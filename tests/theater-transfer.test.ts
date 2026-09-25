import "fake-indexeddb/auto";
import Dexie from "dexie";
import { afterEach, beforeEach, expect, it } from "vitest";
import { strFromU8, unzipSync } from "fflate";
import { db, SceneDB, initialize, deleteStory, makeStory } from "../src/db";
import { exportBackup, importBackup, validateBackup } from "../src/backup";
import { stageBackup, commitStaged, exportBackupBlob } from "../src/backup-transfer";
import { TransferControl } from "../src/transfer-store";
import { exportWork } from "../src/work-export";
import { createTheaterAttempt } from "../src/theater";
import type { WorkOptions } from "../src/transfer-types";
import { uid, type SceneEvent, type TheaterRecord } from "../src/types";

beforeEach(async () => {
  await db.delete();
  await db.open();
  await initialize();
});
afterEach(async () => { await db.delete(); });

async function fixture() {
  const story = (await db.stories.toArray())[0];
  const preset = { id: "my-theater", name: "茶水间", prompt: "写两个人没说出口的念头。" };
  await db.preferences.update("preferences", { theaterPresets: [preset] });
  story.theaterAuto = true;
  story.theaterPresetIds = [preset.id];
  await db.stories.put(story);
  const event: SceneEvent = {
    id: uid(), storyId: story.id, seq: 1, kind: "novel", speaker: "",
    participants: [], input: "写一次重逢。", text: "她停在门口。", facts: [],
    versionId: uid(), versions: [], status: "complete", raw: "", error: "",
    review: false, deleted: false, created: 1,
  };
  event.versions = [{ id: event.versionId, text: event.text, input: event.input, created: 1, facts: [] }];
  const theater: TheaterRecord = {
    id: uid(), storyId: story.id, eventId: event.id, sourceVersionId: event.versionId,
    presets: [preset], html: '<article><script>doNotRun()</script>茶已经凉了</article>',
    text: "茶已经凉了。<script>只是文字</script>", raw: "原始小剧场", status: "complete",
    error: "", created: 2, updated: 2,
  };
  event.theater = { id: theater.id, sourceVersionId: event.versionId, status: "complete" };
  await db.events.put(event);
  await db.theaters.put(theater);
  return { story, event, theater, preset };
}
const blob = (data: unknown) => new Blob([JSON.stringify(data)]);
const options = (storyId: string, patch: Partial<WorkOptions> = {}): WorkOptions => ({
  storyId, content: "novel", range: "all", from: 1, to: 1, background: false,
  characters: false, format: "txt", fontSize: 16, lineHeight: 1.8, pageBreak: false,
  ...patch,
});

it("upgrades an existing version 5 database without altering saved prose", async () => {
  const name = "theater-upgrade-" + uid();
  const old = new Dexie(name);
  old.version(5).stores({ stories: "id,updated", events: "id,storyId,[storyId+seq],[storyId+seq+id]" });
  await old.open();
  await old.table("stories").put({ id: "preserved", title: "旧故事", updated: 1 });
  await old.table("events").put({ id: "old-prose", storyId: "preserved", seq: 1, text: "旧正文不会变化" });
  old.close();
  const upgraded = new SceneDB(name);
  try {
    await upgraded.open();
    expect(upgraded.verno).toBe(7);
    expect((await upgraded.events.get("old-prose"))?.text).toBe("旧正文不会变化");
    expect(await upgraded.theaters.count()).toBe(0);
    expect(await upgraded.roleCompletionDrafts.count()).toBe(0);
  } finally { await upgraded.delete(); }
});

it("recovers interrupted attempts and their summaries while preserving the last success, then deletes them with the story", async () => {
  const { story, event, theater } = await fixture();
  const attempt = { ...theater, id: uid(), previousId: theater.id, status: "running" as const, created: 3 };
  await db.theaters.put(attempt);
  await db.events.update(event.id, { theater: { id: attempt.id, sourceVersionId: event.versionId, status: "running", previousId: theater.id } });
  const loadedIds: string[] = [];
  const observe = (record: TheaterRecord) => { loadedIds.push(record.id); return record; };
  db.theaters.hook("reading", observe);
  try { await initialize(); }
  finally { db.theaters.hook("reading").unsubscribe(observe); }
  expect(loadedIds).not.toContain(theater.id);
  expect(loadedIds).toContain(attempt.id);
  expect((await db.theaters.get(attempt.id))?.status).toBe("interrupted");
  expect((await db.events.get(event.id))?.theater).toMatchObject({ status: "interrupted", previousId: theater.id });
  expect((await db.theaters.get(theater.id))?.html).toBe(theater.html);
  await deleteStory(story.id);
  expect(await db.theaters.count()).toBe(0);
});

