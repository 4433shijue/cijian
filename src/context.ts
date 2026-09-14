import { prompt } from "./prompts";
import { quotedDialogue } from "./output";
import { styleInstruction } from "./style-presets";
import { fullAudience, historyExcerpt, relevance, sharedTimeline, usableEvent, visibleText } from "./timeline";
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
export const visibleEvent = visibleText;
export function buildContext(
  kind: PromptKind,
  s: Story,
  events: SceneEvent[],
  memories: Memory[],
  world: WorldEntry[],
  prefs: Preferences,
  p: Profile,
  input: string,
  options: { styleOnly?: boolean; chatMessages?: string[] } = {},
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
  const limit = proseCount(prefs.novelContextRounds);
  const usable = (e: SceneEvent) => usableEvent(e, s) && (kind !== "chat" || !e.chatPending);
  const eligible = events
    .filter((e) => usable(e) && visibleEvent(e, viewer, s))
    .sort((a, b) => a.seq - b.seq);
  const recent = eligible.filter((e) => e.kind === "novel").slice(-limit);
  const recentChat = eligible.filter((e) => e.kind === "message").slice(-20);
  const recentIds = new Set([...recent, ...recentChat].map((e) => e.id));
  const older = eligible.filter((e) => !recentIds.has(e.id));
  const scores = relevance(input, older.map((e) => visibleEvent(e, viewer, s)));
  const recalled = older.map((e, i) => ({ e, score: scores[i] }))
    .filter((x) => x.score >= 2).sort((a, b) => b.score - a.score || b.e.seq - a.e.seq)
    .slice(0, 4).map((x) => x.e);
  const recalledIds = new Set(recalled.map((e) => e.id));
  const sourceMap = new Map(events.filter(usable).map((e) => [e.id, e]));
  const validMemories = memories.filter((m) => m.status === "accepted" &&
    (!viewer || m.knownBy.includes(viewer)) && m.sources.every((ref) => {
      const e = sourceMap.get(ref.id);
      return e?.versionId === ref.versionId && (!m.automatic || !viewer || fullAudience(e, s).includes(viewer));
    }));
  const summarized = new Set(validMemories.filter((m) => !m.automatic).flatMap((m) => m.sources.map((ref) => ref.id)));
  const usableMemories = validMemories.filter((m) => !m.automatic || (sharedTimeline(s) && s.autoMemory &&
    m.sources.some((ref) => !recentIds.has(ref.id) && !recalledIds.has(ref.id) && !summarized.has(ref.id))))
    .sort((a, b) => Math.max(0, ...a.sources.map((ref) => sourceMap.get(ref.id)?.seq || 0)) -
      Math.max(0, ...b.sources.map((ref) => sourceMap.get(ref.id)?.seq || 0)) || a.created - b.created || a.id.localeCompare(b.id));
  const memoryScores = relevance(input, usableMemories.map((m) => m.text));
  for (const [i, m] of usableMemories.entries())
    add(m.id, m.automatic ? "早期经历摘记（有省略，可查原文）" : "已确认的故事记忆",
      m.text, !m.automatic && !sharedTimeline(s), (m.automatic ? 60 : 90) + Math.min(25, memoryScores[i] * 3));
  // Old/imported stories also have a bounded fallback before excerpts are persisted.
  const covered = new Set(memories.filter((m) => ["accepted", "ignored"].includes(m.status) && m.sources.every((ref) =>
    sourceMap.get(ref.id)?.versionId === ref.versionId)).flatMap((m) => m.sources.map((ref) => ref.id)));
  if (sharedTimeline(s) && s.autoMemory)
    for (const [i, e] of older.entries())
      if (!recalledIds.has(e.id) && !covered.has(e.id))
        add("excerpt:" + e.id, `早期经历 ${e.seq} 摘记（有省略）`, historyExcerpt(visibleEvent(e, viewer, s)),
          false, 60 + Math.min(25, scores[i] * 3));
  const history = [...recentChat, ...recent, ...recalled].sort((a, b) => a.seq - b.seq);
  for (const e of history) {
    const text = visibleEvent(e, viewer, s);
    if (text)
      add(
        e.id,
        `经历 ${e.seq} / ${e.id} / 版本 ${e.versionId} / ${e.kind === "novel" ? "正文" : s.roles.find((r) => r.id === e.speaker)?.name + " 发言"}${recalledIds.has(e.id) ? " / 相关旧原文" : ""}`,
        text,
        e.kind === "novel" && recentIds.has(e.id),
        recalledIds.has(e.id) ? 110 : 120 + history.indexOf(e),
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
    task = `${styleInstruction(s, prefs, "chat")}\n你扮演 ${s.roles.find((r) => r.id === s.partner)?.name}（${s.partner}），用户扮演 ${s.roles.find((r) => r.id === s.player)?.name}（${s.player}）。以下是本轮按发送顺序排列、尚未回复的用户消息。读完整组后统一回应；后面的补充与纠正应覆盖前面的旧意思。\n${JSON.stringify({ pending_user_messages: options.chatMessages || [input] })}`;
  if (kind === "chat" && sharedTimeline(s))
    task = "正文和手机聊天发生在同一条时间线上。所给正文是已经发生的共同经历，沿着最后的状态继续聊天；较晚的明确变化覆盖旧状态。早期摘记可能有省略，细节以相关原文为准。不要把旁白或别人的心理描写当成自己说过的话。\n" + task;
  const report = assemble(prompt(kind, prefs), task, mats, p.context, p.maxOutput);
  return {
    ...report,
    history: {
      limit,
      sources: recent
        .filter((e) => visibleEvent(e, viewer, s))
        .map((e) => ({ id: e.id, versionId: e.versionId })),
      recalled: recalled.filter((e) => report.included.some((m) => m.id === e.id)).map((e) => ({ id: e.id, versionId: e.versionId })),
    },
  };
}
