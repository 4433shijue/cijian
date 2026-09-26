import { z } from "zod";
import type { TheaterData, TheaterItem, TheaterPreset } from "./types";
import { normalizeTheaterPresentation } from "./theater-presets";
import { theaterText } from "./theater-text";

const presentations = [
  "dialogue",
  "detail-list",
  "subtext-card",
  "forum",
  "body-status",
  "evidence-board",
  "relationship-card",
  "scene-board",
  "custom",
] as const;
const certainties = ["observed", "inferred", "unknown", "fiction"] as const;
const statuses = [
  "unmentioned",
  "stable",
  "subtle",
  "clear",
  "impact",
  "",
] as const;
const themes = ["paper", "forest", "night"] as const;
const limits = {
  sections: 32,
  items: 240,
  fields: 16,
  text: 12000,
  html: 200000,
  total: 2000000,
};
const identifier = z
  .string()
  .min(1)
  .max(200)
  .refine(
    (value) => value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value),
    "小剧场编号不能为空或包含控制字符。",
  );
const itemSchema = z
  .object({
    id: identifier,
    author: z.string().max(200),
    badge: z.string().max(120),
    title: z.string().max(500),
    text: z.string().max(limits.text),
    quote: z.string().max(limits.text),
    certainty: z.enum(certainties),
    replyTo: z.string().max(200),
    group: z.string().max(200),
    status: z.enum(statuses),
    fields: z
      .array(
        z
          .object({
            label: z.string().min(1).max(200),
            value: z.string().max(limits.text),
          })
          .strict(),
      )
      .max(limits.fields),
    // Local provenance is preserved in backups; the model schema omits this key.
    origin: z.enum(["user", "ai"]).optional(),
  })
  .strict();
const sectionSchema = z
  .object({
    id: identifier,
    title: z.string().min(1).max(500),
    presentation: z.enum(presentations),
    theme: z.enum(themes),
    items: z.array(itemSchema).max(limits.items),
    html: z.string().max(limits.html).default(""),
  })
  .strict();

const unknownEvidence =
  /(?:未提及|未涉及|没有依据|无依据|无法确认|尚不明确)|^(?:无|未知|不详|不确定|正常)$/;
function bodyEvidence(item: TheaterItem) {
  return [
    item.quote,
    ...item.fields
      .filter((field) => /依据|原文|证据|设定/.test(field.label))
      .map((field) => field.value),
  ].some((value) => value.trim() && !unknownEvidence.test(value.trim()));
}

/** Validate stored content without rewriting IDs used by replies and local marks. */
export const theaterDataSchema = z
  .object({
    version: z.literal(1),
    sections: z.array(sectionSchema).min(1).max(limits.sections),
  })
  .strict()
  .superRefine((data, ctx) => {
    const sections = new Set<string>();
    const issue = (path: (string | number)[], message: string) =>
      ctx.addIssue({ code: z.ZodIssueCode.custom, path, message });
    for (const [sectionIndex, section] of data.sections.entries()) {
      const path = ["sections", sectionIndex];
      if (sections.has(section.id))
        issue([...path, "id"], "小剧场栏目编号重复。");
      sections.add(section.id);
      if (section.presentation !== "custom" && section.html?.trim())
        issue([...path, "html"], "内置展示使用结构化内容，不能夹带 HTML。");
      if (
        !section.items.length &&
        !(section.presentation === "custom" && theaterText(section.html || ""))
      )
        issue(path, "小剧场没有可阅读内容。");
      const previous = new Set<string>();
      for (const [itemIndex, item] of section.items.entries()) {
        const itemPath = [...path, "items", itemIndex];
        if (previous.has(item.id))
          issue([...itemPath, "id"], "小剧场条目编号重复。");
        if (item.replyTo && !previous.has(item.replyTo))
          issue(
            [...itemPath, "replyTo"],
            "回复只能引用同一栏目里已经出现的条目。",
          );
        previous.add(item.id);
        if (
          !item.text.trim() &&
          !item.fields.some((field) => field.value.trim())
        )
          issue(itemPath, "小剧场条目没有可阅读内容。");
        if (section.presentation === "forum" && !item.author.trim())
          issue([...itemPath, "author"], "论坛楼层缺少发言者。");
        if (section.presentation === "body-status") {
          if (!item.author.trim() || !item.title.trim() || !item.status)
            issue(itemPath, "身体状态需要角色、部位和状态。");
          if (item.status === "unmentioned") {
            if (item.certainty !== "unknown" || item.quote.trim())
              issue(
                itemPath,
                "未提及的部位应标为未知，不能填入确定状态的依据。",
              );
          } else if (
            !bodyEvidence(item) ||
            item.certainty === "unknown" ||
            item.certainty === "fiction"
          ) {
            issue(
              itemPath,
              "身体状态必须有正文或人物设定依据；无依据请标为本回合未提及。",
            );
          }
        }
      }
    }
    if (JSON.stringify(data).length > limits.total)
      issue([], "小剧场内容超过容量上限，请减少栏目或追加内容。");
  });

