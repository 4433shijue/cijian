import "fake-indexeddb/auto";
import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { db, initialize, makeStory, reviseEvent, sessionKeys } from "../src/db";
import {
  uid,
  type Profile,
  type SceneEvent,
  type Story,
  type Preferences,
} from "../src/types";
import { assemble, buildContext } from "../src/context";
import { endpoint, generate, requestSpec } from "../src/model";
import { exportBackup, importBackup, validateBackup } from "../src/backup";
import { memoryDue, checkQuotes, run, organizeMemory } from "../src/engine";
import { allStylePresets } from "../src/style-presets";
const profile: Profile = {
  id: "p",
  name: "test",
  protocol: "chat",
  url: "https://service.test/v1",
  model: "test",
  stream: true,
  context: 16000,
  maxOutput: 2048,
  timeout: 10,
  remember: false,
};
const prefs: Preferences = {
  id: "preferences",
  activeProfile: "p",
  developer: false,
  prompts: {},
};
beforeEach(async () => {
  await db.delete();
  await db.open();
  await initialize();
});
async function fixture() {
  const s = (await db.stories.toArray())[0];
  const e: SceneEvent = {
    id: uid(),
    storyId: s.id,
    seq: 1,
    kind: "novel",
    speaker: "",
    participants: s.roles.map((r) => r.id),
    input: "他递伞。",
    text: "他递伞。心里藏着PRIVATE_MIND。",
    facts: [
      { id: uid(), text: "他递伞。", quote: "他递伞。", knownBy: [s.partner] },
    ],
    versions: [],
    versionId: uid(),
    status: "complete",
    raw: "",
    error: "",
    review: false,
    deleted: false,
    created: Date.now(),
  };
  e.versions = [
    {
      id: e.versionId,
      text: e.text,
      input: e.input,
      facts: e.facts,
      created: Date.now(),
    },
  ];
  await db.events.add(e);
  return { s, e };
}
describe("knowledge and context", () => {
  it("never sends narrator secrets, partner private persona or unrelated private chats", async () => {
    const { s, e } = await fixture();
    s.roles[0].persona = "PARTNER_SECRET";
    s.roles[0].paragraphs = [
      { id: "secret", text: "PARTNER_SECRET", pin: true, public: false },
    ];
    s.background = "AUTHOR_BACKGROUND";
    const privateEvent = {
      ...e,
      id: uid(),
      kind: "message" as const,
      text: "OTHER_PRIVATE_CHAT",
      participants: [s.player, "third"],
    };
    const r = buildContext(
      "chat",
      s,
      [e, privateEvent],
      [],
      [],
      prefs,
      profile,
      "伞在哪里",
    );
    expect(r.user).toContain("他递伞。");
    for (const secret of [
      "PRIVATE_MIND",
      "PARTNER_SECRET",
      "OTHER_PRIVATE_CHAT",
      "AUTHOR_BACKGROUND",
    ])
      expect(r.user).not.toContain(secret);
  });
  it("blocks mandatory overflow without sending and reports omitted paragraphs", () => {
    expect(() =>
      assemble(
        "rules",
        "input",
        [
          {
            id: "1",
            label: "pin",
            text: "必".repeat(10000),
            mandatory: true,
            priority: 1,
          },
        ],
        2000,
        1000,
      ),
    ).toThrow("没有发送");
    const r = assemble(
      "rules",
      "input",
      [
        {
          id: "1",
          label: "long",
          text: "长".repeat(10000),
          mandatory: false,
          priority: 1,
        },
      ],
      2000,
      1000,
    );
    expect(r.omitted).toHaveLength(1);
  });
  it("keeps custom prose but fixed guards even when developer UI is hidden", async () => {
    const { s } = await fixture();
    const r = buildContext(
      "novel",
      s,
      [],
      [],
      [],
      { ...prefs, prompts: { novel: { text: "自定义白描", enabled: true } } },
      profile,
      "递伞",
    );
    expect(r.system).toContain("自定义白描");
    expect(r.system).toContain("不续写");
  });
  it("adds the selected style preset to prose and chat tasks", async () => {
    const { s } = await fixture();
    const custom = {
      id: "custom-style",
      name: "冷静短句",
      description: "",
      prompt: "多用短句，少解释情绪。",
      scope: "both" as const,
    };
    const preferences = { ...prefs, stylePresets: [custom] };
    s.stylePresetId = custom.id;
    s.style = custom.name;
    const prose = buildContext(
      "novel",
      s,
      [],
      [],
      [],
      preferences,
      profile,
      "递伞",
    );
    const chat = buildContext(
      "chat",
      s,
      [],
      [],
      [],
      preferences,
      profile,
      "伞呢",
    );
    expect(prose.user).toContain("多用短句，少解释情绪。");
    expect(chat.user).toContain("多用短句，少解释情绪。");
    expect(allStylePresets(preferences).map((preset) => preset.id)).toContain(
      custom.id,
    );
    expect(
      buildContext(
        "novel",
        s,
        [],
        [],
        [],
        preferences,
        profile,
        "递伞",
        { styleOnly: true },
      ).user,
    ).toContain("这是只换文风重写");
  });
  it("does not use unaccepted or review memories", async () => {
    const { s } = await fixture();
    const ms = ["candidate", "review", "invalid"].map((status) => ({
      id: uid(),
      storyId: s.id,
      text: "SHOULD_NOT_SEND",
      knownBy: [s.partner],
      scope: "story" as const,
      sources: [],
      status: status as any,
      created: 1,
    }));
    expect(
      buildContext("chat", s, [], ms, [], prefs, profile, "hi").user,
    ).not.toContain("SHOULD_NOT_SEND");
  });
  it("preserves explicit dialogue", () => {
    expect(() => checkQuotes("他说“拿着”。", "他说“拿走吧”。")).toThrow("台词");
    expect(() => checkQuotes("他说“拿着”。", "他低声说“拿着”。")).not.toThrow();
  });
});
describe("history and backup", () => {
  it("preserves sampling preferences and model defaults across backup import", async () => {
    await db.profiles.bulkAdd([
      { ...profile, temperature: 0, frequencyPenalty: 1.5 },
      { ...profile, id: "model-defaults", frequencyPenalty: null },
      { ...profile, id: "legacy" },
    ]);
    const backup = await exportBackup();
    await importBackup(backup, true);
    const restored = await db.profiles.toArray();
    expect(restored).toHaveLength(3);
    expect(restored.find((p) => p.temperature === 0)).toMatchObject({
      temperature: 0,
      frequencyPenalty: 1.5,
    });
    const defaults = restored.find((p) => p.frequencyPenalty === null)!;
    expect(requestSpec(defaults, "k", "s", "u").body).not.toHaveProperty(
      "frequency_penalty",
    );
    expect(requestSpec(defaults, "k", "s", "u").body).not.toHaveProperty(
      "temperature",
    );
    const legacy = restored.find((p) => p.frequencyPenalty === undefined)!;
    expect(requestSpec(legacy, "k", "s", "u").body.frequency_penalty).toBe(2);
  });
  it("rejects invalid sampling in backups before replacing any data", async () => {
    const backup = await exportBackup();
    for (const invalid of [
      { ...profile, temperature: -0.1 },
      { ...profile, protocol: "claude", temperature: 1.1 },
      { ...profile, protocol: "gemini", frequencyPenalty: 2 },
    ]) {
      await expect(
        importBackup({ ...backup, profiles: [invalid] }, true),
      ).rejects.toThrow();
    }
    expect((await exportBackup()).stories).toEqual(backup.stories);
  });
  it("retains future versions and invalidates source memory", async () => {
    const { s, e } = await fixture();
    await db.events.add({ ...e, id: uid(), seq: 2 });
    await db.memories.add({
      id: "m",
      storyId: s.id,
      text: "记忆",
      knownBy: [],
      scope: "story",
      sources: [{ id: e.id, versionId: e.versionId }],
      status: "accepted",
      created: 1,
    });
    await reviseEvent(e.id, "新的一刻");
    expect((await db.events.get(e.id))?.versions).toHaveLength(2);
    expect(
      (await db.events.where("storyId").equals(s.id).toArray()).find(
        (x) => x.seq === 2,
      )?.review,
    ).toBe(true);
    expect((await db.memories.get("m"))?.status).toBe("review");
  });
  it("round trips IDs, avatars, versions and excludes keys", async () => {
    const { s, e } = await fixture();
    await db.profiles.add({ ...profile, key: "SECRETKEY", remember: true });
    await db.memories.add({
      id: "m",
      storyId: s.id,
      text: "记忆",
      knownBy: [s.partner],
      scope: "story",
      sources: [{ id: e.id, versionId: e.versionId }],
      status: "accepted",
      created: 1,
    });
    const b = await exportBackup();
    expect(JSON.stringify(b)).not.toContain("SECRETKEY");
    await importBackup(b);
    expect(await db.stories.count()).toBe(2);
    const copied = (await db.memories.toArray()).find((m) => m.id !== "m")!;
    expect(copied.storyId).not.toBe(s.id);
    const source = await db.events.get(copied.sources[0].id);
    expect(source?.storyId).toBe(copied.storyId);
    expect(source?.versionId).toBe(copied.sources[0].versionId);
  });
  it("rejects damaged backups without touching records", async () => {
    const before = await exportBackup();
    expect(() => validateBackup({ ...before, version: 99 })).toThrow();
    await expect(
      importBackup({ ...before, stories: [{}] }, true),
    ).rejects.toThrow();
    expect(await exportBackup()).toMatchObject({
      roles: before.roles,
      stories: before.stories,
    });
  });
  it("rolls back all import writes on a simulated quota failure", async () => {
    const backup = await exportBackup();
    const original = db.events.bulkAdd;
    db.events.bulkAdd = vi
      .fn()
      .mockRejectedValue(new DOMException("full", "QuotaExceededError")) as any;
    await expect(importBackup(backup, true)).rejects.toThrow();
    db.events.bulkAdd = original;
    expect(await db.roles.count()).toBe(backup.roles.length);
    expect((await db.stories.toArray())[0].id).toBe(backup.stories[0].id);
  });
  it("counts each bubble and only completed novels after cursor", async () => {
    const { s, e } = await fixture();
    s.novelThreshold = 0;
    s.chatThreshold = 2;
    await db.events.add({ ...e, id: uid(), seq: 2, kind: "message" });
    expect(await memoryDue(s)).toBe(false);
    await db.events.add({ ...e, id: uid(), seq: 3, kind: "message" });
    expect(await memoryDue(s)).toBe(true);
    s.memoryCursor = 3;
    expect(await memoryDue(s)).toBe(false);
  });
});
describe("protocol contracts", () => {
  it.each([
    ["chat", 2],
    ["gemini", 1.99],
    ["responses", undefined],
    ["claude", undefined],
  ] as const)(
    "applies the maximum supported repetition penalty to old %s profiles",
    (protocol, penalty) => {
      const body = requestSpec({ ...profile, protocol }, "k", "s", "u").body;
      const config = (
        protocol === "gemini" ? body.generationConfig : body
      ) as Record<string, unknown>;
      if (penalty === undefined) {
        expect(config).not.toHaveProperty("frequency_penalty");
      } else {
        expect(
          config[
            protocol === "gemini" ? "frequencyPenalty" : "frequency_penalty"
          ],
        ).toBe(penalty);
      }
      expect(config).not.toHaveProperty("temperature");
      expect(body).not.toHaveProperty("repetition_penalty");
      expect(body).not.toHaveProperty("presence_penalty");
    },
  );
  it.each(["chat", "responses", "claude", "gemini"] as const)(
    "sends chosen temperatures including zero and allows model defaults for %s",
    (protocol) => {
      for (const temperature of [0, 0.75]) {
        const body = requestSpec(
          { ...profile, protocol, temperature, frequencyPenalty: null },
          "k",
          "s",
          "u",
        ).body;
        const config = (
          protocol === "gemini" ? body.generationConfig : body
        ) as Record<string, unknown>;
        expect(config.temperature).toBe(temperature);
        expect(config).not.toHaveProperty("frequency_penalty");
        expect(config).not.toHaveProperty("frequencyPenalty");
      }
    },
  );
  it("uses custom repetition values and rejects invalid sampling before a request", async () => {
    expect(
      requestSpec({ ...profile, frequencyPenalty: 0 }, "k", "s", "u").body
        .frequency_penalty,
    ).toBe(0);
    expect(
      requestSpec(
        { ...profile, protocol: "gemini", frequencyPenalty: 1.25 },
        "k",
        "s",
        "u",
      ).body.generationConfig,
    ).toMatchObject({ frequencyPenalty: 1.25 });
    const fetcher = vi.fn();
    for (const patch of [
      { temperature: -0.01 },
      { temperature: 2.01 },
      { temperature: NaN },
      { protocol: "claude" as const, temperature: 1.01 },
      { frequencyPenalty: Infinity },
      { frequencyPenalty: -1 },
      { protocol: "gemini" as const, frequencyPenalty: 2 },
    ]) {
      await expect(
        generate(
          { ...profile, ...patch },
          "k",
          "s",
          "u",
          new AbortController().signal,
          undefined,
          fetcher,
        ),
      ).rejects.toThrow(/温度|重复惩罚/);
    }
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each(["temperature", "frequency_penalty"])(
    "explains rejected %s without retrying",
    async (parameter) => {
      const fetcher = vi
        .fn()
        .mockResolvedValue(
          new Response(
            JSON.stringify({
              error: { message: `Unsupported parameter: ${parameter}` },
            }),
            { status: 400 },
          ),
        );
      await expect(
        generate(
          profile,
          "k",
          "s",
          "u",
          new AbortController().signal,
          undefined,
          fetcher,
        ),
      ).rejects.toThrow(/API 设置.*清空/);
      expect(fetcher).toHaveBeenCalledTimes(1);
    },
  );
  it.each(["chat", "responses", "claude", "gemini"] as const)(
    "normalizes %s full endpoint without duplicate paths",
    (protocol) => {
      const p = { ...profile, protocol };
      const full = endpoint(p);
      expect(endpoint({ ...p, url: full })).toBe(full);
      expect(full).not.toContain("/v1/v1");
    },
  );
  const cases = [
    {
      protocol: "chat",
      body: {
        choices: [{ message: { content: "你好" }, finish_reason: "stop" }],
      },
      events: [
        { choices: [{ delta: { content: "你" } }] },
        { choices: [{ delta: { content: "好" }, finish_reason: "stop" }] },
      ],
    },
    {
      protocol: "responses",
      body: {
        status: "completed",
        output: [{ content: [{ type: "output_text", text: "你好" }] }],
      },
      events: [
        { type: "response.output_text.delta", delta: "你好" },
        { type: "response.completed" },
      ],
    },
    {
      protocol: "claude",
      body: {
        content: [{ type: "text", text: "你好" }],
        stop_reason: "end_turn",
      },
      events: [
        {
          type: "content_block_delta",
          delta: { type: "text_delta", text: "你好" },
        },
        { type: "message_delta", delta: { stop_reason: "end_turn" } },
      ],
    },
    {
      protocol: "gemini",
      body: {
        candidates: [
          { content: { parts: [{ text: "你好" }] }, finishReason: "STOP" },
        ],
      },
      events: [
        {
          candidates: [
            { content: { parts: [{ text: "你好" }] }, finishReason: "STOP" },
          ],
        },
      ],
    },
  ] as const;
  for (const c of cases) {
    it(c.protocol + " nonstream parses completion", async () => {
      const f = vi.fn().mockResolvedValue(
        new Response(JSON.stringify(c.body), {
          headers: { "content-type": "application/json" },
        }),
      );
      const r = await generate(
        { ...profile, protocol: c.protocol, stream: false },
        "k",
        "s",
        "u",
        new AbortController().signal,
        () => {},
        f,
      );
      expect(r.text).toBe("你好");
      expect(r.complete).toBe(true);
    });
    it(
      c.protocol + " splits SSE on every byte including Chinese characters",
      async () => {
        const bytes = new TextEncoder().encode(
          c.events
            .map((e) => "data: " + JSON.stringify(e) + "\r\n\r\n")
            .join(""),
        );
        const stream = new ReadableStream({
          start(ctrl) {
            for (const b of bytes) ctrl.enqueue(new Uint8Array([b]));
            ctrl.close();
          },
        });
        const f = vi.fn().mockResolvedValue(
          new Response(stream, {
            headers: { "content-type": "text/event-stream" },
          }),
        );
        const r = await generate(
          { ...profile, protocol: c.protocol },
          "k",
          "s",
          "u",
          new AbortController().signal,
          () => {},
          f,
        );
        expect(r.text).toBe("你好");
        expect(r.complete).toBe(true);
      },
    );
  }
  it.each([401, 429, 500])("reports HTTP %s", async (status) => {
    await expect(
      generate(
        profile,
        "k",
        "s",
        "u",
        new AbortController().signal,
        () => {},
        vi.fn().mockResolvedValue(
          new Response(JSON.stringify({ error: { message: "failure" } }), {
            status,
          }),
        ),
      ),
    ).rejects.toThrow(String(status));
  });
  it("does not accept a stream ending without finish marker", async () => {
    const f = vi
      .fn()
      .mockResolvedValue(
        new Response(
          'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n',
          { headers: { "content-type": "text/event-stream" } },
        ),
      );
    expect(
      (
        await generate(
          profile,
          "k",
          "s",
          "u",
          new AbortController().signal,
          () => {},
          f,
        )
      ).complete,
    ).toBe(false);
  });
  it("times out and cancels without retries", async () => {
    const f = vi.fn(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          (init?.signal as AbortSignal).addEventListener("abort", () =>
            reject(new DOMException("abort", "AbortError")),
          );
        }),
    );
    await expect(
      generate(
        { ...profile, timeout: 0.01 },
        "k",
        "s",
        "u",
        new AbortController().signal,
        () => {},
        f as typeof fetch,
      ),
    ).rejects.toThrow("超时");
    expect(f).toHaveBeenCalledTimes(1);
  });
});

