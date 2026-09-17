import { useEffect, useRef, useState } from "react";
import { Lightbulb, RefreshCw } from "lucide-react";
import { useLiveQuery } from "dexie-react-hooks";
import {
  inspirationState,
  pendingInspiration,
  requestInspiration,
} from "./inspiration";
import type { Story } from "./types";

export function InspirationAssistant({
  story,
  blocked,
  onChoose,
  onClose,
}: {
  story: Story;
  blocked: boolean;
  onChoose: (text: string) => void;
  onClose: () => void;
}) {
  const [thinking, setThinking] = useState(false);
  const [error, setError] = useState("");
  const [feedback, setFeedback] = useState(story.inspiration?.feedback || "");
  const mounted = useRef(false);
  const busy = useRef(false);
  const state = useLiveQuery(() => inspirationState(story.id), [story.id]);
  const options = state?.round?.options || story.inspiration?.options || [];
  async function ask(pending?: ReturnType<typeof pendingInspiration>) {
    if (busy.current || blocked) return;
    busy.current = true;
    setThinking(true);
    setError("");
    try {
      const outcome = await (pending || requestInspiration(story.id, feedback));
      if (mounted.current && outcome === "stale")
        setError(
          "生成期间参考内容发生了变化，这次结果没有替换当前建议。请点「你再想想」。",
        );
    } catch (cause) {
      if (mounted.current)
        setError(
          cause instanceof Error
            ? cause.message
            : "暂时没能找到灵感，请再试一次。",
        );
    } finally {
      busy.current = false;
      if (mounted.current) setThinking(false);
    }
  }
  useEffect(() => {
    mounted.current = true;
    // Join work already requested by the author. Stale saved rounds never auto-reroll.
    const pending = pendingInspiration(story.id);
    if (pending) void ask(pending);
    else if (!story.inspiration && !blocked) void ask();
    return () => {
      mounted.current = false;
    };
  }, [story.id]);
  return (
    <div className="inspiration-assistant">
      <p className="inspiration-intro">
        顺着前文和人物当前的处境，想四种接得上的下一步。选一个放进输入框，再按你的想法调整。
      </p>
      {thinking && (
        <p className="inspiration-thinking" role="status">
          <Lightbulb size={18} />
          正在想四个合乎情境的下一步，可以先关掉窗口。
        </p>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {state?.stale && (
        <p className="inspiration-stale" role="status">
          这轮灵感需要更新：前文、人设或参考内容已变化，或来自旧版小助手。旧建议仍保留供你查看，点「你再想想」后会按当前内容生成。
        </p>
      )}
      <div className="inspiration-grid">
        {options.map((option, index) => (
          <button
            className="inspiration-option"
            key={index}
            disabled={thinking || blocked || !state || state.stale}
            onClick={() => onChoose(option.text)}
          >
            <span className="inspiration-direction">
              {String.fromCharCode(65 + index)} · 候选
            </span>
            <strong>{option.title}</strong>
            <span className="inspiration-text">{option.text}</span>
            <span className="inspiration-use">用这个方向 ↗</span>
          </button>
        ))}
      </div>
      {!thinking && !options.length && !error && (
        <p className="hint">
          这一轮已经清空。想找新的方向时，让小助手再想一轮就好。
        </p>
      )}
      <label className="inspiration-feedback">
        这次希望怎么调整？（可选）
        <textarea
          value={feedback}
          rows={2}
          disabled={thinking}
          placeholder="比如：他不会主动靠近；留在当前场景，别突然变亲密。"
          onChange={(event) => setFeedback(event.target.value)}
        />
      </label>
      <div className="inspiration-actions">
        <button onClick={onClose}>我自己写</button>
        <button
          className="primary"
          disabled={thinking || blocked}
          onClick={() => void ask()}
        >
          <RefreshCw size={16} />
          你再想想
        </button>
      </div>
      <p className="hint">
        关闭后可以再看这一轮；参考内容变化时会提示更新，不会自动重新调用模型。点击「你再想想」会再次调用你配置的模型。
      </p>
    </div>
  );
}
