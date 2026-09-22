import { useEffect, useLayoutEffect, useState, useRef, type ReactNode } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import {
  BookOpen,
  Users,
  Leaf,
  Settings,
  Plus,
  ArrowLeft,
  ArrowUpToLine,
  ArrowDownToLine,
  Maximize2,
  Minimize2,
  Send,
  Square,
  Feather,
  MessageCircle,
  Trash2,
  SlidersHorizontal,
  Check,
  RefreshCw,
  BookMarked,
  ChevronDown,
  ChevronUp,
  Lightbulb,
  AlertTriangle,
  CheckCircle2,
  Copy,
} from "lucide-react";
import { db, makeStory, deleteStory, reviseEvent, setTimelineMode, ensureStoryRounds } from "./db";
import { sharedTimeline, visibleText } from "./timeline";
import { loadRoleDraft, saveRoleDraft, saveCreatedRole } from "./role-draft";
import { InspirationAssistant } from "./InspirationAssistant";
import { TheaterPanel, EventRawOutput } from "./TheaterPanel";
import { StoryTheaterSettings, TheaterPresetSettings } from "./TheaterSettings";
import { inspirationCount, chooseInspiration } from "./inspiration";
import { memoryInterval, memoryReadLimit, memoryValid, roundLabel, selectRoundContext } from "./rounds";
import { memoryBatches, memoryRequestCount, scheduleAutomaticMemory } from "./round-memory";
import { cacheHitPercent } from "./prefix-cache";
import { useReadingLayout } from "./reading-layout";
import { sendChatMessage, replyChat, previewChat, pendingChatMessages, dismissChatBatch } from "./chat";
import { draftText, missingQuotes } from "./output";
import {
  uid,
  paragraphs,
  type Role,
  type Story,
  type WorldEntry,
  type SceneEvent,
  type Profile,
  type Preferences,
  type Memory,
  type ContextReport,
  type PromptKind,
  type StylePreset,
} from "./types";
import {
  run,
  stop,
  isBusy,
  extractFacts,
  organizeMemory,
  preview,
  adoptDraft,
} from "./engine";
import { ConnectionForm, protocols } from "./ConnectionForm";
import {
  StarterWelcome,
  StarterNav,
  StarterPage,
  ContextTip,
  FirstSceneCoach,
  StarterCelebration,
} from "./Onboarding";
import { useStarter, openStarter } from "./onboarding-state";
import brandMark from "./assets/cijian-avatar-v1.webp";
import { defaults } from "./prompts";
import {
  allStylePresets,
  builtInStylePresets,
  resolveStylePreset,
} from "./style-presets";
import { Modal } from "./Modal";
import { BackupSettings, StoryTransfer } from "./TransferPanels";
type Notice = (message: string) => void;
const date = (n: number) =>
  new Date(n).toLocaleString("zh-CN", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
function Avatar({ role, size = 44 }: { role?: Role; size?: number }) {
  return role?.avatar ? (
    <img
      className="avatar"
      style={{ width: size, height: size }}
      src={role.avatar}
      alt={role.name}
    />
  ) : (
    <span className="avatar" style={{ width: size, height: size }}>
      {role?.name.slice(0, 1) || "叶"}
    </span>
  );
}
function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
    </label>
  );
}
function Toggle({
  label,
  value,
  onChange,
}: {
  label: string;
  value: boolean;
  onChange: (v: boolean) => void;
}) {
  const [local, setLocal] = useState(value);
  useEffect(() => setLocal(value), [value]);
  return (
    <label className="toggle">
      <input
        type="checkbox"
        checked={local}
        onChange={(e) => {
          setLocal(e.target.checked);
          onChange(e.target.checked);
        }}
      />
      <span>{label}</span>
    </label>
  );
}
function PickRoles({
  roles,
  selected,
  onChange,
}: {
  roles: Role[];
  selected: string[];
  onChange: (s: string[]) => void;
}) {
  return (
    <div className="pick-roles">
      {roles.map((r) => (
        <button
          type="button"
          aria-label={r.name}
          className={selected.includes(r.id) ? "selected" : ""}
          key={r.id}
          onClick={() =>
            onChange(
              selected.includes(r.id)
                ? selected.filter((id) => id !== r.id)
                : [...selected, r.id],
            )
          }
        >
          <Avatar role={r} size={30} />
          {r.name}
          {selected.includes(r.id) && <Check size={14} />}
        </button>
      ))}
    </div>
  );
}
function Empty({ children }: { children: ReactNode }) {
  return (
    <div className="empty">
      <Leaf size={32} />
      <p>{children}</p>
    </div>
  );
}
export default function App() {
  const [route, setRoute] = useState(location.hash.slice(1) || "stories");
  const [notice, setNotice] = useState("");
  const [fatal, setFatal] = useState("");
  const [readingStory, setReadingStory] = useState("");
  const reading = !!readingStory && route === "story/" + readingStory;
  useEffect(() => {
    const fn = () => { setRoute(location.hash.slice(1) || "stories"); setReadingStory(""); };
    addEventListener("hashchange", fn);
    return () => removeEventListener("hashchange", fn);
  }, []);
  useEffect(() => {
    const handler = (e: PromiseRejectionEvent) => {
      setFatal(
        "未能保存或完成操作 · " + (e.reason?.message || String(e.reason)),
      );
      e.preventDefault();
    };
    addEventListener("unhandledrejection", handler);
    return () => removeEventListener("unhandledrejection", handler);
  }, []);
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(""), 6000);
    return () => clearTimeout(t);
  }, [notice]);
  const section =
    route.startsWith("story/") || route === "start" ? "stories" : route;
  const nav = [
    ["stories", "故事", BookOpen],
    ["roles", "角色", Users],
    ["world", "世界书", Leaf],
    ["settings", "设置", Settings],
  ] as const;
  return (
    <div className={"app" + (reading ? " is-reading" : "")}>
      <aside className="sidebar" data-guide="sidebar">
        <a className="brand" href="#stories">
          <img
            className="brand-mark"
            src={brandMark}
            alt=""
            width={48}
            height={48}
          />
          <strong>
            此间<small>角色小剧场</small>
          </strong>
        </a>
        <p className="sidebar-note">
          把故事留在
          <br />
          你想看的那一刻。
        </p>
        <nav>
          {nav.map(([id, label, Icon]) => (
            <a
              key={id}
              href={"#" + id}
              data-guide={id}
              className={section === id ? "active" : ""}
            >
              <Icon size={21} />
              <span>{label}</span>
            </a>
          ))}
        </nav>
        <StarterNav />
        <div className="local-note">
          <i /> 故事保存在这台设备
          <br />
          <small>偶尔备份，让记忆有处可寻。</small>
        </div>
      </aside>
      <main>
        {fatal && (
          <div className="error sticky" role="alert">
            {fatal}
            <button onClick={() => setFatal("")}>知道了</button>
          </div>
        )}
        {route === "start" ? (
          <StarterPage notify={setNotice} />
        ) : route.startsWith("story/") ? (
          <StoryPage key={route.slice(6)} id={route.slice(6)} notify={setNotice}
            reading={reading} onReadingChange={(value) => setReadingStory(value ? route.slice(6) : "")} />
        ) : section === "roles" ? (
          <RolesPage notify={setNotice} />
        ) : section === "world" ? (
          <WorldPage notify={setNotice} />
        ) : section === "settings" ? (
          <SettingsPage notify={setNotice} />
        ) : (
          <StoriesPage notify={setNotice} />
        )}
      </main>
      {notice && (
        <div className="toast" role="status">
          {notice}
        </div>
      )}
    </div>
  );
}
function StoriesPage({ notify }: { notify: Notice }) {
  const starter = useStarter();
  const showWelcome = starter.status === "new" || starter.status === "active";
  const stories =
    useLiveQuery(() => db.stories.orderBy("updated").reverse().toArray(), []) ||
    [];
  const roles = useLiveQuery(() => db.roles.toArray(), []) || [];
  const world = useLiveQuery(() => db.world.toArray(), []) || [];
  const [create, setCreate] = useState(false),
    [title, setTitle] = useState(""),
    [background, setBackground] = useState(""),
    [selected, setSelected] = useState<string[]>([]),
    [worldIds, setWorldIds] = useState<string[]>([]);
  return (
    <div className="page">
      <header className="page-heading">
        <div>
          <span className="eyebrow">A LITTLE ROOM FOR YOUR STORIES</span>
          <h1>故事在此间生长</h1>
          <p>你决定发生什么，让文字慢慢靠近那个瞬间。</p>
        </div>
        <button
          className="primary"
          data-guide="story-create"
          onClick={() => (roles.length ? setCreate(true) : openStarter(1))}
        >
          <Plus size={18} />
          开启一个故事
        </button>
      </header>
      {showWelcome ? (
        <StarterWelcome />
      ) : (
        <section className="hero">
          <div>
            <span className="eyebrow">只写这一刻 · 不替你决定后来</span>
            <h2>
              风经过书页，
              <br />
              他们正好在这里。
            </h2>
            <p>
              一段相遇，一句没说完的话。
              <br />
              用自己的角色，收藏想看的日常。
            </p>
            <button
              onClick={() => (roles.length ? setCreate(true) : openStarter(1))}
            >
              从一个念头开始 <Feather size={16} />
            </button>
          </div>
          <span className="hero-caption">青绿之间 / 此间手记</span>
        </section>
      )}
      <div className="section-title">
        <h2>
          我的故事 <small>{stories.length}</small>
        </h2>
        <span>每一本，都有独立的记忆</span>
      </div>
      <div className="story-grid">
        {stories.map((s, i) => (
          <a className="story-card" key={s.id} href={"#story/" + s.id}>
            <div className={"cover cover-" + (i % 3)}>
              <span>STORY {String(i + 1).padStart(2, "0")}</span>
              <BookOpen size={34} />
              <h3>{s.title}</h3>
            </div>
            <div className="card-body">
              <div className="avatar-stack">
                {s.roles.map((r) => (
                  <Avatar key={r.id} role={r} size={32} />
                ))}
                <span>{s.roles.map((r) => r.name).join(" · ")}</span>
              </div>
              <p>{s.background || "还没有写下开场，故事正等着你。"}</p>
              <footer>
                <span>{date(s.updated)}</span>
                <span>翻开故事 ↗</span>
              </footer>
            </div>
          </a>
        ))}
      </div>
      {!stories.length && <Empty>这里还空着，先开启一个故事吧。</Empty>}
      {create && (
        <Modal title="开启一个故事" onClose={() => setCreate(false)}>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              if (!selected.length) {
                notify("至少选一位角色");
                return;
              }
              const s = makeStory(
                title.trim(),
                roles.filter((r) => selected.includes(r.id)),
                worldIds,
                background,
              );
              await db.stories.add(s);
              location.hash = "story/" + s.id;
              setCreate(false);
            }}
          >
            <Field label="故事名字">
              <input
                autoFocus
                required
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="例如，雨停以前"
              />
            </Field>
            <Field label="这次与谁相遇">
              <PickRoles
                roles={roles}
                selected={selected}
                onChange={setSelected}
              />
            </Field>
            {!roles.length && <a href="#roles">先去添加角色</a>}
            <Field label="开场背景 · 仅作者视角可读">
              <textarea
                value={background}
                onChange={(e) => setBackground(e.target.value)}
                placeholder="时间、地点，他们此刻的关系……"
              />
            </Field>
            <Field label="带入世界书">
              {world.map((w) => (
                <Toggle
                  key={w.id}
                  label={w.title}
                  value={worldIds.includes(w.id)}
                  onChange={(v) =>
                    setWorldIds(
                      v
                        ? [...worldIds, w.id]
                        : worldIds.filter((id) => id !== w.id),
                    )
                  }
                />
              ))}
            </Field>
            <p className="hint">
              故事会保存角色当前的人设副本，之后修改角色库不会改变这里。
            </p>
            <button className="primary" type="submit">
              翻开第一页
            </button>
          </form>
        </Modal>
      )}
    </div>
  );
}
function RoleEditor({
  value,
  onSave,
  onClose,
  onDraftChange,
}: {
  value: Role;
  onSave: (r: Role) => Promise<void>;
  onClose: () => void;
  onDraftChange?: (r: Role) => Promise<unknown>;
}) {
  const [r, setR] = useState(() => structuredClone(value));
  const current = useRef(r);
  const revision = useRef(0);
  const submitting = useRef(false);
  const pendingFiles = useRef(0);
  const [busy, setBusy] = useState(false);
  const [reading, setReading] = useState(false);
  const [error, setError] = useState("");
  const [draftStatus, setDraftStatus] = useState<
    "idle" | "saving" | "saved" | "error"
  >("idle");
  const update = (patch: Partial<Role> | ((role: Role) => Partial<Role>)) => {
    if (submitting.current) return;
    const next = {
      ...current.current,
      ...(typeof patch === "function" ? patch(current.current) : patch),
    };
    current.current = next;
    setR(next);
    setError("");
    if (onDraftChange) {
      const edit = ++revision.current;
      setDraftStatus("saving");
      onDraftChange(next).then(
        () => {
          if (edit === revision.current) setDraftStatus("saved");
        },
        () => {
          if (edit === revision.current) setDraftStatus("error");
        },
      );
    }
  };
  const readFile = async (file: File, avatar = false) => {
    pendingFiles.current += 1;
    setReading(true);
    setError("");
    try {
      if (avatar) {
        if (!file.type.startsWith("image/")) throw Error("请选择图片");
        const data = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result));
          reader.onerror = () => reject(reader.error);
          reader.onabort = () => reject(Error("图片读取已中断"));
          reader.readAsDataURL(file);
        });
        update({ avatar: data });
      } else {
        const persona = await file.text();
        update((latest) => ({
          persona,
          paragraphs: paragraphs(persona, latest.paragraphs),
        }));
      }
    } catch {
      setError("文件没能读取，请重新选择。已填写的内容仍在这里。");
    } finally {
      pendingFiles.current -= 1;
      setReading(pendingFiles.current > 0);
    }
  };
  return (
    <Modal
      title={"角色档案 · " + (value.name || "新朋友")}
      onClose={() => {
        if (!submitting.current && !pendingFiles.current) onClose();
      }}
    >
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (submitting.current || pendingFiles.current) return;
          submitting.current = true;
          setBusy(true);
          setError("");
          try {
            await onSave({ ...current.current, updated: Date.now() });
            onClose();
          } catch {
            setError("角色没能保存，请重试。填写的内容和已有草稿都会保留。");
          } finally {
            submitting.current = false;
            setBusy(false);
          }
        }}
      >
        {onDraftChange && (
          <p
            className={
              draftStatus === "error" ? "error" : "hint role-draft-status"
            }
            role={draftStatus === "error" ? "alert" : "status"}
          >
            {draftStatus === "saving"
              ? "正在保存草稿…"
              : draftStatus === "saved"
                ? "草稿已自动保存，关闭后可继续填写。保存角色后会清除这份草稿。"
                : draftStatus === "error"
                  ? "草稿暂时没能保存，请先不要关闭窗口，可以点击「保存角色」重试。"
                  : "输入会自动保存为草稿，关闭后可继续填写。保存角色后，下次创建会从空白开始。"}
          </p>
        )}
        <fieldset className="role-editor-fields" disabled={busy}>
          <div className="role-top">
            <Avatar role={r} size={68} />
            <Field label="头像">
              <input
                type="file"
                accept="image/*"
                disabled={reading}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void readFile(f, true);
                  e.target.value = "";
                }}
              />
            </Field>
          </div>
          <Field label="名字">
            <input
              required
              value={r.name}
              onChange={(e) => update({ name: e.target.value })}
            />
          </Field>
          <Field label="公开简介 · 其他角色可以看到">
            <textarea
              value={r.bio}
              onChange={(e) => update({ bio: e.target.value })}
            />
          </Field>
          <Field label="导入 TXT / Markdown 人设">
            <input
              type="file"
              accept=".txt,.md,.markdown,text/plain,text/markdown"
              disabled={reading}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void readFile(f);
                e.target.value = "";
              }}
            />
          </Field>
          <Field label="完整人设 · 原文完整保存">
            <textarea
              className="long-text"
              value={r.persona}
              onChange={(e) =>
                update({
                  persona: e.target.value,
                  paragraphs: paragraphs(e.target.value, r.paragraphs),
                })
              }
              placeholder="自由书写，以空行分段。私密内容默认不向其他角色公开。"
            />
          </Field>
          <p className="hint">
            {r.persona.length.toLocaleString()} 字符 ·
            不设输入字数门槛。每次必读仍受模型容量限制。
          </p>
          <details>
            <summary>逐段设置必读 / 公开（{r.paragraphs.length} 段）</summary>
            {r.paragraphs.map((p, i) => (
              <div className="paragraph" key={p.id}>
                <p>{p.text}</p>
                <Toggle
                  label="每次必读"
                  value={p.pin}
                  onChange={(v) =>
                    update({
                      paragraphs: r.paragraphs.map((x, j) =>
                        j === i ? { ...x, pin: v } : x,
                      ),
                    })
                  }
                />
                <Toggle
                  label="对其他角色公开"
                  value={p.public}
                  onChange={(v) =>
                    update({
                      paragraphs: r.paragraphs.map((x, j) =>
                        j === i ? { ...x, public: v } : x,
                      ),
                    })
                  }
                />
              </div>
            ))}
          </details>
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          <button disabled={busy || reading} className="primary" type="submit">
            {busy ? "保存中…" : reading ? "正在读取文件…" : "保存角色"}
          </button>
        </fieldset>
      </form>
    </Modal>
  );
}
function RolesPage({ notify }: { notify: Notice }) {
  const roles = useLiveQuery(() => db.roles.toArray(), []) || [];
  const [editing, setEditing] = useState<{ role: Role; creating: boolean }>();
  const [opening, setOpening] = useState(false);
  return (
    <div className="page">
      <header className="page-heading">
        <div>
          <span className="eyebrow">PEOPLE BETWEEN THE PAGES</span>
          <h1>与你相遇的人</h1>
          <p>名字之外，他们还有许多没说出口的事情。</p>
        </div>
        <button
          className="primary"
          disabled={opening}
          onClick={async () => {
            setOpening(true);
            try {
              const draft = await loadRoleDraft();
              setEditing({
                creating: true,
                role: draft || {
                  id: uid(),
                  name: "",
                  bio: "",
                  persona: "",
                  avatar: "",
                  paragraphs: [],
                  updated: Date.now(),
                },
              });
            } catch {
              notify("角色草稿暂时没能读取，请重试，已有草稿不会被覆盖。");
            } finally {
              setOpening(false);
            }
          }}
        >
          <Plus size={18} />
          添加角色
        </button>
      </header>
      <div className="role-grid">
        {roles.map((r) => (
          <article className="role-card" key={r.id}>
            <div className="role-banner" />
            <Avatar role={r} size={76} />
            <h2>{r.name}</h2>
            <p>{r.bio || "这位朋友还没有写下简介。"}</p>
            <div className="card-actions">
              <button onClick={() => setEditing({ role: r, creating: false })}>
                翻开档案
              </button>
              <button
                aria-label={"删除" + r.name}
                onClick={async () => {
                  if (
                    confirm(
                      "删除角色库中的 " + r.name + "？已建立的故事副本会保留。",
                    )
                  ) {
                    await db.roles.delete(r.id);
                    notify("角色库档案已删除，故事中的副本仍在。");
                  }
                }}
              >
                <Trash2 size={16} />
              </button>
            </div>
          </article>
        ))}
      </div>
      {editing && (
        <RoleEditor
          value={editing.role}
          onDraftChange={editing.creating ? saveRoleDraft : undefined}
          onClose={() => setEditing(undefined)}
          onSave={async (r) => {
            if (editing.creating) await saveCreatedRole(r);
            else await db.roles.put(r);
            notify("角色已保存");
          }}
        />
      )}
    </div>
  );
}
function WorldPage({ notify }: { notify: Notice }) {
  const entries = useLiveQuery(() => db.world.toArray(), []) || [],
    roles = useLiveQuery(() => db.roles.toArray(), []) || [],
    stories = useLiveQuery(() => db.stories.toArray(), []) || [];
  const [edit, setEdit] = useState<WorldEntry>();
  const names = {
    world: "世界观",
    relationship: "关系与往事",
    rule: "语言与行为",
    fact: "当前故事事实",
  };
  return (
    <div className="page">
      <header className="page-heading">
        <div>
          <span className="eyebrow">THINGS WORTH REMEMBERING</span>
          <h1>世界的一角</h1>
          <p>让约定有迹可循，让秘密只被该知道的人知道。</p>
        </div>
        <button
          className="primary"
          onClick={() =>
            setEdit({
              id: uid(),
              title: "",
              text: "",
              type: "world",
              enabled: true,
              always: true,
              keywords: [],
              roleIds: [],
              storyIds: [],
              knownBy: [],
              audience: "all",
            })
          }
        >
          <Plus size={18} />
          写一条设定
        </button>
      </header>
      <div className="world-list">
        {entries.map((w) => (
          <article className="world-card" key={w.id}>
            <div className="world-icon">
              <Leaf />
            </div>
            <div>
              <span className="tag">
                {names[w.type]} ·{" "}
                {w.audience === "all"
                  ? "所有角色可知"
                  : w.audience === "author"
                    ? "仅作者可见"
                    : "指定角色可知"}
              </span>
              <h2>{w.title}</h2>
              <p>{w.text}</p>
              <span className="hint">
                {w.always
                  ? "每次带入"
                  : `关键词触发 · ${w.keywords.join("、")}`}
              </span>
            </div>
            <div className="vertical-actions">
              <Toggle
                label="启用"
                value={w.enabled}
                onChange={async (v) => {
                  await db.world.update(w.id, { enabled: v });
                }}
              />
              <button onClick={() => setEdit(w)}>编辑</button>
              <button
                aria-label={"删除" + w.title}
                onClick={async () => {
                  if (confirm("删除这条世界书设定？"))
                    await db.world.delete(w.id);
                }}
              >
                <Trash2 size={16} />
              </button>
            </div>
          </article>
        ))}
      </div>
      {!entries.length && (
        <Empty>一座城、一件往事，或者一句不能忘记的话。</Empty>
      )}
      {edit && (
        <Modal title="世界书设定" onClose={() => setEdit(undefined)}>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              await db.world.put(edit);
              setEdit(undefined);
              notify("设定已保存，绑定它的故事会使用新版本");
            }}
          >
            <Field label="标题">
              <input
                required
                value={edit.title}
                onChange={(e) => setEdit({ ...edit, title: e.target.value })}
              />
            </Field>
            <Field label="类型">
              <select
                value={edit.type}
                onChange={(e) =>
                  setEdit({
                    ...edit,
                    type: e.target.value as WorldEntry["type"],
                  })
                }
              >
                {Object.entries(names).map(([v, n]) => (
                  <option key={v} value={v}>
                    {n}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="设定正文">
              <textarea
                required
                className="long-text"
                value={edit.text}
                onChange={(e) => setEdit({ ...edit, text: e.target.value })}
              />
            </Field>
            <Field label="谁可以知道">
              <select
                value={edit.audience}
                onChange={(e) =>
                  setEdit({
                    ...edit,
                    audience: e.target.value as WorldEntry["audience"],
                  })
                }
              >
                <option value="all">所有参与角色</option>
                <option value="roles">指定角色</option>
                <option value="author">仅作者</option>
              </select>
            </Field>
            {edit.audience === "roles" && (
              <PickRoles
                roles={roles}
                selected={edit.knownBy}
                onChange={(knownBy) => setEdit({ ...edit, knownBy })}
              />
            )}
            <details>
              <summary>作用范围（留空表示不限）</summary>
              <Field label="涉及的角色">
                <PickRoles
                  roles={roles}
                  selected={edit.roleIds}
                  onChange={(roleIds) => setEdit({ ...edit, roleIds })}
                />
              </Field>
              <Toggle
                label="所有指定角色同时参与时才生效"
                value={edit.match === "all"}
                onChange={(v) => setEdit({ ...edit, match: v ? "all" : "any" })}
              />
              <Field label="仅限故事">
                {stories.map((s) => (
                  <Toggle
                    key={s.id}
                    label={s.title}
                    value={edit.storyIds.includes(s.id)}
                    onChange={(v) =>
                      setEdit({
                        ...edit,
                        storyIds: v
                          ? [...edit.storyIds, s.id]
                          : edit.storyIds.filter((id) => id !== s.id),
                      })
                    }
                  />
                ))}
              </Field>
            </details>
            <Toggle
              label="常驻 · 每次必读"
              value={edit.always}
              onChange={(always) => setEdit({ ...edit, always })}
            />
            {!edit.always && (
              <Field label="触发关键词 · 逗号分隔">
                <input
                  value={edit.keywords.join(",")}
                  onChange={(e) =>
                    setEdit({
                      ...edit,
                      keywords: e.target.value
                        .split(/[,，]/)
                        .map((s) => s.trim()),
                    })
                  }
                />
              </Field>
            )}
            <button className="primary">保存设定</button>
          </form>
        </Modal>
      )}
    </div>
  );
}
function Reference({
  report,
  developer = false,
}: {
  report: ContextReport;
  developer?: boolean;
}) {
  const hitPercent = cacheHitPercent(report.usage);
  const reuseLabels = {
    first: "本次建立多轮前缀",
    window: "原文窗口已滚动，已移除窗口外原文并重新整理前缀",
    selection: "参考记忆选择改变，已重新整理前缀",
    continued: "已原样保留前轮请求与回复，新内容追加在末尾",
    settings: "设定或模型配置改变，已重新整理前缀",
    history: "历史内容或知情范围改变，已重新整理前缀",
    capacity: "已接近上下文容量，重新整理了历史",
    rewrite: "本次是重写或重试，已按原时间点重新整理",
  };
  return (
    <div>
      <p className="hint">
        本地估算 {report.estimate.toLocaleString()} /{" "}
        {report.limit.toLocaleString()} token
        {report.usage &&
          ` · 服务实际用量 输入 ${report.usage.input ?? "未返回"} / 输出 ${report.usage.output ?? "未返回"}`}
      </p>
      {report.history && (
        <p className="hint">
          {report.history.rounds ? `原文窗口 ${report.history.rounds.length} / ${report.history.limit} 回合 · ${roundLabel(report.history.rounds)}，正文与聊天合计。` : "这是升级前保存的参考记录，新请求将采用20回合上限。"}
        </p>
      )}
      {report.memoryContext && <p className="hint">本次选中 {report.memoryContext.selected.length} 条记忆{report.memoryContext.selectionToken ? " · 使用一次性选择" : ` · 自动读取上限 ${report.memoryContext.automaticLimit} 条`}。
        {report.memoryContext.gaps.length > 0 && ` ${roundLabel(report.memoryContext.gaps)}未被所选记忆完整覆盖。`}</p>}
      {report.materialTokens && <p className="hint">本地分项估算 · 设定 {report.materialTokens.settings} · 记忆 {report.materialTokens.memories} · 原文 {report.materialTokens.history} · 规则与本次输入 {report.materialTokens.task} token</p>}
      {developer && (
        <div className="reference-metrics">
          <p>
            缓存命中{" "}
            {report.usage?.cachedInput === undefined
              ? "服务未返回"
              : `${report.usage.cachedInput.toLocaleString()} token`}
            {hitPercent === undefined ? "" : ` · 命中率 ${hitPercent}%`}
          </p>
          <p>
            缓存未命中{" "}
            {report.usage?.uncachedInput === undefined
              ? "服务未返回"
              : `${report.usage.uncachedInput.toLocaleString()} token`}
          </p>
          <p>
            缓存写入{" "}
            {report.usage?.cacheWriteInput === undefined
              ? "服务未返回"
              : `${report.usage.cacheWriteInput.toLocaleString()} token`}{" "}
            · 请求耗时{" "}
            {report.durationMs === undefined
              ? "暂无记录"
              : `${(report.durationMs / 1000).toFixed(1)} 秒`}
          </p>
          {report.prefixReuse && <p>{reuseLabels[report.prefixReuse.state]}
            {report.prefixReuse.retainedMessages > 0 && `（${report.prefixReuse.retainedMessages} 条请求消息）`}。</p>}
          <p className="hint">
            命中统计来自本次接口响应。DeepSeek 命中率按命中 /（命中 + 未命中）计算；未命中不代表缓存写入。保留前缀不等于服务已命中，缓存建立与过期由服务管理。
          </p>
        </div>
      )}
      <h3>实际带入 {report.included.length} 项</h3>
      {report.included.map((m) => (
        <details key={m.id}>
          <summary>
            {m.label}
            {m.mandatory ? " · 必读" : ""}
          </summary>
          <pre>{m.text}</pre>
        </details>
      ))}
      <h3>因容量省略 {report.omitted.length} 项</h3>
      {report.omitted.map((m) => (
        <details key={m.id}>
          <summary>{m.label}</summary>
          <pre>{m.text}</pre>
        </details>
      ))}
      {developer && (
        <details>
          <summary>最终请求文本（不含密钥）</summary>
          <pre>{report.messages ? JSON.stringify(report.messages, null, 2) : report.system + "\n\n" + report.user}</pre>
        </details>
      )}
    </div>
  );
}
function DraftReview({
  event,
  onClose,
  onAdopted,
}: {
  event: SceneEvent;
  onClose: () => void;
  onAdopted: () => void;
}) {
  const [text, setText] = useState(event.text || draftText(event.raw));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const prefs = useLiveQuery(() => db.preferences.get("preferences"), []);
  const missing = prefs?.dialogueCheck ? missingQuotes(event.input, text) : [];
  return (
    <Modal
      title="检查草稿并采用"
      onClose={() => {
        if (!saving) onClose();
      }}
    >
      <p>
        请先读一遍，按你的想法修改。确认后，这段文字会成为正式正文，供后续生成参考。
      </p>
      {event.rewriteOf && (
        <p className="review">
          这是一份重写草稿，采用后将替换对应原文，并保留旧版本。后续经历会标记为待复核。
        </p>
      )}
      <p className="error">
        {event.error || "这次生成没有完整通过检查，请确认文字是否完整。"}
      </p>
      <details>
        <summary>查看本次输入</summary>
        <pre>{event.input}</pre>
      </details>
      <label className="field">
        <span>准备采用的正文</span>
        <textarea
          className="long-text"
          value={text}
          disabled={saving}
          onChange={(e) => setText(e.target.value)}
        />
      </label>
      {missing.length > 0 && (
        <div className="review">
          <p>
            以下台词仍可能被改动或遗漏。你可以补回，也可以按当前文字确认采用。
          </p>
          {missing.map((q, i) => (
            <p key={i}>「{q}」</p>
          ))}
        </div>
      )}
      <EventRawOutput event={event} />
      <p className="hint">
        采用操作不会调用
        AI。角色知情事实先留空，可以之后用「摘录事实」整理并确认。
      </p>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="row">
        <button
          className="primary"
          disabled={saving || !text.trim()}
          onClick={async () => {
            setSaving(true);
            setError("");
            try {
              await adoptDraft(event.id, text, event.versionId, event.raw);
              onAdopted();
            } catch (e) {
              setError(e instanceof Error ? e.message : String(e));
            } finally {
              setSaving(false);
            }
          }}
        >
          {saving ? "正在采用…" : "我同意，采用为正文"}
        </button>
        <button disabled={saving} onClick={onClose}>
          先保留草稿
        </button>
      </div>
    </Modal>
  );
}
function EventEditor({
  event,
  story,
  onClose,
}: {
  event: SceneEvent;
  story: Story;
  onClose: () => void;
}) {
  const [text, setText] = useState(event.text),
    [facts, setFacts] = useState(structuredClone(event.facts));
  const [visibility, setVisibility] = useState(event.visibility || "inherit");
  const [error, setError] = useState("");
  return (
    <Modal title="修改这一刻" onClose={onClose}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          try { await reviseEvent(
            event.id,
            text,
            false,
            facts.filter((f) => f.quote.trim() && text.includes(f.quote)),
            event.versionId,
            visibility,
          );
          onClose(); } catch (error) { setError(String(error)); }
        }}
      >
        <p className="hint">
          旧版本与后文都会保留。只调整知情范围不会把后文全部标为待复核。
        </p>
        <Field label="正文 / 消息">
          <textarea
            className="long-text"
            required
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
        </Field>
        {event.kind === "novel" && (
          <>
            <Field label="本段如何进入手机聊天">
              <select value={visibility} onChange={(e) => setVisibility(e.target.value as typeof visibility)}>
                <option value="inherit">跟随故事设置{sharedTimeline(story) ? " · 自动互通" : " · 严格知情"}</option>
                <option value="author">私密段落 · 仅作者可见</option>
                <option value="facts">仅共享下方授权的事实</option>
              </select>
            </Field>
            <p className="hint">普通正文在自动互通模式下会进入聊天参考。含秘密或内心独白的段落，可以整段设为私密，或只共享选中的事实。</p>
            <details open={visibility === "facts" || (!sharedTimeline(story) && visibility === "inherit")}>
              <summary>高级 · 角色可知的事实摘录</summary>
            <h3>角色可知的事实摘录</h3>
            <p className="hint">
              选择“仅共享下方授权的事实”或使用严格知情模式时，以下授权才控制本段的聊天参考。摘录必须逐字来自正文。
            </p>
            {facts.map((f, i) => (
              <div className="paragraph" key={f.id}>
                <Field label="原文摘录">
                  <textarea
                    value={f.quote}
                    onChange={(e) =>
                      setFacts(
                        facts.map((x, j) =>
                          i === j
                            ? {
                                ...x,
                                quote: e.target.value,
                                text: e.target.value,
                              }
                            : x,
                        ),
                      )
                    }
                  />
                </Field>
                {!text.includes(f.quote) && (
                  <p className="error">摘录不在原文中，保存时不会采用。</p>
                )}
                <span className="hint">
                  {f.knownBy.length ? "以下角色知道" : "仅作者可见"}
                </span>
                <PickRoles
                  roles={story.roles}
                  selected={f.knownBy}
                  onChange={(knownBy) =>
                    setFacts(
                      facts.map((x, j) => (i === j ? { ...x, knownBy } : x)),
                    )
                  }
                />
                <button
                  type="button"
                  onClick={() => setFacts(facts.filter((_, j) => i !== j))}
                >
                  移除摘录
                </button>
              </div>
            ))}
            <button
              type="button"
              onClick={() =>
                setFacts([
                  ...facts,
                  { id: uid(), text: "", quote: "", knownBy: [] },
                ])
              }
            >
              <Plus size={16} />
              添加原文摘录
            </button>
            </details>
          </>
        )}
        {error && <p className="error">{error}</p>}
        <button className="primary" type="submit">
          保存新版本
        </button>
      </form>
    </Modal>
  );
}
function Memories({
  s,
  mode,
  notify,
  onClose,
}: {
  s: Story;
  mode: "novel" | "chat";
  notify: Notice;
  onClose: () => void;
}) {
  const items =
    useLiveQuery(
      () => db.memories.where("storyId").equals(s.id).toArray(),
      [s.id],
    ) || [];
  const events =
    useLiveQuery(
      () => db.events.where("storyId").equals(s.id).toArray(),
      [s.id],
    ) || [];
  const prefs = useLiveQuery(() => db.preferences.get("preferences"), []) || { id: "preferences" as const, activeProfile: "", developer: false, prompts: {} };
  const profile = useLiveQuery(() => db.profiles.get(prefs.activeProfile), [prefs.activeProfile]);
  const [viewMode, setViewMode] = useState(mode);
  const [showLegacy, setShowLegacy] = useState(false);
  const [localChoice, setLocalChoice] = useState<Story["memorySelection"]>();
  useEffect(() => {
    if (localChoice && s.memorySelection?.token === localChoice.token) setLocalChoice(undefined);
  }, [s.memorySelection?.token, localChoice?.token]);
  const selection = selectRoundContext({ ...s, memorySelection: localChoice || s.memorySelection }, events, items, prefs, viewMode === "chat" ? s.partner : undefined);
  const selectedIds = selection.selected.map((m) => m.id);
  const batches = memoryBatches(s, events, items, prefs, true);
  const requests = memoryRequestCount(s, batches, prefs, profile);
  async function toggleMemory(id: string, checked: boolean) {
    const ids = checked ? [...new Set([...selectedIds, id])] : selectedIds.filter((x) => x !== id);
    const choice = { token: uid(), ids };
    setLocalChoice(choice);
    try { await db.stories.update(s.id, { memorySelection: choice }); }
    catch (error) { setLocalChoice((current) => current?.token === choice.token ? undefined : current); throw error; }
  }
  const [editing, setEditing] = useState<Memory>();
  const [mergedIds, setMergedIds] = useState<string[]>([]);
  const [tab, setTab] = useState<"memory" | "facts">("memory");
  useEffect(() => setMergedIds([]), [editing?.id]);
  const [busy, setBusy] = useState(false);
  const facts = events
    .filter((event) => event.kind === "novel" && event.status === "complete" && !event.deleted)
    .flatMap((event) => event.facts.map((fact) => ({ event, fact })));
  async function accept(m: Memory) {
    const valid = m.sources.every((src) => {
      const e = events.find((x) => x.id === src.id);
      return e && !e.deleted && e.status === "complete" && e.versionId === src.versionId;
    });
    if (!valid) { notify("来源已改变，请重新提炼，不能直接确认旧记忆。"); return; }
    await db.memories.put({
      ...m,
      status: "accepted",
    });
    notify("记忆已确认，将按知情范围带入后续生成");
  }
  return (
    <Modal title="记忆中心" onClose={onClose}>
      <div className="memory-tabs" role="tablist" aria-label="记忆中心分类">
        <button
          type="button"
          role="tab"
          aria-selected={tab === "memory"}
          className={tab === "memory" ? "active" : ""}
          onClick={() => setTab("memory")}
        >
          故事记忆 ({items.filter((item) => item.status !== "ignored").length})
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "facts"}
          className={tab === "facts" ? "active" : ""}
          onClick={() => setTab("facts")}
        >
          原文事实 ({facts.length})
        </button>
      </div>
      {tab === "memory" ? (
        <>
      <ContextTip id="memory" title="回合记忆，按需带入">
        <p>每 {memoryInterval(prefs)} 回合自动提炼一段连贯小结，默认读取最近 {memoryReadLimit(prefs)} 条可用记忆。近期原文合计最多20回；更早的经历通过记忆衔接。</p>
      </ContextTip>
      <div className="row">
        <Field label="查看下次参考记忆">
          <select value={viewMode} onChange={(e) => setViewMode(e.target.value as "novel" | "chat")}>
            <option value="novel">正文</option><option value="chat">当前角色聊天</option>
          </select>
        </Field>
        <button disabled={!s.memorySelection} onClick={() => db.stories.update(s.id, { memorySelection: undefined })}>恢复默认选择</button>
      </div>
      <p className="hint" role="status">下次将带入 {selectedIds.length} 条记忆。{s.memorySelection ? "已临时调整：下一次成功回复后恢复默认；失败或取消会保留。" : "正在使用自动选择。勾选可临时增减，仅影响下一次正文或聊天回复。"}</p>
      {selection.gaps.length > 0 && <p className="hint">{roundLabel(selection.gaps)}未被所选记忆完整覆盖；可勾选已有记忆或一键补齐。</p>}
      <div className="row">
        <button disabled={busy || isBusy(s.id) || !batches.length} className="primary" onClick={async () => {
          setBusy(true);
          try { await organizeMemory(s.id); notify("回合记忆已补齐。"); }
          catch (e) { notify(String(e)); }
          finally { setBusy(false); }
        }}><RefreshCw size={16} />{busy || s.memoryState === "running" ? "记忆整理中…" : "一键补齐回合记忆"}</button>
        {(busy || s.memoryState === "running") && <button onClick={() => stop(s.id)}>停止整理</button>}
      </div>
      <p className="hint">待整理 {roundLabel(batches.flatMap((b) => b.rounds))} · {batches.length} 批 · {requests === undefined ? "当前容量不足，请调整接口设置" : `预计至少 ${requests} 次请求`}。分批合并可能增加请求；关闭页面或停止后，已完成批次保留。</p>
      {s.memoryError && <p className="error">{s.memoryError} 写作仍可继续。</p>}
      <details><summary>自动记忆设置</summary>
        <Toggle label="自动提炼回合记忆（页面打开时运行）" value={s.autoMemory} onChange={async (v) => {
          await db.stories.update(s.id, { autoMemory: v });
          if (v) scheduleAutomaticMemory(s.id);
        }} />
        <p className="hint">提炼频率和自动读取数量可在设置的开发者模式中修改。已被重写或删除的来源不会继续使用。</p>
      </details>
      {items.some((m) => m.automatic) && <Toggle label="显示旧版自动摘记（不自动带入）" value={showLegacy} onChange={setShowLegacy} />}
      {items
        .filter((m) => m.status !== "ignored" && (!m.automatic || showLegacy))
        .sort((a, b) => Math.max(0, ...(b.rounds || [])) - Math.max(0, ...(a.rounds || [])) || b.created - a.created)
        .map((m) => (
          <article className="memory-card" key={m.id}>
            <h3>{m.kind === "round" ? `${roundLabel(m.rounds || [])}记忆` : m.automatic ? "旧版自动摘记" : "故事记忆"}</h3>
            <label className="memory-select"><input type="checkbox" checked={selectedIds.includes(m.id)}
              disabled={!selection.eligible.some((x) => x.id === m.id)}
              onChange={(e) => void toggleMemory(m.id, e.target.checked).catch(() => notify("记忆选择保存失败，请重试。"))} />下次带入这条记忆</label>
            {!selectedIds.includes(m.id) && <p className="hint">{selection.eligible.some((x) => x.id === m.id) ? "未自动选择：近期原文已覆盖，或超出自动读取数量；可手动勾选。" : "不参与当前请求：旧摘记、来源失效、待确认或当前角色不可知。"}</p>}
            <span className="tag">
              {
                {
                  candidate: "待确认",
                  accepted: "已记住",
                  invalid: "来源已改变 · 候选失效",
                  review: "需要复核 · 暂停使用",
                  ignored: "已忽略",
                }[m.status]
              }
            </span>
            {m.automatic && <span className="tag">自动摘记</span>}
            <p>{m.text}</p>
            <p className="hint">
              {m.knownBy.length
                ? m.knownBy
                    .map((id) => s.roles.find((r) => r.id === id)?.name)
                    .join("、") + " 可知"
                : "仅作者可见"}
            </p>
            <details>
              <summary>查看来源（{m.sources.length}）</summary>
              {m.sources.map((src) => (
                <blockquote key={src.id}>
                  {events
                    .find((e) => e.id === src.id)
                    ?.versions.find((v) => v.id === src.versionId)?.text ||
                    "原版本不存在"}
                </blockquote>
              ))}
            </details>
            <div className="row">
              <button onClick={() => setEditing(m)}>修改 / 知情范围</button>
              {!m.automatic && m.status !== "accepted" && memoryValid({ ...m, status: "accepted" }, s, events) && (
                <button onClick={() => accept(m)}>
                  确认记忆
                </button>
              )}
              <button
                onClick={async () => {
                  await db.memories.update(m.id, { status: "ignored" });
                }}
              >
                忽略
              </button>
            </div>
          </article>
        ))}
      {!items.length && <Empty>聊一会儿，或者写下几个片段，再来整理吧。</Empty>}
      {editing && (
        <div className="inline-editor">
          <h3>编辑记忆</h3>
          <textarea
            value={editing.text}
            onChange={(e) => setEditing({ ...editing, text: e.target.value })}
          />
          <PickRoles
            roles={s.roles}
            selected={editing.knownBy}
            onChange={(knownBy) => setEditing({ ...editing, knownBy })}
          />
          <Field label="作用范围">
            <select
              value={editing.scope}
              onChange={(e) =>
                setEditing({
                  ...editing,
                  scope: e.target.value as Memory["scope"],
                })
              }
            >
              <option value="story">当前故事</option>
              <option value="roles">知情角色</option>
            </select>
          </Field>
          <Field label="合并到另一条记忆（可选）">
            <select
              defaultValue=""
              onChange={(e) => {
                const target = items.find((m) => m.id === e.target.value);
                if (target)
                  setMergedIds((ids) => [...new Set([...ids, target.id])]);
                if (target)
                  setEditing({
                    ...editing,
                    text: target.text + "\n" + editing.text,
                    rounds: [...new Set([...(target.rounds || []), ...(editing.rounds || [])])].sort((a, b) => a - b),
                    batchRounds: [...new Set([...(target.batchRounds || []), ...(editing.batchRounds || [])])].sort((a, b) => a - b),
                    sources: [...target.sources, ...editing.sources].filter(
                      (x, i, a) => a.findIndex((y) => y.id === x.id) === i,
                    ),
                    knownBy: editing.knownBy.filter((id) =>
                      target.knownBy.includes(id),
                    ),
                  });
              }}
            >
              <option value="">选择内容合并到当前候选</option>
              {items
                .filter(
                  (m) =>
                    m.id !== editing.id &&
                    m.status !== "invalid" &&
                    m.status !== "ignored",
                )
                .map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.text.slice(0, 45)}
                  </option>
                ))}
            </select>
          </Field>
          <button
            className="primary"
            onClick={async () => {
              await db.transaction("rw", db.memories, async () => {
                await db.memories.put({
                  ...editing,
                  automatic: false,
                  status:
                    sharedTimeline(s) && editing.status === "accepted" && !mergedIds.length ? "accepted" : editing.status === "accepted" || mergedIds.length
                      ? "review"
                      : editing.status,
                });
                for (const id of mergedIds)
                  await db.memories.update(id, { status: "ignored" });
              });
              setEditing(undefined);
            }}
          >
            保存修改
          </button>
          <button onClick={() => setEditing(undefined)}>取消</button>
        </div>
      )}
        </>
      ) : (
        <section className="fact-center">
          <p className="hint">
            这里用于严格知情模式和单段权限微调。自动互通模式下，普通正文无需逐条摘录或授权；私密段落可在原文编辑中单独设置。
          </p>
          {facts.map(({ event, fact }) => (
            <article className="memory-card" key={fact.id}>
              <span className="tag">正文第 {event.seq} 段</span>
              <p>{fact.quote}</p>
              <p className="hint">
                {fact.knownBy.length
                  ? fact.knownBy
                      .map((id) => s.roles.find((role) => role.id === id)?.name)
                      .join("、") + " 可知"
                  : "仅作者可见"}
              </p>
              <p className="hint">请在对应正文段落的「编辑」中修改摘录和知情范围。</p>
            </article>
          ))}
          {!facts.length && <Empty>先写下一段正文，再从段落中摘录可核对的事实。</Empty>}
        </section>
      )}
    </Modal>
  );
}
function StoryHealth({
  story,
  events,
  memories,
  readyModel,
  failedChats,
}: {
  story: Story;
  events: SceneEvent[];
  memories: Memory[];
  readyModel: boolean;
  failedChats: number;
}) {
  const issues = [
    !readyModel && "还没有选用可用的模型接口",
    !story.roles.length && "故事还没有角色",
    events.filter((event) => event.status === "draft" && !event.deleted).length > 0 &&
      `有 ${events.filter((event) => event.status === "draft" && !event.deleted).length} 条未完成草稿`,
    !sharedTimeline(story) && events.filter((event) => event.review && !event.deleted).length > 0 &&
      `有 ${events.filter((event) => event.review && !event.deleted).length} 段内容待复核`,
    memories.filter((memory) => memory.status === "review" || memory.status === "invalid").length > 0 &&
      `有 ${memories.filter((memory) => memory.status === "review" || memory.status === "invalid").length} 条记忆需要处理`,
    story.memoryState === "failed" && "故事记忆上次整理失败",
    failedChats > 0 && `有 ${failedChats} 组手机回复待重试`,
  ].filter(Boolean) as string[];
  return (
    <details className="story-health">
      <summary>
        {issues.length ? <AlertTriangle size={15} /> : <CheckCircle2 size={15} />}
        故事状态 {issues.length ? `· ${issues.length} 项待处理` : "· 当前正常"}
      </summary>
      {issues.length ? (
        <ul>
          {issues.map((issue) => <li key={issue}>{issue}</li>)}
        </ul>
      ) : (
        <p className="hint">没有发现待复核草稿、失效记忆或连接问题。</p>
      )}
    </details>
  );
}
function StoryPage({ id, notify, reading, onReadingChange }: {
  id: string; notify: Notice; reading: boolean; onReadingChange: (value: boolean) => void;
}) {
  const [localInputs, setLocalInputs] = useState<Record<string, string>>({});
  const sendingMessage = useRef(false);
  const [sending, setSending] = useState(false);
  const chatEnd = useRef<HTMLDivElement>(null);
  const composer = useRef<HTMLElement>(null);
  const storyPage = useRef<HTMLDivElement>(null);
  const storyTop = useRef<HTMLDivElement>(null);
  const readerToggle = useRef<HTMLButtonElement>(null);
  const [layout, changeLayout] = useReadingLayout(id);
  const s = useLiveQuery(() => db.stories.get(id), [id]);
  const events =
    useLiveQuery(
      () => db.events.where("storyId").equals(id).sortBy("seq"),
      [id],
    ) || [];
  const prefs = useLiveQuery(() => db.preferences.get("preferences"), []);
  const chatBatches = useLiveQuery(() => db.chatBatches.where("storyId").equals(id).sortBy("created"), [id]) || [];
  const profiles = useLiveQuery(() => db.profiles.toArray(), []) || [];
  const memories =
    useLiveQuery(
      () => db.memories.where("storyId").equals(id).toArray(),
      [id],
    ) || [];
  const world = useLiveQuery(() => db.world.toArray(), []) || [];
  useEffect(() => {
    void ensureStoryRounds(id).catch(() => notify("回合顺序初始化失败，请刷新后重试。"));
  }, [id, s?.timelineMode, s?.autoMemory, s?.roles.map((r) => r.id).join(","), events.length]);
  const [mode, setMode] = useState<"novel" | "chat">("novel"),
    [panel, setPanel] = useState(""),
    [busy, setBusy] = useState(false),
    [editing, setEditing] = useState<SceneEvent>(),
    [adopting, setAdopting] = useState<SceneEvent>(),
    [versions, setVersions] = useState<SceneEvent>(),
    [role, setRole] = useState<Role>(),
    [reference, setReference] = useState<ContextReport>(),
    [referenceEvent, setReferenceEvent] = useState<string>(),
    [saveState, setSaveState] = useState("已保存到本机");
  const chatUpdate = chatBatches.map((batch) => `${batch.id}:${batch.status}:${batch.updated}`).join("|");
  useLayoutEffect(() => {
    const page = storyPage.current, editor = composer.current;
    if (!page || !editor) return;
    const measure = () => {
      const space = reading ? 12 : editor.offsetHeight + (parseFloat(getComputedStyle(editor).bottom) || 0) + 12;
      page.style.setProperty("--reader-bottom", `${space}px`);
      if (chatEnd.current) chatEnd.current.style.scrollMarginBottom = `${space + 60}px`;
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(editor);
    window.addEventListener("resize", measure);
    return () => { observer.disconnect(); window.removeEventListener("resize", measure); };
  }, [reading, layout.composerCollapsed, mode, !!s]);
  function toggleReading(value: boolean) {
    const anchor = [...(storyPage.current?.querySelectorAll<HTMLElement>("[data-reading-anchor]") || [])]
      .find((element) => element.getBoundingClientRect().bottom > 0);
    const top = anchor?.getBoundingClientRect().top;
    onReadingChange(value);
    requestAnimationFrame(() => {
      if (anchor && top !== undefined) window.scrollBy({ top: anchor.getBoundingClientRect().top - top, behavior: "instant" });
      readerToggle.current?.focus({ preventScroll: true });
    });
  }
  useEffect(() => {
    if (!reading) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !document.querySelector('[role="dialog"]')) toggleReading(false);
    };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [reading]);
  function jumpTo(end: boolean) {
    const target = end ? chatEnd.current : storyTop.current;
    target?.scrollIntoView({ block: end ? "end" : "start",
      behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" });
  }
  function openComposer() {
    changeLayout({ composerCollapsed: false });
    requestAnimationFrame(() => document.getElementById("story-input")?.focus());
  }
  useEffect(() => {
    if (mode !== "chat" || reading) return;
    const frame = requestAnimationFrame(() => {
      if (!chatEnd.current || !composer.current) return;
      chatEnd.current.scrollIntoView({ block: "end" });
    });
    return () => cancelAnimationFrame(frame);
  }, [id, mode, events.length, events.at(-1)?.versionId, s?.player, s?.partner, chatUpdate]);
  useEffect(() => {
    setPanel("");
    setEditing(undefined);
    setAdopting(undefined);
    setReference(undefined);
    setReferenceEvent(undefined);
    setBusy(isBusy(id));
  }, [id]);
  async function update(patch: Partial<Story>) {
    setSaveState("保存中…");
    try {
      await db.stories.update(id, patch);
      setSaveState("已保存到本机");
    } catch (e) {
      setSaveState("保存失败，请备份当前输入");
      throw e;
    }
  }
  if (s === undefined)
    return (
      <div className="page">
        <a href="#stories">← 返回故事列表</a>
        <Empty>正在读取故事；如果故事已删除，请返回列表。</Empty>
      </div>
    );
  const inputKey = id + ":" + mode;
  const input =
    localInputs[inputKey] ?? (mode === "novel" ? s.draft : s.chatDraft);
  const stylePresets = allStylePresets(prefs);
  const selectedStylePreset = resolveStylePreset(s, prefs);
  const pendingMessages = pendingChatMessages(events, s.player, s.partner);
  const unfinishedBatches = chatBatches.filter((b) => b.player === s.player && b.partner === s.partner && b.status !== "complete");
  const generating = busy || isBusy(id) || chatBatches.some((b) => b.status === "running");
  function changeInput(value: string) {
    setLocalInputs((current) => ({ ...current, [inputKey]: value }));
    return update(mode === "novel" ? { draft: value } : { chatDraft: value });
  }
  async function submit(rewrite?: SceneEvent, styleOnly = false) {
    if (!s) return;
    if (rewrite?.kind === "message")
      return requestChat(rewrite.chatBatchId, rewrite.chatBatchId ? undefined : rewrite.id);
    if (!rewrite && mode === "chat") return sendMessage();
    setBusy(true);
    try {
      await run(
        id,
        rewrite?.kind === "novel" ? "novel" : rewrite ? "chat" : mode,
        rewrite?.input || input,
        rewrite?.id,
        { styleOnly },
      );
      if (!rewrite)
        setLocalInputs((current) => {
          if (current[inputKey] !== undefined && current[inputKey] !== input)
            return current;
          const next = { ...current };
          delete next[inputKey];
          return next;
        });
      notify("这一刻已保存");
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  async function sendMessage() {
    if (!s || sendingMessage.current) return;
    sendingMessage.current = true;
    setSending(true);
    try {
      await sendChatMessage(id, s.player, s.partner, input);
      setLocalInputs((current) => {
        if (current[inputKey] !== undefined && current[inputKey] !== input) return current;
        return { ...current, [inputKey]: "" };
      });
      setSaveState("已保存到本机");
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error));
    } finally {
      sendingMessage.current = false;
      setSending(false);
    }
  }
  async function requestChat(batchId?: string, legacyEventId?: string) {
    setBusy(true);
    try {
      await replyChat(id, batchId, legacyEventId);
      notify("这一组回复已保存");
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error));
    } finally { setBusy(false); }
  }
  const actions = (e: SceneEvent) => (
    <div className="event-actions">
      <button disabled={busy || isBusy(id)} onClick={() => setEditing(e)}>
        编辑
      </button>
      {(e.kind === "novel" || ((e.origin === "ai" || e.kind === "message" && e.origin !== "user") &&
        (!e.chatBatchId || chatBatches.find((b) => b.id === e.chatBatchId)?.replyIds.find((id) => events.some((x) => x.id === id && !x.deleted)) === e.id))) && (
        <button disabled={busy || isBusy(id)} onClick={() => submit(e)}>
          {e.kind === "message" ? "重新生成本组" : "重写"}
        </button>
      )}
      {e.kind === "novel" && (
        <button
          disabled={busy || isBusy(id)}
          onClick={() => submit(e, true)}
          title="保持事件、台词和停止位置，只使用当前文风预设重新表达"
        >
          仅换文风
        </button>
      )}
      <button onClick={() => setVersions(e)}>版本 {e.versions.length}</button>
      {e.kind === "novel" && (
        <button
          disabled={busy || isBusy(id)}
          onClick={async () => {
            setBusy(true);
            try {
              const n = await extractFacts(e.id);
              notify(`摘录了 ${n} 条事实，请在编辑中指定知情角色`);
            } catch (x) {
              notify(String(x));
            } finally {
              setBusy(false);
            }
          }}
        >
          摘录事实
        </button>
      )}
      {e.request && (
        <button
          onClick={() => {
            setReferenceEvent(e.id);
            setReference(e.request);
          }}
        >
          参考内容
        </button>
      )}
      <button
        disabled={busy || isBusy(id)}
        onClick={async () => {
          if (confirm("隐藏这一条内容？旧版本仍保留，后续内容会标记复核。"))
            await reviseEvent(e.id, e.text, true);
        }}
      >
        删除
      </button>
    </div>
  );
  const visible = events.filter((e) => !e.deleted);
  const pair = [s.player, s.partner];
  return (
    <div ref={storyPage} className={"story-page" + (reading ? " story-reading" : "")}>
      <div ref={storyTop} className="story-top" aria-hidden="true" />
      <div className="story-tools-toggle">
        <button aria-controls="story-tools" aria-expanded={!layout.toolbarCollapsed}
          onClick={() => changeLayout({ toolbarCollapsed: !layout.toolbarCollapsed })}>
          {layout.toolbarCollapsed ? <ChevronDown size={16} /> : <ChevronUp size={16} />}
          {layout.toolbarCollapsed ? "展开功能栏" : "收起功能栏"}
        </button>
        {layout.toolbarCollapsed && <span className="hint">{s.title} · {mode === "novel" ? "正文" : "手机聊天"}</span>}
      </div>
      <div id="story-tools" hidden={layout.toolbarCollapsed || reading}>
      <header className="story-heading">
        <div className="row">
          <a className="icon-button" href="#stories" aria-label="返回故事列表">
            <ArrowLeft size={20} />
          </a>
          <div>
            <h1>{s.title}</h1>
            <span className="hint">
              {s.roles.map((r) => r.name).join(" · ")}{" "}
              <span className="save-status">· {saveState}</span>
            </span>
          </div>
        </div>
        <div className="row">
          <button data-guide="memory" aria-label="故事记忆" onClick={() => setPanel("memory")}>
            <BookMarked size={18} />
            <span>故事记忆</span>
          </button>
          <button aria-label="故事设置" onClick={() => setPanel("settings")}>
            <SlidersHorizontal size={19} />
          </button>
        </div>
      </header>
      <div className="story-toolbar">
        <button
          onClick={async () => {
            try {
              setReferenceEvent(undefined);
              setReference(mode === "chat" ? await previewChat(id) : await preview(id, mode, input));
            } catch (e) {
              notify(String(e));
            }
          }}
        >
          <BookOpen size={16} />
          本次参考内容
        </button>
        <span className="toolbar-divider" />
        <span className="toolbar-label">当前页面操作</span>
        <span className="toolbar-hint">正文操作会显示在对应段落下方</span>
        <StoryHealth
          story={s}
          events={events}
          memories={memories}
          failedChats={chatBatches.filter((batch) => batch.status === "failed" || batch.status === "interrupted").length}
          readyModel={
            !!prefs?.activeProfile &&
            profiles.some((p) => p.id === prefs.activeProfile)
          }
        />
      </div>
      <div className="mode-bar">
        <div className="segmented">
          <button
            className={mode === "novel" ? "active" : ""}
            onClick={() => setMode("novel")}
          >
            <Feather size={16} />
            正文
          </button>
          <button
            className={mode === "chat" ? "active" : ""}
            onClick={() => setMode("chat")}
          >
            <MessageCircle size={16} />
            手机聊天
          </button>
        </div>
        <span className="hint">同一本故事，同一条时间线</span>
      </div>
      </div>
      {!reading && events.some(
        (event) =>
          event.kind === "novel" &&
          event.status === "complete" &&
          !event.deleted,
      ) && (
        <StarterCelebration
          story={s}
          onContinue={() => {
            setMode("novel");
            openComposer();
          }}
          onChat={() => setMode("chat")}
        />
      )}
      {!reading && !layout.toolbarCollapsed && mode === "chat" && (
        <ContextTip id="chat" title="选好身份，再开始聊天">
          <p>
            「我扮演」是你发消息时的身份，「聊天对象」是回复你的角色。连续发送消息，说完后点「让 TA 回复」，对方会结合整组消息自然分条回复。{sharedTimeline(s) ? "普通正文会自动接入聊天，聊天也会带回正文；私聊仍只对参与双方可知。" : "当前使用严格知情模式，正文按事实授权进入聊天。可以在故事设置中切换为自动互通。"}
          </p>
        </ContextTip>
      )}
      {!reading && !layout.toolbarCollapsed && s.timelineMode === undefined && (
        <div className="timeline-upgrade">
          <div><strong>让正文和手机聊天自动接上</strong><p>整本故事一次启用，普通正文无需逐段授权。已有的特定角色授权会保留，私密内容可在段落编辑中设置。</p></div>
          <button disabled={generating} onClick={async () => {
            try { await setTimelineMode(id, "shared"); notify("整本故事已启用自动互通"); }
            catch (error) { notify(String(error)); }
          }}>整本启用自动互通</button>
        </div>
      )}
      {!reading && !layout.toolbarCollapsed && mode === "chat" && s.roles.length < 2 && (
        <div className="starter-reminder">
          <span>
            聊天需要至少两位角色。先在角色库添加一位，再到故事设置中带入。
          </span>
          <button onClick={() => setPanel("settings")}>打开故事设置</button>
        </div>
      )}
      {!reading && !layout.toolbarCollapsed && mode === "chat" && (
        <div className="chat-identity">
          <Field label="我扮演">
            <select
              aria-label="我扮演"
              value={s.player}
              disabled={generating || sending}
              onChange={(e) => update({ player: e.target.value })}
            >
              {s.roles.map((r) => (
                <option value={r.id} key={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
          </Field>
          <span>与</span>
          <Field label="聊天对象">
            <select
              aria-label="聊天对象"
              value={s.partner}
              disabled={generating || sending}
              onChange={(e) => update({ partner: e.target.value })}
            >
              <option value="">选择角色</option>
              {s.roles
                .filter((r) => r.id !== s.player)
                .map((r) => (
                  <option value={r.id} key={r.id}>
                    {r.name}
                  </option>
                ))}
            </select>
          </Field>
          <span className="hint">私聊只对双方可知</span>
        </div>
      )}
      <section
        className={
          "timeline " + (mode === "chat" ? "chat-timeline" : "novel-timeline")
        }
        aria-live="polite"
      >
        {mode === "novel" && (
          <div className="opening" data-reading-anchor>
            <span className="eyebrow">PROLOGUE / 故事的起点</span>
            <p>{s.background || "故事还没开始，你可以先写一个瞬间。"}</p>
          </div>
        )}
        {visible.map((e, i) => {
          if (
            mode === "chat" &&
            e.kind === "message" &&
            !e.participants.every((x) => pair.includes(x))
          )
            return null;
          if (mode === "chat" && e.kind === "novel")
            return (
              <div key={e.id} className="node-marker">
                书页之间 · 正文片段 {e.seq}
                {e.review ? " · 待复核" : ""}
                <details>
                  <summary>{sharedTimeline(s) ? "查看聊天对象可参考的正文" : "查看双方可知的事实"}</summary>
                  <p>{visibleText(e, s.partner, s) || "这段内容未向聊天对象共享。"}</p>
                  <small>{sharedTimeline(s) ? "普通正文自动接入，单段权限可以在编辑中调整。" : "当前仅共享授权事实，可在故事设置中开启自动互通。"}</small>
                </details>
              </div>
            );
          if (mode === "novel" && e.kind === "message")
            return (
              <details className="chat-insert" key={e.id}>
                <summary>
                  <MessageCircle size={14} />
                  {
                    s.roles.find((r) => r.id === e.speaker)?.name
                  } 的手机消息 <span>{date(e.created)}</span>
                  {e.review ? " · 待复核" : ""}
                  {e.status === "draft" ? " · 草稿" : ""}
                </summary>
                <p>{e.text || "正在接收…"}</p>
                {e.error && <p className="error">{e.error}</p>}
                {e.status === "complete" ? (
                  actions(e)
                ) : (
                  <button disabled={busy} onClick={() => submit(e)}>
                    重试回复
                  </button>
                )}
              </details>
            );
          return (
            <article
              key={e.id}
              data-reading-anchor
              className={
                e.kind === "novel"
                  ? "prose-event"
                  : "message-event " +
                    (e.speaker === s.player ? "mine" : "theirs")
              }
            >
              {e.kind === "novel" ? (
                <div className="prose-heading">
                  <span className="event-number">
                    {String(i + 1).padStart(2, "0")} / 这一刻
                  </span>
                  {e.status === "complete" && !reading && (
                    <button
                      className="prose-collapse"
                      aria-expanded={!e.collapsed}
                      aria-controls={"prose-body-" + e.id}
                      onClick={async () => {
                        try {
                          await db.events.update(e.id, {
                            collapsed: !e.collapsed,
                          });
                        } catch {
                          notify("折叠状态没能保存，请再试一次。");
                        }
                      }}
                    >
                      {e.collapsed ? (
                        <ChevronDown size={15} />
                      ) : (
                        <ChevronUp size={15} />
                      )}
                      {e.collapsed ? "展开本段" : "折叠本段"}
                    </button>
                  )}
                </div>
              ) : (
                <div className="message-author">
                  <Avatar
                    role={s.roles.find((r) => r.id === e.speaker)}
                    size={28}
                  />
                  {s.roles.find((r) => r.id === e.speaker)?.name}
                </div>
              )}
              {e.review && (
                <div className="review">
                  {sharedTimeline(s) ? "早期内容已修改。这一条仍会接续使用，可按需调整。" : "早期内容已修改，这一条可能受影响。"}
                  <button
                    onClick={async () => {
                      await db.events.update(e.id, { review: false });
                    }}
                  >
                    {sharedTimeline(s) ? "收起提醒" : "确认沿用"}
                  </button>
                </div>
              )}
              {e.status === "draft" && (
                <div className="draft-label">
                  {busy && !e.error
                    ? "正在描绘…"
                    : "未完成草稿 · 不进入正式经历"}
                </div>
              )}
              {e.kind === "novel" && e.status === "complete" && e.collapsed && !reading && (
                <p className="prose-preview">{e.text.slice(0, 100)}</p>
              )}
              <div
                id={"prose-body-" + e.id}
                hidden={
                  !reading && e.kind === "novel" && e.status === "complete" && e.collapsed
                }
              >
                <p className="event-text">
                  {e.text ||
                    (e.status === "draft" && draftText(e.raw)) ||
                    (busy && !e.error
                      ? "文字正在路上…"
                      : "这次没有收到可显示的文字，可以取回输入后重试。")}
                </p>
                {e.acceptedByAuthor && <p className="hint">作者确认采用</p>}
                {e.warnings?.length ? <details className="output-advice"><summary>可选检查提醒 · 正文已保存</summary>
                  {e.warnings.map((warning, index) => <p className="hint" key={index}>{warning}</p>)}
                </details> : null}
                {e.chatPending && e.origin === "user" && (
                  <p className="chat-message-state">
                    {!e.chatBatchId ? "已发送 · 待回复" :
                      chatBatches.find((b) => b.id === e.chatBatchId)?.status === "running" ? "对方正在回复这组消息" : "本组待重试"}
                  </p>
                )}
                {e.error && <p className="error">{e.error}</p>}
                {e.status === "complete" ? (
                  actions(e)
                ) : (
                  <div className="row">
                    {e.kind === "message" && (
                      <button disabled={generating} onClick={() => submit(e)}>重试本组</button>
                    )}
                    {e.kind === "novel" && (e.text.trim() || e.raw.trim()) && (
                      <button
                        className="primary"
                        disabled={busy}
                        onClick={() => setAdopting(structuredClone(e))}
                      >
                        检查并采用
                      </button>
                    )}
                    <button
                      disabled={busy}
                      onClick={() => {
                        changeInput(e.input);
                        openComposer();
                        notify("原输入已放回输入框；草稿仍保留");
                      }}
                    >
                      取回输入
                    </button>
                    <button
                      disabled={busy}
                      onClick={async () => {
                        await db.transaction("rw", [db.events, db.theaters], async () => {
                          await db.theaters.where("eventId").equals(e.id).delete();
                          await db.events.delete(e.id);
                        });
                      }}
                    >
                      删除草稿
                    </button>
                  </div>
                )}
                {e.status === "draft" && (e.raw || e.theater) && <EventRawOutput event={e} />}
                {e.status === "draft" && e.request && (
                  <button
                    onClick={() => {
                      setReferenceEvent(e.id);
                      setReference(e.request);
                    }}
                  >
                    参考内容
                  </button>
                )}
                {e.kind === "novel" && (e.status === "complete" || e.theater) &&
                  (reading || !e.collapsed || e.status === "draft") && (
                    <TheaterPanel key={e.id} event={e} blocked={generating} />
                  )}
              </div>
            </article>
          );
        })}
        {mode === "chat" && unfinishedBatches.map((batch) => (
          <div className="chat-batch-status" key={batch.id}>
            {batch.status === "running" ? (
              <p role="status">对方正在输入… <span className="hint">正在回应 {batch.messages.length} 条消息</span></p>
            ) : (
              <>
                <p className="error">{batch.error || "这组回复尚未完成，可以重试。"}</p>
                <p className="hint">本组 {batch.messages.length} 条消息已保留。新发送的消息留待下一轮。</p>
                <div className="row">
                  <button disabled={generating} onClick={() => requestChat(batch.id)}>重试本组</button>
                  <button disabled={generating} onClick={async () => {
                    try { await dismissChatBatch(batch.id); }
                    catch (error) { notify(String(error)); }
                  }}>{batch.replyIds.length ? "保留原回复" : "返回待回复"}</button>
                </div>
                {batch.raw && <details><summary>查看模型原始输出</summary><pre>{batch.raw}</pre></details>}
              </>
            )}
          </div>
        ))}
        {!visible.length && (
          <Empty>
            {mode === "novel"
              ? "写下动作或一句台词，把这一刻交给文字。"
              : "选好彼此的身份，发出第一条消息。"}
          </Empty>
        )}
        <div ref={chatEnd} className="story-end" aria-hidden="true" />
      </section>
      {!reading && !layout.composerCollapsed && mode === "novel" && (
        <FirstSceneCoach
          story={s}
          events={events}
          onExample={(text) => {
            if (!input.trim()) {
              changeInput(text);
              openComposer();
            } else {
              notify("输入框已经有内容，可以参考示例自行调整。");
            }
          }}
        />
      )}
      <section
        ref={composer}
        className={"composer" + (mode === "chat" ? " chat-composer" : "") + (layout.composerCollapsed ? " composer-collapsed" : "")}
        id="story-composer"
        data-guide="novel-compose"
        hidden={reading}
      >
        <div className="composer-heading">
          <span className="hint">{mode === "novel" ? "写下这一刻" : "手机消息"}
            {layout.composerCollapsed && (generating ? " · 正在生成…" : input.trim() ? " · 有未发送的输入" : mode === "chat" && pendingMessages.length ? ` · ${pendingMessages.length} 条待回复` : "")}</span>
          <button aria-expanded={!layout.composerCollapsed} aria-controls="story-composer-fields"
            onClick={() => layout.composerCollapsed ? openComposer() : changeLayout({ composerCollapsed: true })}>
            {layout.composerCollapsed ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
            {layout.composerCollapsed ? "展开输入框" : "收起输入框"}
          </button>
          {layout.composerCollapsed && generating && <button onClick={() => stop(id)}><Square size={14} />停止生成</button>}
        </div>
        <div id="story-composer-fields" hidden={layout.composerCollapsed}>
        {mode === "novel" && (
          <details className="writing-preferences">
            <summary>
              <span className="writing-preferences-label">写作偏好</span>
              <span className="writing-preferences-style" title={selectedStylePreset?.name || s.style || "自定义文风"}>
                {selectedStylePreset?.name || s.style || "自定义文风"}
              </span>
              <span className="writing-preferences-length">{s.length}</span>
              <ChevronDown className="writing-preferences-chevron" size={15} aria-hidden="true" />
            </summary>
            <div className="composer-options">
              <label className="field compact-field">
                <span>文风预设</span>
                <select
                  aria-label="文风预设"
                  value={selectedStylePreset?.id || "__custom__"}
                  onChange={(e) => {
                    if (e.target.value === "__custom__")
                      void update({ stylePresetId: undefined });
                    else {
                      const preset = stylePresets.find((x) => x.id === e.target.value);
                      if (preset)
                        void update({ stylePresetId: preset.id, style: preset.name });
                    }
                  }}
                >
                  <option value="__custom__">自定义文风</option>
                  {stylePresets.map((preset) => (
                    <option key={preset.id} value={preset.id}>
                      {preset.name}
                    </option>
                  ))}
                </select>
              </label>
              {!selectedStylePreset && (
                <label className="field compact-field">
                  <span>自定义文风</span>
                  <input
                    aria-label="自定义文风"
                    value={s.style}
                    onChange={(e) =>
                      void update({ style: e.target.value, stylePresetId: undefined })
                    }
                    placeholder="例如：冷静、短句、少用比喻"
                  />
                </label>
              )}
              <label className="field compact-field">
                <span>扩写篇幅</span>
                <select
                  aria-label="扩写篇幅"
                  value={s.length}
                  onChange={(e) => void update({ length: e.target.value })}
                >
                  {["简短", "适中", "细腻"].map((x) => (
                    <option key={x}>{x}</option>
                  ))}
                </select>
              </label>
              <Toggle
                label="心理描写"
                value={s.psychology}
                onChange={(v) => void update({ psychology: v })}
              />
            </div>
            {selectedStylePreset && (
              <p className="hint writing-preference-description">
                {selectedStylePreset.description}
              </p>
            )}
          </details>
        )}
        <textarea
          id="story-input"
          aria-label={mode === "novel" ? "本段动作或台词" : "聊天消息"}
          value={input}
          onChange={(e) => changeInput(e.target.value)}
          placeholder={
            mode === "novel"
              ? "他把伞递给她，说“拿着”，但没有看她。\n写下发生的事，扩写会停在你给出的最后一刻。"
              : "可以连续发送多条消息，说完后点「让 TA 回复」……"
          }
          onKeyDown={(e) => {
            if (
              (e.ctrlKey || e.metaKey) &&
              e.key === "Enter" &&
              !e.nativeEvent.isComposing &&
              (mode === "chat" ? !sending : !generating)
            ) {
              e.preventDefault();
              submit();
            }
          }}
        />
        <footer>
          <button
            onClick={async () => {
              try {
                setReferenceEvent(undefined);
                setReference(mode === "chat" ? await previewChat(id) : await preview(id, mode, input));
              } catch (e) {
                notify(String(e));
              }
            }}
          >
            本次参考内容
          </button>
          {mode === "novel" && (
            <button
              className="inspiration-trigger"
              disabled={busy || isBusy(id)}
              onClick={() => setPanel("inspiration")}
            >
              <Lightbulb size={16} />
              灵感小助手
            </button>
          )}
          <span className="hint">Ctrl / ⌘ + Enter</span>
          {mode === "chat" && (
            <button className="chat-send" disabled={sending || !input.trim() || !s.partner || s.player === s.partner}
              onClick={() => sendMessage()}><Send size={16} /> 发送消息</button>
          )}
          {generating ? (
            <button className="primary" onClick={() => stop(id)}>
              <Square size={15} />
              停止生成
            </button>
          ) : (
            <button
              className="primary"
              disabled={
                (mode === "novel" ? !input.trim() : !pendingMessages.length || unfinishedBatches.length > 0 || sending) ||
                (mode === "chat" && (!s.partner || s.player === s.partner))
              }
              onClick={() => mode === "chat" ? requestChat() : submit()}
            >
              {mode === "novel" ? <Feather size={16} /> : <Send size={16} />}{" "}
              {mode === "novel" ? "扩写这一刻" : `让 TA 回复（${pendingMessages.length}）`}
            </button>
          )}
        </footer>
        </div>
      </section>
      <nav className="story-reader-controls" aria-label="故事阅读控制">
        <button title="回到故事顶部" aria-label="回到故事顶部" onClick={() => jumpTo(false)}><ArrowUpToLine size={18} /></button>
        <button title="回到故事底部" aria-label="回到故事底部" onClick={() => jumpTo(true)}><ArrowDownToLine size={18} /></button>
        <button ref={readerToggle} title={reading ? "退出沉浸阅读" : "沉浸阅读"} aria-pressed={reading}
          onClick={() => toggleReading(!reading)}>
          {reading ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
          {reading ? "退出阅读" : "沉浸阅读"}
        </button>
        {reading && generating && <button onClick={() => stop(id)} aria-label="停止生成"><Square size={16} /></button>}
      </nav>
      {panel === "inspiration" && (
        <Modal title="灵感小助手" onClose={() => setPanel("")}>
          <InspirationAssistant
            story={s}
            blocked={busy || isBusy(id)}
            onClose={() => setPanel("")}
            onChoose={async (text) => {
              try {
                const draft = await chooseInspiration(id, text, input);
                setLocalInputs((current) => ({
                  ...current,
                  [inputKey]: draft,
                }));
                setSaveState("已保存到本机");
                setPanel("");
                openComposer();
                notify("灵感已放进输入框，可以调整后再扩写。");
              } catch {
                notify("输入没能保存，灵感仍保留在窗口里，请重试。");
              }
            }}
          />
        </Modal>
      )}
      {panel === "memory" && (
        <Memories s={s} mode={mode} notify={notify} onClose={() => setPanel("")} />
      )}{" "}
      {panel === "settings" && (
        <Modal title="这本故事的设定" onClose={() => setPanel("")}>
          <StoryTheaterSettings story={s} prefs={prefs} update={update} />
          <Field label="正文与手机聊天">
            <select value={s.timelineMode || "strict"} disabled={generating} onChange={async (event) => {
              try { await setTimelineMode(id, event.target.value as "shared" | "strict"); notify("故事互通设置已保存"); }
              catch (error) { notify(String(error)); }
            }}>
              <option value="shared">自动互通（推荐）</option>
              <option value="strict">严格知情（高级）</option>
            </select>
          </Field>
          <p className="hint">自动互通会让普通正文和手机聊天按时间接续。私密段落、作者设定和其他人的私聊仍按各自权限处理。严格模式只把授权事实提供给聊天角色。</p>
          <Field label="故事名字">
            <input
              value={s.title}
              onChange={(e) => update({ title: e.target.value })}
            />
          </Field>
          <Field label="开场背景 · 作者可见">
            <textarea
              value={s.background}
              onChange={(e) => update({ background: e.target.value })}
            />
          </Field>
          <h3>故事中的角色副本</h3>
          {s.roles.map((r) => (
            <div className="row paragraph" key={r.id}>
              <Avatar role={r} />
              <span>{r.name}</span>
              <button onClick={() => setRole(r)}>编辑故事人设</button>
              <button
                onClick={async () => {
                  const original = await db.roles.get(r.sourceId || r.id);
                  if (!original) {
                    notify("角色库原档案已删除");
                    return;
                  }
                  if (
                    confirm(
                      "将故事中的 " + r.name + " 人设替换为角色库当前版本？",
                    )
                  )
                    await update({
                      roles: s.roles.map((x) =>
                        x.id === r.id
                          ? {
                              ...structuredClone(original),
                              id: r.id,
                              sourceId: original.id,
                            }
                          : x,
                      ),
                    });
                }}
              >
                同步角色库
              </button>
            </div>
          ))}
          <StoryCastPicker
            story={s}
            onAdd={async (newRole) => {
              await update({
                roles: [
                  ...s.roles,
                  { ...structuredClone(newRole), sourceId: newRole.id },
                ],
                partner: s.partner || newRole.id,
              });
              notify("角色已带入这本故事");
            }}
          />
          <Field label="绑定世界书">
            {world.map((w) => (
              <Toggle
                key={w.id}
                label={w.title}
                value={s.worldIds.includes(w.id)}
                onChange={(v) =>
                  update({
                    worldIds: v
                      ? [...s.worldIds, w.id]
                      : s.worldIds.filter((id) => id !== w.id),
                  })
                }
              />
            ))}
          </Field>
          <StoryTransfer story={s} notify={notify} />
          <details>
            <summary>已删除的内容（可恢复）</summary>
            {events
              .filter((e) => e.deleted)
              .map((e) => (
                <div key={e.id}>
                  <p>{e.text}</p>
                  <button
                    onClick={() => reviseEvent(e.id, e.text, false, e.facts)}
                  >
                    恢复
                  </button>
                </div>
              ))}
          </details>
          <button
            className="danger"
            disabled={busy || isBusy(id)}
            onClick={async () => {
              if (confirm("永久删除整本故事、版本和记忆？建议先导出备份。")) {
                await deleteStory(id);
                location.hash = "stories";
              }
            }}
          >
            <Trash2 size={16} />
            删除这本故事
          </button>
        </Modal>
      )}
      {role && (
        <RoleEditor
          value={role}
          onClose={() => setRole(undefined)}
          onSave={async (r) => {
            await update({
              roles: s.roles.map((x) => (x.id === r.id ? r : x)),
            });
          }}
        />
      )}
      {editing && (
        <EventEditor
          event={editing}
          story={s}
          onClose={() => setEditing(undefined)}
        />
      )}{" "}
      {adopting && (
        <DraftReview
          key={adopting.id}
          event={adopting}
          onClose={() => setAdopting(undefined)}
          onAdopted={() => {
            setLocalInputs((current) => {
              const next = { ...current };
              if (next[id + ":novel"] === adopting.input)
                delete next[id + ":novel"];
              return next;
            });
            setAdopting(undefined);
            notify("已按你确认的文字采用为正文。");
          }}
        />
      )}
      {versions && (
        <Modal title="版本对照与恢复" onClose={() => setVersions(undefined)}>
          <div className="versions">
            {versions.versions.map((v, i) => (
              <section key={v.id}>
                <h3>
                  版本 {i + 1} · {date(v.created)}
                </h3>
                <p>{v.text}</p>
                <button
                  disabled={busy || isBusy(id)}
                  onClick={async () => {
                    await reviseEvent(
                      versions.id,
                      v.text,
                      v.deleted || false,
                      v.facts,
                      versions.versionId,
                    );
                    setVersions(undefined);
                    notify("旧版已恢复为新的当前版本");
                  }}
                >
                  恢复这个版本
                </button>
              </section>
            ))}
          </div>
        </Modal>
      )}
      {reference && (
        <Modal title="本次参考内容" onClose={() => setReference(undefined)}>
          <Reference
            report={
              (referenceEvent &&
                events.find((e) => e.id === referenceEvent)?.request) ||
              reference
            }
            developer={prefs?.developer}
          />
        </Modal>
      )}
    </div>
  );
}
function StoryCastPicker({
  story,
  onAdd,
}: {
  story: Story;
  onAdd: (role: Role) => Promise<void>;
}) {
  const roles = useLiveQuery(() => db.roles.toArray(), []) || [];
  const [adding, setAdding] = useState(false);
  const available = roles.filter(
    (role) => !story.roles.some((r) => (r.sourceId || r.id) === role.id),
  );
  return (
    <div className="story-add-cast">
      <h3>带入另一位角色</h3>
      {available.length ? (
        <div className="pick-roles">
          {available.map((role) => (
            <button
              key={role.id}
              disabled={adding}
              onClick={async () => {
                setAdding(true);
                try {
                  await onAdd(role);
                } finally {
                  setAdding(false);
                }
              }}
            >
              <Plus size={15} />
              {role.name}
            </button>
          ))}
        </div>
      ) : (
        <p className="hint">
          角色库中的角色都已在这里。可以先到
          <a href="#roles">「角色」页添加一位</a>，再回来带入。
        </p>
      )}
    </div>
  );
}
function ProfileEditor({
  value,
  onClose,
  notify,
}: {
  value: Profile;
  onClose: () => void;
  notify: Notice;
}) {
  return (
    <Modal title="模型接口" onClose={onClose}>
      <ConnectionForm
        value={value}
        onSaved={() => {
          notify("接口已保存并选用");
          onClose();
        }}
      />
    </Modal>
  );
}
function StylePresetSettings({
  prefs,
  notify,
}: {
  prefs: Preferences;
  notify: Notice;
}) {
  const [editing, setEditing] = useState<StylePreset>();
  const custom = prefs.stylePresets || [];
  const begin = (preset: StylePreset) => setEditing(structuredClone(preset));
  const save = async () => {
    if (!editing?.name.trim() || !editing.prompt.trim()) return;
    const next = [
      ...custom.filter((preset) => preset.id !== editing.id),
      {
        ...editing,
        name: editing.name.trim(),
        prompt: editing.prompt.trim(),
        builtIn: false,
      },
    ];
    await db.preferences.update("preferences", { stylePresets: next });
    setEditing(undefined);
    notify("文风预设已保存");
  };
  return (
    <section className="settings-card">
      <div className="section-title">
        <div>
          <h2>文风预设</h2>
          <p className="hint">正文和手机聊天共用。固定剧情边界仍由程序维护。</p>
        </div>
        <button
          onClick={() =>
            begin({
              id: uid(),
              name: "我的文风",
              description: "自己定义的写作习惯",
              prompt: "",
              scope: "both",
              builtIn: false,
            })
          }
        >
          <Plus size={16} />
          新建预设
        </button>
      </div>
      <div className="style-preset-grid">
        {builtInStylePresets.map((preset) => (
          <article className="style-preset-card" key={preset.id}>
            <span className="tag">内置</span>
            <strong>{preset.name}</strong>
            <p>{preset.description}</p>
            <button
              onClick={() =>
                begin({
                  ...preset,
                  id: uid(),
                  name: preset.name + "（自定义）",
                  builtIn: false,
                })
              }
            >
              <Copy size={15} />
              复制后修改
            </button>
          </article>
        ))}
        {custom.map((preset) => (
          <article className="style-preset-card custom" key={preset.id}>
            <span className="tag">自定义</span>
            <strong>{preset.name}</strong>
            <p>{preset.description || "还没有写说明"}</p>
            <div className="row">
              <button onClick={() => begin(preset)}>编辑</button>
              <button
                onClick={async () => {
                  await db.preferences.update("preferences", {
                    stylePresets: custom.filter((item) => item.id !== preset.id),
                  });
                  notify("文风预设已删除");
                }}
              >
                删除
              </button>
            </div>
          </article>
        ))}
      </div>
      {editing && (
        <div className="inline-editor style-preset-editor">
          <h3>{editing.builtIn ? "复制文风预设" : "编辑文风预设"}</h3>
          <Field label="名称">
            <input
              required
              value={editing.name}
              onChange={(e) => setEditing({ ...editing, name: e.target.value })}
            />
          </Field>
          <Field label="说明">
            <input
              value={editing.description}
              onChange={(e) =>
                setEditing({ ...editing, description: e.target.value })
              }
            />
          </Field>
          <Field label="适用范围">
            <select
              value={editing.scope}
              onChange={(e) =>
                setEditing({
                  ...editing,
                  scope: e.target.value as StylePreset["scope"],
                })
              }
            >
              <option value="both">正文和手机聊天</option>
              <option value="novel">仅正文</option>
              <option value="chat">仅手机聊天</option>
            </select>
          </Field>
          <Field label="风格要求">
            <textarea
              className="long-text"
              required
              value={editing.prompt}
              onChange={(e) => setEditing({ ...editing, prompt: e.target.value })}
              placeholder="例如：多用短句，减少情绪解释，让动作承担情绪。"
            />
          </Field>
          <div className="row">
            <button
              className="primary"
              disabled={!editing.name.trim() || !editing.prompt.trim()}
              onClick={() => void save()}
            >
              保存预设
            </button>
            <button onClick={() => setEditing(undefined)}>取消</button>
          </div>
        </div>
      )}
    </section>
  );
}
function SettingsPage({ notify }: { notify: Notice }) {
  const profiles = useLiveQuery(() => db.profiles.toArray(), []) || [],
    prefs = useLiveQuery(() => db.preferences.get("preferences"), []);
  const [edit, setEdit] = useState<Profile>(),
    [kind, setKind] = useState<PromptKind>("novel"),
    [inspirationWindow, setInspirationWindow] = useState("3"),
    [memoryEvery, setMemoryEvery] = useState("5"),
    [memoryLimit, setMemoryLimit] = useState("8"),
    [custom, setCustom] = useState("");
  useEffect(() => {
    setCustom(prefs?.prompts[kind]?.text ?? defaults[kind]);
  }, [kind, prefs?.prompts[kind]?.text]);
  useEffect(() => {
    setInspirationWindow(
      String(inspirationCount(prefs?.inspirationParagraphs)),
    );
  }, [prefs?.inspirationParagraphs]);
  useEffect(() => {
    if (prefs) { setMemoryEvery(String(memoryInterval(prefs))); setMemoryLimit(String(memoryReadLimit(prefs))); }
  }, [prefs?.memoryIntervalRounds, prefs?.memoryAutoReadLimit]);
  if (!prefs) return null;
  return (
    <div className="page settings-page">
      <header className="page-heading">
        <div>
          <span className="eyebrow">MAKE YOURSELF AT HOME</span>
          <h1>让此间合你心意</h1>
          <p>接好灵感的来路，也为故事留一份备份。</p>
        </div>
      </header>
      <section className="settings-card">
        <div className="section-title">
          <div>
            <h2>模型与连接</h2>
            <p className="hint">使用你自己的接口、密钥和模型。</p>
          </div>
          <button
            onClick={() =>
              setEdit({
                id: uid(),
                name: "我的接口",
                protocol: "chat",
                url: "",
                model: "",
                stream: true,
                context: 32000,
                maxOutput: 4096,
                timeout: 120,
                remember: false,
              })
            }
          >
            <Plus size={16} />
            添加接口
          </button>
        </div>
        {profiles.map((p) => (
          <div className="profile-row" key={p.id}>
            <input
              aria-label={"选用" + p.name}
              type="radio"
              checked={prefs.activeProfile === p.id}
              onChange={async () => {
                await db.preferences.update("preferences", {
                  activeProfile: p.id,
                });
              }}
            />
            <div>
              <strong>{p.name}</strong>
              <p>
                {protocols[p.protocol]} · {p.model}
              </p>
            </div>
            <button onClick={() => setEdit(p)}>配置</button>
            <button
              aria-label={"删除接口" + p.name}
              onClick={async () => {
                if (confirm("删除这个接口配置？"))
                  await db.profiles.delete(p.id);
              }}
            >
              <Trash2 size={16} />
            </button>
          </div>
        ))}
        {!profiles.length && (
          <p className="hint">还没有接口。添加一个，就可以开始扩写和聊天。</p>
        )}
      </section>
      <BackupSettings notify={notify} />
      <section className="settings-card">
        <h2>开发者模式</h2>
        <Toggle
          label="显示内部提示词编辑器"
          value={prefs.developer}
          onChange={async (v) => {
            await db.preferences.update("preferences", { developer: v });
          }}
        />
        <p className="hint">
          关闭只隐藏编辑入口，已启用的自定义提示词继续生效。剧情边界、输出格式与知情过滤由程序固定维护。
        </p>
        {prefs.developer && (
          <>
            <Toggle label="台词检查（只提醒，不拦截）" value={!!prefs.dialogueCheck}
              onChange={(value) => db.preferences.update("preferences", { dialogueCheck: value }).then(() => {})} />
            <p className="hint">默认关闭。开启后只提示台词用字差异，完整正文仍会直接保存；标点变化也可能触发提醒。</p>
            <p className="hint">正文与聊天共用最多20回原文，按16～20回分批滚动。删除和被替换的旧版本不参与请求。</p>
            <Field label="每几回合自动提炼记忆"><input type="number" min={1} step={1} value={memoryEvery}
              onChange={(e) => { setMemoryEvery(e.target.value); const n = Number(e.target.value);
                if (Number.isSafeInteger(n) && n >= 1) void db.preferences.update("preferences", { memoryIntervalRounds: n }).catch(() => notify("记忆频率保存失败")); }}
              onBlur={() => setMemoryEvery(String(memoryInterval(prefs)))} /></Field>
            <Field label="最多自动读取几条回合记忆"><input type="number" min={0} step={1} value={memoryLimit}
              onChange={(e) => { setMemoryLimit(e.target.value); const n = Number(e.target.value);
                if (e.target.value && Number.isSafeInteger(n) && n >= 0) void db.preferences.update("preferences", { memoryAutoReadLimit: n }).catch(() => notify("记忆数量保存失败")); }}
              onBlur={() => setMemoryLimit(String(memoryReadLimit(prefs)))} /></Field>
            <p className="hint">默认每5回整理一段、自动读取8条；读取数量设为0可关闭自动选择。记忆库可临时增减下一次参考。自动提炼会调用当前接口，失败时保留进度并提示。</p>
            <Field label="灵感小助手参考正文段数">
              <input
                type="number"
                min={1}
                max={20}
                step={1}
                value={inspirationWindow}
                onChange={(event) => {
                  const value = event.target.value;
                  setInspirationWindow(value);
                  const count = Number(value);
                  if (Number.isInteger(count) && count >= 1 && count <= 20)
                    void db.preferences
                      .update("preferences", { inspirationParagraphs: count })
                      .catch(() => notify("参考段数没能保存，请重试。"));
                }}
                onBlur={() =>
                  setInspirationWindow(
                    String(inspirationCount(prefs.inspirationParagraphs)),
                  )
                }
              />
            </Field>
            <p className="hint">
              默认参考最近 3 段完整正文，可设为 1 到 20
              段，另参考最近 20 条已发送聊天和相关的已确认记忆，并区分人物知情范围。新一轮灵感会使用新段数，关闭开发者模式后设置仍生效。
            </p>
            <Field label="编辑提示词">
              <select
                value={kind}
                onChange={(e) => setKind(e.target.value as PromptKind)}
              >
                <option value="novel">小说扩写</option>
                <option value="chat">手机聊天</option>
                <option value="facts">事实摘录</option>
                <option value="memory">记忆整理</option>
                <option value="inspiration">灵感小助手</option>
                <option value="theater">小剧场</option>
              </select>
            </Field>
            <textarea
              className="long-text"
              aria-label="自定义内部提示词"
              value={custom}
              onChange={(e) => setCustom(e.target.value)}
            />
            <div className="row">
              <button
                className="primary"
                onClick={async () => {
                  await db.preferences.update("preferences", {
                    prompts: {
                      ...prefs.prompts,
                      [kind]: { text: custom, enabled: true },
                    },
                  });
                  notify("自定义提示词已保存并启用");
                }}
              >
                保存并启用
              </button>
              <Toggle
                label="使用自定义版本"
                value={!!prefs.prompts[kind]?.enabled}
                onChange={async (enabled) => {
                  await db.preferences.update("preferences", {
                    prompts: {
                      ...prefs.prompts,
                      [kind]: {
                        text: prefs.prompts[kind]?.text ?? custom,
                        enabled,
                      },
                    },
                  });
                }}
              />
              <button
                onClick={async () => {
                  await db.preferences.update("preferences", {
                    prompts: {
                      ...prefs.prompts,
                      [kind]: { text: defaults[kind], enabled: false },
                    },
                  });
                  setCustom(defaults[kind]);
                }}
              >
                恢复默认
              </button>
            </div>
            <p className="hint">
              最终请求可以在故事中的“本次参考内容”查看。此处调整写作习惯，不能绕过角色知情范围。
            </p>
          </>
        )}
      </section>
      {prefs.developer && <StylePresetSettings prefs={prefs} notify={notify} />}
      {prefs.developer && <TheaterPresetSettings prefs={prefs} notify={notify} />}
      {edit && (
        <ProfileEditor
          value={edit}
          notify={notify}
          onClose={() => setEdit(undefined)}
        />
      )}
    </div>
  );
}