/** Enforce the selected columns and their order. Model provenance is never trusted. */
export function normalizeTheaterData(
  value: unknown,
  presets: TheaterPreset[],
  options: { partial?: boolean; preserveOrigins?: boolean } = {},
): TheaterData {
  const parsed = theaterDataSchema.safeParse(value);
  if (!parsed.success)
    throw Error(
      `小剧场结构无效。${parsed.error.issues[0]?.message || "请单独重试小剧场。"}`,
    );
  const data = parsed.data;
  if (
    (!options.partial && data.sections.length !== presets.length) ||
    data.sections.length > presets.length
  )
    throw Error("小剧场栏目与本次所选预设不一致。");
  for (const [index, section] of data.sections.entries()) {
    const preset = presets[index];
    if (!preset || section.id !== preset.id)
      throw Error("小剧场栏目顺序或编号与本次所选预设不一致。");
    if (
      section.presentation !== normalizeTheaterPresentation(preset.presentation)
    )
      throw Error("小剧场展示结构与本次预设不一致。");
    if (!options.preserveOrigins)
      for (const item of section.items) delete item.origin;
  }
  return data;
}

const certaintyText: Record<TheaterItem["certainty"], string> = {
  observed: "正文观察",
  inferred: "可能的理解",
  unknown: "尚未确定",
  fiction: "番外演绎",
};
const statusText: Record<TheaterItem["status"], string> = {
  "": "",
  unmentioned: "本回合未提及",
  stable: "无明显变化",
  subtle: "轻微反应",
  clear: "明显反应",
  impact: "影响动作或表达",
};
function itemText(item: TheaterItem, source?: string) {
  const matched = !!item.quote && source !== undefined && source.includes(item.quote);
  const certainty = item.origin === "user" ? "你的留言" : item.certainty === "observed" && !matched ? "观察待核对" : certaintyText[item.certainty];
  return [
    [item.author, item.title].filter(Boolean).join(" · "),
    [item.badge, certainty, statusText[item.status]]
      .filter(Boolean)
      .join(" · "),
    item.text,
    item.quote ? `${matched ? "原文" : "引用待核对"}「${item.quote}」` : "",
    ...item.fields.map((field) => `${field.label}\n${field.value}`),
  ]
    .filter(Boolean)
    .join("\n");
}
export function structuredTheaterText(data: TheaterData, source?: string): string {
  return data.sections
    .map((section) =>
      [
        section.title,
        ...section.items.map((item) => itemText(item, source)),
        section.presentation === "custom"
          ? theaterText(section.html || "")
          : "",
      ]
        .filter(Boolean)
        .join("\n\n"),
    )
    .join("\n\n");
}
const escape = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[c]!,
  );
const lines = (value: string) => escape(value).replace(/\r?\n/g, "<br>");
/** Export plain, escaped content. Custom model HTML never enters exported markup. */
export function structuredTheaterHtml(data: TheaterData): string {
  return data.sections
    .map(
      (section) =>
        `<section data-theater-template="${escape(section.presentation)}"><h2>${escape(section.title)}</h2>${section.items.map((item) => `<article><h3>${escape([item.author, item.title].filter(Boolean).join(" · "))}</h3><p>${escape([item.badge, certaintyText[item.certainty], statusText[item.status]].filter(Boolean).join(" · "))}</p><p>${lines(item.text)}</p>${item.quote ? `<blockquote>${lines(item.quote)}</blockquote>` : ""}${item.fields.length ? `<dl>${item.fields.map((field) => `<dt>${escape(field.label)}</dt><dd>${lines(field.value)}</dd>`).join("")}</dl>` : ""}</article>`).join("")}${section.presentation === "custom" && section.html ? `<p>${lines(theaterText(section.html))}</p>` : ""}</section>`,
    )
    .join("\n");
}