afterEach(() => vi.unstubAllGlobals());
describe("generation ownership and drafts", () => {
  async function configured() {
    const s = (await db.stories.toArray())[0];
    await db.profiles.put(profile);
    await db.preferences.put(prefs);
    sessionKeys.set("p", "fixture");
    return s;
  }
  const response = (content: string) =>
    new Response(
      JSON.stringify({
        choices: [{ message: { content }, finish_reason: "stop" }],
      }),
      { headers: { "content-type": "application/json" } },
    );
  it("keeps malformed output as a draft instead of a canonical event", async () => {
    const s = await configured();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response('{"text":')));
    await expect(run(s.id, "novel", "递伞。")).rejects.toThrow();
    const events = await db.events.where("storyId").equals(s.id).toArray();
    expect(events).toHaveLength(1);
    expect(events[0].status).toBe("draft");
    expect(events[0].raw).toBe('{"text":');
  });
  it("does not erase input typed during generation and disallows concurrent story jobs", async () => {
    const s = await configured();
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
    const task = run(s.id, "novel", "递伞。");
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    await expect(run(s.id, "novel", "第二段")).rejects.toThrow("正在生成");
    await db.stories.update(s.id, { draft: "下一段新输入" });
    finish(response(JSON.stringify({ text: "他把伞递到门边。" })));
    await task;
    expect((await db.stories.get(s.id))?.draft).toBe("下一段新输入");
  });
  it("rejects an old response when the original version changes", async () => {
    const s = await configured();
    const { e } = await fixture();
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
    const task = run(s.id, "novel", e.input, e.id);
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    await reviseEvent(e.id, "作者的新版本");
    finish(response(JSON.stringify({ text: "模型的旧版本" })));
    await expect(task).rejects.toThrow("原文");
    expect((await db.events.get(e.id))?.text).toBe("作者的新版本");
    expect(
      await db.events
        .where("storyId")
        .equals(s.id)
        .filter((e) => e.status === "draft")
        .count(),
    ).toBe(1);
  });
  it("marks style-only rewrites without changing the source input", async () => {
    await configured();
    const { s, e } = await fixture();
    let requestBody: any;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url, init) => {
        requestBody = JSON.parse(String(init?.body));
        return response(JSON.stringify({ text: "换一种表达。", facts: [] }));
      }),
    );
    await run(s.id, "novel", e.input, e.id, { styleOnly: true });
    expect(requestBody.messages[1].content).toContain("这是只换文风重写");
    expect((await db.events.get(e.id))?.versions.at(-1)?.input).toBe(e.input);
  });
});

