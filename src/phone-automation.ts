import { liveQuery } from "dexie";
import { schedulePhoneImages } from "./image-scheduling";
import { phoneImageInstruction } from "./image-generation";
import { z } from "zod";
import { db, keyFor } from "./db";
import { uid, type Preferences, type PromptKind, type Profile } from "./types";
import { requireStory } from "./story-service";
import { withStoryLock } from "./locks";
import { phoneContext } from "./phone-context";
import { canSee, phoneTime, recordText } from "./phone-store";
import { emptyBody, phoneBodySchema, phoneRecordSchema } from "./phone-types";
import { assemble } from "./context";
import { generate } from "./model";
import { parseJSON } from "./output";
import { decisionWire, contentWire, habitsWire } from "./phone-prompts";
import { phoneInstruction } from "./phone-prompt-runtime";
import {
  automationOptionsSchema,
  automationStepSchema,
  autoActionSchema,
  habitSchema,
  documentSchema,
  type PhoneAutomationOptions,
  type PhoneAutomationSettings,
  type PhoneAutomationRun,
  type PhoneAutomationStep,
  type PhoneAutomationPayload,
  type PhoneHabit,
  type PhoneAutoAction,
} from "./work-types";

const controls = new Map<string, AbortController>();
async function persistStep(step: PhoneAutomationStep) {
  await db.transaction(
    "rw",
    db.phoneAutomationSteps,
    db.phoneAutomationRuns,
    db.stories,
    async () => {
      if (
        (await db.stories.get(step.storyId)) &&
        (await db.phoneAutomationRuns.get(step.runId))
      )
        await db.phoneAutomationSteps.put(step);
    },
  );
}
export async function pauseStoryAutomation(storyId: string) {
  controls.get(storyId)?.abort();
  for (const r of await db.phoneAutomationRuns
    .where("storyId")
    .equals(storyId)
    .filter((r) => r.status === "running")
    .toArray())
    await pauseAutomation(r.id);
}

const payload = (): PhoneAutomationPayload => ({
  records: [],
  documents: [],
  events: [],
  conversations: [],
  likes: [],
});
export const defaultHabit = (): PhoneHabit => ({
  initiative: "balanced",
  expression: "balanced",
  replyDelay: 0,
  browseEvery: 1,
  preference: "",
});
export const emptyAction = (): PhoneAutoAction => ({
  kind: "wait",
  conversationId: "",
  recipientId: "",
  parentId: "",
  replyTo: "",
  documentId: "",
  audience: [],
  reason: "",
  instruction: "",
  awaitUser: false,
});
const contentSchema = z
  .object({
    messages: z.array(phoneBodySchema).max(5),
    title: z.string(),
    text: z.string(),
    assets: z.array(z.string()),
  })
  .strict();
const sourceVersion = (table: string, row: any) =>
  table === "phoneConversations" ? JSON.stringify(row.members) : row.versionId;
const addMinutes = (time: string, minutes: number) => {
  const d = new Date(time);
  if (!Number.isFinite(d.getTime())) throw Error("剧情时间无效");
  d.setMinutes(d.getMinutes() + minutes);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}T${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};
