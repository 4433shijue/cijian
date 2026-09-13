import { withStoryLock } from "./locks";
import { z } from "zod";
import { db, keyFor, reviseEvent } from "./db";
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
const novelSchema = z.object({
  text: z.string().min(1),
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
export function parseJSON(raw: string) {
  return JSON.parse(
    raw
      .trim()
      .replace(/^```(?:json)?\s*/, "")
      .replace(/\s*```$/, ""),
  );
}
export function draftText(raw: string) {
  try {
    const d = parseJSON(raw);
    return d.text || d.messages?.join("\n") || "";
  } catch {
    const m = raw.match(/"text"\s*:\s*"((?:[^"\\]|\\.)*)/s);
    if (m) {
      try {
        return JSON.parse('"' + m[1] + '"');
      } catch {
        return m[1].replace(/\\n/g, "\n");
      }
    }
    return "";
  }
}
export function checkQuotes(input: string, text: string) {
  const quotes = [...input.matchAll(/[“「"]([^”」"]+)[”」"]/g)].map(
    (m) => m[1],
  );
  if (quotes.some((q) => !text.includes(q)))
    throw Error("输出改动或遗漏了明确台词，已保留草稿，请检查后重写。");
}
const active = new Map<string, AbortController>();
export const isBusy = (id: string) => active.has(id);
export function stop(id: string) {
  active.get(id)?.abort();
}
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
) {
  return buildContext(
    kind,
    s,
    (await db.events.where("storyId").equals(s.id).sortBy("seq")).filter(
      (e) => e.seq < until,
    ),
    await db.memories.where("storyId").equals(s.id).toArray(),
    await db.world.toArray(),
    prefs,
    p,
    input,
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
) {
  if (active.has(storyId)) throw Error("这个故事正在生成，请先停止或等待完成");
  if (!input.trim()) throw Error("先写下这一刻发生的事");
  const control = new AbortController();
  active.set(storyId, control);
  let event: SceneEvent | undefined,
    jobId = uid(),
    success = false;
  try {
    const s = await db.stories.get(storyId);
    if (!s) throw Error("故事不存在");
    if (kind === "chat" && (!s.partner || s.partner === s.player))
      throw Error("请选择两位不同的聊天角色");
    const { p, prefs, key } = await settings();
    if (!key.trim()) throw Error("请先到设置填写 API Key，当前没有发送请求");
    const old = rewriteId ? await db.events.get(rewriteId) : undefined;
    if (rewriteId && !old) throw Error("要重写的内容已不存在");
    if (old && kind === "chat") {
      s.player = old.participants.find((x) => x !== old.speaker) || s.player;
      s.partner = old.speaker;
    }
    const context = await report(s, p, prefs, kind, input, old?.seq);
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
    let saving = Promise.resolve();
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
            .then(() => {});
        }
      },
    );
    await saving;
    event.raw = result.text;
    event.request = { ...context, usage: result.usage };
    if (!result.complete) throw Error("服务未完整结束 · " + result.reason);
    let texts: string[];
    if (kind === "novel") {
      const data = novelSchema.parse(parseJSON(result.text));
      checkQuotes(input, data.text);
      texts = [data.text];
      event.facts = data.facts
        .filter((f) => data.text.includes(f.quote))
        .map((f) => ({
          id: uid(),
          text: f.quote,
          quote: f.quote,
          knownBy: [],
        }));
    } else texts = chatSchema.parse(parseJSON(result.text)).messages;
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
    await db.transaction("rw", [db.events, db.stories], async () => {
      if (!(await db.stories.get(storyId)))
        throw Error("故事已删除，未写入结果");
      if (!old) await db.events.put(event!);
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
        ...(!old &&
        (kind === "novel" ? latest?.draft : latest?.chatDraft) === input
          ? kind === "novel"
            ? { draft: "" }
            : { chatDraft: "" }
          : {}),
      });
    });
    if (old) {
      await reviseEvent(
        old.id,
        texts.join("\n"),
        false,
        event.facts,
        old.versionId,
      );
      await db.events.update(old.id, {
        status: "complete",
        error: "",
        raw: result.text,
        request: event.request,
      });
      await db.events.delete(event.id);
      event = undefined;
    }
    await db.jobs.update(jobId, { status: "complete" });
    success = true;
  } catch (error) {
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
    const result = await generate(p, key, r.system, r.user, control.signal);
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
    await reviseEvent(id, e.text, false, facts);
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
    const events = await db.events
      .where("storyId")
      .equals(storyId)
      .filter(
        (e) =>
          e.seq > s.memoryCursor &&
          e.status === "complete" &&
          !e.deleted &&
          !e.review,
      )
      .sortBy("seq");
    if (!events.length) return;
    const { p, prefs, key } = await settings();
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
    const rows = events.map((e) => ({
      id: e.id,
      text: e.text,
      knownBy: e.kind === "message" ? e.participants : [],
      facts: e.facts,
    }));
    const r = assemble(
      prompt("memory", prefs),
      JSON.stringify(rows),
      [],
      p.context,
      p.maxOutput,
    );
    const result = await generate(p, key, r.system, r.user, controller.signal);
    if (!result.complete) throw Error("整理未完整结束，进度未前移");
    const parsed = memoriesSchema.parse(parseJSON(result.text));
    await db.transaction(
      "rw",
      [db.events, db.memories, db.stories, db.jobs],
      async () => {
        for (const e of events)
          if ((await db.events.get(e.id))?.versionId !== e.versionId)
            throw Error("整理期间经历已修改，请重新整理");
        for (const m of parsed.memories) {
          const sources = events.filter((e) => m.sourceIds.includes(e.id));
          if (sources.length !== new Set(m.sourceIds).size) continue;
          const audience = s.roles
            .map((r) => r.id)
            .filter((id) =>
              sources.every((e) =>
                e.kind === "message" ? e.participants.includes(id) : false,
              ),
            );
          await db.memories.add({
            id: uid(),
            storyId,
            text: m.text,
            knownBy: m.knownBy.filter((id) => audience.includes(id)),
            scope: m.scope,
            sources: sources.map((e) => ({ id: e.id, versionId: e.versionId })),
            status: "candidate",
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
) {
  if (active.has(storyId)) throw Error("这个故事正在生成，请先停止或等待完成");
  await withStoryLock(storyId, () =>
    runUnlocked(storyId, kind, input, rewriteId),
  );
  const s = await db.stories.get(storyId);
  if (s && s.autoMemory && s.memoryState === "idle" && (await memoryDue(s)))
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
