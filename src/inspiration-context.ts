import { assemble } from "./context";
import { prompt } from "./prompts";
import { styleInstruction } from "./style-presets";
import { selectRoundContext, memoryReadLimit, roundLabel } from "./rounds";
import {
  fullAudience,
  sharedTimeline,
  usableEvent,
} from "./timeline";
import type {
  Material,
  Memory,
  Preferences,
  Profile,
  SceneEvent,
  Story,
  WorldEntry,
} from "./types";

export interface InspirationInputs {
  story: Story;
  events: SceneEvent[];
  memories: Memory[];
  world: WorldEntry[];
  prefs: Preferences;
}

export function inspirationCount(value?: number) {
  return Number.isInteger(value) && value! >= 1 && value! <= 20 ? value! : 3;
}

export function recentProse(
  events: SceneEvent[],
  count: number,
  story?: Story,
) {
  return events
    .filter(
      (e) =>
        e.kind === "novel" &&
        e.status === "complete" &&
        !e.deleted &&
        (!story || e.storyId === story.id) &&
        (!e.review || (story && sharedTimeline(story))),
    )
    .sort((a, b) => a.seq - b.seq || a.id.localeCompare(b.id))
    .slice(-inspirationCount(count));
}

// Choosing a suggestion must not make it a new fact or stale its own round.
export function authorIdea(story: Story) {
  const selected = story.inspiration?.selectedText;
  return (
    selected && story.draft.endsWith(selected)
      ? story.draft.slice(0, -selected.length)
      : story.draft
  ).trim();
}

// Exclude presentation, transport logs, timestamps and unaccepted drafts. This is
// also compared inside write transactions, so late results cannot cross an edit.
export function inspirationSourceText({
  story: s,
  events,
  memories,
  world,
  prefs,
}: InspirationInputs) {
  return JSON.stringify({
    policy: 3,
    memoryLimit: memoryReadLimit(prefs),
    windowStart: s.contextWindowStart,
    story: {
      id: s.id,
      background: s.background,
      timelineMode: s.timelineMode,
      autoMemory: s.autoMemory,
      roles: s.roles.map((r) => ({
        id: r.id,
        name: r.name,
        bio: r.bio,
        persona: r.persona,
        paragraphs: r.paragraphs.map((p) => ({
          text: p.text,
          public: p.public,
        })),
      })),
      worldIds: s.worldIds,
      draft: authorIdea(s),
      revision: s.inspirationRevision || "",
    },
    events: events
      .filter((e) => e.storyId === s.id && usableEvent(e, s))
      .sort((a, b) => a.seq - b.seq || a.id.localeCompare(b.id))
      .map((e) => ({
        id: e.id,
        versionId: e.versionId,
        seq: e.seq,
        kind: e.kind,
        text: e.text,
        speaker: e.speaker,
        participants: e.participants,
        visibility: e.visibility,
        facts: e.facts,
        chatPending: !!e.chatPending,
      })),
    memories: memories
      .filter((m) => m.storyId === s.id && m.status === "accepted")
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((m) => ({
        id: m.id,
        text: m.text,
        knownBy: m.knownBy,
        scope: m.scope,
        sources: m.sources,
        automatic: !!m.automatic,
      })),
    world: s.worldIds.map((id) => world.find((w) => w.id === id) || null),
    count: inspirationCount(prefs.inspirationParagraphs),
    rules: prompt("inspiration", prefs),
    style: styleInstruction(s, prefs, "novel"),
  });
}

