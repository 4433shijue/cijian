import { z } from "zod";
import { db } from "./db";
import { uid } from "./types";
import { samplingParameters } from "./sampling";
const str = z.string(),
  ids = z.array(str),
  aud = z.enum(["all", "roles", "author"]);
const paragraph = z.object({
  id: str,
  text: str,
  pin: z.boolean(),
  public: z.boolean(),
});
const role = z.object({
  id: str,
  name: str,
  bio: str,
  persona: str,
  avatar: str,
  paragraphs: z.array(paragraph),
  sourceId: str.optional(),
  updated: z.number(),
});
const fact = z.object({ id: str, text: str, quote: str, knownBy: ids });
const version = z.object({
  id: str,
  text: str,
  input: str,
  created: z.number(),
  facts: z.array(fact),
  deleted: z.boolean().optional(),
  visibility: z.enum(["inherit", "author", "facts"]).optional(),
});
const story = z.object({
  id: str,
  title: str,
  background: str,
  roles: z.array(role),
  worldIds: ids,
  created: z.number(),
  updated: z.number(),
  draft: str,
  chatDraft: str,
  player: str,
  partner: str,
  length: str,
  style: str,
  stylePresetId: str.optional(),
  psychology: z.boolean(),
  timelineMode: z.enum(["shared", "strict"]).optional(),
  autoMemory: z.boolean(),
  chatThreshold: z.number().nonnegative(),
  novelThreshold: z.number().nonnegative(),
  memoryCursor: z.number(),
  memoryState: z.enum(["idle", "running", "failed", "interrupted"]),
  memoryError: str,
});
const world = z.object({
  id: str,
  title: str,
  text: str,
  type: z.enum(["world", "relationship", "rule", "fact"]),
  enabled: z.boolean(),
  always: z.boolean(),
  keywords: ids,
  roleIds: ids,
  match: z.enum(["any", "all"]).optional(),
  storyIds: ids,
  knownBy: ids,
  audience: aud,
});
const event = z.object({
  id: str,
  storyId: str,
  seq: z.number(),
  kind: z.enum(["novel", "message"]),
  origin: z.enum(["user", "ai"]).optional(),
  speaker: str,
  participants: ids,
  input: str,
  text: str,
  facts: z.array(fact),
  versions: z.array(version),
  versionId: str,
  status: z.enum(["complete", "draft"]),
  raw: str,
  error: str,
  review: z.boolean(),
  deleted: z.boolean(),
  created: z.number(),
  collapsed: z.boolean().optional(),
  rewriteOf: z.object({ id: str, versionId: str }).optional(),
  acceptedByAuthor: z.boolean().optional(),
  visibility: z.enum(["inherit", "author", "facts"]).optional(),
  warnings: ids.optional(),
  chatPending: z.boolean().optional(),
  chatBatchId: str.optional(),
});
const chatBatch = z.object({
  id: str,
  storyId: str,
  player: str,
  partner: str,
  sources: z.array(z.object({ id: str, versionId: str })),
  messages: z.array(str.min(1)).min(1),
  replyIds: ids,
  cutoff: z.number().finite(),
  status: z.enum(["running", "complete", "failed", "interrupted"]),
  created: z.number(),
  updated: z.number(),
  raw: str,
  error: str,
});
const memory = z.object({
  id: str,
  storyId: str,
  text: str,
  knownBy: ids,
  scope: z.enum(["story", "roles"]),
  sources: z.array(z.object({ id: str, versionId: str })),
  status: z.enum(["candidate", "accepted", "ignored", "invalid", "review"]),
  automatic: z.boolean().optional(),
  created: z.number(),
});
const profile = z.object({
  id: str,
  name: str,
  protocol: z.enum(["chat", "responses", "claude", "gemini"]),
  url: str,
  model: str,
  stream: z.boolean(),
  context: z.number().positive(),
  maxOutput: z.number().positive(),
  timeout: z.number().positive(),
  temperature: z.number().finite().min(0).max(2).optional(),
  frequencyPenalty: z.number().finite().min(0).max(2).nullable().optional(),
  outputMode: z.enum(["auto", "schema", "json", "compatible"]).optional(),
  cachePolicy: z.enum(["auto", "off"]).optional(),
  prefixReuse: z.enum(["auto", "on", "off"]).optional(),
  remember: z.boolean(),
  key: str.optional(),
});
const prefs = z.object({
  id: z.literal("preferences"),
  activeProfile: str,
  developer: z.boolean(),
  dialogueCheck: z.boolean().optional(),
  inspirationParagraphs: z.number().int().min(1).max(20).optional(),
  novelContextRounds: z.number().int().min(1).max(50).optional(),
  stylePresets: z
    .array(
      z.object({
        id: str,
        name: str,
        description: str,
        prompt: str,
        scope: z.enum(["novel", "chat", "both"]),
        builtIn: z.boolean().optional(),
      }),
    )
    .optional(),
  prompts: z.record(
    z.enum(["novel", "chat", "facts", "memory", "inspiration"]),
    z.object({ text: str, enabled: z.boolean() }),
  ),
});
const schema = z.object({
  format: z.literal("little-scene"),
  version: z.literal(1),
  created: str,
  roles: z.array(role),
  stories: z.array(story),
  world: z.array(world),
  events: z.array(event),
  memories: z.array(memory),
  profiles: z.array(profile),
  preferences: z.array(prefs),
  chatBatches: z.array(chatBatch).default([]),
});
export type Backup = z.infer<typeof schema>;
export function validateBackup(raw: unknown) {
  const b = schema.parse(raw);
  for (const p of b.profiles) samplingParameters(p);
  for (const list of [
    b.roles,
    b.stories,
    b.world,
    b.events,
    b.memories,
    b.profiles,
    b.chatBatches,
  ])
    if (new Set(list.map((x) => x.id)).size !== list.length)
      throw Error("备份存在重复 ID");
  const stories = new Set(b.stories.map((x) => x.id));
  const events = new Map(b.events.map((x) => [x.id, x]));
  const batches = new Map(b.chatBatches.map((x) => [x.id, x]));
  for (const batch of b.chatBatches) {
    const s = b.stories.find((s) => s.id === batch.storyId);
    const matches = (id: string, speaker: string) => {
      const e = events.get(id);
      return e && e.storyId === batch.storyId && e.kind === "message" &&
        e.speaker === speaker && e.participants.length === 2 &&
        e.participants.includes(batch.player) && e.participants.includes(batch.partner) &&
        e.chatBatchId === batch.id;
    };
    if (!s || batch.player === batch.partner ||
      ![batch.player, batch.partner].every((id) => s.roles.some((r) => r.id === id)) ||
      new Set(batch.sources.map((x) => x.id)).size !== batch.sources.length ||
      new Set(batch.replyIds).size !== batch.replyIds.length ||
      (batch.sources.length > 0 && batch.sources.length !== batch.messages.length) ||
      batch.sources.some((ref) => !matches(ref.id, batch.player) ||
        events.get(ref.id)?.origin !== "user" ||
        !events.get(ref.id)?.versions.some((v) => v.id === ref.versionId)) ||
      batch.replyIds.some((id) => !matches(id, batch.partner) || events.get(id)?.origin === "user"))
      throw Error("备份聊天批次关联不完整");
  }
  for (const e of b.events) {
    if (!e.chatBatchId) continue;
    const batch = batches.get(e.chatBatchId);
    if (!batch || batch.storyId !== e.storyId || e.kind !== "message" ||
      (e.origin === "user" && !batch.sources.some((source) => source.id === e.id)))
      throw Error("备份消息的回复批次无效");
  }
  for (const e of b.events) {
    if (!e.rewriteOf) continue;
    const target = events.get(e.rewriteOf.id);
    if (
      !target ||
      target.id === e.id ||
      target.storyId !== e.storyId ||
      target.kind !== e.kind ||
      !target.versions.some((v) => v.id === e.rewriteOf!.versionId)
    )
      throw Error("重写草稿的原文关联无效");
  }
  for (const e of b.events)
    if (
      !stories.has(e.storyId) ||
      (!e.versions.some((v) => v.id === e.versionId) && e.status === "complete")
    )
      throw Error("备份时间线关联不完整");
  for (const m of b.memories)
    if (
      !stories.has(m.storyId) ||
      m.sources.some(
        (s) =>
          !events.has(s.id) ||
          events.get(s.id)!.storyId !== m.storyId ||
          !events.get(s.id)!.versions.some((v) => v.id === s.versionId),
      )
    )
      throw Error("备份记忆来源不完整");
  return b;
}
export async function exportBackup() {
  return db.transaction(
    "r",
    [
      db.roles,
      db.stories,
      db.world,
      db.events,
      db.memories,
      db.profiles,
      db.preferences,
      db.chatBatches,
    ],
    async () => ({
      format: "little-scene",
      version: 1,
      created: new Date().toISOString(),
      roles: await db.roles.toArray(),
      stories: (await db.stories.toArray()).map(
        ({ inspiration, inspirationRequest, inspirationRevision, ...story }) =>
          story,
      ),
      world: await db.world.toArray(),
      events: (await db.events.toArray()).map(({ request, ...e }) => e),
      memories: await db.memories.toArray(),
      profiles: (await db.profiles.toArray()).map(({ key, ...p }) => ({
        ...p,
        remember: false,
      })),
      preferences: await db.preferences.toArray(),
      chatBatches: (await db.chatBatches.toArray()).map(({ request, ...batch }) => batch),
    }),
  );
}
export async function importBackup(value: unknown, replace = false) {
  const b = validateBackup(value),
    map = new Map<string, string>();
  const remap = (id: string) => {
    if (!id) return "";
    if (!map.has(id)) map.set(id, uid());
    return map.get(id)!;
  };
  const f = (x: z.infer<typeof fact>) => ({
    ...x,
    id: remap(x.id),
    knownBy: x.knownBy.map(remap),
  });
  const r = (x: z.infer<typeof role>) => ({
    ...x,
    id: remap(x.id),
    sourceId: x.sourceId ? remap(x.sourceId) : undefined,
    paragraphs: x.paragraphs.map((p) => ({ ...p, id: remap(p.id) })),
  });
  await db.transaction("rw", db.tables, async () => {
    if (await db.jobs.where("status").equals("running").count() ||
      await db.chatBatches.where("status").equals("running").count())
      throw Error(
        "请先停止正在进行的生成或记忆整理，再导入备份。现有资料未改变。",
      );
    if (replace)
      for (const table of db.tables)
        if (table.name !== db.roleDrafts.name) await table.clear();
    await db.roles.bulkAdd(b.roles.map(r));
    await db.world.bulkAdd(
      b.world.map((x) => ({
        ...x,
        id: remap(x.id),
        roleIds: x.roleIds.map(remap),
        storyIds: x.storyIds.map(remap),
        knownBy: x.knownBy.map(remap),
      })),
    );
    await db.stories.bulkAdd(
      b.stories.map((x) => ({
        ...x,
        id: remap(x.id),
        title: x.title + (replace ? "" : "（导入副本）"),
        roles: x.roles.map(r),
        worldIds: x.worldIds.map(remap),
        player: remap(x.player),
        partner: remap(x.partner),
        stylePresetId: x.stylePresetId,
        memoryState:
          x.memoryState === "running" ? "interrupted" : x.memoryState,
      })),
    );
    await db.events.bulkAdd(
      b.events.map((x) => ({
        ...x,
        id: remap(x.id),
        storyId: remap(x.storyId),
        speaker: remap(x.speaker),
        participants: x.participants.map(remap),
        versionId: remap(x.versionId),
        chatBatchId: x.chatBatchId ? remap(x.chatBatchId) : undefined,
        rewriteOf: x.rewriteOf && {
          id: remap(x.rewriteOf.id),
          versionId: remap(x.rewriteOf.versionId),
        },
        facts: x.facts.map(f),
        versions: x.versions.map((v) => ({
          ...v,
          id: remap(v.id),
          facts: v.facts.map(f),
        })),
      })),
    );
    await db.chatBatches.bulkAdd(b.chatBatches.map((x) => ({
      ...x, id: remap(x.id), storyId: remap(x.storyId),
      player: remap(x.player), partner: remap(x.partner),
      sources: x.sources.map((ref) => ({ id: remap(ref.id), versionId: remap(ref.versionId) })),
      replyIds: x.replyIds.map(remap),
      status: x.status === "running" ? "interrupted" as const : x.status,
      error: x.status === "running" ? "导入的回复尚未完成，可以重试本组。" : x.error,
    })));
    await db.memories.bulkAdd(
      b.memories.map((x) => ({
        ...x,
        id: remap(x.id),
        storyId: remap(x.storyId),
        knownBy: x.knownBy.map(remap),
        sources: x.sources.map((s) => ({
          id: remap(s.id),
          versionId: remap(s.versionId),
        })),
      })),
    );
    await db.profiles.bulkAdd(
      b.profiles.map((x) => ({
        ...x,
        id: remap(x.id),
        remember: false,
        key: undefined,
      })),
    );
    const existing = await db.preferences.get("preferences");
    const imported = b.preferences[0];
    if (imported)
      await db.preferences.put(
        existing
          ? {
              ...existing,
              prompts: { ...existing.prompts, ...imported.prompts },
              stylePresets: [
                ...(existing.stylePresets || []),
                ...(imported.stylePresets || [])
                  .filter(
                    (preset) =>
                      !existing.stylePresets?.some((x) => x.id === preset.id),
                  )
                  .map((preset) => ({ ...preset, builtIn: false })),
              ],
            }
          : {
              ...imported,
              activeProfile: remap(imported.activeProfile),
              stylePresets: imported.stylePresets?.map((preset) => ({
                ...preset,
                builtIn: false,
              })),
            },
      );
  });
}
export function download(
  name: string,
  text: string,
  type = "application/json",
) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
