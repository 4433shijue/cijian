import { db } from "./db";
import { estimate } from "./context";
import { styleInstruction } from "./style-presets";
import { sharedTimeline } from "./timeline";
import type {
  ContextReport,
  Material,
  Memory,
  ModelUsage,
  Preferences,
  Profile,
  PromptMessage,
  PromptSession,
  SceneEvent,
  Story,
  WorldEntry,
} from "./types";

export function prefixEnabled(p: Profile) {
  return (
    p.protocol === "chat" &&
    p.prefixReuse !== "off" &&
    (p.prefixReuse === "on" ||
      new URL(p.url).hostname === "api.deepseek.com" ||
      /deepseek/i.test(p.model))
  );
}

const section = (m: Material) => `【${m.label}】\n${m.text}\n\n`;
const messageCost = (messages: PromptMessage[]) =>
  messages.reduce((sum, m) => sum + estimate(m.content) + 8, 4);
const eventStamp = (e: SceneEvent, s: Story) =>
  JSON.stringify([
    e.versionId,
    e.seq,
    e.text,
    e.input,
    e.kind,
    e.speaker,
    e.participants,
    e.facts,
    e.visibility,
    e.status,
    e.deleted,
    sharedTimeline(s) ? false : e.review,
  ]);
const memoryStamp = (m: Memory) =>
  JSON.stringify([m.text, m.knownBy, m.sources, m.status, m.automatic]);
const materialKey = (m: Material) =>
  JSON.stringify([m.excerpt ? ["excerpt", m.sources] : m.id, m.text]);

export interface PreparedContext {
  report: ContextReport;
  session?: PromptSession;
}

