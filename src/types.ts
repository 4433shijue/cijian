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
  direction: InspirationDirection;
  title: string;
  text: string;
}
export interface Inspiration {
  options: InspirationOption[];
  sources: SourceRef[];
  created: number;
  selectedText?: string;
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
  autoMemory: boolean;
  chatThreshold: number;
  novelThreshold: number;
  memoryCursor: number;
  memoryState: "idle" | "running" | "failed" | "interrupted";
  memoryError: string;
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
  remember: boolean;
  key?: string;
  testedAt?: number;
  testedWithoutKey?: boolean;
}
export interface Preferences {
  id: "preferences";
  activeProfile: string;
  developer: boolean;
  inspirationParagraphs?: number;
  novelContextRounds?: number;
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
}
export interface ModelUsage {
  input?: number;
  output?: number;
  cachedInput?: number;
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
  history?: { limit: number; sources: SourceRef[] };
  usage?: ModelUsage;
  durationMs?: number;
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
