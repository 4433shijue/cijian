import "fake-indexeddb/auto";
import Dexie from "dexie";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  db,
  initialize,
  reviseEvent,
  sessionKeys,
  deleteStory,
  SceneDB,
} from "../src/db";
import { preview, run } from "../src/engine";
import { sendChatMessage, replyChat } from "../src/chat";
import { exportBackup, validateBackup, importBackup } from "../src/backup";
import { active } from "../src/generation-state";
import { cacheHitPercent, prefixEnabled } from "../src/prefix-cache";
import { generate, requestSpec } from "../src/model";
import type { Profile, Story } from "../src/types";

let story: Story;
const profile: Profile = {
  id: "ds",
  name: "缓存测试",
  protocol: "chat",
  model: "deepseek-chat",
  url: "https://fixture.test/v1",
  stream: false,
  context: 16000,
  maxOutput: 2048,
  timeout: 10,
  remember: false,
};

it("upgrades an existing version 3 database without losing stories or stored profiles", async () => {
  const name = "upgrade-cache-fixture";
  const old = new Dexie(name);
  old
    .version(3)
    .stores({
      roles: "id",
      stories: "id,updated",
      world: "id",
      events: "id,storyId,[storyId+seq]",
      memories: "id,storyId,status",
      profiles: "id",
      preferences: "id",
      jobs: "id,storyId,status",
      roleDrafts: "id",
      chatBatches: "id,storyId,status",
    });
  await old.table("stories").put(story);
  await old.table("profiles").put(profile);
  old.close();
  const upgraded = new SceneDB(name);
  try {
    await upgraded.open();
    expect(await upgraded.stories.get(story.id)).toEqual(story);
    expect(await upgraded.profiles.get(profile.id)).toEqual(profile);
    expect(await upgraded.promptSessions.count()).toBe(0);
  } finally {
    await upgraded.delete();
  }
});
const response = (content: string, usage?: unknown, finish_reason = "stop") =>
  new Response(
    JSON.stringify({
      choices: [{ message: { content }, finish_reason }],
      usage,
    }),
    { headers: { "content-type": "application/json" } },
  );
const raw = (n: number) =>
  ` {"text": "正文第${n}段，他在窗边放下杯子。", "facts": []} `;
const rows = () => db.events.where("storyId").equals(story.id).sortBy("seq");
const send = (text: string) =>
  sendChatMessage(story.id, story.player, story.partner, text);
const body = (fetcher: ReturnType<typeof vi.fn>, index: number) =>
  JSON.parse(fetcher.mock.calls[index][1].body);
function mockNovel() {
  let n = 0;
  const fetcher = vi.fn().mockImplementation(() => response(raw(++n)));
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}

beforeEach(async () => {
  await db.delete();
  await db.open();
  await initialize();
  story = (await db.stories.toArray())[0];
  await db.profiles.put(profile);
  await db.preferences.update("preferences", {
    activeProfile: profile.id,
    novelContextRounds: 2,
  });
  sessionKeys.set(profile.id, "fixture-key");
});
afterEach(() => {
  vi.unstubAllGlobals();
  active.clear();
  sessionKeys.clear();
});

it("preserves exact input and raw assistant bytes through rolling windows and a database reopen", async () => {
  const fetcher = mockNovel();
  for (let n = 1; n <= 6; n++) {
    if (n === 4) {
      db.close();
      await db.open();
    }
    const report = await preview(story.id, "novel", "输入第" + n);
    await run(story.id, "novel", "输入第" + n);
    expect(body(fetcher, n - 1).messages).toEqual(report.messages);
    if (n > 1) {
      const messages = body(fetcher, n - 1).messages;
      expect(messages.slice(0, -1)).toEqual([
        ...body(fetcher, n - 2).messages,
        { role: "assistant", content: raw(n - 1) },
      ]);
      expect(report.prefixReuse?.state).toBe("continued");
      expect(messages.at(-1).content).not.toContain("早期经历");
      expect(messages.at(-1).content).not.toContain("正文第");
    }
  }
  expect(fetcher).toHaveBeenCalledTimes(6); // no warming or summary calls
  expect(await db.promptSessions.count()).toBe(1);
});