it.each(["legacy", "stream"])("imports v1 backups without theaters through %s", async (method) => {
  await fixture();
  const value: any = await exportBackup();
  value.version = 1;
  delete value.theaters;
  for (const event of value.events) delete event.theater;
  for (const story of value.stories) { delete story.theaterAuto; delete story.theaterPresetIds; }
  for (const preferences of value.preferences) delete preferences.theaterPresets;
  expect(validateBackup(value).theaters).toEqual([]);
  if (method === "legacy") await importBackup(value);
  else {
    const summary = await stageBackup(blob(value), uid());
    expect(summary.counts.theaters).toBe(0);
    await commitStaged(summary.session, { replace: false, applySettings: false });
  }
  expect(await db.stories.count()).toBe(2);
  expect(await db.theaters.count()).toBe(1);
});

it.each(["legacy", "stream"])("exports density snapshots and defaults missing legacy density to standard through %s", async (method) => {
  const { story, theater } = await fixture();
  await db.stories.update(story.id, { theaterDensity: "rich" });
  await db.theaters.update(theater.id, { density: "light" });
  const exported = await exportBackup();
  expect(exported.stories.find((row) => row.id === story.id)?.theaterDensity).toBe("rich");
  expect(exported.theaters.find((row) => row.id === theater.id)?.density).toBe("light");
  const streamExport = await exportBackupBlob(uid());
  const streamed = JSON.parse(await streamExport.blob.text());
  expect(streamed.stories.find((row: any) => row.id === story.id)?.theaterDensity).toBe("rich");
  expect(streamed.theaters.find((row: any) => row.id === theater.id)?.density).toBe("light");

  const legacy = structuredClone(exported) as any;
  legacy.version = 1;
  delete legacy.stories[0].theaterDensity;
  delete legacy.theaters[0].density;
  expect(validateBackup(legacy).stories[0].theaterDensity).toBeUndefined();
  expect(validateBackup(legacy).theaters[0].density).toBeUndefined();
  if (method === "legacy") await importBackup(legacy);
  else {
    const summary = await stageBackup(blob(legacy), uid());
    await commitStaged(summary.session, { replace: false, applySettings: false });
  }
  const copied = (await db.stories.toArray()).find((row) => row.id !== story.id)!;
  const copiedTheater = (await db.theaters.where("storyId").equals(copied.id).toArray())[0];
  expect(copied.theaterDensity).toBe("standard");
  expect(copiedTheater.density).toBe("standard");
});

it.each(["legacy", "stream"])("defaults missing theater presentation to custom through %s", async (method) => {
  const { theater } = await fixture();
  const value: any = structuredClone(await exportBackup());
  delete value.preferences[0].theaterPresets[0].presentation;
  delete value.theaters[0].presets[0].presentation;
  expect(validateBackup(value).preferences[0].theaterPresets[0].presentation).toBe("custom");
  expect(validateBackup(value).theaters[0].presets[0].presentation).toBe("custom");
  if (method === "legacy") await importBackup(value);
  else {
    const summary = await stageBackup(blob(value), uid());
    await commitStaged(summary.session, { replace: false, applySettings: false });
  }
  const copied = (await db.stories.toArray()).find((story) => story.id !== theater.storyId)!;
  const saved = (await db.preferences.get("preferences"))!.theaterPresets!;
  expect(saved.find((preset) => preset.id === "my-theater")?.presentation).toBe("custom");
  expect((await db.theaters.where("storyId").equals(copied.id).first())?.presets[0].presentation).toBe("custom");
});

