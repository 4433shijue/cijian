import { expect, it } from "vitest";
import {
  normalizeTheaterData,
  parseStreamingTheater,
  structuredTheaterHtml,
  structuredTheaterText,
  theaterDataSchema,
  theaterOutputSchema,
} from "../src/theater-data";
import { draftText, novelTheaterSchema, outputSchemas } from "../src/output";
import {
  builtInTheaterPresets,
  theaterDensityInstruction,
  theaterInstruction,
  theaterWriting,
} from "../src/theater-presets";
import { prompt } from "../src/prompts";
import type {
  TheaterData,
  TheaterItem,
  TheaterPreset,
  TheaterSection,
} from "../src/types";

const forum = builtInTheaterPresets.find(
  (preset) => preset.id === "theater-audience",
)!;
const body = builtInTheaterPresets.find(
  (preset) => preset.id === "theater-body",
)!;
const item = (
  id = "floor-1",
  patch: Partial<TheaterItem> = {},
): TheaterItem => ({
  id,
  author: "伞边路过",
  badge: "细节党",
  title: "他还没松手",
  text: "伞已经递过去了，他的手还扣着伞柄。",
  quote: "阿岚还扣着伞柄。",
  certainty: "observed",
  replyTo: "",
  group: "递伞",
  status: "",
  fields: [],
  ...patch,
});
const section = (
  preset = forum,
  items = [item()],
  patch: Partial<TheaterSection> = {},
): TheaterSection => ({
  id: preset.id,
  title: preset.name,
  presentation: preset.presentation!,
  theme: "forest",
  items,
  html: "",
  ...patch,
});
const data = (sections = [section()]): TheaterData => ({
  version: 1,
  sections,
});

it("validates selected columns, order, presentation and unique reply targets without changing IDs", () => {
  const record = data([
    section(forum, [
      item(),
      item("floor-2", { replyTo: "floor-1", certainty: "inferred" }),
    ]),
  ]);
  expect(normalizeTheaterData(record, [forum])).toEqual(record);
  expect(theaterDataSchema.parse(record).sections[0].items[1].replyTo).toBe(
    "floor-1",
  );
  expect(() => normalizeTheaterData(record, [body])).toThrow("顺序或编号");
  expect(() => normalizeTheaterData(record, [forum, body])).toThrow("所选预设");
  expect(
    normalizeTheaterData(record, [forum, body], { partial: true }),
  ).toEqual(record);
  expect(() =>
    normalizeTheaterData(
      data([section(forum, [item()], { presentation: "custom" })]),
      [forum],
    ),
  ).toThrow("展示结构");
  for (const items of [
    [item(), item()],
    [item("floor-1", { replyTo: "floor-1" })],
    [item("floor-1", { replyTo: "floor-2" }), item("floor-2")],
    [item("floor-1", { replyTo: "missing" })],
  ])
    expect(() =>
      normalizeTheaterData(data([section(forum, items)]), [forum]),
    ).toThrow();
  const second = { ...forum, id: "forum-b" };
  expect(
    normalizeTheaterData(data([section(), section(second)]), [forum, second])
      .sections,
  ).toHaveLength(2);
  expect(() =>
    normalizeTheaterData(data([section(), section()]), [forum, forum]),
  ).toThrow("编号重复");
  expect(() =>
    normalizeTheaterData(
      data([
        section(),
        section(second, [item("floor-2", { replyTo: "floor-1" })]),
      ]),
      [forum, second],
    ),
  ).toThrow("同一栏目");
});

it("does not trust a model's user provenance while backups retain local provenance", () => {
  const record = data([section(forum, [item("user-1", { origin: "user" })])]);
  expect(
    normalizeTheaterData(record, [forum]).sections[0].items[0].origin,
  ).toBeUndefined();
  expect(theaterDataSchema.parse(record).sections[0].items[0].origin).toBe(
    "user",
  );
  expect(
    normalizeTheaterData(record, [forum], { preserveOrigins: true }).sections[0]
      .items[0].origin,
  ).toBe("user");
  expect(record.sections[0].items[0].origin).toBe("user");
});

