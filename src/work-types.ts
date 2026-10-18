import { z } from "zod";
import { phoneBodySchema } from "./phone-types";

const id = z.string(),
  ids = z.array(id);
const base = { id, storyId: id };
export const storyWorldSchema = z.object({
  ...base,
  title: id,
  text: id,
  type: z.enum(["world", "relationship", "rule", "fact"]),
  enabled: z.boolean(),
  always: z.boolean(),
  keywords: ids,
  roleIds: ids,
  match: z.enum(["any", "all"]).optional(),
  storyIds: ids,
  knownBy: ids,
  audience: z.enum(["all", "roles", "author"]),
  sourceId: id.optional(),
});
export const backgroundSchema = z.object({
  ...base,
  title: id,
  text: id,
  audience: ids,
  enabled: z.boolean(),
  source: z
    .object({
      id,
      version: id,
      seq: z.number(),
      kind: z.enum(["prose", "memory"]),
    })
    .optional(),
  updated: z.number(),
});
const documentContent = {
  title: id,
  text: id,
  assets: ids,
  time: id,
  album: id,
  recipientId: id,
  audience: ids,
  pinned: z.boolean(),
  deleted: z.boolean(),
};
export const documentSchema = z.object({
  ...base,
  ownerId: id,
  kind: z.enum(["note", "photo", "draft"]),
  ...documentContent,
  versionId: id,
  versions: z.array(z.object({ id, ...documentContent, created: z.number() })),
  created: z.number(),
  updated: z.number(),
});
export const readerApps = [
  "messages",
  "contacts",
  "moments",
  "notes",
  "photos",
  "drafts",
] as const;
export const targetSchema = z.object({
  ownerId: id,
  type: z.enum(["app", "record", "document"]),
  id,
});
export const conditionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("read"), target: targetSchema }),
  z.object({ type: z.literal("clue"), ruleId: id }),
  z.object({ type: z.literal("password"), answers: ids.min(1) }),
]);
export const ruleSchema = z.object({
  id,
  title: id,
  targets: z.array(targetSchema).min(1),
  match: z.enum(["all", "any"]),
  conditions: z.array(conditionSchema).min(1),
  hint: id,
  error: id,
  notification: id,
});
export const performanceSchema = z.object({
  id,
  title: id,
  conversationId: id,
  steps: z.array(
    z.object({
      recordId: id,
      delay: z.number().min(0).max(60000),
      typing: z.boolean(),
      retractAfter: z.number().min(0).max(60000),
      revealedText: id.optional(),
    }),
  ),
});
export const readingSchema = z.object({
  ...base,
  revision: z.number(),
  opening: id,
  owners: ids,
  initialOwner: id,
  password: id,
  notification: id,
  apps: z.array(z.enum(readerApps)),
  mode: z.enum(["free", "clues"]),
  rules: z.array(ruleSchema),
  performances: z.array(performanceSchema),
  selectedRecords: ids.optional(),
  selectedDocuments: ids.optional(),
  updated: z.number(),
});
export const draftLineSchema = z.object({
  id,
  speakerId: id,
  body: phoneBodySchema,
  time: id,
  audience: ids,
  sourceId: id.optional(),
  sourceVersion: id.optional(),
});
export const compositionSchema = z.object({
  ...base,
  conversationId: id,
  title: id,
  lines: z.array(draftLineSchema),
  sourceVersions: z.record(id),
  status: z.enum(["draft", "adopted"]),
  updated: z.number(),
  generation: z
    .object({
      status: z.enum(["running", "failed", "interrupted", "complete"]),
      context: id,
      raw: id,
      error: id,
    })
    .optional(),
});
export const editSchema = z.object({
  ...base,
  conversationId: id,
  title: id,
  created: z.number(),
  undone: z.boolean(),
  before: z.array(
    z.object({
      id,
      versionId: id,
      seq: z.number(),
      time: id,
      body: phoneBodySchema,
      deleted: z.boolean(),
    }),
  ),
  after: z.record(id),
  added: ids,
});
export const migrationSchema = z.object({
  ...base,
  sourceId: id,
  novelId: id,
  phoneId: id,
  map: z.record(id),
  acknowledged: z.boolean(),
  created: z.number(),
});
export const archiveSchema = z.object({
  ...base,
  table: id,
  originalId: id,
  value: z.unknown(),
  created: z.number(),
});
export const extraSchemas = {
  storyWorld: storyWorldSchema,
  storyMigrations: migrationSchema,
  legacyArchives: archiveSchema,
  phoneBackgrounds: backgroundSchema,
  phoneDocuments: documentSchema,
  phoneReading: readingSchema,
  phoneDrafts: compositionSchema,
  phoneEdits: editSchema,
};
export const extraTables = Object.keys(
  extraSchemas,
) as (keyof typeof extraSchemas)[];
export type StoryWorld = z.infer<typeof storyWorldSchema>;
export type StoryMigration = z.infer<typeof migrationSchema>;
export type LegacyArchive = z.infer<typeof archiveSchema>;
export type PhoneBackground = z.infer<typeof backgroundSchema>;
export type PhoneDocument = z.infer<typeof documentSchema>;
export type PhoneReading = z.infer<typeof readingSchema>;
export type ReaderTarget = z.infer<typeof targetSchema>;
export type ReaderRule = z.infer<typeof ruleSchema>;
export type PhoneDraft = z.infer<typeof compositionSchema>;
export type PhoneEdit = z.infer<typeof editSchema>;
export type DraftLine = z.infer<typeof draftLineSchema>;
