import { withStoryLock } from "./locks";
import { active, isBusy } from "./generation-state";
export { isBusy, stop } from "./generation-state";
import { z } from "zod";
import { db, keyFor, reviseEvent, refreshTimelineMemory } from "./db";
import { fullAudience, sharedTimeline, usableEvent } from "./timeline";
import {
  uid,
  type SceneEvent,
  type Fact,
  type Story,
  type ContextReport,
  type Profile,
  type Preferences,
} from "./types";
import { generate } from "./model";
import { buildContext, assemble } from "./context";
import { prompt } from "./prompts";
import { parseJSON, draftText, missingQuotes } from "./output";
export { parseJSON, draftText, checkQuotes } from "./output";
const novelSchema = z.object({
  text: z.string().trim().min(1),
  facts: z
    .array(
      z.object({
        quote: z.string().min(1),
        knownBy: z.array(z.string()).default([]),
      }),
    )
    .default([]),
});
const chatSchema = z.object({
  messages: z.array(z.string().trim().min(1)).min(1).max(20),
});
const factsSchema = z.object({
  facts: z.array(
    z.object({ quote: z.string().min(1), knownBy: z.array(z.string()) }),
  ),
});
const memoriesSchema = z.object({
  memories: z.array(
    z.object({
      text: z.string().min(1),
      sourceIds: z.array(z.string()).min(1),
      knownBy: z.array(z.string()),
      scope: z.enum(["story", "roles"]).default("story"),
    }),
  ),
});
async function settings() {
  const prefs = await db.preferences.get("preferences");
  const p = prefs && (await db.profiles.get(prefs.activeProfile));
  if (!prefs || !p) throw Error("先到设置添加并选中一个接口");
  return { prefs, p, key: keyFor(p) };
}
async function report(
  s: Story,
  p: Profile,
  prefs: Preferences,
  kind: "novel" | "chat",
  input: string,
  until = Infinity,
  options: { styleOnly?: boolean } = {},
) {
  const prior = (
    await db.events.where("storyId").equals(s.id).sortBy("seq")
  ).filter((e) => e.seq < until);
  const priorVersions = new Map(
    prior
      .filter((e) => usableEvent(e, s) && (kind !== "chat" || !e.chatPending))
      .map((e) => [e.id, e.versionId]),
  );
  return buildContext(
    kind,
    s,
    prior,
    (await db.memories.where("storyId").equals(s.id).toArray()).filter((m) =>
      m.sources.every(
        (source) => priorVersions.get(source.id) === source.versionId,
      ),
    ),
    await db.world.toArray(),
    prefs,
    p,
    input,
    options,
  );
}
export async function preview(
  storyId: string,
  kind: "novel" | "chat",
  input: string,
) {
  const s = await db.stories.get(storyId);
  if (!s) throw Error("故事不存在");
  const { p, prefs } = await settings();
  return report(s, p, prefs, kind, input);
}
function blankEvent(
  s: Story,
  seq: number,
  kind: SceneEvent["kind"],
  input: string,
): SceneEvent {
  return {
    id: uid(),
    storyId: s.id,
    seq,
    kind,
    origin: "ai",
    speaker: kind === "message" ? s.partner : "",
    participants:
      kind === "message" ? [s.player, s.partner] : s.roles.map((r) => r.id),
    input,
    text: "",
    facts: [],
    versions: [],
    versionId: uid(),
    status: "draft",
    raw: "",
    error: "",
    review: false,
    deleted: false,
    created: Date.now(),
  };
}
async function runUnlocked(
  storyId: string,
  kind: "novel" | "chat",
  input: string,
  rewriteId?: string,
  options: { styleOnly?: boolean } = {},
) {
  if (active.has(storyId)) throw Error("这个故事正在生成，请先停止或等待完成");
  if (!input.trim()) throw Error("先写下这一刻发生的事");
  const control = new AbortController();
  active.set(storyId, control);
  let event: SceneEvent | undefined,
    jobId = uid();
  let saving = Promise.resolve();
  let storageError: unknown;
  try {
    const s = await db.stories.get(storyId);
    if (!s) throw Error("故事不存在");
    if (kind === "chat" && (!s.partner || s.partner === s.player))
      throw Error("请选择两位不同的聊天角色");
    const { p, prefs, key } = await settings();
    if (!key.trim()) throw Error("请先到设置填写 API Key，当前没有发送请求");
    const old = rewriteId ? await db.events.get(rewriteId) : undefined;
    if (
      rewriteId &&
      (!old ||
        old.storyId !== storyId ||
        old.deleted ||
        (kind === "novel" && old.status !== "complete") ||
        old.kind !== (kind === "novel" ? "novel" : "message"))
    )
      throw Error("要重写的内容已不存在或不属于当前故事");
    if (old && kind === "chat") {
      s.player = old.participants.find((x) => x !== old.speaker) || s.player;
      s.partner = old.speaker;
    }
    const context = await report(s, p, prefs, kind, input, old?.seq, options);
    let seq =
      (await db.events.where("storyId").equals(storyId).sortBy("seq")).at(-1)
        ?.seq || 0;
    let userEvent: SceneEvent | undefined;
    if (kind === "chat" && !old) {
      const u = blankEvent(s, ++seq, "message", input);
      u.speaker = s.player;
      u.origin = "user";
      u.text = input;
      u.status = "complete";
      u.versions = [
        { id: u.versionId, text: input, input, created: Date.now(), facts: [] },
      ];
      userEvent = u;
    }
    event = blankEvent(s, ++seq, kind === "novel" ? "novel" : "message", input);
    event.request = context;
    if (old && kind === "novel")
      event.rewriteOf = { id: old.id, versionId: old.versionId };
    await db.transaction("rw", [db.events, db.jobs, db.stories], async () => {
      if (!(await db.stories.get(storyId)))
        throw Error("故事已删除，未发送请求");
      if (userEvent) await db.events.add(userEvent);
      await db.events.add(event!);
      await db.jobs.add({
        id: jobId,
        storyId,
        kind,
        eventId: event!.id,
        inputVersion: old?.versionId || event!.versionId,
        status: "running",
        created: Date.now(),
        error: "",
      });
    });
    let last = 0;
    const result = await generate(
      p,
      key,
      context.system,
      context.user,
      control.signal,
      (raw) => {
        if (!event) return;
        event.raw = raw;
        event.text = draftText(raw);
        if (Date.now() - last > 200) {
          last = Date.now();
          const update = { raw, text: event.text };
          saving = saving
            .then(() => db.events.update(event!.id, update))
            .then(() => {})
            .catch((error) => {
              storageError ??= error;
            });
        }
      },
      fetch,
      { kind, stablePrefix: context.stablePrefix },
    );
    await saving;
    if (storageError) throw storageError;
    event.raw = result.text;
    event.text = draftText(result.text);
    event.request = {
      ...context,
      usage: result.usage,
      durationMs: result.durationMs,
    };
    if (!result.complete) throw Error("服务未完整结束 · " + result.reason);
    let texts: string[];
    if (kind === "novel") {
      let data: z.infer<typeof novelSchema>;
      try {
        const parsed = z.object({ text: z.string().trim().min(1), facts: z.unknown().optional() }).parse(parseJSON(result.text));
        const facts = novelSchema.shape.facts.safeParse(parsed.facts);
        data = { text: parsed.text, facts: facts.success ? facts.data : [] };
        if (!facts.success) event.warnings = ["事实摘录格式有误，已跳过摘录，正文已保存。"];
      } catch {
        throw Error(
          "模型返回的格式未通过检查，收到的文字已保留。可以检查并修改后，确认采用为正文。",
        );
      }
      if (prefs.dialogueCheck) {
        const missing = missingQuotes(input, data.text);
        if (missing.length) event.warnings = [...(event.warnings || []),
          "台词用字可能有调整，仅供参考：" + missing.map((q) => `「${q}」`).join("、")];
      }
      texts = [data.text];
      event.facts = data.facts
        .filter((f) => data.text.includes(f.quote))
        .map((f) => ({
          id: uid(),
          text: f.quote,
          quote: f.quote,
          knownBy: [],
        }));
    } else {
      try {
        texts = chatSchema.parse(parseJSON(result.text)).messages;
      } catch {
        throw Error(
          "模型返回的消息格式未通过检查，已保留收到的内容，请取回输入后重试。",
        );
      }
    }
    // A rewrite only replaces its target when the source version is still current.
    if (old) {
      const current = await db.events.get(old.id);
      if (!current || current.versionId !== old.versionId)
        throw Error("原文在生成期间已修改，本次结果留作草稿，未覆盖新版本");
    }
    event.text = texts[0];
    event.status = "complete";
    event.versions = [
      {
        id: event.versionId,
        text: event.text,
        input,
        facts: event.facts,
        created: Date.now(),
      },
    ];
    await db.transaction(
      "rw",
      [db.events, db.stories, db.memories, db.jobs],
      async () => {
        if (!(await db.stories.get(storyId)))
          throw Error("故事已删除，未写入结果");
        if (!old) await db.events.put(event!);
        else {
          await reviseEvent(
            old.id,
            texts.join("\n"),
            false,
            event!.facts,
            old.versionId,
          );
          await db.events.update(old.id, {
            status: "complete",
            error: "",
            raw: result.text,
            request: event!.request,
            acceptedByAuthor: undefined,
            rewriteOf: undefined,
            warnings: event!.warnings || [],
          });
          await db.events.delete(event!.id);
        }
        if (!old && kind === "chat")
          for (const text of texts.slice(1)) {
            const e = blankEvent(s, ++seq, "message", input);
            e.text = text;
            e.status = "complete";
            e.versions = [
              { id: e.versionId, text, input, facts: [], created: Date.now() },
            ];
            await db.events.add(e);
          }
        const latest = await db.stories.get(storyId);
        await db.stories.update(storyId, {
          updated: Date.now(),
          ...(kind === "novel"
            ? {
                inspiration: undefined,
                inspirationRequest: undefined,
                inspirationRevision: uid(),
              }
            : {}),
          ...(!old &&
          (kind === "novel" ? latest?.draft : latest?.chatDraft) === input
            ? kind === "novel"
              ? { draft: "" }
              : { chatDraft: "" }
            : {}),
        });
        await db.jobs.update(jobId, {
          status: "complete",
          eventId: old?.id || event!.id,
        });
      },
    );
    event = undefined;
  } catch (error) {
    // Drain queued stream writes before releasing the lock or exposing adoption.
    await saving;
    const message = error instanceof Error ? error.message : String(error);
    if (event && (await db.stories.get(storyId))) {
      await db.events.put({ ...event, status: "draft", error: message });
    }
    await db.jobs.update(jobId, { status: "failed", error: message });
    throw error;
  } finally {
    active.delete(storyId);
  }
}
async function extractFactsUnlocked(id: string) {
  const e = await db.events.get(id);
  if (!e || e.status !== "complete") throw Error("只能整理完整正文的事实");
  if (active.has(e.storyId)) throw Error("请等待当前任务完成");
  const control = new AbortController();
  active.set(e.storyId, control);
  try {
    const s = await db.stories.get(e.storyId);
    if (!s) throw Error("故事不存在");
    const { p, prefs, key } = await settings();
    const r = assemble(
      prompt("facts", prefs),
      "角色名单\n" +
        s.roles.map((r) => r.id + " " + r.name).join("\n") +
        "\n正文\n" +
        e.text,
      [],
      p.context,
      p.maxOutput,
    );
    const result = await generate(
      p,
      key,
      r.system,
      r.user,
      control.signal,
      undefined,
      fetch,
      { kind: "facts" },
    );
    if (!result.complete) throw Error("事实摘录未完整生成，请重试");
    const facts: Fact[] = factsSchema
      .parse(parseJSON(result.text))
      .facts.filter((f) => e.text.includes(f.quote))
      .map((f) => ({
        id: uid(),
        text: f.quote,
        quote: f.quote,
        knownBy: [] /* AI suggestions need explicit author approval */,
      }));
    if ((await db.events.get(id))?.versionId !== e.versionId)
      throw Error("原文已经改变，摘录未应用");
    await reviseEvent(id, e.text, false, facts, e.versionId);
    return facts.length;
  } finally {
    active.delete(e.storyId);
  }
}
export async function memoryDue(s: Story) {
  const events = await db.events
    .where("storyId")
    .equals(s.id)
    .filter(
      (e) => e.seq > s.memoryCursor && !e.deleted && e.status === "complete",
    )
    .toArray();
  return (
    (s.chatThreshold > 0 &&
      events.filter((e) => e.kind === "message").length >= s.chatThreshold) ||
    (s.novelThreshold > 0 &&
      events.filter((e) => e.kind === "novel").length >= s.novelThreshold)
  );
}
async function organizeMemoryUnlocked(storyId: string) {
  if (active.has(storyId))
    throw Error("故事正在生成，整理会在当前任务结束后进行");
  const controller = new AbortController();
  active.set(storyId, controller);
  const jobId = uid();
  try {
    const s = await db.stories.get(storyId);
    if (!s) throw Error("故事不存在");
    const pending = await db.events
      .where("storyId")
      .equals(storyId)
      .filter(
        (e) =>
          e.seq > s.memoryCursor &&
          usableEvent(e, s) && !e.chatPending,
      )
      .sortBy("seq");
    if (!pending.length) return;
    const { p, prefs, key } = await settings();
    // Process a bounded, contiguous prefix; each audience gets a separate request.
    // An author-only secret must not contaminate a shared summary in the same call.
    const events: SceneEvent[] = [];
    for (const e of pending.slice(0, 20)) {
      try {
        assemble(prompt("memory", prefs), JSON.stringify([...events, e].map((x) => ({
          id: x.id, text: x.text, knownBy: fullAudience(x, s),
        }))), [], p.context, p.maxOutput);
      } catch (error) {
        if (!events.length) throw error;
        break;
      }
      events.push(e);
    }
    await db.stories.update(storyId, {
      memoryState: "running",
      memoryError: "",
    });
    await db.jobs.add({
      id: jobId,
      storyId,
      kind: "memory",
      eventId: "",
      inputVersion: String(s.memoryCursor),
      status: "running",
      created: Date.now(),
      error: "",
    });
    const groups = new Map<string, SceneEvent[]>();
    for (const e of events) {
      const audience = JSON.stringify([...fullAudience(e, s)].sort());
      groups.set(audience, [...(groups.get(audience) || []), e]);
    }
    const summaries: { memory: z.infer<typeof memoriesSchema>["memories"][number]; sources: SceneEvent[] }[] = [];
    for (const group of groups.values()) {
      const rows = group.map((e) => ({ id: e.id, text: e.text, knownBy: fullAudience(e, s) }));
      const r = assemble(prompt("memory", prefs), JSON.stringify(rows), [], p.context, p.maxOutput);
      const result = await generate(p, key, r.system, r.user, controller.signal, undefined, fetch, { kind: "memory" });
      if (!result.complete) throw Error("整理未完整结束，进度未前移");
      for (const m of memoriesSchema.parse(parseJSON(result.text)).memories) {
        const sources = group.filter((e) => m.sourceIds.includes(e.id));
        if (sources.length === new Set(m.sourceIds).size) summaries.push({ memory: m, sources });
      }
    }
    await db.transaction(
      "rw",
      [db.events, db.memories, db.stories, db.jobs],
      async () => {
        for (const e of events)
          if ((await db.events.get(e.id))?.versionId !== e.versionId)
            throw Error("整理期间经历已修改，请重新整理");
        if ((await db.stories.get(storyId))?.timelineMode !== s.timelineMode)
          throw Error("整理期间故事互通设置已改变，请重新整理");
        for (const { memory: m, sources } of summaries) {
          const audience = s.roles
            .map((r) => r.id)
            .filter((id) =>
              sources.every((e) => fullAudience(e, s).includes(id)),
            );
          await db.memories.add({
            id: uid(),
            storyId,
            text: m.text,
            knownBy: sharedTimeline(s) ? audience : m.knownBy.filter((id) => audience.includes(id)),
            scope: m.scope,
            sources: sources.map((e) => ({ id: e.id, versionId: e.versionId })),
            status: sharedTimeline(s) ? "accepted" : "candidate",
            created: Date.now(),
          });
        }
        await db.stories.update(storyId, {
          memoryCursor: events.at(-1)!.seq,
          memoryState: "idle",
          memoryError: "",
        });
        await db.jobs.update(jobId, { status: "complete" });
      },
    );
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    await db.stories.update(storyId, {
      memoryState: "failed",
      memoryError: error,
    });
    await db.jobs.update(jobId, { status: "failed", error });
    throw e;
  } finally {
    active.delete(storyId);
  }
}

