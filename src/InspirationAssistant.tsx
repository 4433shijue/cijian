import { useEffect, useRef, useState } from "react";
import { Lightbulb, RefreshCw } from "lucide-react";
import { inspirationDirections, requestInspiration } from "./inspiration";
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
  const mounted = useRef(false);
  const busy = useRef(false);
  const options = story.inspiration?.options || [];
  async function ask() {
    if (busy.current || blocked) return;
    busy.current = true;
    setThinking(true);
    setError("");
    try {
      await requestInspiration(story.id);
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
    // Opening a saved round is free; clearing it after new prose never sends a request.
    if (!story.inspiration && !blocked) void ask();
    return () => {
      mounted.current = false;
    };
  }, [story.id]);
  return (
    <div className="inspiration-assistant">
      <p className="inspiration-intro">
        给接下来的故事找四条路。选一个放进输入框，改到合你心意再扩写。
      </p>
      {thinking && (
        <p className="inspiration-thinking" role="status">
          <Lightbulb size={18} />
          正在想四个不同的方向，可以先关掉窗口。
        </p>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="inspiration-grid">
        {options.map((option, index) => (
          <button
            className="inspiration-option"
            key={option.direction}
            disabled={thinking || blocked}
            onClick={() => onChoose(option.text)}
          >
            <span className="inspiration-direction">
              {String.fromCharCode(65 + index)} ·{" "}
              {inspirationDirections[option.direction]}
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
        这轮灵感会保留到下一段正文生成成功，关闭后可以再来看看。重新想一轮会再次调用你配置的模型。
      </p>
    </div>
  );
}
