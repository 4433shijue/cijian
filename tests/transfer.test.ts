import "fake-indexeddb/auto";
import { beforeEach, afterEach, it, expect, vi } from "vitest";
import { unzipSync, strFromU8 } from "fflate";
import { db, initialize, makeStory } from "../src/db";
import { uid, type SceneEvent, type Story } from "../src/types";
import { exportBackup, validateBackup } from "../src/backup";
import {
  stageBackup,
  commitStaged,
  exportBackupBlob,
} from "../src/backup-transfer";
import {
  BackupParser,
  READ_CHUNK_BYTES,
  MAX_RECORD_CHARS,
} from "../src/backup-parser";
import {
  TransferControl,
  clearTransfer,
  cleanupTransfers,
} from "../src/transfer-store";
import { exportWork } from "../src/work-export";
import type { WorkOptions } from "../src/transfer-types";

beforeEach(async () => {
  await db.delete();
  await db.open();
  await initialize();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await db.delete();
});
function event(
  s: Story,
  seq: number,
  patch: Partial<SceneEvent> = {},
): SceneEvent {
  const id = uid(),
    versionId = uid();
  const text = `第${seq}段。中文🫖\n第二行\\反斜线"引号" <script>unsafe</script>`;
  return {
    id,
    storyId: s.id,
    seq,
    kind: "novel",
    input: "作者输入",
    text,
    speaker: "",
    participants: s.roles.map((r) => r.id),
    facts: [],
    versions: [
      { id: versionId, text, input: "作者输入", created: seq, facts: [] },
    ],
    versionId,
    raw: "",
    error: "",
    review: false,
    deleted: false,
    status: "complete",
    created: seq,
    ...patch,
  };
}
async function fixture() {
  const s = (await db.stories.toArray())[0];
  s.stylePresetId = "custom-style";
  s.draft = "未完成的正文输入";
  s.chatDraft = "待发送聊天";
  await db.stories.put(s);
  await db.preferences.update("preferences", {
    prompts: { novel: { text: "备份提示词", enabled: true } },
    stylePresets: [
      {
        id: "custom-style",
        name: "自定义",
        description: "轻盈",
        prompt: "备份文风",
        scope: "novel",
      },
    ],
  });
  const e = event(s, 1);
  const draft = event(s, 3, {
    status: "draft",
    text: "未完成的重写",
    rewriteOf: { id: e.id, versionId: e.versionId },
  });
  await db.events.bulkAdd([
    e,
    event(s, 2, { deleted: true, text: "已删除正文" }),
    draft,
    event(s, 4, { text: "新正文" }),
  ]);
  const batchId = uid();
  const user = event(s, 5, {
    kind: "message",
    origin: "user",
    speaker: s.player,
    text: "这是用户发来的消息",
    chatBatchId: batchId,
  });
  const reply = event(s, 6, {
    kind: "message",
    origin: "ai",
    speaker: s.partner,
    text: "好呀",
    chatBatchId: batchId,
  });
  await db.events.bulkAdd([user, reply]);
  await db.chatBatches.add({
    id: batchId,
    storyId: s.id,
    player: s.player,
    partner: s.partner,
    sources: [{ id: user.id, versionId: user.versionId }],
    messages: [user.text],
    replyIds: [reply.id],
    cutoff: 5,
    status: "complete",
    created: 1,
    updated: 1,
    raw: "",
    error: "",
  });
  await db.memories.add({
    id: uid(),
    storyId: s.id,
    text: "保留记忆",
    knownBy: [s.partner],
    scope: "story",
    sources: [{ id: e.id, versionId: e.versionId }],
    status: "accepted",
    created: 1,
  });
  await db.profiles.add({
    id: "private-profile",
    name: "接口",
    protocol: "chat",
    url: "https://fixture.test/v1",
    model: "test",
    stream: true,
    context: 16000,
    maxOutput: 4096,
    timeout: 120,
    remember: true,
    key: "DO_NOT_EXPORT_KEY",
  });
  return { s, e, draft };
}
const file = (value: unknown) => new Blob([JSON.stringify(value)]);
const workOptions = (
  id: string,
  patch: Partial<WorkOptions> = {},
): WorkOptions => ({
  storyId: id,
  content: "all",
  range: "all",
  from: 1,
  to: 1,
  background: false,
  characters: false,
  format: "txt",
  fontSize: 16,
  lineHeight: 1.8,
  pageBreak: false,
  ...patch,
});

