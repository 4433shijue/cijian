import Dexie, { type Table } from "dexie";
import {
  uid,
  paragraphs,
  type Role,
  type Story,
  type WorldEntry,
  type SceneEvent,
  type Memory,
  type Profile,
  type Preferences,
  type Job,
  type ChatBatch,
} from "./types";
export class SceneDB extends Dexie {
  roles!: Table<Role, string>;
  roleDrafts!: Table<{ id: string; role: Role }, string>;
  stories!: Table<Story, string>;
  world!: Table<WorldEntry, string>;
  events!: Table<SceneEvent, string>;
  memories!: Table<Memory, string>;
  profiles!: Table<Profile, string>;
  preferences!: Table<Preferences, string>;
  jobs!: Table<Job, string>;
  chatBatches!: Table<ChatBatch, string>;
  constructor(name = "little-scene-v1") {
    super(name);
    this.version(1).stores({
      roles: "id",
      stories: "id,updated",
      world: "id",
      events: "id,storyId,[storyId+seq]",
      memories: "id,storyId,status",
      profiles: "id",
      preferences: "id",
      jobs: "id,storyId,status",
    });
    this.version(2).stores({ roleDrafts: "id" });
    this.version(3).stores({ chatBatches: "id,storyId,status" });
  }
}
export const db = new SceneDB();
export const sessionKeys = new Map<string, string>();
export const keyFor = (p: Profile) =>
  sessionKeys.get(p.id) || (p.remember ? p.key : "") || "";
