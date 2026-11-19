import {
  guidedInterviewSchema,
  type GeneratorInput,
  type GeneratorInterview,
  type GeneratorTurn,
} from "./generator-types";

export function currentQuestions(turns: GeneratorTurn[]) {
  return (
    [...turns].reverse().find((t) => !t.settingChange && !t.draftUpdate)
      ?.interview?.questions || []
  );
}

export function confirmedSettings(turns: GeneratorTurn[]) {
  let items = [
    ...([...turns].reverse().find((t) => t.interview)?.interview?.confirmed ||
      []),
  ];
  for (const turn of turns) {
    if (!turn.settingChange) continue;
    const { from, to } = turn.settingChange;
    const at = items.indexOf(from);
    items = items.filter((x) => x !== from && x !== to);
    if (to) items.splice(at < 0 ? items.length : at, 0, to);
  }
  return [...new Set(items)];
}

const normalize = (s: string) =>
  s
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\p{P}\p{Z}\s]/gu, "");
function similarity(a: string, b: string) {
  const grams = (s: string) =>
    new Set(
      Array.from({ length: Math.max(0, s.length - 1) }, (_, i) =>
        s.slice(i, i + 2),
      ),
    );
  const aa = grams(a),
    bb = grams(b);
  return aa.size + bb.size
    ? (2 * [...aa].filter((x) => bb.has(x)).length) / (aa.size + bb.size)
    : 0;
}

export function validateGuidedInterview(
  value: GeneratorInterview,
  input: GeneratorInput,
) {
  if (input.experience !== "guided") return;
  if (!guidedInterviewSchema.safeParse(value).success)
    throw Error(
      "这一轮需要四个不同方向的选项，回复不完整。原始回复已保留，可以重试或手动修复。",
    );
  if (input.pace !== "quick" && value.questions.length > 1)
    throw Error("慢慢聊模式每轮只问一个问题，原始回复已保留。");
  for (const q of value.questions) {
    if (q.multiple)
      throw Error("这一轮应为四选一；组合想法可以直接输入。原始回复已保留。");
    const directions = q.options.map((o) => normalize(o.direction || ""));
    const texts = q.options.map((o) => normalize(o.text));
    if (
      new Set(directions).size !== 4 ||
      directions.some((x) => !x) ||
      texts.some((a, i) =>
        texts.slice(i + 1).some((b) => a === b || similarity(a, b) > 0.82),
      )
    )
      throw Error(
        "四个选项的方向重复或文案过于相似，原始回复已保留，请换一组真正不同的方向。",
      );
  }
}

export const guidedRules = `陪作者捏角色。每道题必须给恰好四个完全不同的创作方向，multiple=false，每项带简短 direction 和具体 text。四项应改变人物的核心动机、价值选择、经历根源、生活道路或关系模式，不能只是同一种性格的四种说法、程度强弱或相近举动。先自行比较四项的核心命题，有重合就重写；仍须遵守作者已确认的共同前提，不为不同而推翻设定。第五项“我自己写”由界面提供，不要生成第五个选项。
pace=gentle 每轮只问一个关键问题；pace=quick 每轮问二至三个相关问题，只剩一个时可只问一个。读完整段自由输入，选择加补充以作者补充为准。作者要求换选项时保留当前问题和已确认事实，给新的四个方向，未选择的候选不是真实设定，不据此成稿。
creationKind=solo 先建立人物自己的生活和欲望；partner 围绕选定的关系参考人物，探索吸引点、分歧、边界和相处方式，只生成新搭档；pair 先确认共同背景与关系，再分别细化两个人，输出两张独立卡。roleKind 只代表作者指定的角色定位，攻受、男女主不决定性格、强弱和感情主动权。autoName=true 的称呼只是暂称，可在访谈确认名字，未确认时成稿可拟名；ID 始终不变。
confirmed 是当前完整的已确认设定，包含作者明确说出的不喜欢与不要的设定。confirmedSettings 和 history 中 settingChange 是作者手动修正，优先于此前回答和旧结果；不能恢复被删改的旧设定。少重复已知问题，有明确身份方向、欲望、主要关系和行为特点后可以成稿，作者也能随时提前成稿。`;
