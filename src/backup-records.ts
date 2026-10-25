// Large records (for example a cast with many reference pictures) are split on
// the wire, without changing the author's stored data or version history.
export const MAX_RECORD_CHARS = 16 * 1024 * 1024;
export const MAX_RESTORED_RECORD_CHARS = 256 * 1024 * 1024;
const PART_CHARS = 512 * 1024;
const marker = "__cijianBackupChunk";

export function* encodeBackupRecord(row: { id: string }) {
  const json = JSON.stringify(row);
  if (json.length > MAX_RESTORED_RECORD_CHARS)
    throw Error(
      "单条资料超过 256 MiB，无法安全恢复，已停止导出；请先精简该条资料或版本历史",
    );
  if (json.length <= MAX_RECORD_CHARS) {
    yield json;
    return;
  }
  const total = Math.ceil(json.length / PART_CHARS);
  for (let index = 0; index < total; index++)
    yield JSON.stringify({
      [marker]: {
        id: row.id,
        index,
        total,
        text: json.slice(index * PART_CHARS, (index + 1) * PART_CHARS),
      },
    });
}

export class BackupRecordDecoder {
  private pending?: {
    table: string;
    id: string;
    total: number;
    parts: string[];
    length: number;
  };
  push(table: string, row: any): any | undefined {
    if (!row || typeof row !== "object" || !(marker in row)) {
      this.finish();
      return row;
    }
    const part = row[marker];
    if (
      Object.keys(row).length !== 1 ||
      !part ||
      typeof part.id !== "string" ||
      !part.id ||
      part.id.length > 2048 ||
      !Number.isSafeInteger(part.index) ||
      !Number.isSafeInteger(part.total) ||
      part.total < 2 ||
      part.total > MAX_RESTORED_RECORD_CHARS / PART_CHARS ||
      part.index < 0 ||
      part.index >= part.total ||
      typeof part.text !== "string" ||
      !part.text.length ||
      part.text.length > PART_CHARS
    )
      throw Error("备份分块资料无效");
    if (!this.pending) {
      if (part.index !== 0) throw Error("备份分块缺失或顺序错误");
      this.pending = {
        table,
        id: part.id,
        total: part.total,
        parts: [],
        length: 0,
      };
    }
    const p = this.pending;
    if (
      p.table !== table ||
      p.id !== part.id ||
      p.total !== part.total ||
      part.index !== p.parts.length
    )
      throw Error("备份分块缺失、重复或顺序错误");
    p.parts.push(part.text);
    p.length += part.text.length;
    if (p.length > MAX_RESTORED_RECORD_CHARS)
      throw Error("备份分块资料超过恢复上限");
    if (p.parts.length < p.total) return;
    const value = JSON.parse(p.parts.join(""));
    this.pending = undefined;
    if (!value || value.id !== p.id || marker in value)
      throw Error("备份分块的资料编号不一致");
    return value;
  }
  finish() {
    if (this.pending) throw Error("备份分块不完整，原资料未改变");
  }
}

export function decodeBackupRecords(raw: unknown) {
  if (!raw || typeof raw !== "object" || ![11, 12].includes((raw as any).version))
    return raw;
  const decoded: Record<string, unknown> = { ...raw };
  for (const [table, rows] of Object.entries(raw)) {
    if (!Array.isArray(rows)) continue;
    const decoder = new BackupRecordDecoder();
    const values: unknown[] = [];
    for (const row of rows) {
      const value = decoder.push(table, row);
      if (value !== undefined) values.push(value);
    }
    decoder.finish();
    decoded[table] = values;
  }
  return decoded;
}
