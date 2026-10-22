import "fake-indexeddb/auto";
import { beforeEach, afterEach, it, expect, vi } from "vitest";
import { db, initialize, sessionKeys, deleteStory } from "../src/db";
import { createStory } from "../src/story-service";
import {
  ensureAutomation,
  startAutomation,
  continueAutomation,
  pauseAutomation,
  cancelAutomation,
  initializeAutomation,
  emptyAction,
  saveAutomation,
  adoptAutomation,
  undoAutomation,
  extendRequestLimit,
  suggestHabits,
} from "../src/phone-automation";
import {
  conversation,
  addRecord,
  editRecord,
  likeMoment,
} from "../src/phone-store";
import { emptyBody } from "../src/phone-types";
import { savePhoneDocument } from "../src/phone-authoring";
import { startPhoneRun, continuePhoneRun } from "../src/phone-generation";
import { exportBackup, importBackup, validateBackup } from "../src/backup";
import {
  exportBackupBlob,
  stageBackup,
  commitStaged,
} from "../src/backup-transfer";
import { buildReaderPackage } from "../src/phone-reader";
import { generate } from "../src/model";
import { uid, type Story } from "../src/types";
vi.mock("../src/model", () => ({ generate: vi.fn() }));
const model = vi.mocked(generate);
let story: Story, cid: string;
const action = (patch = {}) => ({
  ...emptyAction(),
  reason: "角色自己的选择",
  ...patch,
});
const content = (text = "今晚有雨") => ({
  messages: [{ ...emptyBody(), text }],
  title: "夜雨",
  text,
  assets: [],
});
const result = (value: unknown) =>
  ({
    text: JSON.stringify(value),
    complete: true,
    reason: "stop",
    usage: {},
  }) as any;
const setup = async (patch = {}) => ({
  ...(await ensureAutomation(story.id)),
  ...patch,
});
const waitRun = async (id: string, status?: string) => {
  await vi.waitFor(
    async () => {
      const run = await db.phoneAutomationRuns.get(id);
      expect(status ? run?.status : run?.status !== "running").toBe(
        status || true,
      );
    },
    { timeout: 8000, interval: 10 },
  );
  return (await db.phoneAutomationRuns.get(id))!;
};
const run = async (patch = {}) => {
  const id = await startAutomation(story.id, await setup(patch));
  await waitRun(id);
  return id;
};
beforeEach(async () => {
  await db.delete();
  await db.open();
  await initialize();
  const template = (await db.stories.toArray())[0];
  story = await createStory({
    kind: "phone",
    title: "雨夜",
    roles: template.roles,
    worldIds: [],
    background: "PUBLIC_BACKGROUND",
    secret: "AUTHOR_SECRET",
  });
  cid = await conversation(story, [story.player, story.partner]);
  await db.profiles.put({
    id: "auto-fixture",
    name: "fixture",
    protocol: "chat",
    url: "https://fixture.invalid/v1",
    model: "fixture",
    context: 128000,
    maxOutput: 2000,
    stream: false,
    timeout: 10,
    remember: false,
    temperature: 0.37,
  });
  sessionKeys.set("auto-fixture", "fixture-key");
  await db.preferences.update("preferences", { activeProfile: "auto-fixture" });
  model.mockReset();
  model.mockResolvedValue(result(action()));
});
afterEach(() => {
  sessionKeys.clear();
  vi.restoreAllMocks();
});

