import "fake-indexeddb/auto";
import { beforeEach, afterEach, it, expect, vi } from "vitest";
import {
  db,
  initialize,
  deleteStory,
  sessionKeys,
  worldForStory,
} from "../src/db";
import { createStory, migrateStories, updateStory } from "../src/story-service";
import {
  addRecord,
  conversation,
  editRecord,
  ensurePhone,
} from "../src/phone-store";
import { emptyBody } from "../src/phone-types";
import { uid, type Story, type SceneEvent } from "../src/types";
import { phoneContext } from "../src/phone-context";
import {
  savePhoneDocument,
  parseScript,
  copyComposition,
  saveComposition,
  adoptComposition,
  batchMessages,
  undoPhoneEdit,
  generateVariant,
  stopVariant,
} from "../src/phone-authoring";
import {
  ensureReading,
  saveReading,
  buildReaderPackage,
  validateReader,
  createReaderHTML,
} from "../src/phone-reader";
import { exportBackup, importBackup, validateBackup } from "../src/backup";
import {
  exportBackupBlob,
  stageBackup,
  commitStaged,
} from "../src/backup-transfer";
import { preview } from "../src/engine";
import { startPhoneRun } from "../src/phone-generation";

let novel: Story;
beforeEach(async () => {
  await db.delete();
  await db.open();
  await initialize();
  novel = (await db.stories.toArray())[0];
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  sessionKeys.clear();
});
const phone = () =>
  createStory({
    kind: "phone",
    title: "手机作品",
    roles: novel.roles,
    worldIds: [],
    background: "公开开场",
    secret: "AUTHOR_SECRET",
  });
