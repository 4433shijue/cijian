export const backupTables = [
  "roles",
  "stories",
  "world",
  "events",
  "memories",
  "profiles",
  "preferences",
  "chatBatches",
  "roleDrafts",
] as const;
export type BackupTable = (typeof backupTables)[number];
export type Counts = Record<BackupTable, number>;
export const emptyCounts = (): Counts =>
  Object.fromEntries(backupTables.map((t) => [t, 0])) as Counts;
export interface TransferProgress {
  phase: "reading" | "checking" | "importing" | "exporting" | "packing";
  bytes: number;
  totalBytes: number;
  records: number;
  totalRecords?: number;
}
export interface ImportSummary {
  session: string;
  created: string;
  scope: "library" | "story";
  title?: string;
  counts: Counts;
  bytes: number;
}
export interface TransferRecord {
  session: string;
  table: BackupTable;
  id: string;
  order: number;
  value: any;
}
export interface TransferSession {
  id: string;
  touched: number;
  summary?: ImportSummary;
}
export interface TransferChunk {
  session: string;
  index: number;
  blob: Blob;
}
export interface ImportOptions {
  replace: boolean;
  applySettings: boolean;
}
export type WorkFormat = "txt" | "md" | "docx" | "epub" | "print";
export interface WorkOptions {
  storyId: string;
  content: "novel" | "all" | "chat";
  range: "all" | "selection";
  from: number;
  to: number;
  background: boolean;
  characters: boolean;
  format: WorkFormat;
  fontSize: number;
  lineHeight: number;
  pageBreak: boolean;
}
export type TransferCommand =
  | { type: "read"; file: File; session: string }
  | { type: "commit"; options: ImportOptions }
  | { type: "backup"; session: string; storyId?: string }
  | { type: "work"; session: string; options: WorkOptions }
  | { type: "cancel" };
export type TransferReply =
  | { type: "progress"; progress: TransferProgress }
  | { type: "preview"; summary: ImportSummary }
  | { type: "complete"; blob?: Blob; filename?: string }
  | { type: "cancelled" }
  | { type: "error"; message: string };
