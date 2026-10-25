import { z } from "zod";
import type { Preferences, Role, Story } from "./types";

export const imageStyleSchema = z.object({
  id: z.string().min(1).max(100),
  name: z.string().trim().min(1).max(80),
  positive: z.string().trim().min(1).max(6000),
  negative: z.string().max(3000).default(""),
});
export type ImageStyle = z.infer<typeof imageStyleSchema>;
export const imagePromptOverridesSchema = z.object({
  novel: z
    .object({ enabled: z.boolean(), text: z.string().max(6000) })
    .optional(),
  phone: z
    .object({ enabled: z.boolean(), text: z.string().max(6000) })
    .optional(),
});
export const imageReferenceSchema = z.object({
  id: z.string(),
  name: z.string().max(100),
  view: z.enum(["front", "side", "three-quarter", "full", "other"]),
  styleId: z.string().max(100).default(""),
  data: z
    .string()
    .max(15 * 1024 * 1024)
    .regex(/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/),
});
export type CharacterImageReference = z.infer<typeof imageReferenceSchema>;
export const referenceViews = {
  front: "正面",
  side: "侧面",
  "three-quarter": "四分之三侧面",
  full: "全身",
  other: "其他",
} as const;
const avoid =
  "避免畸形手指、错误肢体、五官错位、人物串脸、文字与水印；保留人物的年龄感、体型和辨识特征，不把所有人画成同一张脸。";
