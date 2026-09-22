import { assemble } from "./context";
import { db, keyFor } from "./db";
import { active as storyActive } from "./generation-state";
import { withStoryLock } from "./locks";
import { generate } from "./model";
import { parseJSON, topLevelString } from "./output";
import { prompt } from "./prompts";
import { selectedTheaterPresets, theaterInstruction } from "./theater-presets";
import { theaterText } from "./theater-text";
import {
  uid,
  type ContextReport,
  type Material,
  type Preferences,
  type Profile,
  type SceneEvent,
  type Story,
  type TheaterPreset,
  type TheaterRecord,
  type WorldEntry,
} from "./types";

export function validateTheaterHtml(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/<[a-z][^>]*>/i.test(value) ||
    !theaterText(value)
  )
    throw Error(
      "小剧场没有完整的 HTML 和可阅读内容，收到的内容已保留，请重试。",
    );
  return value.trim();
}

export function buildTheaterContext(
  story: Story,
  event: SceneEvent,
  world: WorldEntry[],
  prefs: Preferences,
  profile: Profile,
  presets = selectedTheaterPresets(story, prefs),
): ContextReport {
  if (
    event.storyId !== story.id ||
    event.kind !== "novel" ||
    event.deleted ||
    !event.text.trim()
  )
    throw Error("请先选择一段有效正文，再生成小剧场");
  if (!presets.length) throw Error("先在小剧场设置中选择至少一个预设");
  const materials: Material[] = [];
  const add = (id: string, label: string, text: string, stable = false) => {
    if (text.trim())
      materials.push({ id, label, text, stable, mandatory: true, priority: 0 });
  };
  const present = story.roles.map((role) => role.id);
  const audience = (ids: string[]) =>
    ids
      .map((id) => story.roles.find((role) => role.id === id)?.name || id)
      .join("、") || "仅作者";
  add(
    "roles",
    "角色名单",
    story.roles.map((role) => `${role.id} = ${role.name}`).join("\n"),
    true,
  );
  for (const role of story.roles) {
    add(role.id + ":bio", "人物简介 · " + role.name, role.bio, true);
    const paragraphs = role.paragraphs.length
      ? role.paragraphs
      : [{ text: role.persona, public: false }];
    for (const [index, paragraph] of paragraphs.entries())
      add(
        role.id + ":persona:" + index,
        "人物设定 · " + role.name,
        `可知范围 ${paragraph.public ? "所有角色" : role.name}\n${paragraph.text}`,
        true,
      );
  }
  for (const id of story.worldIds) {
    const entry = world.find((candidate) => candidate.id === id);
    if (
      !entry ||
      !entry.enabled ||
      (entry.storyIds.length && !entry.storyIds.includes(story.id)) ||
      (entry.roleIds.length &&
        !(entry.match === "all"
          ? entry.roleIds.every((role) => present.includes(role))
          : entry.roleIds.some((role) => present.includes(role)))) ||
      (!entry.always &&
        !entry.keywords.some(
          (keyword) => keyword.trim() && event.text.includes(keyword),
        ))
    )
      continue;
    add(
      entry.id,
      "世界书 · " + entry.title,
      `可知范围 ${entry.audience === "all" ? "所有角色" : entry.audience === "roles" ? audience(entry.knownBy) : "仅作者"}\n${entry.text}`,
      true,
    );
  }
  materials.push({
    id: event.id,
    label: `目标正文 · 第${event.round ?? event.seq}回 · 版本 ${event.versionId}`,
    text: event.text,
    mandatory: true,
    priority: 100,
    sources: [{ id: event.id, versionId: event.versionId }],
  });
  return assemble(
    prompt("theater", prefs),
    "只为给出的目标正文生成小剧场。当前没有提供其他回合，不补全前后剧情，也不把番外当作正式经历。\n\n" +
      theaterInstruction(presets),
    materials,
    profile.context,
    profile.maxOutput,
  );
}

const tables = [db.events, db.theaters, db.stories];
function summary(record: TheaterRecord): NonNullable<SceneEvent["theater"]> {
  return {
    id: record.id,
    sourceVersionId: record.sourceVersionId,
    status: record.status,
    ...(record.previousId ? { previousId: record.previousId } : {}),
  };
}
async function previousSuccess(eventId: string, sourceVersionId: string) {
  const latest = (records: TheaterRecord[]) =>
    records
      .filter((record) => record.status === "complete")
      .sort((a, b) => b.updated - a.updated || b.created - a.created)[0]?.id;
  const sameVersion = latest(
    await db.theaters
      .where("[eventId+sourceVersionId]")
      .equals([eventId, sourceVersionId])
      .toArray(),
  );
  // A failed reroll after a prose edit must not make its earlier successful
  // theater inaccessible. The record's own version still marks it as stale.
  return (
    sameVersion ??
    latest(await db.theaters.where("eventId").equals(eventId).toArray())
  );
}
async function publishSummary(record: TheaterRecord) {
  const event = await db.events.get(record.eventId);
  if (event?.theater?.id === record.id)
    await db.events.update(event.id, { theater: summary(record) });
}

