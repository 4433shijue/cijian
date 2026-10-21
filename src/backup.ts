import { generatorTables, generatorSchemas } from "./generator-types";
import { completionBackupRows } from "./completion-backup";
import { validateGeneratorBackup, remapGenerator } from "./generator-backup";
import { ensureAutomation } from "./phone-automation";
import { extraSchemas, extraTables, automationTables } from "./work-types";
import { migrateStories } from "./story-service";
import { remapExtra, validateExtras } from "./work-backup";
import { phoneSchemas, phoneTables } from "./phone-types";
import { remapPhone, ensurePhone } from "./phone-store";
import { checkPhoneBackup } from "./phone-backup";
import { z } from "zod";
import { db } from "./db";
import { uid, type TheaterPreset, type TheaterRecord, type TheaterState } from "./types";
import { samplingParameters } from "./sampling";
import { builtInTheaterPresets, normalizeTheaterPresentation, resolveTheaterPreset } from "./theater-presets";
import { theaterDataSchema } from "./theater-data";
import { htmlPageSchema, validateHtmlState } from "./theater-html";
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
const theaterStatus = z.enum(["running", "complete", "failed", "interrupted"]);
const theaterPresentation = z.enum([
  "dialogue",
  "detail-list",
  "subtext-card",
  "forum",
  "body-status",
  "evidence-board",
  "relationship-card",
  "scene-board",
  "custom",
  "freeform", // Legacy value written by an intermediate 2.2.0 build.
  "body-card", // Legacy alias accepted during the unpublished transition.
  "evidence",
  "relationship",
]).transform(normalizeTheaterPresentation);
// Configuration may inherit a built-in presentation; historical snapshots may
// not. Resolve configuration while the original ID is still available.
const theaterPresetSnapshot = z.object({
  id: str.min(1),
  name: str.min(1),
  prompt: str,
  presentation: theaterPresentation.optional(),
  experience: str.optional(),
});
const theaterPresetConfig = theaterPresetSnapshot.transform(resolveTheaterPreset);
const theater = z.object({
  id: str,
  storyId: str,
  eventId: str,
  sourceVersionId: str,
  presets: z.array(theaterPresetSnapshot),
  html: str,
  text: str,
  raw: str,
  status: theaterStatus,
  error: str,
  created: z.number(),
  updated: z.number(),
  previousId: str.optional(),
  density: z.enum(["light", "standard", "rich"]).optional(),
  data: theaterDataSchema.optional(),
  likes: ids.optional(),
  bookmarks: ids.optional(),
  replyDrafts: z.record(str).optional(),
  reading: z.object({ clarity: z.boolean(), fontSize: z.number().finite().min(12).max(32) }).optional(),
  interaction: z.object({
    id: str.min(1),
    sectionId: str.min(1),
    itemId: str.min(1).optional(),
    userItemId: str.min(1).optional(),
    kind: z.enum(["reply", "expand"]),
    input: str,
    status: theaterStatus,
    raw: str,
    error: str,
    created: z.number().finite(),
    updated: z.number().finite(),
  }).optional(),
  revision: z.number().int().nonnegative().safe().optional(),
  htmlPages: z.array(htmlPageSchema).min(1).max(32).optional(),
  htmlStates: z.record(z.custom<TheaterState>((value) => { try { validateHtmlState(value); return true; } catch { return false; } })).optional(),
  htmlText: z.record(str.max(200000)).optional(),
  htmlHistory: z.array(z.object({ pageId: str, html: str.max(2000000), requestId: str, created: z.number() })).optional(),
}).superRefine((record, context) => {
  const sections = record.data?.sections ?? [];
  const presetIds = new Set(record.presets.map((preset) => preset.id));
  if (sections.some((section) => !presetIds.has(section.id)))
    context.addIssue({ code: "custom", message: "小剧场栏目与预设关联无效", path: ["data"] });
  const pages = record.htmlPages || [];
  const pageIds = new Set(pages.map((page) => page.id));
  if (pageIds.size !== pages.length || pages.some((page) => !presetIds.has(page.id)) ||
      Object.keys(record.htmlStates || {}).some((id) => !pageIds.has(id)) || Object.keys(record.htmlText || {}).some((id) => !pageIds.has(id)) ||
      record.htmlHistory?.some((item) => !pageIds.has(item.pageId)))
    context.addIssue({ code: "custom", message: "HTML 小剧场栏目或状态关联无效", path: ["htmlPages"] });
  const itemKeys = new Set(sections.flatMap((section) => section.items.map((item) => section.id + "/" + item.id)));
  for (const field of ["likes", "bookmarks"] as const)
    if (record[field]?.some((key) => !itemKeys.has(key)))
      context.addIssue({ code: "custom", message: "小剧场互动标记关联无效", path: [field] });
  if (record.replyDrafts && Object.keys(record.replyDrafts).some((id) => !sections.some((section) => section.id === id)))
    context.addIssue({ code: "custom", message: "小剧场回复草稿关联无效", path: ["replyDrafts"] });
  if (record.interaction) {
    const interaction = record.interaction;
    const section = sections.find((section) => section.id === interaction.sectionId);
    if ((!section && !pageIds.has(interaction.sectionId)) || [interaction.itemId, interaction.userItemId].some((id) => id && !section?.items.some((item) => item.id === id)))
      context.addIssue({ code: "custom", message: "小剧场追加内容关联无效", path: ["interaction"] });
  }
});
const story = z.object({
  kind: z.enum(["novel", "phone"]).optional(),
  id: str,
  title: str,
  background: str,
  roles: z.array(role),
  worldIds: ids,
  created: z.number(),
  updated: z.number(),
  archived: z.boolean().optional(),
  draft: str,
  chatDraft: str,
  player: str,
  partner: str,
  length: str,
  style: str,
  stylePresetId: str.optional(),
  theaterAuto: z.boolean().optional(),
  theaterPresetIds: ids.optional(),
  theaterDensity: z.enum(["light", "standard", "rich"]).optional(),
  psychology: z.boolean(),
  timelineMode: z.enum(["shared", "strict"]).optional(),
  autoMemory: z.boolean(),
  chatThreshold: z.number().nonnegative(),
  novelThreshold: z.number().nonnegative(),
  memoryCursor: z.number(),
  memoryState: z.enum(["idle", "running", "failed", "interrupted"]),
  memoryError: str,
  nextRound: z.number().int().positive().optional(),
  contextWindowStart: z.number().int().nonnegative().optional(),
  memoryAutoStart: z.number().int().positive().optional(),
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
  round: z.number().int().positive().optional(),
  theater: z
    .object({
      id: str,
      sourceVersionId: str,
      status: theaterStatus,
      previousId: str.optional(),
    })
    .optional(),
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
  kind: z.literal("round").optional(),
  rounds: z.array(z.number().int().positive()).optional(),
  batchRounds: z.array(z.number().int().positive()).optional(),
  timelineMode: z.enum(["shared", "strict"]).optional(),
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
  generatorConnection: z.enum(["inherit","dedicated"]).optional(),
  generatorProfileId: str.optional(),
  generatorLegacyMigrated: z.boolean().optional(),
  developer: z.boolean(),
  dialogueCheck: z.boolean().optional(),
  inspirationParagraphs: z.number().int().min(1).max(20).optional(),
  novelContextRounds: z.number().int().min(1).max(50).optional(),
  memoryIntervalRounds: z.number().int().positive().safe().optional(),
  memoryAutoReadLimit: z.number().int().nonnegative().safe().optional(),
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
  theaterPresets: z
    .array(theaterPresetConfig)
    .refine(
      (presets) => new Set(presets.map((p) => p.id)).size === presets.length,
      "小剧场预设 ID 重复",
    )
    .optional(),
  prompts: z.record(
    z.enum(["novel", "chat", "facts", "memory", "inspiration", "theater", "phoneDecision", "phoneMoment", "phoneInteraction", "phoneDocument", "phoneEvent", "phoneVariant", "phoneHabits", "generatorInterview", "generatorIf", "generatorCompose"]),
    z.object({ text: str, enabled: z.boolean() }),
  ),
});
export const recordSchemas = {
  ...phoneSchemas, ...extraSchemas, ...generatorSchemas,
  roles: role,
  stories: story,
  world,
  events: event,
  memories: memory,
  profiles: profile,
  preferences: prefs,
  chatBatches: chatBatch,
  theaters: theater,
  roleDrafts: z.object({ id: str, role }),
};
const schema = z.object({
  generatorSessions: z.array(generatorSchemas.generatorSessions).default([]),
  generatorMaterials: z.array(generatorSchemas.generatorMaterials).default([]),
  generatorTurns: z.array(generatorSchemas.generatorTurns).default([]),
  generatorSteps: z.array(generatorSchemas.generatorSteps).default([]),
  generatorResults: z.array(generatorSchemas.generatorResults).default([]),

  phoneAutomationSettings: z.array(extraSchemas.phoneAutomationSettings).default([]),
  phoneAutomationRuns: z.array(extraSchemas.phoneAutomationRuns).default([]),
  phoneAutomationSteps: z.array(extraSchemas.phoneAutomationSteps).default([]),
  phoneKnowledge: z.array(extraSchemas.phoneKnowledge).default([]),
  phoneWorldEvents: z.array(extraSchemas.phoneWorldEvents).default([]),
  storyWorld: z.array(extraSchemas.storyWorld).default([]),
  storyMigrations: z.array(extraSchemas.storyMigrations).default([]),
  legacyArchives: z.array(extraSchemas.legacyArchives).default([]),
  phoneBackgrounds: z.array(extraSchemas.phoneBackgrounds).default([]),
  phoneDocuments: z.array(extraSchemas.phoneDocuments).default([]),
  phoneReading: z.array(extraSchemas.phoneReading).default([]),
  phoneDrafts: z.array(extraSchemas.phoneDrafts).default([]),
  phoneEdits: z.array(extraSchemas.phoneEdits).default([]),
  phoneSpaces: z.array(phoneSchemas.phoneSpaces).default([]),
  phoneConversations: z.array(phoneSchemas.phoneConversations).default([]),
  phoneRecords: z.array(phoneSchemas.phoneRecords).default([]),
  phoneAssets: z.array(phoneSchemas.phoneAssets).default([]),
  phoneRuns: z.array(phoneSchemas.phoneRuns).default([]),
  format: z.literal("little-scene"),
  version: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5), z.literal(6), z.literal(7), z.literal(8)]),
  created: str,
  roles: z.array(role),
  stories: z.array(story),
  world: z.array(world),
  events: z.array(event),
  memories: z.array(memory),
  profiles: z.array(profile),
  preferences: z.array(prefs),
  chatBatches: z.array(chatBatch).default([]),
  roleDrafts: z.array(recordSchemas.roleDrafts).default([]),
  theaters: z.array(theater).default([]),
  scope: z.enum(["library", "story"]).optional(),
  title: str.optional(),
});
export type Backup = z.infer<typeof schema>;

