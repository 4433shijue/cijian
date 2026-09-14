import "fake-indexeddb/auto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { db, initialize, reviseEvent, sessionKeys } from "../src/db";
import { sendChatMessage, replyChat, pendingChatMessages, previewChat, dismissChatBatch } from "../src/chat";
import { active, stop } from "../src/generation-state";
import { exportBackup, importBackup, validateBackup } from "../src/backup";
import type { Story } from "../src/types";

let story: Story;
const response = (raw: string) => new Response(JSON.stringify({
  choices: [{ message: { content: raw }, finish_reason: "stop" }],
}), { headers: { "content-type": "application/json" } });
const success = (messages: string[]) => response(JSON.stringify({ messages }));
const rows = () => db.events.where("storyId").equals(story.id).sortBy("seq");
const send = (text: string) => sendChatMessage(story.id, story.player, story.partner, text);
const pending = async () => pendingChatMessages(await rows(), story.player, story.partner);

beforeEach(async () => {
  await db.delete();
  await db.open();
  await initialize();
  story = (await db.stories.toArray())[0];
  await db.stories.update(story.id, { autoMemory: false });
  await db.profiles.put({ id: "p", name: "fixture", protocol: "chat", url: "https://fixture.test/v1",
    model: "fixture", stream: false, context: 16000, maxOutput: 2048, timeout: 10, remember: false });
  await db.preferences.update("preferences", { activeProfile: "p" });
  sessionKeys.set("p", "fixture-key");
});
afterEach(() => { vi.unstubAllGlobals(); active.clear(); sessionKeys.clear(); });

it("saves consecutive sends without a model or network and restores the pending queue", async () => {
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  await db.preferences.update("preferences", { activeProfile: "" });
  const ids = [await send("明天吃饭吗"), await send("改成今天"), await send("六点下班")];
  db.close();
  await db.open();
  expect((await pending()).map((e) => e.id)).toEqual(ids);
  expect((await rows()).map((e) => e.seq)).toEqual([1, 2, 3]);
  expect(fetcher).not.toHaveBeenCalled();
  await expect(sendChatMessage(story.id, story.player, story.player, "你好")).rejects.toThrow("不同");
});

