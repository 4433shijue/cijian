import { z } from "zod";
import { db, keyFor } from "./db";
import { generate } from "./model";
import { parseJSON } from "./output";
import {
  buildInspirationContext,
  inspirationSourceText,
  type InspirationInputs,
} from "./inspiration-context";
import { uid, type InspirationOption } from "./types";
export {
  buildInspirationContext,
  inspirationCount,
  recentProse,
} from "./inspiration-context";

const optionSchema = z.object({
  title: z.string().trim().min(1).max(40),
  text: z.string().trim().min(1).max(400),
});
export function parseInspiration(raw: string): InspirationOption[] {
  try {
    // JSON validates the cards' shape only. No category quotas or semantic veto.
    return z
      .object({ options: z.array(optionSchema).length(4) })
      .parse(parseJSON(raw)).options;
  } catch {
    throw Error("小助手没有给出完整的四个选项，请点「你再想想」重试。");
  }
}

const sourceTables = [
  db.stories,
  db.events,
  db.memories,
  db.world,
  db.preferences,
];
async function readInputs(
  storyId: string,
): Promise<InspirationInputs | undefined> {
  return db.transaction("r", sourceTables, async () => {
    const [story, events, memories, world, prefs] = await Promise.all([
      db.stories.get(storyId),
      db.events.where("storyId").equals(storyId).toArray(),
      db.memories.where("storyId").equals(storyId).toArray(),
      db.world.toArray(),
      db.preferences.get("preferences"),
    ]);
    return story
      ? {
          story,
          events,
          memories,
          world,
          prefs: prefs || {
            id: "preferences",
            activeProfile: "",
            developer: false,
            prompts: {},
          },
        }
      : undefined;
  });
}
async function contextKey(source: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(source),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
export async function inspirationState(storyId: string) {
  const inputs = await readInputs(storyId);
  if (!inputs) return undefined;
  const key = await contextKey(inspirationSourceText(inputs));
  const round = inputs.story.inspiration;
  return { round, stale: !!round && round.contextKey !== key };
}

type Outcome = "saved" | "stale";
const active = new Map<
  string,
  {
    key: string;
    feedback: string;
    control: AbortController;
    work: Promise<Outcome>;
  }
>();
export const pendingInspiration = (storyId: string) =>
  active.get(storyId)?.work;

export async function chooseInspiration(
  storyId: string,
  text: string,
  input: string,
) {
  const initial = await readInputs(storyId);
  if (!initial) throw Error("故事已不存在");
  const source = inspirationSourceText(initial);
  const key = await contextKey(source);
  return db.transaction("rw", sourceTables, async () => {
    const latest = await readInputs(storyId);
    const round = latest?.story.inspiration;
    if (!round?.options.some((option) => option.text === text))
      throw Error("这轮灵感已更新，请重新打开窗口再选。");
    if (
      !latest ||
      inspirationSourceText(latest) !== source ||
      round.contextKey !== key
    )
      throw Error("前文、人设或参考内容已经变化，请让小助手重新想一轮。");
    if (input !== latest.story.draft)
      throw Error("输入内容刚刚发生变化，请稍后重新选择。");
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

export async function requestInspiration(
  storyId: string,
  feedback = "",
): Promise<Outcome> {
  const inputs = await readInputs(storyId);
  if (!inputs) throw Error("故事已不存在");
  const { story, events, memories, world, prefs } = inputs;
  const source = inspirationSourceText(inputs);
  const key = await contextKey(source);
  feedback = feedback.trim();
  const existing = active.get(storyId);
  if (existing?.key === key && existing.feedback === feedback)
    return existing.work;
  existing?.control.abort();
  const control = new AbortController();
  const requestId = uid();
  const work = (async (): Promise<Outcome> => {
    const profile = await db.profiles.get(prefs.activeProfile);
    if (!profile) throw Error("先到设置添加并选中一个模型接口，再来找灵感。");
    const { report, sources } = buildInspirationContext(
      story,
      events,
      world,
      prefs,
      profile,
      memories,
      feedback,
    );
    const ready = await db.transaction("rw", sourceTables, async () => {
      const latest = await readInputs(storyId);
      if (
        !latest ||
        inspirationSourceText(latest) !== source ||
        control.signal.aborted
      )
        return false;
      await db.stories.update(storyId, { inspirationRequest: requestId });
      return true;
    });
    if (!ready) return "stale";
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
    if (control.signal.aborted) return "stale";
    if (!result.complete)
      throw Error("这一轮灵感还没完整生成，请点「你再想想」重试。");
    const options = parseInspiration(result.text);
    return db.transaction("rw", sourceTables, async () => {
      const latest = await readInputs(storyId);
      if (
        !latest ||
        latest.story.inspirationRequest !== requestId ||
        inspirationSourceText(latest) !== source ||
        control.signal.aborted
      )
        return "stale";
      await db.stories.update(storyId, {
        inspiration: {
          options,
          sources,
          contextKey: key,
          feedback,
          created: Date.now(),
          selectedText: latest.story.inspiration?.selectedText,
        },
        inspirationRequest: undefined,
      });
      return "saved";
    });
  })();
  const task = { key, feedback, control, work };
  active.set(storyId, task);
  try {
    return await work;
  } finally {
    if (active.get(storyId) === task) active.delete(storyId);
    await db.transaction("rw", db.stories, async () => {
      const latest = await db.stories.get(storyId);
      if (latest?.inspirationRequest === requestId)
        await db.stories.update(storyId, { inspirationRequest: undefined });
    });
  }
}
