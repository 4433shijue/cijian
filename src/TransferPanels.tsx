import { useEffect, useRef, useState } from "react";
import { Download } from "lucide-react";
import { useLiveQuery } from "dexie-react-hooks";
import { db } from "./db";
import { Modal } from "./Modal";
import { TransferClient, downloadBlob } from "./transfer-client";
import type { Story } from "./types";
import type {
  ImportSummary,
  TransferProgress,
  WorkOptions,
} from "./transfer-types";

const megabytes = (bytes: number) =>
  bytes < 1024 * 1024
    ? (bytes / 1024).toFixed(1) + " KB"
    : (bytes / 1024 / 1024).toFixed(1) + " MB";
const phases = {
  reading: "正在分块读取",
  checking: "正在检查资料关联",
  importing: "正在保存导入资料",
  exporting: "正在分批导出",
  packing: "正在整理文件",
};
function Progress({
  value,
  cancelling,
  cancel,
}: {
  value?: TransferProgress;
  cancelling: boolean;
  cancel: () => void;
}) {
  const p = value;
  const total = p?.phase === "reading" ? p.totalBytes : p?.totalRecords;
  const current = p?.phase === "reading" ? p.bytes : p?.records;
  return (
    <div className="transfer-progress" role="status">
      <strong>
        {cancelling ? "正在取消，请稍候…" : p ? phases[p.phase] : "正在准备…"}
      </strong>
      <progress
        aria-label="文件处理进度"
        value={total ? current : undefined}
        max={total || undefined}
      />
      <span>
        {p
          ? `${p.phase === "reading" ? megabytes(p.bytes) + " / " + megabytes(p.totalBytes) + " · " : ""}${p.records} 条资料${p.totalRecords ? " / " + p.totalRecords : ""}`
          : "大文件会分批处理，可以取消。"}
      </span>
      <button disabled={cancelling} onClick={cancel}>
        取消操作
      </button>
    </div>
  );
}
function useTransfer(notify: (message: string) => void) {
  const client = useRef<TransferClient | undefined>(undefined);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<TransferProgress>();
  const [cancelling, setCancelling] = useState(false);
  const [summary, setSummary] = useState<ImportSummary>();
  const [error, setError] = useState("");
  const [preview, setPreview] = useState<string>();
  const [previewFile, setPreviewFile] = useState<{
    blob: Blob;
    filename: string;
  }>();
  const printWindow = useRef<Window | null>(null);
  const urls = useRef<string[]>([]);
  const printing = useRef(false);
  useEffect(
    () => () => {
      client.current?.dispose();
      for (const url of urls.current) URL.revokeObjectURL(url);
    },
    [],
  );
  useEffect(() => {
    if (!running) return;
    const leave = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", leave);
    return () => window.removeEventListener("beforeunload", leave);
  }, [running]);
  const start = (print = false) => {
    client.current?.dispose();
    setRunning(true);
    setProgress(undefined);
    setCancelling(false);
    setSummary(undefined);
    setError("");
    printing.current = print;
    if (print) {
      printWindow.current = window.open("", "_blank");
      if (printWindow.current) {
        printWindow.current.opener = null;
        printWindow.current.document.title = "正在准备打印预览";
        printWindow.current.document.body.textContent = "正在排版，请稍候…";
      }
    }
    const next = new TransferClient((reply) => {
      if (reply.type === "progress") setProgress(reply.progress);
      if (reply.type === "preview") {
        setSummary(reply.summary);
        setRunning(false);
      }
      if (["complete", "error", "cancelled"].includes(reply.type)) {
        setRunning(false);
        setCancelling(false);
        setSummary(undefined);
      }
      if (reply.type === "error") {
        setError(reply.message);
        printWindow.current?.close();
      }
      if (reply.type === "cancelled") {
        notify("已取消，原资料未改变");
        printWindow.current?.close();
      }
      if (reply.type === "complete") {
        if (reply.blob && reply.filename) {
          if (printing.current) {
            const url = URL.createObjectURL(reply.blob);
            urls.current.push(url);
            setPreview(url);
            setPreviewFile({ blob: reply.blob, filename: reply.filename });
            if (printWindow.current && !printWindow.current.closed)
              printWindow.current.location.replace(url);
            notify("排版已完成，可在预览中打印或保存 PDF");
          } else {
            downloadBlob(reply.filename, reply.blob);
            notify("文件已准备好，请保存到你的设备");
          }
        } else notify("备份已导入，关联资料已完整保存");
      }
    });
    client.current = next;
    return next;
  };
  const cancel = () => {
    setCancelling(true);
    setRunning(true);
    client.current?.cancel();
  };
  return {
    start,
    cancel,
    client,
    running,
    progress,
    cancelling,
    summary,
    setRunning,
    error,
    preview,
    previewFile,
  };
}

