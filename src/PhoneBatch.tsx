import { useEffect, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { db } from "./db";
import { uid, type Story } from "./types";
import { emptyBody } from "./phone-types";
import { phoneTime, recordText } from "./phone-store";
import {
  parseScript,
  saveComposition,
  copyComposition,
  adoptComposition,
  batchMessages,
  undoPhoneEdit,
  generateVariant,
  stopVariant,
} from "./phone-authoring";
import type { PhoneDraft } from "./work-types";

export function PhoneBatch({ story }: { story: Story }) {
  const conversations =
    useLiveQuery(
      () => db.phoneConversations.where("storyId").equals(story.id).toArray(),
      [story.id],
    ) || [];
  const [cid, setCid] = useState(""),
    [selected, setSelected] = useState<string[]>([]),
    [script, setScript] = useState(""),
    [mapping, setMapping] = useState<Record<string, string>>({}),
    [time, setTime] = useState(phoneTime()),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [draft, setDraft] = useState<PhoneDraft>(),
    [situation, setSituation] = useState(""),
    [drag, setDrag] = useState("");
  const records =
    useLiveQuery(
      () =>
        db.phoneRecords
          .where("conversationId")
          .equals(cid)
          .filter((r) => !r.deleted && !r.legacyDraft)
          .sortBy("seq"),
      [cid],
    ) || [];
  const drafts =
    useLiveQuery(
      () => db.phoneDrafts.where("conversationId").equals(cid).toArray(),
      [cid],
    ) || [];
  const edits =
    useLiveQuery(
      () => db.phoneEdits.where("conversationId").equals(cid).sortBy("created"),
      [cid],
    ) || [];
  useEffect(() => {
    if (!cid && conversations.length) setCid(conversations[0].id);
  }, [conversations.length]);
  useEffect(() => {
    setSelected([]);
    setDraft(undefined);
    setError("");
  }, [cid]);
  const c = conversations.find((c) => c.id === cid),
    name = (id: string) => story.roles.find((r) => r.id === id)?.name || "角色";
  const parsed = parseScript(script, story, mapping);
  const action = async (fn: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  const versions = (ids: string[]) =>
    Object.fromEntries(
      records.filter((r) => ids.includes(r.id)).map((r) => [r.id, r.versionId]),
    );
  const move = (id: string, target: string) => {
    if (id === target) return;
    const order = records.map((r) => r.id),
      from = order.indexOf(id),
      to = order.indexOf(target);
    if (from < 0 || to < 0) return;
    order.splice(from, 1);
    order.splice(to, 0, id);
    void action(() => batchMessages(story.id, cid, versions(order), { order }));
  };
  return (
    <section className="work-section">
      <h2>批量编排</h2>
      <label className="field">
        会话
        <select value={cid} onChange={(e) => setCid(e.target.value)}>
          <option value="">选择会话</option>
          {conversations.map((c) => (
            <option key={c.id} value={c.id}>
              {c.title || c.members.map(name).join("、")}
            </option>
          ))}
        </select>
      </label>
      {!c ? (
        <p>先到角色手机创建一段聊天。</p>
      ) : (
        <>
          <details className="work-card">
            <summary>粘贴整段剧本</summary>
            <label className="field">
              每条消息写成「角色名：内容」
              <textarea
                rows={7}
                value={script}
                onChange={(e) => setScript(e.target.value)}
                placeholder="林晚：你到家了吗？&#10;沈知言：刚到。"
              />
            </label>
            {[
              ...new Set(
                parsed.filter((r) => !r.speakerId).map((r) => r.label),
              ),
            ].map((label) => (
              <label className="field" key={label}>
                「{label}」对应角色
                <select
                  value={mapping[label] || ""}
                  onChange={(e) =>
                    setMapping({ ...mapping, [label]: e.target.value })
                  }
                >
                  <option value="">请选择</option>
                  {story.roles
                    .filter((r) => c.members.includes(r.id))
                    .map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.name}
                      </option>
                    ))}
                </select>
              </label>
            ))}
            {!!parsed.length && (
              <ol className="work-script-preview">
                {parsed.map((r, i) => (
                  <li key={i}>
                    {r.speakerId ? name(r.speakerId) : r.label}：{r.text}
                    {(r.error || !c.members.includes(r.speakerId)) && (
                      <small className="error">
                        {" "}
                        {r.error || "角色不在会话中"}
                      </small>
                    )}
                  </li>
                ))}
              </ol>
            )}
            <label className="field">
              剧情时间
              <input
                type="datetime-local"
                value={time}
                onChange={(e) => setTime(e.target.value)}
              />
            </label>
            <button
              disabled={
                busy ||
                !parsed.length ||
                parsed.some(
                  (r) => !!r.error || !c.members.includes(r.speakerId),
                )
              }
              onClick={() =>
                void action(async () => {
                  const d: PhoneDraft = {
                    id: uid(),
                    storyId: story.id,
                    conversationId: cid,
                    title: "导入剧本",
                    sourceVersions: {},
                    status: "draft",
                    updated: Date.now(),
                    lines: parsed.map((r) => ({
                      id: uid(),
                      speakerId: r.speakerId,
                      body: { ...emptyBody(), text: r.text },
                      time,
                      audience: c.members,
                    })),
                  };
                  setDraft(await saveComposition(d));
                })
              }
            >
              保存为编排草稿
            </button>
          </details>
          <div className="row">
            <button
              onClick={() =>
                setSelected(
                  selected.length === records.length
                    ? []
                    : records.map((r) => r.id),
                )
              }
            >
              全选／取消
            </button>
            <span>已选 {selected.length} 条</span>
            <button
              disabled={busy || !selected.length}
              onClick={() =>
                void action(async () =>
                  setDraft(await copyComposition(story.id, cid, selected)),
                )
              }
            >
              复制为对话变体
            </button>
          </div>
          <div className="row">
            <label>
              统一剧情时间{" "}
              <input
                aria-label="批量剧情时间"
                type="datetime-local"
                value={time}
                onChange={(e) => setTime(e.target.value)}
              />
            </label>
            <button
              disabled={busy || !selected.length || !time}
              onClick={() =>
                void action(() =>
                  batchMessages(story.id, cid, versions(selected), { time }),
                )
              }
            >
              应用到选中消息
            </button>
          </div>
          <div className="work-batch-list">
            {records.map((r, i) => (
              <article
                className="work-batch-row"
                key={r.id}
                draggable={!busy}
                onDragStart={() => setDrag(r.id)}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  move(drag, r.id);
                  setDrag("");
                }}
              >
                <label>
                  <input
                    aria-label={"选择消息 " + (i + 1)}
                    type="checkbox"
                    checked={selected.includes(r.id)}
                    onChange={(e) =>
                      setSelected(
                        e.target.checked
                          ? [...selected, r.id]
                          : selected.filter((id) => id !== r.id),
                      )
                    }
                  />
                  <strong>{name(r.speakerId)}</strong>
                  <small>{r.time}</small>
                </label>
                <p>{recordText(r)}</p>
                <div className="row">
                  <button
                    disabled={busy || i === 0}
                    onClick={() => move(r.id, records[i - 1].id)}
                  >
                    上移
                  </button>
                  <button
                    disabled={busy || i === records.length - 1}
                    onClick={() => move(r.id, records[i + 1].id)}
                  >
                    下移
                  </button>
                </div>
              </article>
            ))}
          </div>
          <details>
            <summary>编排草稿与变体（{drafts.length}）</summary>
            {drafts.map((d) => (
              <button
                className="work-draft-link"
                key={d.id}
                onClick={() => setDraft(structuredClone(d))}
              >
                {d.title} · {d.status === "adopted" ? "已采用" : "草稿"}
                {d.generation?.status === "failed" ? " · 上次生成失败" : ""}
              </button>
            ))}
          </details>
          <details>
            <summary>操作历史与撤销</summary>
            {[...edits].reverse().map((e) => (
              <div className="row" key={e.id}>
                <span>
                  {e.title} · {new Date(e.created).toLocaleString()}
                </span>
                <button
                  disabled={busy || e.undone}
                  onClick={() => void action(() => undoPhoneEdit(e.id))}
                >
                  {e.undone ? "已撤销" : "撤销本次操作"}
                </button>
              </div>
            ))}
          </details>
        </>
      )}
      {draft && (
        <section className="work-card work-draft-editor">
          <h3>编排草稿</h3>
          <p>保存或生成变体不会改变正式记录；采用后才会替换对应原消息。</p>
          <label className="field">
            草稿名称
            <input
              value={draft.title}
              onChange={(e) => setDraft({ ...draft, title: e.target.value })}
            />
          </label>
          {draft.lines.map((l, i) => (
            <div className="work-card" key={l.id}>
              <div className="row">
                <select
                  aria-label={"草稿角色 " + (i + 1)}
                  value={l.speakerId}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      lines: draft.lines.map((x) =>
                        x.id === l.id ? { ...x, speakerId: e.target.value } : x,
                      ),
                    })
                  }
                >
                  {story.roles
                    .filter((r) => l.audience.includes(r.id))
                    .map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.name}
                      </option>
                    ))}
                </select>
                <input
                  aria-label={"草稿时间 " + (i + 1)}
                  type="datetime-local"
                  value={l.time}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      lines: draft.lines.map((x) =>
                        x.id === l.id ? { ...x, time: e.target.value } : x,
                      ),
                    })
                  }
                />
              </div>
              <textarea
                aria-label={"草稿消息 " + (i + 1)}
                value={l.body.text}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    lines: draft.lines.map((x) =>
                      x.id === l.id
                        ? { ...x, body: { ...x.body, text: e.target.value } }
                        : x,
                    ),
                  })
                }
              />
              <button
                onClick={() =>
                  setDraft({
                    ...draft,
                    lines: draft.lines.filter((x) => x.id !== l.id),
                  })
                }
              >
                移除此条
              </button>
            </div>
          ))}
          <div className="row">
            <button
              disabled={busy || draft.status === "adopted"}
              onClick={() =>
                void action(async () => setDraft(await saveComposition(draft)))
              }
            >
              保存草稿
            </button>
            <button
              className="primary"
              disabled={
                busy || draft.status === "adopted" || !draft.lines.length
              }
              onClick={() =>
                void action(async () => {
                  const saved = await saveComposition(draft);
                  await adoptComposition(saved.id);
                  setDraft(await db.phoneDrafts.get(saved.id));
                })
              }
            >
              采用这份编排
            </button>
          </div>
          <label className="field">
            变体要求
            <textarea
              value={situation}
              onChange={(e) => setSituation(e.target.value)}
              placeholder="例如：保持事实不变，让对话更克制一些。"
            />
          </label>
          <div className="row">
            <button
              disabled={busy || !situation.trim() || draft.status === "adopted"}
              onClick={() =>
                void action(async () => {
                  const saved = await saveComposition(draft);
                  setDraft(saved);
                  await generateVariant(saved.id, situation);
                  setDraft(await db.phoneDrafts.get(saved.id));
                })
              }
            >
              让 AI 写一个变体
            </button>
            <button disabled={!busy} onClick={() => stopVariant(draft.id)}>
              停止变体生成
            </button>
            <button onClick={() => setDraft(undefined)}>关闭草稿</button>
          </div>
          {draft.generation?.error && (
            <p role="status">{draft.generation.error}</p>
          )}
        </section>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