it.each(["edit", "delete", "privacy", "facts"])(
  "discards retained history after a %s change",
  async (change) => {
    const fetcher = mockNovel();
    await run(story.id, "novel", "旧输入");
    const first = (await rows())[0];
    if (change === "edit") await reviseEvent(first.id, "修改后的正文");
    if (change === "delete") await reviseEvent(first.id, first.text, true);
    if (change === "privacy")
      await reviseEvent(
        first.id,
        first.text,
        false,
        [],
        first.versionId,
        "author",
      );
    if (change === "facts")
      await reviseEvent(first.id, first.text, false, [
        { id: "fact", text: "窗边", quote: "窗边", knownBy: [story.partner] },
      ]);
    await run(story.id, "novel", "新输入");
    expect(body(fetcher, 1).messages).toHaveLength(2);
    expect((await rows()).at(-1)?.request?.prefixReuse?.state).toBe("history");
    if (change === "edit") {
      expect(body(fetcher, 1).messages[1].content).toContain("修改后的正文");
      expect(body(fetcher, 1).messages[1].content).not.toContain(first.text);
    }
  },
);

it.each(["model", "style", "prompt", "world", "mode", "window"])(
  "rebuilds when %s configuration changes",
  async (change) => {
    const fetcher = mockNovel();
    await run(story.id, "novel", "第一轮");
    if (change === "model")
      await db.profiles.update(profile.id, { model: "deepseek-reasoner" });
    if (change === "style")
      await db.stories.update(story.id, { psychology: true });
    if (change === "prompt")
      await db.preferences.update("preferences", {
        prompts: { novel: { text: "短句为主", enabled: true } },
      });
    if (change === "world")
      await db.world.update(story.worldIds[0], { enabled: false });
    if (change === "mode")
      await db.stories.update(story.id, { timelineMode: "strict" });
    if (change === "window")
      await db.preferences.update("preferences", { novelContextRounds: 1 });
    await run(story.id, "novel", "第二轮");
    expect(body(fetcher, 1).messages).toHaveLength(2);
    expect((await rows()).at(-1)?.request?.prefixReuse?.state).toBe("settings");
  },
);

it("rebuilds before capacity is exceeded, retains required recent prose, and can append again", async () => {
  await db.profiles.update(profile.id, { context: 5000, maxOutput: 512 });
  await db.preferences.update("preferences", { novelContextRounds: 1 });
  let n = 0;
  const fetcher = vi.fn().mockImplementation(() =>
    response(
      JSON.stringify({
        text: `正文${++n}。` + "窗边的风吹过书页。".repeat(25),
      }),
    ),
  );
  vi.stubGlobal("fetch", fetcher);
  let reset = false,
    resumed = false;
  for (let turn = 0; turn < 12 && !resumed; turn++) {
    await run(story.id, "novel", "杯子放在窗边。".repeat(20));
    const report = (await rows()).at(-1)!.request!;
    expect(report.estimate).toBeLessThanOrEqual(report.limit);
    if (report.prefixReuse?.state === "capacity") {
      reset = true;
      expect(report.messages).toHaveLength(2);
      expect(report.messages![1].content).toContain(`正文${turn}。`);
      expect(report.history?.sources).toHaveLength(1);
    } else if (reset && report.prefixReuse?.state === "continued")
      resumed = true;
  }
  expect(reset).toBe(true);
  expect(resumed).toBe(true);
});

