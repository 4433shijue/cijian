import "fake-indexeddb/auto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { db, makeStory, reviseEvent, sessionKeys } from "../src/db";
import {
  buildTheaterContext,
  createTheaterAttempt,
  failTheaterAttempt,
  finishTheaterAttempt,
  generateTheater,
  pendingTheater,
  rebindTheaterAttempt,
  stopTheater,
  updateTheaterAttempt,
  validateTheaterHtml,
} from "../src/theater";
import { active as storyActive } from "../src/generation-state";
import { run, stop } from "../src/engine";
import { draftText } from "../src/output";
import {
  allTheaterPresets,
  builtInTheaterPresets,
  normalizeTheaterDensity,
  selectedTheaterPresets,
  theaterDensityInstruction,
  theaterInstruction,
} from "../src/theater-presets";
import { theaterText } from "../src/theater-text";
import type {
  Preferences,
  Profile,
  Role,
  SceneEvent,
  Story,
  WorldEntry,
} from "../src/types";

const prefs: Preferences = {
  id: "preferences",
  activeProfile: "theater-fixture",
  developer: false,
  prompts: {},
};
const profile: Profile = {
  id: prefs.activeProfile,
  name: "fixture",
  protocol: "chat",
  url: "https://theater.fixture.test/v1",
  model: "fixture",
  stream: false,
  context: 16000,
  maxOutput: 2048,
  timeout: 10,
  remember: false,
};
const role: Role = {
  id: "role-a",
  name: "阿岚",
  bio: "修伞的人",
  persona: "说话慢，习惯先看看天气。",
  paragraphs: [],
  avatar: "",
  updated: 1,
};
const world: WorldEntry = {
  id: "world-a",
  title: "雨城",
  text: "雨城每天午后会下雨。",
  type: "world",
  enabled: true,
  always: true,
  keywords: [],
  roleIds: [],
  storyIds: [],
  knownBy: [],
  audience: "all",
};
let story: Story;
const event = (
  id = "prose-a",
  patch: Partial<SceneEvent> = {},
): SceneEvent => ({
  id,
  storyId: story.id,
  seq: 1,
  kind: "novel",
  origin: "ai",
  speaker: "",
  participants: [role.id],
  input: "他把雨伞收好。",
  text: "阿岚把雨伞收好，水滴落在鞋尖。",
  facts: [],
  versions: [],
  versionId: "version-a",
  status: "complete",
  raw: "",
  error: "",
  review: false,
  deleted: false,
  created: 1,
  ...patch,
});
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
const html =
  "<section><h3>主角们的吐槽</h3><p>阿岚低头看了看鞋。今天的雨倒是准时。</p></section>";

beforeEach(async () => {
  await db.delete();
  await db.open();
  story = makeStory(
    "雨城番外",
    [role],
    [world.id],
    "开场的背景不应混入目标回合",
  );
  story.draft = "未来回合尚未写出的秘密";
  await db.stories.put(story);
  await db.world.put(world);
  await db.preferences.put(prefs);
  await db.profiles.put(profile);
  await db.events.put(event());
  sessionKeys.set(profile.id, "controlled-theater-fixture-key");
});
afterEach(async () => {
  vi.unstubAllGlobals();
  sessionKeys.clear();
  storyActive.clear();
  await db.delete();
});

it("keeps built-in order while overriding preset names and content, deduplicating selected IDs", () => {
  const changed = {
    ...prefs,
    theaterPresets: [
      { id: "theater-roast", name: "大家偷偷说", prompt: "只写轻松短句。" },
      { id: "custom-a", name: "雨伞旁白", prompt: "写雨伞眼中的这一幕。" },
    ],
  };
  expect(allTheaterPresets(changed)).toHaveLength(6);
  expect(allTheaterPresets(changed)[0].name).toBe("大家偷偷说");
  expect(
    selectedTheaterPresets(
      {
        ...story,
        theaterPresetIds: ["custom-a", "theater-roast", "custom-a", "missing"],
      },
      changed,
    ).map((p) => p.id),
  ).toEqual(["custom-a", "theater-roast"]);
  expect(
    selectedTheaterPresets({ ...story, theaterPresetIds: undefined }, prefs)[0]
      .id,
  ).toBe("theater-roast");
  expect(
    selectedTheaterPresets({ ...story, theaterPresetIds: [] }, prefs),
  ).toEqual([]);
  expect(builtInTheaterPresets[0].name).toBe("主角们的吐槽");
});

