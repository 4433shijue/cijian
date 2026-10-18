import { db } from "./db";
import { uid, type Story } from "./types";
import { withStoryLock } from "./locks";
import {
  emptyBody,
  newDevice,
  phoneBodySchema,
  phoneTables,
  type PhoneBody,
  type PhoneRecord,
  type PhoneSpace,
  type PhoneDevice,
} from "./phone-types";

export const phoneTime = () =>
  new Date(Date.now() - new Date().getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 16);
export function recordText(r: Pick<PhoneRecord, "body" | "retracted">) {
  if (r.retracted) return "[撤回了一条消息]";
  const b = r.body;
  return `${r.retracted ? "[已撤回] " : ""}${b.type === "text" ? "" : `[${{ image: "图片", sticker: "表情", audio: "语音", transfer: "剧情转账", call: "通话记录", system: "系统" }[b.type]}] `}${b.text}${b.amount ? ` ¥${b.amount}` : ""}${b.duration ? ` ${b.duration}` : ""}${b.type === "call" ? ` ${b.callState === "missed" ? "未接来电" : b.callState === "declined" ? "已拒绝" : "已结束"}` : ""}`;
}
export const canSee = (r: PhoneRecord, owner: string) =>
  !r.deleted && r.audience.includes(owner);
export const deviceFor = (s: PhoneSpace | undefined, owner: string) =>
  s?.devices[owner] || newDevice();

