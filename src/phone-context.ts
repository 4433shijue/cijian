import { db, worldForStory } from "./db";
import { requireStory } from "./story-service";
import { styleInstruction } from "./style-presets";
import type { Preferences } from "./types";

/** Phone generation has no query path to prose, prose memories or another work. */
export async function phoneContext(
  storyId: string,
  speaker: string,
  audience: string[],
  input: string,
  prefs: Preferences,
  before = Infinity,
) {
  const story = await requireStory(storyId, "phone");
  const own = story.roles.find((r) => r.id === speaker);
  if (!own) throw Error("角色不存在");
  const world = (await worldForStory(story)).filter(
    (w) =>
      w.enabled &&
      (!w.roleIds.length ||
        (w.match === "all"
          ? w.roleIds.every((id) => audience.includes(id))
          : w.roleIds.some((id) => audience.includes(id)))) &&
      (w.audience === "all" ||
        (w.audience === "roles" && w.knownBy.includes(speaker))) &&
      (w.always || w.keywords.some((k) => k.trim() && input.includes(k))),
  );
  const backgrounds = (
    await db.phoneBackgrounds.where("storyId").equals(storyId).toArray()
  ).filter(
    (b) =>
      b.enabled &&
      b.audience.includes(speaker) &&
      (Number.isFinite(before) ? !!b.source && b.source.seq < before : true),
  );
  const docs = (
    await db.phoneDocuments.where("storyId").equals(storyId).toArray()
  ).filter(
    (d) =>
      !Number.isFinite(before) && !d.deleted && d.audience.includes(speaker),
  );
  const others = story.roles
    .filter((r) => r.id !== speaker && audience.includes(r.id))
    .map((r) => ({
      name: r.name,
      bio: r.bio,
      publicPersona: r.paragraphs.filter((p) => p.public).map((p) => p.text),
    }));
  return (
    `你现在仅扮演 ${own.name}。这是独立的手机作品，没有需要追踪或同步的小说主线。\n` +
    `【你的设定】\n${own.bio}\n${own.paragraphs.length ? own.paragraphs.map((p) => p.text).join("\n") : own.persona}\n` +
    `【其他角色公开资料】${JSON.stringify(others)}\n` +
    world.map((w) => `【世界书 · ${w.title}】\n${w.text}`).join("\n\n") +
    "\n" +
    backgrounds
      .map((b) => `【你已知的背景 · ${b.title}】\n${b.text}`)
      .join("\n\n") +
    "\n" +
    docs
      .map(
        (d) =>
          `【你可知的${d.kind === "note" ? "备忘录" : d.kind === "photo" ? "照片说明" : "未发送草稿"} · ${d.title} · ${d.time}】\n${d.text}`,
      )
      .join("\n\n") +
    `\n【措辞要求】${styleInstruction(story, prefs, "chat")}\n最近明确的手机经历优先于较早背景。资料中没有写出的秘密不能自行推断。读者的阅读或解锁不代表角色获得知识。`
  );
}
