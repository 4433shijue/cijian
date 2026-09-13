import { useEffect, useRef, useState, type ReactNode } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import {
  ArrowLeft,
  ArrowRight,
  BookOpen,
  Check,
  ChevronDown,
  Feather,
  Leaf,
  MessageCircle,
  Plus,
  Sparkles,
  X,
} from "lucide-react";
import { db, makeStory } from "./db";
import {
  paragraphs,
  uid,
  type Role,
  type SceneEvent,
  type Story,
} from "./types";
import { ConnectionForm, newProfile } from "./ConnectionForm";
import {
  connectionReady,
  dismissStarterTip,
  openStarter,
  starterSteps,
  updateStarter,
  useStarter,
} from "./onboarding-state";
import "./onboarding.css";

export function StarterWelcome() {
  const state = useStarter();
  if (state.status === "complete" || state.status === "paused") return null;
  return (
    <section className="starter-welcome" aria-label="第一次来此间">
      <div className="welcome-copy">
        <span className="starter-kicker">
          <Leaf size={14} /> 初来此间
        </span>
        <h2>
          一起翻开，
          <br />
          你的第一篇故事。
        </h2>
        <p>
          接好模型，带来角色。
          <br />
          剩下的，我们一步一步来。
        </p>
        <div className="welcome-actions">
          <button className="primary" onClick={() => openStarter()}>
            {state.status === "active" ? "继续上次的引导" : "带我开始"}
            <ArrowRight size={17} />
          </button>
          <button
            className="text-action"
            onClick={() => updateStarter({ status: "paused" })}
          >
            我想先自己看看
          </button>
        </div>
      </div>
      <div className="welcome-route" aria-label="四步开启故事">
        {starterSteps.map((label, index) => (
          <div key={label}>
            <span>{String(index + 1).padStart(2, "0")}</span>
            <strong>{label}</strong>
            <small>
              {
                [
                  "让灵感有个来处",
                  "写下你心里的那个人",
                  "给这次相遇一个开场",
                  "把瞬间交给文字",
                ][index]
              }
            </small>
          </div>
        ))}
      </div>
      <span className="welcome-caption">一页一页，慢慢来。</span>
    </section>
  );
}

export function StarterNav() {
  const state = useStarter();
  return (
    <button className="starter-nav" onClick={() => openStarter()}>
      <BookOpen size={16} />
      <span>
        {state.status === "active" || state.status === "paused"
          ? "继续新手引导"
          : "新手引导"}
      </span>
      {state.status !== "complete" && <i />}
    </button>
  );
}