async function connection() {
  const prefs = await db.preferences.get("preferences"),
    profile = prefs && (await db.profiles.get(prefs.activeProfile));
  if (!prefs || !profile || !keyFor(profile))
    throw Error("请先配置模型接口与 Key");
  return { prefs, profile };
}
export async function assertAutomationIdle(storyId: string) {
  if (
    controls.has(storyId) ||
    (await db.phoneAutomationRuns
      .where("storyId")
      .equals(storyId)
      .filter((r) => r.status === "running")
      .count())
  )
    throw Error("这本手机作品正在自动推进，请先暂停任务");
}
async function assertManualIdle(storyId: string) {
  if (
    (await db.phoneRuns
      .where("storyId")
      .equals(storyId)
      .filter((r) => r.status === "running")
      .count()) ||
    (await db.phoneDrafts
      .where("storyId")
      .equals(storyId)
      .filter((d) => d.generation?.status === "running")
      .count())
  )
    throw Error("当前作品还有生成任务，请等待完成或先停止");
}
export async function ensureAutomation(storyId: string) {
  return db.transaction("rw", db.tables, async () => {
    const story = await requireStory(storyId, "phone");
    const old = await db.phoneAutomationSettings
      .where("storyId")
      .equals(storyId)
      .first();
    if (old) return old;
    const settings: PhoneAutomationSettings = {
      id: uid(),
      storyId,
      roles: story.roles.map((r) => r.id),
      controlledRole: story.player || story.roles[0]?.id || "",
      takeover: false,
      rounds: 5,
      minutes: 5,
      endTime: "",
      maxRequests: 0,
      mode: "live",
      freedom: "limited",
      direction: "",
      startTime: phoneTime(),
      habits: Object.fromEntries(
        story.roles.map((r) => [r.id, defaultHabit()]),
      ),
      updated: Date.now(),
    };
    await db.phoneAutomationSettings.add(settings);
    // Existing records retain the knowledge semantics they had before this upgrade.
    for (const r of await db.phoneRecords
      .where("storyId")
      .equals(storyId)
      .toArray())
      if (!r.deleted && !r.legacyDraft)
        for (const actorId of r.audience)
          await db.phoneKnowledge.add({
            id: uid(),
            storyId,
            actorId,
            targetId: r.id,
            versionId: r.versionId,
            runId: "",
            stepId: "",
            created: Date.now(),
          });
    return settings;
  });
}
export async function saveAutomation(value: PhoneAutomationSettings) {
  const story = await requireStory(value.storyId, "phone"),
    options = automationOptionsSchema.parse(value);
  const roleIds = new Set(story.roles.map((r) => r.id));
  if (
    !options.roles.length ||
    new Set(options.roles).size !== options.roles.length ||
    options.roles.some((id) => !roleIds.has(id)) ||
    (options.controlledRole && !roleIds.has(options.controlledRole)) ||
    Object.keys(options.habits).some((id) => !roleIds.has(id))
  )
    throw Error("请选择本作品的有效角色");
  addMinutes(options.startTime, 0);
  if (options.endTime) addMinutes(options.endTime, 0);
  const existing = await ensureAutomation(story.id);
  const next = { ...value, ...options, id: existing.id, updated: Date.now() };
  await db.phoneAutomationSettings.put(next);
  return next;
}
export async function initializeAutomation() {
  for (const story of await db.stories
    .where("kind")
    .equals("phone")
    .toArray()) {
    await ensureAutomation(story.id);
    await withStoryLock(`phone:${story.id}`, async () => {
      await db.phoneAutomationRuns
        .where("storyId")
        .equals(story.id)
        .filter((r) => r.status === "running")
        .modify({
          status: "interrupted",
          error: "上次推进已中断，已有结果保留，点击继续恢复。",
        });
    }).catch(() => {});
  }
}
export async function startAutomation(
  storyId: string,
  input: PhoneAutomationOptions,
) {
  await ensureAutomation(storyId);
  const options = automationOptionsSchema.parse(input);
  const story = await requireStory(storyId, "phone");
  const roleIds = new Set(story.roles.map((r) => r.id));
  if (
    new Set(options.roles).size !== options.roles.length ||
    options.roles.some((id) => !roleIds.has(id)) ||
    (options.controlledRole && !roleIds.has(options.controlledRole))
  )
    throw Error("参与角色无效");
  addMinutes(options.startTime, 0);
  if (options.endTime) addMinutes(options.endTime, 0);
  if (
    !options.roles.some(
      (id) => options.takeover || id !== options.controlledRole,
    )
  )
    throw Error("请至少选择一位 AI 控制的角色");
  await connection();
  const run: PhoneAutomationRun = {
    id: uid(),
    storyId,
    options,
    status: "running",
    round: 0,
    requests: 0,
    waiting: {},
    error: "",
    created: Date.now(),
    updated: Date.now(),
  };
  await withStoryLock(`phone:${storyId}`, () =>
    db.transaction("rw", db.tables, async () => {
      await assertAutomationIdle(storyId);
      await assertManualIdle(storyId);
      await db.phoneAutomationRuns.add(run);
    }),
  );
  void continueAutomation(run.id, true).catch(() => {});
  return run.id;
}
export async function pauseAutomation(id: string) {
  const run = await db.phoneAutomationRuns.get(id);
  if (!run) return;
  controls.get(run.storyId)?.abort();
  if (run.status === "running")
    await db.phoneAutomationRuns.update(id, {
      status: "paused",
      error: "已暂停，已有结果保留。",
      updated: Date.now(),
    });
}
export async function cancelAutomation(id: string) {
  await pauseAutomation(id);
  const r = await db.phoneAutomationRuns.get(id);
  if (r && ["paused", "failed", "interrupted"].includes(r.status))
    await db.phoneAutomationRuns.update(id, {
      status: "cancelled",
      error: "任务已结束，已有结果和恢复资料保留。",
      updated: Date.now(),
    });
}
function mergePayload(
  base: PhoneAutomationPayload,
  extra: PhoneAutomationPayload,
) {
  const result = structuredClone(base);
  for (const key of [
    "records",
    "documents",
    "events",
    "conversations",
  ] as const) {
    const rows = new Map<string, any>(
      (result[key] as any[]).map((r) => [r.id, r]),
    );
    for (const r of extra[key]) rows.set(r.id, r);
    (result[key] as any) = [...rows.values()];
  }
  result.likes = [
    ...new Map(
      [...base.likes, ...extra.likes.filter((l) => !l.before)].map((l) => [
        `${l.recordId}:${l.actorId}`,
        l,
      ]),
    ).values(),
  ];
  for (const like of result.likes) {
    const r = result.records.find((r) => r.id === like.recordId);
    if (r && !r.likes.includes(like.actorId)) {
      r.likes.push(like.actorId);
      if (like.versionId)
        r.likeVersions = { ...r.likeVersions, [like.actorId]: like.versionId };
    }
  }
  return result;
}
async function overlays(run: PhoneAutomationRun) {
  let out = payload();
  if (run.options.mode === "draft")
    for (const step of (
      await db.phoneAutomationSteps.where("runId").equals(run.id).toArray()
    ).sort((a, b) => a.round - b.round || a.order - b.order))
      if (step.status === "complete" && step.result)
        out = mergePayload(out, step.result);
  return out;
}
async function freezeRound(run: PhoneAutomationRun, round: number) {
  const { prefs, profile } = await connection();
  const { key: _key, ...safeProfile } = profile;
  await db.transaction("rw", db.tables, async () => {
    const current = await db.phoneAutomationRuns.get(run.id);
    if (current?.status !== "running") throw Error("推进已停止");
    const story = await requireStory(run.storyId, "phone");
    const settings = await ensureAutomation(run.storyId);
    const options =
      settings.updated > run.created
        ? {
            ...run.options,
            roles: settings.roles,
            controlledRole: settings.controlledRole,
            takeover: settings.takeover,
            direction: settings.direction,
            freedom: settings.freedom,
            habits: settings.habits,
          }
        : run.options;
    let all: PhoneAutomationPayload = {
      records: await db.phoneRecords
        .where("storyId")
        .equals(story.id)
        .sortBy("seq"),
      documents: await db.phoneDocuments
        .where("storyId")
        .equals(story.id)
        .toArray(),
      events: await db.phoneWorldEvents
        .where("storyId")
        .equals(story.id)
        .toArray(),
      conversations: await db.phoneConversations
        .where("storyId")
        .equals(story.id)
        .toArray(),
      likes: [],
    };
    const draftOverlay = await overlays(run);
    const virtualIds = new Set(
      [
        ...draftOverlay.records,
        ...draftOverlay.documents,
        ...draftOverlay.events,
        ...draftOverlay.conversations,
      ].map((r) => r.id),
    );
    all = mergePayload(all, draftOverlay);
    // Only an actual newly sent user message releases a waiting conversation.
    for (const [cid, stamp] of Object.entries(run.waiting))
      if (
        all.records.some(
          (r) =>
            r.conversationId === cid &&
            r.speakerId === options.controlledRole &&
            r.origin === "user" &&
            !r.deleted &&
            r.created > stamp,
        )
      )
        delete run.waiting[cid];
    await db.phoneAutomationRuns.update(run.id, {
      waiting: run.waiting,
      round,
      updated: Date.now(),
    });
    const actors = options.roles.filter(
      (id) => options.takeover || id !== options.controlledRole,
    );
    for (let order = 0; order < actors.length; order++) {
      const actorId = actors[order];
      if (!story.roles.some((r) => r.id === actorId))
        throw Error("参与角色已移除，请重新启动推进");
      const habit = options.habits[actorId] || defaultHabit();
      const known = new Set(
        (
          await db.phoneKnowledge.where("actorId").equals(actorId).toArray()
        ).map((k) => `${k.targetId}:${k.versionId}`),
      );
      for (const previous of await db.phoneAutomationSteps
        .where("runId")
        .equals(run.id)
        .filter((s) => s.actorId === actorId && s.status === "complete")
        .toArray())
        for (const record of previous.snapshot.records)
          known.add(`${record.id}:${record.versionId}`);
      const visible = all.records.filter(
        (r) =>
          canSee(r, actorId) &&
          !r.legacyDraft &&
          (!r.parentId ||
            all.records.some((p) => p.id === r.parentId && canSee(p, actorId))),
      );
      const recentRounds = [...new Set(visible.map((r) => r.round))].slice(-20);
      let records = visible
        .filter((r) => recentRounds.includes(r.round) || r.pending)
        .filter((r) => {
          if (known.has(`${r.id}:${r.versionId}`) || r.speakerId === actorId)
            return true;
          if (r.kind !== "message")
            return (round - 1) % habit.browseEvery === 0;
          return round > habit.replyDelay;
        });
      // Keep visible parents and quotes with the selected recent history.
      const selected = new Map(records.map((r) => [r.id, r]));
      for (let pass = 0; pass < visible.length; pass++) {
        let added = false;
        for (const r of [...selected.values()])
          for (const id of [r.parentId, r.replyTo, r.body.quoteId]) {
            const source = visible.find((x) => x.id === id);
            if (source && !selected.has(id)) {
              selected.set(id, source);
              added = true;
            }
          }
        if (!added) break;
      }
      records = [...selected.values()].sort((a, b) => a.seq - b.seq);
      const snapshot: PhoneAutomationPayload = {
        records,
        documents: all.documents.filter(
          (d) => !d.deleted && d.audience.includes(actorId),
        ),
        events: all.events.filter(
          (e) => !e.deleted && e.audience.includes(actorId),
        ),
        conversations: all.conversations.filter((c) =>
          c.members.includes(actorId),
        ),
        likes: [],
      };
      const refs: PhoneAutomationStep["refs"] = [];
      for (const [table, rows] of [
        ["phoneRecords", records],
        ["phoneDocuments", snapshot.documents],
        ["phoneWorldEvents", snapshot.events],
        ["phoneConversations", snapshot.conversations],
      ] as const)
        for (const row of rows)
          if (!virtualIds.has(row.id) && (await db.table(table).get(row.id)))
            refs.push({
              table,
              id: row.id,
              version: sourceVersion(table, row),
            });
      const allowedAssets = new Set([
        ...records.flatMap((r) => r.body.assets),
        ...snapshot.documents.flatMap((d) => d.assets),
      ]);
      const assets = (
        await db.phoneAssets.where("storyId").equals(story.id).toArray()
      )
        .filter((a) => allowedAssets.has(a.id))
        .map((a) => ({ id: a.id, mime: a.mime }));
      const step = automationStepSchema.parse({
        id: uid(),
        storyId: story.id,
        runId: run.id,
        actorId,
        round,
        order,
        status: "pending",
        phase: "decision",
        options,
        context: await phoneContext(
          story.id,
          actorId,
          options.roles,
          options.direction,
          prefs,
          Infinity,
          true,
        ),
        materialVersion: await materialVersion(story.id),
        prompts: Object.fromEntries(
          (
            [
              "chat",
              "phoneDecision",
              "phoneMoment",
              "phoneInteraction",
              "phoneDocument",
              "phoneEvent",
            ] as PromptKind[]
          ).map((k) => [k, phoneInstruction(k, prefs) + "\n" + phoneImageInstruction(story, actorId)]),
        ),
        profile: { ...safeProfile, remember: false },
        time: addMinutes(options.startTime, (round - 1) * options.minutes),
        snapshot,
        roles: story.roles.map((r) => ({ id: r.id, name: r.name })),
        assets,
        readIds: records.map((r) => r.id),
        refs,
        beforeDocuments: [],
        afterVersions: {},
        applied: false,
        error: "",
        created: Date.now(),
        updated: Date.now(),
      });
      await db.phoneAutomationSteps.add(step);
    }
  });
}
function canonical(value: any): any {
  if (Array.isArray(value)) {
    const rows = value.map(canonical);
    return rows.every(
      (x) => x && typeof x === "object" && typeof x.id === "string",
    )
      ? rows.sort((a, b) => a.id.localeCompare(b.id))
      : rows;
  }
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, canonical(value[k])]),
    );
  return value;
}
async function materialVersion(storyId: string) {
  const story = await requireStory(storyId, "phone");
  return JSON.stringify(
    canonical([
      story.roles,
      story.worldIds,
      await db.storyWorld.where("storyId").equals(storyId).toArray(),
      await db.phoneBackgrounds.where("storyId").equals(storyId).toArray(),
    ]),
  );
}
async function assertSources(step: PhoneAutomationStep) {
  await requireStory(step.storyId, "phone");
  if (
    step.materialVersion &&
    JSON.stringify(canonical(JSON.parse(step.materialVersion))) !==
      (await materialVersion(step.storyId))
  )
    throw Error("角色、背景或世界书已修改，结果保留供检查，请重新开始任务");
  for (const ref of step.refs) {
    const row = await db.table(ref.table).get(ref.id);
    if (!row || row.deleted || sourceVersion(ref.table, row) !== ref.version)
      throw Error("参考资料已修改，请检查后结束本次任务；已有结果和草稿保留。");
  }
}
async function enrichStep(step: PhoneAutomationStep) {
  if (step.decisionRequest) return;
  const allSteps = await db.phoneAutomationSteps
    .where("runId")
    .equals(step.runId)
    .toArray();
  const virtualIds = new Set(
    allSteps
      .filter((s) => s.status === "complete" && s.result)
      .flatMap((s) =>
        [
          ...s.result!.records,
          ...s.result!.documents,
          ...s.result!.events,
          ...s.result!.conversations,
        ].map((x) => x.id),
      ),
  );
  const earlier = allSteps.filter(
    (s) =>
      s.round === step.round &&
      s.order < step.order &&
      s.status === "complete" &&
      s.result,
  );
  for (const prior of earlier) {
    const p = prior.result!;
    const allowed = {
      ...p,
      records: p.records.filter((r) => canSee(r, step.actorId)),
      documents: p.documents.filter((d) => d.audience.includes(step.actorId)),
      events: p.events.filter((e) => e.audience.includes(step.actorId)),
      conversations: p.conversations.filter((c) =>
        c.members.includes(step.actorId),
      ),
      likes: p.likes.filter((l) =>
        step.snapshot.records.some((r) => r.id === l.recordId),
      ),
    };
    // New social posts are read only at the character's chosen browsing cadence.
    if (
      (step.round - 1) %
        (step.options.habits[step.actorId]?.browseEvery || 1) !==
      0
    )
      allowed.records = allowed.records.filter((r) => r.kind === "message");
    step.snapshot = mergePayload(step.snapshot, allowed);
  }
  step.readIds = step.snapshot.records.map((r) => r.id);
  for (const [table, rows] of [
    ["phoneRecords", step.snapshot.records],
    ["phoneDocuments", step.snapshot.documents],
    ["phoneWorldEvents", step.snapshot.events],
    ["phoneConversations", step.snapshot.conversations],
  ] as const)
    for (const row of rows) {
      const priorChange = earlier.some((s) =>
        [
          ...s.result!.records,
          ...s.result!.documents,
          ...s.result!.events,
          ...s.result!.conversations,
        ].some((x) => x.id === row.id),
      );
      if (step.options.mode === "draft" && virtualIds.has(row.id)) continue;
      if (await db.table(table).get(row.id)) {
        const ref = step.refs.find((r) => r.table === table && r.id === row.id);
        if (ref && priorChange) ref.version = sourceVersion(table, row);
        else if (!ref)
          step.refs.push({
            table,
            id: row.id,
            version: sourceVersion(table, row),
          });
      }
    }
}
function describe(step: PhoneAutomationStep, waiting: Record<string, number>) {
  return `${step.context}\n【当前行动习惯】${JSON.stringify(step.options.habits[step.actorId] || defaultHabit())}\n【剧情自由度】${step.options.freedom === "limited" ? "有限创造，仅日常小事" : "主动发展，遵守作者方向与已有角色边界"}\n【作者方向】${step.options.direction}\n【剧情时间】${step.time}\n【角色编号】${JSON.stringify(step.roles)}\n【本人编号】${step.actorId}\n【用户控制角色】${step.options.takeover ? "无" : step.options.controlledRole}\n【等待用户的会话，不能继续催促】${JSON.stringify(Object.keys(waiting).filter((id) => step.snapshot.conversations.some((c) => c.id === id)))}\n【当前可用会话】${JSON.stringify(step.snapshot.conversations.map((c) => ({ id: c.id, title: c.title, members: c.members })))}\n【已读手机经历】${JSON.stringify(step.snapshot.records.map((r) => ({ id: r.id, conversationId: r.conversationId, kind: r.kind, parentId: r.parentId, speakerId: r.speakerId, audience: r.audience, text: recordText(r), assets: r.retracted ? [] : r.body.assets, time: r.time, pending: r.pending })))}\n【可知文档】${JSON.stringify(step.snapshot.documents.map((d) => ({ id: d.id, ownerId: d.ownerId, kind: d.kind, title: d.title, text: d.text, assets: d.assets, audience: d.audience })))}\n【已知事件】${JSON.stringify(step.snapshot.events.map((e) => ({ title: e.title, text: e.text, time: e.time })))}\n【可复用素材】${JSON.stringify(step.assets)}`;
}
function actionPrompt() {
  return "选择且只选择一个行动，返回指定 JSON。kind 为 chat/moment/comment/like/note/draft/event/wait。字段无关时用空字符串、空数组或 false。chat 使用已有 conversationId；开启私聊则填写 recipientId。评论与点赞填写原动态 parentId，回复评论另填 replyTo。修改私密文档填写 documentId，且只能修改自己的文档。audience 用角色 ID，必须包含本人；评论继承动态受众。不要选择等待用户的会话。awaitUser 仅用于需要用户答复的聊天。instruction 写内容生成要求，不把计划描述成已发生。";
}
function validateAction(
  step: PhoneAutomationStep,
  action: PhoneAutoAction,
  waiting: Record<string, number>,
) {
  const roleIds = new Set(step.roles.map((r) => r.id)),
    own = step.actorId;
  if (!step.options.takeover && own === step.options.controlledRole)
    throw Error("没有授权接管用户角色");
  if (action.audience.some((id) => !roleIds.has(id)))
    throw Error("行动包含未知受众");
  const fields: Record<PhoneAutoAction["kind"], string[]> = {
    chat: ["conversationId", "recipientId"],
    moment: [],
    comment: ["parentId", "replyTo"],
    like: ["parentId"],
    note: ["documentId"],
    draft: ["documentId", "recipientId"],
    event: [],
    wait: [],
  };
  for (const key of [
    "conversationId",
    "recipientId",
    "parentId",
    "replyTo",
    "documentId",
  ] as const)
    if (action[key] && !fields[action.kind].includes(key))
      throw Error("行动包含无关目标，请重新判断");
  if (["note", "draft"].includes(action.kind) && !action.documentId)
    action.audience = [own];
  if (action.kind === "chat") {
    const c = step.snapshot.conversations.find(
      (c) => c.id === action.conversationId,
    );
    if (action.conversationId && (!c || !c.members.includes(own)))
      throw Error("行动会话不可见");
    if (!c && (!roleIds.has(action.recipientId) || action.recipientId === own))
      throw Error("私聊对象无效");
    const existing =
      c ||
      step.snapshot.conversations.find(
        (c) =>
          c.kind === "direct" &&
          c.members.includes(own) &&
          c.members.includes(action.recipientId),
      );
    if (existing && waiting[existing.id])
      throw Error("此对话正在等待用户，请选择其他行动");
    if (existing) action.conversationId = existing.id;
  }
  if (["comment", "like"].includes(action.kind)) {
    const parent = step.snapshot.records.find(
      (r) => r.id === action.parentId && r.kind === "moment",
    );
    if (!parent || !canSee(parent, own))
      throw Error("只能回应角色实际看过的动态");
    action.audience = parent.audience;
    if (
      action.replyTo &&
      !step.snapshot.records.some(
        (r) =>
          r.id === action.replyTo && r.parentId === parent.id && canSee(r, own),
      )
    )
      throw Error("评论回复目标不可见");
  }
  if (["moment", "event", "note", "draft"].includes(action.kind)) {
    if (!action.audience.length) action.audience = [own];
    if (!action.audience.includes(own)) throw Error("行动受众必须包含本人");
  }
  if (action.recipientId && !roleIds.has(action.recipientId))
    throw Error("拟发送对象无效");
  if (action.documentId) {
    const d = step.snapshot.documents.find((d) => d.id === action.documentId);
    if (
      !["note", "draft"].includes(action.kind) ||
      !d ||
      d.ownerId !== own ||
      d.kind !== action.kind
    )
      throw Error("只能编辑自己的同类文档");
    if (action.audience.some((id) => !d.audience.includes(id)))
      throw Error("自动修改不能扩大文档知情范围");
  }
  return action;
}
class RequestLimit extends Error {}
async function request(
  step: PhoneAutomationStep,
  phase: "decision" | "content",
  system: string,
  user: string,
  schema: Record<string, unknown>,
  control: AbortController,
) {
  const field = phase === "decision" ? "decisionRequest" : "contentRequest";
  if (step[field]?.complete) return step[field]!.raw;
  const run = await db.phoneAutomationRuns.get(step.runId);
  if (control.signal.aborted || run?.status !== "running")
    throw Error("推进已停止");
  if (run.options.maxRequests && run.requests >= run.options.maxRequests)
    throw new RequestLimit("已到本次请求次数上限，可调整上限后继续。");
  await assertSources(step);
  const profile = step.profile;
  const original = await db.profiles.get(profile.id);
  const stored =
    (original?.url === profile.url && original.protocol === profile.protocol
      ? original
      : undefined) ||
    (await db.profiles
      .filter(
        (p) =>
          p.protocol === profile.protocol &&
          p.url === profile.url &&
          p.model === profile.model,
      )
      .first());
  const key = stored && keyFor(stored);
  if (!key) throw Error("原接口 Key 不可用，请补充该接口的 Key 后继续");
  const frozen = step[field] || { system, user, raw: "", complete: false };
  const report = assemble(
    frozen.system,
    frozen.user,
    [],
    profile.context,
    profile.maxOutput,
  );
  step[field] = frozen;
  step.status = "running";
  step.phase = phase;
  step.error = "";
  step.updated = Date.now();
  await db.transaction("rw", db.tables, async () => {
    if ((await db.phoneAutomationRuns.get(run.id))?.status !== "running")
      throw Error("推进已停止");
    await db.phoneAutomationRuns.update(run.id, {
      requests: run.requests + 1,
      updated: Date.now(),
    });
    await persistStep(step);
  });
  if (run.options.mode === "live") await remember(step);
  let saving = Promise.resolve(),
    last = 0;
  let result;
  try {
    result = await generate(
      profile,
      key,
      report.system,
      report.user,
      control.signal,
      (raw) => {
        frozen.raw = raw;
        if (Date.now() - last > 300) {
          last = Date.now();
          const copy = structuredClone(step);
          saving = saving.then(() => persistStep(copy)).then(() => {});
        }
      },
      fetch,
      {
        kind:
          phase === "decision"
            ? "phoneDecision"
            : contentKind(step.action!.kind),
        schema,
        schemaName:
          phase === "decision" ? "phone_action" : "phone_action_content",
      },
    );
  } finally {
    await saving;
    await persistStep(step);
  }
  await saving;
  frozen.raw = result.text;
  if (
    control.signal.aborted ||
    (await db.phoneAutomationRuns.get(run.id))?.status !== "running"
  )
    throw Error("推进已停止，未采用迟到结果");
  if (!result.complete) {
    await persistStep(step);
    throw Error("模型输出未完成：" + result.reason);
  }
  frozen.complete = true;
  await persistStep(step);
  return result.text;
}
function contentKind(kind: PhoneAutoAction["kind"]): PromptKind {
  return kind === "moment"
    ? "phoneMoment"
    : kind === "comment"
      ? "phoneInteraction"
      : kind === "event"
        ? "phoneEvent"
        : ["note", "draft"].includes(kind)
          ? "phoneDocument"
          : "chat";
}
function buildResult(
  step: PhoneAutomationStep,
  generated?: z.infer<typeof contentSchema>,
) {
  const action = step.action!,
    out = payload(),
    now = Date.now(),
    actorId = step.actorId;
  if (action.kind === "wait") return out;
  if (action.kind === "like") {
    const r = step.snapshot.records.find((r) => r.id === action.parentId)!;
    out.likes.push({
      recordId: r.id,
      actorId,
      before: r.likes.includes(actorId),
      beforeVersion: r.likeVersions?.[actorId] || "",
      versionId: uid(),
    });
    return out;
  }
  if (!generated) throw Error("缺少生成内容");
  const allowed = new Set(step.assets.map((a) => a.id));
  for (const asset of [
    ...generated.assets,
    ...generated.messages.flatMap((m) => m.assets),
  ])
    if (!allowed.has(asset)) throw Error("模型引用了未经授权的素材");
  if (["chat", "moment", "comment"].includes(action.kind)) {
    if (
      !generated.messages.length ||
      (action.kind !== "chat" && generated.messages.length !== 1)
    )
      throw Error("消息数量无效");
    let c = step.snapshot.conversations.find(
      (c) => c.id === action.conversationId,
    );
    if (action.kind === "chat" && !c) {
      c = {
        id: uid(),
        storyId: step.storyId,
        kind: "direct",
        title: "",
        avatar: "",
        members: [actorId, action.recipientId],
        created: now,
        updated: now,
      };
      out.conversations.push(c);
    }
    const audience = action.kind === "chat" ? c!.members : action.audience;
    for (const body of generated.messages) {
      if (
        !["text", "image", "sticker", "audio", "transfer", "call"].includes(
          body.type,
        )
      )
        throw Error("不允许自动生成系统消息");
      for (const assetId of body.assets) {
        const a = step.assets.find((a) => a.id === assetId)!;
        if (!a.mime.startsWith(body.type === "audio" ? "audio/" : "image/"))
          throw Error("附件类型与消息形式不匹配");
      }
      if (
        !body.text.trim() &&
        !body.assets.length &&
        !["call", "transfer"].includes(body.type)
      )
        throw Error("消息内容为空");
      if (body.assets.length > (action.kind === "moment" ? 9 : 1))
        throw Error("消息素材过多");
      if (
        action.kind !== "chat" &&
        !["text", "image", "sticker"].includes(body.type)
      )
        throw Error("朋友圈只支持文字和图片");
      if (
        body.quoteId &&
        !step.snapshot.records.some(
          (r) =>
            r.id === body.quoteId &&
            r.conversationId === c?.id &&
            canSee(r, actorId) &&
            audience.every((id) => r.audience.includes(id)),
        )
      )
        throw Error("引用消息不可见");
      const versionId = uid(),
        id = uid();
      out.records.push(
        phoneRecordSchema.parse({
          id,
          storyId: step.storyId,
          conversationId: c?.id || "",
          kind: action.kind === "chat" ? "message" : action.kind,
          parentId: action.kind === "comment" ? action.parentId : "",
          replyTo: action.kind === "comment" ? action.replyTo : "",
          speakerId: actorId,
          audience,
          body,
          time: step.time,
          seq: 0,
          round: `${step.runId}:${step.round}`,
          runId: "",
          versionId,
          versions: [
            {
              id: versionId,
              body,
              time: step.time,
              deleted: false,
              retracted: false,
              created: now,
            },
          ],
          pending: false,
          deleted: false,
          retracted: false,
          likes: [],
          origin: "ai",
          legacyId: "",
          created: now,
          updated: now,
        }),
      );
    }
  } else if (action.kind === "event") {
    if (!generated.title.trim() || !generated.text.trim())
      throw Error("剧情事件标题和正文不能为空");
    out.events.push({
      id: uid(),
      storyId: step.storyId,
      actorId,
      title: generated.title,
      text: generated.text,
      audience: action.audience,
      time: step.time,
      versionId: uid(),
      runId: step.runId,
      stepId: step.id,
      deleted: false,
      created: now,
    });
  } else {
    if (!generated.title.trim() || !generated.text.trim())
      throw Error("文档标题和正文不能为空");
    if (
      generated.assets.some(
        (id) =>
          !step.assets.find((a) => a.id === id)?.mime.startsWith("image/"),
      )
    )
      throw Error("文档只能使用图片素材");
    const old = step.snapshot.documents.find((d) => d.id === action.documentId),
      versionId = uid();
    if (old) step.beforeDocuments = [old];
    const d = {
      id: old?.id || uid(),
      storyId: step.storyId,
      ownerId: actorId,
      kind: action.kind as "note" | "draft",
      title: generated.title,
      text: generated.text,
      assets: generated.assets,
      time: step.time,
      album: "",
      recipientId: action.kind === "draft" ? action.recipientId : "",
      audience: action.audience,
      pinned: old?.pinned || false,
      deleted: false,
      versionId,
      versions: old?.versions || [],
      created: old?.created || now,
      updated: now,
    };
    d.versions = [
      ...d.versions,
      {
        id: versionId,
        title: d.title,
        text: d.text,
        assets: d.assets,
        time: d.time,
        album: "",
        recipientId: d.recipientId,
        audience: d.audience,
        pinned: d.pinned,
        deleted: false,
        created: now,
      },
    ];
    out.documents.push(documentSchema.parse(d));
  }
  return out;
}
async function remember(step: PhoneAutomationStep) {
  for (const targetId of step.readIds) {
    const r = step.snapshot.records.find((r) => r.id === targetId);
    if (!r) continue;
    if (
      await db.phoneKnowledge
        .where("[actorId+targetId]")
        .equals([step.actorId, targetId])
        .filter((k) => k.versionId === r.versionId)
        .count()
    )
      continue;
    await db.phoneKnowledge.add({
      id: uid(),
      storyId: step.storyId,
      actorId: step.actorId,
      targetId,
      versionId: r.versionId,
      runId: step.runId,
      stepId: step.id,
      created: Date.now(),
    });
  }
}
async function applyResult(step: PhoneAutomationStep, checked = false) {
  if (step.applied) return;
  if (!checked) await assertSources(step);
  const out = step.result!;
  const story = await requireStory(step.storyId, "phone");
  const roles = new Set(story.roles.map((r) => r.id));
  if (
    !roles.has(step.actorId) ||
    (!step.options.takeover && step.actorId === step.options.controlledRole)
  )
    throw Error("角色授权已失效");
  for (const x of [...out.records, ...out.documents, ...out.events])
    if (
      x.storyId !== step.storyId ||
      x.audience.some((id) => !roles.has(id)) ||
      !x.audience.includes(step.actorId)
    )
      throw Error("行动受众无效");
  for (const id of [
    ...out.records.flatMap((r) => r.body.assets),
    ...out.documents.flatMap((d) => d.assets),
  ])
    if (
      (await db.phoneAssets.get(id))?.storyId !== step.storyId ||
      !step.assets.some((a) => a.id === id)
    )
      throw Error("素材授权已失效");
  for (const c of out.conversations) {
    if (c.storyId !== step.storyId || c.members.some((id) => !roles.has(id)))
      throw Error("会话角色无效");
    if (
      await db.phoneConversations
        .where("storyId")
        .equals(step.storyId)
        .filter(
          (x) =>
            x.kind === "direct" &&
            c.members.every((id) => x.members.includes(id)),
        )
        .count()
    )
      throw Error("同一私聊已被创建，请检查草稿后重新推进");
    await db.phoneConversations.add(c);
  }
  let seq =
    (
      await db.phoneRecords.where("storyId").equals(step.storyId).sortBy("seq")
    ).at(-1)?.seq || 0;
  for (const r of out.records) {
    const c =
      r.conversationId && (await db.phoneConversations.get(r.conversationId));
    if (
      r.speakerId !== step.actorId ||
      (r.kind === "message" && (!c || c.storyId !== step.storyId))
    )
      throw Error("消息身份或会话无效");
    if (
      c &&
      (!c.members.includes(step.actorId) ||
        JSON.stringify(c.members) !== JSON.stringify(r.audience))
    )
      throw Error("群成员已改变，结果未写入");
    if (r.parentId) {
      const p = await db.phoneRecords.get(r.parentId);
      if (
        !p ||
        !canSee(p, step.actorId) ||
        JSON.stringify(p.audience) !== JSON.stringify(r.audience)
      )
        throw Error("动态受众已改变");
    }
    r.seq = ++seq;
    await db.phoneRecords.add(r);
    step.afterVersions[r.id] = r.versionId;
  }
  for (const d of out.documents) {
    const old = await db.phoneDocuments.get(d.id);
    if (
      d.ownerId !== step.actorId ||
      (old && (old.storyId !== step.storyId || old.ownerId !== step.actorId))
    )
      throw Error("文档身份无效");
    await db.phoneDocuments.put(d);
    step.afterVersions[d.id] = d.versionId;
  }
  for (const e of out.events) {
    await db.phoneWorldEvents.add(e);
    step.afterVersions[e.id] = e.versionId;
  }
  for (const like of out.likes) {
    const r = await db.phoneRecords.get(like.recordId);
    if (!r || !canSee(r, step.actorId)) throw Error("点赞目标不可见");
    if (
      r.likes.includes(like.actorId) !== like.before ||
      (r.likeVersions?.[like.actorId] || "") !== (like.beforeVersion || "")
    )
      throw Error("点赞状态已被修改，请检查后重试");
    if (!r.likes.includes(like.actorId))
      await db.phoneRecords.update(r.id, {
        likes: [...r.likes, like.actorId],
        likeVersions: {
          ...r.likeVersions,
          [like.actorId]: like.versionId || uid(),
        },
      });
  }
  if (step.action?.kind === "chat")
    for (const source of step.snapshot.records.filter(
      (r) =>
        r.pending &&
        r.conversationId === out.records[0]?.conversationId &&
        r.speakerId !== step.actorId,
    )) {
      const current = await db.phoneRecords.get(source.id);
      if (current?.pending && current.versionId === source.versionId) {
        await db.phoneRecords.update(source.id, { pending: false });
        step.consumedIds.push(source.id);
      }
    }
  await remember(step);
  step.applied = true;
  schedulePhoneImages(out.records.map(r => r.id), step.runId);
}
async function performStep(
  step: PhoneAutomationStep,
  control: AbortController,
) {
  await enrichStep(step);
  let run = (await db.phoneAutomationRuns.get(step.runId))!;
  try {
    if (!step.action) {
      const raw = await request(
        step,
        "decision",
        step.prompts.phoneDecision + "\n" + actionPrompt(),
        describe(step, run.waiting),
        decisionWire,
        control,
      );
      try {
        step.action = validateAction(
          step,
          autoActionSchema.parse(parseJSON(raw)),
          run.waiting,
        );
      } catch (e) {
        step.decisionRequest!.complete = false;
        await persistStep(step);
        throw e;
      }
      await persistStep(step);
    }
    if (!step.result) {
      let content: z.infer<typeof contentSchema> | undefined;
      if (!["wait", "like"].includes(step.action.kind)) {
        const raw = await request(
          step,
          "content",
          step.prompts[contentKind(step.action.kind)] +
            "\n返回指定 JSON。聊天、动态、评论填 messages；文档或事件填 title、text、assets，messages 留空。只生成一个行动，不改变受众。素材与引用只能从提供的编号选取，无关字段留空。",
          describe(step, run.waiting) +
            "\n【已确定行动】" +
            JSON.stringify(step.action),
          contentWire,
          control,
        );
        try {
          content = contentSchema.parse(parseJSON(raw));
          step.result = buildResult(step, content);
        } catch (e) {
          step.contentRequest!.complete = false;
          await persistStep(step);
          throw e;
        }
      } else step.result = buildResult(step);
      step.phase = "commit";
      await persistStep(step);
    }
    await db.transaction("rw", db.tables, async () => {
      run = (await db.phoneAutomationRuns.get(step.runId))!;
      if (control.signal.aborted || run.status !== "running")
        throw Error("推进已停止");
      await assertSources(step);
      if (run.options.mode === "live") await applyResult(step);
      if (step.action!.kind === "chat" && !step.options.takeover) {
        const r = step.result!.records[0];
        if (
          r?.audience.includes(step.options.controlledRole) &&
          (r.audience.length === 2 || step.action!.awaitUser)
        )
          run.waiting[r.conversationId] = Date.now();
      }
      step.status = "complete";
      step.error = "";
      step.updated = Date.now();
      await persistStep(step);
      await db.phoneAutomationRuns.update(run.id, {
        waiting: run.waiting,
        updated: Date.now(),
      });
    });
  } catch (e) {
    step.status = "failed";
    step.error = String(e);
    step.updated = Date.now();
    await persistStep(step);
    throw e;
  }
}
export async function continueAutomation(id: string, initial = false) {
  const first = await db.phoneAutomationRuns.get(id);
  if (!first) throw Error("任务不存在");
  if (controls.has(first.storyId)) throw Error("任务已经在运行");
  if (["complete", "adopted", "undone", "cancelled"].includes(first.status))
    throw Error("任务已经结束，请新建推进任务");
  return withStoryLock(`phone:${first.storyId}`, async () => {
    if (initial && (await db.phoneAutomationRuns.get(id))?.status !== "running")
      return;
    if (
      await db.phoneAutomationRuns
        .where("storyId")
        .equals(first.storyId)
        .filter((r) => r.id !== id && r.status === "running")
        .count()
    )
      throw Error("作品已有其他推进任务");
    await assertManualIdle(first.storyId);
    const control = new AbortController();
    controls.set(first.storyId, control);
    let stopWatching: (() => void) | undefined;
    try {
      const run = (await db.phoneAutomationRuns.get(id))!;
      await db.phoneAutomationRuns.update(id, {
        status: "running",
        error: "",
        updated: Date.now(),
      });
      const watcher = liveQuery(() => db.phoneAutomationRuns.get(id)).subscribe(
        (current) => {
          if (!current || ["paused", "cancelled"].includes(current.status))
            control.abort();
        },
      );
      stopWatching = () => watcher.unsubscribe();
      for (
        let round = Math.max(1, run.round);
        round <= run.options.rounds;
        round++
      ) {
        if (control.signal.aborted) throw Error("推进已暂停");
        if (
          run.options.endTime &&
          addMinutes(run.options.startTime, (round - 1) * run.options.minutes) >
            run.options.endTime
        )
          break;
        let steps = await db.phoneAutomationSteps
          .where("[runId+round]")
          .equals([id, round])
          .toArray();
        if (!steps.length) {
          await freezeRound((await db.phoneAutomationRuns.get(id))!, round);
          steps = await db.phoneAutomationSteps
            .where("[runId+round]")
            .equals([id, round])
            .toArray();
        }
        for (const step of steps.sort((a, b) => a.order - b.order))
          if (step.status !== "complete") await performStep(step, control);
      }
      await db.phoneAutomationRuns.update(id, {
        status: "complete",
        error: "",
        updated: Date.now(),
      });
    } catch (e) {
      if (
        (await db.phoneAutomationRuns.get(id)) &&
        (await db.phoneAutomationRuns.get(id))?.status !== "cancelled"
      )
        await db.phoneAutomationRuns.update(id, {
          status:
            control.signal.aborted || e instanceof RequestLimit
              ? "paused"
              : "failed",
          error: String(e),
          updated: Date.now(),
        });
      throw e;
    } finally {
      stopWatching?.();
      controls.delete(first.storyId);
    }
  });
}
export async function extendRequestLimit(id: string, limit: number) {
  const r = await db.phoneAutomationRuns.get(id);
  if (!r || r.status === "running") throw Error("请先暂停任务");
  if (!Number.isInteger(limit) || limit < 0 || limit > 10000)
    throw Error("次数上限无效");
  await db.phoneAutomationRuns.update(id, {
    options: { ...r.options, maxRequests: limit },
  });
}
export async function adoptAutomation(id: string) {
  const r = await db.phoneAutomationRuns.get(id);
  if (
    !r ||
    r.options.mode !== "draft" ||
    !["complete", "paused", "failed", "interrupted", "cancelled"].includes(
      r.status,
    )
  )
    throw Error("请先暂停并检查草稿");
  await withStoryLock(`phone:${r.storyId}`, () =>
    db.transaction("rw", db.tables, async () => {
      await assertAutomationIdle(r.storyId);
      await assertManualIdle(r.storyId);
      const steps = (
        await db.phoneAutomationSteps.where("runId").equals(id).toArray()
      )
        .filter((s) => s.status === "complete" && s.result)
        .sort((a, b) => a.round - b.round || a.order - b.order);
      if (!steps.length) throw Error("没有可采用的草稿");
      // Validate all external versions before applying any draft overlay.
      for (const s of steps) await assertSources(s);
      for (const s of steps) {
        await applyResult(s, true);
        await db.phoneAutomationSteps.put(s);
      }
      await db.phoneAutomationRuns.update(id, {
        status: "adopted",
        updated: Date.now(),
      });
    }),
  );
}
export async function undoAutomation(id: string, cascade = false) {
  const r = await db.phoneAutomationRuns.get(id);
  if (!r) throw Error("任务不存在");
  await withStoryLock(`phone:${r.storyId}`, () =>
    db.transaction("rw", db.tables, async () => {
      await assertAutomationIdle(r.storyId);
      await assertManualIdle(r.storyId);
      const all = await db.phoneAutomationSteps
        .where("storyId")
        .equals(r.storyId)
        .toArray();
      const selected = new Set([id]);
      if (cascade)
        for (let pass = 0; pass < all.length; pass++) {
          const outputs = new Set(
            all
              .filter((s) => selected.has(s.runId) && s.applied)
              .flatMap((s) =>
                s.result
                  ? [
                      ...s.result.records,
                      ...s.result.documents,
                      ...s.result.events,
                    ].map((x) => x.id)
                  : [],
              ),
          );
          let changed = false;
          for (const s of all)
            if (
              s.applied &&
              !selected.has(s.runId) &&
              s.refs.some((ref) => outputs.has(ref.id))
            ) {
              selected.add(s.runId);
              changed = true;
            }
          if (!changed) break;
        }
      const runs = (await db.phoneAutomationRuns.bulkGet([...selected]))
        .filter((x): x is PhoneAutomationRun => !!x)
        .sort((a, b) => b.created - a.created);
      for (const run of runs) await undoOne(run);
    }),
  );
}
async function undoOne(r: PhoneAutomationRun) {
  const id = r.id;
  if (r.status === "undone") throw Error("已经撤销");
  const steps = (
    await db.phoneAutomationSteps.where("runId").equals(id).toArray()
  )
    .filter((s) => s.applied && s.result)
    .sort((a, b) => b.round - a.round || b.order - a.order);
  const affected = new Set(
    steps.flatMap((s) =>
      [...s.result!.records, ...s.result!.documents, ...s.result!.events].map(
        (x) => x.id,
      ),
    ),
  );
  const dependent = (
    await db.phoneAutomationSteps.where("storyId").equals(r.storyId).toArray()
  ).filter(
    (s) =>
      s.runId !== id && s.applied && s.refs.some((ref) => affected.has(ref.id)),
  );
  if (dependent.length)
    throw Error(
      "后续自动批次引用了这些内容，请先逆序撤销：" +
        [...new Set(dependent.map((s) => s.runId))].join("、"),
    );
  const external = (
    await db.phoneRecords.where("storyId").equals(r.storyId).toArray()
  ).filter(
    (x) =>
      !x.deleted &&
      !affected.has(x.id) &&
      (affected.has(x.parentId) ||
        affected.has(x.replyTo) ||
        affected.has(x.body.quoteId)),
  );
  if (external.length)
    throw Error(
      "存在手写或其他生成的引用，请先处理相关评论与引用，不能连带删除。",
    );
  const manualRuns = (
    await db.phoneRuns.where("storyId").equals(r.storyId).toArray()
  ).filter(
    (x) =>
      x.created > r.created &&
      x.status === "complete" &&
      (x.sourceIds.some((id) => affected.has(id)) ||
        steps.some((s) =>
          s.result?.records.some(
            (record) =>
              record.conversationId &&
              record.conversationId === x.conversationId,
          ),
        )),
  );
  for (const manual of manualRuns)
    if (
      (
        await db.phoneRecords.bulkGet(manual.steps.flatMap((s) => s.outputIds))
      ).some((x) => x && !x.deleted)
    )
      throw Error(
        "后续手动生成引用过这些经历，请先处理对应结果，不能连带删除。",
      );
  if (
    await db.phoneDrafts
      .where("storyId")
      .equals(r.storyId)
      .filter((d) =>
        Object.keys(d.sourceVersions).some((id) => affected.has(id)),
      )
      .count()
  )
    throw Error("编排草稿引用了这些消息，请先处理相关草稿。");
  const expected = new Map<string, string>();
  for (const s of steps)
    for (const [id, v] of Object.entries(s.afterVersions))
      if (!expected.has(id)) expected.set(id, v);
  for (const [id, v] of expected) {
    const row =
      (await db.phoneRecords.get(id)) ||
      (await db.phoneDocuments.get(id)) ||
      (await db.phoneWorldEvents.get(id));
    if (!row || row.versionId !== v)
      throw Error("结果后来被编辑，请先检查冲突，未执行撤销。");
  }
  for (const s of steps) {
    for (const x of s.result!.records)
      await db.phoneRecords.update(x.id, { deleted: true });
    for (const x of s.result!.events)
      await db.phoneWorldEvents.update(x.id, { deleted: true });
    for (const d of s.result!.documents) {
      const old = s.beforeDocuments.find((x) => x.id === d.id);
      if (old) {
        const current = await db.phoneDocuments.get(d.id);
        await db.phoneDocuments.put({
          ...old,
          versions: current?.versions || old.versions,
        });
      } else await db.phoneDocuments.update(d.id, { deleted: true });
    }
    for (const l of s.result!.likes)
      if (!l.before) {
        const x = await db.phoneRecords.get(l.recordId);
        if (
          x &&
          (x.likeVersions?.[l.actorId] !== l.versionId ||
            !x.likes.includes(l.actorId))
        )
          throw Error("点赞后来被修改，未执行撤销。");
        if (x)
          await db.phoneRecords.update(x.id, {
            likes: x.likes.filter((id) => id !== l.actorId),
            likeVersions: {
              ...x.likeVersions,
              [l.actorId]: l.beforeVersion || "",
            },
          });
      }
    for (const consumed of s.consumedIds) {
      const x = await db.phoneRecords.get(consumed);
      if (
        x &&
        x.versionId ===
          s.snapshot.records.find((r) => r.id === consumed)?.versionId
      )
        await db.phoneRecords.update(consumed, { pending: true });
    }
    s.applied = false;
    await db.phoneAutomationSteps.put(s);
  }
  await db.phoneKnowledge
    .where("storyId")
    .equals(r.storyId)
    .filter((k) => k.runId === id || affected.has(k.targetId))
    .delete();
  await db.phoneAutomationRuns.update(id, {
    status: "undone",
    updated: Date.now(),
  });
}
export async function suggestHabits(
  storyId: string,
  actorId: string,
  signal: AbortSignal,
) {
  await assertAutomationIdle(storyId);
  return withStoryLock(`phone:${storyId}`, async () => {
    await assertManualIdle(storyId);
    const story = await requireStory(storyId, "phone"),
      own = story.roles.find((r) => r.id === actorId);
    if (!own) throw Error("角色不存在");
    const { prefs, profile } = await connection();
    const report = assemble(
      phoneInstruction("phoneHabits", prefs) +
        "\n返回行动习惯 JSON，replyDelay 是等待几回合再阅读新消息，browseEvery 是每几回合查看朋友圈。",
      `${own.name}\n${own.bio}\n${own.paragraphs.map((p) => p.text).join("\n")}`,
      [],
      profile.context,
      profile.maxOutput,
    );
    const result = await generate(
      profile,
      keyFor(profile),
      report.system,
      report.user,
      signal,
      () => {},
      fetch,
      { kind: "phoneHabits", schema: habitsWire, schemaName: "phone_habits" },
    );
    if (signal.aborted || !result.complete) throw Error("习惯整理未完成");
    return habitSchema.parse(parseJSON(result.text));
  });
}