it("keeps novel and batched chat independent, brings intervening prose into the tail, and revokes private prose", async () => {
  const fetcher = mockNovel();
  await run(story.id, "novel", "正文输入");
  const prose = (await rows())[0];
  fetcher.mockResolvedValueOnce(
    response('{"messages":["第一条回复","第二条回复"]}'),
  );
  await send("今天见面");
  await send("等我下班");
  await replyChat(story.id);
  expect(body(fetcher, 1).messages).toHaveLength(2);
  expect(body(fetcher, 1).messages[1].content).toContain(prose.text);
  await run(story.id, "novel", "中间正文");
  const secondProse = (await rows()).filter((e) => e.kind === "novel").at(-1)!;
  fetcher.mockResolvedValueOnce(response('{"messages":["好，等你"]}'));
  await send("我下班了");
  await replyChat(story.id);
  const secondChat = body(fetcher, 3).messages;
  expect(secondChat.slice(0, 2)).toEqual(body(fetcher, 1).messages);
  expect(secondChat[2].content).toBe(
    '{"messages":["第一条回复","第二条回复"]}',
  );
  expect(secondChat.at(-1).content).toContain(secondProse.text);
  expect(secondChat.at(-1).content).not.toContain("第一条回复");
  await reviseEvent(prose.id, prose.text, false, [], prose.versionId, "author");
  fetcher.mockResolvedValueOnce(response('{"messages":["晚安"]}'));
  await send("晚安");
  await replyChat(story.id);
  expect(body(fetcher, 4).messages).toHaveLength(2);
  expect(JSON.stringify(body(fetcher, 4))).not.toContain(prose.text);
  expect(await db.promptSessions.count()).toBe(2);
});

it("does not cache failed or truncated responses, and rewrites never reuse future events", async () => {
  const fetcher = mockNovel();
  await run(story.id, "novel", "第一轮");
  const first = (await rows())[0];
  const before = await db.promptSessions.toArray();
  fetcher.mockResolvedValueOnce(
    response('{"text":"不完整', undefined, "length"),
  );
  await expect(run(story.id, "novel", "失败输入")).rejects.toThrow("未完整");
  expect(await db.promptSessions.toArray()).toEqual(before);
  await run(story.id, "novel", "后续正文");
  await run(story.id, "novel", "重新写首段", first.id);
  const rewrite = body(fetcher, 3).messages;
  expect(rewrite).toHaveLength(2);
  expect(JSON.stringify(rewrite)).not.toContain("后续正文");
  expect(JSON.stringify(rewrite)).not.toContain("失败输入");
  expect(await db.promptSessions.count()).toBe(0);
});

it("keeps messages sent during generation for the next appended user turn", async () => {
  let finish!: (r: Response) => void;
  const fetcher = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    )
    .mockResolvedValueOnce(response('{"messages":["第二轮回复"]}'));
  vi.stubGlobal("fetch", fetcher);
  await send("本轮第一条");
  await send("本轮第二条");
  const task = replyChat(story.id);
  await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
  await send("下一轮消息");
  finish(response('{"messages":["第一轮回复"]}'));
  await task;
  await replyChat(story.id);
  expect(body(fetcher, 1).messages.slice(0, 2)).toEqual(
    body(fetcher, 0).messages,
  );
  expect(body(fetcher, 1).messages.at(-1).content).toContain("下一轮消息");
  expect(body(fetcher, 0).messages[1].content).not.toContain("下一轮消息");
});

it("filters changed historical sources even if they were edited while generation was running", async () => {
  const fetcher = mockNovel();
  await run(story.id, "novel", "第一轮");
  let finish!: (r: Response) => void;
  fetcher.mockImplementationOnce(
    () =>
      new Promise<Response>((resolve) => {
        finish = resolve;
      }),
  );
  const task = run(story.id, "novel", "第二轮");
  await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
  const first = (await rows())[0];
  await reviseEvent(first.id, "生成期间改掉的原文");
  finish(response(raw(2)));
  await task;
  await run(story.id, "novel", "第三轮");
  expect(body(fetcher, 2).messages).toHaveLength(2);
  expect(body(fetcher, 2).messages[1].content).not.toContain(first.text);
});

it("keeps transport sessions out of backups and removes them with their story", async () => {
  mockNovel();
  await run(story.id, "novel", "仅存在本地的请求文本");
  const backup = await exportBackup();
  expect(backup).not.toHaveProperty("promptSessions");
  expect(JSON.stringify(backup)).not.toContain('"messages":[{"role":"system"');
  const restored = validateBackup(backup);
  await importBackup(restored, true);
  expect(await db.promptSessions.count()).toBe(0);
  // Profile keys never survive backup import.
  story = (await db.stories.toArray())[0];
  const importedProfile = (await db.profiles.toArray())[0];
  sessionKeys.set(importedProfile.id, "fixture-key");
  await run(story.id, "novel", "导入后继续");
  await deleteStory(story.id);
  expect(await db.promptSessions.count()).toBe(0);
});

