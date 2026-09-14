import { prompt } from "./prompts";
import { quotedDialogue } from "./output";
import { styleInstruction } from "./style-presets";
import type {
  Story,
  SceneEvent,
  Memory,
  WorldEntry,
  Preferences,
  Profile,
  PromptKind,
  Material,
  ContextReport,
} from "./types";
export const estimate = (text: string) =>
  Math.ceil(
    [...text].reduce(
      (n, c) => n + (/[\u2E80-\uFFFF]/.test(c) ? 1.35 : 0.32),
      0,
    ),
  );
export function assemble(
  system: string,
  input: string,
  materials: Material[],
  capacity: number,
  output: number,
): ContextReport {
  const limit = capacity - output - 512;
  if (limit <= 0) throw Error("上下文容量必须大于输出限额与 512 token 预留");
  const selected = new Set<Material>();
  let used = estimate(system + "\n" + input);
  const cost = (m: Material) => estimate(`【${m.label}】\n${m.text}\n\n`);
  for (const m of materials.filter((m) => m.mandatory)) {
    selected.add(m);
    used += cost(m);
  }
  if (used > limit)
    throw Error(
      `当前输入和必读材料估算需要 ${used} token，可用 ${limit}。请增大上下文容量、降低输出限额、精简设定或调低正文参考回合数。没有发送请求。`,
    );
  for (const m of materials
    .filter((m) => !m.mandatory)
    .sort((a, b) => b.priority - a.priority)) {
    if (used + cost(m) <= limit) {
      selected.add(m);
      used += cost(m);
    }
  }
  // Priority controls admission only. Serialization always follows source order.
  const included = materials.filter((m) => selected.has(m));
  const omitted = materials.filter((m) => !selected.has(m));
  const section = (m: Material) => `【${m.label}】\n${m.text}\n\n`;
  let stablePrefix = "";
  for (const m of included) {
    if (!m.stable) break;
    stablePrefix += section(m);
  }
  return {
    system,
    user: included.map(section).join("") + "【当前任务】\n" + input,
    stablePrefix,
    included,
    omitted,
    estimate: used,
    limit,
  };
}
export function proseCount(value?: number) {
  return Number.isInteger(value) && value! >= 1 && value! <= 50 ? value! : 7;
}
export function visibleEvent(e: SceneEvent, viewer?: string) {
  if (e.deleted || e.status !== "complete") return "";
  if (!viewer) return e.text;
  if (e.kind === "message")
    return e.participants.includes(viewer) ? e.text : "";
  return e.facts
    .filter((f) => f.knownBy.includes(viewer))
    .map((f) => f.text)
    .join("\n");
}
export function buildContext(
  kind: PromptKind,
  s: Story,
  events: SceneEvent[],
  memories: Memory[],
  world: WorldEntry[],
  prefs: Preferences,
  p: Profile,
  input: string,
  options: { styleOnly?: boolean } = {},
): ContextReport {
  const viewer = kind === "chat" ? s.partner : undefined;
  const mats: Material[] = [];
  const add = (
    id: string,
    label: string,
    text: string,
    mandatory = false,
    priority = 0,
    stable = false,
  ) => {
    if (text) mats.push({ id, label, text, mandatory, priority, stable });
  };
  const present = viewer ? [s.player, s.partner] : s.roles.map((r) => r.id);
  const loadedWorld = s.worldIds.flatMap((id) => {
    const w = world.find((entry) => entry.id === id);
    if (
      !w ||
      !w.enabled ||
      (w.storyIds.length && !w.storyIds.includes(s.id)) ||
      (w.roleIds.length &&
        !(w.match === "all"
          ? w.roleIds.every((id) => present.includes(id))
          : w.roleIds.some((id) => present.includes(id)))) ||
      (viewer &&
        (w.audience === "author" ||
          (w.audience === "roles" && !w.knownBy.includes(viewer))))
    )
      return [];
    return [w];
  });
  for (const w of loadedWorld.filter((w) => w.always))
    add(w.id, "世界书 · " + w.title, w.text, true, 0, true);
  add(
    "roles",
    "角色名单",
    s.roles
      .filter((r) => !viewer || r.id === viewer || r.id === s.player)
      .map((r) => `${r.id} = ${r.name}`)
      .join("\n"),
    true,
    0,
    true,
  );
  for (const r of s.roles) {
    if (viewer && r.id !== viewer) {
      if (r.id === s.player) {
        add(r.id + "bio", "对方公开资料", r.name + "\n" + r.bio, true, 0, true);
        for (const q of r.paragraphs.filter((x) => x.public))
          add(q.id, "对方公开设定", q.text, true, 0, true);
      }
      continue;
    }
    add(r.id + "bio", r.name + " 的简介", r.bio, true, 0, true);
    for (const q of r.paragraphs) {
      add(q.id, r.name + " 的人设", q.text, true, 0, true);
    }
    if (!r.paragraphs.length)
      add(r.id + "persona", r.name + " 的人设", r.persona, true, 0, true);
  }
  // Author background must never enter a chat character's knowledge.
  if (!viewer) add("background", "作者的开场背景", s.background, true, 0, true);
  for (const w of loadedWorld.filter(
    (w) => !w.always && w.keywords.some((k) => k.trim() && input.includes(k)),
  ))
    add(w.id, "世界书 · " + w.title, w.text, true, 60);
  for (const m of [...memories].sort(
    (a, b) => a.created - b.created || a.id.localeCompare(b.id),
  ))
    if (m.status === "accepted" && (!viewer || m.knownBy.includes(viewer)))
      add(m.id, "已确认的故事记忆", m.text, true, 90);
  const limit = proseCount(prefs.novelContextRounds);
  const eligible = events
    .filter((e) => !e.review && !e.deleted && e.status === "complete")
    .sort((a, b) => a.seq - b.seq);
  const recent = eligible.filter((e) => e.kind === "novel").slice(-limit);
  const history = [...eligible.filter((e) => e.kind === "message"), ...recent];
  for (const e of history) {
    const text = visibleEvent(e, viewer);
    if (text)
      add(
        e.id,
        `经历 ${e.id} / 版本 ${e.versionId} / ${e.kind === "novel" ? "正文" : s.roles.find((r) => r.id === e.speaker)?.name + " 发言"}`,
        text,
        e.kind === "novel",
        100 + e.seq,
      );
  }
  let task = input;
  if (kind === "novel")
    task = `${styleInstruction(s, prefs, "novel")}\n篇幅参考 ${s.length}。${s.psychology ? "可以补充符合人设的心理细节，不能改变动机。" : "禁止增添心理独白或推断动机。"}${options.styleOnly ? "\n这是只换文风重写：严格保持原事件、人物关系、台词和停止位置，只调整表达方式。" : ""}\n作者指定的完整事件\n${input}\n\n需保留的引用台词\n${
      quotedDialogue(input)
        .map((q) => `「${q}」`)
        .join("\n") || "本次没有识别到引用台词。"
    }`;
  if (kind === "chat")
    task = `${styleInstruction(s, prefs, "chat")}\n你扮演 ${s.roles.find((r) => r.id === s.partner)?.name}（${s.partner}），用户扮演 ${s.roles.find((r) => r.id === s.player)?.name}（${s.player}）。以下是用户刚发来的消息，仅回应该消息\n${input}`;
  return {
    ...assemble(prompt(kind, prefs), task, mats, p.context, p.maxOutput),
    history: {
      limit,
      sources: recent
        .filter((e) => visibleEvent(e, viewer))
        .map((e) => ({ id: e.id, versionId: e.versionId })),
    },
  };
}
