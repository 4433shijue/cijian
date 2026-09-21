import "fake-indexeddb/auto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { db, initialize, sessionKeys } from "../src/db";
import {
  buildInspirationContext,
  parseInspiration,
  requestInspiration,
  chooseInspiration,
  inspirationState,
} from "../src/inspiration";
import { authorIdea } from "../src/inspiration-context";
import { outputSchemas } from "../src/output";
import { run } from "../src/engine";
import { exportBackup, validateBackup, importBackup } from "../src/backup";
import type {
  InspirationOption,
  Preferences,
  Profile,
  SceneEvent,
  Story,
  Memory,
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
  Array.from({ length: 4 }, (_, i) => ({
    title: `方向${round}-${i}`,
    text: `第${round}轮的第${i}种事件，人物做出不同的选择。`,
  }));
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
    event(6, {
      kind: "message",
      text: "刚刚在私聊里约好了明天见面",
      participants: [story.roles[0].id],
    }),
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
    "prose-6",
  ]);
  expect(
    buildInspirationContext(
      { ...story, timelineMode: "shared" },
      events,
      world,
      prefs,
      profile,
    ).sources.map((s) => s.id),
  ).toEqual(["prose-4", "prose-5", "prose-6", "prose-9"]);
  for (const text of [
    ...story.roles[0].paragraphs.map((p) => p.text),
    world[0].text,
    "正文内容标记_3",
    "刚刚在私聊里约好了明天见面",
  ])
    expect(built.report.user).toContain(text);
  for (const text of [
    "正文内容标记_1",
    "正文内容标记_2",
    "正文内容标记_7",
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
  ).toHaveLength(6);
  expect(() =>
    buildInspirationContext(story, events, world, prefs, {
      ...profile,
      context: 800,
    }),
  ).toThrow();
});

