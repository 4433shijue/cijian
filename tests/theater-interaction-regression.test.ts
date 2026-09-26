import "fake-indexeddb/auto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { strFromU8, unzipSync } from "fflate";
import { db, initialize, sessionKeys } from "../src/db";
import { exportBackup, validateBackup } from "../src/backup";
import { exportBackupBlob } from "../src/backup-transfer";
import { exportWork } from "../src/work-export";
import { generateTheater, stopTheater } from "../src/theater";
import {
  interactWithTheater,
  saveTheaterReading,
  saveTheaterReplyDraft,
  stopTheaterInteraction,
  toggleTheaterReaction,
} from "../src/theater-interactions";
import { builtInTheaterPresets } from "../src/theater-presets";
import { structuredTheaterHtml, structuredTheaterText } from "../src/theater-data";
import { uid, type Profile, type SceneEvent, type TheaterData, type TheaterItem, type TheaterRecord } from "../src/types";
import type { WorkFormat } from "../src/transfer-types";

const profile: Profile = {
  id: "regression-profile", name: "MOCK", protocol: "chat", url: "https://theater.fixture.test/v1",
  model: "fixture", stream: false, context: 64000, maxOutput: 4096, timeout: 10, remember: false,
};
const preset = builtInTheaterPresets.find((preset) => preset.id === "theater-audience")!;
const item = (id: string, text: string, patch: Partial<TheaterItem> = {}): TheaterItem => ({
  id, author: "看雨的人", badge: "细节党", title: "", text, quote: "", certainty: "inferred",
  replyTo: "", group: "", status: "", fields: [], ...patch,
});
const data = (items = [item("first", "他把伞放在门口，手却没松。")]): TheaterData => ({
  version: 1,
  sections: [{ id: preset.id, title: "伞放下了，人呢", presentation: "forum", theme: "paper", html: "", items }],
});
const response = (value: unknown) => new Response(JSON.stringify({
  choices: [{ message: { content: JSON.stringify(value) }, finish_reason: "stop" }],
}), { headers: { "content-type": "application/json" } });
const addition = (text = "新增回复内容，仅留在小剧场。") => ({
  theater: data([item("new", text, { replyTo: "first" })]),
});

beforeEach(async () => {
  await db.delete(); await db.open(); await initialize();
  await db.profiles.put(profile);
  sessionKeys.set(profile.id, "fixture-key");
  await db.preferences.update("preferences", { activeProfile: profile.id });
});
afterEach(async () => {
  vi.restoreAllMocks(); vi.unstubAllGlobals();
  sessionKeys.delete(profile.id);
  await db.delete();
});

async function fixture(content = data()) {
  const story = (await db.stories.toArray())[0];
  story.autoMemory = false;
  story.theaterPresetIds = [preset.id];
  story.worldIds = ["regression-world"];
  await db.stories.put(story);
  await db.world.put({
    id: "regression-world", title: "门口的雨", text: "伞架放在门口，雨水沿伞面流下来。",
    type: "world", enabled: true, always: true, keywords: [], roleIds: [], storyIds: [story.id], knownBy: [], audience: "all",
  });
  const event: SceneEvent = {
    id: "regression-event", storyId: story.id, seq: 1, round: 1, kind: "novel", speaker: "", participants: [],
    input: "递伞。", text: "沈知言把伞放在门边，右手没有松开。", facts: [], versionId: "regression-version", versions: [],
    status: "complete", raw: "", error: "", review: false, deleted: false, created: 1,
    theater: { id: "regression-theater", sourceVersionId: "regression-version", status: "complete" },
  };
  event.versions = [{ id: event.versionId, text: event.text, input: event.input, facts: [], created: 1 }];
  const record: TheaterRecord = {
    id: "regression-theater", storyId: story.id, eventId: event.id, sourceVersionId: event.versionId,
    presets: [preset], data: content, html: structuredTheaterHtml(content), text: structuredTheaterText(content),
    density: "rich", status: "complete", raw: "", error: "", created: 1, updated: 1,
  };
  await db.events.put(event);
  await db.theaters.put(record);
  return { story, event, record };
}

