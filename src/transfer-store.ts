import Dexie, { type Table, type Transaction } from "dexie";
import { db } from "./db";
import { uid } from "./types";
import type { TransferProgress } from "./transfer-types";

export class TransferControl {
  cancelled = false;
  transaction?: Transaction;
  constructor(readonly report: (p: TransferProgress) => void = () => {}) {}
  check() {
    if (this.cancelled) throw new DOMException("已取消", "AbortError");
  }
  cancel() {
    this.cancelled = true;
    this.transaction?.abort();
  }
}
export async function visitRows<T extends { id: string }>(
  table: Table<T, string>,
  visit: (row: T) => Promise<void>,
) {
  let key: string | undefined;
  for (;;) {
    const row: T | undefined = await (
      key === undefined ? table.orderBy(":id") : table.where(":id").above(key)
    ).first();
    if (!row) return;
    key = row.id;
    await visit(row);
  }
}
export async function clearTransfer(session: string) {
  await db.transaction(
    "rw",
    db.transferRecords,
    db.transferChunks,
    db.transferSessions,
    async () => {
      await db.transferRecords.where("session").equals(session).delete();
      await db.transferChunks.where("session").equals(session).delete();
      await db.transferSessions.delete(session);
    },
  );
}
export const transferLock = (id: string) => "little-scene-transfer:" + id;
export async function cleanupTransfers() {
  await visitRows(db.transferSessions, async (session) => {
    if (typeof navigator !== "undefined" && navigator.locks) {
      await navigator.locks.request(
        transferLock(session.id),
        { ifAvailable: true },
        async (lock) => {
          if (lock) await clearTransfer(session.id);
        },
      );
    } else if (Date.now() - session.touched > 24 * 3600_000) {
      // Without Web Locks an old tab could still own a preview. Never discard it
      // just because a second tab starts; explicit cancellation cleans it sooner.
      await clearTransfer(session.id);
    }
  });
}

// Blob pages are stored while the snapshot transaction is alive. Only Blob
// handles, not a full JSON string or archive byte array, are gathered at finish.
export class PagedBlobWriter {
  private parts: BlobPart[] = [];
  private size = 0;
  private index = 0;
  bytes = 0;
  readonly session: string;
  constructor(session: string = uid()) {
    this.session = session;
  }
  async write(part: string | Uint8Array) {
    const blob = new Blob([part as BlobPart]);
    this.parts.push(blob);
    this.size += blob.size;
    this.bytes += blob.size;
    if (this.size >= 1024 * 1024) await this.flush();
  }
  async flush() {
    if (!this.parts.length) return;
    await db.transferChunks.add({
      session: this.session,
      index: this.index++,
      blob: new Blob(this.parts),
    });
    this.parts = [];
    this.size = 0;
  }
  async finish(type: string) {
    const parts: Blob[] = [];
    await db.transferChunks
      .where("session")
      .equals(this.session)
      .each((row) => {
        parts.push(row.blob);
      });
    return new Blob(parts, { type });
  }
}
export async function exportSnapshot<T>(
  session: string,
  control: TransferControl,
  action: (writer: PagedBlobWriter) => Promise<T>,
) {
  const writer = new PagedBlobWriter(session);
  const result = await db
    .transaction("rw", db.tables, async () => {
      control.transaction = Dexie.currentTransaction!;
      control.check();
      const result = await action(writer);
      await writer.flush();
      control.check();
      return result;
    })
    .finally(() => {
      control.transaction = undefined;
    });
  return { result, writer };
}