export async function createTheaterAttempt(
  event: SceneEvent,
  presets: TheaterPreset[],
): Promise<TheaterRecord> {
  return db.transaction("rw", tables, async () => {
    const current = await db.events.get(event.id);
    if (
      !current ||
      current.deleted ||
      current.kind !== "novel" ||
      current.versionId !== event.versionId ||
      !(await db.stories.get(event.storyId))
    )
      throw Error("正文已经变化，请重新打开小剧场");
    const existing =
      current.theater && (await db.theaters.get(current.theater.id));
    if (
      existing?.status === "running" &&
      existing.sourceVersionId === current.versionId
    )
      throw Error("这段小剧场正在生成，请先停止或等待完成");
    const record: TheaterRecord = {
      id: uid(),
      storyId: event.storyId,
      eventId: event.id,
      sourceVersionId: event.versionId,
      presets: structuredClone(presets),
      html: "",
      text: "",
      raw: "",
      status: "running",
      error: "",
      created: Date.now(),
      updated: Date.now(),
      previousId: await previousSuccess(event.id, event.versionId),
    };
    await db.theaters.add(record);
    await db.events.update(event.id, { theater: summary(record) });
    return record;
  });
}

export async function updateTheaterAttempt(
  recordId: string,
  raw: string,
  html: string,
) {
  await db.transaction("rw", tables, async () => {
    const record = await db.theaters.get(recordId);
    if (!record || record.status !== "running") return;
    await db.theaters.update(recordId, {
      raw,
      html,
      text: theaterText(html),
      updated: Date.now(),
    });
  });
}

export async function finishTheaterAttempt(
  recordId: string,
  event: SceneEvent,
  html: string,
  raw: string,
): Promise<boolean> {
  return db.transaction("rw", tables, async () => {
    const record = await db.theaters.get(recordId);
    if (!record || record.status !== "running") return false;
    const current = await db.events.get(event.id);
    let validationError = "";
    try {
      html = validateTheaterHtml(html);
    } catch (error) {
      validationError = String(error);
    }
    const text = theaterText(html);
    const valid =
      !!current &&
      !current.deleted &&
      current.kind === "novel" &&
      current.status === "complete" &&
      current.storyId === record.storyId &&
      current.id === record.eventId &&
      current.versionId === record.sourceVersionId &&
      current.versionId === event.versionId &&
      current.text === event.text &&
      current.theater?.id === record.id &&
      !!(await db.stories.get(record.storyId));
    const next: TheaterRecord = {
      ...record,
      html,
      text,
      raw,
      updated: Date.now(),
      status: valid && !validationError ? "complete" : "failed",
      error: !valid
        ? "正文已经变化，这份小剧场已过期，请重新生成。"
        : validationError,
    };
    await db.theaters.put(next);
    await publishSummary(next);
    return next.status === "complete";
  });
}

export async function failTheaterAttempt(
  recordId: string,
  error: unknown,
  status: "failed" | "interrupted" = "failed",
) {
  await db.transaction("rw", tables, async () => {
    const record = await db.theaters.get(recordId);
    if (!record || record.status !== "running") return;
    const next: TheaterRecord = {
      ...record,
      status,
      error: error instanceof Error ? error.message : String(error),
      updated: Date.now(),
    };
    await db.theaters.put(next);
    await publishSummary(next);
  });
}

export async function rebindTheaterAttempt(
  recordId: string,
  finalEvent: SceneEvent,
): Promise<boolean> {
  return db.transaction("rw", tables, async () => {
    const record = await db.theaters.get(recordId);
    const current = await db.events.get(finalEvent.id);
    if (
      !record ||
      !current ||
      current.deleted ||
      current.storyId !== record.storyId ||
      current.versionId !== finalEvent.versionId ||
      current.text !== finalEvent.text ||
      !(await db.stories.get(record.storyId))
    )
      return false;
    if (
      current.theater &&
      current.theater.id !== recordId &&
      current.theater.sourceVersionId === current.versionId
    )
      return false;
    const changed =
      record.eventId !== current.id ||
      record.sourceVersionId !== current.versionId;
    const next: TheaterRecord = {
      ...record,
      eventId: current.id,
      sourceVersionId: current.versionId,
      updated: Date.now(),
      previousId: changed
        ? await previousSuccess(current.id, current.versionId)
        : record.previousId,
      ...(changed && record.status === "complete"
        ? {
            status: "failed" as const,
            error: "正文已被人工修改，请重新生成小剧场。",
          }
        : {}),
    };
    await db.theaters.put(next);
    await db.events.update(current.id, { theater: summary(next) });
    return true;
  });
}

type Outcome = "saved" | "stale" | "interrupted";
const active = new Map<
  string,
  { control: AbortController; work: Promise<Outcome> }