it("rejects a reply at the 240-item limit before saving a floor or requesting AI and keeps backups exportable", async () => {
  const content = data(Array.from({ length: 240 }, (_, index) => item(index ? "floor-" + index : "first", "这层暂时还在等下文。")));
  const { story, record } = await fixture(content);
  await saveTheaterReplyDraft(record.id, preset.id, "这一句暂时留在草稿。");
  const before = await db.theaters.get(record.id);
  const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(response(addition()));
  await expect(interactWithTheater(record.id, preset.id, "reply", "这一句暂时留在草稿。", "first")).rejects.toThrow();
  expect(fetcher).not.toHaveBeenCalled();
  expect(await db.theaters.get(record.id)).toEqual(before);
  expect(await db.jobs.count()).toBe(0);
  validateBackup(await exportBackup());
  const exported = JSON.parse(await (await exportBackupBlob(uid(), story.id)).blob.text());
  expect(validateBackup(exported).theaters[0].data?.sections[0].items).toHaveLength(240);
  expect(exported.theaters[0].replyDrafts[preset.id]).toBe("这一句暂时留在草稿。");
});

it("rolls back a successful follow-up when cancellation arrives inside its final commit", async () => {
  const { event, record } = await fixture();
  vi.spyOn(globalThis, "fetch").mockResolvedValue(response(addition("最终存储时取消，这条不该出现。")));
  let cancelled = false;
  const onUpdate = (changes: Record<string, unknown>, key: unknown) => {
    const status = changes["interaction.status"] || (changes.interaction as { status?: string } | undefined)?.status;
    if (key === record.id && status === "complete" && !cancelled) {
      cancelled = true;
      stopTheaterInteraction(record.id);
    }
  };
  db.theaters.hook("updating", onUpdate);
  try { await interactWithTheater(record.id, preset.id, "reply", "我先留一句。", "first"); }
  finally { db.theaters.hook("updating").unsubscribe(onUpdate); }
  expect(cancelled).toBe(true);
  const saved = (await db.theaters.get(record.id))!;
  expect(saved.status).toBe("complete");
  expect(saved.interaction?.status).toBe("interrupted");
  expect(saved.data!.sections[0].items).toHaveLength(2);
  expect(saved.data!.sections[0].items[1]).toMatchObject({ origin: "user", text: "我先留一句。" });
  expect(saved.text).not.toContain("最终存储时取消");
  expect((await db.jobs.get(saved.interaction!.id))?.status).toBe("interrupted");
  expect((await db.events.get(event.id))?.theater?.status).toBe("complete");
});

it("rolls back a manual result when cancellation arrives inside its final commit and retains the prior success", async () => {
  const { event, record } = await fixture();
  vi.spyOn(globalThis, "fetch").mockResolvedValue(response({ theater: data([item("new-root", "手动重生成的新结果。")]) }));
  let cancelled = false;
  const onUpdate = (changes: Record<string, unknown>, key: unknown) => {
    if (key !== record.id && changes.status === "complete" && !cancelled) {
      cancelled = true;
      void stopTheater(event.id);
    }
  };
  db.theaters.hook("updating", onUpdate);
  let outcome: string;
  try { outcome = await generateTheater(event.id); }
  finally { db.theaters.hook("updating").unsubscribe(onUpdate); }
  expect(cancelled).toBe(true);
  expect(outcome).toBe("interrupted");
  const summary = (await db.events.get(event.id))!.theater!;
  const saved = (await db.theaters.get(summary.id))!;
  expect(saved.status).toBe("interrupted");
  expect(summary.status).toBe("interrupted");
  expect(saved.previousId).toBe(record.id);
  expect(await db.theaters.get(record.id)).toEqual(record);
});

