import { StoryImageSettings, RoleImageFields } from "./ImageSettings";
import { PhoneAutomation } from "./PhoneAutomation";
import { useState, type ComponentType } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { db, deleteStory } from "./db";
import { attachWorld, migrateStories, updateStory } from "./story-service";
import { paragraphs, uid, type Story } from "./types";
import { lazyPanel } from "./lazy-panel";
const PhonePanel = lazyPanel(() => import("./PhonePanel"));
const StoryTransfer = lazyPanel(() => import("./TransferPanels").then(m => ({ default: m.StoryTransfer })));
import { Modal } from "./Modal";
const PhoneDocuments = lazyPanel(() => import("./PhoneDocuments").then(m => ({ default: m.PhoneDocuments })));
const PhoneBatch = lazyPanel(() => import("./PhoneBatch").then(m => ({ default: m.PhoneBatch })));
const PhoneReaderEditor = lazyPanel(() => import("./PhoneReaderEditor").then(m => ({ default: m.PhoneReaderEditor })));
import "./work.css";

export function MigrationNotice() {
  const rows =
    useLiveQuery(
      () =>
        db.storyMigrations
          .filter((r) => !r.acknowledged && r.storyId === r.novelId)
          .toArray(),
      [],
    ) || [];
  const works = useLiveQuery(() => db.stories.toArray(), []) || [];
  if (!rows.length) return null;
  return (
    <aside className="work-notice">
      <strong>旧故事已拆分为独立的小说与手机作品</strong>
      <p>手机已保存角色当时可知的背景，此后两边分别发展。</p>
      {rows.map((r) => (
        <div key={r.id}>
          {works.some((s) => s.id === r.novelId) && (
            <a href={"#story/" + r.novelId}>进入小说</a>
          )}{" "}
          {works.some((s) => s.id === r.phoneId) && (
            <a href={"#story/" + r.phoneId}>进入手机</a>
          )}
        </div>
      ))}
      <button
        onClick={() =>
          void db.storyMigrations.toCollection().modify({ acknowledged: true })
        }
      >
        知道了
      </button>
    </aside>
  );
}
export function WorkPage({
  novel: Novel,
  ...props
}: {
  novel: ComponentType<any>;
  id: string;
  notify: (s: string) => void;
  reading: boolean;
  onReadingChange: (v: boolean) => void;
}) {
  const story = useLiveQuery(
    async () => (await db.stories.get(props.id)) || null,
    [props.id],
  );
  const [error, setError] = useState("");
  if (story === undefined) return <div className="page">正在读取作品…</div>;
  if (story === null)
    return (
      <div className="page">
        <p>这本作品已不存在。</p>
        <a href="#stories">返回作品列表</a>
      </div>
    );
  if (!story.kind)
    return (
      <section className="page">
        <h1>这本作品需要完成拆分</h1>
        <p>原始存档仍保留。请关闭其他旧版本页面，再重试。</p>
        <button
          onClick={() =>
            void migrateStories().catch((e) => setError(String(e)))
          }
        >
          重试迁移
        </button>
        {error && <p role="alert">{error}</p>}
      </section>
    );
  return story.kind === "novel" ? (
    <Novel {...props} />
  ) : (
    <PhoneWork story={story} notify={props.notify} />
  );
}
function PhoneWork({
  story,
  notify,
}: {
  story: Story;
  notify: (s: string) => void;
}) {
  const [tab, setTab] = useState("phone"),
    [transfer, setTransfer] = useState(false),
    [settings, setSettings] = useState(false);
  return (
    <section className="page phone-work">
      <header className="page-heading">
        <div>
          <a href="#stories">‹ 我的作品</a>
          <h1>{story.title}</h1>
          <p>手机作品 · 他们的消息，也藏着没说出口的事。</p>
        </div>
        <div className="row">
          <button onClick={() => setSettings(true)}>作品设置</button>
          <button onClick={() => setTransfer(true)}>备份与导出</button>
        </div>
      </header>
      <nav className="work-tabs" aria-label="手机工作区">
        {[
          ["phone", "角色手机"],
          ["automation", "让故事继续"],
          ["documents", "备忘录与相册"],
          ["background", "背景与知情"],
          ["batch", "批量编排"],
          ["reader", "阅读编排与分享"],
        ].map(([id, label]) => (
          <button
            key={id}
            aria-current={tab === id ? "page" : undefined}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
      </nav>
      {tab === "phone" && <PhonePanel story={story} />}
      {tab === "automation" && <PhoneAutomation story={story} />}
      {tab === "documents" && <PhoneDocuments story={story} />}
      {tab === "background" && <PhoneBackgrounds story={story} />}
      {tab === "batch" && <PhoneBatch story={story} />}
      {tab === "reader" && <PhoneReaderEditor story={story} />}
      {transfer && (
        <Modal title="备份与导出" onClose={() => setTransfer(false)}>
          <StoryTransfer story={story} notify={notify} />
        </Modal>
      )}
      {settings && (
        <Modal title="手机作品设置" onClose={() => setSettings(false)}>
          <WorkSettings story={story} notify={notify} />
        </Modal>
      )}
    </section>
  );
}
export function WorkWorldEditor({ story }: { story: Story }) {
  const entries =
    useLiveQuery(
      () => db.storyWorld.where("storyId").equals(story.id).toArray(),
      [story.id],
    ) || [];
  const templates = useLiveQuery(() => db.world.toArray(), []) || [];
  const [template, setTemplate] = useState(""),
    [error, setError] = useState("");
  return (
    <section className="work-world">
      <h3>本作品的世界书</h3>
      <p className="hint">修改副本只影响这本作品。</p>
      {entries.map((w) => (
        <details key={w.id}>
          <summary>
            {w.title}
            {w.enabled ? "" : " · 已停用"}
          </summary>
          <label className="field">
            标题
            <input
              defaultValue={w.title}
              onBlur={(e) =>
                void db.storyWorld.update(w.id, { title: e.target.value })
              }
            />
          </label>
          <label className="field">
            内容
            <textarea
              defaultValue={w.text}
              onBlur={(e) =>
                void db.storyWorld.update(w.id, { text: e.target.value })
              }
            />
          </label>
          <label className="toggle">
            <input
              type="checkbox"
              checked={w.enabled}
              onChange={(e) =>
                void db.storyWorld.update(w.id, { enabled: e.target.checked })
              }
            />
            启用
          </label>
          <label className="toggle">
            <input
              type="checkbox"
              checked={w.always}
              onChange={(e) =>
                void db.storyWorld.update(w.id, { always: e.target.checked })
              }
            />
            始终参考
          </label>
          {!w.always && (
            <label className="field">
              触发词（逗号分隔）
              <input
                defaultValue={w.keywords.join("，")}
                onBlur={(e) =>
                  void db.storyWorld.update(w.id, {
                    keywords: e.target.value
                      .split(/[,，]/)
                      .map((v) => v.trim())
                      .filter(Boolean),
                  })
                }
              />
            </label>
          )}
          <label className="field">
            知情范围
            <select
              value={w.audience}
              onChange={(e) =>
                void db.storyWorld.update(w.id, {
                  audience: e.target.value as typeof w.audience,
                })
              }
            >
              <option value="all">全部角色</option>
              <option value="roles">指定角色</option>
              <option value="author">仅作者</option>
            </select>
          </label>
          {w.audience === "roles" &&
            story.roles.map((r) => (
              <label className="toggle" key={r.id}>
                <input
                  type="checkbox"
                  checked={w.knownBy.includes(r.id)}
                  onChange={(e) =>
                    void db.storyWorld.update(w.id, {
                      knownBy: e.target.checked
                        ? [...w.knownBy, r.id]
                        : w.knownBy.filter((id) => id !== r.id),
                    })
                  }
                />
                {r.name}
              </label>
            ))}
        </details>
      ))}
      <div className="row">
        <select
          aria-label="选择世界书模板"
          value={template}
          onChange={(e) => setTemplate(e.target.value)}
        >
          <option value="">选择模板</option>
          {templates.map((w) => (
            <option key={w.id} value={w.id}>
              {w.title}
            </option>
          ))}
        </select>
        <button
          disabled={!template}
          onClick={() =>
            void attachWorld(story.id, template)
              .then(() => setTemplate(""))
              .catch((e) => setError(String(e)))
          }
        >
          加入独立副本
        </button>
      </div>
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
function WorkSettings({
  story,
  notify,
}: {
  story: Story;
  notify: (s: string) => void;
}) {
  const library = useLiveQuery(() => db.roles.toArray(), []) || [];
  const [add, setAdd] = useState("");
  return (
    <>
      <label className="field">
        作品名字
        <input
          defaultValue={story.title}
          onBlur={(e) =>
            void updateStory(story.id, { title: e.target.value || story.title })
          }
        />
      </label>
      <label className="field">
        作者秘密 · 不提供给角色
        <textarea
          defaultValue={story.background}
          onBlur={(e) =>
            void updateStory(story.id, { background: e.target.value })
          }
        />
      </label>
      <StoryImageSettings story={story} />
      <h3>本作品角色</h3>
      {story.roles.map((r) => (
        <details key={r.id}>
          <summary>{r.name}</summary>
          <label className="field">
            名字
            <input
              defaultValue={r.name}
              onBlur={(e) =>
                void updateStory(story.id, {
                  roles: story.roles.map((x) =>
                    x.id === r.id ? { ...x, name: e.target.value } : x,
                  ),
                })
              }
            />
          </label>
          <label className="field">
            公开简介
            <textarea
              defaultValue={r.bio}
              onBlur={(e) =>
                void updateStory(story.id, {
                  roles: story.roles.map((x) =>
                    x.id === r.id ? { ...x, bio: e.target.value } : x,
                  ),
                })
              }
            />
          </label>
          <label className="field">
            完整人设
            <textarea
              defaultValue={r.persona}
              onBlur={(e) => {
                if (e.target.value !== r.persona)
                  void updateStory(story.id, {
                    roles: story.roles.map((x) =>
                      x.id === r.id
                        ? {
                            ...x,
                            persona: e.target.value,
                            paragraphs: paragraphs(e.target.value),
                          }
                        : x,
                    ),
                  });
              }}
            />
          </label>
          <RoleImageFields role={r} onChange={patch => {
            void db.transaction("rw", db.stories, async () => {
              const current = await db.stories.get(story.id);
              if (current) await db.stories.update(story.id, { roles: current.roles.map(x => x.id === r.id ? { ...x, ...patch, updated: Date.now() } : x) });
            }).catch(e => notify(String(e)));
          }} />
          <p className="hint">完整人设只向角色本人提供，公开信息写在简介中。</p>
        </details>
      ))}
      <div className="row">
        <select
          aria-label="添加角色"
          value={add}
          onChange={(e) => setAdd(e.target.value)}
        >
          <option value="">选择角色模板</option>
          {library.map((r) => (
            <option value={r.id} key={r.id}>
              {r.name}
            </option>
          ))}
        </select>
        <button
          disabled={!add}
          onClick={async () => {
            const r = library.find((r) => r.id === add)!;
            await updateStory(story.id, {
              roles: [
                ...story.roles,
                {
                  ...structuredClone(r),
                  id: uid(),
                  sourceId: r.id,
                  paragraphs: r.paragraphs.map((p) => ({ ...p, id: uid() })),
                },
              ],
            });
            setAdd("");
          }}
        >
          加入角色副本
        </button>
      </div>
      <WorkWorldEditor story={story} />
      <hr />
      <button
        onClick={async () => {
          if (confirm("删除这本手机作品及其附件？其他作品不受影响。")) {
            await deleteStory(story.id);
            location.hash = "stories";
            notify("作品已删除");
          }
        }}
      >
        删除本作品
      </button>
    </>
  );
}
function PhoneBackgrounds({ story }: { story: Story }) {
  const entries =
    useLiveQuery(
      () => db.phoneBackgrounds.where("storyId").equals(story.id).toArray(),
      [story.id],
    ) || [];
  const archives =
    useLiveQuery(
      () => db.legacyArchives.where("storyId").equals(story.id).toArray(),
      [story.id],
    ) || [];
  return (
    <section className="work-section">
      <h2>背景与角色知情</h2>
      <p>这里只保存本作品的背景。承接资料不会再随原小说变化。</p>
      <button
        onClick={() =>
          void db.phoneBackgrounds.add({
            id: uid(),
            storyId: story.id,
            title: "新的背景",
            text: "",
            audience: story.roles.map((r) => r.id),
            enabled: false,
            updated: Date.now(),
          })
        }
      >
        添加背景
      </button>
      {entries.map((b) => (
        <details className="work-card" key={b.id}>
          <summary>
            {b.title}
            {b.enabled ? " · 正在参考" : " · 未启用"}
          </summary>
          <label className="field">
            标题
            <input
              defaultValue={b.title}
              onBlur={(e) =>
                void db.phoneBackgrounds.update(b.id, {
                  title: e.target.value,
                  updated: Date.now(),
                })
              }
            />
          </label>
          <label className="field">
            背景内容
            <textarea
              defaultValue={b.text}
              onBlur={(e) =>
                void db.phoneBackgrounds.update(b.id, {
                  text: e.target.value,
                  updated: Date.now(),
                })
              }
            />
          </label>
          <label className="toggle">
            <input
              type="checkbox"
              checked={b.enabled}
              onChange={(e) =>
                void db.phoneBackgrounds.update(b.id, {
                  enabled: e.target.checked,
                })
              }
            />
            用于后续生成
          </label>
          <fieldset>
            <legend>知情角色</legend>
            {story.roles.map((r) => (
              <label className="toggle" key={r.id}>
                <input
                  type="checkbox"
                  checked={b.audience.includes(r.id)}
                  onChange={(e) =>
                    void db.phoneBackgrounds.update(b.id, {
                      audience: e.target.checked
                        ? [...b.audience, r.id]
                        : b.audience.filter((id) => id !== r.id),
                    })
                  }
                />
                {r.name}
              </label>
            ))}
          </fieldset>
        </details>
      ))}
      {!!archives.length && (
        <details>
          <summary>旧版兼容归档（{archives.length} 条，不参与生成）</summary>
          {archives.map((a) => (
            <details key={a.id}>
              <summary>
                {a.table} · {a.originalId.slice(0, 8)}
              </summary>
              <pre className="work-archive">
                {JSON.stringify(a.value, null, 2)}
              </pre>
            </details>
          ))}
        </details>
      )}
    </section>
  );
}
