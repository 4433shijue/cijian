import "fake-indexeddb/auto";
import Dexie from "dexie";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { db, SceneDB } from "../src/db";
import { exportBackup, importBackup } from "../src/backup";
import {
  loadRoleDraft,
  saveCreatedRole,
  saveRoleDraft,
} from "../src/role-draft";
import { uid, type Role } from "../src/types";
import { emptyCompletionDraft } from "../src/role-completion-types";
import { commitStaged, exportBackupBlob, stageBackup } from "../src/backup-transfer";

const role = (): Role => ({
  id: uid(),
  name: "草稿朋友",
  bio: "尚未保存的简介",
  persona: "完整人设",
  avatar: "",
  paragraphs: [],
  updated: Date.now(),
});

beforeEach(async () => {
  await db.delete();
  await db.open();
});
afterEach(async () => {
  await loadRoleDraft();
  vi.restoreAllMocks();
  await db.delete();
});

it("keeps the latest queued edit and cannot recreate a draft after manual save", async () => {
  const first = role();
  const last = { ...first, bio: "最后输入的内容" };
  const writes = [saveRoleDraft(first), saveRoleDraft(last)];
  expect(await loadRoleDraft()).toEqual(last);
  expect(await db.roles.count()).toBe(0);
  const pendingEdit = saveRoleDraft({ ...last, name: "最后的名字" });
  await saveCreatedRole({ ...last, name: "最后的名字" });
  await Promise.all([...writes, pendingEdit]);
  expect(await loadRoleDraft()).toBeUndefined();
  expect(await db.roles.toArray()).toEqual([{ ...last, name: "最后的名字" }]);
});

it("keeps the previous draft on write failure and accepts later edits", async () => {
  const first = role();
  await saveRoleDraft(first);
  vi.spyOn(db.roleDrafts, "put").mockRejectedValueOnce(
    new Error("storage full"),
  );
  await expect(saveRoleDraft({ ...first, name: "还没写入" })).rejects.toThrow();
  expect(await loadRoleDraft()).toEqual(first);
  await saveRoleDraft({ ...first, name: "恢复写入" });
  expect((await loadRoleDraft())?.name).toBe("恢复写入");
});

it("rolls back role creation and keeps its draft if final cleanup fails", async () => {
  const draft = role();
  await saveRoleDraft(draft);
  vi.spyOn(db.roleDrafts, "delete").mockRejectedValueOnce(
    new Error("interrupted"),
  );
  await expect(saveCreatedRole(draft)).rejects.toThrow();
  expect(await db.roles.count()).toBe(0);
  expect(await loadRoleDraft()).toEqual(draft);
  await saveCreatedRole(draft);
  expect(await loadRoleDraft()).toBeUndefined();
  expect(await db.roles.get(draft.id)).toEqual(draft);
});

it("leaves an unfinished draft intact when importing a replacement backup", async () => {
  await db.roles.put(role());
  const backup = await exportBackup();
  const draft = role();
  await saveRoleDraft(draft);
  const completion = emptyCompletionDraft();
  completion.input.source = "还没生成完的故事素材";
  await db.roleCompletionDrafts.put(completion);
  await importBackup(backup, true);
  expect(await loadRoleDraft()).toEqual(draft);
  expect(await db.roleCompletionDrafts.get(completion.id)).toEqual(completion);
  expect(await db.roles.count()).toBe(1);
});

it("preserves local completion material during a streamed replacement import", async () => {
  await db.roles.put(role());
  const output = await exportBackupBlob("completion-backup");
  const completion = emptyCompletionDraft();
  completion.input.source = "替换资料时保留的补全素材";
  await db.roleCompletionDrafts.put(completion);
  await stageBackup(output.blob, "completion-import");
  await commitStaged("completion-import", { replace: true, applySettings: false });
  expect(await db.roleCompletionDrafts.get(completion.id)).toEqual(completion);
  expect(await db.roles.count()).toBe(1);
});

it("upgrades existing browser data without losing saved roles or settings", async () => {
  const name = "draft-migration-" + uid();
  const legacy = new Dexie(name);
  legacy.version(1).stores({
    roles: "id",
    stories: "id,updated",
    world: "id",
    events: "id,storyId,[storyId+seq]",
    memories: "id,storyId,status",
    profiles: "id",
    preferences: "id",
    jobs: "id,storyId,status",
  });
  const saved = role();
  const preferences = {
    id: "preferences",
    activeProfile: "existing-profile",
    developer: false,
    prompts: {},
  };
  await legacy.table("roles").put(saved);
  await legacy.table("preferences").put(preferences);
  legacy.close();
  const upgraded = new SceneDB(name);
  try {
    await upgraded.open();
    expect(await upgraded.roles.get(saved.id)).toEqual(saved);
    expect(await upgraded.preferences.get("preferences")).toEqual(preferences);
    expect(await upgraded.roleDrafts.count()).toBe(0);
    expect(await upgraded.roleCompletionDrafts.count()).toBe(0);
  } finally {
    await upgraded.delete();
  }
});