it("submits the complete ordered batch once, without copying it into history, and saves separate bubbles", async () => {
  const texts = ["UNIQUE_A 明天吃饭吗", "UNIQUE_B 改成今天", "UNIQUE_C 六点下班"];
  for (const text of texts) await send(text);
  const preview = await previewChat(story.id);
  const fetcher = vi.fn().mockResolvedValue(success(["今天可以。", "六点去接你？"]));
  vi.stubGlobal("fetch", fetcher);
  await replyChat(story.id);
  expect(fetcher).toHaveBeenCalledTimes(1);
  const body = JSON.parse(fetcher.mock.calls[0][1].body);
  expect(body.messages[1].content).toBe(preview.user);
  for (const text of texts) expect(body.messages[1].content.split(text)).toHaveLength(2);
  expect(body.messages[1].content).toContain(JSON.stringify({ pending_user_messages: texts }));
  expect(body.messages[0].content).toContain("补充与纠正");
  const events = await rows(), batch = (await db.chatBatches.toArray())[0];
  expect(events.filter((e) => e.origin === "ai").map((e) => e.text)).toEqual(["今天可以。", "六点去接你？"]);
  expect(events.every((e) => e.chatBatchId === batch.id)).toBe(true);
  expect(batch.status).toBe("complete");
  expect(await pending()).toHaveLength(0);
  await expect(replyChat(story.id)).rejects.toThrow("先发送");
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it("keeps pending queues separate by story, player and recipient", async () => {
  const third = { ...story.roles[0], id: "third", name: "第三位" };
  await db.stories.update(story.id, { roles: [...story.roles, third] });
  const current = await send("CURRENT_CHAT");
  const other = await sendChatMessage(story.id, story.player, third.id, "OTHER_CHAT_PRIVATE");
  const reverse = await sendChatMessage(story.id, story.partner, story.player, "REVERSED_PENDING");
  expect((await pending()).map((e) => e.id)).toEqual([current]);
  const fetcher = vi.fn().mockResolvedValue(success(["收到"]));
  vi.stubGlobal("fetch", fetcher);
  await replyChat(story.id);
  const content = JSON.parse(fetcher.mock.calls[0][1].body).messages[1].content;
  expect(content).not.toContain("OTHER_CHAT_PRIVATE");
  expect(content).not.toContain("REVERSED_PENDING");
  expect((await db.events.get(other))?.chatPending).toBe(true);
  expect((await db.events.get(reverse))?.chatPending).toBe(true);
});

it.each(['{"messages":', '{"messages":[]}', '{"messages":[" "]}',
  '{"messages":["hello"],"extra":true}', JSON.stringify({ messages: Array(21).fill("x") })])(
  "keeps invalid output out of history and retries the same user messages: %s", async (raw) => {
    const ids = [await send("第一条"), await send("第二条")];
    const fetcher = vi.fn().mockResolvedValueOnce(response(raw)).mockResolvedValueOnce(success(["收到了", "两条都看见了"]));
    vi.stubGlobal("fetch", fetcher);
    await expect(replyChat(story.id)).rejects.toThrow("格式");
    const batch = (await db.chatBatches.toArray())[0];
    expect(batch.raw).toBe(raw);
    expect(batch.status).toBe("failed");
    expect((await rows()).map((e) => e.id)).toEqual(ids);
    await replyChat(story.id, batch.id);
    expect((await rows()).filter((e) => e.origin === "user").map((e) => e.id)).toEqual(ids);
    expect((await rows()).filter((e) => e.origin === "ai")).toHaveLength(2);
    expect(fetcher).toHaveBeenCalledTimes(2);
  },
);

it("allows sending during generation, takes a fixed snapshot and allocates unique sequence numbers", async () => {
  await send("THIS_BATCH");
  let finish!: (response: Response) => void;
  const fetcher = vi.fn().mockImplementationOnce(() => new Promise<Response>((resolve) => { finish = resolve; }))
    .mockResolvedValueOnce(success(["下一轮收到"]));
  vi.stubGlobal("fetch", fetcher);
  const task = replyChat(story.id);
  await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
  await expect(replyChat(story.id)).rejects.toThrow("正在生成");
  const next = await send("NEXT_BATCH");
  await db.stories.update(story.id, { chatDraft: "仍在输入的草稿" });
  finish(success(["当前这一轮", "只回复第一条"]));
  await task;
  expect((await pending()).map((e) => e.id)).toEqual([next]);
  expect((await db.stories.get(story.id))?.chatDraft).toBe("仍在输入的草稿");
  let events = await rows();
  expect(new Set(events.map((e) => e.seq)).size).toBe(events.length);
  expect(JSON.parse(fetcher.mock.calls[0][1].body).messages[1].content).not.toContain("NEXT_BATCH");
  await replyChat(story.id);
  const content = JSON.parse(fetcher.mock.calls[1][1].body).messages[1].content;
  expect(content.split("NEXT_BATCH")).toHaveLength(2);
  expect(content).toContain("当前这一轮");
  events = await rows();
  expect(new Set(events.map((e) => e.seq)).size).toBe(events.length);
});

it("stops without adopting a late response, then restores interrupted work after reopening", async () => {
  const source = await send("等我说完");
  let finish!: (response: Response) => void;
  const fetcher = vi.fn().mockImplementationOnce(() => new Promise<Response>((resolve) => { finish = resolve; }))
    .mockResolvedValueOnce(success(["我在听"]));
  vi.stubGlobal("fetch", fetcher);
  const task = replyChat(story.id);
  const rejected = expect(task).rejects.toThrow("停止");
  await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
  stop(story.id);
  finish(success(["迟到的回复"]));
  await rejected;
  const batch = (await db.chatBatches.toArray())[0];
  expect(batch.status).toBe("interrupted");
  expect((await rows()).map((e) => e.id)).toEqual([source]);
  // Simulate a tab closing after it persisted a running request.
  await db.chatBatches.update(batch.id, { status: "running" });
  db.close(); await db.open(); await initialize();
  expect((await db.chatBatches.get(batch.id))?.status).toBe("interrupted");
  expect(fetcher).toHaveBeenCalledTimes(1);
  await replyChat(story.id, batch.id);
  expect((await rows()).filter((e) => e.origin === "user")).toHaveLength(1);
});

it("replaces the whole group when the number of bubbles changes and preserves newer messages and old versions", async () => {
  await send("原消息");
  const fetcher = vi.fn().mockResolvedValueOnce(success(["旧一", "旧二"]))
    .mockResolvedValueOnce(success(["新一", "新二", "新三"]))
    .mockResolvedValueOnce(success(["最后一条"]))
    .mockResolvedValueOnce(response("broken"));
  vi.stubGlobal("fetch", fetcher);
  await replyChat(story.id);
  const batch = (await db.chatBatches.toArray())[0];
  const newer = await send("FUTURE_INPUT");
  await replyChat(story.id, batch.id);
  let events = (await rows()).filter((e) => !e.deleted);
  expect(events.map((e) => e.text)).toEqual(["原消息", "新一", "新二", "新三", "FUTURE_INPUT"]);
  expect(JSON.parse(fetcher.mock.calls[1][1].body).messages[1].content).not.toContain("FUTURE_INPUT");
  expect(events.find((e) => e.text === "新一")?.versions.map((v) => v.text)).toEqual(["旧一", "新一"]);
  await replyChat(story.id, batch.id);
  events = (await rows()).filter((e) => !e.deleted);
  expect(events.map((e) => e.text)).toEqual(["原消息", "最后一条", "FUTURE_INPUT"]);
  expect((await pending()).map((e) => e.id)).toEqual([newer]);
  expect((await db.events.get(newer))?.review).toBe(false);
  await expect(replyChat(story.id, batch.id)).rejects.toThrow("格式");
  expect((await rows()).filter((e) => !e.deleted).map((e) => e.text)).toEqual(events.map((e) => e.text));
  await dismissChatBatch(batch.id);
  expect((await db.chatBatches.get(batch.id))?.status).toBe("complete");
});

it("rejects stale results after source edits and retries with the corrected source", async () => {
  const source = await send("明天");
  let finish!: (response: Response) => void;
  const fetcher = vi.fn().mockImplementationOnce(() => new Promise<Response>((resolve) => { finish = resolve; }))
    .mockResolvedValueOnce(success(["今天可以"]))
    .mockResolvedValueOnce(success(["后天也可以"]));
  vi.stubGlobal("fetch", fetcher);
  const task = replyChat(story.id);
  const rejected = expect(task).rejects.toThrow("已修改");
  await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
  await reviseEvent(source, "今天");
  finish(success(["明天可以"]));
  await rejected;
  const batch = (await db.chatBatches.toArray())[0];
  expect((await rows()).filter((e) => e.origin === "ai")).toHaveLength(0);
  await replyChat(story.id, batch.id);
  expect(JSON.parse(fetcher.mock.calls[1][1].body).messages[1].content).toContain('"pending_user_messages":["今天"]');
  await reviseEvent(source, "后天");
  await replyChat(story.id, batch.id);
  const reply = (await rows()).find((e) => e.origin === "ai")!;
  expect(reply.versions.map((v) => v.input)).toEqual(["今天", "后天"]);
});

it("can release a failed group back to the queue and combine it with newly sent messages", async () => {
  const first = await send("第一条");
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response("bad")));
  await expect(replyChat(story.id)).rejects.toThrow();
  const batch = (await db.chatBatches.toArray())[0];
  const second = await send("补充");
  await expect(replyChat(story.id)).rejects.toThrow("上一组");
  await dismissChatBatch(batch.id);
  expect((await pending()).map((e) => e.id)).toEqual([first, second]);
  expect(await db.chatBatches.count()).toBe(0);
  validateBackup(await exportBackup());
});

