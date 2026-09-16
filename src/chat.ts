import { z } from "zod";
import { db, keyFor, reviseEvent, refreshTimelineMemory } from "./db";
import { sharedTimeline, usableEvent } from "./timeline";
import { active } from "./generation-state";
import { withStoryLock } from "./locks";
import { buildContext } from "./context";
import { preparePrefix, commitPrefix } from "./prefix-cache";
import { generate } from "./model";
import { parseJSON } from "./output";
import { memoryDue, organizeMemory } from "./engine";
import { uid, type ChatBatch, type SceneEvent, type Story } from "./types";

const repliesSchema = z.object({
  messages: z.array(z.string().trim().min(1)).min(1).max(20),
}).strict();

export function sameChat(e: SceneEvent, player: string, partner: string) {
  return e.kind === "message" && e.participants.length === 2 &&
    e.participants.includes(player) && e.participants.includes(partner);
}

export function pendingChatMessages(events: SceneEvent[], player: string, partner: string) {
  return events.filter((e) => sameChat(e, player, partner) &&
    e.speaker === player && e.origin === "user" && e.chatPending &&
    !e.chatBatchId && !e.deleted && e.status === "complete")
    .sort((a, b) => a.seq - b.seq);
}

function message(s: Story, seq: number, text: string, origin: "user" | "ai", batchId?: string): SceneEvent {
  const versionId = uid(), created = Date.now();
  return {
    id: uid(), storyId: s.id, seq, kind: "message", origin,
    speaker: origin === "user" ? s.player : s.partner,
    participants: [s.player, s.partner], input: text, text, facts: [],
    versions: [{ id: versionId, text, input: text, created, facts: [] }],
    versionId, status: "complete", raw: "", error: "", review: false,
    deleted: false, created, chatPending: origin === "user", chatBatchId: batchId,
  };
}

function checkPair(s: Story, player: string, partner: string) {
  if (!player || !partner || player === partner ||
    ![player, partner].every((id) => s.roles.some((r) => r.id === id)))
    throw Error("请选择两位不同的聊天角色");
}

// A short database transaction allows sending while a model request holds the story lock.
export async function sendChatMessage(storyId: string, player: string, partner: string, text: string) {
  if (!text.trim()) throw Error("先写一条消息");
  return db.transaction("rw", [db.stories, db.events], async () => {
    const stored = await db.stories.get(storyId);
    if (!stored) throw Error("故事不存在");
    checkPair(stored, player, partner);
    const s = { ...stored, player, partner };
    const events = await db.events.where("storyId").equals(storyId).sortBy("seq");
    const e = message(s, (events.at(-1)?.seq || 0) + 1, text, "user");
    await db.events.add(e);
    await db.stories.update(storyId, {
      updated: Date.now(),
      ...(stored.chatDraft === text ? { chatDraft: "" } : {}),
    });
    return e.id;
  });
}

async function settings() {
  const prefs = await db.preferences.get("preferences");
  const p = prefs && await db.profiles.get(prefs.activeProfile);
  if (!prefs || !p) throw Error("先到设置添加并选中一个接口");
  return { prefs, p, key: keyFor(p) };
}

async function contextFor(s: Story, batch: ChatBatch, rewrite = false, connection?: Awaited<ReturnType<typeof settings>>) {
  const { prefs, p } = connection || await settings();
  const sourceIds = new Set(batch.sources.map((source) => source.id));
  const events = (await db.events.where("storyId").equals(s.id).sortBy("seq"))
    .filter((e) => e.seq < batch.cutoff && !sourceIds.has(e.id) && !e.chatPending);
  const versions = new Map(events.filter((e) => usableEvent(e, s))
    .map((e) => [e.id, e.versionId]));
  const memories = (await db.memories.where("storyId").equals(s.id).toArray())
    .filter((m) => m.sources.every((source) => versions.get(source.id) === source.versionId));
  const pair = { ...s, player: batch.player, partner: batch.partner };
  const world = await db.world.toArray();
  const baseline = buildContext("chat", pair,
    events, memories, world, prefs, p, batch.messages.join("\n"),
    { chatMessages: batch.messages });
  return preparePrefix(baseline, pair, p, prefs, "chat", events, memories, world, rewrite);
}

