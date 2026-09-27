import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db, initialize, sessionKeys } from "../src/db";
import { preview, run } from "../src/engine";
import { generateTheater, validateTheaterResponse } from "../src/theater";
import { builtInTheaterPresets } from "../src/theater-presets";
import type {
  Profile,
  Protocol,
  SceneEvent,
  TheaterData,
  TheaterItem,
  TheaterPreset,
} from "../src/types";

const forum = builtInTheaterPresets.find((p) => p.id === "theater-audience")!;
const bodyPreset = builtInTheaterPresets.find((p) => p.id === "theater-body")!;
const custom: TheaterPreset = {
  id: "explicit-custom",
  name: "自选画框",
  presentation: "custom",
  prompt: "画一个静态片段。",
};
const body = "周屿把伞放在门边，右手没有松开。";
const legacyHtml = "<section><h2>静态番外</h2><p>仅阅读内容独有标记。</p></section>";
const item = (patch: Partial<TheaterItem> = {}): TheaterItem => ({
  id: "floor-one",
  author: "看雨的人",
  badge: "细节党",
  title: "还没松手",
  text: "他把伞放下了，可手还在伞柄上。",
  quote: "右手没有松开",
  certainty: "observed",
  replyTo: "",
  group: "雨伞",
  status: "",
  fields: [],
  ...patch,
});
const data = (preset = forum, items = [item()]): TheaterData => ({
  version: 1,
  sections: [{
    id: preset.id,
    title: preset.name,
    presentation: preset.presentation!,
    theme: "paper",
    html: "",
    items,
  }],
});
const profile: Profile = {
  id: "format-regression",
  name: "交互格式回归",
  protocol: "chat",
  url: "https://theater.fixture.test/v1",
  model: "fixture",
  stream: false,
  context: 64000,
  maxOutput: 4096,
  timeout: 10,
  remember: false,
};

function response(value: unknown, protocol: Protocol = "chat") {
  const text = JSON.stringify(value);
  const payload = protocol === "responses"
    ? { status: "completed", output: [{ content: [{ type: "output_text", text }] }] }
    : protocol === "claude"
      ? { stop_reason: "end_turn", content: [{ type: "text", text }] }
      : protocol === "gemini"
        ? { candidates: [{ finishReason: "STOP", content: { parts: [{ text }] } }] }
        : { choices: [{ message: { content: text }, finish_reason: "stop" }] };
  return new Response(JSON.stringify(payload), { headers: { "content-type": "application/json" } });
}

beforeEach(async () => {
  await db.delete();
  await db.open();
  await initialize();
  await db.profiles.put(profile);
  await db.preferences.update("preferences", { activeProfile: profile.id });
  sessionKeys.set(profile.id, "fixture-key");
});
afterEach(() => vi.restoreAllMocks());

describe("fresh theater response format boundary", () => {
  it.each(builtInTheaterPresets)("accepts free HTML output for $id", (preset) => {
    const result = validateTheaterResponse(JSON.stringify({ theaterHtml: legacyHtml }), [preset]);
    expect(result.htmlPages).toEqual([{id: preset.id, title: preset.name, html: legacyHtml}]);
  });

  it("preserves combined HTML fallback for mixed selections", () => {
    const result = validateTheaterResponse(JSON.stringify({ theaterHtml: legacyHtml }), [custom, forum]);
    expect(result.htmlPages?.[0].html).toBe(legacyHtml);
    expect(result.htmlPages?.[0].title).toContain(forum.name);
  });

  it("accepts explicitly custom HTML both in the response envelope and as a caller-provided fallback", () => {
    const fromEnvelope = validateTheaterResponse(JSON.stringify({ theaterHtml: legacyHtml }), [custom]);
    const fromCaller = validateTheaterResponse("{}", [custom], legacyHtml);
    expect(fromEnvelope.html).toBe(legacyHtml);
    expect(fromEnvelope.data).toBeUndefined();
    expect(fromEnvelope.text).toContain("静态番外");
    expect(fromEnvelope.text).toContain("仅阅读内容独有标记。");
    expect(fromCaller).toEqual(fromEnvelope);
  });

  it.each([null, {}, { version: 1, sections: [] }])("never hides malformed structured data behind valid HTML: %j", (theater) => {
    expect(() => validateTheaterResponse(JSON.stringify({ theater, theaterHtml: legacyHtml }), [custom], legacyHtml))
      .toThrow();
  });

  it("uses valid structured content as the single source for interactive data, HTML and text", () => {
    const structured = data();
    const result = validateTheaterResponse(JSON.stringify({ theater: structured, theaterHtml: legacyHtml }), [forum], legacyHtml);
    expect(result.data).toEqual(structured);
    expect(result.html).toContain("他把伞放下了，可手还在伞柄上。");
    expect(result.text).toContain("他把伞放下了，可手还在伞柄上。");
    expect(result.html).not.toContain("仅阅读内容独有标记");
    expect(result.text).not.toContain("仅阅读内容独有标记");
  });

  it("preserves body part state, evidence and detail fields in interactive data", () => {
    const fields = [{ label: "本回合变化", value: "放下伞之后仍握着" }, { label: "持续情况", value: "到回合末" }];
    const structured = data(bodyPreset, [item({ author: "周屿", title: "右手", status: "subtle", fields })]);
    const result = validateTheaterResponse(JSON.stringify({ theater: structured }), [bodyPreset]);
    expect(result.data?.sections[0].items[0]).toMatchObject({ author: "周屿", title: "右手", status: "subtle", quote: "右手没有松开", fields });
    expect(result.text).toContain("到回合末");
  });

  it("does not accept a structured column with the wrong selected presentation", () => {
    const structured = data({ ...forum, presentation: "custom" });
    expect(() => validateTheaterResponse(JSON.stringify({ theater: structured, theaterHtml: legacyHtml }), [forum]))
      .toThrow("展示结构");
  });
});