it("adopts adjacent legacy replies as one group without replaying old user messages", async () => {
  await send("旧消息");
  vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(success(["旧回复一", "旧回复二"]))
    .mockResolvedValueOnce(success(["合为一句"])));
  await replyChat(story.id);
  await db.chatBatches.clear();
  for (const e of await rows()) await db.events.update(e.id, { chatBatchId: undefined, chatPending: undefined });
  const old = (await rows()).filter((e) => e.origin === "ai");
  await replyChat(story.id, undefined, old[1].id);
  expect((await rows()).filter((e) => !e.deleted).map((e) => e.text)).toEqual(["旧消息", "合为一句"]);
  expect(await pending()).toHaveLength(0);
  validateBackup(await exportBackup());
});

it("round-trips batches and pending messages with remapped IDs and rejects broken associations", async () => {
  await send("本组");
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(success(["回复一", "回复二"])));
  await replyChat(story.id);
  await send("下一组");
  const backup = await exportBackup();
  const originalBatch = backup.chatBatches[0];
  await importBackup(backup, true);
  const imported = validateBackup(await exportBackup());
  expect(imported.chatBatches).toHaveLength(1);
  const batch = imported.chatBatches[0];
  expect(batch.id).not.toBe(originalBatch.id);
  expect(batch.sources[0].id).not.toBe(originalBatch.sources[0].id);
  expect(imported.events.filter((e) => e.chatBatchId === batch.id)).toHaveLength(3);
  expect(imported.events.filter((e) => e.chatPending)).toHaveLength(1);
  const invalid = structuredClone(imported);
  invalid.chatBatches[0].sources[0].id = "missing";
  expect(() => validateBackup(invalid)).toThrow("批次关联");
  const oldBackup = { ...imported, chatBatches: undefined, events: [] };
  expect(validateBackup(oldBackup).chatBatches).toEqual([]);
});
