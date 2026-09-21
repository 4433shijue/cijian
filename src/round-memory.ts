import { z } from "zod";
import { db, ensureStoryRounds, keyFor } from "./db";
import { active } from "./generation-state";
import { withStoryLock } from "./locks";
import { assemble } from "./context";
import { generate } from "./model";
import { parseJSON } from "./output";
import { prompt } from "./prompts";
import { fullAudience, usableEvent } from "./timeline";
import {
  memoryInterval,
  memoryValid,
  numberedRounds,
  roundLabel,
} from "./rounds";
import {
  uid,
  type Memory,
  type Preferences,
  type Profile,
  type SceneEvent,
  type Story,
} from "./types";

export interface MemoryBatch {
  rounds: number[];
  events: SceneEvent[];
}
const batchKey = (rounds: number[]) =>
  JSON.stringify([...rounds].sort((a, b) => a - b));

export function memoryBatches(
  s: Story,
  events: SceneEvent[],
  memories: Memory[],
  prefs: Preferences,
  all = false,
): MemoryBatch[] {
  const rounds = numberedRounds(events)
    .map((r) => ({ ...r, events: r.events.filter((e) => usableEvent(e, s)) }))
    .filter((r) => r.events.length);
  const normalized = rounds.flatMap((r) => r.events);
  const batches: MemoryBatch[] = [];
  const reserved = new Set<number>();
  // Repair the original range, not just the edited event. Previously ignored
  // memories stay ignored even if later events are rewritten.
  for (const m of memories) {
    if (
      m.kind !== "round" ||
      m.status === "ignored" ||
      !m.batchRounds?.length ||
      memoryValid({ ...m, status: "accepted" }, s, normalized)
    )
      continue;
    if (m.batchRounds.some((n) => reserved.has(n))) continue;
    m.batchRounds.forEach((n) => reserved.add(n));
    const selected = rounds.filter((r) => m.batchRounds!.includes(r.number));
    if (selected.length)
      batches.push({
        rounds: m.batchRounds,
        events: selected.flatMap((r) => r.events),
      });
  }
  const covered = new Set(
    memories
      .filter(
        (m) =>
          m.kind === "round" &&
          (m.status === "ignored" ||
            memoryValid({ ...m, status: "accepted" }, s, normalized)),
      )
      .flatMap((m) => m.sources.map((ref) => ref.id)),
  );
  const pending = rounds.filter(
    (r) =>
      !reserved.has(r.number) &&
      (all || r.number >= (s.memoryAutoStart || 1)) &&
      r.events.some((e) => !covered.has(e.id)),
  );
  const interval = memoryInterval(prefs);
  for (let i = 0; i < pending.length; i += interval) {
    const group = pending.slice(i, i + interval);
    if (!all && group.length < interval) break;
    batches.push({
      rounds: group.map((r) => r.number),
      events: group.flatMap((r) => r.events),
    });
  }
  return batches;
}

type Row = { round?: number; kind?: string; speaker?: string; text: string };
function packRows(
  rows: Row[],
  system: string,
  p: Profile,
  header: string,
): Row[][] {
  const fits = (items: Row[]) => {
    try {
      assemble(
        system,
        header + JSON.stringify(items),
        [],
        p.context,
        p.maxOutput,
      );
      return true;
    } catch {
      return false;
    }
  };
  const parts: Row[] = [];
  for (const row of rows) {
    if (fits([row])) {
      parts.push(row);
      continue;
    }
    let text = row.text;
    while (text) {
      let low = 0,
        high = text.length;
      while (low < high) {
        const n = Math.ceil((low + high) / 2);
        if (fits([{ ...row, text: text.slice(0, n) }])) low = n;
        else high = n - 1;
      }
      // Do not split a UTF-16 surrogate pair.
      if (low && /[\uD800-\uDBFF]/.test(text[low - 1])) low--;
      if (!low)
        throw Error(
          "当前模型容量不足以整理记忆，请增大上下文容量或降低输出限额。",
        );
      parts.push({ ...row, text: text.slice(0, low) });
      text = text.slice(low);
    }
  }
  const groups: Row[][] = [];
  let group: Row[] = [];
  for (const row of parts) {
    if (group.length && !fits([...group, row])) {
      groups.push(group);
      group = [];
    }
    group.push(row);
  }
  if (group.length) groups.push(group);
  return groups;
}