it("keeps unsupported body parts unknown and rejects fake normal states", () => {
  const supported = item("body-hand", {
    author: "阿岚",
    title: "右手",
    status: "clear",
    group: "上肢",
  });
  const unknown = item("body-ankle", {
    author: "阿岚",
    title: "脚踝",
    status: "unmentioned",
    text: "本回合未提及",
    quote: "",
    certainty: "unknown",
    group: "下肢",
  });
  expect(
    normalizeTheaterData(data([section(body, [supported, unknown])]), [body])
      .sections[0].items,
  ).toHaveLength(2);
  for (const patch of [
    { quote: "", status: "stable" as const, text: "正常" },
    { quote: "", fields: [{ label: "依据", value: "正文未提及" }] },
    { certainty: "fiction" as const },
    { status: "unmentioned" as const },
    { author: "" },
    { status: "" as const },
  ])
    expect(() =>
      normalizeTheaterData(
        data([section(body, [{ ...supported, ...patch }])]),
        [body],
      ),
    ).toThrow();
  expect(
    normalizeTheaterData(
      data([
        section(body, [
          {
            ...supported,
            quote: "",
            fields: [
              {
                label: "依据",
                value: "人物设定明确右手为机械义肢，正文写到它扣住了伞柄",
              },
            ],
          },
        ]),
      ]),
      [body],
    ),
  ).toBeDefined();
});

it("allows HTML only in custom columns and escapes data fields in export markup", () => {
  const custom: TheaterPreset = {
    id: "custom-card",
    name: "纸条",
    prompt: "写张纸条",
    presentation: "custom",
  };
  const html =
    "<style>p{color:red}</style><script>stolen()</script><p>留下 &amp; 纸条</p>";
  const record = data([
    section(forum, [
      item("safe-1", {
        text: '<img src="https://evil.test/pixel">',
        quote: "<script>quoted()</script>",
        fields: [{ label: "<字段>", value: "A & B" }],
      }),
    ]),
    section(custom, [], { html }),
  ]);
  expect(normalizeTheaterData(record, [forum, custom]).sections[1].html).toBe(
    html,
  );
  expect(() =>
    normalizeTheaterData(data([section(forum, [item()], { html })]), [forum]),
  ).toThrow("HTML");
  expect(() =>
    normalizeTheaterData(
      data([section(custom, [], { html: "<style>p{color:red}</style>" })]),
      [custom],
    ),
  ).toThrow("可阅读内容");
  const exported = structuredTheaterHtml(record);
  expect(exported).not.toMatch(/<(?:script|style|img)\b/i);
  expect(exported).toContain(
    "&lt;img src=&quot;https://evil.test/pixel&quot;&gt;",
  );
  expect(exported).toContain("&lt;字段&gt;");
  expect(exported).toContain("留下 &amp; 纸条");
  expect(structuredTheaterText(record)).toContain(
    "引用待核对「<script>quoted()</script>」",
  );
  expect(structuredTheaterText(record, "<script>quoted()</script>")).toContain("原文「<script>quoted()</script>」");
  expect(structuredTheaterText(record)).not.toContain("stolen()");
});

it("rejects oversize or empty content without silently trimming it", () => {
  const long = item("long", { text: "很".repeat(12001) });
  expect(() =>
    normalizeTheaterData(data([section(forum, [long])]), [forum]),
  ).toThrow();
  expect(() =>
    normalizeTheaterData(data([section(forum, [])]), [forum]),
  ).toThrow("可阅读内容");
  expect(() =>
    normalizeTheaterData(
      data([section(forum, [item("blank", { text: " " })])]),
      [forum],
    ),
  ).toThrow("可阅读内容");
  expect(() =>
    normalizeTheaterData({ ...data(), extra: "no" }, [forum]),
  ).toThrow();
  expect(() =>
    normalizeTheaterData(data([section(forum, [item(" invalid-id")])]), [
      forum,
    ]),
  ).toThrow();
});