it("uses standard density by default and keeps density guidance separate from HTML protocol", () => {
  expect(story.theaterDensity).toBe("standard");
  expect(normalizeTheaterDensity(undefined)).toBe("standard");
  expect(normalizeTheaterDensity("invalid")).toBe("standard");
  expect(normalizeTheaterDensity("light")).toBe("light");
  expect(normalizeTheaterDensity("rich")).toBe("rich");
  expect(theaterDensityInstruction("light")).toContain("一个具体动作或台词");
  expect(theaterDensityInstruction("rich")).toContain(
    "关系位置、信息理解或情绪变化",
  );
  const instruction = theaterInstruction([
    builtInTheaterPresets[2],
    builtInTheaterPresets[0],
  ]);
  expect(instruction.indexOf("【话外之音】")).toBeLessThan(
    instruction.indexOf("【主角们的吐槽】"),
  );
  expect(instruction).toContain("本节写法要求");
  expect(instruction).toContain("不使用 Markdown 围栏");
});

it("extracts readable HTML text without code, resource URLs, hidden metadata, or entity artifacts", () => {
  const content =
    '<html><head><title>隐藏标题</title><style>body{color:red}</style></head><body><script>alert("secret")</script><div>阿岚&nbsp;&amp; 雨伞<br>第二行</div><p hidden>隐藏句子</p><template><p>模板内容</p></template><img src="https://private.test/pixel"><p>结尾 &lt;小字&gt;</p></body></html>';
  expect(theaterText(content)).toBe("阿岚 & 雨伞\n第二行\n\n结尾 <小字>");
  expect(theaterText("<div>不完整<span>也可提取")).toBe("不完整也可提取");
  expect(validateTheaterHtml(html)).toBe(html);
  for (const invalid of [
    undefined,
    " ",
    "普通文字",
    "<style>body{color:red}</style>",
    "<script>不应展示</script>",
  ])
    expect(() => validateTheaterHtml(invalid)).toThrow();
});

it("builds a read-only target-turn context with applicable world knowledge and no later prose, drafts, or memories", async () => {
  const otherWorld = [
    world,
    {
      ...world,
      id: "keyword",
      always: false,
      keywords: ["雨伞"],
      text: "雨伞的本回合规则",
    },
    {
      ...world,
      id: "future",
      always: false,
      keywords: ["秘密"],
      text: "不应触发的世界书",
    },
    { ...world, id: "disabled", enabled: false, text: "已停用世界书" },
    { ...world, id: "unbound", text: "未绑定的世界书" },
    {
      ...world,
      id: "private",
      audience: "author" as const,
      text: "只有作者知道的设定",
    },
  ];
  const target = event();
  const context = buildTheaterContext(
    {
      ...story,
      worldIds: ["world-a", "keyword", "future", "disabled", "private"],
    },
    target,
    otherWorld,
    prefs,
    profile,
  );
  expect(context.user).toContain(target.text);
  expect(context.user).toContain(role.persona);
  expect(context.user).toContain("雨伞的本回合规则");
  expect(context.user).toContain("可知范围 仅作者");
  for (const absent of [
    story.draft,
    story.background,
    "不应触发的世界书",
    "已停用世界书",
    "未绑定的世界书",
  ])
    expect(context.user).not.toContain(absent);
  expect(context.included.flatMap((m) => m.sources || [])).toEqual([
    { id: target.id, versionId: target.versionId },
  ]);
  expect(() =>
    buildTheaterContext(story, target, otherWorld, prefs, {
      ...profile,
      context: 400,
    }),
  ).toThrow();
  expect((await db.events.get(target.id))?.theater).toBeUndefined();
});