export async function run(
  storyId: string,
  kind: "novel" | "chat",
  input: string,
  rewriteId?: string,
  options: { styleOnly?: boolean } = {},
) {
  if (active.has(storyId)) throw Error("这个故事正在生成，请先停止或等待完成");
  await withStoryLock(storyId, () =>
    runUnlocked(storyId, kind, input, rewriteId, options),
  );
  const s = await db.stories.get(storyId);
  if (s && sharedTimeline(s)) await refreshTimelineMemory(storyId);
  else if (s && s.autoMemory && s.memoryState === "idle" && (await memoryDue(s)))
    await organizeMemory(storyId).catch(() => {});
}
export async function organizeMemory(storyId: string) {
  return withStoryLock(storyId, () => organizeMemoryUnlocked(storyId));
}
export async function extractFacts(id: string) {
  const e = await db.events.get(id);
  if (!e) throw Error("内容不存在");
  return withStoryLock(e.storyId, () => extractFactsUnlocked(id));
}

export async function adoptDraft(
  id: string,
  text: string,
  expectedVersion: string,
  expectedRaw: string,
) {
  if (!text.trim()) throw Error("正文还没有文字，请先填写再采用。");
  const original = await db.events.get(id);
  if (!original) throw Error("草稿已不存在。");
  return withStoryLock(original.storyId, () =>
    db.transaction(
      "rw",
      [db.events, db.stories, db.jobs, db.memories],
      async () => {
        const draft = await db.events.get(id);
        const story = await db.stories.get(original.storyId);
        if (
          !story ||
          !draft ||
          draft.status !== "draft" ||
          draft.kind !== "novel" ||
          draft.deleted
        )
          throw Error("这份正文草稿已改变，请关闭窗口后重新打开。");
        if (
          isBusy(story.id) ||
          (await db.jobs
            .where("storyId")
            .equals(story.id)
            .filter((j) => j.status === "running")
            .count())
        )
          throw Error("请等待当前任务完成后再采用。");
        if (draft.versionId !== expectedVersion || draft.raw !== expectedRaw)
          throw Error("草稿内容已更新，请重新检查后采用。");
        let target = draft;
        if (draft.rewriteOf) {
          const current = await db.events.get(draft.rewriteOf.id);
          if (
            !current ||
            current.storyId !== story.id ||
            current.kind !== "novel" ||
            current.deleted ||
            current.status !== "complete" ||
            current.versionId !== draft.rewriteOf.versionId
          )
            throw Error(
              "要重写的原文已经修改或删除，本次草稿不会覆盖它。可以取回输入后重新生成。",
            );
          target = current;
        }
        await reviseEvent(target.id, text.trim(), false, [], target.versionId);
        await db.events.update(target.id, {
          status: "complete",
          error: "",
          acceptedByAuthor: true,
          raw: draft.raw,
          request: draft.request,
          rewriteOf: undefined,
        });
        if (target.id !== draft.id) await db.events.delete(draft.id);
        for (const job of await db.jobs
          .where("storyId")
          .equals(story.id)
          .filter((j) => j.eventId === id)
          .toArray())
          await db.jobs.update(job.id, {
            eventId: target.id,
            status: "complete",
            error: "",
          });
        await db.stories.update(story.id, {
          updated: Date.now(),
          inspiration: undefined,
          inspirationRequest: undefined,
          inspirationRevision: uid(),
          ...(story.draft === draft.input ? { draft: "" } : {}),
        });
        await refreshTimelineMemory(story.id);
        return target.id;
      },
    ),
  );
}
