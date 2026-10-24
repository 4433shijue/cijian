import "fake-indexeddb/auto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { db, initialize, saveProfile, sessionKeys } from "../src/db";
import { createStory } from "../src/story-service";
import { uid, type Story } from "../src/types";
import { generate } from "../src/model";
import {
  createNovelImage,
  retryImageJob,
  saveImageProfile,
  stopStoryImages,
} from "../src/image-generation";
import {
  imageProfileSchema,
  imageSettings,
  imageWorking,
} from "../src/image-types";
import { compactImageStorage } from "../src/image-storage";
import { exportBackup, validateBackup } from "../src/backup";
import {
  exportBackupBlob,
  stageBackup,
  commitStaged,
} from "../src/backup-transfer";
import { BackupRecordDecoder } from "../src/backup-records";

vi.mock("../src/model", () => ({ generate: vi.fn() }));
const model = vi.mocked(generate);
const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lS8AAAAASUVORK5CYII=";
const imageData = "data:image/png;base64," + png;
const plan = {
  generate: true,
  selfie: false,
  description: "窗台上的花盆",
  roleIds: [],
  reason: "",
};
const planned = () =>
  ({
    text: JSON.stringify(plan),
    complete: true,
    reason: "stop",
    usage: {},
  }) as any;
let story: Story;
let transport: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  await db.delete();
  await db.open();
  await initialize();
  story = await createStory({
    kind: "novel",
    title: "恢复检查",
    worldIds: [],
    background: "",
    roles: [
      {
        id: uid(),
        name: "甲",
        bio: "",
        persona: "人物",
        paragraphs: [],
        avatar: "",
        updated: Date.now(),
      },
    ],
  });
  await saveProfile(
    {
      id: "text",
      name: "文字",
      protocol: "chat",
      url: "https://text.fixture.test/v1",
      model: "test",
      stream: false,
      context: 32000,
      maxOutput: 2048,
      timeout: 10,
      remember: false,
    },
    "fixture-key",
  );
  await db.preferences.update("preferences", { activeProfile: "text" });
  await saveImageProfile(
    imageProfileSchema.parse({
      id: "image",
      name: "图片",
      url: "https://image.fixture.test/v1",
      model: "test",
      timeout: 10,
    }),
    "fixture-key",
  );
  model.mockReset();
  model.mockResolvedValue(planned());
  transport = vi.fn(
    async () =>
      new Response(JSON.stringify({ data: [{ b64_json: png }] }), {
        headers: { "content-type": "application/json" },
      }),
  );
  vi.stubGlobal("fetch", transport);
});
afterEach(async () => {
  for (const s of await db.stories.toArray()) await stopStoryImages(s.id);
  vi.unstubAllGlobals();
  sessionKeys.clear();
  await db.delete();
});
async function prose(seq = 1) {
  const id = uid(),
    versionId = uid(),
    text = "窗台上放着花盆。";
  await db.events.add({
    id,
    storyId: story.id,
    kind: "novel",
    origin: "ai",
    seq,
    speaker: "",
    participants: story.roles.map((r) => r.id),
    input: text,
    text,
    facts: [],
    versions: [
      { id: versionId, text, input: text, facts: [], created: Date.now() },
    ],
    versionId,
    status: "complete",
    raw: "",
    error: "",
    review: false,
    deleted: false,
    created: Date.now(),
  });
  return id;
}
async function settled(id: string) {
  await vi.waitFor(async () =>
    expect(imageWorking((await db.imageJobs.get(id))!.status)).toBe(false),
  );
  if (typeof navigator !== "undefined" && navigator.locks)
    await navigator.locks.request(`cijian-image:${id}`, () => {});
  return (await db.imageJobs.get(id))!;
}

it("cancels both planning and queued automatic pictures when novel images are disabled", async () => {
  await db.stories.update(story.id, {
    images: imageSettings({ novelMode: "every" }),
  });
  let finish!: (value: any) => void;
  model.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const first = (await createNovelImage(await prose(), true))!;
  await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
  const second = (await createNovelImage(await prose(2), true))!;
  await db.stories.update(story.id, {
    images: imageSettings({ novelMode: "manual" }),
  });
  finish(planned());
  expect((await settled(first.id)).error).toContain("已关闭正文自动配图");
  expect((await settled(second.id)).error).toContain("已关闭正文自动配图");
  expect(model).toHaveBeenCalledTimes(1);
  expect(transport).not.toHaveBeenCalled();
});

