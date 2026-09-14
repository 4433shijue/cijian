import "fake-indexeddb/auto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { db, initialize, sessionKeys } from "../src/db";
import {
  buildInspirationContext,
  parseInspiration,
  requestInspiration,
  chooseInspiration,
} from "../src/inspiration";
import { run } from "../src/engine";
import { exportBackup, validateBackup, importBackup } from "../src/backup";
import type {
  InspirationOption,
  Preferences,
  Profile,
  SceneEvent,
  Story,
} from "../src/types";

const prefs: Preferences = {
  id: "preferences",
  activeProfile: "inspiration-fixture",
  developer: false,
  prompts: {},
};
const profile: Profile = {
  id: prefs.activeProfile,
  name: "fixture",
  protocol: "chat",
  url: "https://inspiration.fixture.test/v1",
  model: "fixture",
  stream: false,
  context: 16000,
  maxOutput: 2048,
  timeout: 10,
  remember: false,
};
const options = (round = 1): InspirationOption[] =>
  (["relationship", "discovery", "external", "decision"] as const).map(
    (direction, i) => ({
      direction,
      title: `方向${round}-${i}`,
      text: `第${round}轮的第${i}种事件，人物做出不同的选择。`,
    }),
  );
const response = (data: unknown, finish_reason = "stop") =>
  new Response(
    JSON.stringify({
      choices: [
        {
          message: {
            content: typeof data === "string" ? data : JSON.stringify(data),
          },
          finish_reason,
        },
      ],
    }),
    { headers: { "Content-Type": "application/json" } },
  );
let story: Story;
const event = (seq: number, patch: Partial<SceneEvent> = {}): SceneEvent => ({
  id: `prose-${seq}`,
  storyId: story.id,
  seq,
  kind: "novel",
  origin: "ai",
  speaker: "",
  participants: [],
  input: "",
  text: `正文内容标记_${seq}`,
  facts: [],
  versions: [
    {
      id: `version-${seq}`,
      text: `正文内容标记_${seq}`,
      input: "",
      created: 1,
      facts: [],
    },
  ],
  versionId: `version-${seq}`,
  status: "complete",
  raw: "",
  error: "",
  review: false,
  deleted: false,
  created: 1,
  ...patch,
});
beforeEach(async () => {
  await db.delete();
  await db.open();
  await initialize();
  story = (await db.stories.toArray())[0];
  story.autoMemory = false;
  story.draft = "";
  await db.stories.put(story);
  await db.preferences.put(prefs);
  await db.profiles.put(profile);
  sessionKeys.set(profile.id, "controlled-fixture-key");
});
afterEach(async () => {
  vi.unstubAllGlobals();
  sessionKeys.clear();
  await db.delete();
});

it("uses the most recent three full replies including folded text, story roles and applicable world entries", async () => {
  story.timelineMode = "strict";
  const events = [
    event(1),
    event(2),
    event(3, { collapsed: true }),
    event(4),
    event(5),
    event(6, { kind: "message", text: "私聊不在参考窗口" }),
    event(7, { status: "draft" }),
    event(8, { deleted: true }),
    event(9, { review: true }),
  ];
  const world = await db.world.toArray();
  world.push(
    { ...world[0], id: "unbound", text: "未加载世界书" },
    { ...world[0], id: "disabled", text: "关闭的世界书", enabled: false },
  );
  story.worldIds.push("disabled");
  const built = buildInspirationContext(
    story,
    events.reverse(),
    world,
    prefs,
    profile,
  );
  expect(built.sources.map((s) => s.id)).toEqual([
    "prose-3",
    "prose-4",
    "prose-5",
  ]);
  expect(buildInspirationContext({ ...story, timelineMode: "shared" }, events, world, prefs, profile).sources.map((s) => s.id))
    .toEqual(["prose-4", "prose-5", "prose-9"]);
  for (const text of [story.roles[0].persona, world[0].text, "正文内容标记_3"])
    expect(built.report.user).toContain(text);
  for (const text of [
    "正文内容标记_1",
    "正文内容标记_2",
    "正文内容标记_7",
    "私聊不在参考窗口",
    "未加载世界书",
    "关闭的世界书",
  ])
    expect(built.report.user).not.toContain(text);
  expect(
    buildInspirationContext(
      story,
      events,
      world,
      { ...prefs, inspirationParagraphs: 5 },
      profile,
    ).sources,
  ).toHaveLength(5);
  expect(() =>
    buildInspirationContext(story, events, world, prefs, {
      ...profile,
      context: 800,
    }),
  ).toThrow();
});

it("rejects incomplete, duplicate and recycled option sets", () => {
  expect(parseInspiration(JSON.stringify({ options: options() }))).toHaveLength(
    4,
  );
  for (const invalid of [
    options().slice(0, 3),
    options().map((o) => ({ ...o, direction: "relationship" })),
    options().map((o) => ({ ...o, text: "同一件事。" })),
  ])
    expect(() =>
      parseInspiration(JSON.stringify({ options: invalid })),
    ).toThrow();
  expect(() =>
    parseInspiration(JSON.stringify({ options: options() }), options()),
  ).toThrow("沿用");
});

