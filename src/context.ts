import { prompt } from "./prompts";
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
  const included: Material[] = [],
    omitted: Material[] = [];
  let used = estimate(system + "\n" + input);
  const cost = (m: Material) => estimate(m.label + "\n" + m.text + "\n");
  for (const m of materials.filter((m) => m.mandatory)) {
    included.push(m);
    used += cost(m);
  }
  if (used > limit)
    throw Error(
      `当前输入和必读材料估算需要 ${used} token，可用 ${limit}。请增大上下文容量、降低输出限额或调整必读段落。没有发送请求。`,
    );
  for (const m of materials
    .filter((m) => !m.mandatory)
    .sort((a, b) => b.priority - a.priority)) {
    if (used + cost(m) <= limit) {
      included.push(m);
      used += cost(m);
    } else omitted.push(m);
  }
  return {
    system,
    user:
      included.map((m) => `【${m.label}】\n${m.text}`).join("\n\n") +
      "\n\n【当前任务】\n" +
      input,
    included,
    omitted,
    estimate: used,
    limit,
  };
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
): ContextReport {
  const viewer = kind === "chat" ? s.partner : undefined;
  const mats: Material[] = [];
  const add = (
    id: string,
    label: string,
    text: string,
    mandatory = false,
    priority = 0,
  ) => {
    if (text) mats.push({ id, label, text, mandatory, priority });
  };
  add(
    "roles",
    "角色名单",
    s.roles
      .filter((r) => !viewer || r.id === viewer || r.id === s.player)
      .map((r) => `${r.id} = ${r.name}`)
      .join("\n"),
    true,
  );
  // Opening background is author material: never sent raw to a chat character.
  if (!viewer) add("background", "作者的开场背景", s.background, true);
  for (const r of s.roles) {
    if (viewer && r.id !== viewer) {
      if (r.id === s.player) {
        add(r.id + "bio", "对方公开资料", r.name + "\n" + r.bio, true);
        for (const q of r.paragraphs.filter((x) => x.public))
          add(q.id, "对方公开设定", q.text, q.pin, 20);
      }
      continue;
    }
    add(r.id + "bio", r.name + " 的简介", r.bio, true);
    for (const q of r.paragraphs) {
      const terms = input.match(/[\u4e00-\u9fff]{2}|[a-zA-Z]{3,}/g) || [];
      const relevance = terms.reduce(
        (n, t) => n + (q.text.includes(t) ? 1 : 0),
        0,
      );
      add(q.id, r.name + " 的人设", q.text, q.pin, 20 + relevance);
    }
  }
  for (const w of world) {
    const present = viewer ? [s.player, s.partner] : s.roles.map((r) => r.id);
    if (
      !s.worldIds.includes(w.id) ||
      !w.enabled ||
      (w.storyIds.length && !w.storyIds.includes(s.id)) ||
      (w.roleIds.length &&
        !(w.match === "all"
          ? w.roleIds.every((id) => present.includes(id))
          : w.roleIds.some((id) => present.includes(id))))
    )
      continue;
    if (
      viewer &&
      (w.audience === "author" ||
        (w.audience === "roles" && !w.knownBy.includes(viewer)))
    )
      continue;
    if (!w.always && !w.keywords.some((k) => k.trim() && input.includes(k)))
      continue;
    add(w.id, "世界书 · " + w.title, w.text, w.always, 60);
  }
  for (const m of memories)
    if (m.status === "accepted" && (!viewer || m.knownBy.includes(viewer)))
      add(m.id, "已确认的故事记忆", m.text, true, 90);
  for (const e of events.filter((e) => !e.review)) {
    const text = visibleEvent(e, viewer);
    if (text)
      add(
        e.id,
        `经历 ${e.id} / 版本 ${e.versionId} / ${e.kind === "novel" ? "正文" : s.roles.find((r) => r.id === e.speaker)?.name + " 发言"}`,
        text,
        false,
        100 + e.seq,
      );
  }
  let task = input;
  if (kind === "novel")
    task = `篇幅参考 ${s.length}。文风 ${s.style}。${s.psychology ? "可以补充符合人设的心理细节，不能改变动机。" : "禁止增添心理独白或推断动机。"}\n作者指定的完整事件\n${input}`;
  if (kind === "chat")
    task = `你扮演 ${s.roles.find((r) => r.id === s.partner)?.name}（${s.partner}），用户扮演 ${s.roles.find((r) => r.id === s.player)?.name}（${s.player}）。以下是用户刚发来的消息，仅回应该消息\n${input}`;
  return assemble(prompt(kind, prefs), task, mats, p.context, p.maxOutput);
}
