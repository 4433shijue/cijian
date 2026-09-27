import { useState } from "react";
import { Copy, FileCheck2, PencilLine } from "lucide-react";
import {
  completionCardSourceKey,
  completionSourceKey,
  type CompletionAttempt,
  type CompletionDraft,
  type CompletionParseInfo,
} from "./role-completion-types";

const stateLabels: Record<CompletionAttempt["state"], string> = {
  running: "接收中",
  failed: "未能解析",
  interrupted: "已中断",
  parsed: "已生成预览",
  recovered: "已恢复预览",
};

export function CompletionParseNotice({
  info,
}: {
  info?: CompletionParseInfo;
}) {
  if (!info?.repairs.length) return null;
  const quoteCount = info.repairs.reduce(
    (sum, repair) => sum + (repair.kind === "string-concat" ? 0 : repair.count),
    0,
  );
  const joinCount = info.repairs.reduce(
    (sum, repair) => sum + (repair.kind === "string-concat" ? repair.count : 0),
    0,
  );
  const counts = [
    quoteCount ? `${quoteCount} 处引号转义` : "",
    joinCount ? `${joinCount} 处字面量拼接` : "",
  ]
    .filter(Boolean)
    .join("、");
  return (
    <details className="completion-format-note">
      <summary>已在本地修复 JSON 格式 · {counts}</summary>
      <p>
        {joinCount
          ? "修复仅处理格式。字符串拼接只合并已明确给出的字面量；原始输出仍保存在生成记录中。"
          : "只补充了字符串所需的转义符，没有改写字段文字。原始输出仍保存在生成记录中。"}
      </p>
      <ul>
        {info.repairs.map((repair, index) => (
          <li key={`${repair.field}-${repair.line}-${index}`}>
            <code>{repair.field}</code> · 原始输出第 {repair.line} 行 ·{" "}
            {repair.count} 处
            {repair.kind === "string-concat" ? "字面量拼接" : "引号转义"}
          </li>
        ))}
      </ul>
    </details>
  );
}

type Props = {
  draft: CompletionDraft;
  disabled: boolean;
  onRecover: (attemptId?: string, editedText?: string) => void;
  onEdit: (attemptId: string | undefined, text: string) => void;
};