it("deduplicates concurrent opens, caches only options, and retains them when a reroll fails", async () => {
  const fetcher = vi.fn().mockResolvedValue(response({ options: options() }));
  vi.stubGlobal("fetch", fetcher);
  await Promise.all([
    requestInspiration(story.id),
    requestInspiration(story.id),
  ]);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect((await db.stories.get(story.id))?.inspiration?.options).toEqual(
    options(),
  );
  expect(await db.events.count()).toBe(0);
  expect(await db.memories.count()).toBe(0);
  fetcher.mockResolvedValueOnce(response({ options: options(2).slice(0, 2) }));
  await expect(requestInspiration(story.id)).rejects.toThrow("四个选项");
  expect((await db.stories.get(story.id))?.inspiration?.options).toEqual(
    options(),
  );
  fetcher.mockResolvedValueOnce(response({ options: options(2) }));
  await requestInspiration(story.id);
  const body = JSON.parse(fetcher.mock.calls.at(-1)![1].body);
  expect(body.messages[1].content).toContain(options()[0].text);
  expect((await db.stories.get(story.id))?.inspiration?.options).toEqual(
    options(2),
  );
});

it("keeps a round through failed prose and chat, clearing it only after successful prose", async () => {
  await db.stories.update(story.id, {
    inspiration: { options: options(), sources: [], created: 1 },
  });
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(response({ text: "半段正文" }, "length"));
  vi.stubGlobal("fetch", fetcher);
  await expect(run(story.id, "novel", "人物留在门边。")).rejects.toThrow();
  expect((await db.stories.get(story.id))?.inspiration).toBeDefined();
  fetcher.mockResolvedValueOnce(response({ messages: ["明天再来。"] }));
  await run(story.id, "chat", "我明天再来。");
  expect((await db.stories.get(story.id))?.inspiration).toBeDefined();
  fetcher.mockResolvedValueOnce(
    response({ text: "他还站在门边，伞上的水落了下来。", facts: [] }),
  );
  await run(story.id, "novel", "人物留在门边。");
  expect((await db.stories.get(story.id))?.inspiration).toBeUndefined();
});

it("discards a late inspiration response after the next prose was saved", async () => {
  let finish!: (r: Response) => void;
  const fetcher = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    )
    .mockResolvedValueOnce(response({ text: "他在门边收起伞。", facts: [] }));
  vi.stubGlobal("fetch", fetcher);
  const pending = requestInspiration(story.id);
  await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
  await run(story.id, "novel", "人物收伞。");
  finish(response({ options: options() }));
  await pending;
  expect((await db.stories.get(story.id))?.inspiration).toBeUndefined();
});

it("does not restore suggestions to a deleted story", async () => {
  let finish!: (r: Response) => void;
  vi.stubGlobal(
    "fetch",
    vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    ),
  );
  const pending = requestInspiration(story.id);
  await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
  await db.stories.delete(story.id);
  finish(response({ options: options() }));
  await pending;
  expect(await db.stories.get(story.id)).toBeUndefined();
});

it("switches the chosen idea across rounds while preserving the author's writing", async () => {
  await db.stories.update(story.id, {
    inspiration: { options: options(), sources: [], created: 1 },
  });
  const chosen = await chooseInspiration(
    story.id,
    options()[0].text,
    "作者自己的开头。",
  );
  expect(chosen).toBe("作者自己的开头。\n\n" + options()[0].text);
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(response({ options: options(2) })),
  );
  await requestInspiration(story.id);
  expect(await chooseInspiration(story.id, options(2)[1].text, chosen)).toBe(
    "作者自己的开头。\n\n" + options(2)[1].text,
  );
  await expect(
    chooseInspiration(story.id, options()[0].text, chosen),
  ).rejects.toThrow("已更新");
});

it("clears a round after a successful prose rewrite", async () => {
  await db.events.put(event(1));
  await db.stories.update(story.id, {
    inspiration: { options: options(), sources: [], created: 1 },
  });
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValue(response({ text: "重新描写的片刻。", facts: [] })),
  );
  await run(story.id, "novel", "描写这一刻。", "prose-1");
  expect((await db.stories.get(story.id))?.inspiration).toBeUndefined();
});

it("backs up folding and developer settings without treating ideas as saved story events", async () => {
  await db.events.put(event(1, { collapsed: true }));
  await db.stories.update(story.id, {
    inspiration: { options: options(), sources: [], created: 1 },
  });
  await db.preferences.update("preferences", {
    inspirationParagraphs: 5,
    stylePresets: [
      {
        id: "custom-style",
        name: "冷静短句",
        description: "",
        prompt: "多用短句，少解释情绪。",
        scope: "both",
      },
    ],
    prompts: { inspiration: { text: "用动作写清人物的选择。", enabled: true } },
  });
  const backup = validateBackup(await exportBackup());
  expect(backup.events[0].collapsed).toBe(true);
  expect(backup.preferences[0].inspirationParagraphs).toBe(5);
  expect(backup.preferences[0].stylePresets?.[0].name).toBe("冷静短句");
  expect(backup.preferences[0].prompts.inspiration?.enabled).toBe(true);
  expect(JSON.stringify(backup)).not.toContain(options()[0].text);
  await importBackup(backup, true);
  expect((await db.events.toArray())[0].collapsed).toBe(true);
  expect((await db.preferences.get("preferences"))?.inspirationParagraphs).toBe(
    5,
  );
  expect(
    (await db.preferences.get("preferences"))?.stylePresets?.[0].name,
  ).toBe("冷静短句");
});