export function buildInspirationContext(
  story: Story,
  events: SceneEvent[],
  world: WorldEntry[],
  prefs: Preferences,
  profile: Profile,
  memories: Memory[] = [],
  feedback = "",
) {
  const common = selectRoundContext(story, events, memories, prefs, undefined, false, false);
  const recent = recentProse(
    common.history,
    inspirationCount(prefs.inspirationParagraphs),
    story,
  );
  const eligible = events
    .filter((e) => e.storyId === story.id && usableEvent(e, story))
    .sort((a, b) => a.seq - b.seq || a.id.localeCompare(b.id));
  const chats = [...common.history.filter((e) => e.kind === "message"), ...eligible.filter((e) => e.chatPending)];
  const history = [...recent, ...chats].sort(
    (a, b) => a.seq - b.seq || a.id.localeCompare(b.id),
  );
  const sourceMap = new Map(eligible.map((e) => [e.id, e]));
  const present = story.roles.map((r) => r.id);
  const names = (ids: string[]) =>
    ids
      .filter((id) => present.includes(id))
      .map((id) => `${story.roles.find((r) => r.id === id)!.name}（${id}）`)
      .join("、") || "未授权给任何角色";
  const scope = (ids: string[]) =>
    `可知人物：${names(ids)}。其他人物不能凭这条信息行动。`;
  const materials: Material[] = [];
  const add = (id: string, label: string, text: string, stable = false) => {
    if (text)
      materials.push({ id, label, text, mandatory: true, priority: 0, stable });
  };
  const query =
    [...recent.slice(-2), ...chats.slice(-6)].map((e) => e.text).join("\n") +
    "\n" +
    authorIdea(story);
  const loadedWorld = story.worldIds.flatMap((id) => {
    const w = world.find((entry) => entry.id === id);
    if (
      !w ||
      !w.enabled ||
      (w.storyIds.length && !w.storyIds.includes(story.id)) ||
      (w.roleIds.length &&
        !(w.match === "all"
          ? w.roleIds.every((id) => present.includes(id))
          : w.roleIds.some((id) => present.includes(id))))
    )
      return [];
    return w.always ||
      w.keywords.some((key) => key.trim() && query.includes(key))
      ? [w]
      : [];
  });
  const addWorld = (w: WorldEntry, stable: boolean) =>
    add(
      w.id,
      "世界书 · " + w.title,
      `${scope(w.audience === "all" ? present : w.audience === "roles" ? w.knownBy : [])}\n${w.text}`,
      stable,
    );
  loadedWorld.filter((w) => w.always).forEach((w) => addWorld(w, true));
  add(
    "roles",
    "角色名单",
    story.roles.map((r) => `${r.id} = ${r.name}`).join("\n"),
    true,
  );
  for (const role of story.roles) {
    add(role.id + ":bio", "人物公开简介 · " + role.name, role.bio, true);
    // Paragraph public flags carry knowledge boundaries; the full persona is
    // still available for motivation even when it is private to that person.
    const paragraphs = role.paragraphs.length
      ? role.paragraphs
      : [{ text: role.persona, public: false }];
    paragraphs.forEach((p, i) =>
      add(
        role.id + ":persona:" + i,
        "初始人设 · " + role.name,
        `${scope(p.public ? present : [role.id])}\n${p.text}`,
        true,
      ),
    );
  }
  add(
    "background",
    "作者的开场背景 · 不代表人物已知或当前状态",
    story.background,
    true,
  );
  loadedWorld.filter((w) => !w.always).forEach((w) => addWorld(w, false));

  const lastSeq = (m: Memory) => Math.max(0, ...m.sources.map((ref) => sourceMap.get(ref.id)!.seq));
  // Inspiration uses the configured default, never consumes the next-reply override.
  const rawIds = new Set(history.map((e) => e.id));
  const readLimit = memoryReadLimit(prefs);
  const selectedMemories = (readLimit ? common.eligible.filter((m) => m.sources.some((ref) => !rawIds.has(ref.id))).slice(-readLimit) : []).map((m) => ({ m, score: 0 }));
  const timeline: { seq: number; material: Material }[] = [];
  for (const { m, score } of selectedMemories) {
    const audience = m.knownBy.filter((id) =>
      m.sources.every((ref) => {
        const e = sourceMap.get(ref.id)!;
        return (
          fullAudience(e, story).includes(id) ||
          (!m.automatic &&
            e.visibility !== "author" &&
            e.facts.some((f) => f.knownBy.includes(id)))
        );
      }),
    );
    timeline.push({
      seq: lastSeq(m),
      material: {
        id: m.id,
        label: `${roundLabel(m.sources.flatMap((ref) => common.byId.get(ref.id)?.round || []))}记忆`,
        text: `${scope(audience)}\n来源：${m.sources.map((ref) => `经历 ${sourceMap.get(ref.id)!.seq} / ${ref.id} / 版本 ${ref.versionId}`).join("；")}\n${m.text}`,
        mandatory: !m.automatic,
        priority: 60 + Math.min(25, score),
        sources: m.sources,
        excerpt: !!m.automatic,
      },
    });
  }
  for (const e of history) {
    const factNotes =
      e.visibility === "author"
        ? ""
        : e.facts
            .filter((f) => f.knownBy.length)
            .map((f) => `${scope(f.knownBy)} ${f.text}`)
            .join("\n");
    timeline.push({
      seq: e.seq,
      material: {
        id: e.id,
        label: `经历 ${e.seq} / ${e.id} / 版本 ${e.versionId} / ${e.kind === "novel" ? "正文" : `${story.roles.find((r) => r.id === e.speaker)?.name || e.speaker} 发言${e.chatPending ? "（已发送，尚待回复）" : ""}`}`,
        text: `${scope(fullAudience(e, story))}\n${e.text}${factNotes ? "\n单独授权的事实：\n" + factNotes : ""}`,
        mandatory: true,
        priority: 120,
        sources: [{ id: e.id, versionId: e.versionId }],
      },
    });
  }
  timeline.sort(
    (a, b) =>
      a.seq - b.seq ||
      Number(!a.material.excerpt) - Number(!b.material.excerpt),
  );
  materials.push(...timeline.map((entry) => entry.material));
  const idea = authorIdea(story);
  if (idea)
    add(
      "author-draft",
      "作者尚未采用的想法 · 没有发生，不授予人物知情权",
      idea,
    );
  if (story.inspiration)
    add(
      "previous-options",
      "上一轮建议 · 全部仍是候选，不能当作前文",
      JSON.stringify(story.inspiration.options),
    );
  if (feedback.trim())
    add(
      "author-feedback",
      "作者对本轮建议的要求 · 不代表已发生的经历",
      feedback.trim(),
    );
  const task = `参考最近 ${recent.length} 段正文、${chats.length} 条聊天和所给记忆，给出恰好四个符合人物当前处境的候选。经历按时间顺序提供，较晚的明确事实覆盖较早状态，记忆不能覆盖相关原文。先核对当前场景、关系、每个人正在做的事、已知信息、约定与拒绝，再安排下一小步；聊天中的约定需要接上，但发消息不表示人物已经见面或移动了位置。${history.length ? "接着最后已发生的经历考虑，不能重新套用开场时的关系。" : "尚无正式经历，从开场处境寻找合理的第一步。"}\n以下文风只调整措辞，不能改变人物的动机、边界与行动：\n${styleInstruction(story, prefs, "novel")}`;
  const report = assemble(
    prompt("inspiration", prefs),
    task,
    materials,
    profile.context,
    profile.maxOutput,
  );
  const sources = [
    ...new Map(
      report.included
        .flatMap((m) => m.sources || [])
        .map((ref) => [ref.id, ref]),
    ).values(),
  ].sort((a, b) => sourceMap.get(a.id)!.seq - sourceMap.get(b.id)!.seq);
  return { report, sources };
}