// Reuse the exact serialized conversation, not reconstructed bubbles. No provider
// session ID, cache-control header, warming request or API key is stored here.
export async function preparePrefix(
  baseline: ContextReport,
  s: Story,
  p: Profile,
  prefs: Preferences,
  kind: "novel" | "chat",
  events: SceneEvent[],
  memories: Memory[],
  world: WorldEntry[],
  rewrite = false,
): Promise<PreparedContext> {
  if (!prefixEnabled(p)) return { report: baseline };
  const id = JSON.stringify([
    s.id,
    p.id,
    kind,
    ...(kind === "chat" ? [s.player, s.partner] : []),
  ]);
  const system =
    baseline.system +
    "\n\n前面的 user / assistant 轮次是已经完成的历史；仅处理最后一条 user 消息里的【当前任务】，不要重新回答旧任务。后续补充的经历按标注的顺序理解，较晚的状态覆盖旧状态。";
  // Deliberately exclude drafts, timestamps, usage counters and rolling history.
  // Include all bound world entries, even keyword-triggered ones, so removing or
  // restricting a previously used entry invalidates its retained copy.
  const config = JSON.stringify({
    version: 1,
    system,
    prefix: baseline.stablePrefix,
    profile: [
      p.url,
      p.model,
      p.protocol,
      p.context,
      p.maxOutput,
      p.outputMode,
      p.prefixReuse,
      p.temperature,
      p.frequencyPenalty,
    ],
    style: [styleInstruction(s, prefs, kind), s.length, s.psychology],
    timeline: [s.timelineMode, s.autoMemory, baseline.history?.limit],
    world: s.worldIds.map((id) => world.find((w) => w.id === id)),
    memories: memories
      .filter((m) => !m.automatic)
      .sort((a, b) => a.id.localeCompare(b.id))
      .map(memoryStamp),
    ignoredExcerpts: memories
      .filter((m) => m.automatic && m.status === "ignored")
      .sort((a, b) => a.id.localeCompare(b.id))
      .map(memoryStamp),
  });
  const previous = rewrite ? undefined : await db.promptSessions.get(id);
  const eventMap = new Map(events.map((e) => [e.id, e]));
  const memoryMap = new Map(memories.map((m) => [m.id, m]));
  let state: NonNullable<ContextReport["prefixReuse"]>["state"] = rewrite
    ? "rewrite"
    : "first";
  let reused = previous;
  if (previous) {
    if (previous.config !== config) {
      state = "settings";
      reused = undefined;
    } else if (
      Object.entries(previous.events).some(
        ([id, stamp]) =>
          !eventMap.has(id) || eventStamp(eventMap.get(id)!, s) !== stamp,
      ) ||
      Object.entries(previous.memories).some(
        ([id, stamp]) =>
          !memoryMap.has(id) || memoryStamp(memoryMap.get(id)!) !== stamp,
      )
    ) {
      state = "history";
      reused = undefined;
    } else state = "continued";
  }
  let included: Material[] = [],
    omitted = baseline.omitted;
  let messages: PromptMessage[] = [],
    cost = 0;
  if (reused) {
    const covered = new Map(
      reused.covered.map((ref) => [ref.id, ref.versionId]),
    );
    const known = new Set(reused.materials.map(materialKey));
    const tail = baseline.included.filter((m) => {
      if (known.has(materialKey(m))) return false;
      // Full history already present in user/assistant turns needs no second copy
      // as a rolling-window item or automatically generated excerpt.
      if (
        (m.excerpt || eventMap.has(m.id)) &&
        m.sources?.length &&
        m.sources.every((ref) => covered.get(ref.id) === ref.versionId)
      )
        return false;
      return true;
    });
    const next: PromptMessage = {
      role: "user",
      content: tail.map(section).join("") + "【当前任务】\n" + baseline.task,
    };
    messages = [...reused.messages, next];
    cost = messageCost(messages);
    if (reused.inputTokens !== undefined)
      cost = Math.max(
        cost,
        reused.inputTokens + messageCost([reused.messages.at(-1)!, next]),
      );
    if (cost > baseline.limit) {
      state = "capacity";
      reused = undefined;
    } else {
      included = [...reused.materials, ...tail];
      const present = new Set(included.map((m) => m.id));
      omitted = omitted.filter((m) => !present.has(m.id));
    }
  }
  if (!reused) {
    // Keep every mandatory item, but leave growth room by admitting fewer
    // optional excerpts. Repacking is local and never calls the model.
    const all = baseline.included;
    const minimum = messageCost([
      { role: "system", content: system },
      {
        role: "user",
        content:
          all
            .filter((m) => m.mandatory)
            .map(section)
            .join("") +
          "【当前任务】\n" +
          baseline.task,
      },
    ]);
    if (minimum > baseline.limit)
      throw Error(
        "当前输入和必读材料超过上下文容量，请增大容量或减少正文参考回合数。没有发送请求。",
      );
    const target = Math.max(minimum, Math.floor(baseline.limit * 0.65));
    let used = minimum;
    const selected = new Set(all.filter((m) => m.mandatory));
    for (const m of all
      .filter((m) => !m.mandatory)
      .sort((a, b) => b.priority - a.priority)) {
      const extra = estimate(section(m));
      if (used + extra <= target) {
        selected.add(m);
        used += extra;
      }
    }
    included = all.filter((m) => selected.has(m));
    omitted = [...baseline.omitted, ...all.filter((m) => !selected.has(m))];
    messages = [
      { role: "system", content: system },
      {
        role: "user",
        content:
          included.map(section).join("") + "【当前任务】\n" + baseline.task,
      },
    ];
    cost = messageCost(messages);
    // Near the hard limit, optional admission must also account for message framing.
    while (cost > baseline.limit) {
      const optional = included
        .filter((m) => !m.mandatory)
        .sort((a, b) => a.priority - b.priority)[0];
      if (!optional)
        throw Error("当前输入和必读材料超过上下文容量。没有发送请求。");
      included = included.filter((m) => m !== optional);
      omitted = [...omitted, optional];
      messages[1].content =
        included.map(section).join("") + "【当前任务】\n" + baseline.task;
      cost = messageCost(messages);
    }
  }
  const covered = new Map(
    (reused?.covered || []).map((ref) => [ref.id, ref.versionId]),
  );
  const dependencies = { ...(reused?.events || {}) };
  const memoryDependencies = { ...(reused?.memories || {}) };
  for (const m of included) {
    for (const ref of m.sources || []) {
      const e = eventMap.get(ref.id);
      if (e) dependencies[e.id] = eventStamp(e, s);
      if (e && e.id === m.id && !m.excerpt) covered.set(e.id, ref.versionId);
    }
    const memory = memoryMap.get(m.id);
    if (memory) memoryDependencies[m.id] = memoryStamp(memory);
  }
  return {
    report: {
      ...baseline,
      system,
      user: messages.at(-1)!.content,
      messages,
      included,
      omitted,
      estimate: cost,
      history: baseline.history && {
        ...baseline.history,
        recalled: baseline.history.recalled?.filter((ref) =>
          included.some((m) => m.id === ref.id),
        ),
      },
      prefixReuse: { state, retainedMessages: reused?.messages.length || 0 },
    },
    session: {
      id,
      storyId: s.id,
      config,
      messages,
      materials: included,
      covered: [...covered].map(([id, versionId]) => ({ id, versionId })),
      events: dependencies,
      memories: memoryDependencies,
    },
  };
}

// Called inside the same transaction that adopts the response. Failed, cancelled
// or stale responses must never become reusable assistant history.
export async function commitPrefix(
  prepared: PreparedContext,
  s: Story,
  raw: string,
  adopted: SceneEvent[],
  usage?: ModelUsage,
) {
  if (!prepared.session) return;
  if (prepared.report.prefixReuse?.state === "rewrite") {
    await db.promptSessions.delete(prepared.session.id);
    return;
  }
  const session = structuredClone(prepared.session);
  session.messages.push({ role: "assistant", content: raw });
  session.inputTokens = usage?.input;
  for (const e of adopted) {
    session.events[e.id] = eventStamp(e, s);
    session.covered.push({ id: e.id, versionId: e.versionId });
    session.materials.push({
      id: e.id,
      label: `经历 ${e.seq} / ${e.kind === "novel" ? "正文" : s.roles.find((r) => r.id === e.speaker)?.name + " 发言"}（前轮已带入）`,
      text: e.text,
      mandatory: false,
      priority: 0,
      sources: [{ id: e.id, versionId: e.versionId }],
    });
  }
  await db.promptSessions.put(session);
}

export function cacheHitPercent(usage?: ModelUsage) {
  if (usage?.cachedInput === undefined) return undefined;
  const total =
    usage.uncachedInput === undefined
      ? usage.input
      : usage.cachedInput + usage.uncachedInput;
  if (total === undefined || total <= 0 || usage.cachedInput > total)
    return undefined;
  return ((usage.cachedInput / total) * 100).toFixed(1);
}
