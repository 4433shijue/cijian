import { PhoneImageStatus } from "./ImagePanel";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { db } from "./db";
import type { Story } from "./types";
import { Modal } from "./Modal";
import {
  addRecord,
  canSee,
  changeGroup,
  conversation,
  deviceFor,
  editRecord,
  ensurePhone,
  likeMoment,
  phoneTime,
  recordText,
  saveAsset,
  updateDevice,
} from "./phone-store";
import {
  continuePhoneRun,
  dismissPhoneRun,
  startPhoneRun,
  stopPhone,
} from "./phone-generation";
import {
  defaultSkin,
  phoneBubbleInk,
  emptyBody,
  type PhoneBody,
  type PhoneRecord,
} from "./phone-types";
import { exportPhoneImages } from "./phone-export";
import "./phone.css";

function BodyEditor({
  value,
  onChange,
  storyId,
  moment = false,
  error,
  onSend,
}: {
  value: PhoneBody;
  onChange: (b: PhoneBody) => void;
  storyId: string;
  moment?: boolean;
  error: (s: string) => void;
  onSend?: () => void;
}) {
  const [uploading, setUploading] = useState(false);
  const latest = useRef(value);
  latest.current = value;
  const assets =
    useLiveQuery(
      () => db.phoneAssets.bulkGet(value.assets),
      [value.assets.join()],
    ) || [];
  return (
    <div className="phone-body-editor">
      {!moment && (
        <label>
          消息形式
          <select
            aria-label="消息形式"
            value={value.type}
            onChange={(e) =>
              onChange({
                ...emptyBody(),
                text: value.text,
                type: e.target.value as PhoneBody["type"],
              })
            }
          >
            <option value="text">文字</option>
            <option value="image">图片</option>
            <option value="sticker">表情</option>
            <option value="audio">语音</option>
            <option value="transfer">剧情转账</option>
            <option value="call">通话记录</option>
          </select>
        </label>
      )}
      <textarea
        aria-label={moment ? "动态内容" : "手机消息内容"}
        placeholder={
          value.type === "audio"
            ? "语音文字（AI 将参考这里的文字）"
            : value.type === "image" || value.type === "sticker"
              ? "图片说明（AI 将参考这里的文字）"
              : "写下内容…"
        }
        onKeyDown={(e) => {
          if (
            (e.ctrlKey || e.metaKey) &&
            e.key === "Enter" &&
            !uploading &&
            onSend
          ) {
            e.preventDefault();
            onSend();
          }
        }}
        value={value.text}
        onChange={(e) => onChange({ ...value, text: e.target.value })}
      />
      {value.type === "image" && <label className="field">照片画面说明
        <textarea aria-label="照片画面说明" value={value.imagePrompt || ""} onChange={e => onChange({ ...value, imagePrompt: e.target.value })} placeholder="画面里具体有什么；禁止自拍和拍摄者本人入镜" />
      </label>}
      {(moment || ["image", "sticker", "audio"].includes(value.type)) && (
        <label className="phone-upload">
          {uploading
            ? "正在保存素材…"
            : value.type === "audio"
              ? "添加本地音频 · 最大 10 MiB"
              : `添加图片 · ${moment ? "最多九张" : "一张"}`}
          <input
            aria-label={
              value.type === "audio" ? "上传手机音频" : "上传手机图片"
            }
            disabled={uploading}
            type="file"
            multiple={moment}
            accept={
              value.type === "audio"
                ? "audio/*"
                : "image/png,image/jpeg,image/webp,image/gif"
            }
            onChange={async (e) => {
              const files = [...(e.target.files || [])];
              e.target.value = "";
              if (files.length + value.assets.length > (moment ? 9 : 1)) {
                error("素材数量超出限制，请先移除已有素材");
                return;
              }
              setUploading(true);
              try {
                const ids = [];
                for (const file of files)
                  ids.push(await saveAsset(storyId, file));
                onChange({
                  ...latest.current,
                  assets: [...latest.current.assets, ...ids],
                });
              } catch (e) {
                error(String(e instanceof Error ? e.message : e));
              } finally {
                setUploading(false);
              }
            }}
          />
        </label>
      )}
      {!!assets.length && (
        <div className="phone-attachments">
          {assets.map(
            (a, i) =>
              a && (
                <div key={a.id}>
                  {a.mime.startsWith("image/") ? (
                    <img src={a.data} alt={a.name} />
                  ) : (
                    <audio src={a.data} controls />
                  )}
                  <button
                    type="button"
                    onClick={() =>
                      onChange({
                        ...value,
                        assets: value.assets.filter((_, j) => i !== j),
                      })
                    }
                  >
                    移除 {a.name}
                  </button>
                </div>
              ),
          )}
        </div>
      )}
      {value.type === "transfer" && (
        <label>
          金额
          <input
            aria-label="剧情转账金额"
            value={value.amount}
            onChange={(e) => onChange({ ...value, amount: e.target.value })}
          />
        </label>
      )}
      {["audio", "call"].includes(value.type) && (
        <label>
          时长
          <input
            value={value.duration}
            placeholder="例如 00:23"
            onChange={(e) => onChange({ ...value, duration: e.target.value })}
          />
        </label>
      )}
      {value.type === "call" && (
        <label>
          通话状态
          <select
            value={value.callState}
            onChange={(e) =>
              onChange({
                ...value,
                callState: e.target.value as PhoneBody["callState"],
              })
            }
          >
            <option value="completed">已结束</option>
            <option value="missed">未接来电</option>
            <option value="declined">已拒绝</option>
          </select>
        </label>
      )}
    </div>
  );
}
export default function PhonePanel({ story }: { story: Story }) {
  const preferences=useLiveQuery(()=>db.preferences.get("preferences"),[]);
  const space = useLiveQuery(
    () => db.phoneSpaces.where("storyId").equals(story.id).first(),
    [story.id],
  );
  const conversations =
    useLiveQuery(
      () => db.phoneConversations.where("storyId").equals(story.id).toArray(),
      [story.id],
    ) || [];
  const records =
    useLiveQuery(
      () => db.phoneRecords.where("storyId").equals(story.id).sortBy("seq"),
      [story.id],
    ) || [];
  const assets =
    useLiveQuery(
      () => db.phoneAssets.where("storyId").equals(story.id).toArray(),
      [story.id],
    ) || [];
  const runs =
    useLiveQuery(
      () => db.phoneRuns.where("storyId").equals(story.id).sortBy("created"),
      [story.id],
    ) || [];
  const [owner, setOwner] = useState(story.player || story.roles[0]?.id || ""),
    [tab, setTab] = useState("messages"),
    [cid, setCid] = useState("");
  const [compose, setCompose] = useState(false),
    [immersive, setImmersive] = useState(false),
    [body, setBody] = useState(emptyBody()),
    [time, setTime] = useState(phoneTime());
  const [writer, setWriter] = useState(owner),
    [speakers, setSpeakers] = useState<string[]>([]),
    [situation, setSituation] = useState("");
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [group, setGroup] = useState(false),
    [groupId, setGroupId] = useState(""),
    [groupName, setGroupName] = useState(""),
    [members, setMembers] = useState<string[]>([owner]),
    [groupAvatar, setGroupAvatar] = useState("");
  const [editing, setEditing] = useState<PhoneRecord>(),
    [editBody, setEditBody] = useState(emptyBody()),
    [editTime, setEditTime] = useState(""),
    [versions, setVersions] = useState<PhoneRecord>();
  const [moment, setMoment] = useState(false),
    [momentBody, setMomentBody] = useState(emptyBody()),
    [momentOwner, setMomentOwner] = useState(owner),
    [visibility, setVisibility] = useState("all"),
    [audience, setAudience] = useState<string[]>([]);
  const [comment, setComment] = useState<PhoneRecord>(),
    [replyTo, setReplyTo] = useState(""),
    [commentText, setCommentText] = useState("");
  const [exporting, setExporting] = useState(false),
    [from, setFrom] = useState(1),
    [to, setTo] = useState(0),
    [showDeleted, setShowDeleted] = useState(false),
    [previewImage, setPreviewImage] = useState<string>();
  const bottom = useRef<HTMLDivElement>(null);
  const [runLimit, setRunLimit] = useState(10);
  const scrollLatest = () => {
    const transcript = bottom.current?.parentElement;
    if (transcript) transcript.scrollTop = transcript.scrollHeight;
  };
  const restored = useRef(false);
  const sending = useRef(false);
  const d = deviceFor(space, owner),
    c = conversations.find((c) => c.id === cid);
  const current = records.filter(
    (r) =>
      r.kind === "message" &&
      r.conversationId === cid &&
      r.audience.includes(owner) &&
      (showDeleted || !r.deleted),
  );
  const moments = records.filter(
    (r) =>
      r.kind === "moment" &&
      r.audience.includes(owner) &&
      (showDeleted || !r.deleted),
  );
  const activeRun = runs.some((r) => r.status === "running");
  const name = (id: string) =>
    d.notes[id] || story.roles.find((r) => r.id === id)?.name || "未知角色";
  const title = (id: string) => {
    const chat = conversations.find((c) => c.id === id);
    return chat?.kind === "group"
      ? chat.title || "群聊"
      : name(chat?.members.find((x) => x !== owner) || "");
  };
  const perform = async (fn: () => Promise<unknown>) => {
    setError("");
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    void ensurePhone(story.id).catch((e) => setError(String(e)));
  }, [story.id]);
  useEffect(() => {
    if (space && !restored.current) {
      restored.current = true;
      setOwner(space.ownerId);
    }
  }, [space?.id]);
  useEffect(() => {
    setWriter(owner);
    setMomentOwner(owner);
    setCid("");
  }, [owner]);
  useEffect(() => {
    const dev = deviceFor(space, owner),
      draft = dev.composerDrafts?.[cid];
    setBody(draft?.body || { ...emptyBody(), text: dev.drafts[cid] || "" });
    setTime(draft?.time || phoneTime());
    setSituation(draft?.situation || "");
    setSpeakers(c?.members.filter((x) => compose || x !== owner) || []);
    setShowDeleted(false);
  }, [cid, owner, compose, c?.members.join()]);
  useEffect(() => {
    scrollLatest();
  }, [current.length, tab, cid, owner]);
  useEffect(() => {
    if (cid && space)
      void updateDevice(story.id, owner, (value) => ({
        ...value,
        read: {
          ...value.read,
          [cid]:
            records
              .filter((r) => r.conversationId === cid && canSee(r, owner))
              .at(-1)?.seq || 0,
        },
      }));
  }, [cid, owner, records.length]);
  const assetUrl = (id: string) => assets.find((a) => a.id === id)?.data;
  const avatar = (id: string) => story.roles.find((r) => r.id === id)?.avatar;
  const portrait = (id: string) =>
    avatar(id) ? (
      <img className="phone-avatar" src={avatar(id)} alt="" />
    ) : (
      <span className="phone-avatar">{name(id).slice(0, 1)}</span>
    );
  const skinStyle = {
    "--phone-size": `${d.skin.fontSize}px`,
    "--phone-mine-ink": phoneBubbleInk(d.skin.mine, d.skin.theme === "dark"),
    "--phone-theirs-ink": phoneBubbleInk(
      d.skin.theirs,
      d.skin.theme === "dark",
    ),
    ...(d.skin.mine ? { "--phone-mine": d.skin.mine } : {}),
    ...(d.skin.theirs ? { "--phone-theirs": d.skin.theirs } : {}),
    ...(d.skin.wallpaper && assetUrl(d.skin.wallpaper)
      ? { "--phone-wallpaper": `url("${assetUrl(d.skin.wallpaper)}")` }
      : {}),
  } as CSSProperties;
  const switchOwner = (id: string) => {
    setOwner(id);
    if (space) void db.phoneSpaces.update(space.id, { ownerId: id });
  };
  const openConversation = (id: string) => {
    setCid(id);
    setTab("messages");
  };
  const start = (mode: "participate" | "compose") =>
    perform(() =>
      startPhoneRun({
        storyId: story.id,
        ownerId: owner,
        conversationId: cid,
        speakers,
        mode,
        input: situation,
        time,
      }),
    );
  const saveDraft = async (
    next: PhoneBody,
    nextTime = time,
    nextSituation = situation,
  ) => {
    await updateDevice(story.id, owner, (dev) => ({
      ...dev,
      drafts: { ...dev.drafts, [cid]: next.text },
      composerDrafts: {
        ...dev.composerDrafts,
        [cid]: { body: next, time: nextTime, situation: nextSituation },
      },
    }));
  };
  const changeBody = (next: PhoneBody) => {
    setBody(next);
    void saveDraft(next).catch((e) => setError("输入暂未保存：" + String(e)));
  };
  const sendMessage = async () => {
    if (sending.current) return;
    sending.current = true;
    await perform(async () => {
      // Message and cleared draft commit together, so a quota error preserves the editor.
      await db.transaction("rw", db.tables, async () => {
        await addRecord(story.id, {
          speakerId: compose ? writer : owner,
          conversationId: cid,
          body,
          time,
          pending: !compose,
        });
        await saveDraft(emptyBody());
      });
      setBody(emptyBody());
    });
    sending.current = false;
  };
  const openEdit = (r: PhoneRecord) => {
    setEditing(r);
    setEditBody(structuredClone(r.body));
    setEditTime(r.time);
  };
  const card = (r: PhoneRecord) => (
    <>
      {r.legacyDraft && (
        <details>
          <summary>旧版未采用草稿 · 不参与参考</summary>
          <p>{r.legacyDraft.error}</p>
          <pre>{r.legacyDraft.raw}</pre>
        </details>
      )}
      {r.body.quoteId && (
        <blockquote>
          {records.find((q) => q.id === r.body.quoteId && canSee(q, owner))
            ?.body.text || "引用内容已不可见"}
        </blockquote>
      )}
      {r.retracted ? (
        <span className="phone-muted">撤回了一条消息</span>
      ) : (
        <>
          {r.body.assets.map((id) => {
            const a = assets.find((a) => a.id === id);
            return (
              a &&
              (a.mime.startsWith("audio/") ? (
                <audio key={id} controls src={a.data} aria-label="播放语音" />
              ) : (
                <button
                  className="phone-image-open"
                  key={id}
                  aria-label="查看完整图片"
                  onClick={() => setPreviewImage(a.data)}
                >
                  <img
                    onLoad={scrollLatest}
                    className="phone-media"
                    src={a.data}
                    alt={r.body.text || a.name}
                  />
                </button>
              ))
            );
          })}
          {r.body.type === "transfer" && (
            <strong className="phone-transfer">
              ¥ {r.body.amount || "—"}
              <small>剧情转账</small>
            </strong>
          )}
          {r.body.type === "call" && (
            <strong>
              ☎{" "}
              {r.body.callState === "missed"
                ? "未接来电"
                : r.body.callState === "declined"
                  ? "已拒绝"
                  : "通话已结束"}{" "}
              {r.body.duration}
            </strong>
          )}
          {r.body.type === "audio" && <small>语音文字 {r.body.duration}</small>}
          {["image", "sticker"].includes(r.body.type) &&
            !r.body.assets.length && <small>图片描述</small>}
          <p>{r.body.text}</p>
          <PhoneImageStatus record={r} readOnly={immersive} />
        </>
      )}
    </>
  );
  const controls = (r: PhoneRecord) =>
    !immersive && (
      <div className="phone-record-actions">
        {r.kind === "message" && !r.deleted && (
          <button onClick={() => changeBody({ ...body, quoteId: r.id })}>
            引用
          </button>
        )}
        {(compose || r.speakerId === owner) && (
          <>
            {r.legacyDraft && (
              <button
                onClick={() =>
                  void perform(() =>
                    editRecord(r.id, { legacyDraft: undefined }, r.versionId),
                  )
                }
              >
                采用这条草稿
              </button>
            )}
            <button onClick={() => openEdit(r)}>编辑</button>
            <button
              onClick={() =>
                void perform(() =>
                  editRecord(r.id, { retracted: !r.retracted }, r.versionId),
                )
              }
            >
              {r.retracted ? "取消撤回" : "撤回"}
            </button>
            <button
              onClick={() =>
                void perform(() =>
                  editRecord(r.id, { deleted: !r.deleted }, r.versionId),
                )
              }
            >
              {r.deleted ? "恢复" : "删除"}
            </button>
          </>
        )}
        <button onClick={() => setVersions(r)}>版本</button>
      </div>
    );
  const relevantRuns = runs
    .filter((r) => r.audience.includes(owner))
    .filter((r) =>
      tab === "moments" ? !r.conversationId : r.conversationId === cid,
    )
    .slice(-runLimit);
  return (
    <section
      className={`phone-panel phone-theme-${d.skin.theme} ${immersive ? "phone-immersive" : ""}`}
      style={skinStyle}
      aria-label="角色手机"
    >
      <header className="phone-top">
        <div>
          <strong>角色手机</strong>
          <small>独立手机作品 · 角色各有所知</small>
        </div>
        <label>
          机主
          <select
            aria-label="手机机主"
            value={owner}
            onChange={(e) => switchOwner(e.target.value)}
          >
            {story.roles.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
        </label>
        <button onClick={() => setImmersive(!immersive)}>
          {immersive ? "退出手机阅读" : "沉浸阅读"}
        </button>
      </header>
      {!immersive && (
        <div className="phone-mode">
          <button aria-pressed={!compose} onClick={() => setCompose(false)}>
            参与聊天
          </button>
          <button aria-pressed={compose} onClick={() => setCompose(true)}>
            翻看与编排
          </button>
          <span>内容保存在这本独立手机作品中</span>
        </div>
      )}
      <nav className="phone-tabs" aria-label="手机应用">
        {[
          ["messages", "消息"],
          ["contacts", "联系人"],
          ["moments", "朋友圈"],
          ["settings", "手机设置"],
        ].map(([id, label]) => (
          <button
            key={id}
            className={tab === id ? "selected" : ""}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
      </nav>
      {error && (
        <div className="phone-error" role="alert">
          {error}
          <button onClick={() => setError("")}>关闭</button>
        </div>
      )}
      {tab === "messages" && (
        <div className={`phone-messages ${cid ? "phone-has-chat" : ""}`}>
          <aside className="phone-conversations">
            <div className="phone-list-heading">
              <strong>会话</strong>
              {!immersive && (
                <button
                  onClick={() => {
                    setGroup(true);
                    setGroupId("");
                    setGroupName("");
                    setMembers([owner]);
                    setGroupAvatar("");
                  }}
                >
                  新建群聊
                </button>
              )}
            </div>
            {conversations
              .filter(
                (chat) =>
                  chat.members.includes(owner) ||
                  records.some(
                    (r) =>
                      r.conversationId === chat.id &&
                      r.audience.includes(owner),
                  ),
              )
              .sort(
                (a, b) =>
                  Number(d.pinned.includes(b.id)) -
                    Number(d.pinned.includes(a.id)) || b.updated - a.updated,
              )
              .map((chat) => {
                const visible = records.filter(
                    (r) => r.conversationId === chat.id && canSee(r, owner),
                  ),
                  last = visible.at(-1),
                  unread = visible.filter(
                    (r) =>
                      r.speakerId !== owner && r.seq > (d.read[chat.id] || 0),
                  ).length;
                return (
                  <button
                    key={chat.id}
                    className={`phone-conversation ${cid === chat.id ? "selected" : ""}`}
                    onClick={() => openConversation(chat.id)}
                  >
                    {chat.kind === "group" ? (
                      chat.avatar && assetUrl(chat.avatar) ? (
                        <img
                          className="phone-avatar"
                          src={assetUrl(chat.avatar)}
                          alt=""
                        />
                      ) : (
                        <span className="phone-avatar">群</span>
                      )
                    ) : (
                      portrait(chat.members.find((x) => x !== owner) || owner)
                    )}
                    <span>
                      <strong>
                        {d.pinned.includes(chat.id) ? "⌃ " : ""}
                        {title(chat.id)}
                      </strong>
                      <small>{last ? recordText(last) : "还没有消息"}</small>
                    </span>
                    {unread > 0 && <b className="phone-unread">{unread}</b>}
                  </button>
                );
              })}
            {!conversations.length && (
              <p className="phone-empty">
                从联系人里选一个人，开始你们的故事。
              </p>
            )}
          </aside>
          <main className="phone-chat">
            {c ? (
              <>
                <header className="phone-chat-heading">
                  <button className="phone-back" onClick={() => setCid("")}>
                    ‹ 会话
                  </button>
                  <strong>{title(cid)}</strong>
                  {!immersive && (
                    <>
                      <button
                        onClick={() =>
                          void updateDevice(story.id, owner, (value) => ({
                            ...value,
                            pinned: value.pinned.includes(cid)
                              ? value.pinned.filter((x) => x !== cid)
                              : [...value.pinned, cid],
                          }))
                        }
                      >
                        {d.pinned.includes(cid) ? "取消置顶" : "置顶"}
                      </button>
                      {c.kind === "group" && (
                        <button
                          onClick={() => {
                            setGroupId(cid);
                            setGroupName(c.title);
                            setMembers(c.members);
                            setGroupAvatar(c.avatar);
                            setGroup(true);
                          }}
                        >
                          群设置
                        </button>
                      )}
                      <button
                        onClick={() => {
                          setTo(current.filter((r) => !r.deleted).length);
                          setFrom(1);
                          setExporting(true);
                        }}
                      >
                        导出长图
                      </button>
                    </>
                  )}
                </header>
                <div
                  className="phone-transcript"
                  role="log"
                  aria-label="手机聊天记录"
                >
                  {current.map((r, i) => (
                    <div key={r.id}>
                      {(i === 0 || current[i - 1].time !== r.time) && (
                        <time className="phone-time">
                          {r.time.replace("T", " ")}
                        </time>
                      )}
                      <article
                        className={`phone-message ${r.speakerId === owner ? "mine" : "theirs"} ${r.body.type === "system" ? "system" : ""} ${r.deleted ? "deleted" : ""}`}
                      >
                        {portrait(r.speakerId)}
                        <div className="phone-message-content">
                          <small>
                            {name(r.speakerId)}
                            {r.pending ? " · 待回复" : ""}
                            {r.deleted ? " · 已删除" : ""}
                          </small>
                          <div className="phone-bubble">{card(r)}</div>
                          {controls(r)}
                        </div>
                      </article>
                    </div>
                  ))}
                  {!current.length && (
                    <p className="phone-empty">从一句话开始。</p>
                  )}
                  <div ref={bottom} />
                </div>
                {!immersive && (
                  <div className="phone-composer">
                    {!c.members.includes(owner) ? (
                      <p>你已不在这个群里，可以翻看之前可见的记录。</p>
                    ) : (
                      <>
                        {compose && (
                          <label>
                            发言角色
                            <select
                              aria-label="编排发言角色"
                              value={writer}
                              onChange={(e) => setWriter(e.target.value)}
                            >
                              {c.members.map((id) => (
                                <option key={id} value={id}>
                                  {name(id)}
                                </option>
                              ))}
                            </select>
                          </label>
                        )}
                        {body.quoteId && (
                          <div className="phone-quote-note">
                            引用：
                            {
                              records.find((r) => r.id === body.quoteId)?.body
                                .text
                            }
                            <button
                              onClick={() =>
                                changeBody({ ...body, quoteId: "" })
                              }
                            >
                              取消引用
                            </button>
                          </div>
                        )}
                        <BodyEditor
                          storyId={story.id}
                          value={body}
                          error={setError}
                          onSend={() => void sendMessage()}
                          onChange={changeBody}
                        />
                        <div className="phone-send-row">
                          <label>
                            剧情时间
                            <input
                              aria-label="消息剧情时间"
                              type="datetime-local"
                              value={time}
                              onChange={(e) => {
                                setTime(e.target.value);
                                if (cid)
                                  void saveDraft(body, e.target.value).catch(
                                    (e) => setError(String(e)),
                                  );
                              }}
                            />
                          </label>
                          <button
                            className="phone-primary"
                            disabled={busy && !activeRun}
                            onClick={() => void sendMessage()}
                          >
                            发送消息
                          </button>
                        </div>
                        <details
                          className="phone-generation-options"
                          open={compose}
                        >
                          <summary>
                            {compose ? "AI 编排这一轮" : "选择回复角色与情境"}
                          </summary>
                          <textarea
                            aria-label="手机生成情境"
                            placeholder="例如：聊聊刚刚在书店发生的事，停在约好明天见面。"
                            value={situation}
                            onChange={(e) => {
                              setSituation(e.target.value);
                              void saveDraft(body, time, e.target.value).catch(
                                (e) => setError(String(e)),
                              );
                            }}
                          />
                          <div className="phone-checks">
                            {c.members
                              .filter((id) => compose || id !== owner)
                              .map((id) => (
                                <label key={id}>
                                  <input
                                    type="checkbox"
                                    checked={speakers.includes(id)}
                                    onChange={(e) =>
                                      setSpeakers(
                                        e.target.checked
                                          ? [...speakers, id]
                                          : speakers.filter((x) => x !== id),
                                      )
                                    }
                                  />
                                  {name(id)}
                                </label>
                              ))}
                          </div>
                          <small>按勾选顺序依次回复，每位角色一次请求。</small>
                        </details>
                        <button
                          className="phone-primary"
                          disabled={busy || activeRun || !speakers.length}
                          onClick={() =>
                            void start(compose ? "compose" : "participate")
                          }
                        >
                          {compose
                            ? "生成一轮对话"
                            : c.kind === "group"
                              ? "让选中角色回复"
                              : "让 TA 回复"}
                        </button>
                      </>
                    )}
                  </div>
                )}
              </>
            ) : (
              <div className="phone-empty">
                <span className="phone-empty-icon">☏</span>
                <h3>{name(owner)}的手机</h3>
                <p>选一段聊天，看看他们的日常。</p>
                <button onClick={() => setTab("contacts")}>打开联系人</button>
              </div>
            )}
          </main>
        </div>
      )}
      {tab === "contacts" && (
        <div className="phone-contacts">
          {story.roles
            .filter((r) => r.id !== owner)
            .map((r) => (
              <article key={r.id}>
                {portrait(r.id)}
                <div>
                  <strong>{r.name}</strong>
                  <label>
                    这部手机里的备注
                    <input
                      aria-label={`${r.name}的备注`}
                      value={d.notes[r.id] || ""}
                      placeholder={r.name}
                      onChange={(e) => {
                        const value = e.target.value;
                        void updateDevice(story.id, owner, (dev) => ({
                          ...dev,
                          notes: { ...dev.notes, [r.id]: value },
                        }));
                      }}
                    />
                  </label>
                </div>
                <button
                  onClick={() =>
                    void perform(async () =>
                      openConversation(
                        await conversation(story, [owner, r.id]),
                      ),
                    )
                  }
                >
                  发消息
                </button>
              </article>
            ))}
        </div>
      )}
      {tab === "moments" && (
        <div className="phone-moments">
          <header>
            <h3>{name(owner)}的朋友圈</h3>
            {!immersive && (
              <>
                <button
                  onClick={() => {
                    setMoment(true);
                    setMomentOwner(owner);
                    setMomentBody(emptyBody());
                  }}
                >
                  发布动态
                </button>
                <button
                  onClick={() => {
                    setFrom(1);
                    setTo(moments.length);
                    setExporting(true);
                  }}
                >
                  导出朋友圈
                </button>
              </>
            )}
          </header>
          {moments
            .slice()
            .reverse()
            .map((r) => (
              <article
                className={`phone-moment${r.deleted ? " deleted" : ""}`}
                key={r.id}
              >
                <header>
                  {portrait(r.speakerId)}
                  <strong>{name(r.speakerId)}</strong>
                  <time>{r.time.replace("T", " ")}</time>
                </header>
                <div className="phone-moment-body">{card(r)}</div>
                <small className="phone-muted">
                  {r.audience.length === 1
                    ? "仅自己可见"
                    : r.audience.length === story.roles.length
                      ? "全部角色可见"
                      : "指定角色可见"}
                </small>
                {controls(r)}
                {!immersive && (
                  <div className="phone-moment-actions">
                    <button
                      onClick={() =>
                        void perform(() => likeMoment(r.id, owner))
                      }
                    >
                      {r.likes.includes(owner) ? "♥ 已赞" : "♡ 点赞"}
                    </button>
                    <button
                      onClick={() => {
                        setComment(r);
                        setReplyTo("");
                        setCommentText("");
                        setSpeakers(r.audience.filter((id) => id !== owner));
                      }}
                    >
                      评论
                    </button>
                  </div>
                )}
                {!!r.likes.length && (
                  <div className="phone-likes">
                    ♥ {r.likes.map(name).join("、")}
                  </div>
                )}
                <div className="phone-comments">
                  {records
                    .filter(
                      (x) =>
                        x.parentId === r.id &&
                        x.audience.includes(owner) &&
                        (showDeleted || !x.deleted),
                    )
                    .map((x) => (
                      <div key={x.id}>
                        <button
                          onClick={() => {
                            if (!immersive) {
                              setComment(r);
                              setReplyTo(x.id);
                              setCommentText("");
                            }
                          }}
                        >
                          <strong>{name(x.speakerId)}</strong>
                          {x.replyTo &&
                            ` 回复 ${name(records.find((t) => t.id === x.replyTo)?.speakerId || "")}`}
                          ：{x.retracted ? "已撤回" : x.body.text}
                        </button>
                        {controls(x)}
                      </div>
                    ))}
                </div>
              </article>
            ))}
          {!moments.length && (
            <p className="phone-empty">这里还很安静。发一条动态，留住今天。</p>
          )}
        </div>
      )}
      {tab === "settings" && (
        <div className="phone-settings">
          <h3>装扮{name(owner)}的手机</h3>
          <label>
            主题
            <select
              aria-label="手机主题"
              value={d.skin.theme}
              onChange={(e) => {
                const theme = e.target.value as typeof d.skin.theme;
                void updateDevice(story.id, owner, (v) => ({
                  ...v,
                  skin: { ...v.skin, theme, mine: "", theirs: "" },
                }));
              }}
            >
              <option value="light">经典浅色</option>
              <option value="dark">深色</option>
              <option value="pink">柔粉</option>
              <option value="lake">湖绿</option>
            </select>
          </label>
          <div className="phone-skin-colors">
            {[
              ["mine", "自己的气泡"],
              ["theirs", "对方的气泡"],
            ].map(([key, label]) => (
              <label key={key}>
                {label}
                <input
                  aria-label={label}
                  type="color"
                  value={
                    d.skin[key as "mine" | "theirs"] ||
                    (key === "mine" ? "#95ec69" : "#ffffff")
                  }
                  onChange={(e) => {
                    const value = e.target.value;
                    void updateDevice(story.id, owner, (v) => ({
                      ...v,
                      skin: { ...v.skin, [key]: value },
                    }));
                  }}
                />
              </label>
            ))}
          </div>
          <label>
            字号 {d.skin.fontSize}px
            <input
              aria-label="手机字号"
              type="range"
              min="12"
              max="24"
              value={d.skin.fontSize}
              onChange={(e) => {
                const value = Number(e.target.value);
                void updateDevice(story.id, owner, (v) => ({
                  ...v,
                  skin: { ...v.skin, fontSize: value },
                }));
              }}
            />
          </label>
          <label>
            聊天壁纸
            <input
              aria-label="上传手机壁纸"
              type="file"
              accept="image/*"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f)
                  void perform(async () => {
                    const id = await saveAsset(story.id, f);
                    await updateDevice(story.id, owner, (v) => ({
                      ...v,
                      skin: { ...v.skin, wallpaper: id },
                    }));
                  });
              }}
            />
          </label>
          <div className="phone-skin-preview">
            <span className="phone-bubble">今天过得怎么样？</span>
            <span className="phone-bubble mine">想和你说说今天的事。</span>
          </div>
          <button
            onClick={() =>
              void updateDevice(story.id, owner, (v) => ({
                ...v,
                skin: defaultSkin(),
              }))
            }
          >
            恢复默认皮肤
          </button>
          <p>
            这部手机的外观单独保存。生成只参考本作品中角色可知的背景与手机内容。
          </p>
        </div>
      )}
      {activeRun && (
        <div className="phone-running" role="status">
          对方正在输入…
          <button onClick={() => stopPhone(story.id)}>停止手机生成</button>
        </div>
      )}
      {!immersive && relevantRuns.length > 0 && (
        <details
          className="phone-runs"
          open={relevantRuns.some((r) => r.status !== "complete")}
        >
          <summary>生成记录与恢复</summary>
          {relevantRuns.length >= runLimit && (
            <button onClick={() => setRunLimit((n) => n + 20)}>
              查看更多生成记录
            </button>
          )}
          {relevantRuns.map((r) => (
            <div key={r.id}>
              <span>
                {r.steps.map((s) => name(s.speakerId)).join(" → ")} ·{" "}
                {r.status === "complete"
                  ? "已完成"
                  : r.status === "running"
                    ? "生成中"
                    : "待继续"}
              </span>
              {r.error && <p>{r.error}</p>}
              {r.status !== "running" && (
                <>
                  {r.draftOnly && r.staged?.["0"]?.[0] && <button onClick={()=>{setMomentOwner(r.steps[0].speakerId);setMomentBody(r.staged!["0"][0]);setAudience(r.audience);setVisibility("selected");setTime(r.time);setMoment(true);}}>载入动态草稿</button>}
                  <button
                    disabled={busy || activeRun}
                    onClick={() =>
                      void perform(() =>
                        continuePhoneRun(r.id, r.status === "complete"),
                      )
                    }
                  >
                    {r.status === "complete"
                      ? "重新生成本轮"
                      : "继续未完成角色"}
                  </button>
                  {r.status !== "complete" && (
                    <button
                      disabled={busy || activeRun}
                      onClick={() => void perform(() => dismissPhoneRun(r.id))}
                    >
                      结束本轮
                    </button>
                  )}
                  {preferences?.developer && <details><summary>查看本轮请求与参考</summary><pre>{JSON.stringify({profile:r.profile,steps:r.steps.map(s=>({speakerId:s.speakerId,request:s.request,context:s.context}))},null,2)}</pre></details>}
                  <details>
                    <summary>查看接收内容</summary>
                    <pre>
                      {r.steps.map((s) => s.raw).join("\n") || "还没有接收内容"}
                    </pre>
                  </details>
                </>
              )}
            </div>
          ))}
        </details>
      )}
      {compose && !immersive && ["messages", "moments"].includes(tab) && (
        <label className="phone-deleted-toggle">
          <input
            type="checkbox"
            checked={showDeleted}
            onChange={(e) => setShowDeleted(e.target.checked)}
          />
          显示已删除内容并恢复
        </label>
      )}
      {group && (
        <Modal
          title={groupId ? "群设置" : "新建群聊"}
          onClose={() => setGroup(false)}
        >
          <label>
            群名
            <input
              aria-label="群名"
              value={groupName}
              onChange={(e) => setGroupName(e.target.value)}
            />
          </label>
          <label>
            群头像
            <input
              type="file"
              accept="image/*"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f)
                  void perform(async () =>
                    setGroupAvatar(await saveAsset(story.id, f)),
                  );
              }}
            />
          </label>
          <div className="phone-checks">
            {story.roles.map((r) => (
              <label key={r.id}>
                <input
                  type="checkbox"
                  checked={members.includes(r.id)}
                  onChange={(e) =>
                    setMembers(
                      e.target.checked
                        ? [...members, r.id]
                        : members.filter((x) => x !== r.id),
                    )
                  }
                />
                {r.name}
              </label>
            ))}
          </div>
          <button
            disabled={busy || members.length < 2 || !members.includes(owner)}
            onClick={() =>
              void perform(async () => {
                const id =
                  groupId ||
                  (await conversation(
                    story,
                    members,
                    groupName,
                    true,
                    groupAvatar,
                  ));
                if (groupId)
                  await changeGroup(id, groupName, members, owner, groupAvatar);
                openConversation(id);
                setGroup(false);
              })
            }
          >
            保存群聊
          </button>
        </Modal>
      )}
      {editing && (
        <Modal title="编辑手机内容" onClose={() => setEditing(undefined)}>
          <BodyEditor
            storyId={story.id}
            value={editBody}
            onChange={setEditBody}
            error={setError}
            moment={editing.kind === "moment"}
          />
          <label>
            剧情时间
            <input
              type="datetime-local"
              value={editTime}
              onChange={(e) => setEditTime(e.target.value)}
            />
          </label>
          <button
            disabled={busy}
            onClick={() =>
              void perform(async () => {
                await editRecord(
                  editing.id,
                  { body: editBody, time: editTime },
                  editing.versionId,
                );
                setEditing(undefined);
              })
            }
          >
            保存修改
          </button>
        </Modal>
      )}
      {versions && (
        <Modal title="手机内容版本" onClose={() => setVersions(undefined)}>
          {versions.versions.map((v) => (
            <article className="phone-version" key={v.id}>
              <small>{new Date(v.created).toLocaleString()}</small>
              <p>{v.body.text || `[${v.body.type}]`}</p>
              <button
                onClick={() =>
                  void perform(async () => {
                    await editRecord(
                      versions.id,
                      {
                        body: v.body,
                        time: v.time,
                        retracted: v.retracted,
                        deleted: v.deleted,
                      },
                      versions.versionId,
                    );
                    setVersions(undefined);
                  })
                }
              >
                恢复这个版本
              </button>
            </article>
          ))}
        </Modal>
      )}
      {moment && (
        <Modal title="发布朋友圈" onClose={() => setMoment(false)}>
          {error && <p role="alert">{error}</p>}
          {activeRun && (
            <button onClick={() => stopPhone(story.id)}>停止手机生成</button>
          )}
          <label>
            发布角色
            <select
              aria-label="动态发布角色"
              value={momentOwner}
              onChange={(e) => setMomentOwner(e.target.value)}
            >
              {story.roles
                .filter((r) => compose || r.id === owner)
                .map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
            </select>
          </label>
          <BodyEditor
            storyId={story.id}
            value={momentBody}
            onChange={setMomentBody}
            error={setError}
            moment
          />
          <label>
            可见范围
            <select
              aria-label="动态可见范围"
              value={visibility}
              onChange={(e) => setVisibility(e.target.value)}
            >
              <option value="all">全部角色</option>
              <option value="selected">指定角色</option>
              <option value="self">仅自己</option>
            </select>
          </label>
          {visibility === "selected" && (
            <div className="phone-checks">
              {story.roles
                .filter((r) => r.id !== momentOwner)
                .map((r) => (
                  <label key={r.id}>
                    <input
                      type="checkbox"
                      checked={audience.includes(r.id)}
                      onChange={(e) =>
                        setAudience(
                          e.target.checked
                            ? [...audience, r.id]
                            : audience.filter((id) => id !== r.id),
                        )
                      }
                    />
                    {r.name}
                  </label>
                ))}
            </div>
          )}
          <label>
            剧情时间
            <input
              type="datetime-local"
              value={time}
              onChange={(e) => {
                setTime(e.target.value);
                if (cid)
                  void saveDraft(body, e.target.value).catch((e) =>
                    setError(String(e)),
                  );
              }}
            />
          </label>
          <button
            disabled={busy}
            onClick={() =>
              void perform(async () => {
                await addRecord(story.id, {
                  speakerId: momentOwner,
                  kind: "moment",
                  body: momentBody,
                  audience:
                    visibility === "all"
                      ? story.roles.map((r) => r.id)
                      : visibility === "self"
                        ? [momentOwner]
                        : [...new Set([momentOwner, ...audience])],
                  time,
                });
                setMoment(false);
              })
            }
          >
            发布这条动态
          </button>
          <button disabled={busy || activeRun} onClick={()=>void perform(async()=>{
            const id=await startPhoneRun({storyId:story.id,ownerId:owner,speakers:[momentOwner],mode:"moment",input:momentBody.text,
              audience:visibility==="all"?story.roles.map(r=>r.id):visibility==="self"?[momentOwner]:[...new Set([momentOwner,...audience])],time,draftOnly:true});
            const run=await db.phoneRuns.get(id);
            const generated=run?.staged?.["0"]?.[0];
            if(!generated)throw Error(run?.error || "动态尚未生成完成，可在生成记录中恢复");
            const selectedAssets = momentBody.assets.length ? momentBody.assets : generated.assets;
            setMomentBody({...generated,assets:selectedAssets,type:selectedAssets.length?"image":generated.type});
          })}>AI 生成到编辑器</button>
          <button
            disabled={busy || activeRun}
            onClick={() =>
              void perform(async () => {
                const task = {
                  storyId: story.id,
                  ownerId: owner,
                  speakers: [momentOwner],
                  mode: "moment" as const,
                  input: momentBody.text,
                  audience:
                    visibility === "all"
                      ? story.roles.map((r) => r.id)
                      : visibility === "self"
                        ? [momentOwner]
                        : [...new Set([momentOwner, ...audience])],
                  time,
                };
                await startPhoneRun(task);
                setMoment(false);
              })
            }
          >
            让角色直接发布
          </button>
        </Modal>
      )}
      {comment && (
        <Modal
          title={replyTo ? "回复评论" : "评论动态"}
          onClose={() => setComment(undefined)}
        >
          {error && <p role="alert">{error}</p>}
          {activeRun && (
            <button onClick={() => stopPhone(story.id)}>停止手机生成</button>
          )}
          <p>{comment.body.text}</p>
          <textarea
            aria-label="朋友圈评论内容"
            value={commentText}
            onChange={(e) => setCommentText(e.target.value)}
          />
          <button
            disabled={busy}
            onClick={() =>
              void perform(async () => {
                await addRecord(story.id, {
                  speakerId: owner,
                  kind: "comment",
                  parentId: comment.id,
                  replyTo,
                  body: { ...emptyBody(), text: commentText },
                });
                setComment(undefined);
              })
            }
          >
            发送评论
          </button>
          <div className="phone-checks">
            {comment.audience
              .filter((id) => id !== owner)
              .map((id) => (
                <label key={id}>
                  <input
                    type="checkbox"
                    checked={speakers.includes(id)}
                    onChange={(e) =>
                      setSpeakers(
                        e.target.checked
                          ? [...speakers, id]
                          : speakers.filter((x) => x !== id),
                      )
                    }
                  />
                  {name(id)}
                </label>
              ))}
          </div>
          <button
            disabled={busy || activeRun || !speakers.length}
            onClick={() =>
              void perform(async () => {
                const parent = comment;
                await startPhoneRun({
                  storyId: story.id,
                  ownerId: owner,
                  speakers: speakers.filter((id) =>
                    parent.audience.includes(id),
                  ),
                  mode: "comment",
                  parentId: parent.id,
                  input: commentText,
                });
                setComment(undefined);
              })
            }
          >
            让选中角色评论
          </button>
        </Modal>
      )}
      {previewImage && (
        <Modal title="查看图片" onClose={() => setPreviewImage(undefined)}>
          <img
            src={previewImage}
            alt="完整图片"
            style={{ maxWidth: "100%", height: "auto" }}
          />
        </Modal>
      )}
      {exporting && (
        <Modal title="导出手机长图" onClose={() => setExporting(false)}>
          <p>按当前机主的可见内容与皮肤导出。长内容自动分图打包。</p>
          <label>
            起始条目
            <input
              aria-label="长图起始条目"
              type="number"
              min="1"
              value={from}
              onChange={(e) => setFrom(Number(e.target.value))}
            />
          </label>
          <label>
            结束条目
            <input
              aria-label="长图结束条目"
              type="number"
              min="1"
              value={to}
              onChange={(e) => setTo(Number(e.target.value))}
            />
          </label>
          <button
            disabled={busy}
            onClick={() =>
              void perform(async () => {
                const source =
                  tab === "moments"
                    ? moments.slice().reverse()
                    : current.filter((r) => !r.deleted);
                if (
                  !Number.isInteger(from) ||
                  !Number.isInteger(to) ||
                  from < 1 ||
                  to < from ||
                  to > source.length
                )
                  throw Error("请选择有效的起止范围");
                await exportPhoneImages({
                  title:
                    tab === "moments" ? `${name(owner)}的朋友圈` : title(cid),
                  owner,
                  records: source.slice(from - 1, to),
                  allRecords: records,
                  story,
                  assets,
                  skin: d.skin,
                  notes: d.notes,
                });
                setExporting(false);
              })
            }
          >
            保存 PNG 长图
          </button>
        </Modal>
      )}
    </section>
  );
}