it("retains a failed download across startup and retries GET only without credentials or another image charge", async () => {
  let posts = 0,
    gets = 0;
  transport.mockImplementation(async (url: string) => {
    if (url.includes("image.fixture.test")) {
      posts++;
      return new Response(
        JSON.stringify({
          data: [
            { url: "https://cdn.fixture.test/generated.png?signature=private" },
          ],
        }),
        { headers: { "content-type": "application/json" } },
      );
    }
    gets++;
    return gets === 1
      ? new Response("", { status: 503 })
      : new Response(Uint8Array.from(atob(png), (c) => c.charCodeAt(0)));
  });
  const job = (await createNovelImage(await prose()))!;
  expect((await settled(job.id)).downloadUrl).toContain("signature=private");
  expect(JSON.stringify(await exportBackup())).not.toContain(
    "signature=private",
  );
  expect(await (await exportBackupBlob(uid())).blob.text()).not.toContain(
    "signature=private",
  );
  await db.imageProfiles.clear();
  sessionKeys.clear();
  const { initializeImages } = await import("../src/image-generation");
  await initializeImages();
  await retryImageJob(job.id);
  const saved = (await db.imageJobs.get(job.id))!;
  expect(saved.status).toBe("complete");
  expect(saved.downloadUrl).toBeUndefined();
  expect(saved.attempts).toBe(1);
  expect(posts).toBe(1);
  expect(gets).toBe(2);
  expect(model).toHaveBeenCalledTimes(1);
  expect(transport.mock.calls.at(-1)?.[1]).not.toHaveProperty("headers");
});

it("deduplicates references and compacts old copies without changing current or historical pictures", async () => {
  await db.stories.update(story.id, {
    roles: story.roles.map((r) => ({ ...r, imageReference: imageData })),
  });
  const a = await settled((await createNovelImage(await prose()))!.id);
  const b = await settled((await createNovelImage(await prose(2)))!.id);
  expect(a.roles[0].reference).toBe(b.roles[0].reference);
  const old = (await db.imageAssets.get(a.roles[0].reference))!;
  const duplicateId = uid();
  await db.imageAssets.add({ ...old, id: duplicateId, contentHash: undefined });
  await db.imageJobs.update(b.id, {
    roles: b.roles.map((r) => ({ ...r, reference: duplicateId })),
  });
  await db.imageAssets.add({ ...old, id: uid(), contentHash: undefined }); // unused copy
  expect(await compactImageStorage(story.id)).toBeGreaterThan(0);
  for (const id of [a.id, b.id]) {
    const job = (await db.imageJobs.get(id))!;
    expect((await db.imageAssets.get(job.assetId))?.data).toBe(imageData);
    expect((await db.imageAssets.get(job.roles[0].reference))?.data).toBe(
      imageData,
    );
  }
  const backup = await exportBackup();
  expect(() => validateBackup(backup)).not.toThrow();
});

it("round trips a story larger than 16 MiB and recovers already-exported version 10 backups", async () => {
  const reference = "data:image/png;base64," + "A".repeat(2 * 1024 * 1024);
  const roles = Array.from({ length: 9 }, (_, i) => ({
    ...story.roles[0],
    id: uid(),
    name: "角色" + i,
    imageReference: reference,
  }));
  await db.stories.update(story.id, {
    roles,
    player: roles[0].id,
    partner: roles[1].id,
  });
  const output = await exportBackupBlob(uid(), story.id);
  const wire = JSON.parse(await output.blob.text());
  expect(wire.stories.length).toBeGreaterThan(1);
  expect(validateBackup(wire).stories[0].roles).toHaveLength(9);
  const session = uid();
  await stageBackup(output.blob, session);
  await commitStaged(session, { replace: false, applySettings: false });
  const copy = await db.stories
    .filter((s) => s.id !== story.id && s.roles.length === 9)
    .first();
  expect(copy?.roles.every((r) => r.imageReference === reference)).toBe(true);
  const legacy = { ...(await exportBackup()), version: 10 };
  const oldSession = uid();
  await stageBackup(new Blob([JSON.stringify(legacy)]), oldSession);
  expect(
    (await db.transferRecords.get([oldSession, "stories", story.id]))?.value
      .roles,
  ).toHaveLength(9);
  wire.stories.splice(1, 1);
  await expect(
    stageBackup(new Blob([JSON.stringify(wire)]), uid()),
  ).rejects.toThrow("分块");
}, 30_000);

it("rejects incomplete, reordered and cross-table record fragments", () => {
  const part = (index: number, text: string) => ({
    __cijianBackupChunk: { id: "a", index, total: 2, text },
  });
  const decoder = new BackupRecordDecoder();
  decoder.push("stories", part(0, '{"id":"a",'));
  expect(() => decoder.finish()).toThrow("不完整");
  expect(() => decoder.push("roles", part(1, '"title":"x"}'))).toThrow("顺序");
  expect(() => new BackupRecordDecoder().push("stories", part(1, "x"))).toThrow(
    "顺序",
  );
});