export function normalizeTheaterPresetSnapshot(
  preset: Omit<TheaterPreset, "presentation"> & { presentation?: unknown },
): TheaterPreset {
  const { presentation, ...snapshot } = preset;
  return presentation === undefined
    ? snapshot
    : { ...snapshot, presentation: normalizeTheaterPresentation(presentation) };
}

// Item IDs and reply links live inside each saved result. Only preset/section
// identities change when a copied backup keeps a conflicting local preset.
export function remapTheaterContent(
  record: Pick<TheaterRecord, "data" | "likes" | "bookmarks" | "replyDrafts" | "interaction" | "htmlPages" | "htmlStates" | "htmlText" | "htmlHistory">,
  presetIds: ReadonlyMap<string, string>,
) {
  const sectionId = (id: string) => presetIds.get(id) || id;
  const itemKeys = new Map(record.data?.sections.flatMap((section) =>
    section.items.map((item) => [section.id + "/" + item.id, sectionId(section.id) + "/" + item.id] as const),
  ));
  return {
    htmlPages: record.htmlPages?.map((page) => ({ ...page, id: sectionId(page.id) })),
    htmlStates: record.htmlStates && Object.fromEntries(Object.entries(record.htmlStates).map(([id, value]) => [sectionId(id), value])),
    htmlText: record.htmlText && Object.fromEntries(Object.entries(record.htmlText).map(([id, value]) => [sectionId(id), value])),
    htmlHistory: record.htmlHistory?.map((item) => ({ ...item, pageId: sectionId(item.pageId) })),
    data: record.data && {
      ...record.data,
      sections: record.data.sections.map((section) => ({ ...section, id: sectionId(section.id) })),
    },
    likes: record.likes?.map((key) => itemKeys.get(key) || key),
    bookmarks: record.bookmarks?.map((key) => itemKeys.get(key) || key),
    replyDrafts: record.replyDrafts && Object.fromEntries(
      Object.entries(record.replyDrafts).map(([id, value]) => [sectionId(id), value]),
    ),
    interaction: record.interaction && {
      ...record.interaction,
      sectionId: sectionId(record.interaction.sectionId),
      status: record.interaction.status === "running" ? "interrupted" as const : record.interaction.status,
      error: record.interaction.status === "running"
        ? "导入的小剧场追加已中断，已有内容保留，可以手动重试。"
        : record.interaction.error,
    },
  };
}

