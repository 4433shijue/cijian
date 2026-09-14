import type { Preferences, Story, StylePreset } from "./types";

export const builtInStylePresets: readonly StylePreset[] = [
  {
    id: "builtin-natural",
    name: "自然白描",
    description: "把动作、声音和停顿写清楚，语气随着关系自然变化。",
    prompt:
      "以具体动作、声音和触感为主，句子长短随现场变化。动作已经传达的情绪不再重复解释，少用空泛比喻和整齐排比。",
    scope: "both",
    builtIn: true,
  },
  {
    id: "builtin-delicate",
    name: "清新细腻",
    description: "保留轻盈的感官细节，让情绪从日常物件里慢慢显出来。",
    prompt:
      "加入克制而准确的光线、气味、颜色和触感细节。保持轻盈，不把普通时刻写成宏大的抒情段落。",
    scope: "both",
    builtIn: true,
  },
  {
    id: "builtin-restraint",
    name: "克制留白",
    description: "少解释，多让人物的动作和对话留下余地。",
    prompt:
      "减少情绪解释和心理结论，优先写人物做了什么、没有做什么以及对话中的停顿。让读者从细节自行感受到关系变化。",
    scope: "both",
    builtIn: true,
  },
  {
    id: "builtin-daily",
    name: "轻松日常",
    description: "用自然的口语和小事推进关系，保留生活里的松弛感。",
    prompt:
      "使用自然口语和具体小事，允许轻微的打趣与停顿。避免每一次互动都上升为告白、冲突或人生感悟。",
    scope: "both",
    builtIn: true,
  },
  {
    id: "builtin-suspense",
    name: "悬疑紧绷",
    description: "让信息分配、观察和迟疑承担压力，节奏保持收紧。",
    prompt:
      "突出可观察的异常、信息缺口和人物的试探。短句与停顿可以增加紧张感，但不要凭空添加秘密揭露或危险升级。",
    scope: "both",
    builtIn: true,
  },
  {
    id: "builtin-classical",
    name: "古典雅致",
    description: "语句稍有古意，仍然保持清楚、克制和可读。",
    prompt:
      "使用含蓄、洁净、略带古意的词语和节奏，避免生僻典故堆砌。人物说话仍要符合自己的身份与时代。",
    scope: "both",
    builtIn: true,
  },
];

export function allStylePresets(prefs?: Preferences) {
  const custom = (prefs?.stylePresets || []).filter(
    (preset) =>
      !builtInStylePresets.some((builtIn) => builtIn.id === preset.id),
  );
  return [...builtInStylePresets, ...custom];
}

export function resolveStylePreset(story: Story, prefs?: Preferences) {
  const presets = allStylePresets(prefs);
  return (
    (story.stylePresetId &&
      presets.find((preset) => preset.id === story.stylePresetId)) ||
    presets.find((preset) => preset.name === story.style) ||
    undefined
  );
}

export function styleInstruction(
  story: Story,
  prefs: Preferences,
  kind: "novel" | "chat",
) {
  const preset = resolveStylePreset(story, prefs);
  if (!preset) return `文风：${story.style || "自然白描"}`;
  if (preset.scope !== "both" && preset.scope !== kind)
    return `文风：${story.style || preset.name}`;
  return `文风预设：${preset.name}\n${preset.prompt}`;
}