export const builtInImageStyles: ImageStyle[] = [
  {
    id: "korean-3d",
    name: "韩系 3D 厚涂",
    positive:
      "韩系高完成度半写实 3D 厚涂插画，精致但有个人辨识度的面部骨相，立体自然的五官，通透有细腻肌理的皮肤，层次清晰的发丝。柔和电影布光，细腻的明暗转折与体积感，厚涂笔触融入精致塑形。干净协调的色彩与有呼吸感的构图，人物眼神和微表情自然，服装材质精细，人物和环境光统一。",
    negative:
      avoid + "避免粗黑描边、脏灰肤色、塑料蜡像感、过度磨皮、廉价游戏建模感。",
  },
  {
    id: "otome",
    name: "乙游精绘",
    positive:
      "乙女游戏高品质剧情卡面，细致半写实人物，精美服饰材质、柔润肤色、细腻发丝和有情绪的眼神。注重人物之间的距离、视线与动作，浪漫但克制的电影构图，柔和轮廓光与清晰视觉焦点。保持原有面貌、年龄和气质。",
    negative: avoid + "避免千篇一律的尖下巴、大眼滤镜、浮夸特效与僵硬摆拍。",
  },
  {
    id: "soft-realism",
    name: "柔光半写实",
    positive:
      "柔光半写实叙事插画，自然骨相与细腻皮肤肌理，轻柔漫射光、真实空间层次、低饱和协调配色，笔触含蓄而有温度。表情与肢体语言自然，保留生活细节和人物原本的年龄特征。",
    negative: avoid + "避免过度锐化、强烈磨皮和油腻高光。",
  },
  {
    id: "japanese-painterly",
    name: "日系清透厚涂",
    positive:
      "日系清透厚涂插画，明亮通透的色彩，轻盈边缘与细腻色块塑形，柔和环境光和有空气感的背景。人物五官精致但保持个人特征，发丝与衣褶自然，构图清爽，情绪含蓄。",
    negative: avoid + "避免浓重黑线、死板赛璐璐平涂、过曝与幼态化人物。",
  },
  {
    id: "watercolor",
    name: "水彩绘本",
    positive:
      "精致水彩绘本，透明色层和自然纸张肌理，柔软晕染与适度留白，温暖细腻的叙事构图。以可辨识的面部轮廓、发型和体型表现角色，轻盈但准确的动作与生活细节。",
    negative: avoid + "避免脏色堆积、失去人物辨识度与过度卡通化。",
  },
  {
    id: "classic-oil",
    name: "古典油画",
    positive:
      "古典叙事油画，扎实的肖像塑形，丰富而克制的油彩层次，温润深邃的色调和细腻光影。保留角色面部结构、发色和年龄，人物动作自然，衣物材质真实，场景时代与原文一致。",
    negative: avoid + "避免擅自替换成古代服饰、过暗背景、蜡像感与装饰画滤镜。",
  },
  {
    id: "life-photo",
    name: "自然生活摄影",
    positive:
      "自然生活摄影，真实环境光、可信的镜头透视与物体比例，适度景深，保留生活中的细微不完美。颜色自然，材质和皮肤纹理真实，符合场景的后置镜头随手拍视角，不强行摆拍。",
    negative: avoid + "避免影楼背景、夸张美颜、过度 HDR、人工塑料质感。",
  },
];
export const imagePlanningDefaults = {
  novel:
    "从正文选择最有情绪和画面感的一个瞬间，明确人物站位、视线、动作、景别和环境光。忠于正文的时间、地点和服装；人物外貌优先遵循固定外貌，本场造型只影响服装、发型整理和配饰。不要把多个时刻拼成一张图。",
  phone:
    "将图片消息整理成一张符合角色当时所处环境的生活照片，说明实际可见的物件、光线、机位和景别。保留随手拍的自然感，不把照片拍成宣传海报；不凭空增加在场人物或不曾获得的旧照片。",
};
export function imageStyleOptions(custom: ImageStyle[] = []) {
  const overrides = new Map(custom.map((p) => [p.id, p]));
  return [
    ...builtInImageStyles.map((p) => overrides.get(p.id) || p),
    ...custom.filter((p) => !builtInImageStyles.some((b) => b.id === p.id)),
  ];
}
export function mergeImageStyles(
  existing: ImageStyle[] = [],
  imported: ImageStyle[] = [],
) {
  const merged = [
    ...existing,
    ...imported.filter((p) => !existing.some((x) => x.id === p.id)),
  ];
  if (merged.length > 100)
    throw Error("导入后的绘画预设超过 100 项，请先整理不需要的自定义画风");
  return merged;
}
export function portableImageSettings(
  story: Pick<Story, "kind" | "images">,
  custom: ImageStyle[] = [],
) {
  const preset = resolveImageStyle(story, custom);
  return {
    novelMode: "manual" as const,
    phoneEnabled: false,
    style: "",
    perTurn: 1,
    perRun: 5,
    ...story.images,
    stylePresetId: preset.id,
    stylePresetSnapshot: preset,
  };
}
export function resolveImageStyle(
  story: Pick<Story, "kind" | "images">,
  custom: ImageStyle[] = [],
  override?: string,
): ImageStyle {
  const settings = story.images;
  const id =
    override ||
    settings?.stylePresetId ||
    (settings?.style
      ? "custom-only"
      : story.kind === "phone"
        ? "life-photo"
        : "korean-3d");
  if (id === "custom-only")
    return {
      id,
      name: "仅使用自定义画风",
      positive: settings?.style?.trim() || "忠于原文的自然叙事画面",
      negative: "",
    };
  const fallback = settings?.stylePresetSnapshot;
  // A saved story carries its own preset, including when imported without preferences.
  return (
    (override
      ? imageStyleOptions(custom).find((p) => p.id === id)
      : fallback?.id === id
        ? fallback
        : imageStyleOptions(custom).find((p) => p.id === id)) ||
    fallback ||
    builtInImageStyles[story.kind === "phone" ? 6 : 0]
  );
}
export function roleImageReferences(
  role: Pick<Role, "imageReference" | "imageReferences">,
): CharacterImageReference[] {
  const refs = role.imageReferences || [];
  return role.imageReference &&
    !refs.some((r) => r.data === role.imageReference)
    ? [
        {
          id: "legacy",
          name: "默认定妆",
          view: "front",
          styleId: "",
          data: role.imageReference,
        },
        ...refs,
      ]
    : refs;
}
export function selectCharacterReferences(role: Role, styleId: string) {
  const refs = roleImageReferences(role);
  const matched = refs.filter((r) => r.styleId === styleId);
  const candidates = matched.length ? matched : refs.filter((r) => !r.styleId);
  return candidates
    .filter((r, i) => candidates.findIndex((x) => x.data === r.data) === i)
    .slice(0, 3);
}
export function planningPreference(
  prefs: Preferences | undefined,
  kind: "novel" | "phone",
) {
  const custom = prefs?.imagePromptOverrides?.[kind];
  return custom?.enabled && custom.text.trim()
    ? custom.text
    : imagePlanningDefaults[kind];
}
export const imageStudioExportSchema = z.object({
  format: z.literal("cijian-image-studio"),
  version: z.literal(1),
  presets: z
    .array(imageStyleSchema)
    .max(100)
    .refine(
      (p) => new Set(p.map((x) => x.id)).size === p.length,
      "画风编号重复",
    ),
  planning: imagePromptOverridesSchema.optional(),
});
