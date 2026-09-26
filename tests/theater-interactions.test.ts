import "fake-indexeddb/auto";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { db, initialize, sessionKeys, reviseEvent } from "../src/db";
import { run, preview } from "../src/engine";
import { generateTheater } from "../src/theater";
import { interactWithTheater, stopTheaterInteraction, toggleTheaterReaction, saveTheaterReading, saveTheaterReplyDraft } from "../src/theater-interactions";
import { builtInTheaterPresets } from "../src/theater-presets";
import { structuredTheaterText } from "../src/theater-data";
import type { TheaterData, TheaterItem, SceneEvent, Profile } from "../src/types";

const p: Profile = { id: "interactive-fixture", name: "test", protocol: "chat", url: "https://theater.fixture.test/v1", model: "fixture", stream: false, context: 64000, maxOutput: 4096, timeout: 10, remember: false };
const item = (id: string, text: string, extra: Partial<TheaterItem> = {}): TheaterItem => ({ id, author: "看雨的人", badge: "细节党", title: "", text, quote: "", certainty: "inferred", replyTo: "", group: "", status: "", fields: [], ...extra });
const data = (): TheaterData => ({ version: 1, sections: [
  { id: "theater-audience", title: "这一把伞", presentation: "forum", theme: "forest", html: "", items: [item("f1", "他把伞放下了，但还没有走。", { quote: "伞放在门边", certainty: "observed" })] },
  { id: "theater-body", title: "当下的身体", presentation: "body-status", theme: "paper", html: "", items: [item("b1", "握着伞柄", { author: "沈知言", title: "右手", group: "上肢", status: "subtle", fields: [{ label: "依据", value: "右手没有松开" }] })] },
] });
const response = (value: unknown, reason = "stop") => new Response(JSON.stringify({ choices: [{ message: { content: typeof value === "string" ? value : JSON.stringify(value) }, finish_reason: reason }] }), { headers: { "content-type": "application/json" } });
const addition = (id = "new-floor", text = "这是补充楼层，先别急着下结论。", replyTo = "f1") => ({ theater: { version: 1, sections: [{ ...data().sections[0], items: [item(id, text, { replyTo })] }] } });