export async function previewChat(storyId: string) {
  const s = await db.stories.get(storyId);
  if (!s) throw Error("故事不存在");
  const events = await db.events.where("storyId").equals(storyId).sortBy("seq");
  const pending = pendingChatMessages(events, s.player, s.partner);
  if (!pending.length) throw Error("先发送消息，再查看本次参考内容");
  return (await contextFor(s, newBatch(s, pending, (events.at(-1)?.seq || 0) + 1))).report;
}

function newBatch(s: Story, sources: SceneEvent[], cutoff: number): ChatBatch {
  return {
    id: uid(), storyId: s.id, player: s.player, partner: s.partner,
    sources: sources.map((e) => ({ id: e.id, versionId: e.versionId })),
    messages: sources.map((e) => e.text), replyIds: [], cutoff,
    status: "running", created: Date.now(), updated: Date.now(), raw: "", error: "",
  };
}

// Old backups have no batch metadata. Adopt only adjacent replies from the same old request.
async function adoptLegacyReply(storyId: string, eventId: string) {
  return db.transaction("rw", [db.events, db.stories, db.chatBatches], async () => {
    const s = await db.stories.get(storyId);
    const events = await db.events.where("storyId").equals(storyId).sortBy("seq");
    const target = events.find((e) => e.id === eventId && !e.deleted);
    if (!s || !target || target.kind !== "message" || target.origin === "user")
      throw Error("要重新生成的回复已不存在");
    if (target.chatBatchId) return target.chatBatchId;
    const partner = target.speaker, player = target.participants.find((id) => id !== partner) || "";
    checkPair(s, player, partner);
    const matches = (e: SceneEvent) => !e.deleted && !e.chatBatchId && e.origin !== "user" &&
      e.speaker === partner && e.input === target.input && sameChat(e, player, partner);
    let start = events.indexOf(target), end = start + 1;
    while (start > 0 && matches(events[start - 1])) start--;
    while (end < events.length && matches(events[end])) end++;
    const group = events.slice(start, end);
    const source = events.slice(0, start).reverse().find((e) => !e.deleted &&
      e.origin === "user" && e.speaker === player && sameChat(e, player, partner));
    const sources = source?.text === target.input ? [source] : [];
    const batch = newBatch({ ...s, player, partner }, sources, group[0].seq);
    if (!sources.length) batch.messages = [target.input];
    batch.replyIds = group.filter((e) => e.status === "complete").map((e) => e.id);
    batch.status = batch.replyIds.length ? "complete" : "interrupted";
    await db.chatBatches.add(batch);
    for (const e of group)
      await db.events.update(e.id, { chatBatchId: batch.id, ...(e.status === "draft" ? { deleted: true } : {}) });
    for (const e of sources)
      await db.events.update(e.id, { chatBatchId: batch.id, chatPending: !batch.replyIds.length });
    return batch.id;
  });
}

