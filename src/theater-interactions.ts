import { db, keyFor } from "./db";
import { active as storyActive } from "./generation-state";
import { withStoryLock } from "./locks";
import { generate } from "./model";
import { parseJSON } from "./output";
import { buildTheaterContext } from "./theater";
import { normalizeTheaterData, structuredTheaterHtml, structuredTheaterText, theaterOutputSchema } from "./theater-data";
import { uid, type TheaterData, type TheaterItem, type TheaterRecord, type SceneEvent } from "./types";

const active = new Map<string, { control: AbortController; work: Promise<void> }>();
const cancellations = typeof window !== "undefined" && typeof BroadcastChannel !== "undefined"
  ? new BroadcastChannel("cijian-theater-cancellations") : undefined;
cancellations?.addEventListener("message", (event) => {
  if (typeof event.data === "string") active.get(event.data)?.control.abort();
});
const tables = [db.theaters, db.events, db.stories, db.jobs];
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

function currentSource(record: TheaterRecord, event: SceneEvent | undefined) {
  if (!event || event.deleted || event.status !== "complete" || event.kind !== "novel" ||
      event.storyId !== record.storyId || event.versionId !== record.sourceVersionId ||
      event.theater?.id !== record.id || record.status !== "complete" || !record.data)
    throw Error("这份小剧场对应的正文已经变化，请先按当前正文重新生成。");
}

export async function saveTheaterReading(recordId: string, patch: Partial<{ clarity: boolean; fontSize: number }>) {
  await db.transaction("rw", db.theaters, async () => {
    const record = await db.theaters.get(recordId);
    if (!record) return;
    const reading = { clarity: true, fontSize: 16, ...record.reading, ...patch };
    reading.fontSize = Number.isFinite(reading.fontSize) ? Math.max(16, Math.min(24, Math.round(reading.fontSize))) : 16;
    await db.theaters.update(record.id, { reading });
  });
}

export async function saveTheaterReplyDraft(recordId: string, sectionId: string, input: string) {
  await db.transaction("rw", db.theaters, async () => {
    const record = await db.theaters.get(recordId);
    if (!record?.data?.sections.some((section) => section.id === sectionId)) return;
    await db.theaters.update(record.id, { replyDrafts: { ...record.replyDrafts, [sectionId]: input } });
  });
}

export async function toggleTheaterReaction(recordId: string, sectionId: string, itemId: string, kind: "likes" | "bookmarks") {
  await db.transaction("rw", db.theaters, async () => {
    const record = await db.theaters.get(recordId);
    const section = record?.data?.sections.find((section) => section.id === sectionId);
    if (!record || !section?.items.some((item) => item.id === itemId)) return;
    const key = sectionId + "/" + itemId;
    const values = record[kind] || [];
    const next = values.includes(key) ? values.filter((value) => value !== key) : [...values, key];
    await db.theaters.update(record.id, kind === "likes" ? { likes: next } : { bookmarks: next });
  });
}

export function stopTheaterInteraction(recordId: string) {
  active.get(recordId)?.control.abort();
  cancellations?.postMessage(recordId);
}

/** Append validated new items; existing text and ids are never rewritten by a reply. */
export function mergeTheaterAddition(record: TheaterRecord, sectionId: string, value: unknown): TheaterData {
  const data = record.data!;
  const section = data.sections.find((section) => section.id === sectionId);
  const incoming = value as { version?: number; sections?: { id?: string; items?: TheaterItem[] }[] };
  if (!section || incoming?.version !== 1 || !Array.isArray(incoming.sections) || incoming.sections.length !== 1 ||
      incoming.sections[0]?.id !== sectionId || !Array.isArray(incoming.sections[0].items) || !incoming.sections[0].items.length)
    throw Error("没有收到这个栏目的完整补充，原内容已保留。");
  const additions = incoming.sections[0].items;
  const seen = new Set(section.items.map((item) => item.id));
  const remap = new Map<string, string>();
  for (const item of additions) {
    if (!item || typeof item.id !== "string" || !item.id.trim() || seen.has(item.id))
      throw Error("补充内容包含重复楼层或条目，原内容已保留。");
    seen.add(item.id);
    remap.set(item.id, uid());
  }
  const next = {
    ...data,
    sections: data.sections.map((current) => current.id !== sectionId ? current : {
      ...current,
      items: [...current.items, ...additions.map((item) => ({
        ...item, id: remap.get(item.id)!, replyTo: remap.get(item.replyTo) || item.replyTo, origin: "ai" as const,
      }))],
    }),
  };
  return normalizeTheaterData(next, record.presets, { preserveOrigins: true });
}