beforeEach(async () => {
  await db.delete(); await db.open(); await initialize();
  await db.profiles.put(p); sessionKeys.set(p.id, "fixture-key");
  await db.preferences.update("preferences", { activeProfile: p.id });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function fixture() {
  const story = (await db.stories.toArray())[0];
  await db.stories.update(story.id, { autoMemory: false, theaterPresetIds: ["theater-audience", "theater-body"], theaterAuto: true });
  const event: SceneEvent = { id: "target", storyId: story.id, seq: 1, round: 1, kind: "novel", speaker: "", participants: [], input: "递伞。", text: "沈知言把伞放在门边，右手没有松开。", facts: [], versions: [], versionId: "source", status: "complete", raw: "", error: "", review: false, deleted: false, created: 1, theater: { id: "saved", sourceVersionId: "source", status: "complete" } };
  event.versions = [{ id: "source", text: event.text, input: event.input, facts: [], created: 1 }];
  await db.events.put(event);
  await db.theaters.put({ id: "saved", storyId: story.id, eventId: event.id, sourceVersionId: event.versionId, status: "complete", data: data(), html: "<p>旧小剧场</p>", text: structuredTheaterText(data()), presets: [builtInTheaterPresets.find((p) => p.id === "theater-audience")!, builtInTheaterPresets.find((p) => p.id === "theater-body")!], density: "rich", raw: "", error: "", created: 1, updated: 1 });
  return { story, event };
}

it("saves structured manual and one-request automatic generation without leaking it into prose history", async () => {
  const { story } = await fixture();
  const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(response({ theater: data() }));
  await generateTheater("target");
  let e = (await db.events.get("target"))!;
  expect((await db.theaters.get(e.theater!.id))?.data?.sections[0].items[0].id).toBe("f1");
  expect(fetcher).toHaveBeenCalledTimes(1);
  fetcher.mockResolvedValue(response({ text: "新正文，雨停下来。", facts: [], theater: data() }));
  await run(story.id, "novel", "雨停了。");
  expect(fetcher).toHaveBeenCalledTimes(2);
  e = (await db.events.where("storyId").equals(story.id).sortBy("seq")).at(-1)!;
  expect(e.text).toBe("新正文，雨停下来。");
  expect(e.raw).not.toContain("这一把伞");
  expect((await db.theaters.get(e.theater!.id))?.status).toBe("complete");
  await db.stories.update(story.id, { theaterAuto: false });
  expect(JSON.stringify(await preview(story.id, "novel", "收好书。"))).not.toContain("这一把伞");
});

it("replies once, keeps original floors and other sections, persists user text and stays outside memories", async () => {
  const { story, event } = await fixture();
  await saveTheaterReplyDraft("saved", "theater-audience", "可他还没松手呀。");
  const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(response(addition()));
  const a = interactWithTheater("saved", "theater-audience", "reply", "可他还没松手呀。", "f1");
  const b = interactWithTheater("saved", "theater-audience", "reply", "可他还没松手呀。", "f1");
  expect(a).toBe(b); await a;
  expect(fetcher).toHaveBeenCalledTimes(1);
  const record = (await db.theaters.get("saved"))!;
  expect(record.status).toBe("complete");
  expect(record.interaction?.status).toBe("complete");
  expect(record.data?.sections[0].items).toHaveLength(3);
  expect(record.data?.sections[0].items[0]).toMatchObject(data().sections[0].items[0]);
  expect(record.data?.sections[0].items[1]).toMatchObject({ text: "可他还没松手呀。", origin: "user" });
  expect(record.data?.sections[1]).toMatchObject(data().sections[1]);
  expect(record.replyDrafts?.["theater-audience"]).toBe("");
  const sent = JSON.parse(String(fetcher.mock.calls[0][1]?.body));
  expect(sent.max_tokens).toBe(4096);
  expect(sent.messages[1].content).toContain("可他还没松手呀。");
  expect(sent.messages[1].content).not.toContain("当下的身体");
  expect((await db.events.get(event.id))?.text).toBe(event.text);
  expect(await db.memories.count()).toBe(0);
  expect(JSON.stringify(await preview(story.id, "novel", "看看门外。"))).not.toContain("可他还没松手呀。");
});

it("a failed reply preserves content and retries without duplicating the user's floor", async () => {
  await fixture();
  const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(response('{"theater":', "length")).mockResolvedValue(response(addition()));
  await expect(interactWithTheater("saved", "theater-audience", "reply", "我觉得只是顺手。", "f1")).rejects.toThrow("未完整结束");
  let record = (await db.theaters.get("saved"))!;
  expect(record.data!.sections[0].items).toHaveLength(2);
  expect(record.interaction?.status).toBe("failed");
  await interactWithTheater("saved", "theater-audience", "reply", "我觉得只是顺手。", "f1");
  record = (await db.theaters.get("saved"))!;
  expect(record.data!.sections[0].items.filter((item) => item.origin === "user")).toHaveLength(1);
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it.each(["edit", "cancel", "delete"])("rejects a late %s response without overwriting old content", async (change) => {
  const { story } = await fixture();
  let release!: (value: Response) => void;
  const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(() => new Promise((resolve) => { release = resolve; }));
  const work = interactWithTheater("saved", "theater-audience", "expand", "再看一处细节。");
  // Attach an error handler immediately, before releasing the controlled response.
  const settled = work.catch((error) => String(error));
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
  if (change === "edit") await reviseEvent("target", "新的正文。", false, [], "source");
  if (change === "cancel") stopTheaterInteraction("saved");
  if (change === "delete") await db.stories.delete(story.id);
  release(response(addition("late", "迟到结果绝不能写入")));
  await settled;
  const saved = (await db.theaters.get("saved"))!;
  expect(saved.text).not.toContain("迟到结果");
  expect(saved.interaction?.status).toBe(change === "cancel" ? "interrupted" : "failed");
  expect(saved.data!.sections[0].items).toHaveLength(1);
});

it("offline reading controls and drafts never send a model request", async () => {
  await fixture();
  const fetcher = vi.spyOn(globalThis, "fetch");
  await toggleTheaterReaction("saved", "theater-audience", "f1", "likes");
  await toggleTheaterReaction("saved", "theater-audience", "f1", "bookmarks");
  await saveTheaterReading("saved", { clarity: true, fontSize: 22 });
  await saveTheaterReplyDraft("saved", "theater-audience", "尚未发送");
  const record = (await db.theaters.get("saved"))!;
  expect(record.likes).toEqual(["theater-audience/f1"]);
  expect(record.bookmarks).toEqual(["theater-audience/f1"]);
  expect(record.reading).toEqual({ clarity: true, fontSize: 22 });
  expect(record.replyDrafts?.["theater-audience"]).toBe("尚未发送");
  expect(fetcher).not.toHaveBeenCalled();
});

it("rejects model attempts to overwrite an existing floor", async () => {
  await fixture();
  vi.spyOn(globalThis, "fetch").mockResolvedValue(response(addition("f1", "覆盖旧楼")));
  await expect(interactWithTheater("saved", "theater-audience", "expand", "多写一些。")).rejects.toThrow("重复");
  expect((await db.theaters.get("saved"))?.data!.sections[0].items[0].text).toBe(data().sections[0].items[0].text);
});
