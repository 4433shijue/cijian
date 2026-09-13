import { useEffect, useState, useRef, type ReactNode } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import {
  BookOpen,
  Users,
  Leaf,
  Settings,
  Plus,
  ArrowLeft,
  Send,
  Square,
  Feather,
  MessageCircle,
  Download,
  Trash2,
  SlidersHorizontal,
  Check,
  RefreshCw,
  BookMarked,
  X,
} from "lucide-react";
import { db, makeStory, deleteStory, reviseEvent } from "./db";
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
} from "./types";
import {
  run,
  stop,
  isBusy,
  extractFacts,
  organizeMemory,
  preview,
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
  download,
  exportBackup,
  importBackup,
  validateBackup,
  type Backup,
} from "./backup";
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
function Modal({
  title,
  children,
  onClose,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
}) {
  const modalRef = useRef<HTMLElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement;
    const focusables = () =>
      Array.from(
        modalRef.current?.querySelectorAll<HTMLElement>(
          "button:not(:disabled),input:not(:disabled),textarea,select,a[href],summary",
        ) || [],
      ).filter((e) => e.offsetParent !== null);
    if (!modalRef.current?.contains(document.activeElement))
      focusables()[0]?.focus();
    const close = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeRef.current();
      if (e.key === "Tab") {
        const items = focusables();
        if (!items.length) return;
        const first = items[0],
          last = items.at(-1)!;
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", close);
    const old = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", close);
      document.body.style.overflow = old;
      previous?.focus();
    };
  }, []);
  return (
    <div
      className="veil"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <section
        ref={modalRef}
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <header>
          <h2>{title}</h2>
          <button aria-label="关闭" onClick={onClose}>
            <X size={20} />
          </button>
        </header>
        {children}
      </section>
    </div>
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
  useEffect(() => {
    const fn = () => setRoute(location.hash.slice(1) || "stories");
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
    <div className="app">
      <aside className="sidebar" data-guide="sidebar">
        <a className="brand" href="#stories">
          <img className="brand-mark" src={brandMark} alt="" width={48} height={48} />
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
          <StoryPage id={route.slice(6)} notify={setNotice} />
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
}: {
  value: Role;
  onSave: (r: Role) => Promise<void>;
  onClose: () => void;
}) {
  const [r, setR] = useState(structuredClone(value));
  const update = (patch: Partial<Role>) => setR({ ...r, ...patch });
  const [busy, setBusy] = useState(false);
  return (
    <Modal title={"角色档案 · " + (value.name || "新朋友")} onClose={onClose}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            await onSave({ ...r, updated: Date.now() });
            onClose();
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="role-top">
          <Avatar role={r} size={68} />
          <Field label="头像">
            <input
              type="file"
              accept="image/*"
              onChange={async (e) => {
                const f = e.target.files?.[0];
                if (!f) return;
                if (!f.type.startsWith("image/")) throw Error("请选择图片");
                const reader = new FileReader();
                reader.onload = () => update({ avatar: String(reader.result) });
                reader.readAsDataURL(f);
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
            onChange={async (e) => {
              const f = e.target.files?.[0];
              if (f) {
                const persona = await f.text();
                update({
                  persona,
                  paragraphs: paragraphs(persona, r.paragraphs),
                });
              }
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
        <button disabled={busy} className="primary" type="submit">
          {busy ? "保存中…" : "保存角色"}
        </button>
      </form>
    </Modal>
  );
}
function RolesPage({ notify }: { notify: Notice }) {
  const roles = useLiveQuery(() => db.roles.toArray(), []) || [];
  const [editing, setEditing] = useState<Role>();
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
          onClick={() =>
            setEditing({
              id: uid(),
              name: "",
              bio: "",
              persona: "",
              avatar: "",
              paragraphs: [],
              updated: Date.now(),
            })
          }
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
              <button onClick={() => setEditing(r)}>翻开档案</button>
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
          value={editing}
          onClose={() => setEditing(undefined)}
          onSave={async (r) => {
            await db.roles.put(r);
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
  return (
    <div>
      <p className="hint">
        本地估算 {report.estimate.toLocaleString()} /{" "}
        {report.limit.toLocaleString()} token
        {report.usage &&
          ` · 服务实际用量 输入 ${report.usage.input} / 输出 ${report.usage.output}`}
      </p>
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
          <pre>{report.system + "\n\n" + report.user}</pre>
        </details>
      )}
    </div>
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
  return (
    <Modal title="修改这一刻" onClose={onClose}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          await reviseEvent(
            event.id,
            text,
            false,
            facts.filter((f) => f.quote.trim() && text.includes(f.quote)),
          );
          onClose();
        }}
      >
        <p className="hint">
          旧版本与后文都会保留。相关记忆将暂停使用，等待复核。
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
            <h3>角色可知的事实摘录</h3>
            <p className="hint">
              只有在这里明确授权的摘录会进入角色聊天。心理与秘密请保持“仅作者”。摘录必须逐字来自正文。
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
          </>
        )}
        <button className="primary" type="submit">
          保存新版本
        </button>
      </form>
    </Modal>
  );
}
function Memories({
  s,
  notify,
  onClose,
}: {
  s: Story;
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
  const [editing, setEditing] = useState<Memory>();
  const [mergedIds, setMergedIds] = useState<string[]>([]);
  useEffect(() => setMergedIds([]), [editing?.id]);
  const [busy, setBusy] = useState(false);
  async function accept(m: Memory) {
    const valid = m.sources.every((src) => {
      const e = events.find((x) => x.id === src.id);
      return e && !e.deleted && e.status === "complete";
    });
    if (!valid) throw Error("来源不存在或已删除，请忽略这条记忆");
    await db.memories.put({
      ...m,
      status: "accepted",
      sources: m.sources.map((src) => ({
        id: src.id,
        versionId: events.find((x) => x.id === src.id)!.versionId,
      })),
    });
    notify("记忆已确认，将按知情范围带入后续生成");
  }
  return (
    <Modal title="这本故事的记忆" onClose={onClose}>
      <ContextTip id="memory" title="记住什么，由你决定">
        <p>
          自动整理的内容会先成为候选。检查内容和知情角色，点击「接受」后才会作为长久记忆使用；写错的可以编辑，不需要的可以忽略。
        </p>
      </ContextTip>
      <p className="hint">
        候选需要你点头。仅作者可见的记忆不会出现在角色聊天中。
      </p>
      <div className="row">
        <button
          disabled={busy || isBusy(s.id)}
          className="primary"
          onClick={async () => {
            setBusy(true);
            try {
              await organizeMemory(s.id);
              notify("整理完成，请审核候选");
            } catch (e) {
              notify(String(e));
            } finally {
              setBusy(false);
            }
          }}
        >
          <RefreshCw size={16} />
          {busy ? "整理中…" : "立即整理"}
        </button>
        <span className="hint">处理进度 · 节点 {s.memoryCursor}</span>
      </div>
      {s.memoryError && <p className="error">{s.memoryError}</p>}
      <details>
        <summary>自动整理频率</summary>
        <Toggle
          label="自动整理（只在当前页面打开时运行）"
          value={s.autoMemory}
          onChange={async (v) => {
            await db.stories.update(s.id, { autoMemory: v });
          }}
        />
        <div className="two-col">
          <Field label="每新增几条聊天气泡 · 0 关闭">
            <input
              type="number"
              min="0"
              value={s.chatThreshold}
              onChange={async (e) => {
                await db.stories.update(s.id, {
                  chatThreshold: Math.max(0, Number(e.target.value)),
                });
              }}
            />
          </Field>
          <Field label="每新增几段完整小说 · 0 关闭">
            <input
              type="number"
              min="0"
              value={s.novelThreshold}
              onChange={async (e) => {
                await db.stories.update(s.id, {
                  novelThreshold: Math.max(0, Number(e.target.value)),
                });
              }}
            />
          </Field>
        </div>
      </details>
      {items
        .filter((m) => m.status !== "ignored")
        .map((m) => (
          <article className="memory-card" key={m.id}>
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
              {m.status !== "accepted" && m.status !== "invalid" && (
                <button onClick={() => accept(m)}>
                  接受{m.status === "review" ? "并确认新来源" : ""}
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
                  status:
                    editing.status === "accepted" || mergedIds.length
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
    </Modal>
  );
}
function StoryPage({ id, notify }: { id: string; notify: Notice }) {
  const [localInputs, setLocalInputs] = useState<Record<string, string>>({});
  const s = useLiveQuery(() => db.stories.get(id), [id]);
  const events =
    useLiveQuery(
      () => db.events.where("storyId").equals(id).sortBy("seq"),
      [id],
    ) || [];
  const prefs = useLiveQuery(() => db.preferences.get("preferences"), []);
  const world = useLiveQuery(() => db.world.toArray(), []) || [];
  const [mode, setMode] = useState<"novel" | "chat">("novel"),
    [panel, setPanel] = useState(""),
    [busy, setBusy] = useState(false),
    [editing, setEditing] = useState<SceneEvent>(),
    [versions, setVersions] = useState<SceneEvent>(),
    [role, setRole] = useState<Role>(),
    [reference, setReference] = useState<ContextReport>(),
    [saveState, setSaveState] = useState("已保存到本机");
  useEffect(() => {
    setPanel("");
    setEditing(undefined);
    setReference(undefined);
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
  function changeInput(value: string) {
    setLocalInputs((current) => ({ ...current, [inputKey]: value }));
    return update(mode === "novel" ? { draft: value } : { chatDraft: value });
  }
  async function submit(rewrite?: SceneEvent) {
    if (!s) return;
    setBusy(true);
    try {
      await run(
        id,
        rewrite?.kind === "novel" ? "novel" : rewrite ? "chat" : mode,
        rewrite?.input || input,
        rewrite?.id,
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
  const actions = (e: SceneEvent) => (
    <div className="event-actions">
      <button disabled={busy || isBusy(id)} onClick={() => setEditing(e)}>
        编辑
      </button>
      {(e.kind === "novel" || e.origin === "ai") && (
        <button disabled={busy || isBusy(id)} onClick={() => submit(e)}>
          重写
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
        <button onClick={() => setReference(e.request)}>参考内容</button>
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
    <div className="story-page">
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
          <button data-guide="memory" onClick={() => setPanel("memory")}>
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
              setReference(await preview(id, mode, input));
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
      {events.some(
        (event) =>
          event.kind === "novel" &&
          event.status === "complete" &&
          !event.deleted,
      ) && (
        <StarterCelebration
          story={s}
          onContinue={() => {
            setMode("novel");
            document.getElementById("story-input")?.focus();
          }}
          onChat={() => setMode("chat")}
        />
      )}
      {mode === "chat" && (
        <ContextTip id="chat" title="选好身份，再开始聊天">
          <p>
            「我扮演」是你发消息时的身份，「聊天对象」是回复你的角色。私聊只对双方可知；正文里的事情，需要在段落「编辑」中指定谁知道，才会进入对应角色的聊天参考。
          </p>
        </ContextTip>
      )}
      {mode === "chat" && s.roles.length < 2 && (
        <div className="starter-reminder">
          <span>
            聊天需要至少两位角色。先在角色库添加一位，再到故事设置中带入。
          </span>
          <button onClick={() => setPanel("settings")}>打开故事设置</button>
        </div>
      )}
      {mode === "chat" && (
        <div className="chat-identity">
          <Field label="我扮演">
            <select
              aria-label="我扮演"
              value={s.player}
              disabled={busy}
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
              disabled={busy}
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
          <div className="opening">
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
                  <summary>查看双方可知的事实</summary>
                  {e.facts
                    .filter((f) => pair.every((id) => f.knownBy.includes(id)))
                    .map((f) => (
                      <p key={f.id}>{f.text}</p>
                    ))}
                  <small>全知正文不会直接提供给聊天角色。</small>
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
              className={
                e.kind === "novel"
                  ? "prose-event"
                  : "message-event " +
                    (e.speaker === s.player ? "mine" : "theirs")
              }
            >
              {e.kind === "novel" ? (
                <span className="event-number">
                  {String(i + 1).padStart(2, "0")} / 这一刻
                </span>
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
                  早期内容已修改，这一条可能受影响。
                  <button
                    onClick={async () => {
                      await db.events.update(e.id, { review: false });
                    }}
                  >
                    确认沿用
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
              <p className="event-text">{e.text || "文字正在路上…"}</p>
              {e.error && <p className="error">{e.error}</p>}
              {e.status === "complete" ? (
                actions(e)
              ) : (
                <div className="row">
                  <button
                    disabled={busy}
                    onClick={() => {
                      changeInput(e.input);
                      notify("原输入已放回输入框；草稿仍保留");
                    }}
                  >
                    取回输入
                  </button>
                  <button
                    disabled={busy}
                    onClick={async () => {
                      await db.events.delete(e.id);
                    }}
                  >
                    删除草稿
                  </button>
                </div>
              )}
            </article>
          );
        })}
        {!visible.length && (
          <Empty>
            {mode === "novel"
              ? "写下动作或一句台词，把这一刻交给文字。"
              : "选好彼此的身份，发出第一条消息。"}
          </Empty>
        )}
      </section>
      {mode === "novel" && (
        <FirstSceneCoach
          story={s}
          events={events}
          onExample={(text) => {
            if (!input.trim()) {
              changeInput(text);
              document.getElementById("story-input")?.focus();
            } else {
              notify("输入框已经有内容，可以参考示例自行调整。");
            }
          }}
        />
      )}
      <section
        className="composer"
        id="story-composer"
        data-guide="novel-compose"
      >
        {mode === "novel" && (
          <div className="composer-options">
            <select
              aria-label="扩写篇幅"
              value={s.length}
              onChange={(e) => update({ length: e.target.value })}
            >
              {["简短", "适中", "细腻"].map((x) => (
                <option key={x}>{x}</option>
              ))}
            </select>
            <input
              aria-label="文风"
              list="styles"
              value={s.style}
              onChange={(e) => update({ style: e.target.value })}
            />
            <datalist id="styles">
              {["自然白描", "清新细腻", "克制留白", "轻松日常"].map((x) => (
                <option key={x}>{x}</option>
              ))}
            </datalist>
            <Toggle
              label="心理描写"
              value={s.psychology}
              onChange={(v) => update({ psychology: v })}
            />
          </div>
        )}
        <textarea
          id="story-input"
          aria-label={mode === "novel" ? "本段动作或台词" : "聊天消息"}
          value={input}
          onChange={(e) => changeInput(e.target.value)}
          placeholder={
            mode === "novel"
              ? "他把伞递给她，说“拿着”，但没有看她。\n写下发生的事，扩写会停在你给出的最后一刻。"
              : "以你的角色身份，发一条消息……"
          }
          onKeyDown={(e) => {
            if (
              (e.ctrlKey || e.metaKey) &&
              e.key === "Enter" &&
              !e.nativeEvent.isComposing &&
              !busy
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
                setReference(await preview(id, mode, input));
              } catch (e) {
                notify(String(e));
              }
            }}
          >
            本次参考内容
          </button>
          <span className="hint">Ctrl / ⌘ + Enter</span>
          {busy || isBusy(id) ? (
            <button className="primary" onClick={() => stop(id)}>
              <Square size={15} />
              停止生成
            </button>
          ) : (
            <button
              className="primary"
              disabled={
                !input.trim() ||
                (mode === "chat" && (!s.partner || s.player === s.partner))
              }
              onClick={() => submit()}
            >
              {mode === "novel" ? <Feather size={16} /> : <Send size={16} />}{" "}
              {mode === "novel" ? "扩写这一刻" : "发送消息"}
            </button>
          )}
        </footer>
      </section>
      {panel === "memory" && (
        <Memories s={s} notify={notify} onClose={() => setPanel("")} />
      )}{" "}
      {panel === "settings" && (
        <Modal title="这本故事的设定" onClose={() => setPanel("")}>
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
          <div className="row">
            <button
              onClick={() =>
                download(
                  s.title + ".txt",
                  s.title +
                    "\n\n" +
                    events
                      .filter((e) => e.status === "complete" && !e.deleted)
                      .map((e) =>
                        e.kind === "novel"
                          ? e.text
                          : `[手机聊天 / ${s.roles.find((r) => r.id === e.speaker)?.name}] ${e.text}`,
                      )
                      .join("\n\n"),
                  "text/plain",
                )
              }
            >
              <Download size={16} />
              导出全文与聊天
            </button>
            <button
              onClick={() =>
                download(
                  s.title + "-聊天.txt",
                  events
                    .filter(
                      (e) =>
                        e.kind === "message" &&
                        e.status === "complete" &&
                        !e.deleted,
                    )
                    .map(
                      (e) =>
                        `${s.roles.find((r) => r.id === e.speaker)?.name}：${e.text}`,
                    )
                    .join("\n\n"),
                  "text/plain",
                )
              }
            >
              单独导出聊天
            </button>
          </div>
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
          <Reference report={reference} developer={prefs?.developer} />
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
function SettingsPage({ notify }: { notify: Notice }) {
  const profiles = useLiveQuery(() => db.profiles.toArray(), []) || [],
    prefs = useLiveQuery(() => db.preferences.get("preferences"), []);
  const [edit, setEdit] = useState<Profile>(),
    [backup, setBackup] = useState<Backup>(),
    [kind, setKind] = useState<PromptKind>("novel"),
    [custom, setCustom] = useState(""),
    [importing, setImporting] = useState(false);
  useEffect(() => {
    setCustom(prefs?.prompts[kind]?.text ?? defaults[kind]);
  }, [kind, prefs?.prompts[kind]?.text]);
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
      <section className="settings-card">
        <h2>保存与迁移</h2>
        <p>
          角色、人设、头像、故事版本与记忆都保存在这台设备的浏览器中。清理浏览器数据会移除它们，请定期导出。
        </p>
        <div className="row">
          <button
            onClick={async () =>
              download(
                "此间-完整备份-" +
                  new Date().toISOString().slice(0, 10) +
                  ".json",
                JSON.stringify(await exportBackup(), null, 2),
              )
            }
          >
            <Download size={16} />
            导出完整备份（不含 Key）
          </button>
          <label className="file-button">
            导入备份
            <input
              type="file"
              accept=".json,application/json"
              onChange={async (e) => {
                const f = e.target.files?.[0];
                if (!f) return;
                try {
                  setBackup(validateBackup(JSON.parse(await f.text())));
                } catch {
                  notify("备份格式或关联不完整，没有修改现有资料");
                }
                e.target.value = "";
              }}
            />
          </label>
        </div>
      </section>
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
            <Field label="编辑提示词">
              <select
                value={kind}
                onChange={(e) => setKind(e.target.value as PromptKind)}
              >
                <option value="novel">小说扩写</option>
                <option value="chat">手机聊天</option>
                <option value="facts">事实摘录</option>
                <option value="memory">记忆整理</option>
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
      {edit && (
        <ProfileEditor
          value={edit}
          notify={notify}
          onClose={() => setEdit(undefined)}
        />
      )}{" "}
      {backup && (
        <Modal title="导入预览" onClose={() => setBackup(undefined)}>
          <p>
            这份备份来自 {backup.created.slice(0, 10)}，包含{" "}
            {backup.roles.length} 位角色、{backup.stories.length} 本故事、
            {backup.events.length} 条经历、{backup.memories.length} 条记忆。
          </p>
          <p className="hint">
            默认作为副本合并，自动重建关联。自定义提示词按备份中的版本合并。接口密钥需要重新填写。
          </p>
          <div className="row">
            <button
              className="primary"
              disabled={importing}
              onClick={async () => {
                setImporting(true);
                try {
                  await importBackup(backup);
                  setBackup(undefined);
                  notify("已作为副本导入，原资料完整保留");
                } catch (e) {
                  notify("导入失败，原数据未改变 · " + String(e));
                } finally {
                  setImporting(false);
                }
              }}
            >
              作为副本合并
            </button>
            <button
              className="danger"
              disabled={importing}
              onClick={async () => {
                if (
                  !confirm(
                    "替换将移除当前全部故事和角色。确定已经保存备份，并用这份文件替换全部资料吗？",
                  )
                )
                  return;
                setImporting(true);
                try {
                  await importBackup(backup, true);
                  setBackup(undefined);
                  notify("已完整替换资料");
                } catch (e) {
                  notify("替换失败，原数据未改变 · " + String(e));
                } finally {
                  setImporting(false);
                }
              }}
            >
              替换全部资料
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