it("uses the story density snapshot when starting a new theater attempt and defaults old stories to standard", async () => {
  const { story, event } = await fixture();
  await db.stories.update(story.id, { theaterDensity: "rich" });
  const rich = await createTheaterAttempt(event, [{ id: "theater-roast", name: "吐槽", prompt: "" }]);
  expect(rich.density).toBe("rich");
  await db.theaters.delete(rich.id);
  await db.events.update(event.id, { theater: undefined });
  await db.stories.update(story.id, { theaterDensity: undefined });
  const standard = await createTheaterAttempt(event, [{ id: "theater-roast", name: "吐槽", prompt: "" }]);
  expect(standard.density).toBe("standard");
});

it.each(["legacy", "stream"])("blocks %s imports during a manual theater request without a job record", async (method) => {
  const { event, theater } = await fixture();
  const incoming = await exportBackup();
  await db.theaters.update(theater.id, { status: "running" });
  await db.events.update(event.id, { theater: { id: theater.id, sourceVersionId: event.versionId, status: "running" } });
  expect(await db.jobs.count()).toBe(0);
  const before = await exportBackup();
  if (method === "legacy") await expect(importBackup(incoming, true)).rejects.toThrow(/先停止/);
  else {
    const summary = await stageBackup(blob(incoming), uid());
    await expect(commitStaged(summary.session, { replace: true, applySettings: true })).rejects.toThrow(/先停止/);
  }
  const after = await exportBackup();
  expect(after.stories).toEqual(before.stories);
  expect(after.events).toEqual(before.events);
  expect(after.theaters).toEqual(before.theaters);
});

it.each(["legacy", "stream"])("round-trips theater versions, fallback IDs, preset conflicts and interrupted status through %s", async (method) => {
  const { story, event, theater, preset } = await fixture();
  const attempt = { ...theater, id: uid(), status: "running" as const, previousId: theater.id, updated: 3 };
  await db.theaters.put(attempt);
  await db.events.update(event.id, { theater: { id: attempt.id, sourceVersionId: event.versionId, status: "running", previousId: theater.id } });
  const value = await exportBackup();
  expect(value.version).toBe(2);
  await initialize();
  await db.preferences.update("preferences", { theaterPresets: [{ ...preset, prompt: "本机刚修改的要求" }] });
  if (method === "legacy") await importBackup(value);
  else {
    const summary = await stageBackup(blob(value), uid());
    await commitStaged(summary.session, { replace: false, applySettings: false });
  }
  const copy = (await db.stories.toArray()).find((s) => s.id !== story.id)!;
  const copiedEvent = (await db.events.where("storyId").equals(copy.id).toArray())[0];
  const copiedAttempt = (await db.theaters.get(copiedEvent.theater!.id))!;
  const previous = (await db.theaters.get(copiedAttempt.previousId!))!;
  expect(copiedEvent.id).not.toBe(event.id);
  expect(copiedAttempt.id).not.toBe(attempt.id);
  expect(copiedAttempt.sourceVersionId).toBe(copiedEvent.versionId);
  expect(copiedEvent.theater?.status).toBe("interrupted");
  expect(copiedAttempt.status).toBe("interrupted");
  expect(previous.status).toBe("complete");
  expect(previous.eventId).toBe(copiedEvent.id);
  expect(previous.html).toBe(theater.html);
  expect(copy.theaterPresetIds?.[0]).not.toBe(preset.id);
  expect(copiedAttempt.presets[0].id).toBe(copy.theaterPresetIds?.[0]);
  const saved = (await db.preferences.get("preferences"))!.theaterPresets!;
  expect(saved.find((p) => p.id === preset.id)?.prompt).toBe("本机刚修改的要求");
  expect(saved.find((p) => p.id === copy.theaterPresetIds?.[0])?.prompt).toBe(preset.prompt);
  expect(() => validateBackup(value)).not.toThrow();
  expect(() => validateBackup({ ...value, theaters: undefined })).toThrow();
  validateBackup(await exportBackup());
});