it.each(["character", "world"])("rejects a late follow-up after the %s material changes", async (kind) => {
  const { story, record } = await fixture();
  let release!: (value: Response) => void;
  const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(() => new Promise((resolve) => { release = resolve; }));
  const settled = interactWithTheater(record.id, preset.id, "expand", "再看一处细节。").catch((error) => error);
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
  if (kind === "character") {
    const current = (await db.stories.get(story.id))!;
    await db.stories.update(story.id, { roles: current.roles.map((role, index) => index ? role : { ...role, bio: "人物简介已修改。" }) });
  } else await db.world.update("regression-world", { text: "设定已改，这里并没有伞架。" });
  release(response(addition("基于过期材料的追加。")));
  expect(String(await settled)).toMatch(/变化/);
  const saved = (await db.theaters.get(record.id))!;
  expect(saved.data).toEqual(record.data);
  expect(saved.text).toBe(record.text);
  expect(saved.interaction?.status).toBe("failed");
  expect(saved.interaction?.raw).toContain("基于过期材料的追加");
});

it("keeps reader changes and a newer reply draft made while an AI reply is pending", async () => {
  const { record } = await fixture();
  await saveTheaterReplyDraft(record.id, preset.id, "已经发送的留言。");
  let release!: (value: Response) => void;
  const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(() => new Promise((resolve) => { release = resolve; }));
  const work = interactWithTheater(record.id, preset.id, "reply", "已经发送的留言。", "first");
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
  await saveTheaterReading(record.id, { clarity: false, fontSize: 23 });
  await toggleTheaterReaction(record.id, preset.id, "first", "likes");
  await toggleTheaterReaction(record.id, preset.id, "first", "bookmarks");
  await saveTheaterReplyDraft(record.id, preset.id, "正在写下一条，不要替我清掉。");
  release(response(addition()));
  await work;
  const saved = (await db.theaters.get(record.id))!;
  expect(saved.interaction?.status).toBe("complete");
  expect(saved.reading).toEqual({ clarity: false, fontSize: 23 });
  expect(saved.likes).toEqual([preset.id + "/first"]);
  expect(saved.bookmarks).toEqual([preset.id + "/first"]);
  expect(saved.replyDrafts?.[preset.id]).toBe("正在写下一条，不要替我清掉。");
  expect(saved.data!.sections[0].items[1]).toMatchObject({ origin: "user", text: "已经发送的留言。" });
  expect(saved.text).toContain("新增回复内容，仅留在小剧场。");
});

it.each(["txt", "md", "docx", "epub", "print"] as WorkFormat[])("exports saved user and AI additions in %s only when theaters are included", async (format) => {
  const { story, record } = await fixture();
  const userText = "用户留言应进入番外作品导出。";
  const aiText = "观众的新回复也应进入番外作品导出。";
  vi.spyOn(globalThis, "fetch").mockResolvedValue(response(addition(aiText)));
  await interactWithTheater(record.id, preset.id, "reply", userText, "first");
  const read = async (theaters: boolean) => {
    const result = await exportWork(uid(), { storyId: story.id, content: "novel", range: "all", from: 1, to: 1,
      background: false, characters: false, format, fontSize: 16, lineHeight: 1.8, pageBreak: false, theaters });
    if (format === "docx" || format === "epub") {
      const entries = unzipSync(new Uint8Array(await result.blob.arrayBuffer()));
      return strFromU8(entries[format === "docx" ? "word/document.xml" : "OEBPS/story.xhtml"]);
    }
    return result.blob.text();
  };
  const proseOnly = await read(false);
  expect(proseOnly).not.toContain(userText);
  expect(proseOnly).not.toContain(aiText);
  const withTheater = await read(true);
  expect(withTheater).toContain(userText);
  expect(withTheater).toContain(aiText);
  expect(withTheater).toContain(preset.name);
});