it("snapshots the selected density on each manual attempt", async () => {
  await db.stories.update(story.id, { theaterDensity: "rich" });
  const richContext = buildTheaterContext(
    { ...story, theaterDensity: "rich" },
    event(),
    [world],
    prefs,
    profile,
  );
  expect(richContext.user).toContain("小剧场丰富度：丰富");
  const rich = await createTheaterAttempt(
    event(),
    builtInTheaterPresets.slice(0, 1),
  );
  expect(rich.density).toBe("rich");
  await failTheaterAttempt(rich.id, "fixture");
  const compact = await createTheaterAttempt(
    event(),
    builtInTheaterPresets.slice(0, 1),
    "light",
  );
  expect(compact.density).toBe("light");
});

it("shares one request for concurrent manual clicks and keeps theater content out of prose and memories", async () => {
  const fetcher = vi.fn().mockResolvedValue(response({ theaterHtml: html }));
  vi.stubGlobal("fetch", fetcher);
  const first = generateTheater("prose-a");
  const second = generateTheater("prose-a");
  expect(first).toBe(second);
  expect(pendingTheater("prose-a")).toBe(first);
  expect(await first).toBe("saved");
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(pendingTheater("prose-a")).toBeUndefined();
  const saved = (await db.theaters.toArray())[0];
  expect(saved.status).toBe("complete");
  expect(saved.text).toContain("今天的雨倒是准时");
  expect((await db.events.get("prose-a"))?.text).toBe(event().text);
  expect(await db.events.count()).toBe(1);
  expect(await db.memories.count()).toBe(0);
  expect((await db.stories.get(story.id))?.draft).toBe(story.draft);
});

it("creates a fresh attempt for regeneration and preserves the last successful result after a malformed response", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(response({ theaterHtml: html }))
    .mockResolvedValueOnce(
      response({ theaterHtml: "<style>p{color:red}</style>" }),
    );
  vi.stubGlobal("fetch", fetcher);
  await generateTheater("prose-a");
  const success = (await db.events.get("prose-a"))!.theater!;
  await expect(generateTheater("prose-a")).rejects.toThrow("可阅读内容");
  const latest = (await db.events.get("prose-a"))!.theater!;
  expect(latest.id).not.toBe(success.id);
  expect(latest.previousId).toBe(success.id);
  expect(latest.status).toBe("failed");
  expect((await db.theaters.get(success.id))?.html).toBe(html);
  expect((await db.theaters.get(latest.id))?.raw).toContain("<style>");
});

it("retains partial streaming output after an incomplete model response", async () => {
  const raw = JSON.stringify({ theaterHtml: html }).slice(0, -5);
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(raw, "length")));
  await expect(generateTheater("prose-a")).rejects.toThrow("未完整结束");
  const saved = (await db.theaters.toArray())[0];
  expect(saved.status).toBe("failed");
  expect(saved.raw).toBe(raw);
  expect(saved.html).toContain("<section>");
  expect(saved.text).toContain("阿岚");
});

it("stops a manual request, preserves its attempt, and releases the story lock", async () => {
  const fetcher = vi.fn().mockImplementation(
    (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener(
          "abort",
          () => reject(new Error("aborted")),
          { once: true },
        );
      }),
  );
  vi.stubGlobal("fetch", fetcher);
  const work = generateTheater("prose-a");
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
  await stopTheater("prose-a");
  expect(await work).toBe("interrupted");
  expect((await db.theaters.toArray())[0].status).toBe("interrupted");
  expect(storyActive.has(story.id)).toBe(false);
});

