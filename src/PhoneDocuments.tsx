import { useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { db } from "./db";
import type { Story } from "./types";
import { Modal } from "./Modal";
import { savePhoneDocument } from "./phone-authoring";
import { saveAsset, phoneTime } from "./phone-store";
import type { PhoneDocument } from "./work-types";

export function PhoneDocuments({ story }: { story: Story }) {
  const docs =
    useLiveQuery(
      () => db.phoneDocuments.where("storyId").equals(story.id).toArray(),
      [story.id],
    ) || [];
  const assets =
    useLiveQuery(
      () => db.phoneAssets.where("storyId").equals(story.id).toArray(),
      [story.id],
    ) || [];
  const [owner, setOwner] = useState(story.player || story.roles[0]?.id),
    [kind, setKind] = useState<PhoneDocument["kind"]>("note"),
    [deleted, setDeleted] = useState(false),
    [album, setAlbum] = useState("");
  const [edit, setEdit] = useState<Partial<PhoneDocument>>(),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [image, setImage] = useState("");
  const list = docs
    .filter(
      (d) =>
        d.ownerId === owner &&
        d.kind === kind &&
        (deleted || !d.deleted) &&
        (!album || d.album === album),
    )
    .sort(
      (a, b) =>
        Number(b.pinned) - Number(a.pinned) || b.time.localeCompare(a.time),
    );
  const name = (id: string) =>
    story.roles.find((r) => r.id === id)?.name || "角色";
  const labels = { note: "备忘录", photo: "相册", draft: "剧情草稿箱" };
  const openNew = () =>
    setEdit({
      storyId: story.id,
      ownerId: owner,
      kind,
      title: "",
      text: "",
      time: phoneTime(),
      assets: [],
      audience: [owner],
      album: "",
      recipientId: "",
      pinned: false,
      deleted: false,
    });
  return (
    <section className="work-section">
      <div className="row">
        <h2>手机里的私人记录</h2>
        <label>
          机主{" "}
          <select
            value={owner}
            onChange={(e) => {
              setOwner(e.target.value);
              setAlbum("");
            }}
          >
            {story.roles.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      <nav className="work-tabs">
        {(["note", "photo", "draft"] as const).map((k) => (
          <button
            key={k}
            aria-current={kind === k ? "page" : undefined}
            onClick={() => {
              setKind(k);
              setAlbum("");
            }}
          >
            {labels[k]}
          </button>
        ))}
      </nav>
      <div className="row">
        <button onClick={openNew}>
          新增{kind === "photo" ? "照片" : labels[kind]}
        </button>
        <label className="toggle">
          <input
            type="checkbox"
            checked={deleted}
            onChange={(e) => setDeleted(e.target.checked)}
          />
          显示已删除
        </label>
        {kind === "photo" && (
          <select
            aria-label="相册分组"
            value={album}
            onChange={(e) => setAlbum(e.target.value)}
          >
            <option value="">全部相册</option>
            {[
              ...new Set(
                docs
                  .filter((d) => d.ownerId === owner && d.kind === "photo")
                  .map((d) => d.album)
                  .filter(Boolean),
              ),
            ].map((a) => (
              <option key={a}>{a}</option>
            ))}
          </select>
        )}
      </div>
      <p className="hint">
        默认只有机主知道。剧情草稿是故事内容，与输入框的自动保存草稿分开。
      </p>
      <div className="work-document-grid">
        {list.map((d) => (
          <article className="work-card" key={d.id}>
            <small>
              {d.time.replace("T", " ")}
              {d.deleted ? " · 已删除" : ""}
              {d.pinned ? " · 置顶" : ""}
            </small>
            <h3>{d.title}</h3>
            {d.recipientId && <p>未发送给 {name(d.recipientId)}</p>}
            <p className="work-pre">{d.text}</p>
            <div className="work-photo-grid">
              {d.assets.map((id) => {
                const a = assets.find((a) => a.id === id);
                return (
                  a && (
                    <button key={id} onClick={() => setImage(a.data)}>
                      <img src={a.data} alt={d.title} />
                    </button>
                  )
                );
              })}
            </div>
            <small>知情：{d.audience.map(name).join("、")}</small>
            <div className="row">
              <button
                onClick={() => {
                  setEdit(structuredClone(d));
                  setError("");
                }}
              >
                编辑与版本
              </button>
              <button
                onClick={() =>
                  void savePhoneDocument(
                    { ...d, deleted: !d.deleted },
                    d.versionId,
                  ).catch((e) => setError(String(e)))
                }
              >
                {d.deleted ? "恢复" : "删除"}
              </button>
            </div>
          </article>
        ))}
      </div>
      {!list.length && <p className="phone-empty">这里还没有记录。</p>}
      {error && !edit && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {edit && (
        <Modal
          title={"编辑" + labels[edit.kind!]}
          onClose={() => {
            if (!busy) setEdit(undefined);
          }}
        >
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              setError("");
              try {
                await savePhoneDocument(edit as PhoneDocument, edit.versionId);
                setEdit(undefined);
              } catch (e) {
                setError(String(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            <label className="field">
              标题
              <input
                required
                value={edit.title || ""}
                onChange={(e) => setEdit({ ...edit, title: e.target.value })}
              />
            </label>
            <label className="field">
              {edit.kind === "photo" ? "照片说明" : "内容"}
              <textarea
                aria-label={edit.kind === "photo" ? "照片说明" : "内容"}
                value={edit.text || ""}
                onChange={(e) => setEdit({ ...edit, text: e.target.value })}
              />
            </label>
            <label className="field">
              剧情时间
              <input
                type="datetime-local"
                value={edit.time}
                onChange={(e) => setEdit({ ...edit, time: e.target.value })}
              />
            </label>
            {edit.kind === "photo" && (
              <label className="field">
                相册名称
                <input
                  value={edit.album || ""}
                  onChange={(e) => setEdit({ ...edit, album: e.target.value })}
                />
              </label>
            )}
            {edit.kind === "draft" && (
              <label className="field">
                拟发送对象
                <select
                  value={edit.recipientId || ""}
                  onChange={(e) =>
                    setEdit({ ...edit, recipientId: e.target.value })
                  }
                >
                  <option value="">未指定</option>
                  {story.roles
                    .filter((r) => r.id !== edit.ownerId)
                    .map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.name}
                      </option>
                    ))}
                </select>
              </label>
            )}
            <fieldset>
              <legend>知情角色</legend>
              {story.roles.map((r) => (
                <label className="toggle" key={r.id}>
                  <input
                    type="checkbox"
                    disabled={r.id === edit.ownerId}
                    checked={edit.audience?.includes(r.id) || false}
                    onChange={(e) =>
                      setEdit({
                        ...edit,
                        audience: e.target.checked
                          ? [...(edit.audience || []), r.id]
                          : edit.audience?.filter((id) => id !== r.id),
                      })
                    }
                  />
                  {r.name}
                </label>
              ))}
            </fieldset>
            <label className="toggle">
              <input
                type="checkbox"
                checked={edit.pinned || false}
                onChange={(e) => setEdit({ ...edit, pinned: e.target.checked })}
              />
              置顶
            </label>
            <label className="field">
              上传图片
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp,image/gif"
                multiple
                disabled={busy}
                onChange={async (e) => {
                  const files = Array.from(e.target.files || []);
                  setBusy(true);
                  try {
                    for (const f of files) {
                      const id = await saveAsset(story.id, f);
                      setEdit((current) =>
                        current
                          ? {
                              ...current,
                              assets: [...(current.assets || []), id],
                            }
                          : current,
                      );
                    }
                  } catch (e) {
                    setError(String(e));
                  } finally {
                    setBusy(false);
                  }
                }}
              />
            </label>
            <details>
              <summary>选择本作品已有图片</summary>
              <div className="work-asset-grid">
                {assets
                  .filter((a) => a.mime.startsWith("image/"))
                  .map((a) => (
                    <label key={a.id}>
                      <input
                        type="checkbox"
                        checked={edit.assets?.includes(a.id) || false}
                        onChange={(e) =>
                          setEdit({
                            ...edit,
                            assets: e.target.checked
                              ? [...(edit.assets || []), a.id]
                              : edit.assets?.filter((id) => id !== a.id),
                          })
                        }
                      />
                      <img src={a.data} alt={a.name} />
                    </label>
                  ))}
              </div>
            </details>
            {!!edit.versions?.length && (
              <details>
                <summary>历史版本（{edit.versions.length}）</summary>
                {[...edit.versions].reverse().map((v) => (
                  <div className="work-card" key={v.id}>
                    <strong>{v.title}</strong>
                    <p className="work-pre">{v.text}</p>
                    <button
                      type="button"
                      onClick={() =>
                        setEdit({
                          ...edit,
                          title: v.title,
                          text: v.text,
                          time: v.time,
                          assets: v.assets,
                          album: v.album,
                          recipientId: v.recipientId,
                          audience: v.audience,
                          pinned: v.pinned,
                          deleted: v.deleted,
                        })
                      }
                    >
                      恢复此版本到编辑器
                    </button>
                  </div>
                ))}
              </details>
            )}
            {error && (
              <p className="error" role="alert">
                {error}
              </p>
            )}
            <button className="primary" disabled={busy}>
              {busy ? "正在保存…" : "保存文档"}
            </button>
          </form>
        </Modal>
      )}
      {image && (
        <Modal title="查看图片" onClose={() => setImage("")}>
          <img className="work-full-image" src={image} alt="完整图片" />
        </Modal>
      )}
    </section>
  );
}
