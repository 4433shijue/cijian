import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Bookmark, Heart, MessageCircle, Plus, Square } from "lucide-react";
import { db } from "./db";
import type { SceneEvent, TheaterItem, TheaterRecord, TheaterSection } from "./types";
import { presetPresentationLabel } from "./theater-presets";
import {
  interactWithTheater, saveTheaterReplyDraft, stopTheaterInteraction, toggleTheaterReaction,
} from "./theater-interactions";
import { theaterReading } from "./theater-render";

const statusLabels: Record<TheaterItem["status"], string> = {
  "": "状态记录", unmentioned: "未提及", stable: "无明显变化", subtle: "轻微反应", clear: "明显反应", impact: "影响动作",
};
const certaintyLabels: Record<TheaterItem["certainty"], string> = {
  observed: "正文观察", inferred: "一种推测", unknown: "尚不能确定", fiction: "番外演绎",
};

function QuoteEvidence({ quote, text }: { quote: string; text: string }) {
  if (!quote) return null;
  const index = text.indexOf(quote);
  return <details className="theater-evidence">
    <summary>{index >= 0 ? "查看正文依据" : "查看引用 · 尚未匹配原句"}</summary>
    {index >= 0 ? <blockquote aria-label="对应正文原句">
      {index > 60 && "…"}{text.slice(Math.max(0, index - 60), index)}
      <mark>{quote}</mark>{text.slice(index + quote.length, index + quote.length + 60)}
      {text.length > index + quote.length + 60 && "…"}
    </blockquote> : <><blockquote>{quote}</blockquote><p className="theater-note">当前正文中没有找到这句完整原话，暂时作为待核对的引用。</p></>}
  </details>;
}

interface ItemProps {
  item: TheaterItem;
  section: TheaterSection;
  record: TheaterRecord;
  event: SceneEvent;
  canRequest: boolean;
  floor?: number;
  onReply?: (id: string) => void;
  onExpand: (itemId: string) => void;
  onError: (message: string) => void;
}

function TheaterEntry({ item, section, record, event, canRequest, floor, onReply, onExpand, onError }: ItemProps) {
  const reactionKey = section.id + "/" + item.id;
  const liked = record.likes?.includes(reactionKey) || false;
  const bookmarked = record.bookmarks?.includes(reactionKey) || false;
  const source = item.origin === "user" ? "你的留言" : item.certainty === "observed" && (!item.quote || !event.text.includes(item.quote)) ? "观察待核对" : certaintyLabels[item.certainty];
  const parent = section.items.find((candidate) => candidate.id === item.replyTo);
  async function react(kind: "likes" | "bookmarks") {
    try { await toggleTheaterReaction(record.id, section.id, item.id, kind); }
    catch (cause) { onError(cause instanceof Error ? cause.message : "没能保存这次操作，请再试一次。"); }
  }
  return <article className={"theater-entry" + (item.replyTo ? " is-reply" : "") + (item.origin === "user" ? " is-user" : "")}
    data-testid="theater-item" data-item-id={item.id} data-status={item.status || undefined}>
    <header className="theater-entry-meta">
      {item.author && <strong>{item.author}</strong>}
      {item.badge && <span className="theater-badge">{item.badge}</span>}
      <span className="theater-certainty">{source}</span>
      {floor !== undefined && <span className="theater-floor">{floor === 1 ? "楼主 · 1 楼" : `${floor} 楼`}</span>}
      {section.presentation === "body-status" && <span className="theater-status">{statusLabels[item.status]}</span>}
    </header>
    {item.replyTo && <p className="theater-reply-reference">回复 {parent?.author || "前面的发言"}{parent?.title ? ` · ${parent.title}` : ""}</p>}
    {item.title && <h4>{item.title}</h4>}
    <p className="theater-entry-text">{item.text || (item.status === "unmentioned" ? "本回合正文没有提到这一部位。" : "")}</p>
    {!!item.fields.length && <details className="theater-entry-details" open={section.presentation === "body-status"}>
      <summary>{section.presentation === "subtext-card" ? "翻开内心与另一种理解" : "展开细节"}</summary>
      <dl>{item.fields.map((field, index) => <div key={index}><dt>{field.label}</dt><dd>{field.value}</dd></div>)}</dl>
    </details>}
    <QuoteEvidence quote={item.quote} text={event.text} />
    <footer className="theater-entry-actions">
      <button type="button" aria-pressed={liked} onClick={() => void react("likes")}><Heart size={14} fill={liked ? "currentColor" : "none"} />{liked ? "已赞" : "赞"}</button>
      <button type="button" aria-pressed={bookmarked} onClick={() => void react("bookmarks")}><Bookmark size={14} fill={bookmarked ? "currentColor" : "none"} />{bookmarked ? "已收藏" : "收藏"}</button>
      {onReply && <button type="button" onClick={() => onReply(item.id)} disabled={!canRequest}><MessageCircle size={14} />回复此楼</button>}
      {item.origin !== "user" && item.status !== "unmentioned" && <button type="button" onClick={() => onExpand(item.id)} disabled={!canRequest}><Plus size={14} />细写此项 · AI</button>}
    </footer>
  </article>;
}

