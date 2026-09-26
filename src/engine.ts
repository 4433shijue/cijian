import { withStoryLock } from "./locks";
import { active, isBusy } from "./generation-state";
export { isBusy, stop } from "./generation-state";
import { z } from "zod";
import { db, keyFor, reviseEvent, collapseEarlierProse, ensureStoryRounds, consumeMemorySelection } from "./db";
import { usableEvent } from "./timeline";
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
import { preparePrefix, commitPrefix } from "./prefix-cache";
import { prompt } from "./prompts";
import { parseJSON, draftText, missingQuotes, topLevelString } from "./output";
import { selectedTheaterPresets } from "./theater-presets";
import { normalizeTheaterData } from "./theater-data";
import {
  createTheaterAttempt, updateTheaterAttempt, finishTheaterAttempt,
  failTheaterAttempt, rebindTheaterAttempt, validateTheaterHtml,
} from "./theater";
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
  const normalized = await ensureStoryRounds(s.id);
  s = { ...s, nextRound: normalized.nextRound, contextWindowStart: normalized.contextWindowStart };
  const prior = (
    await db.events.where("storyId").equals(s.id).sortBy("seq")
  ).filter((e) => e.seq < until);
  const priorVersions = new Map(
    prior
      .filter((e) => usableEvent(e, s) && (kind !== "chat" || !e.chatPending))
      .map((e) => [e.id, e.versionId]),
  );
  const memories = (await db.memories.where("storyId").equals(s.id).toArray()).filter((m) =>
    m.sources.every((source) => priorVersions.get(source.id) === source.versionId));
  const world = await db.world.toArray();
  const baseline = buildContext(
    kind,
    s,
    prior,
    memories,
    world,
    prefs,
    p,
    input,
    { ...options, rewrite: Number.isFinite(until) },
  );
  // Combined responses contain non-canonical HTML. Never retain them as assistant history.
  if (kind === "novel" && s.theaterAuto) return { report: baseline };
  return preparePrefix(baseline, s, p, prefs, kind, prior, memories, world, Number.isFinite(until));
}
export async function preview(
  storyId: string,
  kind: "novel" | "chat",
  input: string,
) {
  const s = await db.stories.get(storyId);
  if (!s) throw Error("故事不存在");
  const { p, prefs } = await settings();
  return (await report(s, p, prefs, kind, input)).report;
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
  let theaterId: string | undefined;
  let latestRaw = "";
  try {
    const s = await db.stories.get(storyId);
    if (!s) throw Error("故事不存在");
    if (kind === "chat" && (!s.partner || s.partner === s.player))
      throw Error("请选择两位不同的聊天角色");
    const { p, prefs, key } = await settings();
    const autoTheater = kind === "novel" && !!s.theaterAuto;
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
    const prepared = await report(s, p, prefs, kind, input, old?.seq, options);
    const context = prepared.report;
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
    if (autoTheater) {
      const theater = await createTheaterAttempt(event, selectedTheaterPresets(s, prefs));
      theaterId = theater.id;
      event.theater = { id: theater.id, sourceVersionId: theater.sourceVersionId, status: "running", previousId: theater.previousId };
    }
    let last = 0;
    const result = await generate(
      p,
      key,
      context.system,
      context.user,
      control.signal,
      (raw) => {
        if (!event) return;
        latestRaw = raw;
        event.text = draftText(raw);
        event.raw = theaterId ? JSON.stringify({ text: event.text, facts: [] }) : raw;
        if (Date.now() - last > 200) {
          last = Date.now();
          const update = { raw: event.raw, text: event.text };
          const html = theaterId ? topLevelString(raw, "theaterHtml")?.value || "" : "";
          saving = saving
            .then(async () => {
              await db.events.update(event!.id, update);
              if (theaterId) await updateTheaterAttempt(theaterId, raw, html);
            })
            .then(() => {})
            .catch((error) => {
              storageError ??= error;
            });
        }
      },
      fetch,
      { kind, theater: autoTheater, stablePrefix: context.stablePrefix, messages: context.messages },
    );
    await saving;
    if (storageError) throw storageError;
    latestRaw = result.text;
    event.text = draftText(result.text);
    event.raw = theaterId ? JSON.stringify({ text: event.text, facts: [] }) : result.text;
    if (theaterId) await updateTheaterAttempt(theaterId, result.text, topLevelString(result.text, "theaterHtml")?.value || "");
    event.request = {
      ...context,
      usage: result.usage,
      durationMs: result.durationMs,
    };
    if (control.signal.aborted) throw Error("已停止生成，收到的正文保留为草稿。");
    if (!result.complete) throw Error("服务未完整结束 · " + result.reason);
    let theaterHtml = "";
    let theaterError = "";
    if (theaterId) {
      try {
        const parsed = parseJSON(result.text);
        if (parsed.theater !== undefined) normalizeTheaterData(parsed.theater, selectedTheaterPresets(s, prefs));
        else theaterHtml = validateTheaterHtml(parsed.theaterHtml);
      }
      catch (error) { theaterError = error instanceof Error ? error.message : "小剧场未完整生成，可以单独重试。"; }
    }
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
      if (theaterId) event.raw = JSON.stringify(data);
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
      [db.events, db.stories, db.memories, db.jobs, db.promptSessions, db.theaters],
      async () => {
        if (control.signal.aborted) throw Error("已停止生成，收到的正文保留为草稿。");
        if (!(await db.stories.get(storyId)))
          throw Error("故事已删除，未写入结果");
        const adopted: SceneEvent[] = userEvent ? [userEvent] : [];
        if (!old) {
          await db.events.put(event!);
          adopted.push(event!);
          if (kind === "novel") await collapseEarlierProse(storyId, event!.seq);
        }
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
            raw: event!.raw,
            request: event!.request,
            acceptedByAuthor: undefined,
            rewriteOf: undefined,
            warnings: event!.warnings || [],
            collapsed: false,
          });
          if (theaterId) {
            const finalEvent = (await db.events.get(old.id))!;
            await rebindTheaterAttempt(theaterId, finalEvent);
          }
          await db.events.delete(event!.id);
        }
        if (theaterId) {
          const finalEvent = (await db.events.get(old?.id || event!.id))!;
          if (theaterError) await failTheaterAttempt(theaterId, theaterError);
          else await finishTheaterAttempt(theaterId, finalEvent, theaterHtml, result.text);
          // Any older session is rebuilt from adopted prose after a combined response.
          await db.promptSessions.where("storyId").equals(storyId).delete();
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
            adopted.push(e);
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
        await ensureStoryRounds(storyId);
        const numbered = (await db.events.bulkGet(adopted.map((e) => e.id))).filter((e): e is SceneEvent => !!e);
        await commitPrefix(prepared, s, result.text, numbered, result.usage);
        await consumeMemorySelection(storyId, context.memoryContext?.selectionToken);
        if (control.signal.aborted) throw Error("已停止生成，收到的正文保留为草稿。");
      },
    );
    event = undefined;
  } catch (error) {
    // Drain queued stream writes before releasing the lock or exposing adoption.
    await saving;
    const message = error instanceof Error ? error.message : String(error);
    if (event && (await db.stories.get(storyId))) {
      await db.events.put({ ...event, status: "draft", error: message });
      if (theaterId) {
        await updateTheaterAttempt(theaterId, latestRaw, topLevelString(latestRaw, "theaterHtml")?.value || "");
        await failTheaterAttempt(theaterId, message, control.signal.aborted ? "interrupted" : "failed");
      }
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
export { memoryDue, organizeMemory } from "./round-memory";
import { maybeOrganizeMemory, scheduleAutomaticMemory } from "./round-memory";
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
  await maybeOrganizeMemory(storyId);
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
      [db.events, db.stories, db.jobs, db.memories, db.theaters],
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
          collapsed: false,
        });
        if (draft.theater) {
          const finalEvent = (await db.events.get(target.id))!;
          await rebindTheaterAttempt(draft.theater.id, finalEvent);
        }
        if (!draft.rewriteOf) await collapseEarlierProse(story.id, target.seq);
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
        await ensureStoryRounds(story.id);
        await consumeMemorySelection(story.id, draft.request?.memoryContext?.selectionToken);
        scheduleAutomaticMemory(story.id);
        return target.id;
      },
    ),
  );
}