it("streams split Chinese, emoji, escapes and arbitrary top-level field order without reading the whole file", async () => {
  await fixture();
  const original = await exportBackup();
  original.roles[0].persona = '中文🫖\\"\n'.repeat(140_000);
  const blob = file({
    events: original.events,
    ...Object.fromEntries(
      Object.entries(original).filter(([k]) => k !== "events"),
    ),
  });
  const sizes: number[] = [];
  const slice = blob.slice.bind(blob);
  vi.spyOn(blob, "text").mockRejectedValue(Error("whole file forbidden"));
  vi.spyOn(blob, "arrayBuffer").mockRejectedValue(
    Error("whole file forbidden"),
  );
  vi.spyOn(blob, "slice").mockImplementation((start, end) => {
    sizes.push((end || 0) - (start || 0));
    return slice(start, end);
  });
  const summary = await stageBackup(blob, "chunks");
  expect(sizes.length).toBeGreaterThan(1);
  expect(Math.max(...sizes)).toBeLessThanOrEqual(READ_CHUNK_BYTES);
  expect(summary.counts.events).toBe(6);
  expect(await db.stories.count()).toBe(1);
  await commitStaged("chunks", { replace: false, applySettings: true });
  const restored = validateBackup(await exportBackup());
  expect(
    restored.roles.some((r) => r.persona === original.roles[0].persona),
  ).toBe(true);
  const copied = restored.stories.find((s) => s.id !== original.stories[0].id)!;
  expect(copied.draft).toBe("未完成的正文输入");
  expect(copied.chatDraft).toBe("待发送聊天");
  expect(restored.events.filter((e) => e.storyId === copied.id)).toHaveLength(
    6,
  );
  expect(restored.chatBatches).toHaveLength(2);
});

it("scans every character boundary without treating quotes or escaped braces as structure", async () => {
  const b = await exportBackup();
  b.roles[0].persona = '一\\\"二🫖\n{[}]';
  const rows: any[] = [];
  const parser = new BackupParser(async (table, row) => {
    rows.push([table, row]);
  });
  for (const char of JSON.stringify(b)) await parser.push(char);
  parser.finish();
  expect(rows.find(([t]) => t === "roles")[1].persona).toBe(b.roles[0].persona);
});

it("stops an oversized individual record before parsing it or touching the archive", async () => {
  const record = vi.fn();
  const parser = new BackupParser(record);
  await parser.push('{"roles":[{"id":"large","persona":"');
  const chunk = "a".repeat(READ_CHUNK_BYTES);
  for (let i = 0; i < MAX_RECORD_CHARS / READ_CHUNK_BYTES - 1; i++)
    await parser.push(chunk);
  await expect(parser.push(chunk)).rejects.toThrow("单条资料超过");
  expect(record).not.toHaveBeenCalled();
  expect(await db.stories.count()).toBe(1);
});

it.each([
  "truncated",
  "trailing",
  "duplicate",
  "invalid-utf8",
  "bad-reference",
])("rejects %s input without changing the archive", async (kind) => {
  const { e } = await fixture();
  const before = await exportBackup();
  let text = JSON.stringify(before);
  if (kind === "truncated") text = text.slice(0, -3);
  if (kind === "trailing") text += " junk";
  if (kind === "duplicate") text = text.slice(0, -1) + ',"roles":[]}';
  if (kind === "bad-reference") {
    before.memories[0].sources[0].id = "missing";
    text = JSON.stringify(before);
  }
  const blob =
    kind === "invalid-utf8"
      ? new Blob([new Uint8Array([0xff, 0xff])])
      : new Blob([text]);
  await expect(stageBackup(blob, kind)).rejects.toThrow();
  expect(await db.stories.count()).toBe(1);
  expect(await db.events.get(e.id)).toEqual(e);
  await expect(
    commitStaged(kind, { replace: true, applySettings: true }),
  ).rejects.toThrow("预览已失效");
  await clearTransfer(kind);
});

it("duplicate record IDs and crossed chat/memory/rewrite links cannot be activated", async () => {
  await fixture();
  const original = await exportBackup();
  for (const damage of [
    (b: any) => b.events.push(b.events[0]),
    (b: any) => b.chatBatches[0].replyIds.push(b.chatBatches[0].sources[0].id),
    (b: any) =>
      (b.events.find((e: any) => e.rewriteOf).rewriteOf.versionId = "missing"),
  ]) {
    const b = structuredClone(original);
    damage(b);
    const session = uid();
    await expect(stageBackup(file(b), session)).rejects.toThrow();
    await clearTransfer(session);
  }
  expect(await db.events.count()).toBe(6);
});

