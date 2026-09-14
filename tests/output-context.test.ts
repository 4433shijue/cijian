import "fake-indexeddb/auto";
import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { db, initialize, reviseEvent, sessionKeys } from "../src/db";
import { run, adoptDraft, isBusy } from "../src/engine";
import {
  parseJSON,
  draftText,
  checkQuotes,
  quotedDialogue,
} from "../src/output";
import { buildContext, proseCount } from "../src/context";
import { generate, requestSpec } from "../src/model";
import { exportBackup, importBackup, validateBackup } from "../src/backup";
import type {
  Profile,
  Preferences,
  SceneEvent,
  WorldEntry,
} from "../src/types";

const p: Profile = {
  id: "test-profile",
  name: "fixture",
  protocol: "chat",
  url: "https://format.fixture.test/v1",
  model: "fixture",
  stream: false,
  context: 32000,
  maxOutput: 2048,
  timeout: 10,
  remember: false,
};
const prefs: Preferences = {
  id: "preferences",
  activeProfile: p.id,
  developer: true,
  prompts: {},
};
const event = (
  storyId: string,
  seq: number,
  patch: Partial<SceneEvent> = {},
): SceneEvent => ({
  id: "prose-" + seq,
  storyId,
  seq,
  kind: "novel",
  speaker: "",
  participants: [],
  input: "递伞",
  text: `正文标记${seq}。`,
  facts: [],
  versionId: "version-" + seq,
  versions: [
    {
      id: "version-" + seq,
      text: `正文标记${seq}。`,
      input: "递伞",
      facts: [],
      created: seq,
    },
  ],
  status: "complete",
  raw: "",
  error: "",
  review: false,
  deleted: false,
  created: seq,
  ...patch,
});
const world = (id: string, patch: Partial<WorldEntry> = {}): WorldEntry => ({
  id,
  title: id,
  text: id + "设定",
  type: "world",
  enabled: true,
  always: true,
  keywords: [],
  roleIds: [],
  storyIds: [],
  knownBy: [],
  audience: "all",
  ...patch,
});
const response = (text: string, finish_reason = "stop", usage?: unknown) =>
  new Response(
    JSON.stringify({
      choices: [{ message: { content: text }, finish_reason }],
      usage,
    }),
    { headers: { "content-type": "application/json" } },
  );
beforeEach(async () => {
  await db.delete();
  await db.open();
  await initialize();
  await db.profiles.put(p);
  await db.preferences.put(prefs);
  sessionKeys.set(p.id, "isolated-fixture-key");
});
afterEach(() => vi.restoreAllMocks());
async function story() {
  const s = (await db.stories.toArray())[0];
  await db.stories.update(s.id, { autoMemory: false, timelineMode: "strict" });
  return { ...s, autoMemory: false, timelineMode: "strict" as const };
}

describe("recoverable model output", () => {
  it.each([
    '\uFEFF```JSON\n{"text":"他递伞。","facts":[]}\n```',
    '下面是正文。\n{"text":"括号 { 和转义引号 \\" 在句中。","facts":[]}\n以上。',
  ])("unwraps one complete JSON object without rewriting prose", (raw) => {
    expect(parseJSON(raw).text).toBeTruthy();
  });
  it("rejects ambiguous or truncated objects and preserves readable drafts", () => {
    expect(() => parseJSON('{"text":"一"}{"text":"二"}')).toThrow("多份");
    expect(() => parseJSON('{"text":"未完')).toThrow();
    expect(draftText('{"text":"先写一行。\\n第二行')).toBe(
      "先写一行。\n第二行",
    );
    expect(draftText("莫先生站在门边。\n他没有进屋。")).toBe(
      "莫先生站在门边。\n他没有进屋。",
    );
    expect(draftText('{"error":{"message":"bad"}}')).toBe("");
    expect(draftText('{"text":{"bad":true}}')).toBe("");
  });
  it("tolerates typographic ellipses and whitespace, while protecting negation and questions", () => {
    expect(() =>
      checkQuotes("他说“等等…… 我不走。”", "他开口说「等等…\n我不走。」"),
    ).not.toThrow();
    expect(() => checkQuotes("他说“我不走。”", "他说“我走。”")).toThrow(
      "我不走",
    );
    expect(() => checkQuotes("她问“你走吗？”", "她说“你走吗。”")).toThrow();
    expect(quotedDialogue("他露出“你别管我”的表情。")).toEqual([]);
    expect(quotedDialogue("他说“你别管我”的语气很轻。")).toEqual(["你别管我"]);
  });
});

