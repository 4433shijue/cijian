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
      "让本回合出场的主角在幕后接着刚才那点尴尬聊起来。先抓住正文里一句台词、一个动作或一件物品，让一个人开口，另一个人顺着自己的心事回应。有人嘴硬，有人把话岔开，也有人听懂了却故意装没听懂，口气和反应要贴着人物身份与关系。把动作旁注放在对应台词附近，让几次接话构成一个完整的小片段，最后停在一个动作或有余味的回话上。笑点来自眼前的人和事，别让大家轮流复述正文、解释笑点或讲同一种网络段子。",
  },
  {
    id: "theater-details",
    name: "没被发现的细节",
    presentation: "detail-list",
    prompt:
      "重新看一遍本回合，挑出容易被略过的目光、物件位置、小动作或措辞。每条先留下可以核对的原句，再慢一点写读者能从中看见什么，以及哪一部分还无法确定。几条观察要各有落点，可以互相照应，别把同一个动作换几种说法凑条目。让细节改变读者对眼前场面的理解，不强行埋伏笔，不补出重大秘密，也不提前揭晓后面的事。",
  },
  {
    id: "theater-subtext",
    name: "话外之音",
    presentation: "subtext-card",
    prompt:
      "挑出本回合有余味的对白，把说话者、原话和当时的动作放在一起看。先交代字面上说了什么，再写他可能想试探、遮掩或保住的那一点东西；内心层要保留人物口气，别替所有人写成漂亮独白。每段对白留出另一种同样说得通的理解，解释分歧来自原句的哪里。原文写明的心理可直接引用，其余动机只作为推测，不替作者决定还没写明的关系。",
  },
  {
    id: "theater-audience",
    name: "来自第四面墙的观众",
    presentation: "forum",
    prompt:
      "开一个只讨论本回合的虚构观众专楼。楼主从一句能核对的台词、一个动作、一个物件或一次停顿起帖，标题像读者看完后真正会冒出的念头。几位观众各有在意的地方，细节党会翻原句，角色厨容易护短，吐槽党会接梗，谨慎推理者也会承认没看懂。让他们互相引用、补充、反驳或改口，讨论里可以长出两三个分支，别让每个人各说各的。每层有具体内容，长短随表达意图变化，允许一句到位，也允许一小段说明。观众只能知道当前回合已经公开的内容，不得偷看私密设定、其他回合、后续剧情或作者意图；猜错也要标明是猜测。收在仍值得讨论的一句话上，不写下一回预告。",
  },
  {
    id: "theater-body",
    name: "角色的身体变化",
    presentation: "body-status",
    prompt:
      "把本回合出场角色的身体反应做成可以逐部位翻看的状态卡。细看动作经过哪里，目光怎样停住，呼吸在哪里变了节奏，手指与身体支撑点怎样用力。按人物实际结构覆盖头部与面部、眼睛、口唇与下颌、颈肩、胸背与呼吸、腹部与腰部、上臂、肘、前臂、手腕、手掌与手指、髋部、大腿、膝、小腿、脚踝和足部；相关部位可继续细分，不要求每一项都发生变化。每项写清当前可见状态、相对本回合较早时刻的变化、触发动作和持续到何时，材料没给出的部分保留未知。左侧和右侧只有正文能区分时才分写，设定中的尾巴、翅膀、义肢等也按实际结构增加。人物设定用来确认身体结构，不能证明本回合没写到的部位处于正常状态。不要把呼吸、发热或肌肉反应直接定性为某种情绪，不添加伤病、改造、永久变化或未经正文支持的亲密暗示。",
  },
  {
    id: "theater-relationship",
    name: "关系里的小变化",
    presentation: "relationship-card",
    prompt:
      "沿着本回合两个人实际说过的话和做过的动作，看看他们站在彼此面前的位置有没有一点变化。可以是暂时愿意配合，也可以是退回原来的距离；没有变化也照实写。把触发变化的原句放在附近，分别写表面态度、可能的理解和仍没解决的问题。不同方向的态度可以不对称，不给关系打精确分数，不把一次照顾直接判成爱情，也不把沉默都读成拒绝。",
  },
  {
    id: "theater-scene",
    name: "场景里的声与光",
    presentation: "scene-board",
    prompt:
      "把注意力暂时放到人物身边。跟着本回合已有的光线、声音、触感、温度和空间距离，写它们怎样伴随动作发生变化。每个小镜头都要找得到正文落点，物件的动静可以相互照应，但别让天气替人物宣布心情。没有出现的感官信息保持留白，不增添地点、人物或下一段事件。",
  },
  {
    id: "theater-props",
    name: "物件与线索",
    presentation: "evidence-board",
    prompt:
      "给本回合真正出现过的物件和线索做几张小档案。写清它在哪里、谁碰过它、原文明确留下了什么，再写它可能让读者多想一步的地方。把可核对的原句、合理推测和暂时无法确认的部分分开。普通物件可以只是普通物件，不为凑悬念赋予隐藏身份，也不替后文提前安排用途。",
  },
];