it.each(["legacy", "stream"])("preserves the prior prose version's successful theater as a failed retry fallback through %s", async (method) => {
  const { story, event, theater } = await fixture();
  const currentVersion = uid();
  const attempt = { ...theater, id: uid(), sourceVersionId: currentVersion,
    status: "failed" as const, previousId: theater.id, html: "", text: "", updated: 3 };
  await db.events.update(event.id, {
    versionId: currentVersion, text: "她终于推开了门。",
    versions: [...event.versions, { ...event.versions[0], id: currentVersion, text: "她终于推开了门。" }],
    theater: { id: attempt.id, sourceVersionId: currentVersion, status: "failed", previousId: theater.id },
  });
  await db.theaters.add(attempt);
  const value = await exportBackup();
  expect(() => validateBackup(value)).not.toThrow();
  if (method === "legacy") await importBackup(value);
  else {
    const summary = await stageBackup(blob(value), uid());
    await commitStaged(summary.session, { replace: false, applySettings: false });
  }
  const copy = (await db.stories.toArray()).find((s) => s.id !== story.id)!;
  const copiedEvent = (await db.events.where("storyId").equals(copy.id).toArray())[0];
  const copiedAttempt = (await db.theaters.get(copiedEvent.theater!.id))!;
  const previous = (await db.theaters.get(copiedAttempt.previousId!))!;
  expect(copiedAttempt.sourceVersionId).toBe(copiedEvent.versionId);
  expect(previous.sourceVersionId).not.toBe(copiedEvent.versionId);
  expect(previous.eventId).toBe(copiedEvent.id);
  expect(previous.storyId).toBe(copy.id);
  expect(previous.status).toBe("complete");
  expect(previous.html).toBe(theater.html);
  expect(copiedEvent.versions.some((v) => v.id === previous.sourceVersionId)).toBe(true);
  const output = await exportWork(uid(), options(copy.id, { theaters: true }));
  expect(await output.blob.text()).not.toContain(theater.text);
  validateBackup(await exportBackup());
});

it("still rejects a fallback from another paragraph or an unsuccessful attempt", async () => {
  const { event, theater } = await fixture();
  const attempt = { ...theater, id: uid(), previousId: theater.id, status: "failed" as const };
  await db.theaters.add(attempt);
  await db.events.update(event.id, { theater: { id: attempt.id, sourceVersionId: event.versionId, status: "failed", previousId: theater.id } });
  const original = await exportBackup();
  for (const condition of ["another-event", "incomplete"] as const) {
    const value = structuredClone(original);
    const previous = value.theaters.find((record) => record.id === theater.id)!;
    if (condition === "another-event") {
      const other = { ...value.events[0], id: uid(), seq: 2, theater: undefined };
      value.events.push(other);
      previous.eventId = other.id;
    } else previous.status = "failed";
    expect(() => validateBackup(value)).toThrow(/已有结果关联/);
    await expect(stageBackup(blob(value), uid())).rejects.toThrow(/已有结果关联/);
  }
});

it("single-story backups carry selected and historical presets but omit unrelated data and isolate built-in overrides", async () => {
  const { story, theater, preset } = await fixture();
  const historical = { id: "theater-roast", name: "旧吐槽", prompt: "本书独有的吐槽要求" };
  const unused = { id: "unrelated", name: "其他作品的预设", prompt: "无关" };
  await db.preferences.update("preferences", { theaterPresets: [preset, historical, unused] });
  await db.theaters.update(theater.id, { presets: [historical] });
  const other = makeStory("另一部", []);
  await db.stories.add(other);
  const output = await exportBackupBlob(uid(), story.id);
  const value = JSON.parse(await output.blob.text());
  expect(value.version).toBe(2);
  expect(value.stories.map((s: any) => s.id)).toEqual([story.id]);
  expect(value.theaters).toHaveLength(1);
  expect(value.preferences[0].theaterPresets.map((p: any) => p.id).sort()).toEqual([preset.id, historical.id].sort());
  expect(value.profiles).toEqual([]);
  expect(value.preferences[0].prompts).toEqual({});
  await db.preferences.update("preferences", { theaterPresets: [preset] });
  const summary = await stageBackup(blob(value), uid());
  await commitStaged(summary.session, { replace: false, applySettings: false });
  const copy = (await db.stories.toArray()).find((s) => s.title.endsWith("（导入副本）"))!;
  const copied = (await db.theaters.where("storyId").equals(copy.id).toArray())[0];
  expect(copied.presets[0].id).not.toBe("theater-roast");
  expect((await db.preferences.get("preferences"))?.theaterPresets?.find((p) => p.id === copied.presets[0].id)?.prompt).toBe(historical.prompt);
});

