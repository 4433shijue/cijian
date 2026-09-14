import { z } from "zod";
import { db, keyFor } from "./db";
import { assemble } from "./context";
import { generate } from "./model";
import { prompt } from "./prompts";
import { styleInstruction } from "./style-presets";
import { parseJSON } from "./output";
import {
  uid,
  type InspirationOption,
  type Material,
  type Preferences,
  type Profile,
  type SceneEvent,
  type Story,
  type WorldEntry,
} from "./types";

export const inspirationDirections = {
  relationship: "关系变化",
  discovery: "信息发现",
  external: "外部变化",
  decision: "主动选择",
} as const;
export function inspirationCount(value?: number) {
  return Number.isInteger(value) && value! >= 1 && value! <= 20 ? value! : 3;
}
export function recentProse(events: SceneEvent[], count: number) {
  return events
    .filter(
      (e) =>
        e.kind === "novel" &&
        e.status === "complete" &&
        !e.deleted &&
        !e.review,
    )
    .sort((a, b) => a.seq - b.seq)
    .slice(-inspirationCount(count));
}
const optionSchema = z.object({
  direction: z.enum(["relationship", "discovery", "external", "decision"]),
  title: z.string().trim().min(1).max(40),
  text: z.string().trim().min(1).max(400),
});
const normalized = (text: string) =>
  text.replace(/[\s\p{P}]/gu, "").toLowerCase();
export function parseInspiration(
  raw: string,
  previous: InspirationOption[] = [],
) {
  let options: InspirationOption[];
  try {
    const data = parseJSON(raw);
    options = z
      .object({ options: z.array(optionSchema).length(4) })
      .parse(data).options;
  } catch {
    throw Error("小助手没有给出完整的四个选项，请点「你再想想」重试。");
  }
  if (
    new Set(options.map((o) => o.direction)).size !== 4 ||
    new Set(options.map((o) => normalized(o.text))).size !== 4
  )
    throw Error("这四个方向有重复，请让小助手再想一轮。");
  if (
    options.some((o) =>
      previous.some((p) => normalized(p.text) === normalized(o.text)),
    )
  )
    throw Error("这一轮沿用了之前的建议，旧选项仍保留，可以再想一轮。");
  return options;
}
export function buildInspirationContext(
  story: Story,
  events: SceneEvent[],
  world: WorldEntry[],
  prefs: Preferences,
  profile: Profile,
) {
  const recent = recentProse(
    events,
    inspirationCount(prefs.inspirationParagraphs),
  );
  const materials: Material[] = [];
  const add = (id: string, label: string, text: string, stable = false) => {
    if (text)
      materials.push({ id, label, text, mandatory: true, priority: 0, stable });
  };
  const present = story.roles.map((r) => r.id);
  for (const entry of story.worldIds.flatMap((id) =>
    world.filter((w) => w.id === id),
  )) {
    if (
      !story.worldIds.includes(entry.id) ||
      !entry.enabled ||
      (entry.storyIds.length && !entry.storyIds.includes(story.id)) ||
      (entry.roleIds.length &&
        !(entry.match === "all"
          ? entry.roleIds.every((id) => present.includes(id))
          : entry.roleIds.some((id) => present.includes(id))))
    )
      continue;
    add(entry.id, "世界书 · " + entry.title, entry.text, true);
  }
  for (const role of story.roles)
    add(
      role.id,
      "当前故事人物 · " + role.name,
      [
        role.bio,
        role.persona || role.paragraphs.map((p) => p.text).join("\n\n"),
      ]
        .filter(Boolean)
        .join("\n\n"),
      true,
    );
  add("background", "故事开场背景", story.background, true);
  recent.forEach((event, i) =>
    add(event.id, `最近正文 ${i + 1} / 版本 ${event.versionId}`, event.text),
  );
  if (story.draft.trim())
    add("author-draft", "作者尚未扩写的想法", story.draft);
  if (story.inspiration)
    add(
      "previous-options",
      "上一轮建议 · 请换四条新路",
      JSON.stringify(story.inspiration.options),
    );
  const task = `依据所给的 ${recent.length} 段最近正文和人物、世界书，提出四种不同的后续事件。${styleInstruction(story, prefs, "novel")}。${recent.length ? "从最新一段停下的位置往前想。" : "故事还没有正式正文，可以从开场背景与人物处境中寻找开头。"}`;
  return {
    report: assemble(
      prompt("inspiration", prefs),
      task,
      materials,
      profile.context,
      profile.maxOutput,
    ),
    sources: recent.map((e) => ({ id: e.id, versionId: e.versionId })),
  };
}

const active = new Map<
  string,
  { revision: string; control: AbortController; work: Promise<void> }
>();
export function chooseInspiration(
  storyId: string,
  text: string,
  input: string,
) {
  return db.transaction("rw", db.stories, async () => {
    const story = await db.stories.get(storyId);
    const round = story?.inspiration;
    if (!round?.options.some((option) => option.text === text))
      throw Error("这轮灵感已更新，请重新打开窗口再选。");
    const previous = round.selectedText;
    const ownText =
      previous && input.endsWith(previous)
        ? input.slice(0, -previous.length).trimEnd()
        : input;
    const draft = ownText.trim() ? ownText + "\n\n" + text : text;
    await db.stories.update(storyId, {
      draft,
      inspiration: { ...round, selectedText: text },
    });
    return draft;
  });
}
export async function requestInspiration(storyId: string): Promise<void> {
  const story = await db.stories.get(storyId);
  if (!story) throw Error("故事已不存在");
  const revision = story.inspirationRevision || "";
  const existing = active.get(storyId);
  if (existing?.revision === revision) return existing.work;
  existing?.control.abort();
  const control = new AbortController();
  const requestId = uid();
  const work = (async () => {
    const prefs = await db.preferences.get("preferences");
    const profile = prefs && (await db.profiles.get(prefs.activeProfile));
    if (!prefs || !profile)
      throw Error("先到设置添加并选中一个模型接口，再来找灵感。");
    const { report, sources } = buildInspirationContext(
      story,
      await db.events.where("storyId").equals(storyId).toArray(),
      await db.world.toArray(),
      prefs,
      profile,
    );
    const ready = await db.transaction("rw", db.stories, async () => {
      const latest = await db.stories.get(storyId);
      if (
        !latest ||
        (latest.inspirationRevision || "") !== revision ||
        control.signal.aborted
      )
        return false;
      await db.stories.update(storyId, { inspirationRequest: requestId });
      return true;
    });
    if (!ready) return;
    const result = await generate(
      profile,
      keyFor(profile),
      report.system,
      report.user,
      control.signal,
      undefined,
      fetch,
      { kind: "inspiration", stablePrefix: report.stablePrefix },
    );
    if (control.signal.aborted) return;
    if (!result.complete)
      throw Error("这一轮灵感还没完整生成，请点「你再想想」重试。");
    const options = parseInspiration(result.text, story.inspiration?.options);
    await db.transaction("rw", db.stories, async () => {
      const latest = await db.stories.get(storyId);
      if (
        !latest ||
        latest.inspirationRequest !== requestId ||
        (latest.inspirationRevision || "") !== revision ||
        control.signal.aborted
      )
        return;
      await db.stories.update(storyId, {
        inspiration: {
          options,
          sources,
          created: Date.now(),
          selectedText: latest.inspiration?.selectedText,
        },
        inspirationRequest: undefined,
      });
    });
  })();
  const task = { revision, control, work };
  active.set(storyId, task);
  try {
    await work;
  } finally {
    if (active.get(storyId) === task) active.delete(storyId);
  }
}