it("persists a long persona intact and keeps story snapshots isolated", async () => {
  const role = (await db.roles.toArray())[0];
  const raw = "一段很长但完整保留的人设。".repeat(10000) + "末尾不可丢失";
  await db.roles.update(role.id, { persona: raw });
  expect((await db.roles.get(role.id))?.persona).toBe(raw);
  const story = (await db.stories.toArray())[0];
  expect(story.roles.find((r) => r.id === role.id)?.persona).not.toBe(raw);
});
it("filters worldbook keywords and whole character combinations", async () => {
  const s = (await db.stories.toArray())[0];
  const w = (await db.world.toArray())[0];
  w.always = false;
  w.keywords = ["伞", ""];
  w.text = "KEYWORD_FACT";
  expect(
    buildContext("chat", s, [], [], [w], prefs, profile, "你好").user,
  ).not.toContain("KEYWORD_FACT");
  expect(
    buildContext("chat", s, [], [], [w], prefs, profile, "伞呢").user,
  ).toContain("KEYWORD_FACT");
  w.roleIds = [s.player, "not-present"];
  w.match = "all";
  expect(
    buildContext("chat", s, [], [], [w], prefs, profile, "伞呢").user,
  ).not.toContain("KEYWORD_FACT");
});

it("memory progress prevents duplicate calls and never auto-accepts candidates", async () => {
  const { s, e } = await fixture();
  await db.profiles.put(profile);
  await db.preferences.put(prefs);
  sessionKeys.set("p", "fixture");
  const fetcher = vi
    .fn()
    .mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  memories: [
                    {
                      text: "他递了伞。",
                      sourceIds: [e.id],
                      knownBy: [],
                      scope: "story",
                    },
                  ],
                }),
              },
              finish_reason: "stop",
            },
          ],
        }),
        { headers: { "content-type": "application/json" } },
      ),
    );
  vi.stubGlobal("fetch", fetcher);
  await organizeMemory(s.id);
  await organizeMemory(s.id);
  await initialize();
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect((await db.memories.toArray())[0].status).toBe("candidate");
  expect((await db.stories.get(s.id))?.memoryCursor).toBe(1);
});
