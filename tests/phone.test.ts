import "fake-indexeddb/auto";
import { beforeEach, afterEach, it, expect, vi } from "vitest";
import { db, initialize, sessionKeys, deleteStory, makeStory } from "../src/db";
import {
  addRecord,
  canSee,
  changeGroup,
  conversation,
  editRecord,
  ensurePhone,
  initializePhones,
  likeMoment,
  updateDevice,
  saveAsset,
} from "../src/phone-store";
import {
  startPhoneRun,
  continuePhoneRun,
  stopPhone,
} from "../src/phone-generation";
import { emptyBody } from "../src/phone-types";
import { exportBackup, importBackup, validateBackup } from "../src/backup";
import {
  exportBackupBlob,
  stageBackup,
  commitStaged,
} from "../src/backup-transfer";
import { exportWork } from "../src/work-export";
import { preview } from "../src/engine";
import { uid, type Story, type SceneEvent } from "../src/types";
let s: Story, cid: string;
const body = (text: string) => ({ ...emptyBody(), text });
const response = (text: string) =>
  new Response(
    JSON.stringify({
      choices: [
        {
          message: {
            content: JSON.stringify({ messages: [{ type: "text", text }] }),
          },
          finish_reason: "stop",
        },
      ],
    }),
    { headers: { "content-type": "application/json" } },
  );
const rows = () => db.phoneRecords.where("storyId").equals(s.id).sortBy("seq");
const task = () => ({
  storyId: s.id,
  ownerId: s.player,
  conversationId: cid,
  speakers: [s.partner],
  mode: "participate" as const,
});
const send = (text: string) =>
  addRecord(s.id, {
    speakerId: s.player,
    conversationId: cid,
    body: body(text),
    pending: true,
  });
function prose(
  text: string,
  seq = 1,
  patch: Partial<SceneEvent> = {},
): SceneEvent {
  const id = uid(),
    versionId = uid();
  return {
    id,
    storyId: s.id,
    seq,
    kind: "novel",
    text,
    input: text,
    speaker: "",
    participants: s.roles.map((r) => r.id),
    facts: [],
    versions: [{ id: versionId, text, input: text, created: seq, facts: [] }],
    versionId,
    status: "complete",
    raw: "",
    error: "",
    review: false,
    deleted: false,
    created: seq,
    ...patch,
  };
}
beforeEach(async () => {
  await db.delete();
  await db.open();
  await initialize();
  s = (await db.stories.toArray())[0];
  s.kind = "phone";
  s.autoMemory = false;
  s.roles.push({
    ...structuredClone(s.roles[0]),
    id: "third",
    name: "第三位",
    persona: "THIRD_PRIVATE_SECRET",
    paragraphs: [],
  });
  await db.stories.put(s);
  await db.profiles.put({
    id: "phone-fixture",
    name: "fixture",
    protocol: "chat",
    url: "https://phone.fixture.test/v1",
    model: "fixture",
    context: 64000,
    maxOutput: 2000,
    timeout: 10,
    stream: false,
    remember: false,
  });
  await db.preferences.update("preferences", {
    activeProfile: "phone-fixture",
  });
  sessionKeys.set("phone-fixture", "fixture-key");
  cid = await conversation(s, [s.player, s.partner]);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  sessionKeys.clear();
});

