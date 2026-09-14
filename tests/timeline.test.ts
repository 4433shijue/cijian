import "fake-indexeddb/auto";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { db, initialize, refreshTimelineMemory, reviseEvent, sessionKeys, setTimelineMode } from "../src/db";
import { buildContext } from "../src/context";
import { organizeMemory, run } from "../src/engine";
import { replyChat, sendChatMessage } from "../src/chat";
import { exportBackup, importBackup } from "../src/backup";
import { visibleText } from "../src/timeline";
import type { Preferences, Profile, SceneEvent, Story } from "../src/types";

const profile: Profile = { id: "timeline-profile", name: "fixture", protocol: "chat", url: "https://timeline.fixture.test/v1",
  model: "fixture", stream: false, context: 18000, maxOutput: 2000, timeout: 10, remember: false };
const prefs: Preferences = { id: "preferences", activeProfile: profile.id, developer: false, prompts: {} };
let s: Story;
function event(seq: number, text: string, patch: Partial<SceneEvent> = {}): SceneEvent {
  const e: SceneEvent = { id: "event-" + seq, storyId: s.id, seq, kind: "novel", speaker: "", participants: s.roles.map((r) => r.id),
    input: text, text, facts: [], versions: [], versionId: "version-" + seq, status: "complete", raw: "", error: "",
    review: false, deleted: false, created: seq, ...patch };
  e.versions = [{ id: e.versionId, text: e.text, input: e.input, facts: e.facts, visibility: e.visibility, created: seq }];
  return e;
}
const response = (data: unknown, finish_reason = "stop") => new Response(JSON.stringify({
  choices: [{ message: { content: typeof data === "string" ? data : JSON.stringify(data) }, finish_reason }],
}));
async function context(kind: "novel" | "chat" = "chat", query = "接着聊") {
  return buildContext(kind, (await db.stories.get(s.id))!, await db.events.toArray(), await db.memories.toArray(), [], prefs, profile, query);
}
beforeEach(async () => {
  await db.delete(); await db.open(); await initialize();
  s = (await db.stories.toArray())[0];
  await db.profiles.put(profile); await db.preferences.put(prefs);
  sessionKeys.set(profile.id, "fixture-key");
});
afterEach(() => vi.restoreAllMocks());

it("new stories use shared chronological prose and chat without facts approval", async () => {
  expect(s.timelineMode).toBe("shared");
  await db.events.bulkAdd([event(1, "先约在河边见面。"), event(2, "我已经到桥头了。", {
    kind: "message", speaker: s.partner, origin: "ai", participants: [s.player, s.partner],
  }), event(3, "后来他们一起走进书店。", { review: true })]);
  for (const kind of ["novel", "chat"] as const) {
    const r = await context(kind);
    expect(r.user.indexOf("先约在河边见面。")).toBeLessThan(r.user.indexOf("我已经到桥头了。"));
    expect(r.user.indexOf("我已经到桥头了。")).toBeLessThan(r.user.indexOf("后来他们一起走进书店。"));
  }
});

it("keeps author-only prose, restricted facts, other conversations and drafts private", async () => {
  await db.events.bulkAdd([
    event(1, "PRIVATE_AUTHOR", { visibility: "author" }),
    event(2, "VISIBLE_FACT。PRIVATE_THOUGHT", { visibility: "facts", facts: [
      { id: "fact", text: "VISIBLE_FACT", quote: "VISIBLE_FACT", knownBy: [s.partner] },
    ] }),
    event(3, "PRIVATE_CHAT", { kind: "message", participants: [s.player, "third"] }),
    event(4, "INCOMPLETE_PROSE", { status: "draft" }),
    event(5, "DELETED_PROSE", { deleted: true }),
    event(6, "PENDING_CHAT", { kind: "message", chatPending: true }),
    ...Array.from({ length: 10 }, (_, i) => event(7 + i, "日常走动片段。")),
  ]);
  await refreshTimelineMemory(s.id);
  const r = await context("chat", "VISIBLE_FACT PRIVATE_AUTHOR PRIVATE_THOUGHT PRIVATE_CHAT");
  // The query itself contains test labels; only inspect reference materials.
  const materials = r.included.map((m) => m.text).join("\n");
  expect(materials).toContain("VISIBLE_FACT");
  for (const secret of ["PRIVATE_AUTHOR", "PRIVATE_THOUGHT", "PRIVATE_CHAT", "INCOMPLETE_PROSE", "DELETED_PROSE", "PENDING_CHAT"])
    expect(materials).not.toContain(secret);
});

