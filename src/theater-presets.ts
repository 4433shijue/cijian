import type {
  Preferences,
  Story,
  TheaterDensity,
  TheaterPresentation,
  TheaterPreset,
} from "./types";

export const builtInTheaterPresets: TheaterPreset[] = [
  {
    id: "theater-roast",
    name: "主角们的吐槽",
    presentation: "dialogue",
    prompt:
      "请让本回合出场的主角围绕刚发生的事说几句平时未必肯当面说的吐槽。抓住正文里一句台词、一个动作或一次小尴尬，让笑点贴着人物性格与彼此关系。每个人按自己的口气说话，可以嘴硬、自嘲，也可以熟人拌嘴；吐槽到点就收住，不把正文重新讲一遍。",
  },
  {
    id: "theater-details",
    name: "没被发现的细节",
    presentation: "detail-list",
    prompt:
      "请重看本回合场景，列出当时容易被忽略的两三个细节。可以是一瞬间收回的目光、被挪过的物件，或有人下意识的小动作。每条先指出正文里看得见的落点，再写它给当下场面带来的轻微余味。让细节贴合已有线索，不强行埋伏笔，不凭空补出重大秘密，也不提前揭晓后面的事。",
  },
  {
    id: "theater-subtext",
    name: "话外之音",
    presentation: "subtext-card",
    prompt:
      "请挑出本回合几句有余味的对白，分别写出原话、角色可能忍住没说的话，以及其中露出的试探或顾虑。让原话和话外之音清楚对应，读者能认出是谁在说、为什么会这样说。含义不明的地方保留两可，不把猜测写成确定动机，不替作者决定尚未写明的关系。",
  },
  {
    id: "theater-audience",
    name: "来自第四面墙的观众",
    presentation: "forum",
    prompt:
      "请把内容写成一个只讨论本回合的虚构观众论坛。先由楼主抓住正文里可核对的一句台词、一个动作、一个物件或一次停顿发帖，再让几位不同立场的观众以楼层和回复接话。楼里要有细节党、角色厨、吐槽党或谨慎推理者之类的不同声音，至少出现一次自然的补充、质疑或分歧；猜测必须标明不确定，允许观众猜错。所有人只能知道当前回合已经公开的内容，不得知道后续剧情、角色未说出口的秘密、其他回合或作者意图。每层一至三句，少复述正文，讨论到点自然收住，不写下一回预告。",
  },
  {
    id: "theater-body",
    name: "角色的身体变化",
    presentation: "body-status",
    prompt:
      "请把本回合出场角色的身体反应整理成状态卡，按角色和可观察部位写出变化。优先关注呼吸、眼睛、面部、喉咙、肩颈、手臂、手指、胸腹、腰背、腿脚等与当前动作有关的部位，只有正文或人物设定支持时才填写；没有依据的部位标为未提及，不要硬凑。每项说明当前状态、变化原因和短暂程度，不能添加伤病、身体改造、永久变化或暧昧关系，不预设性别。",
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

export function normalizeTheaterPresentation(
  value: unknown,
): TheaterPresentation {
  if (value === "body-card") return "body-status";
  if (value === "evidence") return "evidence-board";
  if (value === "relationship") return "relationship-card";
  if (value === "freeform") return "custom";
  return value === "dialogue" ||
    value === "detail-list" ||
    value === "subtext-card" ||
    value === "forum" ||
    value === "body-status" ||
    value === "evidence-board" ||
    value === "relationship-card" ||
    value === "scene-board" ||
    value === "custom"
    ? value
    : "custom";
}

export function presetPresentationLabel(
  presentation: TheaterPresentation | undefined,
): string {
  switch (normalizeTheaterPresentation(presentation)) {
    case "dialogue":
      return "对白吐槽";
    case "detail-list":
      return "细节清单";
    case "subtext-card":
      return "话外音卡";
    case "forum":
      return "论坛楼层";
    case "body-status":
      return "身体状态卡";
    case "evidence-board":
      return "证据板";
    case "relationship-card":
      return "关系卡";
    case "scene-board":
      return "场景声画";
    default:
      return "自定义展示";
  }
}

export function presentationInstruction(
  presentation: TheaterPresentation | undefined,
): string {
  switch (normalizeTheaterPresentation(presentation)) {
    case "dialogue":
      return "【展示结构：对白吐槽】根容器使用 data-theater-template=\"dialogue\"，用短对白或对话卡呈现。每句台词标明说话者，必要时配一小句动作提示，让人物口气和彼此接话清楚可见。不要把对白写成角色突然知道了未公开信息。";
    case "detail-list":
      return "【展示结构：细节清单】根容器使用 data-theater-template=\"detail-list\"，使用两至三个带小标题的观察条目。每条先写可从正文核对的细节，再写它给当前场面带来的轻微余味；不要把观察条目伪装成新的剧情事实。";
    case "subtext-card":
      return "【展示结构：话外音卡】根容器使用 data-theater-template=\"subtext-card\"，使用成组卡片呈现“原话”“可能没说出口的话”“留白”。三者必须清楚对应；不确定的内心和动机使用可能、像是、也许等措辞，不下全知结论。";
    case "forum":
      return "【展示结构：论坛楼层】根容器使用 data-theater-template=\"forum\"，必须呈现为本回合专楼。包含版块或帖子标题、楼主首楼、若干带 data-floor 的楼层回复和至少一个带 data-reply-to 的楼中楼。每位观众有不同昵称与身份标签，楼层之间要有补充、接梗、质疑或轻微分歧。把“观察到的事实”和“观众的猜测”区分标记，可用 data-certainty=\"visible\" 或 \"inference\"。猜测不得写成结论；底部可放一条“仅讨论当前回合已公开内容”的版规。不得模拟后续剧情、作者解释或角色未公开的内心。丰富密度增加楼层和回应，不把单条发言拉成长段落。";
    case "body-status":
      return "【展示结构：身体状态卡】根容器使用 data-theater-template=\"body-card\"，按角色分卡，再按与本回合有关的身体部位分项。每项包含部位、当前状态、变化或触发动作；可以写呼吸、眼睛、面部、喉咙、肩颈、手臂、手指、胸腹、腰背、腿脚等，但没有正文依据的部位应省略或明确写“本回合未提及”。区分短暂反应与持续状态，不添加伤病、改造、永久变化或正文没有的亲密暗示。";
    case "evidence-board":
      return "【展示结构：证据板】根容器使用 data-theater-template=\"evidence-board\"，用带小标题的条目整理本回合出现的物件、动作和线索。每条标明正文依据，并区分正文明确、人物设定支持、观众推测和当前无法确认；不要把可能性写成事实，不替后续剧情下结论。";
    case "relationship-card":
      return "【展示结构：关系卡】根容器使用 data-theater-template=\"relationship-card\"，按角色组合展示当前关系位置、本回合变化、触发依据、表面态度和未解决的问题。使用观望、试探、缓和、紧绷等自然状态词；推断要标明可能或暂时，不使用虚假的精确分数，不把卡片内容写回人物事实。";
    case "scene-board":
      return "【展示结构：场景声画】根容器使用 data-theater-template=\"scene-board\"，用光线、声音、温度、气味、触感、空间距离和突出物件整理本回合氛围。每项都要能在正文找到落点，只补充可感知的余味，不新增地点、事件或世界规则。";
    default:
      return "【展示结构：自定义】按照该预设的内容要求选择清晰的卡片、条目、对白或短段落结构。结构服务于阅读，不以排版掩盖缺少依据的内容。";
  }
}

// Content instructions remain independent of the model's outer JSON protocol.
export function theaterInstruction(presets: TheaterPreset[]) {
  return [
    theaterWriting,
    ...presets.map(
      (preset) =>
        `【${preset.name}】\n${preset.prompt}\n${presentationInstruction(preset.presentation)}\n本节写法要求\n先落到本回合一个具体动作、台词或物件，再按预设完成一轮反应或观察，最后停在本段可支持的余波上。不要把其他预设的内容换个说法重复一遍。`,
    ),
    "【小剧场展示格式】\n将小剧场写成一个自包含的 HTML 片段，可用内联样式和 style 标签自由设计卡片、纸条、对话气泡或评论区。多个预设按上面列出的顺序展示，各有清楚的小标题，整体适配窄屏，文字可换行。不输出脚本、事件处理属性、表单、iframe、外部资源、链接跳转或任何网络请求，不使用固定定位和无限动画。美化只改变展示，角色名字与正文内容须作为可阅读文字保留。HTML 字符串交给外层约定的 theaterHtml 字段，不使用 Markdown 围栏。",
  ].join("\n\n");
}