describe("stable context with a rolling prose window", () => {
  it("keeps world/personas stable while advancing exactly seven chronological prose rounds", async () => {
    const s = await story();
    s.worldIds = ["static", "trigger"];
    const worlds = [
      world("trigger", { always: false, keywords: ["雨"] }),
      world("static"),
    ];
    const events = Array.from({ length: 9 }, (_, i) => event(s.id, i + 1));
    const first = buildContext(
      "novel",
      s,
      events.slice(0, 8).reverse(),
      [],
      worlds,
      prefs,
      p,
      "递伞",
    );
    const next = buildContext(
      "novel",
      s,
      events,
      [],
      worlds,
      prefs,
      p,
      "雨落下。",
    );
    expect(first.history?.sources.map((x) => x.id)).toEqual(
      [2, 3, 4, 5, 6, 7, 8].map((n) => "prose-" + n),
    );
    expect(next.history?.sources.map((x) => x.id)).toEqual(
      [3, 4, 5, 6, 7, 8, 9].map((n) => "prose-" + n),
    );
    expect(first.stablePrefix).toBe(next.stablePrefix);
    expect(next.user.startsWith(next.stablePrefix!)).toBe(true);
    expect(next.included[0].id).toBe("static");
    expect(next.stablePrefix).not.toContain("trigger设定");
    expect(next.user.indexOf("trigger设定")).toBeGreaterThan(
      next.user.indexOf(s.roles[0].bio),
    );
    expect(next.user.indexOf("正文标记3。")).toBeLessThan(
      next.user.indexOf("正文标记9。"),
    );
    expect(next.user).not.toContain("正文标记2。");
    expect(next.user.endsWith("本次没有识别到引用台词。")).toBe(true);
    const small = buildContext(
      "novel",
      s,
      [
        ...events,
        event(s.id, 10, { status: "draft" }),
        event(s.id, 11, { review: true }),
        event(s.id, 12, { deleted: true }),
      ],
      [],
      worlds,
      { ...prefs, novelContextRounds: 2, inspirationParagraphs: 10 },
      p,
      "递伞",
    );
    expect(small.history?.sources.map((x) => x.id)).toEqual([
      "prose-8",
      "prose-9",
    ]);
    expect(small.stablePrefix).toBe(first.stablePrefix);
    expect(proseCount(undefined)).toBe(7);
    expect(proseCount(0)).toBe(7);
  });
  it("fails before sending when the requested prose window cannot fit", async () => {
    const s = await story();
    expect(() =>
      buildContext(
        "novel",
        s,
        [event(s.id, 1, { text: "长".repeat(6000) })],
        [],
        [],
        prefs,
        { ...p, context: 4000 },
        "递伞",
      ),
    ).toThrow("正文参考回合数");
  });
  it("applies audience filters before constructing the cached chat prefix", async () => {
    const s = await story();
    s.background = "作者秘密";
    s.worldIds = ["private", "public"];
    const other = s.roles.find((r) => r.id !== s.partner)!;
    other.paragraphs = [
      { id: "secret", text: "他人秘密", pin: true, public: false },
    ];
    const r = buildContext(
      "chat",
      s,
      [event(s.id, 1, { text: "全知秘密" })],
      [],
      [world("private", { audience: "author" }), world("public")],
      prefs,
      p,
      "你好",
    );
    expect(r.stablePrefix).toContain("public设定");
    for (const text of ["作者秘密", "他人秘密", "全知秘密", "private设定"])
      expect(r.system + r.user).not.toContain(text);
  });
});