const descriptions = [
  "填入服务提供方给你的连接信息。测试只发送一句简短问候。",
  "先认识一个人。名字和人设足够开始，其他细节可以慢慢补。",
  "给这次相遇一个开场。选好角色，写下故事发生的地方。",
  "准备好了。带着角色走进故事，写下你想看的那一刻。",
];
export function StarterPage({ notify }: { notify: (text: string) => void }) {
  const state = useStarter();
  const data = useLiveQuery(
    async () => ({
      profiles: await db.profiles.toArray(),
      roles: await db.roles.toArray(),
      stories: await db.stories.orderBy("updated").reverse().toArray(),
      world: await db.world.toArray(),
      prefs: await db.preferences.get("preferences"),
      firstScene: state.storyId
        ? await db.events
            .where("storyId")
            .equals(state.storyId)
            .filter(
              (event) =>
                event.kind === "novel" &&
                event.status === "complete" &&
                !event.deleted,
            )
            .count()
        : 0,
    }),
    [state.storyId],
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [editConnection, setEditConnection] = useState(false);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const blankProfile = useRef(newProfile());
  useEffect(() => {
    setError("");
    titleRef.current?.focus({ preventScroll: true });
    window.scrollTo({ top: 0 });
  }, [state.step, !!data]);
  if (!data)
    return (
      <div className="page">
        <p role="status">正在取出你的手记…</p>
      </div>
    );
  const { profiles, roles, stories, world, prefs } = data;
  const profile =
    profiles.find((p) => p.id === prefs?.activeProfile) || profiles[0];
  const story = stories.find((s) => s.id === state.storyId);
  const roleIds = state.roleIds.filter((id) => roles.some((r) => r.id === id));
  const selectedRoles = roleIds.map((id) =>
    roles.find((role) => role.id === id)!,
  );
  const ready = [
    connectionReady(profile),
    selectedRoles.length > 0 || !!story?.roles.length,
    !!story,
    data.firstScene > 0,
  ];
  const progress = ready.filter(Boolean).length;
  const step = state.step;
  const connectionValue =
    state.profileDraft && (!profile || state.profileDraft.id === profile.id)
      ? { ...blankProfile.current, ...profile, ...state.profileDraft }
      : profile || blankProfile.current;
  function go(next: number) {
    updateStarter({
      step: next,
      status: state.status === "complete" ? "complete" : "active",
    });
  }
  async function guarded(work: () => Promise<void>) {
    if (saving) return;
    setSaving(true);
    setError("");
    try {
      await work();
    } catch (e) {
      setError(
        "这一步还没有保存成功，请重试。" +
          (e instanceof Error ? e.message : ""),
      );
    } finally {
      setSaving(false);
    }
  }
  function pause() {
    if (state.status !== "complete") updateStarter({ status: "paused" });
    location.hash = "stories";
  }
  return (
    <div className="starter-page">
      <header className="starter-top">
        <a href="#stories">
          <ArrowLeft size={16} />
          返回故事
        </a>
        <span>此间 · 开始一段小故事</span>
        <button className="text-action" onClick={pause}>
          暂时收起
          <X size={15} />
        </button>
      </header>
      <div className="starter-book">
        <aside className="starter-spine">
          <span className="starter-kicker">
            <Leaf size={15} /> 初来此间
          </span>
          <h1>
            故事的第一页，
            <br />
            从你开始。
          </h1>
          <p>
            不用一次准备好全部。
            <br />
            我们陪这一刻，慢慢成形。
          </p>
          <nav aria-label="新手引导步骤">
            <ol>
              {starterSteps.map((label, index) => (
                <li
                  key={label}
                  className={
                    (index === step ? "current " : "") +
                    (ready[index] ? "done" : "")
                  }
                >
                  <button
                    disabled={
                      saving ||
                      (index > step && !ready.slice(0, index).every(Boolean))
                    }
                    aria-current={index === step ? "step" : undefined}
                    onClick={() => go(index)}
                  >
                    <span className="step-number">
                      {ready[index] ? (
                        <Check size={17} />
                      ) : (
                        String(index + 1).padStart(2, "0")
                      )}
                    </span>
                    <span>
                      <strong>{label}</strong>
                      <small>
                        {ready[index]
                          ? "已完成"
                          : index === step
                            ? "正在这里"
                            : "慢慢来"}
                      </small>
                    </span>
                  </button>
                </li>
              ))}
            </ol>
          </nav>
          <div className="starter-bookmark">
            <Feather size={18} />
            <span>
              每一个故事，
              <br />
              都从一个小小的念头开始。
            </span>
          </div>
        </aside>
        <section className="starter-sheet" aria-label="当前引导步骤">
          <div className="starter-sheet-meta">
            <span>第 {step + 1} 步 / 共 4 步</span>
            <span>{progress}/4 已完成</span>
          </div>
          <progress
            className="starter-progress"
            max={4}
            value={progress}
            aria-label="已完成的引导步骤"
          />
          <header className="starter-sheet-heading">
            <h2 ref={titleRef} tabIndex={-1}>
              {
                [
                  "先接好，灵感的来路",
                  "把你心里的角色带来",
                  "为这次相遇，翻开一页",
                  "现在，写下第一个瞬间",
                ][step]
              }
            </h2>
            <p>{descriptions[step]}</p>
          </header>
          {step > 0 && !ready[0] && (
            <div className="starter-reminder" role="status">
              <span>
                连接还需要确认
                {profile?.testedAt ? "，刷新后请重新填写未记住的密钥" : ""}
                。角色和故事可以继续准备。
              </span>
              <button onClick={() => go(0)}>去完成连接</button>
            </div>
          )}
          {error && (
            <p className="connection-failure" role="alert">
              {error}
            </p>
          )}
          {step === 0 && (
            <>
              {profiles.length > 1 && (
                <label className="field">
                  <span>使用已有接口</span>
                  <select
                    value={profile?.id || ""}
                    onChange={async (e) => {
                      await db.preferences.update("preferences", {
                        activeProfile: e.target.value,
                      });
                      updateStarter({ profileDraft: undefined });
                      setEditConnection(false);
                    }}
                  >
                    {profiles.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name} · {p.model}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {ready[0] && !editConnection && !state.profileDraft ? (
                <div className="starter-existing">
                  <span className="success-seal">
                    <Check size={25} />
                  </span>
                  <h3>你的模型已经接好了</h3>
                  <p>
                    {profile!.name} · {profile!.model}
                  </p>
                  <div className="starter-actions">
                    <button onClick={() => setEditConnection(true)}>
                      调整连接
                    </button>
                    <button
                      className="primary"
                      onClick={() =>
                        go(story ? 3 : selectedRoles.length ? 2 : 1)
                      }
                    >
                      继续下一步
                      <ArrowRight size={16} />
                    </button>
                  </div>
                </div>
              ) : (
                <ConnectionForm
                  key={connectionValue.id}
                  value={connectionValue}
                  guided
                  onDraftChange={(profileDraft) =>
                    updateStarter({ profileDraft })
                  }
                  onSaved={() => {
                    updateStarter({ profileDraft: undefined });
                    setEditConnection(false);
                    notify("连接已验证并保存");
                    go(story ? 3 : selectedRoles.length ? 2 : 1);
                  }}
                />
              )}
            </>
          )}
          {step === 1 && (
            <>
              {roles.length > 0 && (
                <div className="starter-role-library">
                  <h3>也可以带上已有角色</h3>
                  <div className="starter-role-picks">
                    {roles.map((r) => (
                      <button
                        key={r.id}
                        aria-pressed={roleIds.includes(r.id)}
                        className={roleIds.includes(r.id) ? "selected" : ""}
                        onClick={() =>
                          updateStarter({
                            roleIds: roleIds.includes(r.id)
                              ? roleIds.filter((id) => id !== r.id)
                              : [...roleIds, r.id],
                          })
                        }
                      >
                        <span className="role-initial">
                          {r.avatar ? (
                            <img src={r.avatar} alt="" />
                          ) : (
                            r.name.slice(0, 1)
                          )}
                        </span>
                        <span>{r.name}</span>
                        {roleIds.includes(r.id) && <Check size={15} />}
                      </button>
                    ))}
                  </div>
                  <button
                    className="primary"
                    disabled={!selectedRoles.length}
                    onClick={() => go(2)}
                  >
                    带上所选角色
                    <ArrowRight size={16} />
                  </button>
                  <div className="starter-or">或写下一位新角色</div>
                </div>
              )}
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  if (!state.roleName.trim() || !state.persona.trim()) {
                    setError("请写下角色的名字和人设。");
                    return;
                  }
                  guarded(async () => {
                    const r: Role = {
                      id: uid(),
                      name: state.roleName.trim(),
                      persona: state.persona.trim(),
                      bio: state.persona.trim().slice(0, 70),
                      avatar: "",
                      paragraphs: paragraphs(state.persona.trim()),
                      updated: Date.now(),
                    };
                    if (r.paragraphs[0]) r.paragraphs[0].pin = true;
                    await db.roles.add(r);
                    updateStarter({
                      roleIds: [...new Set([...roleIds, r.id])],
                      roleName: "",
                      persona: "",
                      step: 2,
                      status: "active",
                    });
                  });
                }}
              >
                <label className="field">
                  <span>角色名字</span>
                  <input
                    autoComplete="off"
                    required
                    value={state.roleName}
                    placeholder="你想把谁带进故事？"
                    onChange={(e) =>
                      updateStarter({ roleName: e.target.value })
                    }
                  />
                </label>
                <label className="field">
                  <span>角色人设</span>
                  <textarea
                    required
                    rows={6}
                    value={state.persona}
                    placeholder={
                      "TA 是谁，性格怎样，说话有什么习惯？\n写下你最在意的几件事就好。"
                    }
                    onChange={(e) => updateStarter({ persona: e.target.value })}
                  />
                </label>
                <details className="starter-details">
                  <summary>
                    <span>不知道怎么写？看看一个例子</span>
                    <ChevronDown size={15} />
                  </summary>
                  <div className="starter-writing-example">
                    <p>
                      在旧书店工作的年轻人，说话简短，关心别人时习惯先做事。遇到熟人会把刚泡好的茶推过去，却很少主动问候。
                    </p>
                    <small>
                      身份、性格，再加一个具体习惯，就能让角色鲜明起来。
                    </small>
                  </div>
                </details>
                <label className="starter-import">
                  已有一份人设？导入 TXT / Markdown
                  <input
                    type="file"
                    accept=".txt,.md,text/plain,text/markdown"
                    onChange={async (e) => {
                      const file = e.target.files?.[0];
                      if (!file) return;
                      try {
                        updateStarter({ persona: await file.text() });
                      } catch {
                        setError("文件没能读取，请重试或直接粘贴人设。");
                      }
                      e.target.value = "";
                    }}
                  />
                </label>
                <div className="starter-actions">
                  <button type="button" disabled={saving} onClick={() => go(0)}>
                    上一步
                  </button>
                  <button className="primary" disabled={saving}>
                    保存角色，继续
                    <ArrowRight size={16} />
                  </button>
                </div>
              </form>
            </>
          )}
          {step === 2 && (
            <>
              {stories.length > 0 && (
                <div className="starter-existing-story">
                  <label className="field">
                    <span>继续一本已有的故事</span>
                    <select
                      value={story?.id || ""}
                      onChange={(e) => {
                        const chosen = stories.find(
                          (s) => s.id === e.target.value,
                        );
                        if (chosen)
                          updateStarter({
                            storyId: chosen.id,
                            roleIds: chosen.roles.map(
                              (r) => r.sourceId || r.id,
                            ),
                          });
                      }}
                    >
                      <option value="">选择故事</option>
                      {stories.map((s) => (
                        <option value={s.id} key={s.id}>
                          {s.title}
                        </option>
                      ))}
                    </select>
                  </label>
                  {story && (
                    <button className="primary" onClick={() => go(3)}>
                      带上这本故事
                      <ArrowRight size={16} />
                    </button>
                  )}
                  <div className="starter-or">或开启一本新故事</div>
                </div>
              )}
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  if (!state.title.trim() || !selectedRoles.length) {
                    setError("请为故事起个名字，并选上至少一位角色。");
                    return;
                  }
                  guarded(async () => {
                    const created = makeStory(
                      state.title.trim(),
                      selectedRoles,
                      state.worldIds.filter((id) =>
                        world.some((w) => w.id === id),
                      ),
                      state.background.trim(),
                    );
                    await db.stories.add(created);
                    updateStarter({
                      storyId: created.id,
                      title: "",
                      background: "",
                      worldIds: [],
                      step: 3,
                      status: "active",
                    });
                  });
                }}
              >
                <label className="field">
                  <span>故事名字</span>
                  <input
                    required
                    value={state.title}
                    placeholder="例如，风经过书页"
                    onChange={(e) => updateStarter({ title: e.target.value })}
                  />
                </label>
                <fieldset className="starter-cast">
                  <legend>这次与谁相遇</legend>
                  <div className="starter-role-picks">
                    {roles.map((r) => (
                      <button
                        type="button"
                        key={r.id}
                        aria-pressed={roleIds.includes(r.id)}
                        className={roleIds.includes(r.id) ? "selected" : ""}
                        onClick={() =>
                          updateStarter({
                            roleIds: roleIds.includes(r.id)
                              ? roleIds.filter((id) => id !== r.id)
                              : [...roleIds, r.id],
                          })
                        }
                      >
                        <span className="role-initial">
                          {r.name.slice(0, 1)}
                        </span>
                        {r.name}
                        {roleIds.includes(r.id) && <Check size={14} />}
                      </button>
                    ))}
                    <button
                      type="button"
                      className="text-action"
                      onClick={() => go(1)}
                    >
                      <Plus size={15} />
                      添加角色
                    </button>
                  </div>
                  <p className="hint">
                    写正文，一位角色就可以。想让角色互相聊天，可以选两位或更多。
                  </p>
                </fieldset>
                <label className="field">
                  <span>
                    开场背景 <small>选填</small>
                  </span>
                  <textarea
                    rows={3}
                    value={state.background}
                    placeholder="傍晚的旧书店，风把门口的书页翻动了。"
                    onChange={(e) =>
                      updateStarter({ background: e.target.value })
                    }
                  />
                </label>
                <details className="starter-details">
                  <summary>
                    <span>带入世界书</span>
                    <small>选填，以后也能补上</small>
                    <ChevronDown size={15} />
                  </summary>
                  <div className="details-content">
                    <p className="hint">
                      世界书用来补充地点、人物关系和故事规则。第一次写，可以先留空。
                    </p>
                    {world.length ? (
                      world.map((w) => (
                        <label className="toggle" key={w.id}>
                          <input
                            type="checkbox"
                            checked={state.worldIds.includes(w.id)}
                            onChange={(e) =>
                              updateStarter({
                                worldIds: e.target.checked
                                  ? [...state.worldIds, w.id]
                                  : state.worldIds.filter((id) => id !== w.id),
                              })
                            }
                          />
                          <span>{w.title}</span>
                        </label>
                      ))
                    ) : (
                      <p>还没有世界书，也可以直接开始。</p>
                    )}
                  </div>
                </details>
                <div className="starter-actions">
                  <button type="button" disabled={saving} onClick={() => go(1)}>
                    上一步
                  </button>
                  <button
                    className="primary"
                    disabled={saving || !selectedRoles.length}
                  >
                    保存故事，继续
                    <ArrowRight size={16} />
                  </button>
                </div>
              </form>
            </>
          )}
          {step === 3 &&
            (story ? (
              <div className="starter-ready">
                <div className="starter-story-cover">
                  <BookOpen size={30} />
                  <h3>{story.title}</h3>
                  <p>{story.roles.map((r) => r.name).join(" · ")}</p>
                </div>
                <div className="starter-next-note">
                  <Feather size={19} />
                  <div>
                    <h3>你决定发生什么，AI 负责写得更细。</h3>
                    <p>
                      进入故事后，在输入框写下动作或台词，再点「扩写这一刻」。成功保存第一段，引导就完成了。
                    </p>
                  </div>
                </div>
                <div className="starter-actions">
                  <button onClick={() => go(2)}>上一步</button>
                  <button
                    className="primary"
                    onClick={() => {
                      if (!ready[0]) {
                        go(0);
                        return;
                      }
                      updateStarter({
                        status:
                          state.status === "complete" ? "complete" : "active",
                      });
                      location.hash = "story/" + story.id;
                    }}
                  >
                    {" "}
                    {ready[0] ? "进入故事，写第一段" : "先完成模型连接"}
                    <ArrowRight size={16} />
                  </button>
                </div>
              </div>
            ) : (
              <div className="starter-recovery">
                <Leaf size={30} />
                <h3>先为这个瞬间准备一本故事</h3>
                <p>
                  之前的故事可能已被移除。可以选择已有故事，也可以重新开启一本。
                </p>
                <button className="primary" onClick={() => go(2)}>
                  去选择故事
                </button>
              </div>
            ))}
          <footer className="starter-footnote">
            <span>
              <i />
              {saving ? "正在保存…" : "填写内容在这台设备暂存"}
            </span>
            <span>密钥按你的记住选项保存</span>
          </footer>
        </section>
      </div>
    </div>
  );
}