it("enables a legacy story once while retaining explicit and previously revoked permissions", async () => {
  await db.stories.update(s.id, { timelineMode: undefined });
  const restricted = event(3, "他递伞。隐藏心事。", { facts: [{ id: "f", text: "他递伞。", quote: "他递伞。", knownBy: [s.partner] }] });
  const revoked = event(4, "已撤回知情的秘密。", { facts: [] });
  revoked.versions.unshift({ id: "prior-auth", input: "", text: revoked.text, facts: restricted.facts, created: 0 });
  await db.events.bulkAdd([event(1, "普通旧正文", { review: true }), event(2, "显式私密正文", { visibility: "author" }), restricted, revoked]);
  await setTimelineMode(s.id, "shared");
  await setTimelineMode(s.id, "shared");
  expect((await context()).user).toContain("普通旧正文");
  expect((await context()).user).not.toContain("隐藏心事");
  expect((await context()).user).not.toContain("已撤回知情的秘密");
  expect((await context()).user).not.toContain("显式私密正文");
  expect((await db.events.get(restricted.id))?.visibility).toBe("facts");
  expect((await db.events.get(restricted.id))?.versions).toHaveLength(2);
  expect(await db.memories.count()).toBe(4);
});

it("retrieves an old original after dozens of passages and respects context capacity", async () => {
  const old = event(1, "他们约定七月去雾岚岛看灯塔，船票放在蓝色抽屉里。");
  await db.events.bulkAdd([old, ...Array.from({ length: 45 }, (_, i) => event(i + 2, `第${i}天，两人在店里整理书架。`))]);
  await refreshTimelineMemory(s.id);
  const r = await context("chat", "雾岚岛的船票放哪了？");
  expect(r.included.find((m) => m.id === old.id)?.text).toBe(old.text);
  expect(r.history?.recalled?.some((ref) => ref.id === old.id)).toBe(true);
  expect(r.estimate).toBeLessThanOrEqual(r.limit);
  expect(r.included.filter((m) => m.id.startsWith("event-")).map((m) => m.id)).toEqual([
    "event-1", ...Array.from({ length: 7 }, (_, i) => "event-" + (40 + i)),
  ]);
  const memories = await db.memories.toArray();
  expect(memories).toHaveLength(46);
  expect(memories.every((m) => m.status === "accepted" && m.knownBy.includes(s.partner))).toBe(true);
});

it("preserves edited/ignored excerpts and regenerates only an edited source", async () => {
  const a = event(1, "最初约在门口。"), b = event(2, "随后走进书店。");
  await db.events.bulkAdd([a, b]); await refreshTimelineMemory(s.id);
  const [first, second] = (await db.memories.toArray()).sort((x, y) => x.created - y.created);
  await db.memories.update(first.id, { text: "作者改过的摘记", automatic: false });
  await db.memories.update(second.id, { status: "ignored" });
  await refreshTimelineMemory(s.id);
  expect(await db.memories.count()).toBe(2);
  expect((await db.memories.get(first.id))?.text).toBe("作者改过的摘记");
  await reviseEvent(a.id, "改为桥边见面。");
  expect((await db.memories.get(first.id))?.status).toBe("review");
  expect((await db.memories.get(second.id))?.status).toBe("ignored");
  expect((await context("novel")).user).toContain("随后走进书店。");
  expect((await db.memories.toArray()).some((m) => m.automatic && m.text === "改为桥边见面。")).toBe(true);
});

it.each(["shared", "strict"] as const)("metadata edits do not invalidate later events in %s mode", async (mode) => {
  await db.stories.update(s.id, { timelineMode: mode });
  const a = event(1, "递伞。"), b = event(2, "伞已收好。");
  await db.events.bulkAdd([a, b]);
  await db.memories.add({ id: "later-memory", storyId: s.id, text: b.text, knownBy: [], scope: "story",
    sources: [{ id: b.id, versionId: b.versionId }], status: "accepted", created: 3 });
  await reviseEvent(a.id, a.text, false, [{ id: "fact", text: a.text, quote: a.text, knownBy: [s.partner] }], a.versionId, "facts");
  expect((await db.events.get(b.id))?.review).toBe(false);
  expect((await db.memories.get("later-memory"))?.status).toBe("accepted");
  const latest = (await db.events.get(a.id))!;
  await reviseEvent(a.id, latest.text, false, latest.facts, latest.versionId, "author");
  expect(visibleText((await db.events.get(a.id))!, s.partner, s)).toBe("");
  expect((await db.events.get(b.id))?.review).toBe(false);
});

it("switching back to strict mode revokes summaries of shared prose", async () => {
  const e = event(1, "共享时期的秘密"); await db.events.add(e);
  await refreshTimelineMemory(s.id);
  await db.memories.add({ id: "ai-summary", storyId: s.id, text: "SUMMARY_SECRET", knownBy: [s.partner], scope: "story",
    sources: [{ id: e.id, versionId: e.versionId }], status: "accepted", created: 2 });
  await setTimelineMode(s.id, "strict");
  const r = await context(); expect(r.user).not.toContain("共享时期的秘密"); expect(r.user).not.toContain("SUMMARY_SECRET");
});