describe("native output formats and actual usage", () => {
  it("reads DeepSeek-style cache hit counters without treating cache misses as writes", async () => {
    const result = await generate(
      p,
      "k",
      "s",
      "u",
      new AbortController().signal,
      undefined,
      vi
        .fn()
        .mockResolvedValue(
          response("ok", "stop", {
            prompt_tokens: 100,
            completion_tokens: 10,
            prompt_cache_hit_tokens: 60,
            prompt_cache_miss_tokens: 40,
          }),
        ),
    );
    expect(result.usage).toEqual({ input: 100, output: 10, cachedInput: 60 });
  });
  it("keeps unknown compatible services free of unrequested schema fields", () => {
    expect(
      requestSpec(p, "k", "s", "u", { kind: "novel" }).body,
    ).not.toHaveProperty("response_format");
    expect(
      requestSpec({ ...p, outputMode: "json" }, "k", "s", "u", {
        kind: "novel",
      }).body.response_format,
    ).toEqual({ type: "json_object" });
    const b: any = requestSpec(
      { ...p, url: "https://api.openai.com/v1", model: "gpt-4o-mini" },
      "k",
      "s",
      "u",
      { kind: "novel" },
    ).body;
    expect(b.response_format.json_schema).toMatchObject({
      strict: true,
      schema: { required: ["text", "facts"] },
    });
    expect(
      requestSpec({ ...p, outputMode: "schema" }, "k", "s", "u").body,
    ).not.toHaveProperty("response_format");
  });
  it("uses protocol-specific schemas and puts explicit cache boundaries before dynamic content", () => {
    const options = { kind: "novel" as const, stablePrefix: "世界与人设\n\n" };
    const input = options.stablePrefix + "历史和当前任务";
    const claude: any = requestSpec(
      { ...p, protocol: "claude", outputMode: "schema" },
      "k",
      "固定规则",
      input,
      options,
    ).body;
    expect(claude.output_config.format.type).toBe("json_schema");
    expect(claude.messages[0].content[0]).toMatchObject({
      text: options.stablePrefix,
      cache_control: { type: "ephemeral" },
    });
    expect(claude.messages[0].content[1]).not.toHaveProperty("cache_control");
    const responses: any = requestSpec(
      {
        ...p,
        protocol: "responses",
        url: "https://api.openai.com/v1",
        model: "gpt-5.6",
      },
      "k",
      "固定规则",
      input,
      options,
    ).body;
    expect(responses.text.format.type).toBe("json_schema");
    expect(responses.prompt_cache_options).toEqual({ mode: "explicit" });
    expect(responses.input[0].content[0]).toHaveProperty(
      "prompt_cache_breakpoint",
    );
    const gemini: any = requestSpec(
      { ...p, protocol: "gemini", outputMode: "schema" },
      "k",
      "s",
      input,
      options,
    ).body;
    expect(gemini.generationConfig).toMatchObject({
      responseMimeType: "application/json",
      responseJsonSchema: { type: "object" },
    });
    const off: any = requestSpec(
      { ...p, protocol: "claude", cachePolicy: "off" },
      "k",
      "s",
      input,
      options,
    ).body;
    expect(off.messages[0].content).toBe(input);
  });
  it.each([
    [
      "chat",
      {
        choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
        usage: {
          prompt_tokens: 100,
          completion_tokens: 5,
          prompt_tokens_details: { cached_tokens: 70 },
        },
      },
    ],
    [
      "responses",
      {
        status: "completed",
        output: [{ content: [{ type: "output_text", text: "ok" }] }],
        usage: {
          input_tokens: 100,
          output_tokens: 5,
          input_tokens_details: { cached_tokens: 70 },
        },
      },
    ],
    [
      "claude",
      {
        content: [{ type: "text", text: "ok" }],
        stop_reason: "end_turn",
        usage: {
          input_tokens: 20,
          output_tokens: 5,
          cache_read_input_tokens: 70,
          cache_creation_input_tokens: 10,
        },
      },
    ],
    [
      "gemini",
      {
        candidates: [
          { content: { parts: [{ text: "ok" }] }, finishReason: "STOP" },
        ],
        usageMetadata: {
          promptTokenCount: 100,
          candidatesTokenCount: 5,
          cachedContentTokenCount: 70,
        },
      },
    ],
  ] as const)(
    "reads %s cache tokens without confusing Claude's uncached input with total input",
    async (protocol, data) => {
      const r = await generate(
        { ...p, protocol },
        "k",
        "s",
        "u",
        new AbortController().signal,
        undefined,
        vi.fn().mockResolvedValue(new Response(JSON.stringify(data))),
      );
      expect(r.usage).toMatchObject({ input: 100, output: 5, cachedInput: 70 });
      expect(r.durationMs).toBeGreaterThanOrEqual(0);
    },
  );
  it("preserves input and cache counters across Claude stream output updates", async () => {
    const packets = [
      {
        type: "message_start",
        message: {
          usage: {
            input_tokens: 20,
            cache_read_input_tokens: 70,
            cache_creation_input_tokens: 10,
          },
        },
      },
      {
        type: "content_block_delta",
        delta: { type: "text_delta", text: "ok" },
      },
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { output_tokens: 5 },
      },
    ];
    const r = await generate(
      { ...p, protocol: "claude", stream: true },
      "k",
      "s",
      "u",
      new AbortController().signal,
      undefined,
      vi
        .fn()
        .mockResolvedValue(
          new Response(
            packets.map((d) => "data: " + JSON.stringify(d) + "\n\n").join(""),
            { headers: { "content-type": "text/event-stream" } },
          ),
        ),
    );
    expect(r.usage).toEqual({
      input: 100,
      output: 5,
      cachedInput: 70,
      cacheWriteInput: 10,
    });
  });
  it("leaves missing cache stats unknown and never automatically retries a format rejection", async () => {
    const r = await generate(
      p,
      "k",
      "s",
      "u",
      new AbortController().signal,
      undefined,
      vi
        .fn()
        .mockResolvedValue(
          response("ok", "stop", { prompt_tokens: 10, completion_tokens: 2 }),
        ),
    );
    expect(r.usage?.cachedInput).toBeUndefined();
    const fetcher = vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ error: { message: "unsupported response_format" } }),
          { status: 400 },
        ),
      );
    await expect(
      generate(
        p,
        "k",
        "s",
        "u",
        new AbortController().signal,
        undefined,
        fetcher,
      ),
    ).rejects.toThrow("兼容模式");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