it("publishes completed sections incrementally and never repairs a truncated item or section", () => {
  const first = section(forum, [
    item("floor-1", {
      text: '带有引号 " 和反斜杠 \\，还有假字段 ",\"theater\":{}',
    }),
  ]);
  const second = section(body, [
    item("body-hand", { author: "阿岚", title: "右手", status: "clear" }),
  ]);
  const prefix = `{"text":"正文","facts":[],"theater":{"version":1,"sections":[${JSON.stringify(first)}`;
  expect(parseStreamingTheater(prefix, [forum, body])).toEqual(data([first]));
  expect(
    parseStreamingTheater(
      prefix + ',{"id":"theater-body","items":[{"text":"未完',
      [forum, body],
    ),
  ).toEqual(data([first]));
  expect(
    parseStreamingTheater(prefix.slice(0, -1), [forum, body]),
  ).toBeUndefined();
  expect(
    parseStreamingTheater(prefix + `,${JSON.stringify(second)}]}}`, [
      forum,
      body,
    ]),
  ).toEqual(data([first, second]));
  expect(
    parseStreamingTheater(`\n\x60\x60\x60json\n${prefix}`, [forum, body]),
  ).toEqual(data([first]));
  expect(
    parseStreamingTheater(prefix + ',{"bad":true}', [forum, body]),
  ).toEqual(data([first]));
});

it("does not read nested, quoted or out-of-order theater distractors", () => {
  const valid = JSON.stringify(data());
  const fake = `{"theater":${valid}}`;
  expect(
    parseStreamingTheater(
      JSON.stringify({ nested: { theater: data() }, text: fake }),
      [forum],
    ),
  ).toBeUndefined();
  expect(
    parseStreamingTheater(JSON.stringify([{ theater: data() }]), [forum]),
  ).toBeUndefined();
  expect(parseStreamingTheater(JSON.stringify(fake), [forum])).toBeUndefined();
  expect(
    parseStreamingTheater(
      JSON.stringify({ text: fake, facts: [{ theater: data() }] }),
      [forum],
    ),
  ).toBeUndefined();
  expect(
    parseStreamingTheater(`{"nested":${fake},"theater":${valid}`, [forum]),
  ).toEqual(data());
  expect(
    parseStreamingTheater(
      `{"theater":{"version":2,"sections":[${JSON.stringify(section())}`,
      [forum],
    ),
  ).toBeUndefined();
  expect(
    parseStreamingTheater(
      `{"theater":{"version":1,"sections":[${JSON.stringify(section())}`,
      [body, forum],
    ),
  ).toBeUndefined();
  expect(
    parseStreamingTheater(
      `{"theater":{"sections":[${JSON.stringify(section())}`,
      [forum],
    ),
  ).toBeUndefined();
  expect(draftText(`\x60\x60\x60json\n{"theater":${valid}`)).toBe("");
  expect(draftText(`{"theater":${valid},"text":"真正正文`)).toBe("真正正文");
});

it("uses strict complete object schemas for combined and manual output across protocols", () => {
  const check = (schema: any) => {
    if (schema.type === "object") {
      expect(schema.additionalProperties).toBe(false);
      expect(schema.required).toEqual(Object.keys(schema.properties));
      for (const value of Object.values(schema.properties)) check(value);
    } else if (schema.type === "array") check(schema.items);
  };
  check(theaterOutputSchema);
  check(novelTheaterSchema);
  check(outputSchemas.theater);
  expect(novelTheaterSchema.required).toEqual(["text", "facts", "theater"]);
  expect(outputSchemas.theater.required).toEqual(["theater"]);
  expect(JSON.stringify(theaterOutputSchema)).not.toContain('"origin"');
});

it("gives distinct density guidance, observable body evidence and one combined request", () => {
  expect(theaterDensityInstruction("light")).toContain("4～5层");
  expect(theaterDensityInstruction("standard")).toContain("7～9层");
  expect(theaterDensityInstruction("rich")).toContain("10～14层");
  expect(theaterWriting).not.toContain("短番外");
  const instruction = theaterInstruction([forum, body]);
  expect(instruction).toContain('id="theater-audience"');
  expect(instruction).toContain("replyTo");
  expect(instruction).toContain("只讨论当前回合已公开内容");
  expect(instruction).toContain("左");
  expect(instruction).toContain("脚踝");
  expect(instruction).toContain("不能把没提到写成正常");
  expect(instruction).not.toContain("theaterHtml");
  const prefs = {
    id: "preferences" as const,
    activeProfile: "",
    developer: false,
    prompts: {},
  };
  expect(prompt("novel", prefs, true)).toContain("text、facts、theater");
  expect(prompt("novel", prefs, true)).toContain("不追加第二次请求");
  expect(prompt("novel", prefs, true)).not.toContain("简短的小剧场");
  expect(prompt("theater", prefs)).toContain(
    '"theater":{"version":1,"sections":[]}',
  );
});
