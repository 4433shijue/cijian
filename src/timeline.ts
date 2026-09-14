import type { SceneEvent, Story } from "./types";

export const sharedTimeline = (s: Story) => s.timelineMode === "shared";

// Review flags are advisory in the shared timeline. Current saved text wins.
export const usableEvent = (e: SceneEvent, s: Story) =>
  !e.deleted && e.status === "complete" && (!e.review || sharedTimeline(s));

export function fullAudience(e: SceneEvent, s: Story): string[] {
  if (e.kind === "message") return e.participants;
  if (sharedTimeline(s) && (!e.visibility || e.visibility === "inherit"))
    return s.roles.map((r) => r.id);
  return [];
}

export function visibleText(e: SceneEvent, viewer?: string, s?: Story) {
  if (e.deleted || e.status !== "complete") return "";
  if (!viewer) return e.text;
  if (e.kind === "message")
    return e.participants.includes(viewer) ? e.text : "";
  if (e.visibility === "author") return "";
  if (s && fullAudience(e, s).includes(viewer)) return e.text;
  return e.facts.filter((f) => f.knownBy.includes(viewer))
    .map((f) => f.text).join("\n");
}

// Local excerpts keep old history available even when a provider is offline.
// They are deliberately labelled as excerpts, not AI-inferred facts.
export function historyExcerpt(text: string, max = 320) {
  const cleaned = text.trim();
  if (cleaned.length <= max) return cleaned;
  const head = cleaned.slice(0, Math.floor(max * 0.65));
  const tail = cleaned.slice(-Math.floor(max * 0.35));
  return head + "\n……（中间省略）……\n" + tail;
}

function terms(text: string) {
  const result = new Set<string>();
  for (const word of text.toLowerCase().match(/[a-z0-9_]{2,}|[\u3400-\u9fff]+/g) || []) {
    if (/^[a-z0-9_]+$/.test(word)) result.add(word);
    else for (const size of [2, 3, 4])
      for (let i = 0; i <= word.length - size; i++) result.add(word.slice(i, i + size));
  }
  return result;
}

export function relevance(query: string, documents: string[]) {
  const wanted = terms(query);
  const indexed = documents.map(terms);
  const frequency = new Map<string, number>();
  for (const set of indexed) for (const term of set)
    frequency.set(term, (frequency.get(term) || 0) + 1);
  return indexed.map((set) => {
    let score = 0;
    for (const term of wanted) {
      const count = frequency.get(term) || 0;
      if (!set.has(term) || (documents.length >= 5 && count > documents.length * 0.4)) continue;
      score += (term.length >= 3 ? 2 : 1) / Math.max(1, count);
    }
    return score;
  });
}