it("gives one AI five opportunities, excludes the user role and never creates messages for waiting", async () => {
  const id = await run();
  expect((await waitRun(id)).status).toBe("complete");
  expect(model).toHaveBeenCalledTimes(5);
  const steps = await db.phoneAutomationSteps
    .where("runId")
    .equals(id)
    .toArray();
  expect(steps.map((s) => s.round).sort()).toEqual([1, 2, 3, 4, 5]);
  expect(steps.every((s) => s.actorId === story.partner)).toBe(true);
  expect(await db.phoneRecords.count()).toBe(0);
});
it("allows explicit takeover, serializes actors and freezes every profile temperature", async () => {
  const id = await run({ takeover: true, rounds: 2 });
  expect(model).toHaveBeenCalledTimes(4);
  const steps = (
    await db.phoneAutomationSteps.where("runId").equals(id).toArray()
  ).sort((a, b) => a.round - b.round || a.order - b.order);
  expect(steps.map((s) => s.actorId)).toEqual(
    [...story.roles, ...story.roles].map((r) => r.id),
  );
  expect(steps.every((s) => s.profile.temperature === 0.37)).toBe(true);
});
it("waits only in the user's conversation while a later round publishes a moment", async () => {
  model
    .mockResolvedValueOnce(
      result(action({ kind: "chat", conversationId: cid })),
    )
    .mockResolvedValueOnce(result(content("在吗")))
    .mockResolvedValueOnce(
      result(
        action({ kind: "moment", audience: story.roles.map((r) => r.id) }),
      ),
    )
    .mockResolvedValueOnce(result(content()));
  const id = await run({ rounds: 2 });
  expect((await waitRun(id)).status).toBe("complete");
  expect(
    (await db.phoneRecords.toCollection().sortBy("seq")).map((r) => r.kind),
  ).toEqual(["message", "moment"]);
  expect(model.mock.calls[2][3]).toContain(cid);
  expect((await db.phoneAutomationRuns.get(id))?.waiting[cid]).toBeTruthy();
});
it("new user messages enter the next round and release a wait without restarting completed tasks", async () => {
  let calls = 0;
  model.mockImplementation(async () => {
    calls++;
    if (calls === 1) {
      await addRecord(story.id, {
        speakerId: story.player,
        conversationId: cid,
        body: { ...emptyBody(), text: "MID_ROUND" },
        pending: true,
      });
      return result(action());
    }
    return result(action());
  });
  const id = await run({ rounds: 2 });
  expect(model.mock.calls[0][3]).not.toContain("MID_ROUND");
  expect(model.mock.calls[1][3]).toContain("MID_ROUND");
  await addRecord(story.id, {
    speakerId: story.player,
    conversationId: cid,
    body: { ...emptyBody(), text: "AFTER_COMPLETION" },
  });
  expect(model).toHaveBeenCalledTimes(2);
  await expect(continueAutomation(id)).rejects.toThrow("已经结束");
});
it("keeps private documents and author secrets out of another actor's requests", async () => {
  await savePhoneDocument({
    storyId: story.id,
    ownerId: story.player,
    kind: "note",
    title: "秘密",
    text: "PRIVATE_NOTE",
  });
  await run({ rounds: 1 });
  const sent = model.mock.calls[0][3];
  expect(sent).toContain("PUBLIC_BACKGROUND");
  expect(sent).not.toContain("AUTHOR_SECRET");
  expect(sent).not.toContain("PRIVATE_NOTE");
});
it("rejects forbidden audience and fabricated asset IDs before writing", async () => {
  model.mockResolvedValueOnce(
    result(
      action({ kind: "moment", audience: [story.partner, "foreign-role"] }),
    ),
  );
  let id = await run({ rounds: 1 });
  expect((await waitRun(id)).status).toBe("failed");
  expect(await db.phoneRecords.count()).toBe(0);
  model
    .mockResolvedValueOnce(
      result(action({ kind: "moment", audience: [story.partner] })),
    )
    .mockResolvedValueOnce(
      result({
        ...content(),
        messages: [
          {
            ...emptyBody(),
            type: "image",
            text: "图",
            assets: ["foreign-asset"],
          },
        ],
      }),
    );
  id = await run({ rounds: 1 });
  expect((await waitRun(id)).status).toBe("failed");
  expect(await db.phoneRecords.count()).toBe(0);
});
it("pauses an active request, ignores late output, resumes the same snapshot without replaying successes", async () => {
  let release: (x: any) => void = () => {};
  model.mockResolvedValueOnce(result(action())).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const id = await startAutomation(story.id, await setup({ rounds: 2 }));
  await vi.waitFor(() => expect(model).toHaveBeenCalledTimes(2));
  await expect(startAutomation(story.id, await setup())).rejects.toThrow(
    /正在自动推进|另一个标签页/,
  );
  await expect(
    startPhoneRun({
      storyId: story.id,
      ownerId: story.player,
      conversationId: cid,
      speakers: [story.partner],
      mode: "participate",
    }),
  ).rejects.toThrow("正在自动推进");
  await pauseAutomation(id);
  release(result(action()));
  await vi.waitFor(async () =>
    expect(
      (await db.phoneAutomationSteps.where("runId").equals(id).toArray()).some(
        (s) => s.status === "failed",
      ),
    ).toBe(true),
  );
  const preferences = (await db.preferences.get("preferences"))!;
  await db.preferences.update("preferences", {
    prompts: {
      ...preferences.prompts,
      phoneDecision: { text: "NEW_PROMPT", enabled: true },
    },
  });
  model.mockResolvedValue(result(action()));
  await continueAutomation(id);
  expect(model).toHaveBeenCalledTimes(3);
  expect(model.mock.calls[2][2]).not.toContain("NEW_PROMPT");
  expect((await db.phoneAutomationRuns.get(id))?.status).toBe("complete");
});
it("preserves failed content output and retries content only under the original prompt", async () => {
  model
    .mockResolvedValueOnce(
      result(action({ kind: "moment", audience: [story.partner] })),
    )
    .mockResolvedValueOnce(result({ messages: [] }));
  const id = await run({ rounds: 1 });
  expect((await waitRun(id)).status).toBe("failed");
  model.mockResolvedValueOnce(result(content()));
  await continueAutomation(id);
  expect(model).toHaveBeenCalledTimes(3);
  expect(model.mock.calls[2][7]?.kind).toBe("phoneMoment");
  expect(await db.phoneRecords.count()).toBe(1);
});
it("stops at request limits and resumes without regenerating the decision", async () => {
  model.mockResolvedValueOnce(
    result(action({ kind: "moment", audience: [story.partner] })),
  );
  const id = await run({ rounds: 1, maxRequests: 1 });
  expect((await waitRun(id)).status).toBe("paused");
  await extendRequestLimit(id, 2);
  model.mockResolvedValueOnce(result(content()));
  await continueAutomation(id);
  expect(model).toHaveBeenCalledTimes(2);
  expect(await db.phoneRecords.count()).toBe(1);
});
it("drafts remain isolated, adopt atomically and undo without deleting handwritten records", async () => {
  model
    .mockResolvedValueOnce(
      result(action({ kind: "moment", audience: [story.partner] })),
    )
    .mockResolvedValueOnce(result(content()));
  const id = await run({ rounds: 1, mode: "draft" });
  expect(await db.phoneRecords.count()).toBe(0);
  await adoptAutomation(id);
  expect(await db.phoneRecords.count()).toBe(1);
  const hand = await addRecord(story.id, {
    speakerId: story.player,
    conversationId: cid,
    body: { ...emptyBody(), text: "手写" },
  });
  await undoAutomation(id);
  expect((await db.phoneRecords.get(hand.id))?.deleted).toBe(false);
  expect(
    (await db.phoneRecords.filter((r) => r.origin === "ai").first())?.deleted,
  ).toBe(true);
});
it("a changed source prevents draft adoption with no partial writes", async () => {
  const source = await addRecord(story.id, {
    speakerId: story.player,
    conversationId: cid,
    body: { ...emptyBody(), text: "原文" },
  });
  model
    .mockResolvedValueOnce(
      result(action({ kind: "moment", audience: [story.partner] })),
    )
    .mockResolvedValueOnce(result(content()));
  const id = await run({ rounds: 1, mode: "draft" });
  await editRecord(
    source.id,
    { body: { ...emptyBody(), text: "改稿" } },
    source.versionId,
  );
  await expect(adoptAutomation(id)).rejects.toThrow("参考资料已修改");
  expect(await db.phoneRecords.count()).toBe(1);
});
it("rejects undo after a user edits the result, preserving both versions", async () => {
  model
    .mockResolvedValueOnce(
      result(action({ kind: "moment", audience: [story.partner] })),
    )
    .mockResolvedValueOnce(result(content()));
  const id = await run({ rounds: 1 });
  const output = (await db.phoneRecords.toArray())[0];
  await editRecord(
    output.id,
    { body: { ...emptyBody(), text: "用户改稿" } },
    output.versionId,
  );
  await expect(undoAutomation(id)).rejects.toThrow("后来被编辑");
  expect((await db.phoneRecords.get(output.id))?.versions).toHaveLength(2);
});
it("enabled custom prompts still apply after developer mode is hidden", async () => {
  const p = (await db.preferences.get("preferences"))!;
  await db.preferences.update("preferences", {
    developer: false,
    prompts: {
      ...p.prompts,
      phoneDecision: { text: "DECISION_CUSTOM", enabled: true },
      phoneMoment: { text: "MOMENT_CUSTOM", enabled: true },
    },
  });
  model
    .mockResolvedValueOnce(
      result(action({ kind: "moment", audience: [story.partner] })),
    )
    .mockResolvedValueOnce(result(content()));
  await run({ rounds: 1 });
  expect(model.mock.calls[0][2]).toContain("DECISION_CUSTOM");
  expect(model.mock.calls[1][2]).toContain("MOMENT_CUSTOM");
});
it("stores reading only for actually supplied records, respecting browsing cadence", async () => {
  await ensureAutomation(story.id);
  const m = await addRecord(story.id, {
    speakerId: story.player,
    kind: "moment",
    audience: [story.player, story.partner],
    body: { ...emptyBody(), text: "可见动态" },
  });
  await run({ rounds: 1 });
  expect(
    await db.phoneKnowledge.filter((k) => k.targetId === m.id).count(),
  ).toBe(1);
  expect(
    (await db.phoneKnowledge.filter((k) => k.targetId === m.id).first())
      ?.actorId,
  ).toBe(story.partner);
});
it.each(["legacy", "stream"])(
  "round-trips automatic jobs and snapshots through %s backup and removes all on deletion",
  async (route) => {
    model
      .mockResolvedValueOnce(
        result(action({ kind: "moment", audience: [story.partner] })),
      )
      .mockResolvedValueOnce(result(content()));
    await run({ rounds: 1 });
    const b = await exportBackup();
    expect(b.version).toBe(9);
    validateBackup(b);
    if (route === "legacy") await importBackup(b);
    else {
      const exported = await exportBackupBlob(uid(), story.id);
      const staged = await stageBackup(exported.blob, uid());
      await commitStaged(staged.session, {
        replace: false,
        applySettings: false,
      });
    }
    const copy = (await db.stories.toArray()).find(
      (s) => s.kind === "phone" && s.id !== story.id,
    )!;
    expect(copy).toBeTruthy();
    const job = (
      await db.phoneAutomationRuns.where("storyId").equals(copy.id).toArray()
    )[0];
    const step = (
      await db.phoneAutomationSteps.where("runId").equals(job.id).toArray()
    )[0];
    expect(step.result?.records[0].storyId).toBe(copy.id);
    expect(copy.roles.some((r) => r.id === step.actorId)).toBe(true);
    validateBackup(await exportBackup());
    await deleteStory(copy.id);
    expect(
      await db.phoneAutomationSteps.where("storyId").equals(copy.id).count(),
    ).toBe(0);
  },
);
it("marks abandoned jobs recoverable without automatically contacting a provider", async () => {
  const id = await run({ rounds: 1 });
  await db.phoneAutomationRuns.update(id, { status: "running" });
  model.mockClear();
  await initializeAutomation();
  expect((await db.phoneAutomationRuns.get(id))?.status).toBe("interrupted");
  expect(model).not.toHaveBeenCalled();
});
it("reader packages exclude unadopted drafts, snapshots, secrets and interface details", async () => {
  model
    .mockResolvedValueOnce(
      result(action({ kind: "moment", audience: [story.partner] })),
    )
    .mockResolvedValueOnce(result(content("DRAFT_EXCLUSIVE")));
  await run({ rounds: 1, mode: "draft" });
  const reader = JSON.stringify(await buildReaderPackage(story.id));
  expect(reader).not.toMatch(
    /DRAFT_EXCLUSIVE|AUTHOR_SECRET|fixture.invalid|phoneAutomation/,
  );
});