it("stores both directions in one conversation without any provider calls", async () => {
  const api = vi.spyOn(globalThis, "fetch");
  expect(await conversation(s, [s.partner, s.player])).toBe(cid);
  await send("A");
  await addRecord(s.id, {
    speakerId: s.partner,
    conversationId: cid,
    body: body("B"),
    pending: true,
  });
  db.close();
  await db.open();
  expect((await rows()).map((r) => r.body.text)).toEqual(["A", "B"]);
  expect((await rows()).every((r) => r.pending)).toBe(true);
  expect(api).not.toHaveBeenCalled();
  expect(await db.events.count()).toBe(0);
});
it("migrates legacy versions, drafts, failed batches and mixed memories once", async () => {
  await db.phoneSpaces.where("storyId").equals(s.id).delete();
  const event = prose("OLD_USER", 1, {
    kind: "message",
    speaker: s.player,
    participants: [s.player, s.partner],
    origin: "user",
    chatPending: true,
  });
  const batch = {
    id: uid(),
    storyId: s.id,
    player: s.player,
    partner: s.partner,
    sources: [{ id: event.id, versionId: event.versionId }],
    messages: [event.text],
    replyIds: [],
    cutoff: 2,
    status: "failed" as const,
    created: 1,
    updated: 1,
    raw: "bad output",
    error: "broken",
  };
  event.chatBatchId = batch.id;
  await db.events.add(event);
  await db.chatBatches.add(batch);
  await db.stories.update(s.id, { chatDraft: "UNSENT" });
  await db.memories.add({
    id: "mixed",
    storyId: s.id,
    text: "OLD_MEMORY",
    sources: batch.sources,
    knownBy: [s.player, s.partner],
    scope: "story",
    status: "accepted",
    created: 1,
  });
  await ensurePhone(s.id);
  await initializePhones();
  expect(await db.phoneRecords.count()).toBe(1);
  expect((await rows())[0]).toMatchObject({
    pending: true,
    legacyId: event.id,
    versionId: event.versionId,
  });
  expect((await db.phoneRuns.toArray())[0]).toMatchObject({
    status: "failed",
    legacyId: batch.id,
  });
  expect((await db.memories.get("mixed"))?.status).toBe("invalid");
  expect((await ensurePhone(s.id)).devices[s.player].drafts[cid]).toBe(
    "UNSENT",
  );
  expect((await db.events.get(event.id))?.text).toBe("OLD_USER");
});
it("does not read prose and blocks novel operations on a phone work", async () => {
  await db.events.bulkAdd([
    prose("PUBLIC_PROSE"),
    prose("PRIVATE_PROSE", 2, { visibility: "author" }),
  ]);
  await send("PHONE_ONLY");
  const api = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(response("PHONE_REPLY"));
  await startPhoneRun(task());
  const request = JSON.stringify(
    JSON.parse(api.mock.calls[0][1]!.body as string),
  );
  expect(request).not.toContain("PUBLIC_PROSE");
  expect(request).not.toContain("PRIVATE_PROSE");
  expect(request).toContain("PHONE_ONLY");
  expect(request).not.toContain("THIRD_PRIVATE_SECRET");
  await expect(preview(s.id,"novel","继续正文")).rejects.toThrow("手机作品");
});
it("keeps group membership history and rejects invisible moments and quotes", async () => {
  const g = await conversation(s, [s.player, s.partner], "朋友", true);
  const old = await addRecord(s.id, {
    speakerId: s.player,
    conversationId: g,
    body: body("BEFORE_JOIN"),
  });
  await changeGroup(g, "三人", [s.player, s.partner, "third"], s.player);
  const next = await addRecord(s.id, {
    speakerId: s.player,
    conversationId: g,
    body: body("AFTER_JOIN"),
  });
  expect(canSee(old, "third")).toBe(false);
  expect(canSee(next, "third")).toBe(true);
  const post = await addRecord(s.id, {
    kind: "moment",
    speakerId: s.player,
    audience: [s.player],
    body: body("PRIVATE_POST"),
  });
  await expect(likeMoment(post.id, s.partner)).rejects.toThrow("不可见");
  await expect(
    addRecord(s.id, {
      kind: "comment",
      parentId: post.id,
      speakerId: s.partner,
      body: body("wrong"),
    }),
  ).rejects.toThrow("不可见");
  await expect(
    addRecord(s.id, {
      speakerId: "third",
      conversationId: g,
      body: { ...body("引用"), quoteId: old.id },
    }),
  ).rejects.toThrow("不可见");
});
it("runs selected speakers in order and retries only the failing speaker", async () => {
  cid = await conversation(s, [s.player, s.partner, "third"], "群聊", true);
  await send("BATCH");
  const api = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(response("FIRST_REPLY"))
    .mockRejectedValueOnce(Error("network failed"))
    .mockResolvedValueOnce(response("SECOND_REPLY"));
  await expect(
    startPhoneRun({ ...task(), speakers: [s.partner, "third"] }),
  ).rejects.toThrow("network failed");
  const run = (await db.phoneRuns.toArray())[0];
  expect(run.steps[0].status).toBe("complete");
  await continuePhoneRun(run.id);
  expect(api).toHaveBeenCalledTimes(3);
  expect(
    (await rows()).filter((r) => r.body.text === "FIRST_REPLY"),
  ).toHaveLength(1);
  expect(JSON.stringify(api.mock.calls[2][1])).toContain("FIRST_REPLY");
  expect((await rows()).some((r) => r.pending)).toBe(false);
});
it("freezes the input and keeps sends arriving during generation pending", async () => {
  await send("THIS_ROUND");
  let release!: (r: Response) => void;
  const api = vi.spyOn(globalThis, "fetch").mockImplementation(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const running = startPhoneRun(task());
  await vi.waitFor(() => expect(api).toHaveBeenCalledTimes(1));
  await send("NEXT_ROUND");
  release(response("DONE"));
  await running;
  expect(JSON.stringify(api.mock.calls[0][1])).not.toContain("NEXT_ROUND");
  expect(
    (await rows()).filter((r) => r.pending).map((r) => r.body.text),
  ).toEqual(["NEXT_ROUND"]);
});
it("rejects duplicate runs and preserves original outputs on invalid rewrite", async () => {
  await send("HELLO");
  const api = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(response("ORIGINAL"));
  await startPhoneRun(task());
  const run = (await db.phoneRuns.toArray())[0];
  api.mockResolvedValue(
    new Response(
      JSON.stringify({
        choices: [
          { message: { content: '{"messages":[],' }, finish_reason: "stop" },
        ],
      }),
    ),
  );
  await expect(continuePhoneRun(run.id, true)).rejects.toThrow();
  expect(
    (await rows()).filter((r) => !r.deleted).map((r) => r.body.text),
  ).toContain("ORIGINAL");
  expect((await db.phoneRuns.get(run.id))?.status).toBe("failed");
});
it("historical rewrite uses frozen phone background and replaces the whole output without touching later messages", async () => {
  await db.phoneBackgrounds.add({id:"old-background",storyId:s.id,title:"承接背景",text:"OLD_PROSE",audience:[s.partner],enabled:true,updated:1});
  await send("HELLO");
  const api = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(response("ORIGINAL"));
  await startPhoneRun(task());
  const run = (await db.phoneRuns.toArray())[0];
  await db.phoneBackgrounds.update("old-background",{text:"FUTURE_PROSE"});
  await send("FUTURE_PHONE");
  api.mockResolvedValue(response("REPLACEMENT"));
  await continuePhoneRun(run.id, true);
  const request = JSON.stringify(api.mock.calls[1][1]);
  expect(request).toContain("OLD_PROSE");
  expect(request).not.toContain("FUTURE_PROSE");
  expect(request).not.toContain("FUTURE_PHONE");
  expect(
    (await rows()).filter((r) => !r.deleted).map((r) => r.body.text),
  ).toEqual(["HELLO", "REPLACEMENT", "FUTURE_PHONE"]);
  expect(
    (await rows()).find((r) => r.body.text === "ORIGINAL")?.versions.length,
  ).toBeGreaterThan(1);
});
it("does not adopt a late result after cancellation", async () => {
  await send("HELLO");
  let release!: (r: Response) => void;
  const api = vi.spyOn(globalThis, "fetch").mockImplementation(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const running = startPhoneRun(task());
  const rejected = expect(running).rejects.toThrow("停止");
  await vi.waitFor(() => expect(api).toHaveBeenCalled());
  stopPhone(s.id);
  release(response("LATE"));
  await rejected;
  expect((await rows()).map((r) => r.body.text)).toEqual(["HELLO"]);
  expect((await db.phoneRuns.toArray())[0].status).toBe("interrupted");
});
it("retains versions and detects an edit conflict", async () => {
  const r = await send("BEFORE");
  await editRecord(r.id, { body: body("AFTER") }, r.versionId);
  await expect(
    editRecord(r.id, { deleted: true }, r.versionId),
  ).rejects.toThrow("已改变");
  const changed = (await db.phoneRecords.get(r.id))!;
  await editRecord(r.id, { body: changed.versions[0].body }, changed.versionId);
  expect((await db.phoneRecords.get(r.id))?.body.text).toBe("BEFORE");
});
it.each(["legacy", "stream"])(
  "round-trips all phone relationships with %s backup",
  async (method) => {
    await send("TEXT");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(response("REPLY"));
    await startPhoneRun(task());
    const post = await addRecord(s.id, {
      kind: "moment",
      speakerId: s.player,
      audience: [s.player, s.partner],
      body: body("POST"),
    });
    await addRecord(s.id, {
      kind: "comment",
      parentId: post.id,
      speakerId: s.partner,
      body: body("COMMENT"),
    });
    await likeMoment(post.id, s.partner);
    const assetId = uid();
    await db.phoneAssets.add({
      id: assetId,
      storyId: s.id,
      name: "local.png",
      mime: "image/png",
      data: "data:image/png;base64,aGVsbG8=",
      size: 5,
    });
    await editRecord(post.id, { body: { ...post.body, assets: [assetId] } });
    await updateDevice(s.id, s.player, (d) => ({
      ...d,
      skin: { ...d.skin, wallpaper: assetId, theme: "pink" },
      composerDrafts: {
        [cid]: {
          body: { ...body("DRAFT_ASSET"), assets: [assetId] },
          time: "2026-10-18T18:00",
          situation: "草稿情境",
        },
      },
    }));

    const backup =
      method === "legacy"
        ? await exportBackup()
        : JSON.parse(await (await exportBackupBlob(uid(), s.id)).blob.text());
    expect(backup.version).toBe(11);
    validateBackup(backup);
    if (method === "legacy") await importBackup(backup);
    else {
      const session = uid();
      await stageBackup(new Blob([JSON.stringify(backup)]), session);
      await commitStaged(session, { replace: false, applySettings: false });
    }
    const copy = (await db.stories.toArray()).find((x) => x.id !== s.id)!;
    const records = await db.phoneRecords
      .where("storyId")
      .equals(copy.id)
      .toArray();
    expect(records).toHaveLength(4);
    expect(records.find((r) => r.kind === "comment")?.parentId).toBe(
      records.find((r) => r.kind === "moment")?.id,
    );
    expect(
      records.every((r) =>
        r.audience.every((id) => copy.roles.some((role) => role.id === id)),
      ),
    ).toBe(true);
    const copiedAsset = (
      await db.phoneAssets.where("storyId").equals(copy.id).toArray()
    )[0];
    const copiedSpace = (await db.phoneSpaces
      .where("storyId")
      .equals(copy.id)
      .first())!;
    const copiedDevice = copiedSpace.devices[copy.player];
    expect(copiedAsset.id).not.toBe(assetId);
    expect(copiedAsset.data).toBe("data:image/png;base64,aGVsbG8=");
    expect(copiedDevice.skin.wallpaper).toBe(copiedAsset.id);
    expect(Object.values(copiedDevice.composerDrafts!)[0].body.assets).toEqual([
      copiedAsset.id,
    ]);
    expect(records.find((r) => r.kind === "moment")?.body.assets).toEqual([
      copiedAsset.id,
    ]);
    validateBackup(await exportBackup());
  },
);
it("exports only independent phone material and cascades deletion", async () => {
  await db.events.add(prose("MAINLINE"));
  await send("APPENDIX");
  const result = await exportWork(uid(), {
    storyId: s.id,
    content: "all",
    range: "all",
    from: 1,
    to: 99,
    background: false,
    characters: false,
    format: "txt",
    fontSize: 16,
    lineHeight: 1.6,
    pageBreak: false,
  });
  const text = await result.blob.text();
  expect(text).not.toContain("MAINLINE");
  expect(text).toContain("手机记录");
  expect(text).toContain("APPENDIX");
  await deleteStory(s.id);
  expect(await db.phoneRecords.count()).toBe(0);
  expect(await db.phoneConversations.count()).toBe(0);
  expect(await db.phoneSpaces.count()).toBe(0);
});
it("rejects references to another story in writes and backups", async () => {
  const other = makeStory("phone", "OTHER", s.roles);
  await db.stories.add(other);
  await ensurePhone(other.id);
  const foreign = await addRecord(other.id, {
    kind: "moment",
    speakerId: other.player,
    audience: [other.player],
    body: body("FOREIGN"),
  });
  await expect(
    addRecord(s.id, {
      kind: "comment",
      speakerId: s.player,
      parentId: foreign.id,
      body: body("BAD"),
    }),
  ).rejects.toThrow();
  const own = await send("OWN"),
    backup = await exportBackup();
  backup.phoneRecords.find((r) => r.id === own.id)!.parentId = foreign.id;
  expect(() => validateBackup(backup)).toThrow("跨越故事");
});

it("resumes a partial historical rewrite after refresh without replacing originals early", async () => {
  cid = await conversation(s, [s.player, s.partner, "third"], "群聊", true);
  await send("START");
  const api = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(response("OLD_ONE"))
    .mockResolvedValueOnce(response("OLD_TWO"));
  await startPhoneRun({ ...task(), speakers: [s.partner, "third"] });
  const run = (await db.phoneRuns.toArray())[0];
  api
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  messages: [
                    { type: "transfer", text: "NEW_ONE", amount: "23.00" },
                  ],
                }),
              },
              finish_reason: "stop",
            },
          ],
        }),
      ),
    )
    .mockRejectedValueOnce(Error("failed second"));
  await expect(continuePhoneRun(run.id, true)).rejects.toThrow("failed second");
  expect(
    (await rows()).filter((r) => !r.deleted).map((r) => r.body.text),
  ).toEqual(["START", "OLD_ONE", "OLD_TWO"]);
  db.close();
  await db.open();
  await initializePhones();
  api.mockResolvedValueOnce(response("NEW_TWO"));
  await continuePhoneRun(run.id);
  expect(api).toHaveBeenCalledTimes(5);
  expect(
    (await rows()).filter((r) => !r.deleted).map((r) => r.body.text),
  ).toEqual(["START", "NEW_ONE", "NEW_TWO"]);
  expect(JSON.stringify(api.mock.calls[4][1])).toContain("NEW_ONE");
  expect(JSON.stringify(api.mock.calls[4][1])).toContain("23.00");
  expect((await db.phoneRuns.get(run.id))?.rewriteBase).toBeUndefined();
});
it("rejects an audience change while the model is replying", async () => {
  cid = await conversation(s, [s.player, s.partner], "原来的群", true);
  await send("PRIVATE_START");
  let release!: (r: Response) => void;
  const api = vi.spyOn(globalThis, "fetch").mockImplementation(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const running = startPhoneRun(task());
  const rejected = expect(running).rejects.toThrow("群成员已改变");
  await vi.waitFor(() => expect(api).toHaveBeenCalled());
  await changeGroup(cid, "扩大的群", [s.player, s.partner, "third"], s.player);
  release(response("PRIVATE_RESULT"));
  await rejected;
  expect((await rows()).some((r) => r.body.text === "PRIVATE_RESULT")).toBe(
    false,
  );
});
it("keeps third-party private chats and private moments outside another role's reference", async () => {
  const privateChat = await conversation(s, [s.player, "third"]);
  await addRecord(s.id, {
    conversationId: privateChat,
    speakerId: "third",
    body: body("OTHER_PRIVATE_CHAT"),
  });
  const moment = await addRecord(s.id, {
    kind: "moment",
    speakerId: "third",
    audience: ["third"],
    body: body("OTHER_PRIVATE_MOMENT"),
  });
  await addRecord(s.id, {
    kind: "comment",
    speakerId: "third",
    parentId: moment.id,
    body: body("OTHER_PRIVATE_COMMENT"),
  });
  await send("HELLO");
  const api = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(response("ANSWER"));
  await startPhoneRun(task());
  const request = JSON.stringify(api.mock.calls[0][1]);
  for (const secret of [
    "OTHER_PRIVATE_CHAT",
    "OTHER_PRIVATE_MOMENT",
    "OTHER_PRIVATE_COMMENT",
  ])
    expect(request).not.toContain(secret);
});
it("ignores deleted moments and their comments in future references", async () => {
  const post = await addRecord(s.id, {
    kind: "moment",
    speakerId: s.player,
    audience: [s.player, s.partner],
    body: body("DELETED_MOMENT"),
  });
  await addRecord(s.id, {
    kind: "comment",
    speakerId: s.partner,
    parentId: post.id,
    body: body("ORPHAN_COMMENT"),
  });
  await editRecord(post.id, { deleted: true });
  await send("HELLO");
  const api = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(response("ANSWER"));
  await startPhoneRun(task());
  expect(JSON.stringify(api.mock.calls[0][1])).not.toContain("ORPHAN_COMMENT");
  const exported = await exportWork(uid(), { storyId: s.id, content: "chat", range: "all", from: 1, to: 99, background: false, characters: false, format: "txt", fontSize: 16, lineHeight: 1.6, pageBreak: false });
  expect(await exported.blob.text()).not.toContain("ORPHAN_COMMENT");

});
it("rejects unknown output identities and context overflow without adopting output", async () => {
  await send("HELLO");
  const api = vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                messages: [
                  { type: "text", text: "FORGED", speakerId: "third" },
                ],
              }),
            },
            finish_reason: "stop",
          },
        ],
      }),
    ),
  );
  await expect(startPhoneRun(task())).rejects.toThrow("格式未通过");
  expect((await rows()).map((r) => r.body.text)).toEqual(["HELLO"]);
  await db.phoneRuns.clear();
  await db.profiles.update("phone-fixture", { context: 1000, maxOutput: 800 });
  await expect(startPhoneRun(task())).rejects.toThrow("上下文容量");
  expect(api).toHaveBeenCalledTimes(1);
});
it("migrates a draft without messages and preserves deleted versions and both pending directions", async () => {
  await db.phoneSpaces.clear();
  await db.phoneConversations.clear();
  await db.stories.update(s.id, { chatDraft: "DRAFT_ONLY" });
  const space = await ensurePhone(s.id);
  cid = (await db.phoneConversations.toArray())[0].id;
  expect(space.devices[s.player].drafts[cid]).toBe("DRAFT_ONLY");
  await db.phoneSpaces.clear();
  const a = prose("DELETED", 1, {
    kind: "message",
    speaker: s.player,
    participants: [s.player, s.partner],
    origin: "user",
    deleted: true,
    chatPending: true,
  });
  a.versions.push({ ...a.versions[0], id: uid(), text: "OLDER" });
  const b = prose("REVERSE", 2, {
    kind: "message",
    speaker: s.partner,
    participants: [s.partner, s.player],
    origin: "user",
    chatPending: true,
  });
  await db.events.bulkAdd([a, b]);
  await ensurePhone(s.id);
  await ensurePhone(s.id);
  expect(await db.phoneConversations.count()).toBe(1);
  expect((await rows())[0]).toMatchObject({
    deleted: true,
    pending: true,
    speakerId: s.player,
  });
  expect((await rows())[0].versions).toHaveLength(2);
  expect((await rows())[1]).toMatchObject({
    pending: true,
    speakerId: s.partner,
  });
});
it("prevents duplicate clicks from scheduling two requests", async () => {
  await send("HELLO");
  let release!: (r: Response) => void;
  const api = vi.spyOn(globalThis, "fetch").mockImplementation(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const running = startPhoneRun(task());
  await vi.waitFor(() => expect(api).toHaveBeenCalled());
  await expect(startPhoneRun(task())).rejects.toThrow("正在生成");
  release(response("ONCE"));
  await running;
  expect(api).toHaveBeenCalledTimes(1);
  expect(await db.phoneRuns.count()).toBe(1);
});

it("keeps all current input when a continuous send contains more than twenty bubbles", async () => {
  for (let n = 1; n <= 25; n++) await send(`PENDING_MESSAGE_${n}_END`);
  const api = vi.spyOn(globalThis, "fetch").mockResolvedValue(response("DONE"));
  await startPhoneRun(task());
  const request = JSON.stringify(api.mock.calls[0][1]);
  for (let n = 1; n <= 25; n++)
    expect(request).toContain(`PENDING_MESSAGE_${n}_END`);
});
it("rejects oversized or unsupported local media before storing anything", async () => {
  await expect(
    saveAsset(s.id, { size: 10 * 1024 * 1024 + 1, type: "image/png" } as File),
  ).rejects.toThrow("10 MiB");
  await expect(
    saveAsset(s.id, { size: 100, type: "text/html" } as File),
  ).rejects.toThrow("支持 PNG");
  expect(await db.phoneAssets.count()).toBe(0);
});
it("preserves legacy failed drafts without treating them as accepted phone experience", async () => {
  await db.phoneSpaces.clear();
  const draft = prose("UNACCEPTED_TEXT", 1, {
    kind: "message",
    speaker: s.partner,
    participants: [s.player, s.partner],
    status: "draft",
    raw: "UNFINISHED_RAW",
    error: "old failure",
  });
  await db.events.add(draft);
  await ensurePhone(s.id);
  await send("HELLO");
  const api = vi.spyOn(globalThis, "fetch").mockResolvedValue(response("DONE"));
  await startPhoneRun(task());
  expect((await rows())[0].legacyDraft).toEqual({
    raw: "UNFINISHED_RAW",
    error: "old failure",
  });
  expect(JSON.stringify(api.mock.calls[0][1])).not.toContain("UNACCEPTED_TEXT");
});
