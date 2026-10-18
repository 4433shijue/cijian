import { useState, useEffect } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { db } from "./db";
import { createStory } from "./story-service";
import type { Story } from "./types";

export function CreateStory({
  onCreated,
  draftKey = "cijian-create-work-v3",
  initialRoleIds = [],
  onAddRole,
}: {
  onCreated: (story: Story) => void;
  draftKey?: string;
  initialRoleIds?: string[];
  onAddRole?: () => void;
}) {
  const [saved] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem(draftKey) || "null") as {
        kind?: Story["kind"];
        title: string;
        background: string;
        secret: string;
        selected: string[];
        worldIds: string[];
        audience?: string[];
      } | null;
    } catch {
      return null;
    }
  });
  const roles = useLiveQuery(() => db.roles.toArray(), []) || [];
  const world =
    useLiveQuery(
      () => db.world.filter((w) => !w.storyIds.length).toArray(),
      [],
    ) || [];
  const [kind, setKind] = useState<Story["kind"] | undefined>(saved?.kind);
  const [title, setTitle] = useState(saved?.title || ""),
    [background, setBackground] = useState(saved?.background || ""),
    [secret, setSecret] = useState(saved?.secret || "");
  const [selected, setSelected] = useState<string[]>(
      saved?.selected || initialRoleIds,
    ),
    [worldIds, setWorldIds] = useState<string[]>(saved?.worldIds || []);
  const [audience, setAudience] = useState<string[] | undefined>(
      saved?.audience,
    ),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  useEffect(() => {
    try {
      localStorage.setItem(
        draftKey,
        JSON.stringify({
          kind,
          title,
          background,
          secret,
          selected,
          worldIds,
          audience,
        }),
      );
    } catch {}
  }, [draftKey, kind, title, background, secret, selected, worldIds, audience]);
  const toggle = (list: string[], id: string) =>
    list.includes(id) ? list.filter((x) => x !== id) : [...list, id];
  if (!kind)
    return (
      <section className="work-mode-picker">
        <h2>先选择作品模式</h2>
        <p>每本作品拥有自己的角色设定与经历，创建后模式固定。</p>
        <div className="work-mode-options">
          <button onClick={() => setKind("novel")}>
            <b>小说模式</b>
            <span>写正文、整理记忆，展开角色的故事。</span>
          </button>
          <button onClick={() => setKind("phone")}>
            <b>手机模式</b>
            <span>聊天、朋友圈与手机里的秘密，编成可探索的作品。</span>
          </button>
        </div>
      </section>
    );
  return (
    <form
      className="work-create"
      onSubmit={async (e) => {
        e.preventDefault();
        if (busy) return;
        setBusy(true);
        setError("");
        try {
          const story = await createStory({
            kind,
            title,
            background,
            secret,
            roles: roles.filter((r) => selected.includes(r.id)),
            worldIds,
            audience: audience?.filter((id) => selected.includes(id)),
          });
          try {
            localStorage.removeItem(draftKey);
          } catch {}
          onCreated(story);
        } catch (e) {
          setError(String(e));
        } finally {
          setBusy(false);
        }
      }}
    >
      <div className="row">
        <strong>{kind === "phone" ? "手机作品" : "小说作品"}</strong>
        <button type="button" onClick={() => setKind(undefined)}>
          重新选择模式
        </button>
      </div>
      <label className="field">
        作品名字
        <input
          autoFocus
          required
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
      </label>
      <fieldset>
        <legend>选择角色</legend>
        {roles.map((r) => (
          <label className="toggle" key={r.id}>
            <input
              type="checkbox"
              checked={selected.includes(r.id)}
              onChange={() => setSelected(toggle(selected, r.id))}
            />
            {r.name}
          </label>
        ))}
      </fieldset>
      {onAddRole && (
        <button type="button" onClick={onAddRole}>
          添加角色
        </button>
      )}
      {!roles.length && (
        <p>
          先到<a href="#roles">角色库添加角色</a>，再回来创建作品。
        </p>
      )}
      <label className="field">
        {kind === "phone" ? "手机开场背景" : "开场背景 · 作者视角"}
        <textarea
          value={background}
          onChange={(e) => setBackground(e.target.value)}
        />
      </label>
      {kind === "phone" && (
        <>
          <fieldset>
            <legend>哪些角色知道开场背景</legend>
            {roles
              .filter((r) => selected.includes(r.id))
              .map((r) => (
                <label className="toggle" key={r.id}>
                  <input
                    type="checkbox"
                    checked={(audience || selected).includes(r.id)}
                    onChange={() =>
                      setAudience(toggle(audience || selected, r.id))
                    }
                  />
                  {r.name}
                </label>
              ))}
          </fieldset>
          <label className="field">
            作者秘密 · 不提供给角色
            <textarea
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
            />
          </label>
        </>
      )}
      <details>
        <summary>带入世界书副本</summary>
        {world.map((w) => (
          <label className="toggle" key={w.id}>
            <input
              type="checkbox"
              checked={worldIds.includes(w.id)}
              onChange={() => setWorldIds(toggle(worldIds, w.id))}
            />
            {w.title}
          </label>
        ))}
      </details>
      <p className="hint">角色与世界书保存为本作品的独立副本。</p>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <button className="primary" disabled={busy || !selected.length}>
        {busy
          ? "正在创建…"
          : kind === "phone"
            ? "创建手机作品"
            : "创建小说作品"}
      </button>
    </form>
  );
}