export async function ensurePhone(storyId: string) {
  return db.transaction("rw", db.tables, async () => {
    const story = await db.stories.get(storyId);
    if (!story) throw Error("故事不存在");
    let space = await db.phoneSpaces.where("storyId").equals(storyId).first();
    if (space?.migrated) return space;
    space ||= {
      id: uid(),
      storyId,
      ownerId: story.player || story.roles[0]?.id || "",
      devices: {},
      migrated: false,
      updated: Date.now(),
    };
    for (const r of story.roles) space.devices[r.id] ||= newDevice();
    const events = (
      await db.events.where("storyId").equals(storyId).sortBy("seq")
    ).filter((e) => e.kind === "message");
    const conversations = new Map<string, string>(),
      records = new Map<string, string>();
    for (const c of await db.phoneConversations
      .where("storyId")
      .equals(storyId)
      .toArray())
      if (c.kind === "direct")
        conversations.set([...c.members].sort().join("|"), c.id);
    for (const e of events) {
      const members = [...new Set(e.participants)],
        key = [...members].sort().join("|");
      if (!conversations.has(key)) {
        const id = uid();
        conversations.set(key, id);
        await db.phoneConversations.add({
          id,
          storyId,
          kind: members.length > 2 ? "group" : "direct",
          title: "",
          avatar: "",
          members,
          created: e.created,
          updated: e.created,
        });
      }
      const body = { ...emptyBody(), text: e.text },
        id = uid();
      records.set(e.id, id);
      const time = new Date(e.created).toISOString().slice(0, 16);
      await db.phoneRecords.add({
        id,
        storyId,
        conversationId: conversations.get(key)!,
        kind: "message",
        parentId: "",
        replyTo: "",
        speakerId: e.speaker,
        audience: members,
        body,
        time,
        seq: e.seq,
        round: e.chatBatchId || `legacy:${e.round || e.id}`,
        runId: "",
        versionId: e.versionId,
        versions: e.versions.map((v) => ({
          id: v.id,
          body: { ...emptyBody(), text: v.text },
          deleted: !!v.deleted,
          retracted: false,
          time,
          created: v.created,
        })),
        legacyDraft:
          e.status !== "complete" ? { raw: e.raw, error: e.error } : undefined,
        pending: !!e.chatPending,
        deleted: e.deleted,
        retracted: false,
        likes: [],
        origin: "legacy",
        legacyId: e.id,
        created: e.created,
        updated: e.created,
      });
    }
    for (const b of await db.chatBatches
      .where("storyId")
      .equals(storyId)
      .toArray()) {
      const conversationId = conversations.get(
        [b.player, b.partner].sort().join("|"),
      );
      if (!conversationId) continue;
      const id = uid(),
        outputIds = b.replyIds.flatMap((x) => records.get(x) || []);
      const sourceIds = b.sources.flatMap((x) => records.get(x.id) || []);
      const status = b.status === "running" ? "interrupted" : b.status;
      await db.phoneRuns.add({
        id,
        storyId,
        conversationId,
        ownerId: b.player,
        mode: "participate",
        parentId: "",
        audience: [b.player, b.partner],
        input: b.messages.join("\n"),
        time: new Date(b.created).toISOString().slice(0, 16),
        cutoff: b.cutoff - 0.5,
        sourceIds,
        sourceVersions: Object.fromEntries(
          b.sources.flatMap((x) =>
            records.has(x.id) ? [[records.get(x.id)!, x.versionId]] : [],
          ),
        ),
        steps: [
          {
            speakerId: b.partner,
            status: status === "complete" ? "complete" : "pending",
            context: "",
            outputIds,
            raw: b.raw,
            error: b.error,
          },
        ],
        status,
        error: b.error,
        created: b.created,
        updated: b.updated,
        legacyId: b.id,
      });
      for (const recordId of [...sourceIds, ...outputIds])
        await db.phoneRecords.update(recordId, { runId: id, round: id });
    }
    if (
      story.chatDraft &&
      story.player &&
      story.partner &&
      !conversations.has([story.player, story.partner].sort().join("|"))
    ) {
      const id = uid();
      conversations.set([story.player, story.partner].sort().join("|"), id);
      await db.phoneConversations.add({
        id,
        storyId,
        kind: "direct",
        title: "",
        avatar: "",
        members: [story.player, story.partner],
        created: Date.now(),
        updated: Date.now(),
      });
    }
    if (story.chatDraft) {
      const c = conversations.get(
        [story.player, story.partner].sort().join("|"),
      );
      if (c && space.devices[story.player])
        space.devices[story.player].drafts[c] = story.chatDraft;
    }
    const legacyIds = new Set(events.map((e) => e.id));
    for (const m of await db.memories
      .where("storyId")
      .equals(storyId)
      .toArray())
      if (m.sources.some((ref) => legacyIds.has(ref.id)))
        await db.memories.update(m.id, { status: "invalid" });
    if (events.length) {
      await db.promptSessions.where("storyId").equals(storyId).delete();
      await db.stories.update(storyId, {
        inspiration: undefined,
        inspirationRequest: undefined,
        inspirationRevision: undefined,
        memorySelection: undefined,
      });
    }
    space.migrated = true;
    await db.phoneSpaces.put(space);
    return space;
  });
}
export async function initializePhones() {
  for (const story of await db.stories.toArray()) {
    await ensurePhone(story.id);
    await withStoryLock(`phone:${story.id}`, async () => {
      for (const run of await db.phoneRuns
        .where("storyId")
        .equals(story.id)
        .toArray())
        if (run.status === "running")
          await db.phoneRuns.update(run.id, {
            status: "interrupted",
            error: "上次生成已中断，可继续未完成的角色。",
            steps: run.steps.map((s) =>
              s.status === "running" ? { ...s, status: "pending" } : s,
            ),
          });
    }).catch(() => {});
  }
}
export async function updateDevice(
  storyId: string,
  owner: string,
  change: (d: PhoneDevice) => PhoneDevice,
) {
  await ensurePhone(storyId);
  await db.transaction("rw", db.phoneSpaces, async () => {
    const s = (await db.phoneSpaces.where("storyId").equals(storyId).first())!;
    s.devices[owner] = change(deviceFor(s, owner));
    s.updated = Date.now();
    await db.phoneSpaces.put(s);
  });
}
export async function conversation(
  story: Story,
  members: string[],
  title = "",
  group = false,
  avatar = "",
) {
  members = [...new Set(members)];
  if (
    members.length < 2 ||
    members.some((id) => !story.roles.some((r) => r.id === id))
  )
    throw Error("请选择至少两位故事角色");
  return db.transaction("rw", db.phoneConversations, async () => {
    if (!group) {
      const existing = (
        await db.phoneConversations.where("storyId").equals(story.id).toArray()
      ).find(
        (c) =>
          c.kind === "direct" &&
          [...c.members].sort().join() === [...members].sort().join(),
      );
      if (existing) return existing.id;
    }
    const id = uid();
    await db.phoneConversations.add({
      id,
      storyId: story.id,
      members,
      title,
      avatar,
      kind: group ? "group" : "direct",
      created: Date.now(),
      updated: Date.now(),
    });
    return id;
  });
}
export async function changeGroup(
  id: string,
  title: string,
  members: string[],
  speakerId: string,
  avatar = "",
) {
  await db.transaction(
    "rw",
    [db.phoneConversations, db.phoneRecords, db.stories, db.phoneAssets],
    async () => {
      const c = await db.phoneConversations.get(id),
        s = c && (await db.stories.get(c.storyId));
      if (
        !c ||
        c.kind !== "group" ||
        !s ||
        members.length < 2 ||
        members.some((id) => !s.roles.some((r) => r.id === id))
      )
        throw Error("群成员无效");
      await addRecord(
        s.id,
        {
          conversationId: id,
          speakerId,
          audience: [...new Set([...c.members, ...members])],
          body: {
            ...emptyBody(),
            type: "system",
            text: `群设置已更新：${title}；成员：${members.map((id) => s.roles.find((r) => r.id === id)?.name).join("、")}`,
          },
        },
        true,
      );
      await db.phoneConversations.update(id, {
        title,
        avatar,
        members: [...new Set(members)],
        updated: Date.now(),
      });
    },
  );
}
export type RecordInput = Partial<PhoneRecord> & {
  speakerId: string;
  body: PhoneBody;
};
export async function addRecord(
  storyId: string,
  input: RecordInput,
  trusted = false,
) {
  return db.transaction(
    "rw",
    [db.phoneRecords, db.phoneConversations, db.stories, db.phoneAssets],
    async () => {
      const s = await db.stories.get(storyId);
      if (!s || !s.roles.some((r) => r.id === input.speakerId))
        throw Error("发言角色不存在");
      const body = phoneBodySchema.parse(input.body);
      if (
        !body.text.trim() &&
        !body.assets.length &&
        !["transfer", "call"].includes(body.type)
      )
        throw Error("先写内容或添加素材");
      if (body.assets.length > (input.kind === "moment" ? 9 : 1))
        throw Error("图片数量超出限制");
      for (const id of body.assets)
        if ((await db.phoneAssets.get(id))?.storyId !== storyId)
          throw Error("素材不存在或不属于这本故事");
      let audience = input.audience || [];
      if (input.conversationId && !trusted) {
        const c = await db.phoneConversations.get(input.conversationId);
        if (!c || c.storyId !== storyId || !c.members.includes(input.speakerId))
          throw Error("角色不在当前会话中");
        audience = c.members;
      }
      if (input.parentId) {
        const parent = await db.phoneRecords.get(input.parentId);
        if (
          !parent ||
          parent.storyId !== storyId ||
          parent.kind !== "moment" ||
          !canSee(parent, input.speakerId)
        )
          throw Error("这条动态对角色不可见");
        audience = parent.audience;
        if (input.replyTo) {
          const target = await db.phoneRecords.get(input.replyTo);
          if (
            !target ||
            target.parentId !== parent.id ||
            !canSee(target, input.speakerId)
          )
            throw Error("回复目标无效");
        }
      }
      if (body.quoteId) {
        const q = await db.phoneRecords.get(body.quoteId);
        if (
          !q ||
          q.storyId !== storyId ||
          q.conversationId !== input.conversationId ||
          !canSee(q, input.speakerId)
        )
          throw Error("引用内容不可见");
      }
      if (
        !audience.includes(input.speakerId) ||
        audience.some((id) => !s.roles.some((r) => r.id === id))
      )
        throw Error("可见范围无效");
      const seq =
        ((
          await db.phoneRecords.where("storyId").equals(storyId).sortBy("seq")
        ).at(-1)?.seq || 0) + 1;
      const id = uid(),
        now = Date.now(),
        versionId = uid(),
        time = input.time || phoneTime();
      const r: PhoneRecord = {
        id,
        storyId,
        conversationId: "",
        kind: "message",
        parentId: "",
        replyTo: "",
        audience,
        time,
        seq,
        round: id,
        runId: "",
        versionId,
        versions: [],
        pending: false,
        deleted: false,
        retracted: false,
        likes: [],
        origin: "user",
        legacyId: "",
        created: now,
        updated: now,
        ...input,
        body,
      };
      r.audience = [...new Set(audience)];
      r.versions = [
        {
          id: versionId,
          body,
          time,
          deleted: false,
          retracted: false,
          created: now,
        },
      ];
      await db.phoneRecords.add(r);
      if (r.conversationId)
        await db.phoneConversations.update(r.conversationId, { updated: now });
      return r;
    },
  );
}
export async function editRecord(
  id: string,
  change: Partial<
    Pick<PhoneRecord, "body" | "time" | "deleted" | "retracted" | "legacyDraft">
  >,
  expected?: string,
) {
  await db.transaction("rw", [db.phoneRecords, db.phoneAssets], async () => {
    const r = await db.phoneRecords.get(id);
    if (!r || (expected && r.versionId !== expected))
      throw Error("消息已改变，请重新打开编辑");
    const next = { ...r, ...change, versionId: uid(), updated: Date.now() };
    next.body = phoneBodySchema.parse(next.body);
    if (change.body || "legacyDraft" in change) {
      if (
        !next.body.text.trim() &&
        !next.body.assets.length &&
        !["transfer", "call"].includes(next.body.type)
      )
        throw Error("先写内容或添加素材");
      if (next.body.assets.length > (r.kind === "moment" ? 9 : 1))
        throw Error("素材数量超出限制");
      for (const asset of next.body.assets)
        if ((await db.phoneAssets.get(asset))?.storyId !== r.storyId)
          throw Error("素材不存在或不属于这本故事");
      if (next.body.quoteId) {
        const q = await db.phoneRecords.get(next.body.quoteId);
        if (
          !q ||
          q.storyId !== r.storyId ||
          q.conversationId !== r.conversationId ||
          !canSee(q, r.speakerId)
        )
          throw Error("引用内容不可见");
      }
    }
    next.versions = [
      ...r.versions,
      {
        id: next.versionId,
        body: next.body,
        time: next.time,
        deleted: next.deleted,
        retracted: next.retracted,
        created: next.updated,
      },
    ];
    await db.phoneRecords.put(next);
  });
}
export async function likeMoment(id: string, owner: string) {
  await db.transaction("rw", db.phoneRecords, async () => {
    const r = await db.phoneRecords.get(id);
    if (!r || r.kind !== "moment" || !canSee(r, owner))
      throw Error("动态不可见");
    await db.phoneRecords.update(id, {
      likes: r.likes.includes(owner)
        ? r.likes.filter((x) => x !== owner)
        : [...r.likes, owner],
    });
  });
}
export async function saveAsset(storyId: string, file: File) {
  if (file.size > 10 * 1024 * 1024) throw Error("请选择不超过 10 MiB 的素材");
  if (
    !/^(image\/(png|jpeg|webp|gif)|audio\/(mpeg|mp3|wav|x-wav|mp4|aac|ogg|webm))$/.test(
      file.type,
    )
  )
    throw Error("支持 PNG、JPG、WebP、GIF，以及 MP3、WAV、M4A、OGG 音频");
  let data = await new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(Error("素材读取失败"));
    r.readAsDataURL(file);
  });
  if (file.type.startsWith("image/")) {
    const bitmap = await createImageBitmap(file),
      scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
    if (file.type !== "image/gif" || scale < 1) {
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      canvas
        .getContext("2d")!
        .drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      data = canvas.toDataURL("image/webp", 0.88);
    }
    bitmap.close();
  } else if (
    file.type.startsWith("audio/") &&
    !document.createElement("audio").canPlayType(file.type)
  )
    throw Error("当前浏览器不支持播放这种音频，请换用 MP3");
  const id = uid();
  await db.phoneAssets.add({
    id,
    storyId,
    name: file.name,
    mime: data.startsWith("data:image/webp") ? "image/webp" : file.type,
    size: file.size,
    data,
  });
  return id;
}

