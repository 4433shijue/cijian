import { z } from "zod";
import { db } from "./db";
import { uid } from "./types";
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
  psychology: z.boolean(),
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
});
const memory = z.object({
  id: str,
  storyId: str,
  text: str,
  knownBy: ids,
  scope: z.enum(["story", "roles"]),
  sources: z.array(z.object({ id: str, versionId: str })),
  status: z.enum(["candidate", "accepted", "ignored", "invalid", "review"]),
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
  remember: z.boolean(),
  key: str.optional(),
});
const prefs = z.object({
  id: z.literal("preferences"),
  activeProfile: str,
  developer: z.boolean(),
  inspirationParagraphs: z.number().int().min(1).max(20).optional(),
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
});
export type Backup = z.infer<typeof schema>;
export function validateBackup(raw: unknown) {
  const b = schema.parse(raw);
  for (const list of [
    b.roles,
    b.stories,
    b.world,
    b.events,
    b.memories,
    b.profiles,
  ])
    if (new Set(list.map((x) => x.id)).size !== list.length)
      throw Error("备份存在重复 ID");
  const stories = new Set(b.stories.map((x) => x.id));
  const events = new Map(b.events.map((x) => [x.id, x]));
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
    if (await db.jobs.where("status").equals("running").count())
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
        facts: x.facts.map(f),
        versions: x.versions.map((v) => ({
          ...v,
          id: remap(v.id),
          facts: v.facts.map(f),
        })),
      })),
    );
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
            }
          : { ...imported, activeProfile: remap(imported.activeProfile) },
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
