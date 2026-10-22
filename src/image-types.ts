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
export const imageProfileSchema = z.object({
  id: z.string(),
  name: z.string(),
  url: z.string(),
  model: z.string(),
  size: z.string().default("1024x1024"),
  quality: z.string().default(""),
  responseFormat: z.enum(["", "b64_json", "url"]).default(""),
  references: z.enum(["off", "multipart", "json"]).default("off"),
  timeout: z.number().int().min(10).max(600).default(180),
  remember: z.boolean().default(false),
});
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