export function CompletionRecovery({
  draft,
  disabled,
  onRecover,
  onEdit,
}: Props) {
  const [selectedId, setSelectedId] = useState("");
  const [rawOpen, setRawOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [message, setMessage] = useState("");
  const [localError, setLocalError] = useState("");
  const attempts = draft.attempts || [];
  const selected =
    attempts.find((attempt) => attempt.id === selectedId) || attempts.at(-1);
  const raw = selected?.raw ?? draft.raw;
  const legacy = !selected || (selected.stage === "card" && !selected.target);
  const inputKey = selected?.inputKey ?? draft.sourceKey;
  const stale =
    inputKey !== completionSourceKey(draft.input) ||
    (!legacy &&
      selected?.stage === "card" &&
      selected.sourceKey !== completionCardSourceKey(draft));
  const alreadyParsed =
    selected?.state === "parsed" || selected?.state === "recovered";
  const targetUnselected =
    !!selected?.target &&
    !draft.candidates.some(
      (candidate) => candidate.id === selected.target?.id && candidate.selected,
    );
  const existingCard =
    !!selected?.target &&
    draft.cards.some(
      (card) =>
        card.candidateId === selected.target?.id &&
        card.sourceKey === selected.sourceKey,
    );
  const blocked =
    stale || targetUnselected || alreadyParsed || existingCard || !raw.trim();
  const label =
    selected?.target?.name || (legacy ? "旧版保留的输出" : "识别主角");
  const editedText = selected?.recoveryText ?? raw;

  function recover(edited = false) {
    setMessage("");
    setLocalError("");
    try {
      onRecover(selected?.id, edited ? editedText : raw);
      setEditing(false);
      setMessage(
        "已在本地重新解析，请检查上方的预览，再选择保存。没有调用 AI。",
      );
    } catch (error) {
      setLocalError(
        error instanceof Error
          ? error.message
          : "暂时没能解析，请检查格式后再试。",
      );
    }
  }

  async function copyRaw() {
    setMessage("");
    setLocalError("");
    try {
      await navigator.clipboard.writeText(raw);
      setMessage("原始输出已复制。");
    } catch {
      setLocalError("暂时无法复制。可以展开原始输出后手动选择并复制。");
    }
  }

  if (!attempts.length && !draft.raw) return null;
  return (
    <section className="completion-recovery" aria-label="生成记录与格式恢复">
      <div className="completion-section-heading">
        <div>
          <span className="eyebrow">KEEP WHAT ARRIVED</span>
          <h3>生成记录与格式恢复</h3>
        </div>
        <span className="hint">
          {attempts.length || 1} 次记录 · 仅保存在本机
        </span>
      </div>
      {attempts.length > 1 && (
        <label className="field">
          <span>查看哪次生成</span>
          <select
            aria-label="查看哪次生成"
            value={selected?.id || ""}
            onChange={(event) => {
              setSelectedId(event.target.value);
              setEditing(false);
              setMessage("");
              setLocalError("");
            }}
          >
            {attempts.map((attempt, index) => (
              <option key={attempt.id} value={attempt.id}>
                第 {index + 1} 次 ·{" "}
                {attempt.target?.name ||
                  (attempt.stage === "candidates"
                    ? "识别主角"
                    : "旧版输出")}{" "}
                · {stateLabels[attempt.state]}
              </option>
            ))}
          </select>
        </label>
      )}
      <div className="completion-recovery-meta">
        <strong>{label}</strong>
        <span
          className={`completion-attempt-state state-${selected?.state || "failed"}`}
        >
          {selected ? stateLabels[selected.state] : "待检查"}
        </span>
        <span className="hint">
          已收到 {raw.length.toLocaleString()} 个字符
        </span>
      </div>
      {selected?.error && selected.error !== draft.error && (
        <p className="completion-warning">{selected.error}</p>
      )}
      {legacy && (
        <p className="hint completion-provenance-note">
          这是旧版保留的输出，没有独立的生成来源记录。恢复时会核对当前素材和角色身份，请核对预览后再保存。
        </p>
      )}
      {stale ? (
        <p className="completion-warning" role="status">
          素材、要求或主角名单已改变，这次记录只能查看，不能恢复到当前预览。
        </p>
      ) : targetUnselected ? (
        <p className="completion-warning" role="status">
          请先重新选中这次回复对应的人物，再恢复到角色卡预览。
        </p>
      ) : alreadyParsed || existingCard ? (
        <p className="hint">
          已有对应预览，再次解析不会覆盖你已编辑或已保存的角色卡。
        </p>
      ) : (
        <p className="hint">
          先尝试本地重新解析。只有通过完整格式和角色结构检查的内容才会进入预览，缺失内容不会自动补写。
        </p>
      )}
      <div className="completion-actions completion-recovery-actions">
        <button
          type="button"
          disabled={disabled || blocked}
          onClick={() => recover()}
        >
          <FileCheck2 size={16} />
          重新解析已收到内容（不调用 AI）
        </button>
        <button
          type="button"
          disabled={disabled || blocked}
          aria-expanded={editing}
          onClick={() => {
            setEditing((value) => !value);
            setMessage("");
            setLocalError("");
          }}
        >
          <PencilLine size={16} />
          {editing ? "收起格式编辑" : "检查并修正格式"}
        </button>
      </div>
      {editing && (
        <div className="completion-recovery-editor">
          <label className="field">
            <span>用于重新解析的副本</span>
            <textarea
              aria-label="用于重新解析的副本"
              spellCheck={false}
              value={editedText}
              disabled={disabled || blocked}
              onChange={(event) => {
                onEdit(selected?.id, event.target.value);
                setLocalError("");
              }}
            />
          </label>
          <p className="hint">
            这里的修改单独保存，原始输出不会改变。检查引号、逗号和括号后再解析。
          </p>
          <button
            type="button"
            disabled={disabled || blocked}
            onClick={() => recover(true)}
          >
            解析修正后的内容（不调用 AI）
          </button>
        </div>
      )}
      {localError && (
        <p className="error completion-error" role="alert">
          {localError}
        </p>
      )}
      {message && (
        <p className="completion-recovery-success" role="status">
          {message}
        </p>
      )}
      <CompletionParseNotice info={selected?.parseInfo} />
      <details
        className="completion-raw"
        open={rawOpen}
        onToggle={(event) => setRawOpen(event.currentTarget.open)}
      >
        <summary>查看本次模型原始输出</summary>
        {rawOpen && (
          <>
            <div className="completion-raw-toolbar">
              <span className="hint">原文只读</span>
              <button
                type="button"
                disabled={!raw}
                onClick={() => void copyRaw()}
              >
                <Copy size={14} />
                复制原始输出
              </button>
            </div>
            <pre tabIndex={0} aria-label="模型原始输出">
              {raw || "暂未收到内容。"}
            </pre>
          </>
        )}
      </details>
    </section>
  );
}