it.each(["note", "draft", "event", "comment", "chat"])(
  "uses the dedicated prompt and validates the %s action",
  async (kind) => {
    const key =
      kind === "comment"
        ? "phoneInteraction"
        : kind === "event"
          ? "phoneEvent"
          : kind === "chat"
            ? "chat"
            : "phoneDocument";
    const p = (await db.preferences.get("preferences"))!;
    await db.preferences.update("preferences", {
      prompts: {
        ...p.prompts,
        [key]: { text: "CUSTOM_" + key, enabled: true },
      },
      developer: false,
    });
    const parent = await addRecord(story.id, {
      kind: "moment",
      speakerId: story.player,
      audience: [story.player, story.partner],
      body: { ...emptyBody(), text: "下雨了" },
    });
    model
      .mockResolvedValueOnce(
        result(
          action({
            kind,
            conversationId: kind === "chat" ? cid : "",
            parentId: kind === "comment" ? parent.id : "",
            audience: [story.partner],
          }),
        ),
      )
      .mockResolvedValueOnce(result(content()));
    const id = await run({ rounds: 1 });
    expect((await waitRun(id)).status).toBe("complete");
    expect(model.mock.calls[1][2]).toContain("CUSTOM_" + key);
    validateBackup(await exportBackup());
  },
);
it("offers AI habit suggestions without saving them until the user confirms", async () => {
  const p = (await db.preferences.get("preferences"))!;
  await db.preferences.update("preferences", {
    prompts: {
      ...p.prompts,
      phoneHabits: { text: "CUSTOM_HABITS", enabled: true },
    },
  });
  const before = await ensureAutomation(story.id);
  model.mockResolvedValueOnce(
    result({ ...before.habits[story.partner], initiative: "active" }),
  );
  const suggestion = await suggestHabits(
    story.id,
    story.partner,
    new AbortController().signal,
  );
  expect(suggestion.initiative).toBe("active");
  expect((await ensureAutomation(story.id)).habits).toEqual(before.habits);
  expect(model.mock.calls[0][2]).toContain("CUSTOM_HABITS");
});
it("multi-round draft document edits use the draft overlay and adopt and undo atomically", async () => {
  const original = await savePhoneDocument({
    storyId: story.id,
    ownerId: story.partner,
    kind: "note",
    title: "购物清单",
    text: "OLD_NOTE",
  });
  model
    .mockResolvedValueOnce(
      result(action({ kind: "note", documentId: original.id })),
    )
    .mockResolvedValueOnce(result({ ...content("FIRST_DRAFT"), messages: [] }))
    .mockResolvedValueOnce(
      result(action({ kind: "note", documentId: original.id })),
    )
    .mockResolvedValueOnce(
      result({ ...content("SECOND_DRAFT"), messages: [] }),
    );
  const id = await run({ rounds: 2, mode: "draft" });
  expect((await waitRun(id)).status).toBe("complete");
  expect(model.mock.calls[2][3]).toContain("FIRST_DRAFT");
  expect(model.mock.calls[2][3]).not.toContain("OLD_NOTE");
  expect((await db.phoneDocuments.get(original.id))?.text).toBe("OLD_NOTE");
  await adoptAutomation(id);
  expect((await db.phoneDocuments.get(original.id))?.text).toBe("SECOND_DRAFT");
  await undoAutomation(id);
  expect((await db.phoneDocuments.get(original.id))?.text).toBe("OLD_NOTE");
  expect(
    (await db.phoneDocuments.get(original.id))?.versions.length,
  ).toBeGreaterThan(1);
});
it("dependent automatic batches undo in reverse order and never remove handwritten comments", async () => {
  model
    .mockResolvedValueOnce(
      result(
        action({ kind: "moment", audience: story.roles.map((r) => r.id) }),
      ),
    )
    .mockResolvedValueOnce(result(content()));
  const first = await run({ rounds: 1 });
  const post = (await db.phoneRecords.toArray())[0];
  model
    .mockResolvedValueOnce(
      result(action({ kind: "comment", parentId: post.id })),
    )
    .mockResolvedValueOnce(result(content("第二批评论")));
  const second = await run({ rounds: 1 });
  await expect(undoAutomation(first)).rejects.toThrow("后续自动批次");
  const manual = await addRecord(story.id, {
    speakerId: story.player,
    kind: "comment",
    parentId: post.id,
    body: { ...emptyBody(), text: "手写评论" },
  });
  await expect(undoAutomation(first, true)).rejects.toThrow("不能连带删除");
  expect((await db.phoneAutomationRuns.get(second))?.status).toBe("complete");
  await editRecord(manual.id, { deleted: true }, manual.versionId);
  await undoAutomation(first, true);
  expect((await db.phoneAutomationRuns.get(second))?.status).toBe("undone");
  expect((await db.phoneAutomationRuns.get(first))?.status).toBe("undone");
});
it("restores a failed step from a remapped backup under its original references", async () => {
  model
    .mockResolvedValueOnce(
      result(action({ kind: "moment", audience: [story.partner] })),
    )
    .mockResolvedValueOnce(result({ bad: "output" }));
  await run({ rounds: 1 });
  await importBackup(await exportBackup());
  const copy = (await db.stories.toArray()).find(
    (s) => s.kind === "phone" && s.id !== story.id,
  )!;
  const job = (
    await db.phoneAutomationRuns.where("storyId").equals(copy.id).toArray()
  )[0];
  model.mockResolvedValueOnce(result(content()));
  await continueAutomation(job.id);
  expect((await db.phoneAutomationRuns.get(job.id))?.status).toBe("complete");
});
it("deleting a work stops its in-flight request without leaving orphaned steps", async () => {
  let release: (x: any) => void = () => {};
  model.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const id = await startAutomation(story.id, await setup({ rounds: 1 }));
  await vi.waitFor(() => expect(model).toHaveBeenCalledTimes(1));
  await deleteStory(story.id);
  release(result(action()));
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(await db.phoneAutomationSteps.where("runId").equals(id).count()).toBe(
    0,
  );
  expect(await db.phoneAutomationRuns.get(id)).toBeUndefined();
});

