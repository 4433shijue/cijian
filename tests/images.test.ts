import "fake-indexeddb/auto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  db,
  initialize,
  sessionKeys,
  reviseEvent,
  deleteStory,
} from "../src/db";
import { createStory } from "../src/story-service";
import { uid, type Story, type SceneEvent } from "../src/types";
import {
  imageSettings,
  imageProfileSchema,
  imageWorking,
} from "../src/image-types";
import {
  createNovelImage,
  createPhoneImage,
  retryImageJob,
  runImageJob,
  stopImageJob,
  initializeImages,
  stopStoryImages,
  saveImageProfile,
} from "../src/image-generation";
import { imageEndpoint, requestImage } from "../src/image-provider";
import { generate } from "../src/model";
import { run } from "../src/engine";
import { emptyBody } from "../src/phone-types";
import {
  addRecord,
  conversation,
  editRecord,
  recordText,
} from "../src/phone-store";
import { startPhoneRun } from "../src/phone-generation";
import {
  ensureAutomation,
  startAutomation,
  adoptAutomation,
  undoAutomation,
  emptyAction,
} from "../src/phone-automation";
import { exportBackup, importBackup, validateBackup } from "../src/backup";
import {
  exportBackupBlob,
  stageBackup,
  commitStaged,
} from "../src/backup-transfer";
import { illustratedStoryHtml } from "../src/image-export";
import { buildReaderPackage, createReaderHTML } from "../src/phone-reader";
import { adoptImageReference } from "../src/image-character";
import { builtInImageStyles } from "../src/image-styles";
import { compactImageStorage } from "../src/image-storage";

vi.mock("../src/model", () => ({ generate: vi.fn() }));
const model = vi.mocked(generate);
const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lS8AAAAASUVORK5CYII=";
const dataUrl = "data:image/png;base64," + PNG;
const plan = {
  generate: true,
  selfie: false,
  description: "窗台上放着一碗热面，窗外是雨后的街道",
  roleIds: [] as string[],
  reason: "",
};
const response = (value: unknown) =>
  ({
    text: JSON.stringify(value),
    complete: true,
    reason: "stop",
    usage: {},
  }) as any;
const imageResponse = () =>
  new Response(JSON.stringify({ data: [{ b64_json: PNG }] }), {
    headers: { "Content-Type": "application/json" },
  });
let story: Story;
let fetcher: ReturnType<typeof vi.fn>;
const imageProfile = () =>
  imageProfileSchema.parse({
    id: "image-fixture",
    name: "Images fixture",
    url: "https://images.fixture.test/v1",
    model: "fixture-image",
    remember: true,
    timeout: 10,
  });
