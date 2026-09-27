import { z } from "zod";
import type {
  TheaterHtmlDocument,
  TheaterHtmlPage,
  TheaterPreset,
  TheaterState,
} from "./types";
import { theaterText } from "./theater-text";
export const htmlPageSchema = z.object({
  id: z.string().min(1).max(200),
  title: z.string().min(1).max(500),
  html: z.string().min(1).max(2000000),
});
export const htmlDocumentSchema = z.object({
  version: z.literal(2),
  sections: z.array(htmlPageSchema).min(1).max(32),
});
export const htmlOutputSchema = {
  type: "object",
  properties: {
    version: { type: "integer", enum: [2] },
    sections: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          title: { type: "string" },
          html: { type: "string" },
        },
        required: ["id", "title", "html"],
        additionalProperties: false,
      },
    },
  },
  required: ["version", "sections"],
  additionalProperties: false,
};

export function normalizeHtmlDocument(
  value: unknown,
  presets: TheaterPreset[],
  partial = false,
): TheaterHtmlDocument {
  const data = htmlDocumentSchema.parse(value);
  if (
    (!partial && data.sections.length !== presets.length) ||
    data.sections.length > presets.length ||
    data.sections.some((page, index) => page.id !== presets[index]?.id)
  )
    throw Error("小剧场栏目编号或顺序与所选内容不一致，原始输出已保留。");
  for (const page of data.sections) {
    if (
      !/<[a-z][^>]*>/i.test(page.html) ||
      (!theaterText(page.html) && !/<script\b/i.test(page.html))
    )
      throw Error("小剧场没有完整的 HTML 内容，原始输出已保留。");
  }
  return data;
}
export function htmlPagesText(
  pages: TheaterHtmlPage[],
  rendered: Record<string, string> = {},
) {
  return pages
    .map(
      (page) =>
        page.title +
        "\n" +
        (rendered[page.id] ||
          theaterText(page.html) ||
          "此栏目通过脚本呈现，展开一次后可导出可见文字。"),
    )
    .join("\n\n");
}
export function validateHtmlState(value: unknown): TheaterState {
  let nodes = 0;
  const visit = (v: unknown, depth: number): boolean => {
    if (++nodes > 10000 || depth > 20) return false;
    if (v === null || typeof v === "string" || typeof v === "boolean")
      return true;
    if (typeof v === "number") return Number.isFinite(v);
    if (Array.isArray(v)) return v.every((x) => visit(x, depth + 1));
    if (
      !v ||
      typeof v !== "object" ||
      Object.getPrototypeOf(v) !== Object.prototype
    )
      return false;
    return Object.entries(v).every(
      ([key, child]) =>
        !["__proto__", "constructor", "prototype"].includes(key) &&
        visit(child, depth + 1),
    );
  };
  if (!visit(value, 0) || JSON.stringify(value).length > 65536)
    throw Error("小剧场状态过大或格式不支持，未保存。");
  return value as TheaterState;
}
