import { backupTables } from "./transfer-types";

// Only one top-level array item is assembled at a time. The decoder and scanner
// both retain their state across chunks, including split UTF-8 and JSON escapes.
export const READ_CHUNK_BYTES = 1024 * 1024;
export const MAX_RECORD_CHARS = 16 * 1024 * 1024;
export class BackupParser {
  private state:
    | "root"
    | "key"
    | "colon"
    | "value"
    | "item"
    | "arrayComma"
    | "comma"
    | "done" = "root";
  private key = "";
  private seen = new Set<string>();
  private allowEnd = true;
  private parts: string[] = [];
  private length = 0;
  private active = false;
  private primitive = false;
  private quoted = false;
  private escaped = false;
  private stack: string[] = [];
  readonly metadata: Record<string, unknown> = {};
  constructor(
    private onRecord: (table: string, value: unknown) => Promise<void>,
  ) {}

  async push(text: string) {
    let i = 0;
    const fail = () => {
      throw Error("备份 JSON 格式不完整或存在多余内容");
    };
    while (i < text.length) {
      if (!this.active && /\s/.test(text[i])) {
        i++;
        continue;
      }
      if (this.state === "done") fail();
      if (this.state === "root") {
        if (text[i++] !== "{") fail();
        this.state = "key";
        continue;
      }
      if (this.state === "colon") {
        if (text[i++] !== ":") fail();
        this.state = "value";
        continue;
      }
      if (this.state === "comma" || this.state === "arrayComma") {
        const end = this.state === "comma" ? "}" : "]";
        if (text[i] === end) {
          i++;
          this.state = end === "}" ? "done" : "comma";
          continue;
        }
        if (text[i++] !== ",") fail();
        this.state = end === "}" ? "key" : "item";
        this.allowEnd = false;
        continue;
      }
      if (this.state === "key" && !this.active) {
        if (text[i] === "}" && this.allowEnd) {
          i++;
          this.state = "done";
          continue;
        }
        if (text[i] !== '"') fail();
      }
      if (
        this.state === "value" &&
        backupTables.includes(this.key as any) &&
        !this.active
      ) {
        if (text[i++] !== "[") fail();
        this.state = "item";
        this.allowEnd = true;
        continue;
      }
      if (this.state === "item" && !this.active && text[i] === "]") {
        if (!this.allowEnd) fail();
        i++;
        this.state = "comma";
        continue;
      }
      if (!this.active) {
        this.active = true;
        this.primitive = !'{["'.includes(text[i]);
        this.parts = [];
        this.length = 0;
        this.stack = [];
        this.quoted = false;
        this.escaped = false;
      }
      const start = i;
      let complete = false;
      while (i < text.length) {
        const c = text[i];
        if (this.primitive && /[\s,}\]]/.test(c)) {
          complete = true;
          break;
        }
        i++;
        if (this.quoted) {
          if (this.escaped) this.escaped = false;
          else if (c === "\\") this.escaped = true;
          else if (c === '"') {
            this.quoted = false;
            if (!this.stack.length) {
              complete = true;
              break;
            }
          }
        } else if (c === '"') this.quoted = true;
        else if (c === "{" || c === "[") {
          this.stack.push(c === "{" ? "}" : "]");
          if (this.stack.length > 128) throw Error("备份嵌套过深，已停止读取");
        } else if (c === "}" || c === "]") {
          if (this.stack.pop() !== c) fail();
          if (!this.stack.length) {
            complete = true;
            break;
          }
        }
      }
      this.parts.push(text.slice(start, i));
      this.length += i - start;
      if (this.length > MAX_RECORD_CHARS)
        throw Error(
          "单条资料超过 16 MiB 文本，请先缩小其中的头像或拆分版本历史；原资料未改变",
        );
      if (!complete) return;
      const value = JSON.parse(this.parts.join(""));
      this.parts = [];
      this.active = false;
      if (this.state === "key") {
        this.key = value;
        if (this.seen.has(value)) throw Error("备份字段重复：" + value);
        if (
          ![
            ...backupTables,
            "format",
            "version",
            "created",
            "scope",
            "title",
          ].includes(value)
        )
          throw Error("无法识别的备份字段：" + String(value).slice(0, 60));
        this.seen.add(value);
        this.state = "colon";
      } else if (this.state === "item") {
        await this.onRecord(this.key, value);
        this.state = "arrayComma";
      } else {
        this.metadata[this.key] = value;
        this.state = "comma";
      }
    }
  }
  finish() {
    if (this.state !== "done" || this.active)
      throw Error("备份文件被截断，没有读到完整结尾");
    if (
      this.metadata.format !== "little-scene" ||
      this.metadata.version !== 1 ||
      typeof this.metadata.created !== "string"
    )
      throw Error("这不是支持的此间备份（需要 version 1）");
    for (const key of backupTables.filter(
      (t) => t !== "chatBatches" && t !== "roleDrafts",
    ))
      if (!this.seen.has(key)) throw Error("备份缺少资料区：" + key);
    if (
      this.metadata.scope !== undefined &&
      !["story", "library"].includes(String(this.metadata.scope))
    )
      throw Error("备份范围无效");
    if (
      this.metadata.title !== undefined &&
      typeof this.metadata.title !== "string"
    )
      throw Error("备份名称无效");
    return this.metadata;
  }
}
