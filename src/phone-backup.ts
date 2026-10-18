import { phoneTables } from "./phone-types";
import type { Story } from "./types";
export function phoneLinks(table: string, r: any): [string, string][] {
  const links: [string, string][] = [["stories", r.storyId]];
  const add = (t: string, values: string[]) =>
    values.filter(Boolean).forEach((id) => links.push([t, id]));
  if (table === "phoneConversations") add("phoneAssets", [r.avatar]);
  if (table === "phoneRecords") {
    add("phoneConversations", [r.conversationId]);
    add("phoneRecords", [
      r.parentId,
      r.replyTo,
      r.body.quoteId,
      ...r.versions.map((v: any) => v.body.quoteId),
    ]);
    add(
      "phoneAssets",
      [r.body, ...r.versions.map((v: any) => v.body)].flatMap(
        (b: any) => b.assets,
      ),
    );
    add("phoneRuns", [r.runId]);
  }
  if (table === "phoneRuns") {
    add("phoneConversations", [r.conversationId]);
    add("phoneRecords", [
      r.parentId,
      ...r.sourceIds,
      ...Object.keys(r.sourceVersions),
      ...Object.keys(r.rewriteBase?.versions || {}),
      ...r.steps.flatMap((s: any) => s.outputIds),
    ]);
  }
  if (table === "phoneSpaces")
    for (const d of Object.values(r.devices) as any[]) {
      add("phoneAssets", [
        d.skin.wallpaper,
        ...(Object.values(d.composerDrafts || {}) as any[]).flatMap(
          (x) => x.body.assets,
        ),
      ]);
      add(
        "phoneRecords",
        (Object.values(d.composerDrafts || {}) as any[]).map(
          (x) => x.body.quoteId,
        ),
      );
      add("phoneConversations", [
        ...d.pinned,
        ...Object.keys(d.read),
        ...Object.keys(d.drafts),
        ...Object.keys(d.composerDrafts || {}),
      ]);
    }
  return links;
}
export function checkPhoneRow(
  table: string,
  r: any,
  related: Map<string, any>,
) {
  const story = related.get(`stories:${r.storyId}`) as Story;
  if (!story) throw Error("手机资料的故事不存在");
  if (story.kind && story.kind !== "phone") throw Error("小说作品不能包含手机记录");
  for (const [t, id] of phoneLinks(table, r)) {
    const target = related.get(`${t}:${id}`);
    if (!target || (t !== "stories" && target.storyId !== r.storyId))
      throw Error("手机资料关联缺失或跨越故事");
  }
  let roles: string[] = [];
  if (table === "phoneSpaces")
    roles = [
      r.ownerId,
      ...Object.keys(r.devices),
      ...(Object.values(r.devices) as any[]).flatMap((d) =>
        Object.keys(d.notes),
      ),
    ];
  if (table === "phoneConversations") roles = r.members;
  if (table === "phoneRecords") {
    roles = [r.speakerId, ...r.audience, ...r.likes];
    if (
      !r.audience.includes(r.speakerId) ||
      r.likes.some((id: string) => !r.audience.includes(id))
    )
      throw Error("手机记录的可见范围无效");
    if (r.parentId) {
      const parent = related.get(`phoneRecords:${r.parentId}`);
      if (
        parent.kind !== "moment" ||
        r.audience.some((id: string) => !parent.audience.includes(id))
      )
        throw Error("朋友圈评论扩大了可见范围");
    }
    if (!r.versions.some((v: any) => v.id === r.versionId))
      throw Error("手机消息版本不存在");
  }
  if (table === "phoneRuns")
    roles = [r.ownerId, ...r.audience, ...r.steps.map((s: any) => s.speakerId)];
  if (roles.some((id) => !story.roles.some((role) => role.id === id)))
    throw Error("手机资料关联了未知角色");
  if (
    table === "phoneAssets" &&
    !/^data:(image\/(png|jpeg|webp|gif)|audio\/(mpeg|mp3|wav|x-wav|mp4|aac|ogg|webm));base64,[A-Za-z0-9+/=]*$/.test(
      r.data,
    )
  )
    throw Error("素材格式无效");
}
export function checkPhoneBackup(b: any) {
  const all = new Map<string, any>();
  for (const table of ["stories", ...phoneTables])
    for (const r of b[table] || []) {
      const key = `${table}:${r.id}`;
      if (all.has(key)) throw Error("手机资料 ID 重复");
      all.set(key, r);
    }
  for (const table of phoneTables)
    for (const r of b[table] || []) checkPhoneRow(table, r, all);
}