export function BackupSettings({
  notify,
}: {
  notify: (message: string) => void;
}) {
  const t = useTransfer(notify);
  const [applySettings, setApplySettings] = useState(false);
  return (
    <section className="settings-card transfer-panel">
      <h2>保存与迁移</h2>
      <p>
        资料保存在当前浏览器中，请定期备份。作品文件在「故事设置 →
        导出作品」中选择。
      </p>
      <div className="row">
        <button
          disabled={t.running || !!t.summary}
          onClick={() => t.start().backup()}
        >
          <Download size={16} />
          导出完整备份（不含 Key）
        </button>
        <label className="file-button">
          导入备份
          <input
            disabled={t.running || !!t.summary}
            type="file"
            accept=".json,application/json"
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (file) {
                setApplySettings(false);
                t.start().read(file);
              }
            }}
          />
        </label>
      </div>
      <p className="hint">
        支持旧版完整备份和单本故事备份。读取、检查和保存都有进度，可以随时取消。
      </p>
      {t.running && !t.summary && (
        <Progress
          value={t.progress}
          cancelling={t.cancelling}
          cancel={t.cancel}
        />
      )}
      {t.error && (
        <p className="error" role="alert">
          {t.error}
        </p>
      )}
      {t.summary && (
        <Modal title="导入预览" onClose={t.cancel}>
          <div className="transfer-panel">
            <p>
              {t.summary.scope === "story"
                ? `单本故事「${t.summary.title || "未命名"}」`
                : "完整资料备份"}{" "}
              · {t.summary.created.slice(0, 10)} · {megabytes(t.summary.bytes)}
            </p>
            <dl className="transfer-counts">
              <div>
                <dt>故事</dt>
                <dd>{t.summary.counts.stories}</dd>
              </div>
              <div>
                <dt>角色</dt>
                <dd>{t.summary.counts.roles}</dd>
              </div>
              <div>
                <dt>正文与聊天</dt>
                <dd>{t.summary.counts.events}</dd>
              </div>
              <div>
                <dt>记忆</dt>
                <dd>{t.summary.counts.memories}</dd>
              </div>
              <div>
                <dt>世界书</dt>
                <dd>{t.summary.counts.world}</dd>
              </div>
              <div>
                <dt>角色草稿</dt>
                <dd>{t.summary.counts.roleDrafts}</dd>
              </div>
            </dl>
            <p className="hint">
              合并会新增副本并重建关联，包含已删除内容、历史版本和未完成草稿。故事的自定义文风一起保留，同名预设不会覆盖现有版本。
            </p>
            {!!t.summary.counts.roleDrafts && (
              <p className="hint">
                如本机已有未完成的角色，新导入的角色草稿会放入角色库，名字标注「导入草稿」。
              </p>
            )}
            {t.summary.scope !== "story" && (
              <label className="transfer-check">
                <input
                  type="checkbox"
                  checked={applySettings}
                  disabled={t.running}
                  onChange={(e) => setApplySettings(e.target.checked)}
                />
                应用备份中的模型配置、提示词及偏好设置
              </label>
            )}
            <p className="hint">
              {applySettings
                ? `将导入 ${t.summary.counts.profiles} 个接口配置，并应用备份设置；接口密钥需重新填写。`
                : "保留本机模型配置、密钥和提示词设置。"}
            </p>
            {t.running ? (
              <Progress
                value={t.progress}
                cancelling={t.cancelling}
                cancel={t.cancel}
              />
            ) : (
              <div className="row">
                <button
                  className="primary"
                  onClick={() => {
                    t.setRunning(true);
                    t.client.current?.commit({ replace: false, applySettings });
                  }}
                >
                  作为副本合并
                </button>
                {t.summary.scope === "library" && (
                  <button
                    className="danger"
                    onClick={() => {
                      if (
                        !confirm(
                          "替换会移除现有故事、角色、世界书与记忆。确认已有备份，并用这份文件替换？未勾选应用设置时，本机模型与提示词会保留。",
                        )
                      )
                        return;
                      t.setRunning(true);
                      t.client.current?.commit({
                        replace: true,
                        applySettings,
                      });
                    }}
                  >
                    替换全部资料
                  </button>
                )}
                <button onClick={t.cancel}>取消导入</button>
              </div>
            )}
          </div>
        </Modal>
      )}
    </section>
  );
}

