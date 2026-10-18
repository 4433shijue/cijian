import { z } from "zod";

const id = z.string();
const ids = z.array(id);
const status = z.enum([
  "pending",
  "running",
  "complete",
  "failed",
  "interrupted",
]);
export const phoneSkinSchema = z.object({
  theme: z.enum(["light", "dark", "pink", "lake"]),
  wallpaper: id,
  mine: id,
  theirs: id,
  fontSize: z.number().min(12).max(24),
});
export type PhoneSkin = z.infer<typeof phoneSkinSchema>;
export const defaultSkin = (): PhoneSkin => ({
  theme: "light",
  wallpaper: "",
  mine: "",
  theirs: "",
  fontSize: 16,
});
export const phoneConversationSchema = z.object({
  id,
  storyId: id,
  kind: z.enum(["direct", "group"]),
  title: id,
  avatar: id,
  members: ids,
  created: z.number(),
  updated: z.number(),
});
export const phoneBodySchema = z.object({
  type: z.enum([
    "text",
    "image",
    "sticker",
    "audio",
    "transfer",
    "call",
    "system",
  ]),
  text: id,
  assets: ids,
  quoteId: id,
  amount: id,
  duration: id,
  callState: z.enum(["completed", "missed", "declined"]),
});
export type PhoneBody = z.infer<typeof phoneBodySchema>;
export const emptyBody = (): PhoneBody => ({
  type: "text",
  text: "",
  assets: [],
  quoteId: "",
  amount: "",
  duration: "",
  callState: "completed",
});
const device = z.object({
  skin: phoneSkinSchema,
  notes: z.record(id),
  pinned: ids,
  read: z.record(z.number()),
  drafts: z.record(id),
  composerDrafts: z
    .record(z.object({ body: phoneBodySchema, time: id, situation: id }))
    .optional(),
});
export const phoneSpaceSchema = z.object({
  id,
  storyId: id,
  ownerId: id,
  devices: z.record(device),
  migrated: z.boolean(),
  updated: z.number(),
});
const version = z.object({
  id,
  body: phoneBodySchema,
  deleted: z.boolean(),
  retracted: z.boolean(),
  time: id,
  created: z.number(),
});
export const phoneRecordSchema = z.object({
  legacyDraft: z.object({ raw: id, error: id }).optional(),
  id,
  storyId: id,
  conversationId: id,
  kind: z.enum(["message", "moment", "comment"]),
  parentId: id,
  replyTo: id,
  speakerId: id,
  audience: ids,
  body: phoneBodySchema,
  time: id,
  seq: z.number(),
  round: id,
  runId: id,
  versionId: id,
  versions: z.array(version),
  pending: z.boolean(),
  deleted: z.boolean(),
  retracted: z.boolean(),
  likes: ids,
  origin: z.enum(["user", "ai", "legacy"]),
  legacyId: id,
  created: z.number(),
  updated: z.number(),
});
export const phoneAssetSchema = z.object({
  id,
  storyId: id,
  name: id,
  mime: id,
  data: z.string().max(15 * 1024 * 1024),
  size: z
    .number()
    .min(0)
    .max(10 * 1024 * 1024),
});
const step = z.object({
  speakerId: id,
  status,
  context: id,
  outputIds: ids,
  raw: id,
  error: id,
});
export const phoneRunSchema = z.object({
  rewriteBase: z
    .object({ steps: z.array(step), versions: z.record(id) })
    .optional(),
  staged: z.record(z.array(phoneBodySchema)).optional(),
  id,
  storyId: id,
  conversationId: id,
  ownerId: id,
  mode: z.enum(["participate", "compose", "moment", "comment"]),
  parentId: id,
  audience: ids,
  input: id,
  time: id,
  cutoff: z.number(),
  sourceIds: ids,
  sourceVersions: z.record(id),
  steps: z.array(step),
  status,
  error: id,
  created: z.number(),
  updated: z.number(),
  legacyId: id,
});
export type PhoneSpace = z.infer<typeof phoneSpaceSchema>;
export type PhoneDevice = z.infer<typeof device>;
export type PhoneConversation = z.infer<typeof phoneConversationSchema>;
export type PhoneRecord = z.infer<typeof phoneRecordSchema>;
export type PhoneAsset = z.infer<typeof phoneAssetSchema>;
export type PhoneGenerationRun = z.infer<typeof phoneRunSchema>;
export const phoneTables = [
  "phoneSpaces",
  "phoneConversations",
  "phoneRecords",
  "phoneAssets",
  "phoneRuns",
] as const;
export type PhoneTable = (typeof phoneTables)[number];
export const phoneSchemas = {
  phoneSpaces: phoneSpaceSchema,
  phoneConversations: phoneConversationSchema,
  phoneRecords: phoneRecordSchema,
  phoneAssets: phoneAssetSchema,
  phoneRuns: phoneRunSchema,
};
export const newDevice = (): PhoneDevice => ({
  skin: defaultSkin(),
  notes: {},
  pinned: [],
  read: {},
  drafts: {},
});

export function phoneBubbleInk(color: string, dark = false) {
  if (!/^#[0-9a-f]{6}$/i.test(color)) return dark ? "#e9edf2" : "#222222";
  const channels = [1, 3, 5]
    .map((i) => parseInt(color.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  const luminance =
    0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
  return luminance > 0.179 ? "#222222" : "#ffffff";
}
