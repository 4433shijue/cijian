import { db } from "./db";
import { requireStory } from "./story-service";
import { uid } from "./types";
import {
  readingSchema,
  readerApps,
  type PhoneReading,
  type ReaderTarget,
} from "./work-types";
import { emptyBody, type PhoneBody, type PhoneSkin } from "./phone-types";
import { deviceFor } from "./phone-store";
import { mountPhoneReader } from "./reader-runtime";
import readerCSS from "./reader.css?inline";

export interface ReaderPackage {
  format: "cijian-reader";
  version: 1;
  id: string;
  revision: string;
  title: string;
  roles: { id: string; name: string; avatar: string }[];
  devices: Record<string, { skin: PhoneSkin; notes: Record<string, string> }>;
  conversations: {
    id: string;
    title: string;
    members: string[];
    kind: string;
    avatar: string;
  }[];
  records: {
    id: string;
    conversationId: string;
    kind: string;
    parentId: string;
    replyTo: string;
    speakerId: string;
    audience: string[];
    body: PhoneBody;
    time: string;
    seq: number;
    retracted: boolean;
    likes: string[];
  }[];
  documents: {
    id: string;
    ownerId: string;
    kind: string;
    title: string;
    text: string;
    assets: string[];
    time: string;
    album: string;
    recipientId: string;
    audience: string[];
    pinned: boolean;
  }[];
  assets: { id: string; data: string; mime: string }[];
  config: PhoneReading;
}
export async function ensureReading(storyId: string) {
  return db.transaction("rw", db.tables, async () => {
    const story = await requireStory(storyId, "phone");
    if (!story.roles.length)
      throw Error("请先在作品设置中加入角色，再设置阅读入口");
    let reading = await db.phoneReading
      .where("storyId")
      .equals(storyId)
      .first();
    if (!reading) {
      reading = {
        id: uid(),
        storyId,
        revision: 1,
        opening: "你捡到了一部手机。屏幕亮起，里面的故事还没有结束。",
        owners: story.roles.map((r) => r.id),
        initialOwner: story.player || story.roles[0].id,
        password: "",
        notification: "你有一条未读消息",
        apps: [...readerApps],
        mode: "free",
        rules: [],
        performances: [],
        updated: Date.now(),
      };
      await db.phoneReading.add(reading);
    }
    return reading;
  });
}
export async function saveReading(value: PhoneReading) {
  return db.transaction("rw", db.tables, async () => {
    const story = await requireStory(value.storyId, "phone"),
      old = await db.phoneReading.get(value.id);
    if (old && old.revision !== value.revision)
      throw Error("阅读配置已修改，请重新打开");
    const next = readingSchema.parse({
      ...value,
      revision: value.revision + 1,
      updated: Date.now(),
    });
    if (
      !next.owners.length ||
      !next.owners.includes(next.initialOwner) ||
      next.owners.some((id) => !story.roles.some((r) => r.id === id))
    )
      throw Error("请选择有效的分享机主和初始机主");
    if (
      old &&
      JSON.stringify({ ...old, revision: 0, updated: 0 }) ===
        JSON.stringify({ ...next, revision: 0, updated: 0 })
    )
      return old;
    if (new Set(next.apps).size !== next.apps.length)
      throw Error("应用顺序不能重复");
    await db.phoneReading.put(next);
    return next;
  });
}
export const readerTargetKey = (t: ReaderTarget) =>
  `${t.ownerId}/${t.type}/${t.id}`;