const event = (
  s: Story,
  text: string,
  seq = 1,
  patch: Partial<SceneEvent> = {},
): SceneEvent => {
  const id = uid(),
    versionId = uid();
  return {
    id,
    storyId: s.id,
    seq,
    round: seq,
    kind: "novel",
    origin: "user",
    speaker: "",
    participants: s.roles.map((r) => r.id),
    input: text,
    text,
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
};
async function legacy() {
  await db.stories.update(novel.id, {
    kind: undefined as any,
    worldIds: (await db.world.toArray()).map((w) => w.id),
  });
  return { ...novel, kind: undefined } as any as Story;
}
async function requestContext(s: Story, speaker = s.player) {
  return phoneContext(
    s.id,
    speaker,
    s.roles.map((r) => r.id),
    "",
    (await db.preferences.get("preferences"))!,
  );
}
async function message(s: Story, text: string, speaker = s.player) {
  const cid = await conversation(s, [s.player, s.partner]);
  return addRecord(s.id, {
    speakerId: speaker,
    conversationId: cid,
    body: { ...emptyBody(), text },
  });
}

it("requires an explicit immutable mode and copies characters and worlds", async () => {
  await expect(
    createStory({
      kind: undefined as any,
      title: "bad",
      roles: novel.roles,
      worldIds: [],
      background: "",
    }),
  ).rejects.toThrow("模式");
  const world = (await db.world.toArray())[0];
  const s = await createStory({
    kind: "phone",
    title: "独立",
    roles: novel.roles,
    worldIds: [world.id],
    background: "已知背景",
  });
  expect(s.roles[0].id).not.toBe(novel.roles[0].id);
  await db.world.update(world.id, { text: "CHANGED_LIBRARY" });
  expect((await worldForStory(s))[0].text).not.toBe("CHANGED_LIBRARY");
  await expect(updateStory(s.id, { kind: "novel" })).rejects.toThrow(
    "不能更改",
  );
  await expect(ensurePhone(novel.id)).rejects.toThrow();
  await expect(preview(s.id, "novel", "test")).rejects.toThrow("手机作品");
});
it("splits even an empty old work once and preserves original novel identity", async () => {
  const old = await legacy(),
    api = vi.spyOn(globalThis, "fetch");
  await migrateStories();
  await migrateStories();
  const stories = await db.stories.toArray();
  expect(stories).toHaveLength(2);
  expect(stories.find((s) => s.id === old.id)?.title).toBe(old.title + "·小说");
  expect(stories.find((s) => s.kind === "phone")?.title).toBe(
    old.title + "·手机",
  );
  expect(await db.storyMigrations.count()).toBe(2);
  expect(api).not.toHaveBeenCalled();
});
it("copies only allowed prose and valid memories, archives mixed sources, and disconnects later edits", async () => {
  const old = await legacy(),
    publicEvent = event(old, "VISIBLE_PROSE", 1),
    secret = event(old, "HIDDEN_SECRET", 2, { visibility: "author" }),
    fact = event(old, "PRIVATE_TEXT", 3, {
      visibility: "facts",
      facts: [
        {
          id: uid(),
          text: "ALLOWED_FACT",
          quote: "ALLOWED_FACT",
          knownBy: [old.partner],
        },
      ],
    }),
    chat = event(old, "OLD_PHONE", 4, {
      kind: "message",
      speaker: old.player,
      participants: [old.player, old.partner],
      chatPending: true,
    });
  await db.events.bulkAdd([publicEvent, secret, fact, chat]);
  await db.memories.add({
    id: uid(),
    storyId: old.id,
    text: "MIXED_MEMORY",
    knownBy: [old.partner],
    scope: "roles",
    sources: [{ id: chat.id, versionId: chat.versionId }],
    status: "accepted",
    created: 1,
  } as any);
  await migrateStories();
  const s = (await db.stories.where("kind").equals("phone").toArray())[0];
  expect(
    (await db.phoneRecords.where("storyId").equals(s.id).toArray())[0].body
      .text,
  ).toBe("OLD_PHONE");
  expect((await db.events.toArray()).every((e) => e.kind === "novel")).toBe(
    true,
  );
  expect(await db.legacyArchives.count()).toBe(2);
  const partner = await requestContext(s, s.partner),
    player = await requestContext(s, s.player);
  expect(partner).toContain("VISIBLE_PROSE");
  expect(partner).toContain("ALLOWED_FACT");
  expect(player).not.toContain("ALLOWED_FACT");
  expect(partner).not.toContain("HIDDEN_SECRET");
  expect(partner).not.toContain("MIXED_MEMORY");
  await db.events.update(publicEvent.id, { text: "NOVEL_CHANGED" });
  await deleteStory(old.id);
  expect(await requestContext(s, s.partner)).toContain("VISIBLE_PROSE");
  expect(await requestContext(s, s.partner)).not.toContain("NOVEL_CHANGED");
});
it("retains all old known background but enables only the previous context window", async () => {
  const old = await legacy();
  await db.events.bulkAdd(
    Array.from({ length: 30 }, (_, i) => event(old, "PROSE_" + i, i + 1)),
  );
  await migrateStories();
  const s = (await db.stories.where("kind").equals("phone").toArray())[0],
    rows = await db.phoneBackgrounds.where("storyId").equals(s.id).toArray();
  expect(rows).toHaveLength(60);
  expect(
    rows.filter((r) => r.enabled && r.audience.includes(s.player)).length,
  ).toBeLessThanOrEqual(20);
  expect(rows.some((r) => !r.enabled)).toBe(true);
});
it("rolls back a failed split without leaving half a pair", async () => {
  await legacy();
  const add = vi
    .spyOn(db.storyMigrations, "add")
    .mockRejectedValueOnce(Error("QuotaExceededError"));
  await expect(migrateStories()).rejects.toThrow("Quota");
  expect(await db.stories.count()).toBe(1);
  expect((await db.stories.get(novel.id))?.kind).toBeUndefined();
  expect(await db.phoneBackgrounds.count()).toBe(0);
  add.mockRestore();
  await migrateStories();
  expect(await db.stories.count()).toBe(2);
});
it("phone prompts never read another work or author secrets and include only authorized documents", async () => {
  const s = await phone();
  await db.events.add(event(novel, "NOVEL_ONLY"));
  const note = await savePhoneDocument({
    storyId: s.id,
    ownerId: s.player,
    kind: "note",
    title: "私事",
    text: "OWNER_NOTE",
  });
  expect(await requestContext(s, s.player)).toContain("OWNER_NOTE");
  expect(await requestContext(s, s.partner)).not.toContain("OWNER_NOTE");
  expect(await requestContext(s)).not.toContain("NOVEL_ONLY");
  expect(await requestContext(s)).not.toContain("AUTHOR_SECRET");
  const changed = await savePhoneDocument(
    { ...note, text: "NEW_NOTE", audience: [s.player, s.partner] },
    note.versionId,
  );
  expect(await requestContext(s, s.partner)).toContain("NEW_NOTE");
  await expect(
    savePhoneDocument({ ...note, text: "STALE" }, note.versionId),
  ).rejects.toThrow("改变");
  await savePhoneDocument({ ...changed, text: note.text }, changed.versionId);
  expect((await db.phoneDocuments.get(note.id))?.versions).toHaveLength(3);
});
it("keeps editor drafts out of narrative documents and blocks foreign assets", async () => {
  const a = await phone(),
    b = await phone();
  await db.phoneAssets.add({
    id: "foreign",
    storyId: b.id,
    name: "image",
    mime: "image/png",
    data: "data:image/png;base64,AA==",
    size: 1,
  });
  await expect(
    savePhoneDocument({
      storyId: a.id,
      ownerId: a.player,
      kind: "photo",
      title: "X",
      assets: ["foreign"],
    }),
  ).rejects.toThrow("本作品");
  expect(await db.phoneDocuments.count()).toBe(0);
});
it("parses scripts without guessing duplicate or unknown character names", () => {
  const story = {
    ...novel,
    roles: [...novel.roles, { ...novel.roles[0], id: "duplicate" }],
  };
  const rows = parseScript(
    `${novel.roles[0].name}：第一行\n继续\n陌生人：第二行`,
    story,
  );
  expect(rows[0].error).toBeTruthy();
  expect(rows[0].text).toContain("继续");
  expect(rows[1].error).toBeTruthy();
  expect(
    parseScript(`${novel.roles[0].name}：可以`, story, {
      [novel.roles[0].name]: novel.player,
    })[0].speakerId,
  ).toBe(novel.player);
});
it("reorders and changes story time atomically, retaining IDs, audiences and creation time with undo", async () => {
  const s = await phone(),
    a = await message(s, "first"),
    b = await message(s, "second", s.partner);
  const edit = await batchMessages(
    s.id,
    a.conversationId,
    { [a.id]: a.versionId, [b.id]: b.versionId },
    { order: [b.id, a.id], time: "2025-01-01T09:00" },
  );
  const rows = await db.phoneRecords
    .where("storyId")
    .equals(s.id)
    .sortBy("seq");
  expect(rows.map((r) => r.id)).toEqual([b.id, a.id]);
  expect(rows[1].created).toBe(a.created);
  expect(rows[1].audience).toEqual(a.audience);
  await undoPhoneEdit(edit.id);
  expect(
    (await db.phoneRecords.where("storyId").equals(s.id).sortBy("seq")).map(
      (r) => r.body.text,
    ),
  ).toEqual(["first", "second"]);
});
it("keeps variants separate until adoption and refuses stale replacements", async () => {
  const s = await phone(),
    a = await message(s, "original"),
    d = await copyComposition(s.id, a.conversationId, [a.id]);
  d.lines[0].body.text = "variant";
  const saved = await saveComposition(d);
  expect((await db.phoneRecords.get(a.id))?.body.text).toBe("original");
  const edit = await adoptComposition(saved.id);
  expect((await db.phoneRecords.get(a.id))?.deleted).toBe(true);
  expect((await db.phoneRecords.get(edit.added[0]))?.body.text).toBe("variant");
  await undoPhoneEdit(edit.id);
  expect((await db.phoneRecords.get(a.id))?.deleted).toBe(false);
  const stale = await copyComposition(s.id, a.conversationId, [a.id]);
  await editRecord(a.id, { body: { ...emptyBody(), text: "edited" } });
  await expect(adoptComposition(stale.id)).rejects.toThrow("原消息已修改");
});
it("packages only chosen current content and local assets, never author or recovery data", async () => {
  const s = await phone(),
    a = await message(s, "PUBLIC"),
    b = await message(s, "OMITTED");
  await editRecord(a.id, { body: { ...emptyBody(), text: "CURRENT" } });
  const note = await savePhoneDocument({
    storyId: s.id,
    ownerId: s.partner,
    kind: "note",
    title: "Private",
    text: "PRIVATE_DOC",
  });
  let cfg = await ensureReading(s.id);
  cfg = await saveReading({
    ...cfg,
    owners: [s.player],
    initialOwner: s.player,
    selectedRecords: [a.id],
    selectedDocuments: [],
  });
  const data = await buildReaderPackage(s.id, cfg),
    html = createReaderHTML(data);
  expect(html).toContain("CURRENT");
  for (const excluded of [
    "AUTHOR_SECRET",
    "OMITTED",
    "PRIVATE_DOC",
    "fixture-key",
    "phoneRuns",
    "versionId",
  ]) {
    expect(JSON.stringify(data)).not.toContain(excluded);
  }
  expect(JSON.stringify(data)).not.toContain('"text":"PUBLIC"');
  expect(data.documents).toHaveLength(0);
  expect(validateReader(data)).toEqual([]);
  expect(b.id).not.toBe(a.id);
  expect(note.ownerId).toBe(s.partner);
});
it("escapes HTML script boundaries in offline packages", async () => {
  const s = await phone();
  await message(s, '</script><script>alert("XSS")</script>');
  const data = await buildReaderPackage(s.id);
  const html = createReaderHTML(data);
  expect(html).toContain("\\u003c/script>");
  expect(html).not.toContain('</script><script>alert("XSS")');
});
it("validates cross-phone read clues, missing references and unreachable cycles", async () => {
  const s = await phone(),
    a = await message(s, "clue"),
    b = await message(s, "locked");
  let cfg = await ensureReading(s.id);
  cfg = {
    ...cfg,
    mode: "clues",
    rules: [
      {
        id: "a",
        title: "锁",
        targets: [{ ownerId: s.player, type: "record", id: b.id }],
        match: "all",
        conditions: [
          {
            type: "read",
            target: { ownerId: s.partner, type: "record", id: a.id },
          },
        ],
        hint: "",
        error: "",
        notification: "解开了",
      },
    ],
  };
  expect(validateReader(await buildReaderPackage(s.id, cfg))).toEqual([]);
  cfg.rules[0].conditions = [
    { type: "read", target: { ownerId: s.player, type: "record", id: b.id } },
  ];
  expect(validateReader(await buildReaderPackage(s.id, cfg)).join()).toContain(
    "循环",
  );
  cfg.rules[0].conditions = [
    {
      type: "read",
      target: { ownerId: s.player, type: "record", id: "missing" },
    },
  ];
  expect(validateReader(await buildReaderPackage(s.id, cfg)).join()).toContain(
    "不存在",
  );
});
it("round trips v6 documents, variants, rules, copied worlds and background through both import routes", async () => {
  const s = await phone(),
    a = await message(s, "ROUNDTRIP"),
    d = await copyComposition(s.id, a.conversationId, [a.id]);
  await savePhoneDocument({
    storyId: s.id,
    ownerId: s.player,
    kind: "draft",
    title: "未发送",
    text: "明天见",
    recipientId: s.partner,
  });
  await ensureReading(s.id);
  const raw = await exportBackup();
  expect(raw.version).toBe(8);
  validateBackup(raw);
  await importBackup(raw);
  const imported = (
    await db.stories.where("kind").equals("phone").toArray()
  ).find((x) => x.id !== s.id)!;
  expect(
    (await db.phoneDrafts.where("storyId").equals(imported.id).toArray())[0].id,
  ).not.toBe(d.id);
  const blob = (await exportBackupBlob(uid(), s.id)).blob;
  const summary = await stageBackup(new Blob([blob]), uid());
  await commitStaged(summary.session, { replace: false, applySettings: false });
  const phones = await db.stories.where("kind").equals("phone").toArray();
  expect(phones).toHaveLength(3);
  for (const p of phones) {
    expect(
      (await db.phoneDocuments.where("storyId").equals(p.id).toArray())[0]
        .recipientId,
    ).toBe(p.partner);
    expect((await buildReaderPackage(p.id)).records[0].speakerId).toBe(
      p.player,
    );
  }
});
it("deleting either split work leaves the other work and its own assets intact", async () => {
  await legacy();
  await migrateStories();
  const s = (await db.stories.where("kind").equals("phone").toArray())[0];
  await message(s, "keep");
  await savePhoneDocument({
    storyId: s.id,
    ownerId: s.player,
    kind: "note",
    title: "keep",
    text: "keep",
  });
  await deleteStory(novel.id);
  expect(await db.phoneDocuments.count()).toBe(1);
  await deleteStory(s.id);
  expect(await db.phoneDocuments.count()).toBe(0);
  expect(await db.storyWorld.count()).toBe(0);
});

it.each([1, 2, 3, 4, 5])(
  "imports version %i as new independent copies using both import routes",
  async (version) => {
    const old: any = await exportBackup();
    old.version = version;
    old.stories[0].kind = undefined;
    old.stories[0].worldIds = old.world.map((w: any) => w.id);
    for (const name of [
      "storyWorld",
      "storyMigrations",
      "legacyArchives",
      "phoneBackgrounds",
      "phoneDocuments",
      "phoneReading",
      "phoneDrafts",
      "phoneEdits",
    ])
      delete old[name];
    if (version < 5)
      for (const name of [
        "phoneSpaces",
        "phoneConversations",
        "phoneRecords",
        "phoneAssets",
        "phoneRuns",
      ])
        delete old[name];
    if (version < 2) delete old.theaters;
    await importBackup(old);
    expect(await db.stories.count()).toBe(3);
    const session = "legacy-" + version;
    await stageBackup(new Blob([JSON.stringify(old)]), session);
    await commitStaged(session, { replace: false, applySettings: false });
    expect(await db.stories.count()).toBe(5);
    expect(await db.stories.where("kind").equals("phone").count()).toBe(2);
    await migrateStories();
    expect(await db.stories.count()).toBe(5);
    validateBackup(await exportBackup());
  },
);
async function variantFixture() {
  const s = await phone(),
    a = await message(s, "first"),
    b = await addRecord(
      s.id,
      {
        conversationId: a.conversationId,
        speakerId: s.player,
        audience: [s.player],
        body: { ...emptyBody(), text: "narrow audience" },
      },
      true,
    );
  const draft = await copyComposition(s.id, a.conversationId, [b.id, a.id]);
  await db.profiles.add({
    id: "variant",
    name: "mock",
    protocol: "chat",
    url: "https://variant.fixture.test/v1",
    model: "mock",
    context: 64000,
    maxOutput: 2000,
    timeout: 10,
    stream: false,
    remember: false,
  });
  sessionKeys.set("variant", "test-key");
  await db.preferences.update("preferences", { activeProfile: "variant" });
  return { s, a, b, draft };
}
const variantResponse = (text: string) =>
  new Response(
    JSON.stringify({
      choices: [
        {
          message: { content: JSON.stringify({ messages: [{ text }] }) },
          finish_reason: "stop",
        },
      ],
    }),
    { headers: { "content-type": "application/json" } },
  );
it("AI variants keep every original audience and do not enter experience before adoption", async () => {
  const { s, a, b, draft } = await variantFixture();
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(variantResponse("first variant"))
    .mockResolvedValueOnce(variantResponse("private variant"));
  vi.stubGlobal("fetch", fetcher);
  await generateVariant(draft.id, "保留知情范围");
  const generated = (await db.phoneDrafts.get(draft.id))!;
  expect(generated.lines.map((l) => l.sourceId)).toEqual([a.id, b.id]);
  expect(generated.lines.map((l) => l.audience)).toEqual([
    a.audience,
    b.audience,
  ]);
  expect((await db.phoneRecords.get(a.id))?.body.text).toBe("first");
  const adopted = await adoptComposition(draft.id);
  expect(
    (await db.phoneRecords.bulkGet(adopted.added)).map((r) => r?.audience),
  ).toEqual([a.audience, b.audience]);
  expect(await db.events.count()).toBe(0);
  expect(fetcher).toHaveBeenCalledTimes(2);
});
it("pending variant blocks reordering and normal generation while new messages remain sendable; cancellation preserves the draft", async () => {
  const { s, a, draft } = await variantFixture();
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
  const job = generateVariant(draft.id, "稍作改写");
  const rejected = expect(job).rejects.toThrow("停止");
  await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
  await expect(
    batchMessages(
      s.id,
      a.conversationId,
      { [a.id]: a.versionId },
      { time: "2026-06-12T21:01" },
    ),
  ).rejects.toThrow("正在生成");
  await expect(
    startPhoneRun({
      storyId: s.id,
      ownerId: s.player,
      conversationId: a.conversationId,
      speakers: [s.partner],
      mode: "participate",
    }),
  ).rejects.toThrow("正在生成");
  const next = await message(s, "NEXT_ROUND");
  stopVariant(draft.id);
  finish(variantResponse("late"));
  await rejected;
  expect((await db.phoneDrafts.get(draft.id))?.lines).toEqual(draft.lines);
  expect((await db.phoneRecords.get(next.id))?.body.text).toBe("NEXT_ROUND");
});
it("streaming validation rejects missing work types and crossed prose records in version 6", async () => {
  const s = await phone(),
    original = await exportBackup();
  const missing = structuredClone(original) as any;
  delete missing.stories[0].kind;
  await expect(
    stageBackup(new Blob([JSON.stringify(missing)]), "missing-kind"),
  ).rejects.toThrow("缺少类型");
  const crossed = structuredClone(original);
  crossed.events.push(event(s, "WRONG_KIND"));
  await expect(
    stageBackup(new Blob([JSON.stringify(crossed)]), "crossed-kind"),
  ).rejects.toThrow("手机作品不能");
  expect(await db.events.count()).toBe(0);
});

it("legacy reference reconstruction uses inherited material and excludes later authored documents", async () => {
  const s = await phone();
  await db.phoneBackgrounds.add({
    id: uid(),
    storyId: s.id,
    title: "承接",
    text: "INHERITED",
    audience: [s.player],
    enabled: true,
    source: { id: "old", version: "v1", seq: 1, kind: "prose" },
    updated: 1,
  });
  await savePhoneDocument({
    storyId: s.id,
    ownerId: s.player,
    kind: "note",
    title: "后来才写",
    text: "LATER_DOCUMENT",
  });
  const context = await phoneContext(
    s.id,
    s.player,
    [s.player, s.partner],
    "",
    (await db.preferences.get("preferences"))!,
    3,
  );
  expect(context).toContain("INHERITED");
  expect(context).not.toContain("LATER_DOCUMENT");
  expect(context).not.toContain("公开开场");
});
it("saving unchanged reading settings preserves the package revision", async () => {
  const s = await phone(),
    cfg = await ensureReading(s.id),
    before = await buildReaderPackage(s.id);
  const saved = await saveReading(cfg);
  expect(saved.revision).toBe(cfg.revision);
  expect((await buildReaderPackage(s.id)).revision).toBe(before.revision);
});
