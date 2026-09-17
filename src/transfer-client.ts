import { uid } from "./types";
import type {
  TransferCommand,
  TransferReply,
  ImportOptions,
  WorkOptions,
} from "./transfer-types";

export class TransferClient {
  private worker: Worker;
  private finished = false;
  private shutdown?: ReturnType<typeof setTimeout>;
  readonly session = uid();
  constructor(private receive: (reply: TransferReply) => void) {
    this.worker = new Worker(new URL("./transfer.worker.ts", import.meta.url), {
      type: "module",
    });
    this.worker.onmessage = ({ data }: MessageEvent<TransferReply>) => {
      if (["complete", "cancelled", "error"].includes(data.type)) {
        this.finished = true;
        if (this.shutdown) clearTimeout(this.shutdown);
        this.worker.terminate();
      }
      this.receive(data);
    };
    this.worker.onerror = () => {
      this.finished = true;
      this.worker.terminate();
      this.receive({
        type: "error",
        message: "后台任务意外中断，请刷新确认资料状态后再重试。",
      });
    };
  }
  private send(command: TransferCommand) {
    this.worker.postMessage(command);
  }
  read(file: File) {
    this.send({ type: "read", session: this.session, file });
  }
  backup(storyId?: string) {
    this.send({ type: "backup", session: this.session, storyId });
  }
  work(options: WorkOptions) {
    this.send({ type: "work", session: this.session, options });
  }
  commit(options: ImportOptions) {
    this.send({ type: "commit", options });
  }
  cancel() {
    if (!this.finished) this.send({ type: "cancel" });
  }
  dispose() {
    if (this.finished) return;
    this.cancel();
    this.shutdown = setTimeout(() => this.worker.terminate(), 15_000);
  }
}
export function downloadBlob(filename: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