describe("author-confirmed adoption", () => {
  it("preserves prose returned outside the API JSON envelope for manual recovery", async () => {
    const s = await story();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("莫先生站在门边。"),
    );
    await expect(run(s.id, "novel", "递伞")).rejects.toThrow("响应格式");
    const draft = (await db.events.where("storyId").equals(s.id).toArray())[0];
    expect(draft).toMatchObject({
      status: "draft",
      raw: "莫先生站在门边。",
      text: "莫先生站在门边。",
    });
  });
  it("drains delayed stream writes before a failed generation can be adopted", async () => {
    const s = await story();
    await db.profiles.update(p.id, { stream: true });
    let release!: () => void, started!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const writing = new Promise<void>((resolve) => {
      started = resolve;
    });
    const update = db.events.update.bind(db.events);
    let first = true;
    vi.spyOn(db.events, "update").mockImplementation(
      async (id: any, changes: any) => {
        if (first && changes.raw) {
          first = false;
          started();
          await held;
        }
        return update(id, changes);
      },
    );
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        'data: {"choices":[{"delta":{"content":"先收到的半段。"}}]}\n\ndata: {"error":{"message":"stream failed"}}\n\n',
        { headers: { "content-type": "text/event-stream" } },
      ),
    );
    const task = run(s.id, "novel", "递伞");
    const failed = expect(task).rejects.toThrow("stream failed");
    await writing;
    expect(isBusy(s.id)).toBe(true);
    release();
    await failed;
    const draft = (await db.events.where("storyId").equals(s.id).toArray())[0];
    await adoptDraft(draft.id, "作者确认的正文。", draft.versionId, draft.raw);
    expect((await db.events.get(draft.id))?.text).toBe("作者确认的正文。");
  });
  it("excludes future prose and future memories from a rewrite request", async () => {
    const s = await story();
    const rows = Array.from({ length: 9 }, (_, i) => event(s.id, i + 1));
    await db.events.bulkAdd(rows);
    await db.memories.add({
      id: "future",
      storyId: s.id,
      text: "未来才知道的事",
      knownBy: [],
      scope: "story",
      sources: [{ id: rows[8].id, versionId: rows[8].versionId }],
      status: "accepted",
      created: 1,
    });
    const api = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(response('{"text":"他递出伞。","facts":[]}'));
    await run(s.id, "novel", "递伞", rows[2].id);
    const request = JSON.parse(api.mock.calls[0][1]?.body as string).messages[1]
      .content;
    expect(request).toContain("正文标记1。");
    expect(request).toContain("正文标记2。");
    for (const marker of ["正文标记3。", "正文标记9。", "未来才知道的事"])
      expect(request).not.toContain(marker);
    expect((await db.events.get(rows[2].id))?.versions).toHaveLength(2);
  });
  it("keeps invalid output as a draft until explicit adoption, then versions it without another API call", async () => {
    const s = await story();
    await db.stories.update(s.id, {
      draft: "他说“别走。”",
      inspiration: { options: [], sources: [], created: 1 },
    });
    const api = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(response("莫先生站在门边。"));
    await expect(run(s.id, "novel", "他说“别走。”")).rejects.toThrow("格式");
    const draft = (await db.events.where("storyId").equals(s.id).toArray())[0];
    expect(draft).toMatchObject({
      status: "draft",
      text: "莫先生站在门边。",
      versions: [],
    });
    expect(
      buildContext("novel", s, [draft], [], [], prefs, p, "下一刻").user,
    ).not.toContain("莫先生");
    await adoptDraft(
      draft.id,
      "莫先生说“先走吧。”",
      draft.versionId,
      draft.raw,
    );
    const accepted = (await db.events.get(draft.id))!;
    expect(accepted).toMatchObject({
      status: "complete",
      acceptedByAuthor: true,
      text: "莫先生说“先走吧。”",
      facts: [],
      raw: draft.raw,
    });
    expect(accepted.versions).toHaveLength(1);
    expect((await db.stories.get(s.id))?.draft).toBe("");
    expect((await db.stories.get(s.id))?.inspiration).toBeUndefined();
    expect(
      buildContext("novel", s, [accepted], [], [], prefs, p, "下一刻").user,
    ).toContain("莫先生说");
    expect(api).toHaveBeenCalledTimes(1);
    await expect(
      adoptDraft(draft.id, "重复采用", draft.versionId, draft.raw),
    ).rejects.toThrow("已改变");
  });
  it("preserves a new composer draft and invalidates dependent later events and memories", async () => {
    const s = await story();
    const draft = event(s.id, 1, {
      status: "draft",
      raw: "草稿",
      text: "草稿",
      versions: [],
    });
    await db.events.bulkAdd([draft, event(s.id, 2)]);
    await db.stories.update(s.id, { draft: "我后来输入的新想法" });
    await db.memories.add({
      id: "m",
      storyId: s.id,
      text: "后续记忆",
      knownBy: [],
      scope: "story",
      sources: [{ id: "prose-2", versionId: "version-2" }],
      status: "accepted",
      created: 1,
    });
    await adoptDraft(draft.id, "确认正文", draft.versionId, draft.raw);
    expect((await db.events.get("prose-2"))?.review).toBe(true);
    expect((await db.memories.get("m"))?.status).toBe("review");
    expect((await db.stories.get(s.id))?.draft).toBe("我后来输入的新想法");
  });
  it("adopts a failed rewrite into its original slot and keeps the previous version", async () => {
    const s = await story();
    const original = event(s.id, 1);
    await db.events.add(original);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      response("改写后的文字。"),
    );
    await expect(
      run(s.id, "novel", original.input, original.id),
    ).rejects.toThrow("格式");
    const draft = (
      await db.events
        .where("storyId")
        .equals(s.id)
        .filter((e) => e.status === "draft")
        .toArray()
    )[0];
    expect(draft.rewriteOf).toEqual({
      id: original.id,
      versionId: original.versionId,
    });
    await adoptDraft(draft.id, draft.text, draft.versionId, draft.raw);
    expect(await db.events.get(draft.id)).toBeUndefined();
    expect((await db.events.get(original.id))?.versions).toHaveLength(2);
    expect((await db.events.get(original.id))?.text).toBe("改写后的文字。");
  });
  it("refuses stale drafts, in-flight jobs, and rewrites whose original version has changed", async () => {
    const s = await story();
    const original = event(s.id, 1);
    const draft = event(s.id, 2, {
      status: "draft",
      raw: "candidate",
      versions: [],
      rewriteOf: { id: original.id, versionId: original.versionId },
    });
    await db.events.bulkAdd([original, draft]);
    await expect(
      adoptDraft(draft.id, "text", draft.versionId, "old raw"),
    ).rejects.toThrow("已更新");
    await db.jobs.add({
      id: "j",
      storyId: s.id,
      kind: "novel",
      eventId: draft.id,
      inputVersion: draft.versionId,
      status: "running",
      created: 1,
      error: "",
    });
    await expect(
      adoptDraft(draft.id, "text", draft.versionId, draft.raw),
    ).rejects.toThrow("等待");
    await db.jobs.update("j", { status: "failed" });
    await reviseEvent(original.id, "后来手动修改的原文");
    await expect(
      adoptDraft(draft.id, "覆盖", draft.versionId, draft.raw),
    ).rejects.toThrow("不会覆盖");
    expect((await db.events.get(original.id))?.text).toBe("后来手动修改的原文");
    expect((await db.events.get(draft.id))?.status).toBe("draft");
  });
  it("rolls adoption back if persistence fails", async () => {
    const s = await story();
    const draft = event(s.id, 1, {
      status: "draft",
      versions: [],
      raw: "草稿",
    });
    await db.events.add(draft);
    vi.spyOn(db.stories, "update").mockRejectedValueOnce(Error("disk failed"));
    await expect(
      adoptDraft(draft.id, "确认", draft.versionId, draft.raw),
    ).rejects.toThrow("disk failed");
    expect((await db.events.get(draft.id))?.status).toBe("draft");
    expect((await db.events.get(draft.id))?.versions).toHaveLength(0);
  });
  it("remaps draft rewrite links and preserves optional settings in backup copies", async () => {
    const s = await story();
    const original = event(s.id, 1, { acceptedByAuthor: true });
    await db.events.bulkAdd([
      original,
      event(s.id, 2, {
        status: "draft",
        versions: [],
        rewriteOf: { id: original.id, versionId: original.versionId },
      }),
    ]);
    await db.preferences.update("preferences", { novelContextRounds: 9 });
    await db.profiles.update(p.id, {
      outputMode: "schema",
      cachePolicy: "off",
    });
    const backup = validateBackup(await exportBackup());
    expect(backup.preferences[0].novelContextRounds).toBe(9);
    expect(backup.profiles.find((x) => x.id === p.id)).toMatchObject({
      outputMode: "schema",
      cachePolicy: "off",
    });
    await importBackup(backup, false);
    const copied = (await db.events.toArray()).find(
      (e) => e.storyId !== s.id && e.rewriteOf,
    )!;
    const target = (await db.events.get(copied.rewriteOf!.id))!;
    expect(target.storyId).toBe(copied.storyId);
    expect(target.acceptedByAuthor).toBe(true);
    expect(target.versionId).toBe(copied.rewriteOf!.versionId);
    validateBackup(await exportBackup());
  });
});