export async function replyChat(storyId: string, batchId?: string, legacyEventId?: string) {
  if (active.has(storyId)) throw Error("这个故事正在生成，请先停止或等待完成");
  await withStoryLock(storyId, async () => {
    if (active.has(storyId)) throw Error("这个故事正在生成，请先停止或等待完成");
    const control = new AbortController();
    active.set(storyId, control);
    let batch: ChatBatch | undefined;
    const jobId = uid();
    let raw = "", saving = Promise.resolve(), storageError: unknown;
    try {
      const connection = await settings();
      const { p, key } = connection;
      if (!key.trim()) throw Error("请先到设置填写 API Key，当前没有发送请求");
      if (legacyEventId) batchId = await adoptLegacyReply(storyId, legacyEventId);
      const snapshot = await db.transaction("rw", [db.stories, db.events, db.chatBatches, db.jobs], async () => {
        const s = await db.stories.get(storyId);
        if (!s) throw Error("故事不存在");
        const events = await db.events.where("storyId").equals(storyId).sortBy("seq");
        let selected: ChatBatch;
        if (batchId) {
          const old = await db.chatBatches.get(batchId);
          if (!old || old.storyId !== storyId) throw Error("这组回复已不存在");
          selected = { ...old, status: "running", error: "", raw: "", updated: Date.now() };
          const sources = old.sources.map((source) => events.find((e) => e.id === source.id));
          if (sources.some((e) => !e || e.deleted || e.origin !== "user" ||
            e.speaker !== old.player || !sameChat(e, old.player, old.partner)))
            throw Error("本组用户消息已删除或改变身份，请返回待回复后重新选择");
          if (sources.length) {
            selected.sources = sources.map((e) => ({ id: e!.id, versionId: e!.versionId }));
            selected.messages = sources.map((e) => e!.text);
          }
        } else {
          checkPair(s, s.player, s.partner);
          const unfinished = (await db.chatBatches.where("storyId").equals(storyId).toArray())
            .find((b) => b.player === s.player && b.partner === s.partner && b.status !== "complete");
          if (unfinished) throw Error("上一组还未完成，请先重试本组或返回待回复");
          const pending = pendingChatMessages(events, s.player, s.partner);
          if (!pending.length) throw Error("先发送消息，再让 TA 回复");
          selected = newBatch(s, pending, (events.at(-1)?.seq || 0) + 1);
        }
        checkPair(s, selected.player, selected.partner);
        if (!selected.messages.length || selected.messages.some((text) => !text.trim()))
          throw Error("本组消息为空，请返回待回复后重新选择");
        await db.chatBatches.put(selected);
        for (const source of selected.sources)
          await db.events.update(source.id, { chatBatchId: selected.id });
        await db.jobs.add({ id: jobId, storyId, kind: "chat", eventId: "", inputVersion: selected.id,
          status: "running", created: Date.now(), error: "" });
        return { s: { ...s, player: selected.player, partner: selected.partner }, batch: selected,
          replies: events.filter((e) => selected.replyIds.includes(e.id)) };
      });
      batch = snapshot.batch;
      const prepared = await contextFor(snapshot.s, batch, !!batchId || !!legacyEventId, connection);
      const context = prepared.report;
      await db.chatBatches.update(batch.id, { request: context });
      let lastSave = 0;
      const result = await generate(p, key, context.system, context.user, control.signal,
        (text) => {
          raw = text;
          if (Date.now() - lastSave < 250) return;
          lastSave = Date.now();
          saving = saving.then(() => db.chatBatches.update(batch!.id, { raw: text }))
            .then(() => {}).catch((error) => { storageError ??= error; });
        }, fetch, { kind: "chat", stablePrefix: context.stablePrefix, messages: context.messages });
      raw = result.text;
      await saving;
      if (storageError) throw storageError;
      if (control.signal.aborted) throw Error("回复已停止");
      if (!result.complete) throw Error("回复未完整结束 · " + result.reason);
      let texts: string[];
      try { texts = repliesSchema.parse(parseJSON(raw)).messages; }
      catch { throw Error("回复格式未通过检查，原始内容已保留。请重试本组。"); }
      const request = { ...context, usage: result.usage, durationMs: result.durationMs };
      await db.transaction("rw", [db.events, db.stories, db.chatBatches, db.memories, db.jobs, db.promptSessions], async () => {
        if (!await db.stories.get(storyId)) throw Error("故事已删除，未写入回复");
        if (control.signal.aborted) throw Error("回复已停止");
        for (const source of batch!.sources) {
          const current = await db.events.get(source.id);
          if (!current || current.deleted || current.versionId !== source.versionId)
            throw Error("用户消息在生成期间已修改，本次回复未采用。可重试本组。");
        }
        for (const old of snapshot.replies) {
          const current = await db.events.get(old.id);
          if (!current || current.versionId !== old.versionId)
            throw Error("原回复在生成期间已修改，本次结果未覆盖。可重试本组。");
        }
        const events = await db.events.where("storyId").equals(storyId).sortBy("seq");
        const oldReplies = snapshot.replies.sort((a, b) => a.seq - b.seq);
        const tail = oldReplies.at(-1)?.seq;
        const next = tail === undefined ? undefined : events.find((e) => e.seq > tail)?.seq;
        let seq = events.at(-1)?.seq || 0;
        const replyIds: string[] = [];
        for (let i = 0; i < texts.length; i++) {
          const old = oldReplies[i];
          if (old) {
            await db.events.update(old.id, { input: batch!.messages.join("\n") });
            await reviseEvent(old.id, texts[i], false, [], old.versionId);
            await db.events.update(old.id, { raw, request, input: batch!.messages.join("\n"),
              status: "complete", error: "", chatBatchId: batch!.id });
            replyIds.push(old.id);
          } else {
            const position = tail !== undefined && next !== undefined
              ? tail + (next - tail) * (i - oldReplies.length + 1) / (texts.length - oldReplies.length + 1)
              : ++seq;
            const e = message(snapshot.s, position, texts[i], "ai", batch!.id);
            e.input = batch!.messages.join("\n");
            e.versions[0].input = e.input;
            e.request = request;
            await db.events.add(e);
            replyIds.push(e.id);
          }
        }
        for (const old of oldReplies.slice(texts.length))
          await reviseEvent(old.id, old.text, true, [], old.versionId);
        for (const id of replyIds) await db.events.update(id, { review: false });
        // Unanswered user text is original input, so rewriting an earlier AI group cannot stale it.
        for (const e of events)
          if (e.origin === "user" && e.chatPending)
            await db.events.update(e.id, { review: false });
        for (const source of batch!.sources)
          await db.events.update(source.id, { chatPending: false, review: false });
        await db.chatBatches.update(batch!.id, { status: "complete", replyIds, raw, request,
          error: "", updated: Date.now() });
        await db.stories.update(storyId, { updated: Date.now() });
        await db.jobs.update(jobId, { status: "complete" });
        const adopted = await db.events.bulkGet([...batch!.sources.map((source) => source.id), ...replyIds]);
        await commitPrefix(prepared, snapshot.s, raw, adopted.filter((e): e is SceneEvent => !!e), result.usage);
      });
    } catch (error) {
      await saving;
      const message = control.signal.aborted ? "回复已停止，用户消息仍保留，可以重试本组。"
        : error instanceof Error ? error.message : String(error);
      if (batch) await db.chatBatches.update(batch.id, { raw, error: message,
        status: control.signal.aborted ? "interrupted" : "failed", updated: Date.now() });
      await db.jobs.update(jobId, { status: control.signal.aborted ? "interrupted" : "failed", error: message });
      throw Error(message);
    } finally { active.delete(storyId); }
  });
  const s = await db.stories.get(storyId);
  if (s && sharedTimeline(s)) await refreshTimelineMemory(storyId);
  else if (s && s.autoMemory && s.memoryState === "idle" && await memoryDue(s))
    await organizeMemory(storyId).catch(() => {});
}

export async function dismissChatBatch(id: string) {
  const batch = await db.chatBatches.get(id);
  if (!batch) return;
  return withStoryLock(batch.storyId, () => db.transaction("rw", [db.chatBatches, db.events], async () => {
    const current = await db.chatBatches.get(id);
    if (!current || current.status === "running" || active.has(batch.storyId))
      throw Error("请先停止或等待本组回复完成");
    if (current.replyIds.length) {
      await db.chatBatches.update(id, { status: "complete", error: "" });
    } else {
      for (const e of await db.events.where("storyId").equals(current.storyId).toArray())
        if (e.chatBatchId === id)
          await db.events.update(e.id, { chatBatchId: undefined,
            ...(e.origin === "user" ? { chatPending: true } : {}) });
      await db.chatBatches.delete(id);
    }
  }));
}