function TheaterSectionView({ section, record, event, disabled, onBusyChange, renderHtml }: {
  section: TheaterSection; record: TheaterRecord; event: SceneEvent; disabled: boolean; onBusyChange: (busy: boolean) => void;
  renderHtml: (html: string, section: TheaterSection) => ReactNode;
}) {
  const [onlyOp, setOnlyOp] = useState(false);
  const [author, setAuthor] = useState("");
  const [hideGuesses, setHideGuesses] = useState(false);
  const [onlySaved, setOnlySaved] = useState(false);
  const [expandedReplies, setExpandedReplies] = useState<string[]>([]);
  const [role, setRole] = useState(section.items[0]?.author || "");
  const [group, setGroup] = useState("");
  const [part, setPart] = useState("");
  const [onlyChanged, setOnlyChanged] = useState(false);
  const [replyTo, setReplyTo] = useState("");
  const [draft, setDraft] = useState(record.replyDrafts?.[section.id] || "");
  const [direction, setDirection] = useState("");
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState("");
  const replyInput = useRef<HTMLTextAreaElement>(null);
  const interaction = record.interaction?.sectionId === section.id ? record.interaction : undefined;
  const pending = asking || record.interaction?.status === "running";
  const canRequest = !disabled && !pending && section.presentation !== "custom";
  const isForum = section.presentation === "forum";
  const isBody = section.presentation === "body-status";
  const authors = [...new Set(section.items.map((item) => item.author).filter(Boolean))];
  const selectedRole = authors.includes(role) ? role : authors[0] || "";
  const groups = [...new Set(section.items.filter((item) => item.author === selectedRole).map((item) => item.group).filter(Boolean))];
  const selectedGroup = group && groups.includes(group) ? group : "";
  const op = section.items.find((item) => !item.replyTo)?.author;
  const filtered = section.items.filter((item) => {
    if (onlySaved && !record.bookmarks?.includes(section.id + "/" + item.id)) return false;
    if (isForum && ((onlyOp && item.author !== op) || (author && item.author !== author) ||
      (hideGuesses && (item.certainty === "inferred" || item.certainty === "unknown")))) return false;
    if (isBody && ((item.author !== selectedRole) || (selectedGroup && item.group !== selectedGroup) ||
      (onlyChanged && !["subtle", "clear", "impact"].includes(item.status)))) return false;
    return true;
  });
  const mentioned = filtered.filter((item) => item.status !== "unmentioned");
  const unmentioned = filtered.filter((item) => item.status === "unmentioned");
  const selectedPart = filtered.find((item) => item.id === part) || mentioned[0];
  const replyTarget = section.items.find((item) => item.id === replyTo);
  const forceReplies = onlyOp || !!author || hideGuesses || onlySaved;

  useEffect(() => {
    if (interaction?.status === "complete" && interaction.kind === "reply")
      setDraft((value) => value === interaction.input ? "" : value);
  }, [interaction?.id, interaction?.status]);

  useEffect(() => {
    if (!interaction?.userItemId) return;
    const path: string[] = [interaction.userItemId];
    let ancestor = section.items.find((item) => item.id === interaction.userItemId)?.replyTo;
    while (ancestor && !path.includes(ancestor)) {
      path.push(ancestor);
      ancestor = section.items.find((item) => item.id === ancestor)?.replyTo;
    }
    setExpandedReplies((value) => [...new Set([...value, ...path])]);
  }, [interaction?.id, interaction?.status, section.items.length]);

  async function request(kind: "reply" | "expand", input: string, itemId?: string) {
    if (!canRequest || !input.trim()) return;
    setAsking(true);
    onBusyChange(true);
    setError("");
    try {
      if (kind === "reply") await saveTheaterReplyDraft(record.id, section.id, input);
      await interactWithTheater(record.id, section.id, kind, input, itemId);
      // The model can stop without throwing; preserve the draft until confirmed success.
      const result = await db.theaters.get(record.id);
      if (kind === "reply" && result?.interaction?.status === "complete") {
        setDraft((value) => value === input ? "" : value);
        setReplyTo("");
      }
    } catch (cause) { setError(cause instanceof Error ? cause.message : "这次补充没能完成，原有内容已保留。"); }
    finally { setAsking(false); onBusyChange(false); }
  }

  function expand(itemId?: string) {
    const item = section.items.find((candidate) => candidate.id === itemId);
    const input = direction.trim() || (item ? `围绕${item.title || item.author || "这一项"}再展开一层，补充不同的细节或回应，遵守当前正文依据。` :
      isForum ? "接着已有讨论追加几楼，让不同观众互相回应，抓住当前正文中的新细节。" : "为本栏追加一组不同的细节或人物回应，保持当前正文的范围。");
    void request("expand", input, itemId);
  }

  function chooseReply(itemId: string) {
    setReplyTo(itemId);
    replyInput.current?.scrollIntoView({ behavior: "smooth", block: "center" });
    replyInput.current?.focus({ preventScroll: true });
  }

  function entry(item: TheaterItem) {
    return <TheaterEntry key={item.id} item={item} section={section} record={record} event={event}
      canRequest={canRequest} floor={isForum ? section.items.findIndex((candidate) => candidate.id === item.id) + 1 : undefined}
      onReply={isForum ? chooseReply : undefined} onExpand={expand} onError={setError} />;
  }

  function forumThread(item: TheaterItem, ancestors = new Set<string>()) {
    const visited = new Set([...ancestors, item.id]);
    const replies = forceReplies ? [] : filtered.filter((candidate) => candidate.replyTo === item.id && !visited.has(candidate.id));
    return <div key={item.id}>{entry(item)}{!!replies.length && <div className={"theater-reply-group" + (ancestors.size >= 2 ? " is-flat" : "")}>
      <button type="button" className="theater-show-replies" aria-expanded={expandedReplies.includes(item.id)} onClick={() => setExpandedReplies((value) => value.includes(item.id) ? value.filter((id) => id !== item.id) : [...value, item.id])}>
        {expandedReplies.includes(item.id) ? "收起" : "展开"} {replies.length} 条楼中楼
      </button>
      {expandedReplies.includes(item.id) && replies.map((reply) => forumThread(reply, visited))}
    </div>}</div>;
  }

  return <section className="theater-structured-section" data-theme={section.theme} data-section-id={section.id} aria-label={section.title}>
    <header className="theater-section-heading">
      <span className="theater-section-kicker">{presetPresentationLabel(section.presentation)}<span aria-hidden="true"> / </span>{section.items.length} {isForum ? "则发言" : "则记录"}</span>
      <h3>{section.title}</h3>
      <p className="theater-note">{isForum ? "坐到观众席里，也可以留下一句自己的看法。" : isBody ? "沿着动作看这一刻，未写到的部位单独收好。" : "把这一刻再翻开一层。"}</p>
    </header>

    <div className="theater-local-tools" aria-label={`${section.title}本地筛选`}>
      {isForum && <>
        <label><input type="checkbox" checked={onlyOp} onChange={(change) => setOnlyOp(change.target.checked)} />只看楼主</label>
        <label className="theater-select-label">追踪观众<select aria-label="追踪观众" value={author} onChange={(change) => setAuthor(change.target.value)}><option value="">全部观众</option>{authors.map((name) => <option key={name}>{name}</option>)}</select></label>
        <label><input type="checkbox" checked={hideGuesses} onChange={(change) => setHideGuesses(change.target.checked)} />隐藏猜测</label>
      </>}
      {isBody && <label><input type="checkbox" checked={onlyChanged} onChange={(change) => setOnlyChanged(change.target.checked)} />只看有变化</label>}
      <label><input type="checkbox" checked={onlySaved} onChange={(change) => setOnlySaved(change.target.checked)} />只看收藏</label>
      <span className="theater-local-note">筛选不调用 AI</span>
    </div>

    {section.presentation === "custom" && section.html && renderHtml(section.html, section)}
    {isBody ? <>
      <div className="theater-choices theater-role-choices" aria-label="身体状态角色">
        {authors.map((name) => <button type="button" key={name} aria-pressed={selectedRole === name} onClick={() => { setRole(name); setGroup(""); setPart(""); }}>{name}</button>)}
      </div>
      {!!groups.length && <div className="theater-choices theater-group-choices" aria-label="身体部位分组">
        <button type="button" aria-pressed={!selectedGroup} onClick={() => { setGroup(""); setPart(""); }}>全部部位</button>
        {groups.map((name) => <button type="button" key={name} aria-pressed={selectedGroup === name} onClick={() => { setGroup(name); setPart(""); }}>{name}</button>)}
      </div>}
      <div className="theater-body-layout">
        <div className="theater-parts" aria-label={`${selectedRole || "角色"}的部位目录`}>
          {mentioned.map((item) => <button type="button" key={item.id} aria-pressed={selectedPart?.id === item.id} onClick={() => setPart(item.id)}>
            <span>{item.title || item.group || "身体状态"}</span><small>{statusLabels[item.status]}</small>
          </button>)}
          {!!unmentioned.length && <details className="theater-unmentioned"><summary>正文未提及 · {unmentioned.length} 项</summary>
            {unmentioned.map((item) => <button type="button" key={item.id} aria-pressed={selectedPart?.id === item.id} onClick={() => setPart(item.id)}>{item.title || item.group || "未提及部位"}</button>)}
          </details>}
        </div>
        <div className="theater-part-detail">{selectedPart ? entry(selectedPart) : <p className="theater-empty">{unmentioned.length ? "展开未提及的部位可查看记录。" : "当前筛选下没有部位记录。"}</p>}</div>
      </div>
    </> : isForum ? <div className="theater-forum-posts">
      {filtered.filter((item) => !item.replyTo || forceReplies || !filtered.some((candidate) => candidate.id === item.replyTo)).map((item) => forumThread(item))}
      {!filtered.length && <p className="theater-empty">当前筛选下没有发言，可以调整筛选继续看。</p>}
    </div> : <div className="theater-generic-items">{filtered.map(entry)}{!filtered.length && !section.html && <p className="theater-empty">当前筛选下没有记录。</p>}</div>}

    {error && <p className="theater-inline-error" role="alert">{error}</p>}
    {interaction && <div className="theater-interaction-state" aria-live="polite">
      {interaction.status === "running" ? <><span>正在{interaction.kind === "reply" ? "生成观众回复" : "补充这一栏"}，已有内容可以继续阅读。</span><button type="button" onClick={() => stopTheaterInteraction(record.id)}><Square size={13} />停止补充</button></> :
        interaction.status === "failed" || interaction.status === "interrupted" ? <><p>{interaction.error || "这次补充未完成，原内容和留言仍然保留。"}</p><button type="button" disabled={!canRequest} onClick={() => void request(interaction.kind, interaction.input, interaction.itemId)}>重试这次补充 · AI</button></> : <span>本次补充已保存。</span>}
      {!!interaction.raw && <details className="theater-interaction-raw"><summary>查看本次补充的模型原始输出</summary><pre>{interaction.raw}</pre></details>}
    </div>}

    {isForum && <form className="theater-reply-form" onSubmit={(submit) => { submit.preventDefault(); void request("reply", draft, replyTo || undefined); }}>
      <label htmlFor={`theater-reply-${record.id}-${section.id}`}>你也来回一句{replyTarget ? ` · 回复 ${replyTarget.author || "此楼"}` : ""}</label>
      {replyTarget && <button type="button" className="theater-cancel-target" onClick={() => setReplyTo("")}>改为回复主帖</button>}
      <textarea ref={replyInput} id={`theater-reply-${record.id}-${section.id}`} value={draft} maxLength={4000} rows={3}
        placeholder="刚才那句话，你是怎么想的？" onChange={(change) => {
          const input = change.target.value;
          setDraft(input);
          void saveTheaterReplyDraft(record.id, section.id, input).catch((cause) => setError(cause instanceof Error ? cause.message : "留言草稿暂时没能保存。"));
        }} />
      <div><span className="theater-note">留言和观众回复只留在小剧场里。</span><button type="submit" className="theater-primary" disabled={!canRequest || !draft.trim()}><MessageCircle size={15} />发送并生成回复</button></div>
    </form>}

    {section.presentation === "custom" ? <p className="theater-note">本栏保留自由排版。选择论坛或卡片展示样式后，可以继续追加互动。</p> : <div className="theater-expand-tools">
      <details><summary>指定补充方向</summary><label>想多看一点什么<textarea rows={2} maxLength={2000} value={direction} onChange={(change) => setDirection(change.target.value)} placeholder={isBody ? "例如，细写双手的动作和呼吸，别补出未写明的伤势。" : "例如，让两位观众就刚才的动作再讨论几句。"} /></label></details>
      <button type="button" onClick={() => expand()} disabled={!canRequest}><Plus size={15} />{isForum ? "追加讨论 · AI" : "追加本栏 · AI"}</button>
      <span className="theater-note">点击生成才调用 AI，追加失败也会保留原内容。</span>
    </div>}
  </section>;
}

export function TheaterStructured({ record, event, disabled, onBusyChange, renderHtml }: {
  record: TheaterRecord; event: SceneEvent; disabled: boolean; onBusyChange: (busy: boolean) => void;
  renderHtml: (html: string, section: TheaterSection) => ReactNode;
}) {
  const settings = theaterReading(record.reading);
  return <div className={"theater-structured" + (settings.clarity ? " is-clear" : "")}
    style={{ "--theater-font-size": `${settings.fontSize}px` } as CSSProperties}>
    {record.data?.sections.map((section) => <TheaterSectionView key={section.id} section={section} record={record} event={event} disabled={disabled} onBusyChange={onBusyChange} renderHtml={renderHtml} />)}
  </div>;
}