export function memoryRequestCount(
  s: Story,
  batches: MemoryBatch[],
  prefs: Preferences,
  p?: Profile,
) {
  let count = 0;
  for (const batch of batches) {
    const groups = audiences(batch.events, s);
    for (const group of groups.values()) {
      if (!p) {
        count++;
        continue;
      }
      try {
        const n = packRows(
          rowsFor(group, s),
          prompt("memory", prefs),
          p,
          headerFor(batch),
        ).length;
        count += n + (n > 1 ? 1 : 0);
      } catch {
        return undefined;
      }
    }
  }
  return count;
}
const headerFor = (batch: MemoryBatch) =>
  `整理${roundLabel(batch.rounds)}，按给定顺序生成一段连贯小结。缺号回合不在材料内。\n`;
const rowsFor = (events: SceneEvent[], s: Story): Row[] =>
  events.map((e) => ({
    round: e.round,
    kind: e.kind,
    speaker: s.roles.find((r) => r.id === e.speaker)?.name,
    text: e.text,
  }));
function audiences(events: SceneEvent[], s: Story) {
  const groups = new Map<string, SceneEvent[]>();
  for (const e of events) {
    const key = JSON.stringify([...fullAudience(e, s)].sort());
    groups.set(key, [...(groups.get(key) || []), e]);
  }
  return groups;
}

async function summarize(
  group: SceneEvent[],
  batch: MemoryBatch,
  s: Story,
  p: Profile,
  prefs: Preferences,
  key: string,
  signal: AbortSignal,
) {
  const system = prompt("memory", prefs),
    header = headerFor(batch);
  let rows = rowsFor(group, s);
  for (let level = 0; level < 12; level++) {
    const chunks = packRows(rows, system, p, header);
    const summaries: Row[] = [];
    for (const chunk of chunks) {
      signal.throwIfAborted();
      const r = assemble(
        system,
        header + JSON.stringify(chunk),
        [],
        p.context,
        p.maxOutput,
      );
      const result = await generate(
        p,
        key,
        r.system,
        r.user,
        signal,
        undefined,
        fetch,
        { kind: "memory" },
      );
      signal.throwIfAborted();
      if (!result.complete)
        throw Error("记忆整理未完整结束，本批未保存，可重试。");
      const data = z
        .object({ text: z.string().trim().min(1) })
        .parse(parseJSON(result.text));
      summaries.push({ text: data.text.replace(/\s*\n\s*/g, " ") });
    }
    if (summaries.length === 1) return summaries[0].text;
    if (level && summaries.length >= rows.length)
      throw Error("分批记忆仍超过模型容量，本批未保存。请增大容量后重试。");
    rows = summaries;
  }
  throw Error("记忆未能合并为完整段落，本批未保存。");
}

export async function memoryDue(s: Story) {
  const prefs = await db.preferences.get("preferences");
  if (!prefs) return false;
  const events = await db.events.where("storyId").equals(s.id).toArray();
  const memories = await db.memories.where("storyId").equals(s.id).toArray();
  return memoryBatches(s, events, memories, prefs).length > 0;
}