// Structured-output protocols require every property and forbid unknown keys.
const string = { type: "string" };
const object = (properties: Record<string, unknown>) => ({
  type: "object",
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});
const enumeration = (values: readonly string[]) => ({
  type: "string",
  enum: [...values],
});
export const theaterOutputSchema = object({
  version: { type: "integer", enum: [1] },
  sections: {
    type: "array",
    items: object({
      id: string,
      title: string,
      presentation: enumeration(presentations),
      theme: enumeration(themes),
      items: {
        type: "array",
        items: object({
          id: string,
          author: string,
          badge: string,
          title: string,
          text: string,
          quote: string,
          certainty: enumeration(certainties),
          replyTo: string,
          group: string,
          status: enumeration(statuses),
          fields: {
            type: "array",
            items: object({ label: string, value: string }),
          },
        }),
      },
      html: string,
    }),
  },
});

type Span = { start: number; end?: number; invalid?: boolean };
const whitespace = (source: string, at: number) => {
  while (at < source.length && /\s/.test(source[at])) at++;
  return at;
};
function stringEnd(source: string, at: number): number | undefined {
  for (let i = at + 1; i < source.length; i++) {
    if (source[i] === "\\") {
      i++;
      continue;
    }
    if (source[i] === '"') return i + 1;
  }
}
function valueSpan(source: string, at: number): Span {
  at = whitespace(source, at);
  const first = source[at];
  if (first === '"') return { start: at, end: stringEnd(source, at) };
  if (first === "{" || first === "[") {
    const stack = [first === "{" ? "}" : "]"];
    for (let i = at + 1; i < source.length; i++) {
      const c = source[i];
      if (c === '"') {
        const end = stringEnd(source, i);
        if (end === undefined) return { start: at };
        i = end - 1;
      } else if (c === "{" || c === "[") stack.push(c === "{" ? "}" : "]");
      else if (c === "}" || c === "]") {
        if (c !== stack.pop()) return { start: at, invalid: true };
        if (!stack.length) return { start: at, end: i + 1 };
      }
    }
    return { start: at };
  }
  let end = at;
  while (end < source.length && !/[\s,}\]]/.test(source[end])) end++;
  return { start: at, end: end > at ? end : undefined };
}
/** Read object members only at this exact depth, stopping at an unfinished value. */
function members(source: string, at: number): Map<string, Span> | undefined {
  if (source[at] !== "{") return;
  const found = new Map<string, Span>();
  at = whitespace(source, at + 1);
  while (at < source.length && source[at] !== "}") {
    if (source[at] !== '"') return;
    const end = stringEnd(source, at);
    if (end === undefined) return found;
    let key: string;
    try {
      key = JSON.parse(source.slice(at, end));
    } catch {
      return;
    }
    if (found.has(key)) return;
    at = whitespace(source, end);
    if (source[at] !== ":") return;
    const span = valueSpan(source, at + 1);
    if (span.invalid) return;
    found.set(key, span);
    if (span.end === undefined) return found;
    try {
      JSON.parse(source.slice(span.start, span.end));
    } catch {
      return;
    }
    at = whitespace(source, span.end);
    if (at === source.length || source[at] === "}") return found;
    if (source[at] !== ",") return;
    at = whitespace(source, at + 1);
  }
  return found;
}

/** Publish only complete validated sections; never repair a cut item or scan nested keys. */
export function parseStreamingTheater(
  raw: string,
  presets: TheaterPreset[],
): TheaterData | undefined {
  const source = raw.trim().replace(/^```(?:json)?\s*/i, "");
  // A response array, quoted JSON or explanatory text is not the root object.
  // Complete wrappers may still be accepted by the normal final JSON parser.
  if (!source.startsWith("{")) return;
  const root = members(source, 0);
  const theater = root?.get("theater");
  if (!theater || source[theater.start] !== "{") return;
  const inner = members(source, theater.start);
  const version = inner?.get("version");
  const sections = inner?.get("sections");
  if (
    !version?.end ||
    source.slice(version.start, version.end) !== "1" ||
    !sections ||
    source[sections.start] !== "["
  )
    return;
  let at = whitespace(source, sections.start + 1);
  const values: unknown[] = [];
  let result: TheaterData | undefined;
  while (at < source.length && source[at] !== "]") {
    if (source[at] !== "{") return result;
    const section = valueSpan(source, at);
    if (section.invalid || section.end === undefined) return result;
    try {
      values.push(JSON.parse(source.slice(section.start, section.end)));
      result = normalizeTheaterData({ version: 1, sections: values }, presets, {
        partial: true,
      });
    } catch {
      return result;
    }
    at = whitespace(source, section.end);
    if (source[at] === "]" || at === source.length) return result;
    if (source[at] !== ",") return result;
    at = whitespace(source, at + 1);
  }
  return result;
}