it.each([false, true])("dialogue differences never block saving (advice=%s)", async (enabled) => {
  await db.preferences.update("preferences", { dialogueCheck: enabled });
  const api = vi.spyOn(globalThis, "fetch").mockResolvedValue(response({ text: "他说“收下吧”。", facts: [] }));
  await run(s.id, "novel", "他说“拿着”。");
  const e = (await db.events.toArray())[0];
  expect(e.status).toBe("complete"); expect(e.error).toBe("");
  expect(!!e.warnings?.length).toBe(enabled); expect(api).toHaveBeenCalledTimes(1);
});

it.each([null, "bad facts", [{ quote: 42 }]])("bad optional facts preserve complete prose: %j", async (facts) => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(response({ text: "他把伞递过来。", facts }));
  await run(s.id, "novel", "递伞");
  expect((await db.events.toArray())[0]).toMatchObject({ status: "complete", text: "他把伞递过来。", facts: [], error: "" });
});

it("still preserves incomplete generation as a draft", async () => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(response({ text: "还没有说完", facts: [] }, "length"));
  await expect(run(s.id, "novel", "递伞")).rejects.toThrow("未完整结束");
  expect((await db.events.toArray())[0].status).toBe("draft");
  expect(await db.memories.count()).toBe(0);
});

it("automatically gives a chat batch prose context and brings its replies back into prose", async () => {
  await db.events.add(event(1, "他们约好明天一起去河边。"));
  await sendChatMessage(s.id, s.player, s.partner, "几点出发？");
  await sendChatMessage(s.id, s.player, s.partner, "我上午有事，改下午吧。");
  expect((await context("novel")).user).toContain("我上午有事，改下午吧。");
  const api = vi.spyOn(globalThis, "fetch").mockResolvedValue(response({ messages: ["那就下午三点。", "桥头等你。"] }));
  await replyChat(s.id);
  const sent = JSON.parse(api.mock.calls[0][1]?.body as string).messages[1].content;
  expect(sent).toContain("他们约好明天一起去河边。");
  const novel = (await context("novel")).user;
  expect(novel.indexOf("几点出发？")).toBeLessThan(novel.indexOf("那就下午三点。"));
  expect(novel).toContain("桥头等你。"); expect(api).toHaveBeenCalledTimes(1);
});

it("AI summaries use separate audience requests, inherit prose visibility and respect a batch limit", async () => {
  await db.events.bulkAdd([event(1, "ONLY_AUTHOR", { visibility: "author" }),
    ...Array.from({ length: 24 }, (_, i) => event(i + 2, "PUBLIC_EVENT_" + i))]);
  const api = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
    const body = JSON.parse(init?.body as string);
    const rows = JSON.parse(body.messages[1].content.split("【当前任务】\n")[1]);
    const privateGroup = rows.some((r: any) => r.text === "ONLY_AUTHOR");
    expect(rows.every((r: any) => privateGroup ? r.text === "ONLY_AUTHOR" : r.text.startsWith("PUBLIC_EVENT_"))).toBe(true);
    return response({ memories: [{ text: privateGroup ? "AUTHOR_SUMMARY" : "SHARED_SUMMARY", sourceIds: rows.map((r: any) => r.id), knownBy: [], scope: "story" }] });
  });
  await organizeMemory(s.id);
  expect(api).toHaveBeenCalledTimes(2);
  expect((await db.stories.get(s.id))?.memoryCursor).toBe(20);
  const memories = await db.memories.toArray();
  expect(memories.find((m) => m.text === "SHARED_SUMMARY")).toMatchObject({ status: "accepted", knownBy: s.roles.map((r) => r.id) });
  expect((await context()).user).not.toContain("AUTHOR_SUMMARY");
  await organizeMemory(s.id); expect(api).toHaveBeenCalledTimes(3);
  expect((await db.stories.get(s.id))?.memoryCursor).toBe(25);
});

it("round-trips sharing, warnings, source versions, excerpt status and dialogue preference in backups", async () => {
  const e = event(1, "备份私密正文", { visibility: "author", warnings: ["可选提醒"] });
  await db.events.add(e); await refreshTimelineMemory(s.id);
  await db.preferences.update("preferences", { dialogueCheck: true });
  await importBackup(await exportBackup(), true);
  const imported = (await db.stories.toArray())[0];
  const saved = (await db.events.toArray())[0], memory = (await db.memories.toArray())[0];
  expect(imported.timelineMode).toBe("shared"); expect(saved.id).not.toBe(e.id);
  expect(saved).toMatchObject({ visibility: "author", warnings: ["可选提醒"] });
  expect(saved.versions[0].visibility).toBe("author");
  expect(memory).toMatchObject({ automatic: true, knownBy: [], sources: [{ id: saved.id, versionId: saved.versionId }] });
  expect((await db.preferences.get("preferences"))?.dialogueCheck).toBe(true);
});
