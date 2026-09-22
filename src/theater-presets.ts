import type {
  Preferences,
  Story,
  TheaterDensity,
  TheaterPreset,
} from "./types";

export const builtInTheaterPresets: TheaterPreset[] = [
  {
    id: "theater-roast",
    name: "主角们的吐槽",
    prompt:
      "请让本回合出场的主角围绕刚发生的事，说几句平时未必肯当面说的吐槽。抓住一句台词、一个动作或一次小尴尬，让笑点贴着人物性格与彼此关系。每个人按自己的口气说话，可以嘴硬、自嘲，也可以熟人拌嘴，吐槽到点上就收住。",
  },
  {
    id: "theater-details",
    name: "没被发现的细节",
    prompt:
      "请重看本回合场景，写下当时容易被忽略的两三个细节。可以是一瞬间收回的目光、被挪过的物件，或有人下意识的小动作。让细节贴合正文已有的线索，给读者多一点回味。无需处处埋伏笔，别凭空补出重大秘密，也不要提前揭晓后面的事。",
  },
  {
    id: "theater-subtext",
    name: "话外之音",
    prompt:
      "请挑出本回合几句有余味的对白，写写角色当时忍住没说的话，或那句话里藏着的试探与顾虑。把原话和内心想法自然放在一起，让读者能认出是谁在说、为什么这样说。遇到含义不明的地方留些余地，不替作者确定尚未写明的动机与关系。",
  },
  {
    id: "theater-audience",
    name: "来自第四面墙的观众",
    prompt:
      "请想象几位正在看本回合的观众，围绕眼前的台词和小动作聊几句。有人认真分析，有人忍不住接梗，发言有来有回，别把每个人写成同一种口气。笑点从这段戏里找，不必硬塞流行语。观众可以猜错，也可以各执一词，不掌握后续剧情或未公开的秘密。",
  },
  {
    id: "theater-body",
    name: "角色的身体变化",
    prompt:
      "请留意本回合出场角色的身体反应，结合刚发生的动作与处境，写出呼吸、肌肉松紧、疲惫或其他细微感受。描写适用于角色实际的身体设定，不预设性别与亲密关系。变化有依据才写，不为凑内容添加伤病、身体改造或永久变化，也别强行往暧昧上解释。",
  },
];

export function allTheaterPresets(prefs: Preferences): TheaterPreset[] {
  const merged = new Map(
    builtInTheaterPresets.map((preset) => [preset.id, preset]),
  );
  for (const preset of prefs.theaterPresets || [])
    merged.set(preset.id, preset);
  return [...merged.values()];
}

export function selectedTheaterPresets(story: Story, prefs: Preferences) {
  const available = new Map(
    allTheaterPresets(prefs).map((preset) => [preset.id, preset]),
  );
  return [...new Set(story.theaterPresetIds ?? ["theater-roast"])].flatMap(
    (id) => {
      const preset = available.get(id);
      return preset && preset.name.trim() && preset.prompt.trim()
        ? [{ ...preset }]
        : [];
    },
  );
}

export const theaterWriting =
  "围绕提供的人物设定、世界书与本回合正文写一则短番外，保持人物口气和当时处境。每个已选方向都先从目标正文里找一件可核对的动作、台词或物件作为具体落点，再写至少一处动作或声音的变化，以及一处关系位置、信息理解或情绪的细微偏移。变化只能来自本段材料与直接可见的反应，素材不足时停在原地。标准密度写两至三个互相承接的小节，丰富密度可以拆成多个短层次，轻量密度尽快收束。选择多个方向时各写一节，避免重复正文、同义改写、连续感叹和空泛总结。用自然白话，让动作和台词承载情绪，写到有趣的地方就收住。不要用破折号和提示性冒号，不用先立误解再推翻的句式，避开整齐排比和汇报腔。小剧场始终作为番外，不写成主线中已经发生的新事件。私密设定只能用于理解对应人物，不自动成为其他人物或观众的知识。";

export function theaterDensityInstruction(density: TheaterDensity | undefined) {
  switch (density || "standard") {
    case "light":
      return "【小剧场丰富度：轻量】只抓最有意思的一两个点。每个已选方向写一小段，先落到一个具体动作或台词，再给一个反应，尽快收束。少用分节和重复回应，优先保证读者一眼能看完。";
    case "rich":
      return "【小剧场丰富度：丰富】可以把已选方向展开成多个短小层次或小节。每层都从目标正文的具体落点出发，再写动作、对白和彼此回应如何带来一点关系位置、信息理解或情绪变化，但每一步都必须贴着目标正文，避免复述、空泛总结和凭空推进主线。";
    default:
      return "【小剧场丰富度：标准】适度展开已选方向，每节保留两三个具体细节或来回回应。先有场面落点，再有反应和一处小余波，写到有趣处自然收束。";
  }
}

export function normalizeTheaterDensity(value: unknown): TheaterDensity {
  return value === "light" || value === "rich" || value === "standard"
    ? value
    : "standard";
}

// Content instructions remain independent of the model's outer JSON protocol.
export function theaterInstruction(presets: TheaterPreset[]) {
  return [
    theaterWriting,
    ...presets.map(
      (preset) =>
        `【${preset.name}】\n${preset.prompt}\n本节写法要求\n先落到本回合一个具体动作、台词或物件，再按预设完成一轮反应或观察，最后停在本段可支持的余波上。不要把其他预设的内容换个说法重复一遍。`,
    ),
    "【小剧场展示格式】\n将小剧场写成一个自包含的 HTML 片段，可用内联样式和 style 标签自由设计卡片、纸条、对话气泡或评论区。多个预设按上面列出的顺序展示，各有清楚的小标题，整体适配窄屏，文字可换行。不输出脚本、事件处理属性、表单、iframe、外部资源、链接跳转或任何网络请求，不使用固定定位和无限动画。美化只改变展示，角色名字与正文内容须作为可阅读文字保留。HTML 字符串交给外层约定的 theaterHtml 字段，不使用 Markdown 围栏。",
  ].join("\n\n");
}
