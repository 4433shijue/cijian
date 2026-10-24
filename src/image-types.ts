import { z } from "zod";

export const imageSettingsSchema = z.object({
  novelMode: z.enum(["manual", "every", "auto"]).default("manual"),
  phoneEnabled: z.boolean().default(false),
  style: z.string().default(""),
  perTurn: z.number().int().min(1).max(5).default(1),
  perRun: z.number().int().min(1).max(100).default(5),
});
export type ImageSettings = z.infer<typeof imageSettingsSchema>;
export const imageSettings = (s?: Partial<ImageSettings>): ImageSettings =>
  imageSettingsSchema.parse(s || {});
export const imageProtocolSchema = z.enum([
  "auto",
  "images",
  "chat",
  "responses",
  "gemini",
  "openrouter",
  "custom",
]);
export type ImageProtocol = z.infer<typeof imageProtocolSchema>;
export const imageConnectionSchema = z.object({
  url: z.string(),
  model: z.string(),
  protocol: imageProtocolSchema.default("auto"),
  endpointMode: z.enum(["auto", "base", "full"]).default("auto"),
  modelsUrl: z.string().default(""),
  auth: z
    .enum(["auto", "bearer", "x-api-key", "x-goog-api-key", "none"])
    .default("auto"),
  stream: z.boolean().default(false),
  toolModel: z.string().default(""),
  aspectRatio: z.string().default(""),
  resolution: z.string().default(""),
  extraBody: z.string().max(32000).default(""),
  requestTemplate: z
    .string()
    .max(32000)
    .default('{"model":"{{model}}","prompt":"{{prompt}}"}'),
  resultPath: z.string().max(300).default(""),
  pollUrl: z.string().max(2000).default(""),
  taskIdPath: z.string().max(300).default("id"),
  statusPath: z.string().max(300).default("status"),
  successStates: z
    .string()
    .max(300)
    .default("completed,succeeded,success,done"),
  failureStates: z.string().max(300).default("failed,error,cancelled,canceled"),
  pollInterval: z.number().int().min(2).max(30).default(3),
  size: z.string().default("1024x1024"),
  quality: z.string().default(""),
  responseFormat: z.enum(["", "b64_json", "url"]).default(""),
  references: z.enum(["off", "auto", "multipart", "json"]).default("off"),
  timeout: z.number().int().min(10).max(600).default(180),
});
export type ImageConnection = z.infer<typeof imageConnectionSchema>;
export function migrateImageProfile(value: unknown) {
  if (!value || typeof value !== "object" || "protocol" in value) return value;
  const legacy = value as Record<string, unknown>;
  let url = legacy.url;
  // v3.3 always stripped these suffixes and selected an Images endpoint.
  if (typeof url === "string") {
    try {
      const u = new URL(url);
      u.pathname =
        u.pathname
          .replace(/\/+$/, "")
          .replace(
            /\/(?:chat\/completions|responses|images\/(?:generations|edits))$/,
            "",
          ) || "/v1";
      url = u.toString();
    } catch {
      /* Keep invalid legacy input editable without making a request. */
    }
  }
  return { ...legacy, url, protocol: "images", endpointMode: "base" };
}
export const imageProfileSchema = z.preprocess(
  migrateImageProfile,
  imageConnectionSchema.extend({
    id: z.string(),
    name: z.string(),
    remember: z.boolean().default(false),
    verified: z
      .array(
        z.object({
          testedAt: z.number(),
          connection: imageConnectionSchema,
        }),
      )
      .max(10)
      .default([]),
  }),
);
export type ImageProfile = z.infer<typeof imageProfileSchema> & {
  key?: string;
};
export const imagePlanSchema = z.object({
  generate: z.boolean(),
  description: z.string().max(12000),
  selfie: z.boolean(),
  roleIds: z.array(z.string()).max(16),
  reason: z.string().max(1000),
});
export type ImagePlan = z.infer<typeof imagePlanSchema>;
export const imageJobSchema = z.object({
  id: z.string(),
  storyId: z.string(),
  sourceKind: z.enum(["novel", "phone"]),
  sourceId: z.string(),
  sourceVersionId: z.string(),
  groupId: z.string(),
  runId: z.string(),
  actorId: z.string(),
  audience: z.array(z.string()),
  sourceText: z.string(),
  style: z.string(),
  automatic: z.boolean(),
  selective: z.boolean(),
  actorName: z.string(),
  habit: z.string(),
  roles: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      appearance: z.string(),
      reference: z.string(),
    }),
  ),
  status: z.enum([
    "pending",
    "planning",
    "generating",
    "complete",
    "failed",
    "interrupted",
    "skipped",
    "blocked",
  ]),
  plan: imagePlanSchema.optional(),
  prompt: z.string(),
  assetId: z.string(),
  // Temporary signed URLs stay local and are deliberately excluded from backups.
  downloadUrl: z.string().max(16000).optional(),
  error: z.string(),
  attempts: z.number().int().nonnegative(),
  executionId: z.string().optional(),
  leaseUntil: z.number(),
  created: z.number(),
  updated: z.number(),
});
export type ImageJob = z.infer<typeof imageJobSchema>;
export const imageAssetSchema = z.object({
  id: z.string(),
  storyId: z.string(),
  name: z.string(),
  mime: z.enum(["image/png", "image/jpeg", "image/webp"]),
  contentHash: z.string().optional(),
  data: z.string().max(15 * 1024 * 1024),
  size: z
    .number()
    .min(1)
    .max(10 * 1024 * 1024),
});
export type ImageAsset = z.infer<typeof imageAssetSchema>;
export const imageSchemas = {
  imageProfiles: imageProfileSchema,
  imageJobs: imageJobSchema,
  imageAssets: imageAssetSchema,
};
export const imageTables = [
  "imageProfiles",
  "imageJobs",
  "imageAssets",
] as const;
export const imageWorking = (status: ImageJob["status"]) =>
  ["pending", "planning", "generating"].includes(status);
export const NO_SELFIE =
  "禁止生成自拍、镜子自拍、前置摄像头自拍或拍摄者本人的自画像。不能通过改名、英文、倒影、合照或第三人称措辞绕过此规则。";
export function isSelfie(text: string) {
  return /自拍|自攝|自拍照|自拍像|自画像|自畫像|self[\s_-]*(?:ie|portrait)|mirror[\s_-]*(?:shot|portrait)|前置.{0,12}(?:拍|照)|(?:对|對|照).{0,3}(?:镜|鏡).{0,10}(?:自己|本人)|拍.{0,4}(?:我自己|他自己|她自己|自己的脸|自己的臉)/i.test(
    text.normalize("NFKC"),
  );
}
