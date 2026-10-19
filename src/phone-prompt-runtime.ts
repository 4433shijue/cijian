import type { Preferences, PromptKind } from "./types";
import { defaults } from "./prompts";
import { phoneBoundary } from "./phone-prompts";
export function phoneInstruction(kind: PromptKind, prefs: Preferences) {
  const p = prefs.prompts[kind];
  return `${phoneBoundary}\n\n${p?.enabled ? p.text : defaults[kind]}`;
}
