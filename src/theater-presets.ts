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
      "挑出本回合有余味的对白，把说话者、原话和当时的动作放在一起看。先交代字面上说了什么，再写他可能想试探、遮掩或保住的那一点东西；内心层要保留人物口气，别替所有人写成漂亮独白。每张卡留出另一种同样说得通的理解，解释分歧来自原句的哪里。原文写明的心理可直接引用，其余动机只作为推测，不替作者决定还没写明的关系。",
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
      "把本回合出场角色的身体反应做成可以逐部位翻看的状态卡。细看动作经过哪里，目光怎样停住，呼吸在哪里变了节奏，手指与身体支撑点怎样用力。每项写清当前可见状态、相对本回合较早时刻的变化、触发动作和持续到何时，材料没给出的部分保留未知。左侧和右侧只有正文能区分时才分写，设定中的尾巴、翅膀、义肢等也按实际结构增加。人物设定用来确认身体结构，不能证明本回合没写到的部位处于正常状态。不要把呼吸、发热或肌肉反应直接定性为某种情绪，不添加伤病、改造、永久变化或未经正文支持的亲密暗示。",
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
  "围绕提供的人物设定、世界书与目标回合正文，按每种栏目的阅读方式展开番外。先找到可以核对的动作、台词或物件，再让对白产生回应，让观察带来新的区别，让推测保留依据与余地。丰富度增加不同的具体内容和彼此回应，不靠把一句话反复解释来撑篇幅。人物有各自眼下在意的事，声音从身份、关系与处境里长出来，别用固定口头禅替代性格。允许犹豫、岔话、误读和改口，动作已经传达的情绪不必再翻译一遍。多个方向各成一栏，避免相互重复；材料不足就少写，不能捏造依据或推动主线。写自然中文，不用破折号、提示性冒号、翻案句和整齐排比，内容已经说完时停在具体动作或回话上，不加总结和升华。小剧场是独立番外，不作为主线事件、人物知情或记忆。私密设定只能帮助理解对应人物，不自动成为其他人物或观众的知识。";

