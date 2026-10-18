import "fake-indexeddb/auto";
import { beforeEach, afterEach, it, expect, vi } from "vitest";
import { db, initialize } from "../src/db";
import { createStory, migrateStories } from "../src/story-service";
import {
  sendChatMessage,
  replyChat,
  previewChat,
  dismissChatBatch,
  pendingChatMessages,
} from "../src/chat";
import { run, preview } from "../src/engine";
import { exportBackup, importBackup, validateBackup } from "../src/backup";
import { uid, type Story, type SceneEvent } from "../src/types";
let s: Story;
beforeEach(async () => {
  await db.delete();
  await db.open();
  await initialize();
  s = (await db.stories.toArray())[0];
});
afterEach(async () => {
  vi.restoreAllMocks();
  await db.delete();
});
it.each(["novel", "phone"] as const)(
  "rejects every retired chat entry for %s without writes or requests",
  async (kind) => {
    if (kind === "phone")
      s = await createStory({
        kind,
        title: "手机",
        roles: s.roles,
        worldIds: [],
        background: "",
      });
    const fetcher = vi.spyOn(globalThis, "fetch");
    for (const call of [
      () => sendChatMessage(s.id, s.player, s.partner, "你好"),
      () => replyChat(s.id),
      () => previewChat(s.id),
      () => dismissChatBatch("old"),
      () => run(s.id, "chat", "你好"),
      () => preview(s.id, "chat", "你好"),
    ])
      await expect(call()).rejects.toThrow("旧聊天入口已停用");
    expect(fetcher).not.toHaveBeenCalled();
    expect(await db.events.count()).toBe(0);
    expect(await db.chatBatches.count()).toBe(0);
  },
);
function message(seq: number, patch: Partial<SceneEvent> = {}): SceneEvent {
  const versionId = uid();
  return {
    id: uid(),
    storyId: s.id,
    seq,
    kind: "message",
    origin: "user",
    speaker: s.player,
    participants: [s.player, s.partner],
    input: "旧输入",
    text: "消息" + seq,
    versionId,
    versions: [
      {
        id: versionId,
        text: "消息" + seq,
        input: "旧输入",
        facts: [],
        created: seq,
      },
    ],
    facts: [],
    raw: "",
    error: "",
    review: false,
    deleted: false,
    status: "complete",
    created: seq,
    chatPending: true,
    ...patch,
  };
}
it.each(["complete", "failed", "interrupted", "running"] as const)(
  "migrates %s legacy batches with both pending directions, versions and editor drafts",
  async (status) => {
    const batchId = uid(),
      first = message(1, { chatBatchId: batchId }),
      reply = message(2, {
        origin: "ai",
        speaker: s.partner,
        chatPending: false,
        chatBatchId: batchId,
      }),
      forward = message(3),
      reverse = message(4, { speaker: s.partner }),
      deleted = message(5, { deleted: true });
    first.versions.unshift({ ...first.versions[0], id: uid(), text: "第一稿" });
    const failed = message(6, {
      status: "draft",
      raw: "未完整 JSON",
      error: "中断",
    });
    await db.stories.update(s.id, {
      kind: undefined as any,
      chatDraft: "附件说明还没写完",
    });
    await db.events.bulkAdd([first, reply, forward, reverse, deleted, failed]);
    await db.chatBatches.add({
      id: batchId,
      storyId: s.id,
      player: s.player,
      partner: s.partner,
      sources: [{ id: first.id, versionId: first.versionId }],
      messages: [first.text],
      replyIds: [reply.id],
      cutoff: 1,
      status,
      raw: "原始返回",
      error: status === "failed" ? "网络断开" : "",
      created: 1,
      updated: 1,
    });
    await db.memories.add({
      id: uid(),
      storyId: s.id,
      text: "聊天混合摘要",
      knownBy: [s.player],
      scope: "story",
      sources: [{ id: first.id, versionId: first.versionId }],
      status: "accepted",
      created: 1,
    });
    await migrateStories();
    await migrateStories();
    const phone = (await db.stories.where("kind").equals("phone").toArray())[0],
      records = await db.phoneRecords
        .where("storyId")
        .equals(phone.id)
        .sortBy("seq");
    expect(records).toHaveLength(6);
    expect(records.find((r) => r.legacyId === first.id)?.versions).toHaveLength(
      2,
    );
    expect(records.find((r) => r.legacyId === deleted.id)?.deleted).toBe(true);
    expect(records.find((r) => r.legacyId === failed.id)?.legacyDraft).toEqual({
      raw: "未完整 JSON",
      error: "中断",
    });
    expect(
      new Set(
        records
          .filter((r) => [forward.id, reverse.id].includes(r.legacyId))
          .map((r) => r.speakerId),
      ).size,
    ).toBe(2);
    expect(
      records.every((r) =>
        r.audience.every((id) => phone.roles.some((role) => role.id === id)),
      ),
    ).toBe(true);
    expect((await db.phoneRuns.toArray())[0].status).toBe(
      status === "running" ? "interrupted" : status,
    );
    expect(await db.events.count()).toBe(0);
    expect(await db.memories.count()).toBe(0);
    expect(
      (await db.legacyArchives.toArray()).some((a) => a.table === "memories"),
    ).toBe(true);
    const space = (await db.phoneSpaces.toArray())[0];
    expect(
      Object.values(space.devices).some((d) =>
        Object.values(d.drafts).includes("附件说明还没写完"),
      ),
    ).toBe(true);
    const backup = validateBackup(await exportBackup());
    await importBackup(backup, false);
    expect(await db.stories.count()).toBe(4);
    validateBackup(await exportBackup());
  },
);
it("legacy read helper keeps reversed, deleted and adopted pending messages separate", () => {
  const good = message(1),
    reverse = message(2, { speaker: s.partner }),
    gone = message(3, { deleted: true }),
    adopted = message(4, { chatBatchId: "batch" });
  expect(
    pendingChatMessages([reverse, gone, adopted, good], s.player, s.partner),
  ).toEqual([good]);
});
