export type CompletionMode = "single" | "multiple";
export type CompletionCreativity = "faithful" | "balanced" | "creative";
export interface CompletionInput {
  source: string;
  mode: CompletionMode;
  targets: string;
  guidance: string;
  creativity: CompletionCreativity;
}
export interface CompletionCandidate {
  id: string;
  name: string;
  description: string;
  selected: boolean;
}
export type CompletionBasis =
  "source" | "inferred" | "created" | "unknown" | "mixed";
export interface CompletionSection {
  title: string;
  content: string;
  basis: CompletionBasis;
  evidence: string;
  edited?: boolean;
}
export interface CompletionCard {
  id: string;
  sourceKey?: string;
  candidateId: string;
  name: string;
  bio: string;
  sections: CompletionSection[];
  selected: boolean;
  savedRoleId?: string;
}
export interface CompletionDraft {
  id: "role-completion";
  input: CompletionInput;
  candidates: CompletionCandidate[];
  cards: CompletionCard[];
  sourceKey: string;
  raw: string;
  error: string;
  updated: number;
}
export const completionDimensions = [
  "基础身份",
  "外貌与表现",
  "成长与经历",
  "性格层次",
  "欲望与底线",
  "能力与生活",
  "说话与互动",
  "人际关系",
  "秘密与知情范围",
  "当前状态",
] as const;
export const completionBasisLabels: Record<CompletionBasis, string> = {
  source: "原文已有",
  inferred: "根据素材推测",
  created: "AI 新增",
  unknown: "尚待补充",
  mixed: "原文与补充",
};
export function emptyCompletionDraft(): CompletionDraft {
  return {
    id: "role-completion",
    input: {
      source: "",
      mode: "single",
      targets: "",
      guidance: "",
      creativity: "balanced",
    },
    candidates: [],
    cards: [],
    sourceKey: "",
    raw: "",
    error: "",
    updated: Date.now(),
  };
}
export const completionSourceKey = (input: CompletionInput) =>
  JSON.stringify(input);