it("removes ignored old excerpts from retained requests and rebuilds after manual memory edits", async () => {
  const fetcher = mockNovel();
  for (let n = 0; n < 4; n++) await run(story.id, "novel", "敲门");
  const first = (await rows())[0];
  const memory = (await db.memories.toArray()).find(
    (m) => m.sources[0].id === first.id,
  )!;
  await db.memories.update(memory.id, { status: "ignored" });
  await run(story.id, "novel", "点头");
  expect(body(fetcher, 4).messages).toHaveLength(2);
  expect(JSON.stringify(body(fetcher, 4).messages)).not.toContain(first.text);
  await db.memories.update(memory.id, {
    automatic: false,
    status: "accepted",
    text: "用户整理的约定：周末去书店。",
  });
  await run(story.id, "novel", "抬头");
  expect(body(fetcher, 5).messages).toHaveLength(2);
  expect(body(fetcher, 5).messages[1].content).toContain("用户整理的约定");
});

it("defaults only DeepSeek to prefix reuse, with an explicit override for aliased gateways", () => {
  expect(prefixEnabled(profile)).toBe(true);
  expect(
    prefixEnabled({
      ...profile,
      model: "alias",
      url: "https://api.deepseek.com",
    }),
  ).toBe(true);
  expect(prefixEnabled({ ...profile, model: "another-model" })).toBe(false);
  expect(prefixEnabled({ ...profile, prefixReuse: "off" })).toBe(false);
  expect(prefixEnabled({ ...profile, model: "alias", prefixReuse: "on" })).toBe(
    true,
  );
  expect(
    prefixEnabled({ ...profile, protocol: "claude", prefixReuse: "on" }),
  ).toBe(false);
});

it.each([false, true])(
  "reads DeepSeek hit and miss counts, including a terminal usage-only chunk (stream=%s)",
  async (stream) => {
    const p = { ...profile, url: "https://api.deepseek.com", stream };
    const usage = {
      prompt_tokens: 1000,
      completion_tokens: 12,
      prompt_cache_hit_tokens: 800,
      prompt_cache_miss_tokens: 200,
    };
    const result = await generate(
      p,
      "fixture-key",
      "system",
      "user",
      new AbortController().signal,
      undefined,
      vi
        .fn()
        .mockResolvedValue(
          stream
            ? new Response(
                'data: {"choices":[{"delta":{"reasoning_content":"不回传思考"}}]}\n\n' +
                  'data: {"choices":[{"delta":{"content":"已完成"},"finish_reason":"stop"}]}\n\n' +
                  `data: ${JSON.stringify({ choices: [], usage })}\n\ndata: [DONE]\n\n`,
                { headers: { "content-type": "text/event-stream" } },
              )
            : response("已完成", usage),
        ),
    );
    expect(result.text).toBe("已完成");
    expect(result.usage).toEqual({
      input: 1000,
      output: 12,
      cachedInput: 800,
      uncachedInput: 200,
    });
    expect(cacheHitPercent(result.usage)).toBe("80.0");
    const spec = requestSpec(p, "fixture-key", "system", "user");
    expect(spec.body.stream_options).toEqual(
      stream ? { include_usage: true } : undefined,
    );
    expect(JSON.stringify(spec.body)).not.toContain("cache_control");
  },
);

it("preserves zero misses and hits, distinguishes missing usage, and can derive total input", async () => {
  const fetcher = vi.fn().mockResolvedValue(
    response("done", {
      prompt_cache_hit_tokens: 0,
      prompt_cache_miss_tokens: 10,
    }),
  );
  const result = await generate(
    profile,
    "key",
    "system",
    "user",
    new AbortController().signal,
    undefined,
    fetcher,
  );
  expect(result.usage).toEqual({
    input: 10,
    cachedInput: 0,
    uncachedInput: 10,
  });
  expect(cacheHitPercent(result.usage)).toBe("0.0");
  expect(cacheHitPercent({ cachedInput: 10, uncachedInput: 0 })).toBe("100.0");
  expect(cacheHitPercent(undefined)).toBeUndefined();
  expect(cacheHitPercent({ cachedInput: 0, uncachedInput: 0 })).toBeUndefined();
});