export async function saveProfile(p: Profile, key: string) {
  await db.profiles.put({ ...p, key: p.remember ? key : undefined });
  sessionKeys.set(p.id, key);
}
export function makeStory(
  title: string,
  roles: Role[],
  worldIds: string[] = [],
  background = "",
): Story {
  return {
    id: uid(),
    title,
    roles: structuredClone(roles).map((r) => ({ ...r, sourceId: r.id })),
    worldIds,
    background,
    created: Date.now(),
    updated: Date.now(),
    draft: "",
    chatDraft: "",
    player: roles[0]?.id || "",
    partner: roles[1]?.id || "",
    length: "适中",
    style: "自然白描",
    psychology: false,
    stylePresetId: "builtin-natural",
    autoMemory: true,
    chatThreshold: 20,
    novelThreshold: 5,
    memoryCursor: 0,
    memoryState: "idle",
    memoryError: "",
  };
}
export async function initialize() {
  const keepExample =
    typeof process !== "undefined" && process.env.NODE_ENV === "test";
  await db.transaction("rw", db.tables, async () => {
    if (!(await db.preferences.get("preferences"))) {
      await db.preferences.put({
        id: "preferences",
        activeProfile: "",
        developer: false,
        prompts: {},
      });
      if (!keepExample) return;
      const a: Role = {
        id: uid(),
        name: "沈知言",
        bio: "在旧书店工作，话不多，记得许多细微的小事。",
        persona:
          "沈知言，二十七岁，在临河的旧书店工作。说话简短，关心别人时习惯先做事。\n\n他不喜欢被人问起童年的搬家经历。这件事林晚并不知道。",
        avatar: "",
        paragraphs: [],
        updated: Date.now(),
      };
      const b: Role = {
        id: uid(),
        name: "林晚",
        bio: "插画师，喜欢雨天和路边不知名的植物。",
        persona:
          "林晚，二十五岁，自由插画师。讲话温和直接，不会用夸张的昵称。\n\n她与沈知言是认识三年的朋友，经常到书店借画册。",
        avatar: "",
        paragraphs: [],
        updated: Date.now(),
      };
      a.paragraphs = paragraphs(a.persona);
      b.paragraphs = paragraphs(b.persona);
      a.paragraphs[0].pin = true;
      b.paragraphs[0].pin = true;
      await db.roles.bulkAdd([a, b]);
      const w: WorldEntry = {
        id: uid(),
        title: "临河旧书店",
        text: "当代南方小城，初夏。书店临着河，门口有一架旧雨伞。两人是认识三年的朋友。",
        type: "world",
        enabled: true,
        always: true,
        keywords: [],
        roleIds: [],
        storyIds: [],
        knownBy: [],
        audience: "all",
      };
      await db.world.add(w);
      const s = makeStory(
        "雨停以前",
        [a, b],
        [w.id],
        "傍晚，林晚来到书店门口。雨还没有停。",
      );
      s.draft = "沈知言把伞递给林晚，说“拿着”，但没有看她。";
      await db.stories.add(s);
    }
  });
  if (!keepExample) {
    const starter = (await db.roles.toArray()).filter(
      (r) => r.name === "沈知言" || r.name === "林晚",
    );
    const ids = new Set(starter.map((r) => r.id));
    for (const s of await db.stories.toArray())
      if (
        s.title === "雨停以前" &&
        s.roles.some((r) => ids.has(r.sourceId || r.id))
      )
        await deleteStory(s.id);
    for (const r of starter) await db.roles.delete(r.id);
    for (const w of await db.world.toArray())
      if (w.title === "临河旧书店") await db.world.delete(w.id);
  }
  const recover = async (id: string) => {
    await db.transaction("rw", [db.jobs, db.stories, db.chatBatches], async () => {
      for (const batch of await db.chatBatches.where("storyId").equals(id).toArray())
        if (batch.status === "running")
          await db.chatBatches.update(batch.id, {
            status: "interrupted",
            error: "上次回复已中断，已发送的消息仍保留，可以重试本组。",
          });
      for (const j of await db.jobs
        .where("storyId")
        .equals(id)
        .filter((j) => j.status === "running")
        .toArray())
        await db.jobs.update(j.id, {
          status: "interrupted",
          error: "上次页面关闭，任务已中断。草稿仍保留，请手动重试。",
        });
      const s = await db.stories.get(id);
      if (s?.memoryState === "running")
        await db.stories.update(id, {
          memoryState: "interrupted",
          memoryError: "上次整理中断，可手动继续。",
        });
    });
  };
  for (const s of await db.stories.toArray()) {
    if (typeof navigator !== "undefined" && navigator.locks)
      await navigator.locks.request(
        "little-scene:" + s.id,
        { ifAvailable: true },
        async (lock) => {
          if (lock) await recover(s.id);
        },
      );
    else await recover(s.id);
  }
}
export async function reviseEvent(
  id: string,
  text: string,
  deleted = false,
  facts?: SceneEvent["facts"],
  expectedVersion?: string,
) {
  await db.transaction("rw", [db.events, db.memories], async () => {
    const e = await db.events.get(id);
    if (!e) throw Error("这段内容已不存在");
    if (expectedVersion && expectedVersion !== e.versionId)
      throw Error("原文已修改，本次结果不会覆盖新版本");
    const versionId = uid(),
      nextFacts = facts ?? (text === e.text ? e.facts : []);
    await db.events.put({
      ...e,
      text,
      deleted,
      facts: nextFacts,
      versionId,
      versions: [
        ...e.versions,
        {
          id: versionId,
          text,
          input: e.input,
          facts: nextFacts,
          deleted,
          created: Date.now(),
        },
      ],
      review: false,
    });
    const later = await db.events
      .where("storyId")
      .equals(e.storyId)
      .filter((x) => x.seq > e.seq)
      .toArray();
    for (const x of later) await db.events.update(x.id, { review: true });
    const affected = new Set([id, ...later.map((x) => x.id)]);
    for (const m of await db.memories
      .where("storyId")
      .equals(e.storyId)
      .toArray())
      if (m.sources.some((s) => affected.has(s.id)) && m.status !== "ignored")
        await db.memories.update(m.id, {
          status:
            m.status === "accepted" || m.status === "review"
              ? "review"
              : "invalid",
        });
  });
}
export async function deleteStory(id: string) {
  await db.transaction(
    "rw",
    [db.stories, db.events, db.memories, db.jobs, db.chatBatches],
    async () => {
      await db.events.where("storyId").equals(id).delete();
      await db.memories.where("storyId").equals(id).delete();
      await db.jobs.where("storyId").equals(id).delete();
      await db.chatBatches.where("storyId").equals(id).delete();
      await db.stories.delete(id);
    },
  );
}