export function ContextTip({
  id,
  title,
  children,
}: {
  id: string;
  title: string;
  children: ReactNode;
}) {
  const state = useStarter();
  if (state.dismissedTips.includes(id)) return null;
  return (
    <aside className="context-tip" aria-label={title}>
      <Leaf size={19} />
      <div>
        <strong>{title}</strong>
        {children}
      </div>
      <button
        className="tip-close"
        aria-label={"收起" + title}
        onClick={() => dismissStarterTip(id)}
      >
        <X size={16} />
      </button>
    </aside>
  );
}

export function FirstSceneCoach({
  story,
  events,
  onExample,
}: {
  story: Story;
  events: SceneEvent[];
  onExample: (value: string) => void;
}) {
  const state = useStarter();
  const hasFirstScene = events.some(
    (event) =>
      event.kind === "novel" && event.status === "complete" && !event.deleted,
  );
  useEffect(() => {
    if (
      hasFirstScene &&
      state.storyId === story.id &&
      state.status !== "complete"
    )
      updateStarter({ status: "complete", step: 3 });
  }, [hasFirstScene, story.id, state.storyId, state.status]);
  if (hasFirstScene) return null;
  return (
    <ContextTip id="first-scene" title="从一个小小的动作开始">
      <p>
        写下动作或台词，点「扩写这一刻」。AI
        会围绕你给出的瞬间展开细节；生成后，你仍可以修改。
      </p>
      <button
        className="text-action"
        onClick={() =>
          onExample(
            `${story.roles[0]?.name || "TA"}轻轻合上书，抬头说：“你来了。”`,
          )
        }
      >
        填入一句示例
        <Feather size={14} />
      </button>
      {state.storyId === story.id && (
        <span className="tip-step">第 4 步 · 第一段成功保存后完成引导</span>
      )}
    </ContextTip>
  );
}

export function StarterCelebration({
  story,
  onChat,
  onContinue,
}: {
  story: Story;
  onChat: () => void;
  onContinue: () => void;
}) {
  const state = useStarter();
  if (
    state.status !== "complete" ||
    state.storyId !== story.id ||
    state.dismissedTips.includes("celebration")
  )
    return null;
  return (
    <section className="starter-celebration" aria-label="新手引导已完成">
      <span className="success-seal">
        <Sparkles size={23} />
      </span>
      <div>
        <span className="starter-kicker">第一段，已经写下</span>
        <h2>你的故事，开始了。</h2>
        <p>这一刻已保存在本机。以后随时可以在「新手引导」回顾。</p>
        <div className="row">
          <button
            className="primary"
            onClick={() => {
              dismissStarterTip("celebration");
              onContinue();
            }}
          >
            继续写故事
            <Feather size={15} />
          </button>
          <button
            onClick={() => {
              dismissStarterTip("celebration");
              onChat();
            }}
          >
            看看手机聊天
            <MessageCircle size={15} />
          </button>
        </div>
      </div>
      <button
        className="tip-close"
        aria-label="收起完成提示"
        onClick={() => dismissStarterTip("celebration")}
      >
        <X size={17} />
      </button>
    </section>
  );
}