it("accepts unclassified cards and old category fields, validating only complete card structure", () => {
  expect(parseInspiration(JSON.stringify({ options: options() }))).toHaveLength(
    4,
  );
  for (const invalid of [
    options().slice(0, 3),
    options().map((o) => ({ ...o, text: "  " })),
    options().map((o) => ({ ...o, title: 42 })),
  ])
    expect(() =>
      parseInspiration(JSON.stringify({ options: invalid })),
    ).toThrow();
  expect(
    parseInspiration(
      JSON.stringify({
        options: options().map((o) => ({ ...o, direction: "relationship" })),
      }),
    ),
  ).toEqual(options());
  expect(JSON.stringify(outputSchemas.inspiration)).not.toContain("direction");
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
  await db.stories.update(story.id, { draft: "作者自己的开头。" });
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(response({ options: options() }))
    .mockResolvedValueOnce(response({ options: options(2) }));
  vi.stubGlobal("fetch", fetcher);
  await requestInspiration(story.id);
  const chosen = await chooseInspiration(
    story.id,
    options()[0].text,
    "作者自己的开头。",
  );
  expect(chosen).toBe("作者自己的开头。\n\n" + options()[0].text);
  expect((await inspirationState(story.id))?.stale).toBe(false);
  expect(authorIdea((await db.stories.get(story.id))!)).toBe(
    "作者自己的开头。",
  );
  await requestInspiration(story.id);
  const body = JSON.parse(fetcher.mock.calls[1][1].body);
  const draftSection = body.messages[1].content
    .split("【作者尚未采用的想法")[1]
    .split("【上一轮建议")[0];
  expect(draftSection).toContain("没有发生");
  expect(draftSection).not.toContain(options()[0].text);
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

it("grounds suggestions in chronological chat and current accepted memories, with private knowledge labelled", async () => {
  const [a, b] = story.roles;
  const events = [
    event(1, { text: "她明确说现在不想拥抱。" }),
    event(2),
    event(3),
    event(4),
    event(5, {
      kind: "message",
      speaker: b.id,
      participants: [a.id, b.id],
      chatPending: true,
      text: "今晚不去见面，明天在书店碰头。",
    }),
  ];
  const memory: Memory = {
    id: "promise",
    storyId: story.id,
    text: "她拒绝了拥抱，对方答应保持距离。",
    knownBy: [a.id, b.id],
    scope: "story",
    sources: [{ id: "prose-1", versionId: "version-1" }],
    status: "accepted",
    created: 1,
  };
  const world = await db.world.toArray();
  const secret = {
    ...world[0],
    id: "secret",
    text: "作者秘密标记",
    audience: "author" as const,
  };
  story.worldIds.push(secret.id);
  const memories: Memory[] = [
    memory,
    { ...memory, id: "candidate", status: "candidate", text: "未确认的猜测" },
    {
      ...memory,
      id: "stale",
      sources: [{ id: "prose-1", versionId: "old" }],
      text: "旧版本记忆",
    },
    {
      ...memory,
      id: "other-story",
      storyId: "elsewhere",
      text: "别本故事的记忆",
    },
  ];
  const { report, sources } = buildInspirationContext(
    story,
    events,
    [...world, secret],
    prefs,
    profile,
    memories,
    "他不会主动靠近。",
  );
  expect(report.user).toContain(memory.text);
  expect(report.user).toContain(events.at(-1)!.text);
  expect(report.user.indexOf(memory.text)).toBeLessThan(
    report.user.indexOf(events[1].text),
  );
  expect(report.user.indexOf(events[3].text)).toBeLessThan(
    report.user.indexOf(events[4].text),
  );
  expect(report.included.find((m) => m.id === "promise")?.text).toContain(
    `${a.name}（${a.id}）`,
  );
  expect(report.included.find((m) => m.id === "secret")?.text).toContain(
    "未授权给任何角色",
  );
  expect(report.included.find((m) => m.id === "prose-5")?.label).toContain(
    "尚待回复",
  );
  expect(
    report.included.find((m) => m.id === "author-feedback")?.label,
  ).toContain("不代表已发生");
  expect(report.system).toContain("刚明确拒绝的事不能无缘由地突然接受");
  expect(report.system).not.toContain("各出现一次");
  for (const forbidden of ["未确认的猜测", "旧版本记忆", "别本故事的记忆"])
    expect(report.user).not.toContain(forbidden);
  expect(sources.map((ref) => ref.id)).toEqual(events.map((e) => e.id));
});

it("bounds recent messages, resolves world triggers and limits memory knowledge to source permissions", async () => {
  const [a, b] = story.roles;
  const events = Array.from({ length: 24 }, (_, i) =>
    event(i + 1, {
      kind: "message",
      speaker: a.id,
      participants: [a.id],
      text: `私聊第${i + 1}条，约好在灯塔碰面。`,
      chatBatchId: `batch-${i}`,
    }),
  );
  const world = await db.world.toArray();
  world.push(
    {
      ...world[0],
      id: "lighthouse",
      always: false,
      keywords: ["灯塔"],
      text: "灯塔周围没有咖啡馆。",
    },
    {
      ...world[0],
      id: "irrelevant",
      always: false,
      keywords: ["机场"],
      text: "未触发地点",
    },
  );
  story.worldIds.push("lighthouse", "irrelevant");
  const memory: Memory = {
    id: "private-memory",
    storyId: story.id,
    text: "私聊约定",
    knownBy: [a.id, b.id],
    scope: "story",
    sources: [{ id: "prose-1", versionId: "version-1" }],
    status: "accepted",
    created: 1,
  };
  const { report } = buildInspirationContext(
    story,
    events,
    world,
    prefs,
    profile,
    [memory],
  );
  expect(report.included.filter((m) => m.id.startsWith("prose-"))).toHaveLength(
    19,
  );
  expect(report.user).not.toContain("私聊第4条");
  expect(report.user).toContain("私聊第24条");
  expect(report.user).toContain("灯塔周围没有咖啡馆");
  expect(report.user).not.toContain("未触发地点");
  expect(
    report.included.find((m) => m.id === "private-memory")?.text,
  ).not.toContain(b.name);
});

it.each([
  "prose",
  "chat",
  "persona",
  "world",
  "memory",
  "audience",
  "rules",
  "author-draft",
])(
  "marks saved ideas stale after changing %s, without calling the model or allowing adoption",
  async (change) => {
    await db.events.put(event(1));
    const fetcher = vi.fn().mockResolvedValue(response({ options: options() }));
    vi.stubGlobal("fetch", fetcher);
    await requestInspiration(story.id);
    expect((await inspirationState(story.id))?.stale).toBe(false);
    if (change === "prose")
      await db.events.update("prose-1", {
        text: "新的明确拒绝",
        versionId: "edited",
      });
    if (change === "chat")
      await db.events.put(
        event(2, {
          kind: "message",
          text: "新聊天约定",
          participants: story.roles.map((r) => r.id),
        }),
      );
    if (change === "persona")
      await db.stories.update(story.id, {
        roles: story.roles.map((r) => ({
          ...r,
          persona: "人设已修改",
          paragraphs: [],
        })),
      });
    if (change === "world")
      await db.world.update(story.worldIds[0], { text: "世界规则已修改" });
    if (change === "memory")
      await db.memories.put({
        id: "new-memory",
        storyId: story.id,
        text: "已确认的新约定",
        sources: [{ id: "prose-1", versionId: "version-1" }],
        knownBy: [],
        scope: "story",
        status: "accepted",
        created: 1,
      });
    if (change === "audience")
      await db.events.update("prose-1", { visibility: "author" });
    if (change === "rules")
      await db.preferences.update("preferences", {
        prompts: { inspiration: { text: "保持距离", enabled: true } },
      });
    if (change === "author-draft")
      await db.stories.update(story.id, { draft: "我修改了尚未采用的打算。" });
    expect((await inspirationState(story.id))?.stale).toBe(true);
    await expect(
      chooseInspiration(
        story.id,
        options()[0].text,
        (await db.stories.get(story.id))!.draft,
      ),
    ).rejects.toThrow("参考内容已经变化");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect((await db.stories.get(story.id))?.inspiration?.options).toEqual(
      options(),
    );
  },
);

it("keeps a round current through folding, visual changes, unsent chat and unrelated data", async () => {
  await db.events.put(event(1));
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(response({ options: options() })),
  );
  await requestInspiration(story.id);
  await db.events.update("prose-1", { collapsed: true });
  await db.stories.update(story.id, {
    updated: Date.now(),
    title: "改了书名",
    chatDraft: "还没发的消息",
  });
  await db.events.put(event(2, { storyId: "other-story" }));
  await db.memories.put({
    id: "candidate",
    storyId: story.id,
    text: "待确认",
    knownBy: [],
    scope: "story",
    sources: [],
    status: "candidate",
    created: 1,
  });
  expect((await inspirationState(story.id))?.stale).toBe(false);
  await expect(
    chooseInspiration(story.id, options()[0].text, ""),
  ).resolves.toBe(options()[0].text);
});

it("discards a late response after an in-flight persona edit and saves only an explicitly requested fresh round", async () => {
  let finish!: (r: Response) => void;
  const fetcher = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    )
    .mockResolvedValueOnce(response({ options: options(2) }));
  vi.stubGlobal("fetch", fetcher);
  const pending = requestInspiration(story.id);
  await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
  await db.stories.update(story.id, {
    roles: story.roles.map((r) => ({
      ...r,
      persona: "先保持距离，不主动靠近。",
      paragraphs: [],
    })),
  });
  finish(response({ options: options() }));
  expect(await pending).toBe("stale");
  expect((await db.stories.get(story.id))?.inspiration).toBeUndefined();
  expect((await db.stories.get(story.id))?.inspirationRequest).toBeUndefined();
  expect(fetcher).toHaveBeenCalledTimes(1);
  await requestInspiration(story.id, "留在当前场景。");
  const sent = JSON.parse(fetcher.mock.calls[1][1].body).messages[1].content;
  expect(sent).toContain("先保持距离，不主动靠近。");
  expect(sent).toContain("留在当前场景。");
  expect((await inspirationState(story.id))?.stale).toBe(false);
});

it("retains legacy rounds for viewing but requires a refresh before selecting them", async () => {
  await db.stories.update(story.id, {
    inspiration: { options: options(), sources: [], created: 1 },
  });
  expect((await inspirationState(story.id))?.stale).toBe(true);
  await expect(
    chooseInspiration(story.id, options()[0].text, ""),
  ).rejects.toThrow("参考内容已经变化");
});

it("never lets a superseded request replace a newer round or clear its request marker", async () => {
  let finishOld!: (r: Response) => void;
  const fetcher = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          finishOld = resolve;
        }),
    )
    .mockResolvedValueOnce(response({ options: options(2) }));
  vi.stubGlobal("fetch", fetcher);
  const old = requestInspiration(story.id);
  await vi.waitFor(() => expect(finishOld).toBeTypeOf("function"));
  await db.stories.update(story.id, { background: "新的开场条件" });
  expect(await requestInspiration(story.id)).toBe("saved");
  finishOld(response({ options: options() }));
  expect(await old).toBe("stale");
  expect((await db.stories.get(story.id))?.inspiration?.options).toEqual(
    options(2),
  );
  expect((await inspirationState(story.id))?.stale).toBe(false);
  expect(fetcher).toHaveBeenCalledTimes(2);
});