it("rejects broken source versions and fallback links before import and rolls cancellation back atomically", async () => {
  const { theater } = await fixture();
  const original = await exportBackup();
  for (const patch of [{ sourceVersionId: "missing" }, { previousId: theater.id }]) {
    const value = structuredClone(original);
    Object.assign(value.theaters[0], patch);
    expect(() => validateBackup(value)).toThrow(/小剧场/);
    await expect(stageBackup(blob(value), uid())).rejects.toThrow(/小剧场/);
  }
  const summary = await stageBackup(blob(original), uid());
  const control = new TransferControl((progress) => { if (progress.phase === "importing") control.cancel(); });
  await expect(commitStaged(summary.session, { replace: true, applySettings: true }, control)).rejects.toThrow();
  const after = await exportBackup();
  expect(after.theaters).toEqual(original.theaters);
  expect(after.events).toEqual(original.events);
  expect(after.stories).toEqual(original.stories);
});

it.each(["legacy", "stream"])("preserves an old story's implicit default preset override through single-story export and %s import", async (method) => {
  const { story } = await fixture();
  const override = { id: "theater-roast", name: "茶馆吐槽", prompt: "沿用这部作品的茶馆口气。", presentation: "custom" as const };
  await db.stories.update(story.id, { theaterPresetIds: undefined });
  await db.preferences.update("preferences", { theaterPresets: [override] });
  const output = await exportBackupBlob(uid(), story.id);
  const value = JSON.parse(await output.blob.text());
  expect(value.preferences[0].theaterPresets).toContainEqual(override);
  expect(value.stories[0].theaterPresetIds).toBeUndefined();
  await db.preferences.update("preferences", { theaterPresets: [] });
  if (method === "legacy") await importBackup(value);
  else {
    const summary = await stageBackup(blob(value), uid());
    await commitStaged(summary.session, { replace: false, applySettings: false });
  }
  const copy = (await db.stories.toArray()).find((s) => s.id !== story.id)!;
  expect(copy.theaterPresetIds).toHaveLength(1);
  expect(copy.theaterPresetIds![0]).not.toBe("theater-roast");
  expect((await db.preferences.get("preferences"))!.theaterPresets!.find((p) => p.id === copy.theaterPresetIds![0]))
    .toEqual({ ...override, id: copy.theaterPresetIds![0] });
});

it.each(["txt", "md", "docx", "epub", "print"] as const)("exports optional current completed theater text safely in %s", async (format) => {
  const { story, event, theater } = await fixture();
  const oldVersion = uid();
  await db.events.update(event.id, { versions: [...event.versions, { ...event.versions[0], id: oldVersion, text: "旧正文" }] });
  await db.theaters.bulkAdd([
    { ...theater, id: uid(), sourceVersionId: oldVersion, text: "过期小剧场", updated: 50 },
    { ...theater, id: uid(), text: "未完成小剧场", status: "failed", previousId: theater.id, updated: 99 },
  ]);
  const read = async (withTheaters: boolean) => {
    const result = await exportWork(uid(), options(story.id, { format, theaters: withTheaters }));
    if (format === "docx" || format === "epub") {
      const entries = unzipSync(new Uint8Array(await result.blob.arrayBuffer()));
      return strFromU8(entries[format === "docx" ? "word/document.xml" : "OEBPS/story.xhtml"]);
    }
    return result.blob.text();
  };
  expect(await read(false)).not.toContain("茶已经凉了");
  const text = await read(true);
  expect(text).toContain("茶已经凉了");
  expect(text).toContain("茶水间");
  expect(text).not.toContain("过期小剧场");
  expect(text).not.toContain("未完成小剧场");
  expect(text).not.toContain("doNotRun()");
  if (!["txt", "md"].includes(format)) {
    expect(text).not.toContain("<script>");
    expect(text).toContain("&lt;script&gt;只是文字&lt;/script&gt;");
  }
});