export function validateReader(data: ReaderPackage) {
  const errors: string[] = [],
    { config } = data;
  const apps = (t: ReaderTarget) =>
    t.type === "app"
      ? [t.id]
      : t.type === "document"
        ? [
            { note: "notes", photo: "photos", draft: "drafts" }[
              data.documents.find((d) => d.id === t.id)?.kind as "note"
            ] || "",
          ]
        : [
            data.records.find((r) => r.id === t.id)?.kind === "message"
              ? "messages"
              : "moments",
          ];
  const exists = (t: ReaderTarget) =>
    config.owners.includes(t.ownerId) &&
    apps(t).every((a) =>
      config.apps.includes(a as (typeof readerApps)[number]),
    ) &&
    (t.type === "app"
      ? config.apps.includes(t.id as (typeof readerApps)[number])
      : t.type === "record"
        ? data.records.some(
            (r) => r.id === t.id && r.audience.includes(t.ownerId),
          )
        : data.documents.some(
            (d) => d.id === t.id && d.audience.includes(t.ownerId),
          ));
  const ids = new Set(config.rules.map((r) => r.id));
  if (ids.size !== config.rules.length) errors.push("线索 ID 重复");
  for (const rule of config.rules) {
    if (!rule.targets.length || !rule.conditions.length)
      errors.push(`${rule.title}：缺少目标或条件`);
    if (rule.targets.some((t) => !exists(t)))
      errors.push(`${rule.title}：锁定目标不存在、未分享或对机主不可见`);
    for (const c of rule.conditions) {
      if (c.type === "read" && (!exists(c.target) || c.target.type === "app"))
        errors.push(`${rule.title}：阅读线索不存在或未分享`);
      if (c.type === "clue" && !ids.has(c.ruleId))
        errors.push(`${rule.title}：引用的线索不存在`);
      if (c.type === "password" && !c.answers.some((a) => a.trim()))
        errors.push(`${rule.title}：密码答案为空`);
    }
  }
  const solved = new Set<string>();
  const accessible = (t: ReaderTarget): boolean =>
    exists(t) &&
    (t.type !== "record" ||
      !data.records.find((r) => r.id === t.id)?.parentId ||
      accessible({
        ...t,
        id: data.records.find((r) => r.id === t.id)!.parentId,
      })) &&
    config.rules
      .filter((rule) =>
        rule.targets.some(
          (x) =>
            readerTargetKey(x) === readerTargetKey(t) ||
            (x.ownerId === t.ownerId &&
              x.type === "app" &&
              apps(t).includes(x.id)),
        ),
      )
      .every((r) => solved.has(r.id));
  for (let count = 0; count <= config.rules.length; count++) {
    let changed = false;
    for (const r of config.rules) {
      if (solved.has(r.id)) continue;
      const checks = r.conditions.map((c) =>
        c.type === "password"
          ? true
          : c.type === "clue"
            ? solved.has(c.ruleId)
            : accessible(c.target),
      );
      if (r.match === "all" ? checks.every(Boolean) : checks.some(Boolean)) {
        solved.add(r.id);
        changed = true;
      }
    }
    if (!changed) break;
  }
  if (config.mode === "clues")
    for (const r of config.rules)
      if (!solved.has(r.id))
        errors.push(`${r.title}：存在循环或无法到达的解锁条件`);
  for (const p of config.performances) {
    if (!data.conversations.some((c) => c.id === p.conversationId))
      errors.push(`${p.title}：演出会话未分享`);
    if (
      p.steps.some(
        (s) =>
          !data.records.some(
            (r) => r.id === s.recordId && r.conversationId === p.conversationId,
          ),
      )
    )
      errors.push(`${p.title}：演出消息不存在或未分享`);
  }
  return [...new Set(errors)];
}
export async function buildReaderPackage(
  storyId: string,
  configuration?: PhoneReading,
) {
  const config = configuration || (await ensureReading(storyId));
  return db.transaction("r", db.tables, async () => {
    const story = await requireStory(storyId, "phone"),
      space = await db.phoneSpaces.where("storyId").equals(storyId).first();
    const sourceRecords = await db.phoneRecords
      .where("storyId")
      .equals(storyId)
      .sortBy("seq");
    const selected = sourceRecords.filter(
      (r) =>
        !r.deleted &&
        !r.legacyDraft &&
        r.audience.some((id) => config.owners.includes(id)) &&
        (!config.selectedRecords || config.selectedRecords.includes(r.id)),
    );
    const recordIds = new Set(selected.map((r) => r.id));
    const records = selected
      .filter((r) => !r.parentId || recordIds.has(r.parentId))
      .map((r) => ({
        id: r.id,
        conversationId: r.conversationId,
        kind: r.kind,
        parentId: r.parentId,
        replyTo: recordIds.has(r.replyTo) ? r.replyTo : "",
        speakerId: r.speakerId,
        audience: r.audience,
        body: r.retracted
          ? emptyBody()
          : {
              ...r.body,
              quoteId: recordIds.has(r.body.quoteId) ? r.body.quoteId : "",
            },
        time: r.time,
        seq: r.seq,
        retracted: r.retracted,
        likes: r.likes,
      }));
    const documents = (
      await db.phoneDocuments.where("storyId").equals(storyId).toArray()
    )
      .filter(
        (d) =>
          !d.deleted &&
          d.audience.some((id) => config.owners.includes(id)) &&
          (!config.selectedDocuments ||
            config.selectedDocuments.includes(d.id)),
      )
      .map((d) => ({
        id: d.id,
        ownerId: d.ownerId,
        kind: d.kind,
        title: d.title,
        text: d.text,
        assets: d.assets,
        time: d.time,
        album: d.album,
        recipientId: d.recipientId,
        audience: d.audience,
        pinned: d.pinned,
      }));
    const conversations = (
      await db.phoneConversations.where("storyId").equals(storyId).toArray()
    )
      .filter(
        (c) =>
          records.some((r) => r.conversationId === c.id) ||
          c.members.some((id) => config.owners.includes(id)),
      )
      .map((c) => ({
        id: c.id,
        title: c.title,
        members: c.members,
        kind: c.kind,
        avatar: c.avatar,
      }));
    const devices = Object.fromEntries(
      config.owners.map((id) => {
        const d = deviceFor(space, id);
        return [id, { skin: d.skin, notes: d.notes }];
      }),
    );
    const assetIds = new Set([
      ...records.flatMap((r) => r.body.assets),
      ...documents.flatMap((d) => d.assets),
      ...conversations.map((c) => c.avatar),
      ...Object.values(devices).map((d) => d.skin.wallpaper),
    ]);
    const assets = (
      await db.phoneAssets.where("storyId").equals(storyId).toArray()
    )
      .filter((a) => assetIds.has(a.id))
      .map((a) => ({ id: a.id, data: a.data, mime: a.mime }));
    const selectedConfig = structuredClone(config);
    // Rules for omitted content are removed; references to omitted prerequisites remain errors.
    selectedConfig.rules = selectedConfig.rules
      .map((r) => ({
        ...r,
        targets: r.targets.filter(
          (t) =>
            config.owners.includes(t.ownerId) &&
            (t.type === "app" ||
              (t.type === "record" &&
                (!config.selectedRecords ||
                  config.selectedRecords.includes(t.id))) ||
              (t.type === "document" &&
                (!config.selectedDocuments ||
                  config.selectedDocuments.includes(t.id)))),
        ),
      }))
      .filter((r) => r.targets.length);
    const data: ReaderPackage = {
      format: "cijian-reader",
      version: 1,
      id: config.id,
      revision: "",
      title: story.title,
      roles: story.roles.map((r) => ({
        id: r.id,
        name: r.name,
        avatar: /^data:image\/(png|jpeg|webp|gif);base64,/.test(r.avatar)
          ? r.avatar
          : "",
      })),
      devices,
      records,
      documents,
      conversations,
      assets,
      config: selectedConfig,
    };
    const serialized = JSON.stringify(data);
    let hash = 2166136261;
    for (let i = 0; i < serialized.length; i++) {
      hash ^= serialized.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    data.revision = (hash >>> 0).toString(16);
    return data;
  });
}
export function createReaderHTML(data: ReaderPackage) {
  const errors = validateReader(data);
  if (errors.length) throw Error(errors.join("\n"));
  const json = JSON.stringify(data)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
  return `<!doctype html><html lang="zh-CN"><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>此间 · 手机故事</title><style>${readerCSS}</style><body><main id="reader"></main><script type="application/json" id="phone-data">${json}</script><script>(${mountPhoneReader.toString()})(document.getElementById('reader'),JSON.parse(document.getElementById('phone-data').textContent));</script></body></html>`;
}
