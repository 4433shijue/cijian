import { useEffect, useState } from "react";
import {
  imageDiagnosticText,
  imageStageLabels,
  type ImageDiagnostic,
} from "./image-diagnostics";
import { version } from "../package.json";

export function ImageDiagnostics({
  diagnostic: d,
}: {
  diagnostic?: ImageDiagnostic;
}) {
  const [now, setNow] = useState(Date.now());
  const [copied, setCopied] = useState(false);
  const [fallback, setFallback] = useState(false);
  useEffect(() => {
    if (d?.outcome !== "running") return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [d?.outcome]);
  useEffect(() => {
    setCopied(false);
    setFallback(false);
  }, [d?.startedAt]);
  if (!d) return null;
  const text = `此间 ${version} · 生图诊断\n${imageDiagnosticText(d.outcome === "running" ? { ...d, updatedAt: Math.max(now, d.updatedAt) } : d)}`;
  const elapsed = Math.max(
    0,
    Math.floor(
      ((d.outcome === "running" ? now : d.updatedAt) - d.startedAt) / 1000,
    ),
  );
  return (
    <div className="image-diagnostics">
      {d.outcome === "running" && (
        <p className="hint" role="status">
          {imageStageLabels[d.stage]} · 已用 {elapsed} 秒
        </p>
      )}
      <details>
        <summary>
          生图诊断
          {d.outcome === "timeout" ? ` · ${imageStageLabels[d.stage]}超时` : ""}
        </summary>
        <pre>{text}</pre>
        <button
          type="button"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(text);
              setCopied(true);
            } catch {
              setFallback(true);
            }
          }}
        >
          {copied ? "已复制诊断" : "复制生图诊断"}
        </button>
        {fallback && (
          <label className="field">
            请选中复制诊断
            <textarea
              aria-label="请选中复制诊断"
              readOnly
              value={text}
              onFocus={(e) => e.target.select()}
            />
          </label>
        )}
      </details>
    </div>
  );
}