async function prose(text = "窗台上放着一碗热面。") {
  const id = uid(),
    versionId = uid();
  const e: SceneEvent = {
    id,
    storyId: story.id,
    kind: "novel",
    origin: "ai",
    seq: Date.now(),
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
  };
  await db.events.add(e);
  return e;
}
async function settled(id: string) {
  await vi.waitFor(
    async () =>
      expect(imageWorking((await db.imageJobs.get(id))!.status)).toBe(false),
    { timeout: 8000, interval: 10 },
  );
  return (await db.imageJobs.get(id))!;
}
async function phone() {
  story = await createStory({
    kind: "phone",
    title: "照片聊天",
    roles: story.roles,
    worldIds: [],
    background: "他们在书店聊天",
    secret: "PRIVATE_AUTHOR_SECRET",
  });
  await db.stories.update(story.id, {
    images: imageSettings({ phoneEnabled: true, perTurn: 1, perRun: 2 }),
  });
  story = (await db.stories.get(story.id))!;
  return conversation(story, [story.player, story.partner]);
}
async function photo(cid: string, text = "窗台上的一碗热面", patch = {}) {
  return addRecord(story.id, {
    speakerId: story.partner,
    conversationId: cid,
    body: { ...emptyBody(), type: "image", text },
    ...patch,
  });
}
beforeEach(async () => {
  await db.delete();
  await db.open();
  await initialize();
  story = (await db.stories.where("kind").equals("novel").toArray())[0];
  await db.stories.update(story.id, { autoMemory: false });
  await db.profiles.put({
    id: "text-fixture",
    name: "Text fixture",
    protocol: "chat",
    url: "https://text.fixture.test/v1",
    model: "fixture",
    stream: false,
    context: 64000,
    maxOutput: 4000,
    timeout: 10,
    remember: false,
  });
  sessionKeys.set("text-fixture", "text-secret-fixture");
  await db.preferences.update("preferences", { activeProfile: "text-fixture" });
  await saveImageProfile(imageProfile(), "image-secret-fixture");
  model.mockReset();
  model.mockResolvedValue(response(plan));
  fetcher = vi.fn(async () => imageResponse());
  vi.stubGlobal("fetch", fetcher);
});
afterEach(async () => {
  for (const s of await db.stories.toArray()) await stopStoryImages(s.id);
  sessionKeys.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("saves prose independently, automatically creates its image and never resends on recovery", async () => {
  await db.stories.update(story.id, {
    images: imageSettings({ novelMode: "every" }),
  });
  model
    .mockResolvedValueOnce(
      response({ text: "窗台上放着一碗热面。", facts: [] }),
    )
    .mockResolvedValue(response(plan));
  await run(story.id, "novel", "把热面放在窗台上。");
  await vi.waitFor(async () => expect(await db.imageJobs.count()).toBe(1));
  const job = await settled((await db.imageJobs.toArray())[0].id);
  expect(job.status).toBe("complete");
  expect((await db.events.get(job.sourceId))?.status).toBe("complete");
  expect((await db.imageAssets.get(job.assetId))?.data).toBe(dataUrl);
  await initializeImages();
  await createNovelImage(job.sourceId, true);
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it("selective mode may skip an illustration without spending an image request", async () => {
  await db.stories.update(story.id, {
    images: imageSettings({ novelMode: "auto" }),
  });
  model.mockResolvedValue(
    response({ ...plan, generate: false, reason: "只有抽象思绪" }),
  );
  const job = await settled(
    (await createNovelImage((await prose()).id, true))!.id,
  );
  expect(job.status).toBe("skipped");
  expect(fetcher).not.toHaveBeenCalled();
});

it("a failed image keeps prose and retries the image without repeating successful planning", async () => {
  fetcher
    .mockResolvedValueOnce(new Response("quota", { status: 429 }))
    .mockResolvedValueOnce(imageResponse());
  const event = await prose(),
    job = (await createNovelImage(event.id))!;
  expect((await settled(job.id)).status).toBe("failed");
  expect((await db.events.get(event.id))?.text).toBe(event.text);
  await retryImageJob(job.id);
  expect((await settled(job.id)).status).toBe("complete");
  expect(model).toHaveBeenCalledTimes(1);
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it("binds illustrations to versions and excludes old pictures from the current reading page", async () => {
  const event = await prose();
  const job = await settled((await createNovelImage(event.id))!.id);
  expect((await illustratedStoryHtml(story.id)).html).toContain(dataUrl);
  await reviseEvent(event.id, "窗台已经空了。", false, [], event.versionId);
  expect((await illustratedStoryHtml(story.id)).html).not.toContain(dataUrl);
  expect((await db.imageJobs.get(job.id))?.assetId).toBe(job.assetId);
});

it("blocks an explicit selfie before either model request and blocks a disguised selfie plan", async () => {
  const cid = await phone();
  const r = await photo(cid, "发一张镜子自拍");
  const job = (await createPhoneImage(r.id, true))!;
  expect(job.status).toBe("blocked");
  expect(model).not.toHaveBeenCalled();
  expect(fetcher).not.toHaveBeenCalled();
  await expect(retryImageJob(job.id)).rejects.toThrow("自拍");
  const other = await photo(cid, "发一张生活照片");
  model.mockResolvedValue(
    response({
      ...plan,
      selfie: true,
      description: "the photographer appears in the mirror",
    }),
  );
  expect((await settled((await createPhoneImage(other.id))!.id)).status).toBe(
    "blocked",
  );
  expect(fetcher).not.toHaveBeenCalled();
});

it("generates a phone photograph from the visible message without sending author secrets or character references", async () => {
  const cid = await phone();
  story.roles[1].imageReference = dataUrl;
  await db.stories.update(story.id, { roles: story.roles });
  const r = await photo(cid);
  const job = await settled((await createPhoneImage(r.id, true))!.id);
  expect(job.status).toBe("complete");
  const saved = (await db.phoneRecords.get(r.id))!;
  expect(saved.body.assets).toEqual([job.assetId]);
  expect(saved.body.text).toBe(r.body.text);
  expect(saved.versions[0].body.assets).toEqual([job.assetId]);
  expect(recordText(saved)).toContain(plan.description);
  const textInput = String(model.mock.calls[0][3]);
  expect(textInput).not.toContain("PRIVATE_AUTHOR_SECRET");
  expect(textInput).not.toContain(PNG);
  expect(fetcher.mock.calls[0][0]).toContain("/images/generations");
  const reader = await buildReaderPackage(story.id);
  const html = createReaderHTML(reader);
  expect(html).toContain(PNG);
  expect(html).not.toContain("image-secret-fixture");
  expect(html).not.toContain("PRIVATE_AUTHOR_SECRET");
});

it("enforces round and run image limits before requests while retaining descriptions", async () => {
  const cid = await phone();
  const a = await photo(cid, "一碗面", { round: "round-one" });
  const b = await photo(cid, "一杯茶", { round: "round-one" });
  const c = await photo(cid, "一朵花", { round: "round-two" });
  const d = await photo(cid, "一扇窗", { round: "round-three" });
  await settled((await createPhoneImage(a.id, true, "whole-run"))!.id);
  expect((await createPhoneImage(b.id, true, "whole-run"))!.status).toBe(
    "blocked",
  );
  await settled((await createPhoneImage(c.id, true, "whole-run"))!.id);
  expect((await createPhoneImage(d.id, true, "whole-run"))!.status).toBe(
    "blocked",
  );
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect((await db.phoneRecords.get(b.id))?.body.text).toBe("一杯茶");
});

it("does not attach a late result after editing or retracting its phone message", async () => {
  const cid = await phone(),
    r = await photo(cid);
  let finish!: (response: Response) => void;
  fetcher.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const job = (await createPhoneImage(r.id))!;
  await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
  await editRecord(r.id, { retracted: true }, r.versionId);
  finish(imageResponse());
  expect((await settled(job.id)).status).toBe("failed");
  expect((await db.phoneRecords.get(r.id))?.body.assets).toEqual([]);
  expect(await db.phoneAssets.count()).toBe(0);
});

it("does not attach a late result after the audience changes", async () => {
  const cid = await phone(),
    r = await photo(cid);
  let finish!: (response: Response) => void;
  fetcher.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const job = (await createPhoneImage(r.id))!;
  await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
  await db.phoneConversations.update(cid, { members: [story.partner] });
  finish(imageResponse());
  expect((await settled(job.id)).status).toBe("failed");
  expect(await db.phoneAssets.count()).toBe(0);
});

it("sends only the pictured characters' reference images through the enabled edits adapter", async () => {
  story.roles = story.roles.map((r) => ({
    ...r,
    imageAppearance: "短发",
    imageReference: dataUrl,
  }));
  await db.stories.update(story.id, { roles: story.roles });
  await saveImageProfile(
    { ...imageProfile(), references: "multipart" },
    "image-secret-fixture",
  );
  model.mockResolvedValue(response({ ...plan, roleIds: [story.roles[0].id] }));
  const job = await settled((await createNovelImage((await prose()).id))!.id);
  expect(job.status).toBe("complete");
  expect(fetcher.mock.calls[0][0]).toContain("/images/edits");
  const request = fetcher.mock.calls[0][1] as RequestInit;
  expect((request.body as FormData).getAll("image[]")).toHaveLength(1);
  expect(JSON.stringify(job)).not.toContain(PNG);
  expect((await db.imageAssets.get(job.roles[0].reference))?.data).toBe(
    dataUrl,
  );
});

it("backs up pictures, settings and recovery records without keys; remaps relationships in both import paths", async () => {
  story.roles[0].imageReference = dataUrl;
  await db.stories.update(story.id, {
    roles: story.roles,
    images: imageSettings({ novelMode: "every" }),
  });
  const job = await settled((await createNovelImage((await prose()).id))!.id);
  const backup = await exportBackup();
  expect(backup.version).toBe(12);
  expect(JSON.stringify(backup)).not.toContain("image-secret-fixture");
  expect(() => validateBackup(backup)).not.toThrow();
  await importBackup(backup);
  const imported = (await db.imageJobs.toArray()).find((j) => j.id !== job.id)!;
  expect(imported.sourceId).not.toBe(job.sourceId);
  expect(imported.assetId).not.toBe(job.assetId);
  expect((await db.events.get(imported.sourceId))?.storyId).toBe(
    imported.storyId,
  );
  const blob = await exportBackupBlob("images-export", story.id);
  const parsed = JSON.parse(await blob.blob.text());
  expect(parsed.imageJobs).toHaveLength(1);
  expect(parsed.imageProfiles).toEqual([]);
  expect(JSON.stringify(parsed)).not.toContain("image-secret-fixture");
  await stageBackup(blob.blob, "images-import");
  await commitStaged("images-import", { replace: false, applySettings: false });
  expect(await db.imageJobs.count()).toBe(3);
  expect(() => validateBackup(parsed)).not.toThrow();
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it("rejects broken or cross-story image references in backups", async () => {
  await settled((await createNovelImage((await prose()).id))!.id);
  const backup: any = await exportBackup();
  backup.imageJobs[0].assetId = "missing-asset";
  expect(() => validateBackup(backup)).toThrow("配图关联");
  delete backup.imageAssets;
  expect(() => validateBackup(backup)).toThrow("资料区");
});

it("recovers expired work without a request and removes all pictures when a story is deleted", async () => {
  const job = await settled((await createNovelImage((await prose()).id))!.id);
  await db.imageJobs.update(job.id, { status: "generating", leaseUntil: 0 });
  await initializeImages();
  expect((await db.imageJobs.get(job.id))?.status).toBe("interrupted");
  expect(fetcher).toHaveBeenCalledTimes(1);
  await deleteStory(story.id);
  expect(await db.imageJobs.where("storyId").equals(story.id).count()).toBe(0);
  expect(await db.imageAssets.where("storyId").equals(story.id).count()).toBe(
    0,
  );
});

it("manual AI replies attach generated images, while draft moments wait until publication", async () => {
  const cid = await phone();
  model.mockImplementation(async (_p, _k, system) =>
    response(
      system.includes("作品配图助手")
        ? plan
        : {
            messages: [
              {
                type: "image",
                text: "刚煮好的。",
                imagePrompt: "桌上的一碗热面",
              },
            ],
          },
    ),
  );
  await addRecord(story.id, {
    speakerId: story.player,
    conversationId: cid,
    body: { ...emptyBody(), text: "吃的什么" },
    pending: true,
  });
  await startPhoneRun({
    storyId: story.id,
    ownerId: story.player,
    conversationId: cid,
    speakers: [story.partner],
    mode: "participate",
  });
  await vi.waitFor(async () => expect(await db.imageJobs.count()).toBe(1));
  expect((await settled((await db.imageJobs.toArray())[0].id)).status).toBe(
    "complete",
  );
  const draftId = await startPhoneRun({
    storyId: story.id,
    ownerId: story.player,
    speakers: [story.partner],
    mode: "moment",
    audience: [story.player, story.partner],
    draftOnly: true,
    input: "分享午饭",
  });
  const draft = (await db.phoneRuns.get(draftId))!;
  expect(draft.staged?.["0"][0].imagePrompt).toBe("桌上的一碗热面");
  expect(fetcher).toHaveBeenCalledTimes(1);
  await addRecord(story.id, {
    speakerId: story.partner,
    kind: "moment",
    audience: [story.player, story.partner],
    body: draft.staged!["0"][0],
  });
  await vi.waitFor(async () => expect(await db.imageJobs.count()).toBe(2));
  const latest = (await db.imageJobs.toArray()).find(
    (j) =>
      j.sourceId !== (draft.steps[0].outputIds[0] || "") &&
      j.status !== "complete",
  );
  if (latest) await settled(latest.id);
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
});

it("automation drafts do not spend image calls; adoption generates once, export and undo retain consistency", async () => {
  await phone();
  model.mockImplementation(
    async (_p, _k, system, _input, _signal, _update, _fetch, options) => {
      if (system.includes("作品配图助手")) return response(plan);
      if (
        options?.schemaName === "phone_action" ||
        system.includes("awaitUser")
      )
        return response({
          ...emptyAction(),
          kind: "moment",
          audience: [story.partner],
          reason: "分享午饭",
          instruction: "拍饭菜",
        });
      return response({
        messages: [
          {
            ...emptyBody(),
            type: "image",
            text: "午饭。",
            imagePrompt: "桌上的饭菜",
          },
        ],
        title: "",
        text: "",
        assets: [],
      });
    },
  );
  // The decision and content requests use distinct schema names.
  model
    .mockResolvedValueOnce(
      response({
        ...emptyAction(),
        kind: "moment",
        audience: [story.partner],
        reason: "分享午饭",
        instruction: "拍饭菜",
      }),
    )
    .mockResolvedValueOnce(
      response({
        messages: [
          {
            ...emptyBody(),
            type: "image",
            text: "午饭。",
            imagePrompt: "桌上的饭菜",
          },
        ],
        title: "",
        text: "",
        assets: [],
      }),
    );
  const options = await ensureAutomation(story.id);
  const id = await startAutomation(story.id, {
    ...options,
    roles: [story.partner],
    controlledRole: story.player,
    rounds: 1,
    mode: "draft",
  });
  await vi.waitFor(
    async () =>
      expect((await db.phoneAutomationRuns.get(id))?.status).toBe("complete"),
    { timeout: 8000 },
  );
  expect(fetcher).not.toHaveBeenCalled();
  expect(await db.imageJobs.count()).toBe(0);
  await adoptAutomation(id);
  await vi.waitFor(async () => expect(await db.imageJobs.count()).toBe(1));
  const job = await settled((await db.imageJobs.toArray())[0].id);
  expect(job.status).toBe("complete");
  expect(job.runId).toBe(id);
  const backup = await exportBackup();
  expect(() => validateBackup(backup)).not.toThrow();
  await undoAutomation(id);
  expect((await db.phoneRecords.get(job.sourceId))?.deleted).toBe(true);
});

it("normalizes only supported endpoints, omits optional fields, and never forwards the API key to image URLs", async () => {
  expect(imageEndpoint("https://example.test/v1/chat/completions")).toBe(
    "https://example.test/v1/chat/completions",
  );
  expect(() => imageEndpoint("http://public.example/v1")).toThrow("HTTPS");
  expect(() => imageEndpoint("https://example.test/v1?key=secret")).toThrow(
    "查询参数",
  );
  const transport = vi
    .fn()
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          data: [{ url: "https://cdn.fixture.test/output.png" }],
        }),
      ),
    )
    .mockResolvedValueOnce(
      new Response(Uint8Array.from(atob(PNG), (x) => x.charCodeAt(0))),
    );
  await requestImage(
    imageProfile(),
    "secret",
    "a bowl",
    [],
    new AbortController().signal,
    transport,
  );
  expect(JSON.parse(transport.mock.calls[0][1].body)).not.toHaveProperty(
    "response_format",
  );
  expect(transport.mock.calls[1][1]).not.toHaveProperty("headers");
  expect(transport.mock.calls[1][1].credentials).toBe("omit");
});

it("claims a duplicate job once, discards stopped results, and retries only after the old request ends", async () => {
  const event = await prose();
  let finish!: (response: Response) => void;
  fetcher.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const [a, b] = await Promise.all([
    createNovelImage(event.id),
    createNovelImage(event.id),
  ]);
  expect(a!.id).toBe(b!.id);
  await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
  const completion = runImageJob(a!.id);
  await stopImageJob(a!.id);
  await expect(retryImageJob(a!.id)).rejects.toThrow("正在停止");
  finish(imageResponse());
  await completion;
  // With Web Locks (browsers and Node 24), the duplicate run returns early.
  // Join the original execution's lock before checking its settled state.
  if (typeof navigator !== "undefined" && navigator.locks)
    await navigator.locks.request(`cijian-image:${a!.id}`, () => {});
  expect((await db.imageJobs.get(a!.id))?.status).toBe("interrupted");
  expect(await db.imageAssets.count()).toBe(0);
  await retryImageJob(a!.id);
  expect((await db.imageJobs.get(a!.id))?.status).toBe("complete");
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(model).toHaveBeenCalledTimes(1);
  await stopImageJob(a!.id);
  expect((await db.imageJobs.get(a!.id))?.status).toBe("complete");
});

it("reuses visible old photos with their original description and rejects unprovided asset IDs", async () => {
  const cid = await phone(),
    assetId = uid();
  await db.phoneAssets.add({
    id: assetId,
    storyId: story.id,
    name: "旧照片",
    mime: "image/png",
    data: dataUrl,
    size: 68,
  });
  await addRecord(story.id, {
    speakerId: story.partner,
    conversationId: cid,
    body: {
      ...emptyBody(),
      type: "image",
      text: "昨天拍的。",
      imagePrompt: "树下的白猫",
      assets: [assetId],
    },
  });
  model.mockResolvedValue(
    response({
      messages: [
        {
          type: "image",
          text: "就是这张。",
          imagePrompt: "模型误写的画面",
          assets: [assetId],
        },
      ],
    }),
  );
  const id = await startPhoneRun({
    storyId: story.id,
    ownerId: story.player,
    conversationId: cid,
    speakers: [story.partner],
    mode: "participate",
    input: "把那张猫的照片再给我看看",
  });
  const run = (await db.phoneRuns.get(id))!;
  const output = (await db.phoneRecords.get(run.steps[0].outputIds[0]))!;
  expect(output.body.assets).toEqual([assetId]);
  expect(output.body.imagePrompt).toBe("树下的白猫");
  expect(fetcher).not.toHaveBeenCalled();
  expect(await db.imageJobs.count()).toBe(0);
  model.mockResolvedValue(
    response({
      messages: [{ type: "image", text: "照片。", assets: ["not-authorized"] }],
    }),
  );
  await expect(
    startPhoneRun({
      storyId: story.id,
      ownerId: story.player,
      conversationId: cid,
      speakers: [story.partner],
      mode: "participate",
      input: "再发一张",
    }),
  ).rejects.toThrow("未经授权");
  expect(fetcher).not.toHaveBeenCalled();
});

it("retains historical photo tasks in both backup paths after the source audience changes", async () => {
  await phone();
  const r = await addRecord(story.id, {
    kind: "moment",
    speakerId: story.partner,
    audience: [story.partner, story.player],
    body: { ...emptyBody(), type: "image", text: "一碗热面" },
  });
  const job = await settled((await createPhoneImage(r.id))!.id);
  await db.phoneRecords.update(r.id, { audience: [story.partner] });
  const backup = await exportBackup();
  expect(() => validateBackup(backup)).not.toThrow();
  const blob = await exportBackupBlob("historical-photo", story.id);
  await stageBackup(blob.blob, "historical-import");
  await commitStaged("historical-import", {
    replace: false,
    applySettings: false,
  });
  expect(
    (await db.imageJobs.toArray()).find((j) => j.id !== job.id)?.audience,
  ).toHaveLength(2);
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it("does not send a prompt when a selected appearance or style asks for a selfie", async () => {
  await db.stories.update(story.id, {
    images: imageSettings({ style: "镜子自拍" }),
  });
  const job = await settled((await createNovelImage((await prose()).id))!.id);
  expect(job.status).toBe("failed");
  expect(job.error).toContain("自拍");
  expect(fetcher).not.toHaveBeenCalled();
});

it("always sends fixed textual identity and separate outfit through text-only models", async () => {
  const role = {
    ...story.roles[0],
    imageAppearance: "灰绿色眼睛，窄长脸，左眼下有痣",
    imageLook: "奶白色针织衫",
    imageReference: dataUrl,
  };
  await db.stories.update(story.id, { roles: [role, ...story.roles.slice(1)] });
  model.mockResolvedValue(response({ ...plan, roleIds: [role.id] }));
  const job = await settled((await createNovelImage((await prose()).id))!.id);
  expect(job.status).toBe("complete");
  const body = JSON.parse(
    (fetcher.mock.calls[0][1] as RequestInit).body as string,
  );
  expect(body.prompt).toContain(role.imageAppearance);
  expect(body.prompt).toContain(role.imageLook);
  expect(body.prompt).toContain("韩系高完成度");
  expect(body).not.toHaveProperty("images");
  expect(job.identityInputs?.[0]).toMatchObject({
    method: "text",
    references: [],
  });
  expect(job.styleSnapshot?.id).toBe("korean-3d");
  expect(JSON.stringify(job)).not.toContain("image-secret-fixture");
});

it("binds multiple views to the right character and uses text for an unsupported full generation endpoint", async () => {
  const role = {
    ...story.roles[0],
    imageAppearance: "琥珀色瞳孔",
    imageReferences: [
      {
        id: "front",
        name: "定妆正面",
        view: "front" as const,
        styleId: "korean-3d",
        data: dataUrl,
      },
      {
        id: "water",
        name: "水彩定妆",
        view: "side" as const,
        styleId: "watercolor",
        data: dataUrl,
      },
    ],
  };
  await db.stories.update(story.id, { roles: [role, ...story.roles.slice(1)] });
  await saveImageProfile(
    { ...imageProfile(), references: "multipart" },
    "image-secret-fixture",
  );
  model.mockResolvedValue(response({ ...plan, roleIds: [role.id] }));
  const event = await prose();
  const job = await settled((await createNovelImage(event.id))!.id);
  expect(job.status).toBe("complete");
  expect(job.identityInputs?.[0]).toMatchObject({
    method: "both",
    references: ["定妆正面 · 正面"],
  });
  const form = (fetcher.mock.calls[0][1] as RequestInit).body as FormData;
  expect(form.get("prompt")).toContain(
    `参考图 1 = ${role.name}（编号 ${role.id}）`,
  );
  expect(form.get("prompt")).toContain("琥珀色瞳孔");
  expect(form.getAll("image[]")).toHaveLength(1);
  await saveImageProfile(
    {
      ...imageProfile(),
      endpointMode: "full",
      url: "https://images.fixture.test/v1/images/generations",
      references: "auto",
    },
    "image-secret-fixture",
  );
  const fallback = await settled((await createNovelImage(event.id))!.id);
  expect(fallback.status).toBe("complete");
  expect(fallback.identityInputs?.[0].method).toBe("text");
  expect(fallback.identityInputs?.[0].note).toContain("generations");
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it("one-picture text-only mode skips references on a capable endpoint without changing the stored preset", async () => {
  story.roles[0].imageAppearance = "红棕短发";
  story.roles[0].imageReference = dataUrl;
  await db.stories.update(story.id, { roles: story.roles });
  await saveImageProfile(
    { ...imageProfile(), references: "auto" },
    "image-secret-fixture",
  );
  model.mockResolvedValue(response({ ...plan, roleIds: [story.roles[0].id] }));
  const job = await settled(
    (await createNovelImage((await prose()).id, false, {
      referenceMode: "text",
    }))!.id,
  );
  expect(job.status).toBe("complete");
  expect(fetcher.mock.calls[0][0]).toContain("/images/generations");
  expect(job.identityInputs?.[0].method).toBe("text");
  expect((await db.imageProfiles.get(imageProfile().id))?.references).toBe(
    "auto",
  );
});

it("queued jobs freeze connection and style while explicit retries adopt the current connection", async () => {
  let release!: (value: any) => void;
  model
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    )
    .mockResolvedValue(response(plan));
  const one = (await createNovelImage((await prose("一杯热茶")).id))!;
  await vi.waitFor(() => expect(release).toBeTypeOf("function"));
  const two = (await createNovelImage((await prose("窗边的雨伞")).id, false, {
    styleId: "watercolor",
  }))!;
  await saveImageProfile(
    {
      ...imageProfile(),
      id: "another",
      name: "另一套接口",
      url: "https://another.fixture.test/v1",
      model: "other",
    },
    "another-secret",
  );
  release(response(plan));
  expect((await settled(one.id)).status).toBe("complete");
  const job = await settled(two.id);
  expect(job.status).toBe("complete");
  expect(job.styleSnapshot?.id).toBe("watercolor");
  expect(
    fetcher.mock.calls.every((c) =>
      String(c[0]).includes("images.fixture.test"),
    ),
  ).toBe(true);
  await db.imageJobs.update(two.id, { status: "failed", assetId: "" });
  await retryImageJob(two.id);
  expect(fetcher.mock.calls.at(-1)?.[0]).toContain("another.fixture.test");
  expect((await db.imageJobs.get(two.id))?.styleSnapshot?.id).toBe(
    "watercolor",
  );
});

it("uses developer planning preference without sending binary reference data to the text model", async () => {
  story.roles[0].imageReference = dataUrl;
  await db.stories.update(story.id, { roles: story.roles });
  await db.preferences.update("preferences", {
    imagePromptOverrides: {
      novel: { enabled: true, text: "只选择情绪克制的中景" },
    },
  });
  await settled((await createNovelImage((await prose()).id))!.id);
  expect(model.mock.calls[0][2]).toContain("只选择情绪克制的中景");
  expect(model.mock.calls[0][2]).toContain("禁止生成自拍");
  expect(model.mock.calls[0][3]).not.toContain(PNG);
  expect(model.mock.calls[0][3]).not.toContain("reference");
});

it("never sends a replaced preset key to the previous endpoint while planning is in flight", async () => {
  let release!: (value: any) => void;
  model.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const one = (await createNovelImage((await prose("热茶")).id))!;
  await vi.waitFor(() => expect(release).toBeTypeOf("function"));
  const queued = (await createNovelImage((await prose("雨伞")).id))!;
  await saveImageProfile(
    { ...imageProfile(), url: "https://replacement.fixture.test/v1" },
    "replacement-fixture-key",
  );
  release(response(plan));
  expect((await settled(one.id)).status).toBe("complete");
  expect(fetcher.mock.calls[0][0]).toContain("images.fixture.test");
  expect(
    new Headers((fetcher.mock.calls[0][1] as RequestInit).headers).get(
      "Authorization",
    ),
  ).toBe("Bearer image-secret-fixture");
  const stopped = await settled(queued.id);
  expect(stopped.status).toBe("failed");
  expect(stopped.error).toContain("接口地址或鉴权方式已改变");
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it("only adopts an explicitly chosen pictured role, preserving global cards and old images", async () => {
  const roleId = story.roles[0].id;
  model.mockResolvedValue(response({ ...plan, roleIds: [roleId] }));
  const job = await settled((await createNovelImage((await prose()).id))!.id);
  expect(
    (await db.stories.get(story.id))?.roles[0].imageReferences,
  ).toBeUndefined();
  const globalBefore = await db.roles.toArray();
  await expect(
    adoptImageReference(job.id, story.roles[1].id, {
      name: "错误角色",
      view: "front",
      styleId: "",
    }),
  ).rejects.toThrow("实际出现");
  await adoptImageReference(job.id, roleId, {
    name: "确认定妆",
    view: "front",
    styleId: "korean-3d",
  });
  expect(
    (await db.stories.get(story.id))?.roles[0].imageReferences?.[0].data,
  ).toBe(dataUrl);
  expect(await db.roles.toArray()).toEqual(globalBefore);
  expect((await db.imageJobs.get(job.id))?.assetId).toBe(job.assetId);
});

it("round trips identity, style and multi-view job references through both backup paths and storage cleanup", async () => {
  const custom = {
    ...builtInImageStyles[0],
    id: "my-style",
    name: "我的定妆画风",
  };
  story.roles[0].imageAppearance = "浅灰瞳孔";
  story.roles[0].imageLook = "米色外套";
  story.roles[0].imageReferences = [
    {
      id: "my-ref",
      name: "正面",
      view: "front",
      styleId: custom.id,
      data: dataUrl,
    },
  ];
  await db.stories.update(story.id, {
    roles: story.roles,
    images: imageSettings({
      stylePresetId: custom.id,
      stylePresetSnapshot: custom,
    }),
  });
  await db.preferences.update("preferences", { imageStylePresets: [custom] });
  model.mockResolvedValue(response({ ...plan, roleIds: [story.roles[0].id] }));
  const job = await settled((await createNovelImage((await prose()).id))!.id);
  await compactImageStorage(story.id);
  expect(
    await db.imageAssets.get(job.roles[0].references![0].reference),
  ).toBeDefined();
  const backup = await exportBackup();
  expect(
    validateBackup(backup).stories.find((s) => s.id === story.id)?.roles[0]
      .imageLook,
  ).toBe("米色外套");
  await importBackup(backup);
  const copied = (await db.imageJobs.toArray()).find((j) => j.id !== job.id)!;
  expect(copied.roles[0].references![0].reference).not.toBe(
    job.roles[0].references![0].reference,
  );
  expect(
    await db.imageAssets.get(copied.roles[0].references![0].reference),
  ).toBeDefined();
  const blob = await exportBackupBlob(uid(), story.id);
  const session = uid();
  await stageBackup(blob.blob, session);
  await commitStaged(session, { replace: false, applySettings: false });
  const all = await db.imageJobs.toArray();
  expect(all).toHaveLength(3);
  for (const j of all)
    expect(
      (await db.imageAssets.get(j.roles[0].references![0].reference))?.storyId,
    ).toBe(j.storyId);
  expect(fetcher).toHaveBeenCalledTimes(1);
});