// Backfill is explicitly requested. Automatic work never sweeps pre-upgrade history.
export async function organizeMemory(
  storyId: string,
  options: { all?: boolean } = { all: true },
) {
  return withStoryLock(storyId, async () => {
    if (active.has(storyId)) throw Error("故事正在生成，请等待当前任务完成。");
    const control = new AbortController(),
      jobId = uid();
    active.set(storyId, control);
    let started = false;
    try {
      const s = await ensureStoryRounds(storyId);
      const prefs = await db.preferences.get("preferences");
      const p = prefs && (await db.profiles.get(prefs.activeProfile));
      if (!prefs || !p || !keyFor(p).trim())
        throw Error("请先配置接口和 API Key，尚未发送记忆请求。");
      const events = await db.events
        .where("storyId")
        .equals(storyId)
        .sortBy("seq");
      const memories = await db.memories
        .where("storyId")
        .equals(storyId)
        .toArray();
      const batches = memoryBatches(s, events, memories, prefs, options.all);
      if (!batches.length) return;
      await db.stories.update(storyId, {
        memoryState: "running",
        memoryError: "",
      });
      await db.jobs.add({
        id: jobId,
        storyId,
        kind: "memory",
        eventId: "",
        inputVersion: batchKey(batches.flatMap((b) => b.rounds)),
        status: "running",
        created: Date.now(),
        error: "",
      });
      started = true;
      for (const batch of batches) {
        control.signal.throwIfAborted();
        const results: {
          text: string;
          events: SceneEvent[];
          knownBy: string[];
        }[] = [];
        for (const [audience, group] of audiences(batch.events, s))
          results.push({
            text: await summarize(
              group,
              batch,
              s,
              p,
              prefs,
              keyFor(p),
              control.signal,
            ),
            events: group,
            knownBy: JSON.parse(audience),
          });
        await db.transaction(
          "rw",
          [db.events, db.stories, db.memories],
          async () => {
            control.signal.throwIfAborted();
            const currentStory = await db.stories.get(storyId);
            if (!currentStory || currentStory.timelineMode !== s.timelineMode)
              throw Error("故事或知情范围已改变，本批记忆未保存。");
            for (const e of batch.events) {
              const current = await db.events.get(e.id);
              if (
                !current ||
                !usableEvent(current, currentStory) ||
                current.versionId !== e.versionId ||
                JSON.stringify(fullAudience(current, currentStory)) !==
                  JSON.stringify(fullAudience(e, s))
              )
                throw Error("原文在整理期间已改变，本批记忆未保存，请重试。");
            }
            const existing = (
              await db.memories.where("storyId").equals(storyId).toArray()
            ).filter(
              (m) =>
                m.kind === "round" &&
                batchKey(m.batchRounds || []) === batchKey(batch.rounds),
            );
            for (const m of existing)
              if (m.status !== "ignored") await db.memories.delete(m.id);
            for (const result of results) {
              const old = existing.find(
                (m) =>
                  JSON.stringify([...m.knownBy].sort()) ===
                  JSON.stringify(result.knownBy),
              );
              if (old?.status === "ignored") continue;
              await db.memories.put({
                id: old?.id || uid(),
                storyId,
                text: result.text,
                knownBy: result.knownBy,
                scope: "story",
                status: "accepted",
                created: old?.created || Date.now(),
                kind: "round",
                rounds: [...new Set(result.events.map((e) => e.round!))],
                batchRounds: batch.rounds,
                timelineMode: s.timelineMode || "strict",
                sources: result.events.map((e) => ({
                  id: e.id,
                  versionId: e.versionId,
                })),
              });
            }
            await db.stories.update(storyId, {
              memoryCursor: Math.max(
                s.memoryCursor,
                ...batch.events.map((e) => e.seq),
              ),
            });
          },
        );
      }
      await db.stories.update(storyId, {
        memoryState: "idle",
        memoryError: "",
      });
      await db.jobs.update(jobId, { status: "complete" });
    } catch (error) {
      const message = control.signal.aborted
        ? "记忆整理已停止。已完成批次保留，点击一键补齐可继续。"
        : String(error instanceof Error ? error.message : error);
      if (await db.stories.get(storyId))
        await db.stories.update(storyId, {
          memoryState: control.signal.aborted ? "interrupted" : "failed",
          memoryError: message,
        });
      if (started)
        await db.jobs.update(jobId, {
          status: control.signal.aborted ? "interrupted" : "failed",
          error: message,
        });
      throw Error(message);
    } finally {
      active.delete(storyId);
    }
  });
}

export async function maybeOrganizeMemory(storyId: string) {
  const s = await db.stories.get(storyId);
  if (
    s?.autoMemory &&
    s.memoryState === "idle" &&
    !active.has(storyId) &&
    (await memoryDue(s))
  )
    await organizeMemory(storyId, { all: false }).catch(() => {});
}
const queued = new Set<string>();
export function scheduleAutomaticMemory(storyId: string) {
  if (queued.has(storyId)) return;
  queued.add(storyId);
  setTimeout(() => {
    queued.delete(storyId);
    void maybeOrganizeMemory(storyId).catch(() => {});
  }, 0);
}
