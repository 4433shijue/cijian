import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { TheaterHtmlPage, TheaterRecord, TheaterState } from "./types";
import { freeTheaterDocument } from "./theater-sandbox";
import {
  generateHtmlPage,
  saveHtmlPageState,
  saveHtmlPageText,
  stopHtmlInteraction,
} from "./theater-html-interactions";

function FreeTheaterFrame({
  record,
  page,
  disabled,
  onError,
  onBusy,
}: {
  record: TheaterRecord;
  page: TheaterHtmlPage;
  disabled: boolean;
  onError: (error: string) => void;
  onBusy: (busy: boolean) => void;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const channel = useRef<MessagePort | undefined>(undefined);
  const state = useRef<TheaterState>(null);
  const callbacks = useRef({ disabled, onError, onBusy });
  state.current = record.htmlStates?.[page.id] ?? null;
  callbacks.current = { disabled, onError, onBusy };
  const [height, setHeight] = useState(180);
  const [reload, setReload] = useState(0);
  const token = useMemo(
    () => crypto.randomUUID(),
    [record.id, page.id, page.html, record.reading?.fontSize, reload],
  );
  const document = useMemo(
    () =>
      freeTheaterDocument(page.html, {
        token,
        state: state.current,
        enabled: !disabled,
        fontSize: record.reading?.fontSize,
      }),
    [token],
  );
  useEffect(() => {
    channel.current?.postMessage({ type: "configure", enabled: !disabled });
  }, [disabled]);
  useLayoutEffect(() => {
    let alive = true,
      connected = false,
      asking = false;
    let lastText = 0,
      textTimer: ReturnType<typeof setTimeout> | undefined;
    let pendingText = "";
    let stateTimer: ReturnType<typeof setTimeout> | undefined;
    let stateValue: unknown;
    let stateIds: number[] = [];
    const seen = new Set<number>();
    function connect(event: MessageEvent) {
      if (
        connected ||
        event.source !== frame.current?.contentWindow ||
        event.data?.type !== "cijian-html-port" ||
        event.data.token !== token ||
        event.ports.length !== 1
      )
        return;
      connected = true;
      const port = event.ports[0];
      channel.current = port;
      port.postMessage({
        type: "configure",
        enabled: !callbacks.current.disabled,
      });
      port.onmessage = async (message) => {
        if (!alive) return;
        const data = message.data;
        if (!data || typeof data !== "object") return;
        if (data.type === "height" && Number.isFinite(data.value)) {
          setHeight(Math.min(12000, Math.max(80, Math.ceil(data.value))));
          return;
        }
        if (data.type === "runtime-error") {
          callbacks.current.onError(
            "页面交互脚本遇到问题，可以重新载入页面或使用清晰阅读。",
          );
          return;
        }
        if (
          data.type === "text" &&
          typeof data.value === "string" &&
          data.value.length <= 200000
        ) {
          pendingText = data.value;
          if (!textTimer)
            textTimer = setTimeout(
              () => {
                textTimer = undefined;
                lastText = Date.now();
                if (alive)
                  void saveHtmlPageText(
                    record.id,
                    page.id,
                    page.html,
                    pendingText,
                  ).catch(() => {});
              },
              Math.max(250, 1000 - (Date.now() - lastText)),
            );
          return;
        }
        if (
          !["save", "generate"].includes(data.type) ||
          !Number.isSafeInteger(data.id) ||
          data.id <= 0 ||
          seen.has(data.id)
        )
          return;
        if (seen.size > 10000) return;
        seen.add(data.id);
        if (data.type === "save") {
          if (stateIds.length >= 128) {
            port.postMessage({
              id: data.id,
              ok: false,
              error: "状态更新过快，请稍后再试。",
            });
            return;
          }
          stateValue = data.value;
          stateIds.push(data.id);
          if (!stateTimer)
            stateTimer = setTimeout(async () => {
              stateTimer = undefined;
              const ids = stateIds;
              stateIds = [];
              try {
                await saveHtmlPageState(
                  record.id,
                  page.id,
                  page.html,
                  stateValue,
                );
                if (alive)
                  for (const id of ids) port.postMessage({ id, ok: true });
              } catch (error) {
                callbacks.current.onError(
                  error instanceof Error ? error.message : "状态未能保存。",
                );
                if (alive)
                  for (const id of ids)
                    port.postMessage({
                      id,
                      ok: false,
                      error: "状态未能保存，请查看外侧提示。",
                    });
              }
            }, 100);
          return;
        }
        try {
          {
            if (callbacks.current.disabled || asking)
              throw Error("请先等待当前生成完成，或按当前正文重新生成。");
            if (
              typeof data.value !== "string" ||
              !data.value.trim() ||
              data.value.length > 8000
            )
              throw Error("补充要求无效。");
            asking = true;
            callbacks.current.onBusy(true);
            try {
              await generateHtmlPage(record.id, page.id, data.value);
            } finally {
              asking = false;
              callbacks.current.onBusy(false);
            }
          }
          if (alive) port.postMessage({ id: data.id, ok: true });
        } catch (error) {
          callbacks.current.onError(
            error instanceof Error ? error.message : "小剧场操作没有完成。",
          );
          if (alive)
            port.postMessage({
              id: data.id,
              ok: false,
              error: "操作未完成，请查看小剧场外侧的提示。原内容仍保留。",
            });
        }
      };
    }
    window.addEventListener("message", connect);
    return () => {
      alive = false;
      clearTimeout(textTimer);
      clearTimeout(stateTimer);
      if (stateIds.length)
        void saveHtmlPageState(record.id, page.id, page.html, stateValue).catch(
          () => {},
        );
      window.removeEventListener("message", connect);
      channel.current?.close();
      channel.current = undefined;
    };
  }, [token]);
  return (
    <>
      <iframe
        ref={frame}
        className="theater-frame theater-html-frame"
        data-page-id={page.id}
        title={page.title}
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        allow="camera 'none'; microphone 'none'; geolocation 'none'"
        srcDoc={document}
        style={{ height }}
      />
      <button
        type="button"
        className="theater-reload"
        onClick={() => setReload((value) => value + 1)}
      >
        重新载入页面（不调用 AI）
      </button>
    </>
  );
}

export function FreeTheater({
  record,
  disabled,
  onBusy,
  renderStatic,
}: {
  record: TheaterRecord;
  disabled: boolean;
  onBusy: (busy: boolean) => void;
  renderStatic: (html: string) => ReactNode;
}) {
  const [error, setError] = useState("");
  const [input, setInput] = useState("");
  const [selected, setSelected] = useState(record.htmlPages?.[0]?.id || "");
  const [asking, setAsking] = useState(false);
  const pages = record.htmlPages || [];
  const pageId = pages.some((p) => p.id === selected) ? selected : pages[0]?.id;
  const pending = asking || record.interaction?.status === "running";
  async function request(text: string, id = pageId) {
    if (disabled || pending || !text.trim() || !id) return;
    setAsking(true);
    onBusy(true);
    setError("");
    try {
      await generateHtmlPage(record.id, id, text);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "本次补充未完成。");
    } finally {
      setAsking(false);
      onBusy(false);
    }
  }
  return (
    <div className="free-theater">
      {pages.map((page) => (
        <section
          className="free-theater-page"
          key={page.id}
          aria-label={page.title}
        >
          {pages.length > 1 && (
            <p className="theater-presets-label">{page.title}</p>
          )}
          {record.status !== "complete" || record.reading?.clarity ? (
            renderStatic(page.html)
          ) : (
            <FreeTheaterFrame
              record={record}
              page={page}
              disabled={disabled || pending}
              onError={setError}
              onBusy={onBusy}
            />
          )}
        </section>
      ))}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {record.interaction?.error && (
        <p className="error" role="alert">
          {record.interaction.error}
        </p>
      )}
      {pending ? (
        <p className="hint" role="status">
          正在补充小剧场，原页面仍保留。
          <button onClick={() => stopHtmlInteraction(record.id)}>
            停止补充
          </button>
        </p>
      ) : (
        record.interaction &&
        ["failed", "interrupted"].includes(record.interaction.status) && (
          <button
            disabled={disabled}
            onClick={() =>
              void request(
                record.interaction!.input,
                record.interaction!.sectionId,
              )
            }
          >
            重试这次补充 · AI
          </button>
        )
      )}
      <details className="theater-html-tools">
        <summary>为这一栏补充内容 · AI</summary>
        {pages.length > 1 && (
          <label className="field">
            选择栏目
            <select
              value={pageId}
              onChange={(e) => setSelected(e.target.value)}
            >
              {pages.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.title}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="field">
          补充要求
          <textarea
            value={input}
            maxLength={8000}
            onChange={(e) => setInput(e.target.value)}
            placeholder="写下想回复的话，或希望补充的细节。"
          />
        </label>
        <button
          disabled={disabled || pending || !input.trim()}
          onClick={() => void request(input)}
        >
          发送并更新本栏 · AI
        </button>
        <p className="hint">
          只有点击 AI 操作才请求模型，展开和页面内操作在本地完成。
        </p>
      </details>
      {record.interaction?.raw && (
        <details>
          <summary>查看本次补充的原始输出</summary>
          <pre>{record.interaction.raw}</pre>
        </details>
      )}
    </div>
  );
}
