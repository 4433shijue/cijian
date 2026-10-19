import { ensureAutomation } from "./phone-automation";
import Dexie from "dexie";
import { withStoryLock } from "./locks";
import { db, makeStory } from "./db";
import { uid, type Story, type Role, type WorldEntry } from "./types";
import { ensurePhone, remapPhone } from "./phone-store";
import { phoneTables } from "./phone-types";
import { extraTables } from "./work-types";
import { visibleText, usableEvent } from "./timeline";
import { memoryValid, selectRoundContext } from "./rounds";

export async function requireStory(id: string, kind?: Story["kind"]) {
  const story = await db.stories.get(id);
  if (!story || !story.kind)
    throw Error("作品尚未完成升级，请回到故事列表重试迁移");
  if (kind && story.kind !== kind)
    throw Error(
      kind === "phone"
        ? "这本是小说作品，不能写入手机内容"
        : "这本是手机作品，不能写入小说内容",
    );
  return story;
}

async function copyWorld(
  story: Story,
  entries: WorldEntry[],
  remap: (id: string) => string,
) {
  const copies = entries.map((w) => ({
    ...structuredClone(w),
    id: uid(),
    storyId: story.id,
    sourceId: w.id,
    roleIds: w.roleIds.map(remap),
    knownBy: w.knownBy.map(remap),
    // A restriction excluding the old work remains disabled in the copy.
    enabled: w.enabled,
    storyIds: [story.id],
  }));
  await db.storyWorld.bulkAdd(copies);
  story.worldIds = copies.map((w) => w.id);
}

export async function createStory(input: {
  kind: Story["kind"];
  title: string;
  roles: Role[];
  worldIds: string[];
  background: string;
  audience?: string[];
  secret?: string;
}) {
  if (!["novel", "phone"].includes(input.kind)) throw Error("请先选择作品模式");
  if (!input.title.trim() || !input.roles.length)
    throw Error("请填写作品名字并选择角色");
  return db.transaction("rw", db.tables, async () => {
    const mapping = new Map(input.roles.map((r) => [r.id, uid()]));
    const remap = (id: string) => mapping.get(id) || id;
    const roles = input.roles.map((r) => ({
      ...structuredClone(r),
      id: remap(r.id),
      sourceId: r.sourceId || r.id,
      paragraphs: r.paragraphs.map((p) => ({ ...p, id: uid() })),
    }));
    const story = makeStory(
      input.kind,
      input.title.trim(),
      roles,
      [],
      input.kind === "novel" ? input.background : input.secret || "",
    );
    story.roles = roles;
    const entries = (await db.world.bulkGet(input.worldIds)).filter(
      (w): w is WorldEntry => !!w && !w.storyIds.length,
    );
    await copyWorld(story, entries, remap);
    if (story.kind === "phone") {
      story.autoMemory = false;
      story.theaterAuto = false;
    }
    await db.stories.add(story);
    if (story.kind === "phone") {
      await ensurePhone(story.id);
      await ensureAutomation(story.id);
      if (input.background.trim())
        await db.phoneBackgrounds.add({
          id: uid(),
          storyId: story.id,
          title: "开场背景",
          text: input.background.trim(),
          audience: (input.audience || input.roles.map((r) => r.id)).map(remap),
          enabled: true,
          updated: Date.now(),
        });
    }
    return story;
  });
}

export async function attachWorld(storyId: string, templateId: string) {
  return db.transaction("rw", db.tables, async () => {
    const story = await requireStory(storyId),
      template = await db.world.get(templateId);
    if (!template) throw Error("世界书模板不存在");
    const mapping = new Map(story.roles.map((r) => [r.sourceId || r.id, r.id]));
    const original = [...story.worldIds];
    await copyWorld(story, [template], (id) => mapping.get(id) || id);
    await db.stories.update(story.id, {
      worldIds: [...original, ...story.worldIds],
      updated: Date.now(),
    });
  });
}