export function StoryTransfer({
  story,
  notify,
}: {
  story: Story;
  notify: (message: string) => void;
}) {
  const t = useTransfer(notify);
  const [expanded, setExpanded] = useState(false);
  const [options, setOptions] = useState<WorkOptions>({
    storyId: story.id,
    content: "novel",
    range: "all",
    from: 1,
    to: 1,
    background: false,
    characters: false,
    format: "txt",
    fontSize: 16,
    lineHeight: 1.8,
    pageBreak: false,
  });
  const count = useLiveQuery(
    () =>
      db.events
        .where("storyId")
        .equals(story.id)
        .filter(
          (e) =>
            e.status === "complete" &&
            !e.deleted &&
            (options.content === "all" ||
              e.kind === (options.content === "novel" ? "novel" : "message")),
        )
        .count(),
    [story.id, options.content],
  );
  const change = (patch: Partial<WorkOptions>) =>
    setOptions((o) => ({ ...o, ...patch }));
  const unit =
    options.content === "novel"
      ? "段正文"
      : options.content === "chat"
        ? "条消息"
        : "项时间线内容";
  return (
    <section className="transfer-panel story-transfer">
      <div className="row">
        <button aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
          <Download size={16} />
          导出作品
        </button>
        <button disabled={t.running} onClick={() => t.start().backup(story.id)}>
          备份这本故事
        </button>
      </div>
      <p className="hint">
        作品用于阅读分享；故事备份保留角色、人设、记忆、历史版本和草稿，可重新导入。
      </p>
      {expanded && (
        <div className="transfer-options">
          <div className="transfer-grid">
            <label>
              导出内容
              <select
                aria-label="导出内容"
                value={options.content}
                disabled={t.running}
                onChange={(e) =>
                  change({
                    content: e.target.value as WorkOptions["content"],
                    range: "all",
                  })
                }
              >
                <option value="novel">纯正文</option>
                <option value="all">正文与聊天</option>
                <option value="chat">仅聊天</option>
              </select>
            </label>
            <label>
              文件格式
              <select
                aria-label="文件格式"
                value={options.format}
                disabled={t.running}
                onChange={(e) =>
                  change({ format: e.target.value as WorkOptions["format"] })
                }
              >
                <option value="txt">TXT 文本</option>
                <option value="md">Markdown</option>
                <option value="docx">Word（DOCX）</option>
                <option value="epub">EPUB 电子书</option>
                <option value="print">PDF / 打印预览</option>
              </select>
            </label>
          </div>
          <label>
            导出范围
            <select
              aria-label="导出范围"
              value={options.range}
              disabled={t.running}
              onChange={(e) =>
                change({
                  range: e.target.value as WorkOptions["range"],
                  from: 1,
                  to: count || 1,
                })
              }
            >
              <option value="all">
                全部（{count ?? "…"} {unit}）
              </option>
              <option value="selection">选择起止位置</option>
            </select>
          </label>
          {options.range === "selection" && (
            <div className="transfer-grid">
              <label>
                从第几项开始
                <input
                  type="number"
                  min="1"
                  max={count}
                  value={options.from}
                  disabled={t.running}
                  onChange={(e) => change({ from: Number(e.target.value) })}
                />
              </label>
              <label>
                到第几项结束
                <input
                  type="number"
                  min={options.from}
                  max={count}
                  value={options.to}
                  disabled={t.running}
                  onChange={(e) => change({ to: Number(e.target.value) })}
                />
              </label>
              <p className="hint">
                按所选内容的先后编号，共 {count ?? "…"} {unit}，包含起止两项。
              </p>
            </div>
          )}
          <label className="transfer-check">
            <input
              type="checkbox"
              disabled={t.running}
              checked={options.background}
              onChange={(e) => change({ background: e.target.checked })}
            />
            附上开场背景
          </label>
          <label className="transfer-check">
            <input
              type="checkbox"
              disabled={t.running}
              checked={options.characters}
              onChange={(e) => change({ characters: e.target.checked })}
            />
            附上人物介绍（名字与简介）
          </label>
          {["docx", "epub", "print"].includes(options.format) && (
            <div className="transfer-grid">
              <label>
                字号
                <select
                  aria-label="字号"
                  value={options.fontSize}
                  disabled={t.running}
                  onChange={(e) => change({ fontSize: Number(e.target.value) })}
                >
                  {[12, 14, 16, 18, 20, 24].map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                行距
                <select
                  aria-label="行距"
                  value={options.lineHeight}
                  disabled={t.running}
                  onChange={(e) =>
                    change({ lineHeight: Number(e.target.value) })
                  }
                >
                  {[1.2, 1.5, 1.8, 2, 2.5].map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </select>
              </label>
              <label className="transfer-check">
                <input
                  type="checkbox"
                  checked={options.pageBreak}
                  disabled={t.running}
                  onChange={(e) => change({ pageBreak: e.target.checked })}
                />
                正文段落另起一页
              </label>
            </div>
          )}
          <p className="hint">
            只包含当前已完成内容。草稿、删除内容、历史版本和私密人设请使用故事备份保存。
            {options.format === "print"
              ? "预览可以继续调整排版，在浏览器打印窗口选择「另存为 PDF」。"
              : ""}
          </p>
          <button
            className="primary"
            disabled={
              t.running ||
              !count ||
              (options.range === "selection" &&
                (!Number.isInteger(options.from) ||
                  !Number.isInteger(options.to) ||
                  options.from < 1 ||
                  options.to < options.from ||
                  options.to > count))
            }
            onClick={() => t.start(options.format === "print").work(options)}
          >
            {options.format === "print" ? "打开打印预览" : "生成作品文件"}
          </button>
        </div>
      )}
      {t.running && (
        <Progress
          value={t.progress}
          cancelling={t.cancelling}
          cancel={t.cancel}
        />
      )}
      {t.error && (
        <p className="error" role="alert">
          {t.error}
        </p>
      )}
      {t.preview && (
        <div className="row">
          <a
            className="file-button"
            href={t.preview}
            target="_blank"
            rel="noopener"
          >
            打开已生成的打印预览
          </a>
          <button
            onClick={() =>
              t.previewFile &&
              downloadBlob(t.previewFile.filename, t.previewFile.blob)
            }
          >
            保存排版文件
          </button>
        </div>
      )}
    </section>
  );
}