>();
export const pendingTheater = (eventId: string) => active.get(eventId)?.work;
export async function stopTheater(eventId: string) {
  const pending = active.get(eventId);
  if (pending) {
    pending.control.abort();
    return;
  }
  const event = await db.events.get(eventId);
  if (event?.theater?.status === "running")
    storyActive.get(event.storyId)?.abort();
}

export function generateTheater(eventId: string): Promise<Outcome> {
  const existing = active.get(eventId);
  if (existing) return existing.work;
  const control = new AbortController();
  const work = (async (): Promise<Outcome> => {
    const initial = await db.events.get(eventId);
    if (
      !initial ||
      initial.deleted ||
      initial.kind !== "novel" ||
      initial.status !== "complete"
    )
      throw Error("请先完成这段正文，再生成小剧场");
    return withStoryLock(initial.storyId, async () => {
      if (storyActive.has(initial.storyId))
        throw Error("这个故事正在生成，请先停止或等待完成");
      storyActive.set(initial.storyId, control);
      let attempt: TheaterRecord | undefined;
      let saving = Promise.resolve();
      let storageError: unknown;
      let raw = "",
        html = "",
        last = 0;
      try {
        const [story, event, world, prefs] = await Promise.all([
          db.stories.get(initial.storyId),
          db.events.get(eventId),
          db.world.toArray(),
          db.preferences.get("preferences"),
        ]);
        if (
          !story ||
          !event ||
          event.deleted ||
          event.versionId !== initial.versionId ||
          event.status !== "complete"
        )
          throw Error("正文已经变化，请重新打开小剧场");
        const profile = prefs && (await db.profiles.get(prefs.activeProfile));
        if (!prefs || !profile) throw Error("先到设置添加并选中一个模型接口");
        const key = keyFor(profile);
        if (!key.trim())
          throw Error("请先到设置填写 API Key，当前没有发送请求");
        const presets = selectedTheaterPresets(story, prefs);
        const context = buildTheaterContext(
          story,
          event,
          world,
          prefs,
          profile,
          presets,
        );
        if (control.signal.aborted) return "interrupted";
        attempt = await createTheaterAttempt(event, presets);
        if (control.signal.aborted) throw Error("已停止小剧场生成");
        const result = await generate(
          profile,
          key,
          context.system,
          context.user,
          control.signal,
          (value) => {
            raw = value;
            html = topLevelString(raw, "theaterHtml")?.value || "";
            if (Date.now() - last < 200) return;
            last = Date.now();
            const nextRaw = raw,
              nextHtml = html;
            saving = saving
              .then(() => updateTheaterAttempt(attempt!.id, nextRaw, nextHtml))
              .catch((error) => {
                storageError ??= error;
              });
          },
          fetch,
          { kind: "theater", stablePrefix: context.stablePrefix },
        );
        await saving;
        if (storageError) throw storageError;
        raw = result.text;
        html = topLevelString(raw, "theaterHtml")?.value || html;
        await updateTheaterAttempt(attempt.id, raw, html);
        if (control.signal.aborted) throw Error("已停止小剧场生成");
        if (!result.complete)
          throw Error("小剧场未完整结束 · " + result.reason);
        const parsed = parseJSON(raw);
        html = validateTheaterHtml(parsed?.theaterHtml);
        return await db.transaction(
          "rw",
          [...tables, db.world],
          async (): Promise<Outcome> => {
            const [latestStory, latestEvent, latestWorld] = await Promise.all([
              db.stories.get(story.id),
              db.events.get(eventId),
              db.world.toArray(),
            ]);
            if (
              !latestStory ||
              !latestEvent ||
              latestEvent.deleted ||
              latestEvent.versionId !== event.versionId ||
              buildTheaterContext(
                latestStory,
                latestEvent,
                latestWorld,
                prefs,
                profile,
                presets,
              ).user !== context.user
            ) {
              await failTheaterAttempt(
                attempt!.id,
                "人设、世界书或正文已变化，这份小剧场已过期，请重新生成。",
              );
              return "stale";
            }
            if (control.signal.aborted) {
              await failTheaterAttempt(
                attempt!.id,
                "已停止小剧场生成，收到的内容已保留。",
                "interrupted",
              );
              return "interrupted";
            }
            return (await finishTheaterAttempt(attempt!.id, event, html, raw))
              ? "saved"
              : "stale";
          },
        );
      } catch (error) {
        await saving;
        if (attempt) {
          await updateTheaterAttempt(attempt.id, raw, html);
          await failTheaterAttempt(
            attempt.id,
            control.signal.aborted
              ? "已停止小剧场生成，收到的内容已保留。"
              : error,
            control.signal.aborted ? "interrupted" : "failed",
          );
        }
        if (control.signal.aborted) return "interrupted";
        throw error;
      } finally {
        if (storyActive.get(initial.storyId) === control)
          storyActive.delete(initial.storyId);
      }
    });
  })();
  const task = {
    control,
    work: work.finally(() => {
      if (active.get(eventId) === task) active.delete(eventId);
    }),
  };
  active.set(eventId, task);
  return task.work;
}