// Resolve editable configuration by its original ID before cloning or import
// remapping. Saved result snapshots must not be passed through this fallback.
export function resolveTheaterPreset(preset: TheaterPreset): TheaterPreset {
  const builtin = builtInTheaterPresets.find((item) => item.id === preset.id);
  return {
    ...preset,
    presentation: preset.presentation === undefined
      ? builtin?.presentation ?? "custom"
      : normalizeTheaterPresentation(preset.presentation),
  };
}

export function restoreBuiltInTheaterPresentation(preset: TheaterPreset): TheaterPreset {
  const builtin = builtInTheaterPresets.find((item) => item.id === preset.id);
  return resolveTheaterPreset({
    ...preset,
    presentation: builtin?.presentation ?? preset.presentation,
  });
}

export function allTheaterPresets(prefs: Preferences): TheaterPreset[] {
  const merged = new Map(
    builtInTheaterPresets.map((preset) => [preset.id, preset]),
  );
  for (const preset of prefs.theaterPresets || [])
    merged.set(preset.id, resolveTheaterPreset(preset));
  return [...merged.values()].map(resolveTheaterPreset);
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
  "围绕提供的人物设定、世界书与目标回合正文，按每种栏目的阅读方式展开番外。先找到可以核对的动作、台词或物件，再让对白产生回应，让观察带来新的区别，让推测保留依据与余地。丰富度增加不同的具体内容和彼此回应，不靠把一句话反复解释来撑篇幅。人物有各自眼下在意的事，声音从身份、关系与处境里长出来，别用固定口头禅替代性格。允许犹豫、岔话、误读和改口，动作已经传达的情绪不必再翻译一遍。多个方向各成一栏，避免相互重复；材料不足就少写，不能捏造依据或推动主线。写自然中文，不用破折号、提示性冒号、翻案句和整齐排比，内容已经说完时停在具体动作或回话上，不加总结和升华。小剧场是独立番外，不作为主线事件、人物知情或记忆。私密设定只能帮助理解对应人物，不自动成为其他人物或观众的知识。";

export function theaterDensityInstruction(density: TheaterDensity | undefined) {
  const label = density === "light" ? "轻量" : density === "rich" ? "丰富" : "标准";
  const guidance = density === "light" ? "挑最有意思的落点，内容短而完整，交互简单直接。" : density === "rich" ? "增加具体细节、人物回应和有分歧的讨论，让读者可以逐层探索。每层都带来新的内容，不靠复述凑篇幅。" : "把场面、人物反应和余味写清楚，保留适量可展开的细节。";
  return `【小剧场丰富度：${label}】${guidance}数量、布局和交互由你根据材料决定，不固定楼层数、卡片数或主题颜色。多个方向各有侧重。自动模式优先完成正文，在当前输出额度内安排番外；缺少材料时保留未知。`;
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

// Optional legacy presentation values are editorial suggestions, never HTML schemas.
export function presentationInstruction(presentation: TheaterPresentation | undefined): string {
  switch (normalizeTheaterPresentation(presentation)) {
    case "forum": return "体验方向是虚构观众论坛，内容要有话题、不同观众和彼此回应；论坛界面与交互由你设计。";
    case "body-status": return "体验方向是逐部位探索角色状态，写清人物、部位、当下表现、变化与未确定之处；状态卡或身体示意的界面由你设计。";
    case "dialogue": return "让读者能分清说话者，看到台词和动作怎样彼此回应，表现形式由你设计。";
    case "detail-list": return "帮助读者重新注意到具体细节，并分清观察与猜测，表现形式由你设计。";
    case "subtext-card": return "让对白、可能的潜台词和其他理解互相对应，表现形式由你设计。";
    case "evidence-board": return "分清物件的已知情况、可能联系和待确认部分，表现形式由你设计。";
    case "relationship-card": return "呈现双方态度、变化依据和未解决的问题，允许态度不对称，表现形式由你设计。";
    case "scene-board": return "沿着人物动作表现光、声音、触感与空间，表现形式由你设计。";
    default: return "按作者要求创作一个可以阅读和探索的小剧场，视觉和交互由你设计。";
  }
}

export const theaterRuntimeInstruction = `【应用运行约定】
每个栏目返回自包含 HTML，CSS 和 JavaScript 可以自由内联编写。无需固定标签、类名、卡片形状、配色或控件布局，原生按钮、表单控件、SVG、canvas 和本地交互均可使用。所有内容都在隔离页面内运行，不加载外部资源，不跳转网站，不直接联网，不读取主页面、密钥或浏览器存档。
页面启动时可直接使用 window.cijian。cijian.getState() 返回这一个栏目之前保存的 JSON 状态（初始为 null）；cijian.saveState(value) 保存 JSON 状态，适合保留展开、选择、留言草稿和本地标记；再次展开会恢复该状态。请为需要保留的选择、展开、标记和草稿接入保存与恢复，复杂状态由你的脚本自行应用到界面，字段名由你决定。
读者真实点击按钮后，可调用 await cijian.generate({prompt: "用户想追加或回复的具体要求"})，应用会为当前栏目生成更新后的完整 HTML 并替换这一栏，其他栏目不变。需要模型的按钮明确标注 AI，普通展开、筛选和翻页只在本地处理。generate 每次只接受一次真实点击授权，禁止页面加载时或计时器自动调用，不自行编写 fetch/API Key。
确保文字对比清楚，适配窄屏，交互有实际功能。可使用原生 details 及自己设计的交互；不要只画出没有作用的按钮。正文已知事实和番外推测自然区分，无需统一排成字段表。尽量将可阅读文字保留在初始 HTML 中；脚本动态文字会在展开后保存为导出文字快照。`;

export function theaterInstruction(presets: TheaterPreset[]) {
  return [
    theaterWriting,
    ...presets.map((preset) => `【${preset.name}】\n本栏编号 ${JSON.stringify(preset.id)}\n${preset.prompt}\n${preset.experience?.trim() ? "作者的视觉与交互偏好\n" + preset.experience : ""}\n${presentationInstruction(preset.presentation)}`),
    theaterRuntimeInstruction,
    '【外层传输格式】只约定保存与分发，不约束 HTML 内部。返回 theater 对象 {"version":2,"sections":[{"id":"本栏编号","title":"栏目标题","html":"完整 HTML 代码"}]}。每个已选预设对应一份 HTML，按所选顺序返回。只需 id、title、html，不再输出 items、theme、presentation 或固定内容字段。所有文字、排版和交互都由你在 HTML 中完成。JSON 字符串里的双引号、反斜杠和换行正确转义，不使用 Markdown 围栏。',
  ].join("\n\n");
}
