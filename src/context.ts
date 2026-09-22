import { prompt } from "./prompts";
import { quotedDialogue } from "./output";
import { styleInstruction } from "./style-presets";
import { selectedTheaterPresets, theaterInstruction } from "./theater-presets";
import { sharedTimeline, usableEvent, visibleText } from "./timeline";
import { HISTORY_LIMIT, roundLabel, selectRoundContext } from "./rounds";
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
  SourceRef,
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
      `当前输入和必读材料估算需要 ${used} token，可用 ${limit}，超出 ${used - limit} token。请增大上下文容量、降低输出限额、精简设定或减少勾选记忆。没有发送请求。`,
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
    task: input,
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
  options: { styleOnly?: boolean; chatMessages?: string[]; rewrite?: boolean } = {},
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
    sources?: SourceRef[],
    excerpt = false,
  ) => {
    if (text) mats.push({ id, label, text, mandatory, priority, stable, sources, excerpt });
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
  const selected = selectRoundContext(s, events, memories, prefs, viewer, options.rewrite);
  const history = selected.history;
  const rawIds = new Set(history.map((e) => e.id));
  for (const m of selected.selected) {
    const rounds = m.sources.map((ref) => selected.byId.get(ref.id)?.round).filter((n): n is number => n !== undefined);
    add(m.id, `${roundLabel(rounds)}记忆${m.sources.some((ref) => rawIds.has(ref.id)) ? "（与原文重叠，细节以原文为准）" : ""}`,
      m.text, true, 90, false, m.sources);
  }
  for (const e of history) {
    add(e.id, `第${e.round}回 / 消息顺序 ${e.seq} / ${e.id} / 版本 ${e.versionId} / ${e.kind === "novel" ? "正文" : (s.roles.find((r) => r.id === e.speaker)?.name || "角色") + " 发言"}`,
      visibleEvent(e, viewer, s), true, 120, false, [{ id: e.id, versionId: e.versionId }]);
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
    task = "正文和手机聊天发生在同一条时间线上。所给正文是已经发生的共同经历，沿着最后的状态继续聊天；较晚的明确变化覆盖旧状态。回合记忆是摘要，细节以窗口内原文为准。不要把旁白或别人的心理描写当成自己说过的话。\n" + task;
  const pending = kind === "novel" ? events.filter((e) => e.chatPending && usableEvent(e, s)).sort((a, b) => a.seq - b.seq) : [];
  if (pending.length) task = "已发送、尚未获得聊天回复的本次补充（不算已完成回合）\n" + JSON.stringify(pending.map((e) => ({
    speaker: s.roles.find((r) => r.id === e.speaker)?.name, order: e.seq, text: e.text,
  }))) + "\n" + task;
  task = `本次${options.rewrite ? "重写历史回合" : `生成第${s.nextRound || Math.max(0, ...selected.rounds.map((r) => r.number)) + 1}回`}。参考按回合编号由早到晚排列，编号空缺不代表事件连续发生。较晚的有效原文覆盖旧状态；记忆与原文重叠时以原文为准。${selected.gaps.length ? `较早的${roundLabel(selected.gaps)}未被所选记忆完整覆盖，不要将缺失内容自行补成事实。` : ""}\n` + task;
  const autoTheater = kind === "novel" && !!s.theaterAuto;
  const theaterPresets = autoTheater ? selectedTheaterPresets(s, prefs) : [];
  if (autoTheater && !theaterPresets.length) throw Error("请先为小剧场选择至少一个预设。");
  const system = prompt(kind, prefs, autoTheater) + (autoTheater
    ? "\n\n【仅用于 theaterHtml 的番外要求】\n" + theaterInstruction(theaterPresets) +
      (prefs.prompts.theater?.enabled ? "\n作者的附加小剧场偏好\n" + prefs.prompts.theater.text : "") : "");
  const report = assemble(system, task, mats, p.context, p.maxOutput);
  const memoryIds = new Set(selected.selected.map((m) => m.id));
  const cost = (filter: (m: Material) => boolean) => report.included.filter(filter).reduce((n, m) => n + estimate(`【${m.label}】\n${m.text}\n\n`), 0);
  return {
    ...report,
    taskSources: pending.map((e) => ({ id: e.id, versionId: e.versionId })),
    history: { limit: HISTORY_LIMIT, sources: history.map((e) => ({ id: e.id, versionId: e.versionId })),
      rounds: [...new Set(history.map((e) => e.round!))], windowStart: selected.start, recalled: [] },
    memoryContext: { selected: selected.selected.map((m) => m.id), gaps: selected.gaps,
      automaticLimit: selected.limit, selectionToken: selected.selectionToken },
    materialTokens: { settings: cost((m) => !memoryIds.has(m.id) && !rawIds.has(m.id)),
      memories: cost((m) => memoryIds.has(m.id)), history: cost((m) => rawIds.has(m.id)), task: estimate(report.system + task) },
  };
}