it.each(["version", "role", "world"])(
  "rejects a late result after the %s changed without rewriting prose",
  async (change) => {
    let resolve!: (value: Response) => void;
    const fetcher = vi.fn().mockImplementation(
      () =>
        new Promise<Response>((done) => {
          resolve = done;
        }),
    );
    vi.stubGlobal("fetch", fetcher);
    const work = generateTheater("prose-a");
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    if (change === "version")
      await db.events.update("prose-a", {
        versionId: "version-b",
        text: "修改后的正文",
      });
    else if (change === "role")
      await db.stories.update(story.id, {
        roles: [{ ...role, persona: "人设已经修改" }],
      });
    else await db.world.update(world.id, { text: "世界规则已经修改" });
    resolve(response({ theaterHtml: html }));
    expect(await work).toBe("stale");
    expect((await db.theaters.toArray())[0].status).toBe("failed");
    expect((await db.events.get("prose-a"))?.text).toBe(
      change === "version" ? "修改后的正文" : event().text,
    );
  },
);

it("keeps the selected preset snapshot while it is edited during a request", async () => {
  let resolve!: (value: Response) => void;
  const fetcher = vi.fn().mockImplementation(
    () =>
      new Promise<Response>((done) => {
        resolve = done;
      }),
  );
  vi.stubGlobal("fetch", fetcher);
  const work = generateTheater("prose-a");
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
  await db.preferences.update("preferences", {
    theaterPresets: [{ id: "theater-roast", name: "改名", prompt: "改稿" }],
  });
  resolve(response({ theaterHtml: html }));
  expect(await work).toBe("saved");
  expect((await db.theaters.toArray())[0].presets[0].name).toBe("主角们的吐槽");
});

it("supports auto-generation helpers inside an existing transaction and refuses stale summary overwrites", async () => {
  const target = event();
  await db.transaction("rw", [db.stories, db.events, db.theaters], async () => {
    const record = await createTheaterAttempt(
      target,
      builtInTheaterPresets.slice(0, 1),
    );
    await updateTheaterAttempt(record.id, "raw", html);
    expect(await finishTheaterAttempt(record.id, target, html, "raw")).toBe(
      true,
    );
  });
  const old = await createTheaterAttempt(
    target,
    builtInTheaterPresets.slice(0, 1),
  );
  const newerEvent = { ...target, versionId: "version-b", text: "新版正文" };
  await db.events.put(newerEvent);
  const newer = await createTheaterAttempt(
    newerEvent,
    builtInTheaterPresets.slice(0, 1),
  );
  expect(newer.previousId).toBe(old.previousId);
  expect(await finishTheaterAttempt(old.id, target, html, "late")).toBe(false);
  expect((await db.events.get(target.id))?.theater?.id).toBe(newer.id);
  await failTheaterAttempt(newer.id, "fixture stopped", "interrupted");
});

it("rebinds automatic draft attempts to the accepted event while keeping interrupted output incomplete", async () => {
  const draft = event("draft-a", {
    status: "draft",
    text: "新版正文",
    versionId: "draft-version",
  });
  await db.events.put(draft);
  const record = await createTheaterAttempt(
    draft,
    builtInTheaterPresets.slice(0, 1),
  );
  await updateTheaterAttempt(record.id, "partial raw", html);
  await failTheaterAttempt(record.id, "interrupted", "interrupted");
  const final = event("prose-a", {
    text: draft.text,
    versionId: "accepted-version",
  });
  await db.events.put(final);
  expect(await rebindTheaterAttempt(record.id, final)).toBe(true);
  expect((await db.theaters.get(record.id))?.eventId).toBe(final.id);
  expect((await db.theaters.get(record.id))?.status).toBe("interrupted");
  expect((await db.events.get(final.id))?.theater?.sourceVersionId).toBe(
    final.versionId,
  );
});

