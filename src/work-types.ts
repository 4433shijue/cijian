import { z } from "zod";
import {
  phoneBodySchema,
  phoneRecordSchema,
  phoneConversationSchema,
} from "./phone-types";

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
export const habitSchema = z.object({
  initiative: z.enum(["quiet", "balanced", "active"]),
  expression: z.enum(["private", "balanced", "public"]),
  replyDelay: z.number().int().min(0).max(10),
  browseEvery: z.number().int().min(1).max(20),
  preference: id,
});
export const automationOptionsSchema = z.object({
  roles: ids,
  controlledRole: id,
  takeover: z.boolean(),
  rounds: z.number().int().min(1).max(100),
  minutes: z.number().int().min(1).max(60),
  endTime: id,
  maxRequests: z.number().int().min(0).max(10000),
  mode: z.enum(["live", "draft"]),
  freedom: z.enum(["limited", "active"]),
  direction: id,
  startTime: id,
  habits: z.record(habitSchema),
});
export const automationSettingsSchema = z.object({
  ...base,
  ...automationOptionsSchema.shape,
  updated: z.number(),
});
export const worldEventSchema = z.object({
  ...base,
  actorId: id,
  title: id,
  text: id,
  audience: ids,
  time: id,
  versionId: id,
  runId: id,
  stepId: id,
  deleted: z.boolean(),
  created: z.number(),
});
export const knowledgeSchema = z.object({
  ...base,
  actorId: id,
  targetId: id,
  versionId: id,
  runId: id,
  stepId: id,
  created: z.number(),
});
export const autoActionSchema = z
  .object({
    kind: z.enum([
      "chat",
      "moment",
      "comment",
      "like",
      "note",
      "draft",
      "event",
      "wait",
    ]),
    conversationId: id,
    recipientId: id,
    parentId: id,
    replyTo: id,
    documentId: id,
    audience: ids,
    reason: id,
    instruction: id,
    awaitUser: z.boolean(),
  })
  .strict();
export const automationPayloadSchema = z.object({
  records: z.array(phoneRecordSchema),
  documents: z.array(documentSchema),
  events: z.array(worldEventSchema),
  conversations: z.array(phoneConversationSchema),
  likes: z.array(
    z.object({
      recordId: id,
      actorId: id,
      before: z.boolean(),
      beforeVersion: id.optional(),
      versionId: id.optional(),
    }),
  ),
});
const referenceSchema = z.object({
  table: z.enum([
    "phoneRecords",
    "phoneDocuments",
    "phoneWorldEvents",
    "phoneConversations",
  ]),
  id,
  version: id,
});
const requestSchema = z.object({
  system: id,
  user: id,
  raw: id,
  complete: z.boolean(),
});
export const automationStepSchema = z.object({
  ...base,
  runId: id,
  actorId: id,
  round: z.number().int().min(1),
  order: z.number().int().min(0),
  status: z.enum(["pending", "running", "complete", "failed"]),
  phase: z.enum(["decision", "content", "commit"]),
  options: automationOptionsSchema,
  context: id,
  materialVersion: id.default(""),
  prompts: z.record(id),
  profile: z.object({
    id,
    name: id,
    protocol: z.enum(["chat", "responses", "claude", "gemini"]),
    url: id,
    model: id,
    stream: z.boolean(),
    context: z.number(),
    maxOutput: z.number(),
    timeout: z.number(),
    temperature: z.number().optional(),
    frequencyPenalty: z.number().nullable().optional(),
    outputMode: z.enum(["auto", "schema", "json", "compatible"]).optional(),
    cachePolicy: z.enum(["auto", "off"]).optional(),
    prefixReuse: z.enum(["auto", "on", "off"]).optional(),
    remember: z.literal(false),
  }),
  time: id,
  snapshot: automationPayloadSchema,
  roles: z.array(z.object({ id, name: id })),
  assets: z.array(z.object({ id, mime: id })),
  readIds: ids,
  refs: z.array(referenceSchema),
  action: autoActionSchema.optional(),
  result: automationPayloadSchema.optional(),
  decisionRequest: requestSchema.optional(),
  contentRequest: requestSchema.optional(),
  consumedIds: ids.default([]),
  beforeDocuments: z.array(documentSchema),
  afterVersions: z.record(id),
  applied: z.boolean(),
  error: id,
  created: z.number(),
  updated: z.number(),
});
export const automationRunSchema = z.object({
  ...base,
  options: automationOptionsSchema,
  status: z.enum([
    "running",
    "paused",
    "failed",
    "interrupted",
    "complete",
    "adopted",
    "undone",
    "cancelled",
  ]),
  round: z.number().int().min(0),
  requests: z.number().int().min(0),
  waiting: z.record(z.number()),
  error: id,
  created: z.number(),
  updated: z.number(),
});
export const automationSchemas = {
  phoneAutomationSettings: automationSettingsSchema,
  phoneAutomationRuns: automationRunSchema,
  phoneAutomationSteps: automationStepSchema,
  phoneKnowledge: knowledgeSchema,
  phoneWorldEvents: worldEventSchema,
};
export const automationTables = Object.keys(
  automationSchemas,
) as (keyof typeof automationSchemas)[];
export type PhoneAutomationOptions = z.infer<typeof automationOptionsSchema>;
export type PhoneAutomationSettings = z.infer<typeof automationSettingsSchema>;
export type PhoneAutomationRun = z.infer<typeof automationRunSchema>;
export type PhoneAutomationStep = z.infer<typeof automationStepSchema>;
export type PhoneWorldEvent = z.infer<typeof worldEventSchema>;
export type PhoneKnowledge = z.infer<typeof knowledgeSchema>;
export type PhoneHabit = z.infer<typeof habitSchema>;
export type PhoneAutoAction = z.infer<typeof autoActionSchema>;
export type PhoneAutomationPayload = z.infer<typeof automationPayloadSchema>;
export const extraSchemas = {
  ...automationSchemas,
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
