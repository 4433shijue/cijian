import { stageBackup, commitStaged, exportBackupBlob } from "./backup-transfer";
import { exportWork, safeFilename } from "./work-export";
import { db } from "./db";
import { clearTransfer, transferLock, TransferControl } from "./transfer-store";
import type {
  ImportOptions,
  TransferCommand,
  TransferReply,
} from "./transfer-types";

const port = self as unknown as {
  postMessage: (reply: TransferReply) => void;
  onmessage: (event: MessageEvent<TransferCommand>) => void;
};
let active = false;
let commit: ((options: ImportOptions | undefined) => void) | undefined;
const control = new TransferControl((progress) =>
  port.postMessage({ type: "progress", progress }),
);
port.onmessage = ({ data }) => {
  if (data.type === "cancel") {
    control.cancel();
    commit?.(undefined);
    return;
  }
  if (data.type === "commit") {
    commit?.(data.options);
    commit = undefined;
    return;
  }
  if (active) return;
  active = true;
  const run = async () => {
    let result: TransferReply | undefined;
    try {
      await db.transferSessions.put({ id: data.session, touched: Date.now() });
      if (data.type === "read") {
        const summary = await stageBackup(data.file, data.session, control);
        control.check();
        const next = new Promise<ImportOptions | undefined>((resolve) => {
          commit = resolve;
        });
        port.postMessage({ type: "preview", summary });
        const options = await next;
        control.check();
        if (!options) return;
        await commitStaged(data.session, options, control);
        // Do not turn a successful atomic commit into a cancellation if the
        // author's cancel click arrived just after the transaction committed.
        result = { type: "complete" };
      } else {
        const output =
          data.type === "backup"
            ? await exportBackupBlob(data.session, data.storyId, control)
            : await exportWork(data.session, data.options, control);
        control.check();
        const dot = output.filename.lastIndexOf(".");
        result = {
          type: "complete",
          ...output,
          filename:
            safeFilename(output.filename.slice(0, dot)) +
            output.filename.slice(dot),
        };
      }
    } catch (error) {
      if (control.cancelled) result = { type: "cancelled" };
      else {
        const e = error as Error;
        const message =
          e.name === "QuotaExceededError"
            ? "浏览器存储空间不足，请腾出空间后重试。原资料未改变。"
            : e.name === "ConstraintError" || e.name === "BulkError"
              ? "备份包含重复 ID，或临时资料写入失败。原资料未改变。"
              : e.name === "ZodError"
                ? "备份中有资料字段缺失或不符合格式。原资料未改变。"
                : e.message || "操作失败，请重新尝试";
        result = { type: "error", message };
      }
    } finally {
      await clearTransfer(data.session).catch(() => {});
      db.close();
    }
    if (result) port.postMessage(result);
  };
  void (navigator.locks
    ? navigator.locks.request(transferLock(data.session), run)
    : run());
};