/** Portable remapping uses explicit identifier fields, never replaces prose. */
export function remapPhone(
  table: string,
  row: any,
  id: (s: string) => string,
): any {
  const r = { ...row, id: id(row.id), storyId: id(row.storyId) };
  if (table === "phoneSpaces") {
    r.ownerId = id(r.ownerId);
    r.devices = Object.fromEntries(
      Object.entries(r.devices).map(([owner, value]) => {
        const d = value as PhoneDevice;
        return [
          id(owner),
          {
            ...d,
            skin: { ...d.skin, wallpaper: id(d.skin.wallpaper) },
            composerDrafts: Object.fromEntries(
              Object.entries(d.composerDrafts || {}).map(([key, draft]) => [
                id(key),
                {
                  ...draft,
                  body: {
                    ...draft.body,
                    assets: draft.body.assets.map(id),
                    quoteId: id(draft.body.quoteId),
                  },
                },
              ]),
            ),
            notes: Object.fromEntries(
              Object.entries(d.notes).map(([k, v]) => [id(k), v]),
            ),
            pinned: d.pinned.map(id),
            read: Object.fromEntries(
              Object.entries(d.read).map(([k, v]) => [id(k), v]),
            ),
            drafts: Object.fromEntries(
              Object.entries(d.drafts).map(([k, v]) => [id(k), v]),
            ),
          },
        ];
      }),
    );
  }
  if (table === "phoneConversations") {
    r.members = r.members.map(id);
    r.avatar = id(r.avatar);
  }
  if (table === "phoneRecords") {
    for (const k of [
      "conversationId",
      "parentId",
      "replyTo",
      "speakerId",
      "round",
      "runId",
      "versionId",
      "legacyId",
    ])
      r[k] = id(r[k]);
    r.audience = r.audience.map(id);
    r.likes = r.likes.map(id);
    const body = (b: PhoneBody) => ({
      ...b,
      assets: b.assets.map(id),
      quoteId: id(b.quoteId),
    });
    r.body = body(r.body);
    r.versions = r.versions.map((v: any) => ({
      ...v,
      id: id(v.id),
      body: body(v.body),
    }));
  }
  if (table === "phoneRuns") {
    for (const k of ["conversationId", "ownerId", "parentId", "legacyId"])
      r[k] = id(r[k]);
    if (r.rewriteBase)
      r.rewriteBase = {
        steps: r.rewriteBase.steps.map((s: any) => ({
          ...s,
          speakerId: id(s.speakerId),
          outputIds: s.outputIds.map(id),
        })),
        versions: Object.fromEntries(
          Object.entries(r.rewriteBase.versions).map(([k, v]) => [
            id(k),
            id(v as string),
          ]),
        ),
      };
    if (r.staged)
      r.staged = Object.fromEntries(
        Object.entries(r.staged).map(([k, v]) => [
          k,
          (v as PhoneBody[]).map((b) => ({
            ...b,
            assets: b.assets.map(id),
            quoteId: id(b.quoteId),
          })),
        ]),
      );
    r.audience = r.audience.map(id);
    r.sourceIds = r.sourceIds.map(id);
    r.sourceVersions = Object.fromEntries(
      Object.entries(r.sourceVersions).map(([k, v]) => [
        id(k),
        id(v as string),
      ]),
    );
    r.steps = r.steps.map((s: any) => ({
      ...s,
      speakerId: id(s.speakerId),
      outputIds: s.outputIds.map(id),
      status: s.status === "running" ? "pending" : s.status,
    }));
    if (r.status === "running") r.status = "interrupted";
  }
  return r;
}
export { phoneTables };