export function theaterDensityInstruction(density: TheaterDensity | undefined) {
  switch (density || "standard") {
    case "light":
      return "【小剧场丰富度：轻量】围绕一个具体动作或台词展开。论坛以4～5层、2～3位观众为参考，保留一次有来有回的接话；吐槽以4～6次发言完成一个小片段；话外音、细节、关系、声画或物件选择1～2个落点。身体卡详写每位角色最相关的2～4处部位，未提及项收进未知范围。数量是有材料时的参考，不为凑数复述或补造信息。";
    case "rich":
      return "【小剧场丰富度：丰富】让不同落点相互回应，展开关系位置、信息理解或情绪变化。论坛以10～14层、5～6位观众为参考，形成2～3个可追踪的讨论分支，有补充、质疑和改口；吐槽以10～16次发言展开几轮接话和动作旁注；话外音选择4～6句，逐句保留另一种解释；细节、关系、声画或物件可写4～7个互不重复的条目。身体卡沿动作涉及的部位细分，材料充足可详写8～16处甚至更多，分清左右、触发与持续状态。每一条都需要独立内容，不为凑数发明线索、身体变化或新剧情。优先完成本次正文，在现有输出额度内分配各栏篇幅。";
    default:
      return "【小剧场丰富度：标准】按栏目展开具体内容。论坛以7～9层、约4位观众为参考，至少有一处回应链和一次自然的意见分歧；吐槽以6～10次发言形成一个完整的幕后片段；话外音选择2～3句并写出不同理解；细节、关系、声画或物件保留2～4个不同落点。身体卡详写每位角色与动作相关的4～8处部位，保留依据、变化和未确定处。数量随材料调整，少写也要每条有内容，不凑楼层，不把所有栏目压成同一种短段落。";
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
      return "【展示结构：对白吐槽】每次发言写一个 item，author 是说话者，text 是台词，title 可放一小句动作旁注；有直接回应时 replyTo 指向前一条对应发言的 id。quote 只放作为落点的正文原句，没有则留空。新增的幕后台词用 certainty=fiction，正文引述与推测分别标明 observed 和 inferred。不同人物应当真正接住对方的话，不突然知道未公开信息。html 留空。";
    case "detail-list":
      return "【展示结构：细节清单】每个 item 观察一个不同落点，title 为细节名，quote 为可核对的正文原句，text 写具体观察，fields 可写“多看见的一点”和“尚未确定”。正文明确用 observed，解释和推测用 inferred，不把观察条目伪装成新剧情。html 留空。";
    case "subtext-card":
      return "【展示结构：话外音卡】每句对白一个 item，author 为说话者，quote 完整引用对应原话，text 写字面意思。fields 分别放“可能没说出口的话”“另一种理解”“当时的动作”，没有依据的字段可以少写。推测的内心和动机用 certainty=inferred，并在措辞中保留可能性；正文明确写出的心理才可 observed。不下全知结论，html 留空。";
    case "forum":
      return "【展示结构：论坛楼层】第一个 item 是楼主首楼，其 title 写帖子标题，author 写楼主昵称，badge 写观众身份，text 写主帖；后续每个 item 是一层回复。同一观众始终使用同一个昵称。replyTo 留空表示直接跟帖，指向已有楼层 id 则形成楼中楼，不得指向尚未出现的楼层。每位观众有自己的关注点，昵称和身份不能代替实际内容；楼层之间要有补充、接梗、质疑或轻微分歧。quote 只能逐字引用当前正文，certainty 用 observed 标记可核对的观察，用 inferred 标记推测，unknown 表示无法确定。猜测不得写成结论，只讨论当前回合已公开内容；不泄露私密设定、后续剧情或作者意图。group 可写所属讨论分支。应用负责楼层筛选、点赞和用户回帖，不要自己生成按钮、假点赞数字或脚本。html 留空。";
    case "body-status":
      return "【展示结构：身体状态卡】按角色和身体部位分项，每个 item 的 author 是角色名，title 是具体部位，group 是部位分组，text 是当前状态，quote 放逐字正文依据。fields 可分别写“本回合变化”“触发动作”“持续情况”“依据”，比较只限本回合已写出的先后状态，不引用其他回合。检查目录包括眼睛、眼睑、眉间、面部、嘴唇、下颌、耳部、喉咙、声音、颈部、左右肩、胸腔、呼吸、背部、腹部、腰部、左右上臂、肘部、前臂、手腕、手掌、手指、髋部、大腿、膝盖、小腿、脚踝、脚，以及设定支持的尾巴、翅膀或义肢。目录帮助找遗漏，不能要求模型填满；只详写有依据的项目。没有提到的项目可省略，或写“本回合未提及”，对应 status=unmentioned、certainty=unknown、quote 为空；应用可把未知项目折叠。明确无变化才用 stable，轻微反应用 subtle，明显反应用 clear，影响动作用 impact。其他状态必须有 quote 或“依据”字段，不能把没提到写成正常。身体结构设定仅支持结构本身，不证明当前状态。html 留空。";
    case "evidence-board":
      return "【展示结构：证据板】每件物品或线索一个 item，title 写名称，group 可写所属场景，quote 保留正文原句，text 写可观察事实。fields 可放“所在位置”“接触者”“可能的联系”“仍待确认”。已知情况用 observed，推测用 inferred，无法确认用 unknown。涉及猜测的整条记录不能标成正文明确，不替后续剧情下结论。html 留空。";
    case "relationship-card":
      return "【展示结构：关系卡】每组有依据的角色关系一个 item，author 写观察的一方，title 写关系方向或双方名字，quote 是触发判断的正文原句，text 写当前关系位置。fields 可放“本回合变化”“表面态度”“另一种理解”“未解决的问题”。允许双向态度不同，使用观望、试探、暂时缓和等自然词，分析用 certainty=inferred。不给虚假的精确分数，不把卡片写回人物事实。html 留空。";
    case "scene-board":
      return "【展示结构：场景声画】每个镜头或感官落点一个 item，title 是镜头名，group 可为光线、声音、触感、空间等，quote 保留对应原句，text 写正文支持的感知。fields 可放“跟随的动作”“注意力落点”，缺失的感官信息留白，不新增地点、事件或世界规则。确切观察和可能感受分别标明 certainty，html 留空。";
    default:
      return "【展示结构：自定义】可用 items 写清晰的卡片、条目、对白，也可把自包含的 HTML/CSS 片段放在本栏 html 中，两者至少有一种可阅读内容。只有 custom 展示允许 html。文字与背景成套搭配，字号清楚，使用静态布局并适配窄屏，不靠透明文字和小号浅灰字制造装饰。不输出脚本、事件属性、表单、iframe、外部资源、跳转、网络请求、固定定位或无限动画。应用提供安全展示和操作，HTML 不自带假交互按钮。";
  }
}

// Content instructions remain independent of the model's outer JSON protocol.
export function theaterInstruction(presets: TheaterPreset[]) {
  return [
    theaterWriting,
    ...presets.map(
      (preset) =>
        `【${preset.name}】\n本栏 id=${JSON.stringify(preset.id)}，presentation=${JSON.stringify(normalizeTheaterPresentation(preset.presentation))}，保持所选顺序。\n${preset.prompt}\n${presentationInstruction(preset.presentation)}\n本节写法要求\n先落到本回合一个具体动作、台词或物件，再按此栏目的丰富度完成有内容的回应或观察。补足层次时增加新的落点，不把其他预设换个说法重复一遍。`,
    ),
    '【小剧场数据格式】\n外层 theater 是 {"version":1,"sections":[...]}。每个已选预设对应一个 section，必须按选择顺序完整返回；section 的字段为 id、title、presentation、theme、items、html。id 使用上述预设编号，title 为栏目标题，presentation 遵守上述值，theme 从 paper、forest、night 中选择。每个 item 必须包含 id、author、badge、title、text、quote、certainty、replyTo、group、status、fields；fields 是 {"label":"字段名","value":"内容"} 的数组。所有字段都要填写，不适用的字符串用空字符串、数组用空数组。条目 id 在本栏目中唯一，replyTo 只能指向同栏已出现的条目 id，没有回复对象则为空。certainty 只能为 observed、inferred、unknown、fiction；status 只能为 unmentioned、stable、subtle、clear、impact 或空字符串。quote 仅可逐字摘录目标正文，没有原句就留空，不伪造引文。除 custom 的 html 外，所有文字字段都是纯文本，不写 HTML。内置栏目的 html 必须为空。排版、配色、折叠与交互由应用生成，模型不输出 CSS、按钮或脚本；自定义 HTML 按该栏规则处理。不添加 origin、点赞数或未定义字段，不使用 Markdown 围栏。',
  ].join("\n\n");
}