it("cancels reading after a chunk and retains all original records", async () => {
  const b = await exportBackup();
  b.roles[0].persona = "长人设".repeat(450_000);
  const control = new TransferControl((p) => {
    if (p.phase === "reading") control.cancel();
  });
  await expect(stageBackup(file(b), "cancel-read", control)).rejects.toThrow();
  expect((await db.roles.toArray())[0].persona).not.toBe(b.roles[0].persona);
  await clearTransfer("cancel-read");
  expect(await db.transferRecords.count()).toBe(0);
});

it.each(["cancel", "quota"])(
  "atomically rolls back a replacement on %s after writes have begun",
  async (kind) => {
    await fixture();
    const before = await exportBackup();
    await stageBackup(file(before), kind);
    const control = new TransferControl((p) => {
      if (kind === "cancel" && p.phase === "importing") control.cancel();
    });
    if (kind === "quota")
      vi.spyOn(db.events, "bulkAdd").mockRejectedValueOnce(
        new DOMException("full", "QuotaExceededError"),
      );
    await expect(
      commitStaged(kind, { replace: true, applySettings: true }, control),
    ).rejects.toThrow();
    const after = await exportBackup();
    expect(after.stories).toEqual(before.stories);
    expect(after.roles).toEqual(before.roles);
    expect(after.events).toEqual(before.events);
    expect((await db.profiles.get("private-profile"))?.key).toBe(
      "DO_NOT_EXPORT_KEY",
    );
  },
);

it("keeps current settings and keys by default, and preserves conflicting custom styles separately", async () => {
  const { s } = await fixture();
  const backup = await exportBackup();
  await db.preferences.update("preferences", {
    prompts: { novel: { text: "本机提示词", enabled: true } },
    stylePresets: [
      {
        id: "custom-style",
        name: "自定义",
        description: "本机",
        prompt: "本机文风",
        scope: "novel",
      },
    ],
  });
  await stageBackup(file(backup), "settings");
  await commitStaged("settings", { replace: true, applySettings: false });
  const prefs = await db.preferences.get("preferences");
  expect(prefs?.prompts.novel?.text).toBe("本机提示词");
  expect((await db.profiles.get("private-profile"))?.key).toBe(
    "DO_NOT_EXPORT_KEY",
  );
  const copy = (await db.stories.toArray())[0];
  expect(copy.id).not.toBe(s.id);
  expect(copy.stylePresetId).not.toBe("custom-style");
  expect(
    prefs?.stylePresets?.find((p) => p.id === copy.stylePresetId)?.prompt,
  ).toBe("备份文风");
});

it("exports a complete portable snapshot including drafts but without keys, requests or cached ideas", async () => {
  const { s } = await fixture();
  await db.roleDrafts.add({
    id: "new-role",
    role: { ...s.roles[0], id: "unfinished-role", name: "未完成角色" },
  });
  await db.stories.update(s.id, { inspirationRequest: "TRANSIENT_REQUEST" });
  const output = await exportBackupBlob("whole");
  const text = await output.blob.text();
  expect(text).not.toContain("DO_NOT_EXPORT_KEY");
  expect(text).not.toContain("TRANSIENT_REQUEST");
  const parsed = validateBackup(JSON.parse(text));
  expect(parsed.roleDrafts).toHaveLength(1);
  expect(parsed.events.some((e) => e.deleted)).toBe(true);
  expect(parsed.events.some((e) => e.rewriteOf)).toBe(true);
  await stageBackup(output.blob, "roundtrip");
  await db.stories.update(s.id, { inspirationRequest: undefined });
  await commitStaged("roundtrip", { replace: true, applySettings: true });
  expect((await db.profiles.toArray())[0].key).toBeUndefined();
  validateBackup(await exportBackup());
  expect(
    await db.roles.filter((r) => r.name === "未完成角色（导入草稿）").count(),
  ).toBe(1);
});

