import { useEffect, useMemo, useRef, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { ChevronDown, ChevronUp, Drama, RefreshCw, Square } from "lucide-react";
import { db } from "./db";
import type { SceneEvent, TheaterPresentation, TheaterRecord } from "./types";
import { generateTheater, pendingTheater, stopTheater } from "./theater";
import { stop } from "./generation-state";
import { theaterDocument, theaterReading } from "./theater-render";
import { presetPresentationLabel } from "./theater-presets";
import { saveTheaterReading } from "./theater-interactions";
import { TheaterStructured } from "./TheaterStructured";
import "./theater-interactive.css";

function TheaterFrame({ html, presentations = [], reading }: { html: string; presentations?: TheaterPresentation[]; reading?: TheaterRecord["reading"] }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const observer = useRef<ResizeObserver | undefined>(undefined);
  const [height, setHeight] = useState(120);
  const settings = theaterReading(reading);
  const document = useMemo(() => theaterDocument(html, presentations, settings), [html, presentations.join("|"), settings.clarity, settings.fontSize]);
  useEffect(() => () => observer.current?.disconnect(), []);
  function loaded() {
    observer.current?.disconnect();
    const doc = frame.current?.contentDocument;
    if (!doc?.body) return;
    const measure = () => {
      // Measure the body's contents, not documentElement's viewport-dependent height.
      const next = Math.ceil(Math.max(doc.body.scrollHeight, doc.body.getBoundingClientRect().height));
      setHeight((previous) => Math.abs(previous - next) > 1 ? Math.min(12000, Math.max(80, next)) : previous);
    };
    observer.current = new ResizeObserver(measure);
    observer.current.observe(doc.body);
    measure();
  }
  return <iframe ref={frame} className="theater-frame" title="小剧场内容"
    sandbox="allow-same-origin" referrerPolicy="no-referrer" srcDoc={document}
    style={{ height }} onLoad={loaded} />;
}

function TheaterContent({ event, disabled, onBusyChange }: { event: SceneEvent; disabled: boolean; onBusyChange: (busy: boolean) => void }) {
  const [readingError, setReadingError] = useState("");
  const record = useLiveQuery(async () => {
    if (!event.theater) return null;
    const current = await db.theaters.get(event.theater.id);
    if (!current) return null;
    const previous = current.previousId ? await db.theaters.get(current.previousId) : undefined;
    return { current, previous: previous?.status === "complete" && previous.eventId === event.id && previous.storyId === event.storyId ? previous : undefined };
  }, [event.theater?.id, event.theater?.status]);
  if (record === undefined) return <p className="hint" role="status">正在展开小剧场…</p>;
  if (!record) return <p className="hint">生成后，小剧场会留在这一段下面。</p>;
  const { current, previous } = record;
  const failed = current.status === "failed" || current.status === "interrupted";
  const shown = current.status !== "complete" && previous ? previous : current;
  const settings = theaterReading(shown.reading);
  async function read(patch: Partial<NonNullable<TheaterRecord["reading"]>>) {
    setReadingError("");
    try { await saveTheaterReading(shown.id, patch); }
    catch (cause) { setReadingError(cause instanceof Error ? cause.message : "没能保存阅读设置，请再试一次。"); }
  }
  function renderContent(value: TheaterRecord, canInteract: boolean) {
    return value.data?.sections.length ? <TheaterStructured key={value.id} record={value} event={event} disabled={!canInteract} onBusyChange={onBusyChange}
      renderHtml={(html, section) => <TheaterFrame html={html} presentations={[section.presentation]} reading={shown.reading} />} /> :
      value.html ? <TheaterFrame html={value.html} presentations={value.presets.map((preset) => preset.presentation).filter(Boolean) as TheaterPresentation[]} reading={shown.reading} /> : null;
  }
  return <>
    <p className="theater-presets-label">{shown.presets.map((preset) => `${preset.name} · ${presetPresentationLabel(preset.presentation)}`).join(" · ")}</p>
    {shown.sourceVersionId !== event.versionId && current.sourceVersionId === event.versionId &&
      <p className="review">上一次的小剧场对应修改前的正文，暂时保留供参考。</p>}
    {current.error && <p className="error" role="alert">{current.error}</p>}
    {failed && previous && <p className="hint">这次没能完成，先保留上一次的小剧场。</p>}
    {failed && !previous && shown.html && <p className="hint">这是已经收到的部分内容。</p>}
    <div className="theater-reading-tools" aria-label="小剧场阅读设置">
      <label><input type="checkbox" checked={settings.clarity} onChange={(change) => void read({ clarity: change.target.checked })} />清晰阅读</label>
      <label>字号<select aria-label="小剧场字号" value={settings.fontSize} onChange={(change) => void read({ fontSize: Number(change.target.value) })}>
        {Array.from({ length: 9 }, (_, index) => index + 16).map((size) => <option key={size} value={size}>{size}</option>)}
      </select></label>
      <span>{settings.clarity ? "纸色底与深色字，旧内容也适用。" : "展示原有视觉主题。"}</span>
    </div>
    {readingError && <p className="error" role="alert">{readingError}</p>}
    {shown.sourceVersionId !== event.versionId && shown.data && <p className="hint">旧版小剧场可以筛选和收藏，按当前正文重新生成后就能继续参与。</p>}
    {shown.data?.sections.length || shown.html ? renderContent(shown, !disabled && shown.id === current.id && shown.status === "complete" && shown.sourceVersionId === event.versionId) : <p className="hint" role="status">
      {current.status === "running" ? "小剧场正在布置，收到内容就会在这里显示。" : "还没有可显示的小剧场，可以重新生成。"}
    </p>}
    {current.status === "running" && previous && (current.html || current.data?.sections.length) && <>
      <p className="hint">这次的小剧场正在生成，完成后会替换上面的内容。</p>
      {renderContent(current, false)}
    </>}
  </>;
}

export function TheaterPanel({ event, blocked = false }: { event: SceneEvent; blocked?: boolean }) {
  const [open, setOpen] = useState(false);
  const [interactionPending, setInteractionPending] = useState(false);
  const displayedSource = useRef({ versionId: event.versionId, theaterId: event.theater?.id });
  const replacedWithNewProse = displayedSource.current.versionId !== event.versionId &&
    displayedSource.current.theaterId !== event.theater?.id;
  const expanded = open && !replacedWithNewProse;
  useEffect(() => {
    // Automatic rewrites retain the event id, but the new prose and its theater start folded.
    // Manual theater retries keep the prose version and therefore keep the current open state.
    if (replacedWithNewProse) setOpen(false);
    displayedSource.current = { versionId: event.versionId, theaterId: event.theater?.id };
  }, [event.versionId, event.theater?.id]);
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState("");
  const pending = asking || event.theater?.status === "running" || !!pendingTheater(event.id);
  const stale = !!event.theater && event.theater.sourceVersionId !== event.versionId;
  const canGenerate = event.status === "complete" && !blocked && !pending && !interactionPending;
  async function ask() {
    if (!canGenerate) return;
    setAsking(true);
    setError("");
    try { await generateTheater(event.id); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "这次小剧场没能生成，请再试一次。"); }
    finally { setAsking(false); }
  }
  function toggle() {
    setOpen(!expanded);
    if (!expanded && !event.theater && !error) void ask();
  }
  const label = interactionPending ? "正在补充" : pending ? "正在生成" : stale ? "原文已更新" :
    event.theater?.status === "failed" || event.theater?.status === "interrupted" ? "未完成" :
    event.theater ? "这一刻的幕间" : "点开生成";
  return <section className={"theater-panel" + (expanded ? " is-open" : "")} aria-label="本段小剧场">
    <button type="button" className="theater-toggle" onClick={toggle} aria-expanded={expanded}
      aria-controls={"theater-" + event.id} disabled={!event.theater && !expanded && !canGenerate}>
      <span className="theater-toggle-title"><Drama size={17} /><strong>小剧场</strong></span>
      <span className="theater-toggle-state">{label}{expanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}</span>
    </button>
    {expanded && <div id={"theater-" + event.id} className="theater-content">
      {stale && <p className="review">正文已经修改，下面的小剧场仍对应旧版本。可以按当前正文重新生成。</p>}
      {pending && <p className="hint" role="status">正在生成小剧场，收起后仍会继续。</p>}
      {error && <p className="error" role="alert">{error}</p>}
      <TheaterContent event={event} disabled={blocked || pending || event.status !== "complete"} onBusyChange={setInteractionPending} />
      <div className="theater-actions">
        {pending ? <button onClick={() => event.status === "draft" ? stop(event.storyId) : stopTheater(event.id)}><Square size={14} />{event.status === "draft" ? "停止本次生成" : "停止生成"}</button> :
          event.status === "complete" && <button onClick={() => void ask()} disabled={!canGenerate}><RefreshCw size={14} />{event.theater ? "重新生成小剧场" : "生成小剧场"}</button>}
        <button onClick={() => setOpen(false)}>收起小剧场</button>
      </div>
    </div>}
  </section>;
}

/** Full automatic response bodies live off the main timeline and are read only on demand. */
export function EventRawOutput({ event }: { event: SceneEvent }) {
  const [open, setOpen] = useState(false);
  const raw = useLiveQuery(async () => {
    if (!open) return undefined;
    return event.theater ? (await db.theaters.get(event.theater.id))?.raw || event.raw : event.raw;
  }, [open, event.id, event.raw, event.theater?.id]);
  return <details onToggle={(change) => setOpen(change.currentTarget.open)}>
    <summary>查看模型原始输出</summary>
    {open && <pre>{raw === undefined ? "正在读取…" : raw || "没有收到输出"}</pre>}
  </details>;
}