it("keeps combined prose and theater as interrupted drafts when stopped during final storage", async () => {
  await db.stories.update(story.id, { theaterAuto: true, autoMemory: false });
  const raw = JSON.stringify({
    text: "阿岚把雨伞收好。",
    facts: [],
    theaterHtml: html,
  });
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(raw)));
  const onUpdate = (changes: Record<string, unknown>) => {
    // A stop can arrive after transport completed while the queued stream write
    // is still being saved. No late network behavior is needed for this race.
    if (changes.raw === raw) stop(story.id);
  };
  db.theaters.hook("updating", onUpdate);
  try {
    await expect(run(story.id, "novel", "他收好伞。")).rejects.toThrow("停止");
    const generated = (
      await db.events.where("storyId").equals(story.id).toArray()
    ).find((item) => item.id !== "prose-a")!;
    expect(generated.status).toBe("draft");
    const record = (await db.theaters.get(generated.theater!.id))!;
    expect(record.status).toBe("interrupted");
    expect(record.raw).toBe(raw);
    expect(record.html).toBe(html);
  } finally {
    db.theaters.hook("updating").unsubscribe(onUpdate);
  }
});

it("streams prose and a separate theater prefix from the same response without a follow-up request", async () => {
  await db.stories.update(story.id, { theaterAuto: true, autoMemory: false });
  await db.profiles.update(profile.id, { stream: true });
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value;
    },
  });
  const fetcher = vi.fn().mockResolvedValue(
    new Response(stream, {
      headers: { "content-type": "text/event-stream" },
    }),
  );
  vi.stubGlobal("fetch", fetcher);
  const work = run(story.id, "novel", "他收好伞。");
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
  const prefix =
    '{"text":"阿岚把雨伞收好。","facts":[],"theaterHtml":"<section><p>窗边';
  const tail = '还有一滴水。</p></section>"}';
  const send = (data: unknown) =>
    controller.enqueue(
      new TextEncoder().encode("data: " + JSON.stringify(data) + "\n\n"),
    );
  send({ choices: [{ delta: { content: prefix } }] });
  await vi.waitFor(async () =>
    expect((await db.theaters.toArray())[0]?.raw).toBe(prefix),
  );
  const live = (await db.theaters.toArray())[0];
  expect(live.status).toBe("running");
  expect(live.html).toBe("<section><p>窗边");
  const draft = (await db.events.get(live.eventId))!;
  expect(draft.text).toBe("阿岚把雨伞收好。");
  expect(draft.raw).not.toContain("窗边");
  send({ choices: [{ delta: { content: tail } }] });
  send({ choices: [{ delta: {}, finish_reason: "stop" }] });
  controller.close();
  await work;
  expect(fetcher).toHaveBeenCalledTimes(1);
  const complete = (await db.theaters.get(live.id))!;
  expect(complete.status).toBe("complete");
  expect(complete.raw).toBe(prefix + tail);
  expect(complete.html).toBe("<section><p>窗边还有一滴水。</p></section>");
  expect((await db.events.get(live.eventId))?.text).toBe(draft.text);
});

it("does not show a wrapped theater-first JSON prefix as prose while streaming", () => {
  const prefix = '```json\n{"theaterHtml":"<section>番外不可混入正文';
  expect(draftText(prefix)).toBe("");
  expect(draftText(prefix + '</section>","text":"正文尚未写完')).toBe(
    "正文尚未写完",
  );
});

it("preserves the last successful theater after a prose edit and failed regeneration", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(response({ theaterHtml: html }))
    .mockResolvedValueOnce(
      response({ theaterHtml: "<style>p{color:red}</style>" }),
    );
  vi.stubGlobal("fetch", fetcher);
  await generateTheater("prose-a");
  const previous = (await db.events.get("prose-a"))!.theater!;
  await reviseEvent("prose-a", "阿岚把伞挂在门后。", false, [], "version-a");
  const edited = (await db.events.get("prose-a"))!;
  await expect(generateTheater("prose-a")).rejects.toThrow("可阅读内容");
  const current = (await db.events.get("prose-a"))!;
  expect(current.text).toBe(edited.text);
  expect(current.theater?.sourceVersionId).toBe(edited.versionId);
  expect(current.theater?.status).toBe("failed");
  expect(current.theater?.previousId).toBe(previous.id);
  const saved = (await db.theaters.get(previous.id))!;
  expect(saved.status).toBe("complete");
  expect(saved.sourceVersionId).toBe("version-a");
  expect(saved.html).toBe(html);
});