export function interactWithTheater(recordId: string, sectionId: string, kind: "reply" | "expand", input: string, itemId?: string): Promise<void> {
  const pending = active.get(recordId);
  if (pending) return pending.work;
  const control = new AbortController();
  const work = (async () => {
    const initial = await db.theaters.get(recordId);
    if (!initial) throw Error("小剧场已不存在。");
    await withStoryLock(initial.storyId, async () => {
      if (storyActive.has(initial.storyId)) throw Error("这本故事正在生成，请等待完成或先停止。");
      storyActive.set(initial.storyId, control);
      let interactionId = "";
      let raw = "";
      let writes = Promise.resolve();
      let writeError: unknown;
      try {
        const [record, event, story, prefs, world] = await Promise.all([
          db.theaters.get(recordId), db.events.get(initial.eventId), db.stories.get(initial.storyId),
          db.preferences.get("preferences"), db.world.toArray(),
        ]);
        if (!record || !story || !prefs) throw Error("小剧场或故事已不存在。");
        currentSource(record, event);
        if (record.interaction?.status === "running") throw Error("这个小剧场正在补充，请先停止或等待完成。");
        const section = record.data!.sections.find((section) => section.id === sectionId);
        const preset = record.presets.find((preset) => preset.id === sectionId);
        if (!section || !preset || section.presentation === "custom") throw Error("请为可交互栏目选择补充位置。");
        if (kind === "reply" && section.presentation !== "forum") throw Error("回帖只能发送到观众论坛。");
        if (itemId && !section.items.some((item) => item.id === itemId)) throw Error("要补充的条目已经变化。");
        const text = input.trim();
        if (kind === "reply" && !text) throw Error("先写一句想说的话。");
        const profile = await db.profiles.get(prefs.activeProfile);
        if (!profile) throw Error("先到设置选中一个模型接口。");
        const key = keyFor(profile);
        if (!key.trim()) throw Error("请先到设置填写 API Key，当前没有发送请求。");
        interactionId = uid();
        // Retrying a failed reply reuses its already saved user floor.
        const previous = record.interaction;
        const retryId = previous && previous.status !== "complete" && previous.kind === kind &&
          previous.sectionId === sectionId && previous.itemId === itemId && previous.input === text &&
          section.items.some((item) => item.id === previous.userItemId && item.origin === "user") ? previous.userItemId : undefined;
        const userItemId = kind === "reply" ? retryId || uid() : undefined;
        const userItem: TheaterItem | undefined = userItemId && !retryId ? {
          id: userItemId, author: "我", badge: "观众", title: "", text, quote: "", certainty: "fiction",
          replyTo: itemId || "", group: "", status: "", fields: [], origin: "user",
        } : undefined;
        const nextSection = { ...section, items: userItem ? [...section.items, userItem] : section.items };
        const nextData = normalizeTheaterData({ ...record.data!, sections: record.data!.sections.map((item) => item.id === sectionId ? nextSection : item) }, record.presets, { preserveOrigins: true });
        const material = JSON.stringify({ section: nextSection, selectedItemId: itemId || "", userItemId: userItemId || "", request: text });
        const instruction = [
          "这是作者主动请求的一次小剧场追加。只补充指定栏目，不重新生成已保存的楼层或条目。",
          `只返回 JSON 对象 {\"theater\":{\"version\":1,\"sections\":[一份 id 为 ${JSON.stringify(sectionId)} 的栏目]}}。items 只写新增项，id 不能与已有项重复，replyTo 可以指向当前栏目的已有项或本次更早的新项。不得返回正文或 facts。`,
          kind === "reply" ? `回应观众留言 ${JSON.stringify(userItemId)}，新增两至四条有不同口气的回复。用户留言属于观众评论，不自动成为故事事实，观众猜测可以被质疑。` :
            "围绕选中的条目或栏目补充两至四个不同细节、角色回应或另一种理解。保持本回合时点和人物设定，不延续下一段剧情。",
          "已有条目里的 origin、赞、收藏等由应用管理，不输出也不修改。引用必须逐字来自本回合正文；不能确定时保留留白。不写跨回合对比。",
        ].join("\n");
        const context = buildTheaterContext(story, event!, world, prefs, profile, [preset], { instruction, material });
        if (control.signal.aborted) return;
        const revision = (record.revision || 0) + 1;
        await db.transaction("rw", tables, async () => {
          const latest = await db.theaters.get(recordId);
          const source = await db.events.get(initial.eventId);
          if (!latest || !(await db.stories.get(story.id))) throw Error("故事已删除，未发送请求。");
          currentSource(latest, source);
          if ((latest.revision || 0) !== (record.revision || 0) || latest.interaction?.status === "running") throw Error("小剧场已更新，请重新选择。");
          await db.theaters.update(recordId, {
            data: nextData, text: structuredTheaterText(nextData), html: structuredTheaterHtml(nextData), revision,
            interaction: { id: interactionId, sectionId, itemId, userItemId, kind, input: text, status: "running", raw: "", error: "", created: Date.now(), updated: Date.now() },
          });
          await db.jobs.add({ id: interactionId, storyId: story.id, eventId: event!.id, inputVersion: event!.versionId, kind: "theater", status: "running", created: Date.now(), error: "" });
        });
        let last = 0;
        const result = await generate(profile, key, context.system, context.user, control.signal, (value) => {
          raw = value;
          if (Date.now() - last < 200) return;
          last = Date.now();
          const snapshot = value;
          writes = writes.then(() => db.transaction("rw", db.theaters, async () => {
            const latest = await db.theaters.get(recordId);
            if (latest?.interaction?.id === interactionId && latest.interaction.status === "running")
              await db.theaters.update(recordId, { interaction: { ...latest.interaction, raw: snapshot, updated: Date.now() } });
          })).catch((error) => { writeError ??= error; });
        }, fetch, { kind: "theater", stablePrefix: context.stablePrefix, schema: {
          type: "object", properties: { theater: theaterOutputSchema }, required: ["theater"], additionalProperties: false,
        } });
        await writes;
        raw = result.text;
        if (writeError) throw writeError;
        if (control.signal.aborted) throw Error("已停止补充，原内容和留言已保留。");
        if (!result.complete) throw Error("这次补充未完整结束，原内容已保留。" + result.reason);
        const parsed = parseJSON(raw);
        const data = mergeTheaterAddition({ ...record, data: nextData }, sectionId, parsed.theater);
        await db.transaction("rw", [...tables, db.world], async () => {
          const latest = await db.theaters.get(recordId);
          const source = await db.events.get(initial.eventId);
          const currentStory = await db.stories.get(story.id);
          const currentWorld = await db.world.toArray();
          if (!latest || !currentStory || !source) throw Error("故事已删除，未写入补充。");
          currentSource(latest, source);
          if (control.signal.aborted || latest.interaction?.id !== interactionId || latest.interaction.status !== "running" || latest.revision !== revision)
            throw Error("这次补充已停止或过期，原内容已保留。");
          if (buildTheaterContext(currentStory, source, currentWorld, prefs, profile, [preset], { instruction, material }).user !== context.user)
            throw Error("正文、人设或世界书已变化，这次补充没有写入。");
          await db.theaters.update(recordId, {
            data, html: structuredTheaterHtml(data), text: structuredTheaterText(data), revision: revision + 1, updated: Date.now(),
            replyDrafts: kind === "reply" && latest.replyDrafts?.[sectionId]?.trim() === text ? { ...latest.replyDrafts, [sectionId]: "" } : latest.replyDrafts,
            interaction: { ...latest.interaction!, status: "complete", raw, error: "", updated: Date.now() },
          });
          await db.jobs.update(interactionId, { status: "complete", error: "" });
          if (control.signal.aborted) throw Error("已停止补充，原内容和留言已保留。");
        });
      } catch (error) {
        await writes;
        const status = control.signal.aborted ? "interrupted" : "failed";
        const errorMessage = control.signal.aborted ? "已停止补充，原内容和留言已保留。" : errorText(error);
        if (interactionId) await db.transaction("rw", [db.theaters, db.jobs], async () => {
          const latest = await db.theaters.get(recordId);
          if (latest?.interaction?.id === interactionId && latest.interaction.status === "running")
            await db.theaters.update(recordId, { interaction: { ...latest.interaction, status, raw, error: errorMessage, updated: Date.now() } });
          await db.jobs.update(interactionId, { status, error: errorMessage });
        });
        if (!control.signal.aborted) throw error;
      } finally {
        if (storyActive.get(initial.storyId) === control) storyActive.delete(initial.storyId);
      }
    });
  })();
  const task = { control, work: work.finally(() => { if (active.get(recordId) === task) active.delete(recordId); }) };
  active.set(recordId, task);
  return task.work;
}