it("single-story backups omit other stories and connection settings and scope shared world entries to the copy", async () => {
  const { s } = await fixture();
  await db.stories.add(makeStory("另一故事不导出", s.roles));
  await db.world.add({
    id: "other-world",
    title: "另一故事专属",
    text: "不能泄入",
    type: "world",
    enabled: true,
    always: true,
    keywords: [],
    roleIds: [],
    storyIds: ["other-story"],
    knownBy: [],
    audience: "all",
  });
  const result = await exportBackupBlob("single", s.id);
  const b = validateBackup(JSON.parse(await result.blob.text()));
  expect(b.stories).toHaveLength(1);
  expect(b.profiles).toEqual([]);
  expect(b.world.some((w) => w.id === "other-world")).toBe(false);
  expect(b.world.every((w) => w.storyIds.join() === s.id)).toBe(true);
  expect(b.preferences[0].prompts).toEqual({});
  expect(b.preferences[0].stylePresets).toHaveLength(1);
  await stageBackup(result.blob, "single-read");
  await expect(
    commitStaged("single-read", { replace: true, applySettings: false }),
  ).rejects.toThrow("只能作为副本");
  await commitStaged("single-read", { replace: false, applySettings: false });
  validateBackup(await exportBackup());
});

it("startup cleanup removes abandoned staging without touching story records", async () => {
  await stageBackup(file(await exportBackup()), "abandoned");
  await db.transferSessions.update("abandoned", {
    touched: Date.now() - 2 * 86400_000,
  });
  await cleanupTransfers();
  expect(await db.transferSessions.count()).toBe(0);
  expect(await db.transferRecords.count()).toBe(0);
  expect(await db.stories.count()).toBe(1);
});

it("TXT and Markdown export current selected content in order, excluding drafts and deleted/history content", async () => {
  const { s, e } = await fixture();
  const result = await exportWork(
    "txt",
    workOptions(s.id, { content: "novel", range: "selection", from: 2, to: 2 }),
  );
  const text = await result.blob.text();
  expect(text).toContain("新正文");
  expect(text).not.toContain(e.text);
  expect(text).not.toContain("已删除正文");
  expect(text).not.toContain("未完成的重写");
  const chat = await exportWork("chat", workOptions(s.id, { content: "chat" }));
  expect(await chat.blob.text()).toContain("这是用户发来的消息");
  expect(await chat.blob.text()).not.toContain("新正文");
  const md = await exportWork(
    "md",
    workOptions(s.id, { format: "md", background: true, characters: true }),
  );
  const markdown = await md.blob.text();
  expect(markdown).toContain("# " + s.title);
  expect(markdown).toContain("## 人物介绍");
  expect(markdown).toContain("\\<script\\>");
  expect(markdown).not.toContain(s.roles[0].persona);
  await expect(
    exportWork(
      "invalid-range",
      workOptions(s.id, { range: "selection", from: 1, to: 99 }),
    ),
  ).rejects.toThrow("只有");
});

it("creates actual DOCX and EPUB containers with Chinese content and valid escaped XML", async () => {
  const { s } = await fixture();
  for (const format of ["docx", "epub"] as const) {
    const output = await exportWork(
      format,
      workOptions(s.id, {
        format,
        characters: true,
        background: true,
        pageBreak: true,
      }),
    );
    const bytes = new Uint8Array(await output.blob.arrayBuffer());
    expect(Array.from(bytes.slice(0, 2))).toEqual([80, 75]);
    const files = unzipSync(bytes);
    const content = strFromU8(
      files[format === "docx" ? "word/document.xml" : "OEBPS/story.xhtml"],
    );
    expect(content).toContain("中文🫖");
    expect(content).toContain("&lt;script&gt;");
    expect(content).not.toContain("已删除正文");
    expect(content).not.toContain("未完成的重写");
    if (format === "docx") {
      expect(files["[Content_Types].xml"]).toBeDefined();
      expect(content).toContain("w:pageBreakBefore");
    } else {
      expect(strFromU8(files.mimetype)).toBe("application/epub+zip");
      expect(Object.keys(files)[0]).toBe("mimetype");
      expect(files["OEBPS/nav.xhtml"]).toBeDefined();
    }
  }
});

it("print preview escapes user HTML and provides adjustable layout and print controls", async () => {
  const { s } = await fixture();
  const result = await exportWork(
    "print",
    workOptions(s.id, { format: "print" }),
  );
  const html = await result.blob.text();
  expect(html).toContain("打印 / 保存 PDF");
  expect(html).toContain("预览字号");
  expect(html).toContain("@media print");
  expect(html).toContain("&lt;script&gt;unsafe&lt;/script&gt;");
  expect(html).not.toContain("<script>unsafe</script>");
});

it("does not lose events with equal sequence numbers in a work export", async () => {
  const { s } = await fixture();
  await db.events.add(event(s, 1, { text: "相同序号的第二段" }));
  const result = await exportWork("ties", workOptions(s.id));
  expect(await result.blob.text()).toContain("相同序号的第二段");
  expect(await result.blob.text()).toContain("第1段");
});