describe("automatic output retains canonical prose on theater failure", () => {
  it("places the active interaction format guard after legacy custom theater prompt text", async () => {
    const story = (await db.stories.toArray())[0];
    await db.stories.update(story.id, { theaterAuto: true, autoMemory: false, theaterPresetIds: [forum.id] });
    const prefs = (await db.preferences.get("preferences"))!;
    const legacyOverride = "保留我的观众口气。只输出 theaterHtml 字符串，完整 HTML，不要 theater 对象。";
    await db.preferences.update("preferences", { prompts: { ...prefs.prompts, theater: { enabled: true, text: legacyOverride } } });
    const context = await preview(story.id, "novel", "他把伞放下。");
    expect(context.system).toContain(legacyOverride);
    expect(context.system.lastIndexOf("小剧场输出约定")).toBeGreaterThan(context.system.lastIndexOf(legacyOverride));
  });

  it.each<Protocol>(["chat", "responses", "claude", "gemini"])("keeps completed prose with one request on the %s protocol", async (protocol) => {
    const configured = { ...profile, protocol, outputMode: "schema" as const };
    await db.profiles.put(configured);
    const story = (await db.stories.toArray())[0];
    await db.stories.update(story.id, { theaterAuto: true, autoMemory: false, theaterPresetIds: [forum.id] });
    const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(response({ text: body, facts: [], theaterHtml: legacyHtml }, protocol));
    await run(story.id, "novel", "他把伞放下。");
    const event = (await db.events.where("storyId").equals(story.id).toArray())[0];
    const theater = (await db.theaters.get(event.theater!.id))!;
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(event).toMatchObject({ text: body, status: "complete" });
    expect(event.raw).not.toContain("仅阅读内容独有标记");
    expect(theater.status).toBe("complete");
    expect(theater.htmlPages?.[0].html).toBe(legacyHtml);
    expect(theater.raw).toContain("仅阅读内容独有标记");
    expect(await db.promptSessions.count()).toBe(0);
    const sent = JSON.parse(String(fetcher.mock.calls[0][1]?.body));
    const schema = protocol === "chat" ? sent.response_format.json_schema.schema
      : protocol === "responses" ? sent.text.format.schema
        : protocol === "claude" ? sent.output_config.format.schema
          : sent.generationConfig.responseJsonSchema;
    expect(schema.required).toContain("text");
    expect(schema.required).toContain("theater");
    expect(schema.properties).not.toHaveProperty("theaterHtml");
    await db.stories.update(story.id, { theaterAuto: false });
    expect(JSON.stringify(await preview(story.id, "novel", "等雨停下来。")))
      .not.toContain("仅阅读内容独有标记");
  });
});

it("preserves a previously saved static record when new generation fails, and allows one explicit structured retry", async () => {
  const story = (await db.stories.toArray())[0];
  await db.stories.update(story.id, { theaterPresetIds: [forum.id], autoMemory: false });
  const event: SceneEvent = {
    id: "format-target", storyId: story.id, seq: 1, round: 1, kind: "novel", speaker: "", participants: [], input: "放下伞。", text: body,
    facts: [], versions: [{ id: "format-version", text: body, input: "放下伞。", facts: [], created: 1 }], versionId: "format-version", status: "complete",
    raw: "", error: "", review: false, deleted: false, created: 1, theater: { id: "old-static", sourceVersionId: "format-version", status: "complete" },
  };
  await db.events.put(event);
  const old = { id: "old-static", storyId: story.id, eventId: event.id, sourceVersionId: event.versionId, presets: [forum], html: legacyHtml, text: "旧版已保存内容", raw: JSON.stringify({ theaterHtml: legacyHtml }), status: "complete" as const, error: "", created: 1, updated: 1 };
  await db.theaters.put(old);
  const fetcher = vi.spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(response({ theaterHtml: "<style>body{color:red}</style>" }))
    .mockResolvedValueOnce(response({ theater: data() }));
  await expect(generateTheater(event.id)).rejects.toThrow();
  expect(fetcher).toHaveBeenCalledTimes(1);
  const failed = await db.theaters.get((await db.events.get(event.id))!.theater!.id);
  expect(failed).toMatchObject({ status: "failed", previousId: old.id });
  expect(await db.theaters.get(old.id)).toEqual(old);
  await expect(generateTheater(event.id)).resolves.toBe("saved");
  expect(fetcher).toHaveBeenCalledTimes(2);
  const latest = await db.theaters.get((await db.events.get(event.id))!.theater!.id);
  expect(latest?.status).toBe("complete");
  expect(latest?.data?.sections[0].presentation).toBe("forum");
  expect(await db.theaters.get(old.id)).toEqual(old);
});