async function splitLegacy(storyId: string) {
  return db.transaction("rw", db.tables, async () => {
    const old = await db.stories.get(storyId);
    if (!old || old.kind) return;
    await ensurePhone(old.id, true);
    const events = await db.events
      .where("storyId")
      .equals(old.id)
      .sortBy("seq");
    const prose = events.filter((e) => e.kind === "novel");
    const memories = await db.memories
      .where("storyId")
      .equals(old.id)
      .toArray();
    const prefs = (await db.preferences.get("preferences")) || {
      id: "preferences" as const,
      activeProfile: "",
      developer: false,
      prompts: {},
    };
    const phoneId = uid(),
      roleMap = new Map(old.roles.map((r) => [r.id, uid()]));
    const remap = (id: string) =>
      id === old.id ? phoneId : roleMap.get(id) || id;
    const phone = {
      ...structuredClone(old),
      id: phoneId,
      kind: "phone" as const,
      title: old.title + "·手机",
      roles: old.roles.map((r) => ({
        ...structuredClone(r),
        id: remap(r.id),
        sourceId: r.sourceId || r.id,
        paragraphs: r.paragraphs.map((p) => ({ ...p, id: uid() })),
      })),
      player: remap(old.player),
      partner: remap(old.partner),
      draft: "",
      chatDraft: "",
      background: "",
      memoryState: "idle" as const,
      memoryError: "",
      autoMemory: false,
      theaterAuto: false,
      memorySelection: undefined,
      inspiration: undefined,
      inspirationRequest: undefined,
      inspirationRevision: undefined,
    };
    const novel: Story = {
      ...old,
      kind: "novel",
      title: old.title + "·小说",
      chatDraft: "",
      memorySelection: undefined,
      inspiration: undefined,
      inspirationRequest: undefined,
      inspirationRevision: undefined,
    };
    const templates = (await db.world.bulkGet(old.worldIds))
      .filter((w): w is WorldEntry => !!w)
      .map((w) => ({
        ...w,
        enabled:
          w.enabled && (!w.storyIds.length || w.storyIds.includes(old.id)),
      }));
    await copyWorld(novel, templates, (id) => id);
    await copyWorld(phone, templates, remap);
    await db.stories.put(novel);
    await db.stories.add(phone);
    for (const role of old.roles) {
      const selected = selectRoundContext(
        old,
        prose,
        memories,
        prefs,
        role.id,
        false,
        false,
      );
      const active = new Set([
        ...selected.history.map((e) => e.id),
        ...selected.selected.map((m) => m.id),
      ]);
      for (const event of prose) {
        const text = visibleText(event, role.id, old);
        if (!text || !usableEvent(event, old)) continue;
        await db.phoneBackgrounds.add({
          id: uid(),
          storyId: phoneId,
          title: `承接正文 · 第 ${event.round || event.seq} 回 · ${role.name}`,
          text,
          audience: [remap(role.id)],
          enabled: active.has(event.id),
          source: {
            id: event.id,
            version: event.versionId,
            seq: event.seq,
            kind: "prose",
          },
          updated: Date.now(),
        });
      }
      for (const memory of memories.filter((m) =>
        memoryValid(m, old, prose, role.id),
      )) {
        await db.phoneBackgrounds.add({
          id: uid(),
          storyId: phoneId,
          title: `承接记忆 · ${role.name}`,
          text: memory.text,
          audience: [remap(role.id)],
          enabled: active.has(memory.id),
          source: {
            id: memory.id,
            version: "",
            seq: Math.max(
              0,
              ...memory.sources.map(
                (ref) => prose.find((e) => e.id === ref.id)?.seq || 0,
              ),
            ),
            kind: "memory",
          },
          updated: Date.now(),
        });
      }
    }
    for (const table of phoneTables) {
      for (const row of await db
        .table(table)
        .where("storyId")
        .equals(old.id)
        .toArray())
        await db.table(table).put(remapPhone(table, row, remap));
    }
    const archive = async (table: string, value: any) =>
      db.legacyArchives.add({
        id: uid(),
        storyId: phoneId,
        table,
        originalId: value.id,
        value: structuredClone(value),
        created: Date.now(),
      });
    const proseIds = new Set(prose.map((e) => e.id));
    for (const event of events.filter((e) => e.kind === "message")) {
      await archive("events", event);
      await db.events.delete(event.id);
    }
    for (const memory of memories.filter(
      (m) =>
        !m.sources.length || m.sources.some((ref) => !proseIds.has(ref.id)),
    )) {
      await archive("memories", memory);
      await db.memories.delete(memory.id);
    }
    for (const batch of await db.chatBatches
      .where("storyId")
      .equals(old.id)
      .toArray()) {
      await archive("chatBatches", batch);
      await db.chatBatches.delete(batch.id);
    }
    for (const job of await db.jobs.where("storyId").equals(old.id).toArray()) {
      if (job.kind === "chat") {
        await archive("jobs", job);
        await db.jobs.delete(job.id);
      }
    }
    await db.promptSessions.where("storyId").equals(old.id).delete();
    for (const id of [old.id, phoneId])
      await db.storyMigrations.add({
        id: uid(),
        storyId: id,
        sourceId: old.id,
        novelId: old.id,
        phoneId,
        map: Object.fromEntries(roleMap),
        acknowledged: false,
        created: Date.now(),
      });
  });
}

export async function migrateStories() {
  const work = async () => {
    for (const story of await db.stories.toArray())
      if (!story.kind) {
        if (Dexie.currentTransaction) await splitLegacy(story.id);
        else
          await withStoryLock(story.id, () =>
            withStoryLock(`phone:${story.id}`, () => splitLegacy(story.id)),
          );
      }
  };
  // Import already owns one atomic IndexedDB transaction; do not await an external lock inside it.
  if (db.isOpen() && Dexie.currentTransaction) return work();
  if (typeof navigator !== "undefined" && navigator.locks)
    return navigator.locks.request("little-scene:migration", work);
  return work();
}

export async function updateStory(id: string, patch: Partial<Story>) {
  const story = await requireStory(id);
  if (patch.kind && patch.kind !== story.kind)
    throw Error("作品模式在创建后不能更改");
  await db.stories.update(id, {
    ...patch,
    kind: story.kind,
    updated: Date.now(),
  });
}

export const workTables = extraTables;