it("manual moment editor drafts and their rewrites never publish automatically", async () => {
  model.mockResolvedValue(
    result({ messages: [{ type: "text", text: "草稿文字" }] }),
  );
  const id = await startPhoneRun({
    storyId: story.id,
    ownerId: story.player,
    speakers: [story.partner],
    mode: "moment",
    audience: [story.partner],
    draftOnly: true,
  });
  expect((await db.phoneRuns.get(id))?.staged?.["0"][0].text).toBe("草稿文字");
  expect(await db.phoneRecords.count()).toBe(0);
  await continuePhoneRun(id, true);
  expect(await db.phoneRecords.count()).toBe(0);
  expect((await db.phoneRuns.get(id))?.staged?.["0"][0].text).toBe("草稿文字");
});
it("automatic replies consume only snapshotted inputs and restore pending status on undo", async () => {
  const input = await addRecord(story.id, {
    speakerId: story.player,
    conversationId: cid,
    body: { ...emptyBody(), text: "下雨了" },
    pending: true,
  });
  model
    .mockResolvedValueOnce(
      result(action({ kind: "chat", conversationId: cid })),
    )
    .mockResolvedValueOnce(result(content("我带伞了")));
  const id = await run({ rounds: 1 });
  expect((await db.phoneRecords.get(input.id))?.pending).toBe(false);
  await undoAutomation(id);
  expect((await db.phoneRecords.get(input.id))?.pending).toBe(true);
});
it("an author-modified like prevents undo and all results roll back together", async () => {
  const post = await addRecord(story.id, {
    kind: "moment",
    speakerId: story.player,
    audience: story.roles.map((r) => r.id),
    body: { ...emptyBody(), text: "雨夜" },
  });
  model.mockResolvedValueOnce(
    result(action({ kind: "like", parentId: post.id })),
  );
  const id = await run({ rounds: 1 });
  expect((await db.phoneRecords.get(post.id))?.likes).toContain(story.partner);
  await likeMoment(post.id, story.partner);
  await likeMoment(post.id, story.partner);
  await expect(undoAutomation(id)).rejects.toThrow("点赞后来被修改");
});
it("cancels a paused batch while retaining successful content and refusing automatic resume", async () => {
  const id = await run({ rounds: 2, maxRequests: 1 });
  await cancelAutomation(id);
  expect((await db.phoneAutomationRuns.get(id))?.status).toBe("cancelled");
  await expect(continueAutomation(id)).rejects.toThrow("已经结束");
  expect(await db.phoneAutomationSteps.where("runId").equals(id).count()).toBe(
    2,
  );
});
it("imports version 6 with no automatic tables and keeps new prompts through version 7 round trips", async () => {
  const b: any = await exportBackup();
  b.version = 6;
  for (const key of [
    "phoneAutomationSettings",
    "phoneAutomationRuns",
    "phoneAutomationSteps",
    "phoneKnowledge",
    "phoneWorldEvents",
  ])
    delete b[key];
  await importBackup(b);
  expect(await db.phoneAutomationSettings.count()).toBe(2);
  const prefs = (await db.preferences.get("preferences"))!;
  await db.preferences.update("preferences", {
    prompts: {
      ...prefs.prompts,
      phoneDecision: { text: "我的行动提示词", enabled: true },
    },
  });
  validateBackup(await exportBackup());
});

it("new automatic private documents cannot expand their audience", async () => {
  model
    .mockResolvedValueOnce(
      result(action({ kind: "note", audience: story.roles.map((r) => r.id) })),
    )
    .mockResolvedValueOnce(result({ ...content(), messages: [] }));
  const id = await run({ rounds: 1 });
  expect((await waitRun(id)).status).toBe("complete");
  expect((await db.phoneDocuments.toArray())[0].audience).toEqual([
    story.partner,
  ]);
});
it("rejects unrelated action targets and system-message impersonation", async () => {
  model.mockResolvedValueOnce(
    result(action({ kind: "moment", conversationId: cid })),
  );
  const id = await run({ rounds: 1 });
  expect((await waitRun(id)).status).toBe("failed");
  model
    .mockResolvedValueOnce(
      result(action({ kind: "chat", conversationId: cid })),
    )
    .mockResolvedValueOnce(
      result({
        ...content(),
        messages: [{ ...emptyBody(), type: "system", text: "移除群成员" }],
      }),
    );
  const next = await run({ rounds: 1 });
  expect((await waitRun(next)).status).toBe("failed");
  expect(await db.phoneRecords.count()).toBe(0);
});