export function validateBackup(raw: unknown) {
  const b = schema.parse(raw);
  if (b.version >= 8) for (const table of generatorTables) if (!Array.isArray((raw as any)[table])) throw Error("备份缺少资料区：" + table);
  validateGeneratorBackup(b);
  if (b.version >= 5) for (const table of phoneTables) if (!Array.isArray((raw as any)[table])) throw Error("备份缺少资料区：" + table);
  checkPhoneBackup(b);
  validateExtras(b);
  if (b.version >= 6) {
    for (const table of extraTables.filter(t => b.version >= 7 || !automationTables.includes(t as any))) if (!Array.isArray((raw as any)[table])) throw Error("备份缺少资料区：" + table);
    if (b.stories.some(s => !s.kind)) throw Error("新版备份缺少作品类型");
  }
  if (
    b.version >= 2 &&
    (!raw ||
      typeof raw !== "object" ||
      !Array.isArray((raw as { theaters?: unknown }).theaters))
  )
    throw Error("备份缺少资料区：theaters");
  for (const p of b.profiles) samplingParameters(p);
  for (const list of [
    b.roles,
    b.stories,
    b.world,
    b.events,
    b.memories,
    b.profiles,
    b.chatBatches,
    b.theaters,
  ])
    if (new Set(list.map((x) => x.id)).size !== list.length)
      throw Error("备份存在重复 ID");
  const stories = new Set(b.stories.map((x) => x.id));
  const events = new Map(b.events.map((x) => [x.id, x]));
  const batches = new Map(b.chatBatches.map((x) => [x.id, x]));
  const theaters = new Map(b.theaters.map((x) => [x.id, x]));
  for (const t of b.theaters) {
    const e = events.get(t.eventId);
    if (
      !e ||
      e.storyId !== t.storyId ||
      e.kind !== "novel" ||
      (!e.versions.some((v) => v.id === t.sourceVersionId) &&
        !(e.status === "draft" && e.versionId === t.sourceVersionId))
    )
      throw Error("备份小剧场的正文来源不完整");
    if (t.previousId) {
      const previous = theaters.get(t.previousId);
      if (
        !previous ||
        previous.id === t.id ||
        previous.storyId !== t.storyId ||
        previous.eventId !== t.eventId ||
        previous.status !== "complete"
      )
        throw Error("备份小剧场的已有结果关联无效");
    }
  }
  for (const e of b.events) {
    if (!e.theater) continue;
    const t = theaters.get(e.theater.id);
    if (
      !t ||
      t.storyId !== e.storyId ||
      t.eventId !== e.id ||
      t.sourceVersionId !== e.theater.sourceVersionId ||
      t.status !== e.theater.status ||
      t.previousId !== e.theater.previousId
    )
      throw Error("备份正文的小剧场关联无效");
  }
  for (const batch of b.chatBatches) {
    const s = b.stories.find((s) => s.id === batch.storyId);
    const matches = (id: string, speaker: string) => {
      const e = events.get(id);
      return (
        e &&
        e.storyId === batch.storyId &&
        e.kind === "message" &&
        e.speaker === speaker &&
        e.participants.length === 2 &&
        e.participants.includes(batch.player) &&
        e.participants.includes(batch.partner) &&
        e.chatBatchId === batch.id
      );
    };
    if (
      !s ||
      batch.player === batch.partner ||
      ![batch.player, batch.partner].every((id) =>
        s.roles.some((r) => r.id === id),
      ) ||
      new Set(batch.sources.map((x) => x.id)).size !== batch.sources.length ||
      new Set(batch.replyIds).size !== batch.replyIds.length ||
      (batch.sources.length > 0 &&
        batch.sources.length !== batch.messages.length) ||
      batch.sources.some(
        (ref) =>
          !matches(ref.id, batch.player) ||
          events.get(ref.id)?.origin !== "user" ||
          !events.get(ref.id)?.versions.some((v) => v.id === ref.versionId),
      ) ||
      batch.replyIds.some(
        (id) =>
          !matches(id, batch.partner) || events.get(id)?.origin === "user",
      )
    )
      throw Error("备份聊天批次关联不完整");
  }
  for (const e of b.events) {
    if (!e.chatBatchId) continue;
    const batch = batches.get(e.chatBatchId);
    if (
      !batch ||
      batch.storyId !== e.storyId ||
      e.kind !== "message" ||
      (e.origin === "user" &&
        !batch.sources.some((source) => source.id === e.id))
    )
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

// Imported overrides receive private IDs so they cannot change another story's
// built-in preset. Identical local definitions can safely share their ID.
export function mergeTheaterPresets(
  existing: TheaterPreset[],
  imported: TheaterPreset[],
) {
  const presets = existing.map(resolveTheaterPreset);
  const ids = new Map<string, string>();
  const builtIns = new Set(builtInTheaterPresets.map((preset) => preset.id));
  for (const source of imported) {
    const preset = resolveTheaterPreset(source);
    const current = presets.find((p) => p.id === preset.id);
    if (
      current &&
      current.name === preset.name &&
      current.prompt === preset.prompt &&
      current.presentation === preset.presentation
    )
      continue;
    const id = current || builtIns.has(preset.id) ? uid() : preset.id;
    ids.set(preset.id, id);
    presets.push({ ...preset, id });
  }
  return { presets, ids };
}
export async function exportBackup() {
  return db.transaction(
    "r",
    [
      ...[...phoneTables, ...extraTables, ...generatorTables].map((t) =>
        db.table(t),
      ),
      db.roles,
      db.stories,
      db.world,
      db.events,
      db.memories,
      db.profiles,
      db.preferences,
      db.chatBatches,
      db.theaters,
      db.roleCompletionDrafts,
    ],
    async () => {
      const legacy = completionBackupRows(
        await db.roleCompletionDrafts.get("role-completion"),
      );
      return {
        format: "little-scene",
        version: 8,
        ...Object.fromEntries(
          await Promise.all(
            [...extraTables, ...generatorTables].map(async (t) => [
              t,
              [
                ...(await db.table(t).toArray()),
                ...(t in legacy ? legacy[t as keyof typeof legacy] : []),
              ],
            ]),
          ),
        ),
        phoneSpaces: await db.phoneSpaces.toArray(),
        phoneConversations: await db.phoneConversations.toArray(),
        phoneRecords: await db.phoneRecords.toArray(),
        phoneAssets: await db.phoneAssets.toArray(),
        phoneRuns: await db.phoneRuns.toArray(),
        created: new Date().toISOString(),
        roles: await db.roles.toArray(),
        stories: (await db.stories.toArray()).map(
          ({
            inspiration,
            inspirationRequest,
            inspirationRevision,
            memorySelection,
            ...story
          }) => ({
            ...story,
            theaterDensity: story.theaterDensity ?? "standard",
          }),
        ),
        world: await db.world.toArray(),
        events: (await db.events.toArray()).map(({ request, ...e }) => e),
        memories: await db.memories.toArray(),
        profiles: (await db.profiles.toArray()).map(({ key, ...p }) => ({
          ...p,
          remember: false,
        })),
        preferences: (await db.preferences.toArray()).map((preferences) => ({
          ...preferences,
          theaterPresets: preferences.theaterPresets?.map(resolveTheaterPreset),
        })),
        chatBatches: (await db.chatBatches.toArray()).map(
          ({ request, ...batch }) => batch,
        ),
        theaters: (await db.theaters.toArray()).map((theater) => ({
          ...theater,
          presets: theater.presets.map(normalizeTheaterPresetSnapshot),
          density: theater.density ?? "standard",
        })),
      };
    },
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
    if (
      (await db.generatorSessions.filter(s => !!s.lease && s.lease.until > Date.now()).count()) ||
      (await db.phoneAutomationRuns.where("status").equals("running").count()) ||
      (await db.phoneRuns.where("status").equals("running").count()) ||
      (await db.jobs.where("status").equals("running").count()) ||
      (await db.chatBatches.where("status").equals("running").count()) ||
      (await db.theaters.where("status").equals("running").count()) ||
      (await db.theaters.where("interaction.status").equals("running").count())
    )
      throw Error(
        "请先停止正在进行的生成或记忆整理，再导入备份。现有资料未改变。",
      );
    const theaterPresets = mergeTheaterPresets(
      replace
        ? []
        : (await db.preferences.get("preferences"))?.theaterPresets || [],
      b.preferences[0]?.theaterPresets || [],
    );
    if (replace)
      for (const table of db.tables)
        if (![db.roleDrafts.name, db.roleCompletionDrafts.name].includes(table.name)) await table.clear();
    for (const table of generatorTables) await db.table(table).bulkAdd(b[table].map(row => remapGenerator(table,row,remap)));
    for (const table of extraTables) await db.table(table).bulkAdd(b[table].map(row => remapExtra(table, row, remap)));
    for (const table of phoneTables) await db.table(table).bulkAdd(b[table].map(row => remapPhone(table, row, remap)));
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
        kind: x.kind as import("./types").Story["kind"],
        roles: x.roles.map(r),
        worldIds: x.worldIds.map(remap),
        player: remap(x.player),
        partner: remap(x.partner),
        stylePresetId: x.stylePresetId,
        theaterPresetIds: (x.theaterPresetIds ?? ["theater-roast"]).map(
          (id) => theaterPresets.ids.get(id) || id,
        ),
        theaterDensity: x.theaterDensity ?? "standard",
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
        theater: x.theater && {
          ...x.theater,
          id: remap(x.theater.id),
          sourceVersionId: remap(x.theater.sourceVersionId),
          previousId: x.theater.previousId
            ? remap(x.theater.previousId)
            : undefined,
          status:
            x.theater.status === "running"
              ? ("interrupted" as const)
              : x.theater.status,
        },
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
    await db.chatBatches.bulkAdd(
      b.chatBatches.map((x) => ({
        ...x,
        id: remap(x.id),
        storyId: remap(x.storyId),
        player: remap(x.player),
        partner: remap(x.partner),
        sources: x.sources.map((ref) => ({
          id: remap(ref.id),
          versionId: remap(ref.versionId),
        })),
        replyIds: x.replyIds.map(remap),
        status: x.status === "running" ? ("interrupted" as const) : x.status,
        error:
          x.status === "running"
            ? "导入的回复尚未完成，可以重试本组。"
            : x.error,
      })),
    );
    await db.theaters.bulkAdd(
      b.theaters.map((x) => ({
        ...x,
        ...remapTheaterContent(x, theaterPresets.ids),
        id: remap(x.id),
        storyId: remap(x.storyId),
        eventId: remap(x.eventId),
        sourceVersionId: remap(x.sourceVersionId),
        previousId: x.previousId ? remap(x.previousId) : undefined,
        density: x.density ?? "standard",
        presets: x.presets.map((p) => ({
          ...p,
          id: theaterPresets.ids.get(p.id) || p.id,
        })),
        status: x.status === "running" ? ("interrupted" as const) : x.status,
        error:
          x.status === "running"
            ? "导入的小剧场尚未完成，可以重新生成。"
            : x.error,
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
              theaterPresets: theaterPresets.presets,
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
              theaterPresets: theaterPresets.presets,
              activeProfile: remap(imported.activeProfile),
              generatorProfileId: imported.generatorProfileId ? remap(imported.generatorProfileId) : undefined,
              stylePresets: imported.stylePresets?.map((preset) => ({
                ...preset,
                builtIn: false,
              })),
            },
      );
    await migrateStories();
    for(const story of await db.stories.where("kind").equals("phone").toArray())await ensureAutomation(story.id);
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
