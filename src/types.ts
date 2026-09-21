export type Protocol = "chat" | "responses" | "claude" | "gemini";
export type PromptKind = "novel" | "chat" | "facts" | "memory" | "inspiration";
export interface StylePreset {
  id: string;
  name: string;
  description: string;
  prompt: string;
  scope: "novel" | "chat" | "both";
  builtIn?: boolean;
}
export type InspirationDirection =
  "relationship" | "discovery" | "external" | "decision";
export interface InspirationOption {
  // Kept optional for rounds saved by versions before 1.6.
  direction?: InspirationDirection;
  title: string;
  text: string;
}
export interface Inspiration {
  options: InspirationOption[];
  sources: SourceRef[];
  created: number;
  selectedText?: string;
  contextKey?: string;
  feedback?: string;
}
export interface Paragraph {
  id: string;
  text: string;
  pin: boolean;
  public: boolean;
}
export interface Role {
  id: string;
  name: string;
  bio: string;
  persona: string;
  avatar: string;
  paragraphs: Paragraph[];
  sourceId?: string;
  updated: number;
}
export interface WorldEntry {
  id: string;
  title: string;
  text: string;
  type: "world" | "relationship" | "rule" | "fact";
  enabled: boolean;
  always: boolean;
  keywords: string[];
  roleIds: string[];
  match?: "any" | "all";
  storyIds: string[];
  knownBy: string[];
  audience: "all" | "roles" | "author";
}
export interface Story {
  id: string;
  title: string;
  background: string;
  roles: Role[];
  worldIds: string[];
  created: number;
  updated: number;
  draft: string;
  chatDraft: string;
  player: string;
  partner: string;
  length: string;
  style: string;
  stylePresetId?: string;
  psychology: boolean;
  timelineMode?: "shared" | "strict";
  autoMemory: boolean;
  chatThreshold: number;
  novelThreshold: number;
  memoryCursor: number;
  memoryState: "idle" | "running" | "failed" | "interrupted";
  memoryError: string;
  nextRound?: number;
  contextWindowStart?: number;
  memoryAutoStart?: number;
  // Transient next-reply override; excluded from backups.
  memorySelection?: { token: string; ids: string[] };
  inspiration?: Inspiration;
  inspirationRequest?: string;
  inspirationRevision?: string;
}
export interface Fact {
  id: string;
  text: string;
  quote: string;
  knownBy: string[];
}
export interface Version {
  id: string;
  text: string;
  input: string;
  created: number;
  facts: Fact[];
  deleted?: boolean;
  visibility?: "inherit" | "author" | "facts";
}
export interface SceneEvent {
  id: string;
  storyId: string;
  seq: number;
  kind: "novel" | "message";
  origin?: "user" | "ai";
  speaker: string;
  participants: string[];
  input: string;
  text: string;
  facts: Fact[];
  versions: Version[];
  versionId: string;
  status: "complete" | "draft";
  raw: string;
  error: string;
  review: boolean;
  deleted: boolean;
  created: number;
  request?: ContextReport;
  collapsed?: boolean;
  rewriteOf?: SourceRef;
  acceptedByAuthor?: boolean;
  visibility?: "inherit" | "author" | "facts";
  warnings?: string[];
  chatPending?: boolean;
  chatBatchId?: string;
  round?: number;
}
export interface ChatBatch {
  id: string;
  storyId: string;
  player: string;
  partner: string;
  sources: SourceRef[];
  messages: string[];
  replyIds: string[];
  cutoff: number;
  status: "running" | "complete" | "failed" | "interrupted";
  created: number;
  updated: number;
  raw: string;
  error: string;
  request?: ContextReport;
}
export interface SourceRef {
  id: string;
  versionId: string;
}
export interface Memory {
  id: string;
  storyId: string;
  text: string;
  knownBy: string[];
  scope: "story" | "roles";
  sources: SourceRef[];
  status: "candidate" | "accepted" | "ignored" | "invalid" | "review";
  created: number;
  automatic?: boolean;
  kind?: "round";
  rounds?: number[];
  batchRounds?: number[];
  timelineMode?: "shared" | "strict";
}
export interface Profile {
  id: string;
  name: string;
  protocol: Protocol;
  url: string;
  model: string;
  stream: boolean;
  context: number;
  maxOutput: number;
  timeout: number;
  temperature?: number;
  // Missing values use the app's maximum; null keeps the model's own default.
  frequencyPenalty?: number | null;
  outputMode?: "auto" | "schema" | "json" | "compatible";
  cachePolicy?: "auto" | "off";
  prefixReuse?: "auto" | "on" | "off";
  remember: boolean;
  key?: string;
  testedAt?: number;
  testedWithoutKey?: boolean;
}
export interface Preferences {
  id: "preferences";
  activeProfile: string;
  developer: boolean;
  dialogueCheck?: boolean;
  inspirationParagraphs?: number;
  novelContextRounds?: number;
  memoryIntervalRounds?: number;
  memoryAutoReadLimit?: number;
  stylePresets?: StylePreset[];
  prompts: Partial<Record<PromptKind, { text: string; enabled: boolean }>>;
}
export interface Job {
  id: string;
  storyId: string;
  kind: PromptKind;
  eventId: string;
  inputVersion: string;
  status: "running" | "complete" | "failed" | "interrupted";
  created: number;
  error: string;
}
export interface Material {
  id: string;
  label: string;
  text: string;
  mandatory: boolean;
  priority: number;
  stable?: boolean;
  sources?: SourceRef[];
  excerpt?: boolean;
}
export interface ModelUsage {
  input?: number;
  output?: number;
  cachedInput?: number;
  uncachedInput?: number;
  cacheWriteInput?: number;
}
export interface ContextReport {
  system: string;
  user: string;
  included: Material[];
  omitted: Material[];
  estimate: number;
  limit: number;
  stablePrefix?: string;
  task?: string;
  messages?: PromptMessage[];
  prefixReuse?: {
    state: "first" | "continued" | "settings" | "history" | "capacity" | "rewrite" | "window" | "selection";
    retainedMessages: number;
  };
  history?: { limit: number; sources: SourceRef[]; recalled?: SourceRef[]; rounds?: number[]; windowStart?: number };
  memoryContext?: { selected: string[]; gaps: number[]; selectionToken?: string; automaticLimit: number };
  materialTokens?: { settings: number; memories: number; history: number; task: number };
  taskSources?: SourceRef[];
  usage?: ModelUsage;
  durationMs?: number;
}
export interface PromptMessage {
  role: "system" | "user" | "assistant";
  content: string;
}
// Local transport history, deliberately excluded from story backups.
export interface PromptSession {
  id: string;
  storyId: string;
  config: string;
  messages: PromptMessage[];
  materials: Material[];
  covered: SourceRef[];
  events: Record<string, string>;
  memories: Record<string, string>;
  inputTokens?: number;
  windowStart?: number;
  selectedMemories?: string[];
}
export interface ModelResult {
  text: string;
  complete: boolean;
  reason: string;
  usage?: ModelUsage;
  durationMs?: number;
}
export const uid = () => crypto.randomUUID();
export const paragraphs = (
  text: string,
  previous: Paragraph[] = [],
): Paragraph[] =>
  text
    .split(/\n\s*\n/)
    .filter((x) => x.trim())
    .map(
      (text) =>
        previous.find((p) => p.text === text) || {
          id: uid(),
          text,
          pin: false,
          public: false,
        },
    );
