import "fake-indexeddb/auto";
import Dexie from "dexie";
import { expect, it } from "vitest";
import { SceneDB, makeStory } from "../src/db";
import { editableTheaterPreset, copiedTheaterPreset } from "../src/TheaterSettings";
import { allTheaterPresets, resolveTheaterPreset, restoreBuiltInTheaterPresentation, selectedTheaterPresets } from "../src/theater-presets";
import { uid, type Preferences, type TheaterPreset, type TheaterRecord } from "../src/types";

const legacyForum: TheaterPreset = {
  id: "theater-audience", name: "我改名的论坛", prompt: "只讨论停在门口的那个动作，保留我的口气。",
};
const preferences = (presets: TheaterPreset[]): Preferences => ({
  id: "preferences", activeProfile: "", developer: true, prompts: {}, theaterPresets: presets,
});

it("inherits a missing built-in presentation without replacing custom words in selection, editing or copying", () => {
  const prefs = preferences([legacyForum]);
  const expected = { ...legacyForum, presentation: "forum" };
  expect(resolveTheaterPreset(legacyForum)).toEqual(expected);
  expect(allTheaterPresets(prefs).find((preset) => preset.id === legacyForum.id)).toEqual(expected);
  expect(selectedTheaterPresets({ ...makeStory("测试", []), theaterPresetIds: [legacyForum.id] }, prefs)).toEqual([expected]);
  expect(editableTheaterPreset(legacyForum)).toEqual(expected);
  const copied = copiedTheaterPreset(legacyForum);
  expect(copied).toEqual({ ...expected, id: copied.id, name: legacyForum.name + "（副本）" });
  expect(copied.id).not.toBe(legacyForum.id);
  expect(resolveTheaterPreset(copied).presentation).toBe("forum");
  expect(legacyForum).not.toHaveProperty("presentation");
});

it("keeps explicit custom or freeform static and does not infer types for unknown IDs", () => {
  expect(resolveTheaterPreset({ ...legacyForum, presentation: "custom" }).presentation).toBe("custom");
  expect(resolveTheaterPreset({ ...legacyForum, presentation: "freeform" } as unknown as TheaterPreset).presentation).toBe("custom");
  expect(resolveTheaterPreset({ ...legacyForum, id: "reader-defined-forum" }).presentation).toBe("custom");
});

it("restores only the built-in interaction form on explicit user recovery", () => {
  const staticPreset = { ...legacyForum, presentation: "custom" as const };
  expect(restoreBuiltInTheaterPresentation(staticPreset)).toEqual({ ...legacyForum, presentation: "forum" });
  expect(staticPreset.presentation).toBe("custom");
  const custom = { ...staticPreset, id: "reader-own" };
  expect(restoreBuiltInTheaterPresentation(custom)).toEqual(custom);
});

it("upgrades a schema 8 database to 9 by repairing configuration only, preserving prose and theater history", async () => {
  const name = "theater-config-upgrade-" + uid();
  const old = new Dexie(name);
  old.version(8).stores({
    preferences: "id", stories: "id,updated", events: "id,storyId,[storyId+seq],[storyId+seq+id]",
    theaters: "id,storyId,eventId,[eventId+sourceVersionId],status,interaction.status",
  });
  const explicitStatic = { ...legacyForum, id: "theater-body", presentation: "custom" as const };
  const unknown = { ...legacyForum, id: "private-preset" };
  const legacyExplicit = { ...legacyForum, id: "theater-details", presentation: "freeform" } as unknown as TheaterPreset;
  const prefs = preferences([legacyForum, explicitStatic, unknown, legacyExplicit]);
  const story = { ...makeStory("旧故事", []), id: "story", theaterPresetIds: [legacyForum.id] };
  const prose = { id: "prose", storyId: story.id, seq: 1, text: "她在门口停了一下。" };
  const result: TheaterRecord = {
    id: "old-result", storyId: story.id, eventId: prose.id, sourceVersionId: "version",
    presets: [legacyForum], html: "<article>仍是旧的静态内容</article>", text: "仍是旧的静态内容",
    raw: "原始静态回复", status: "complete", error: "", created: 1, updated: 1,
  };
  const structuredResult: TheaterRecord = {
    ...result, id: "old-structured-result",
    data: { version: 1, sections: [{ id: legacyForum.id, title: "旧内容", presentation: "custom", theme: "paper", items: [], html: result.html }] },
  };
  await old.open();
  await old.table("preferences").put(prefs);
  await old.table("stories").put(story);
  await old.table("events").put(prose);
  await old.table("theaters").bulkPut([result, structuredResult]);
  old.close();
  const upgraded = new SceneDB(name);
  try {
    await upgraded.open();
    expect(upgraded.verno).toBe(9);
    expect(await upgraded.preferences.get("preferences")).toEqual({
      ...prefs, theaterPresets: [
        { ...legacyForum, presentation: "forum" }, explicitStatic, { ...unknown, presentation: "custom" }, legacyExplicit,
      ],
    });
    expect(await upgraded.stories.get(story.id)).toEqual(story);
    expect(await upgraded.events.get(prose.id)).toEqual(prose);
    expect(await upgraded.theaters.get(result.id)).toEqual(result);
    expect(await upgraded.theaters.get(structuredResult.id)).toEqual(structuredResult);
    expect(await upgraded.theaters.count()).toBe(2);
  } finally {
    await upgraded.delete();
  }
});
