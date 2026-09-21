import { fullAudience, usableEvent, visibleText } from "./timeline";
import type { Memory, Preferences, SceneEvent, Story } from "./types";

export const HISTORY_LIMIT = 20;
export const WINDOW_STEP = 5;
export const memoryInterval = (p: Preferences) =>
  positive(p.memoryIntervalRounds, 5);
export const memoryReadLimit = (p: Preferences) =>
  positive(p.memoryAutoReadLimit, 8, true);
const positive = (n: number | undefined, fallback: number, zero = false) =>
  Number.isSafeInteger(n) && n! >= (zero ? 0 : 1) ? n! : fallback;
export interface StoryRound {
  number: number;
  events: SceneEvent[];
}

// One accepted prose result or complete chat response group is one round.
// Deleted events retain their number; pending input and unadopted drafts get none.
export function numberedRounds(events: SceneEvent[]): StoryRound[] {
  const ordered = [...events].sort(
    (a, b) => a.seq - b.seq || a.id.localeCompare(b.id),
  );
  const groups: SceneEvent[][] = [];
  const used = new Set<string>();
  for (let i = 0; i < ordered.length; i++) {
    const e = ordered[i];
    if (
      used.has(e.id) ||
      e.status !== "complete" ||
      e.chatPending ||
      e.rewriteOf
    )
      continue;
    let group: SceneEvent[];
    if (e.kind === "novel") group = [e];
    else if (e.chatBatchId) {
      group = ordered.filter(
        (x) =>
          x.chatBatchId === e.chatBatchId &&
          x.status === "complete" &&
          !x.chatPending,
      );
      if (!group.some((x) => x.origin !== "user")) continue;
    } else if (e.round !== undefined)
      group = ordered.filter(
        (x) => x.round === e.round && x.status === "complete" && !x.chatPending,
      );
    else {
      if (e.origin === "user") continue;
      group = [e];
      // Old imports stored only the first reply's request. Never merge distinct requests.
      for (let j = i + 1; j < ordered.length; j++) {
        const x = ordered[j];
        if (
          x.kind !== "message" ||
          x.origin === "user" ||
          x.chatBatchId ||
          x.round !== undefined ||
          x.request ||
          x.input !== e.input ||
          x.speaker !== e.speaker ||
          x.status !== "complete"
        )
          break;
        group.push(x);
      }
      const before = ordered[i - 1];
      if (
        before?.kind === "message" &&
        before.origin === "user" &&
        !before.chatPending &&
        !used.has(before.id) &&
        before.text === e.input &&
        before.participants.includes(e.speaker)
      )
        group.unshift(before);
    }
    group.forEach((x) => used.add(x.id));
    groups.push(group);
  }
  let next = Math.max(0, ...events.map((e) => e.round || 0));
  return groups
    .map((group) => {
      const number = group.find((e) => e.round !== undefined)?.round ?? ++next;
      return {
        number,
        events: group.map((e) =>
          e.round === number ? e : { ...e, round: number },
        ),
      };
    })
    .sort((a, b) => a.number - b.number);
}

export function roundWindow(s: Story, events: SceneEvent[], rewrite = false) {
  const rounds = numberedRounds(events);
  let start = rewrite ? 0 : s.contextWindowStart || 0;
  let selected = rounds.filter(
    (r) => r.number >= start && r.events.some((e) => usableEvent(e, s)),
  );
  while (selected.length > HISTORY_LIMIT) {
    start = selected[WINDOW_STEP - 1].number + 1;
    selected = selected.slice(WINDOW_STEP);
  }
  return { rounds, selected, start };
}

export function roundLabel(numbers: number[]) {
  const values = [...new Set(numbers)].sort((a, b) => a - b);
  const ranges: string[] = [];
  for (let i = 0; i < values.length; i++) {
    const first = values[i];
    let last = first;
    while (values[i + 1] === last + 1) last = values[++i];
    ranges.push(first === last ? String(first) : `${first}～${last}`);
  }
  return values.length ? `第${ranges.join("、")}回` : "无回合";
}

export function memoryValid(
  m: Memory,
  s: Story,
  events: SceneEvent[],
  viewer?: string,
) {
  const byId = new Map(events.map((e) => [e.id, e]));
  return (
    m.storyId === s.id &&
    !m.automatic &&
    m.status === "accepted" &&
    (!viewer || m.knownBy.includes(viewer)) &&
    (!m.timelineMode || m.timelineMode === (s.timelineMode || "strict")) &&
    m.sources.every((ref) => {
      const e = byId.get(ref.id);
      return (
        !!e &&
        usableEvent(e, s) &&
        !e.chatPending &&
        e.versionId === ref.versionId &&
        (!viewer || fullAudience(e, s).includes(viewer))
      );
    })
  );
}

export function selectRoundContext(
  s: Story,
  events: SceneEvent[],
  memories: Memory[],
  prefs: Preferences,
  viewer?: string,
  rewrite = false,
  useOverride = true,
) {
  const window = roundWindow(
    s,
    events.filter((e) => e.storyId === s.id),
    rewrite,
  );
  const allEvents = window.rounds.flatMap((r) => r.events);
  const byId = new Map(allEvents.map((e) => [e.id, e]));
  const history = window.selected
    .flatMap((r) => r.events)
    .filter((e) => usableEvent(e, s) && visibleText(e, viewer, s))
    .sort(
      (a, b) =>
        a.round! - b.round! || a.seq - b.seq || a.id.localeCompare(b.id),
    );
  const first = window.selected[0]?.number ?? Infinity;
  const end = (m: Memory) =>
    Math.max(0, ...m.sources.map((ref) => byId.get(ref.id)?.round || 0));
  const eligible = memories
    .filter((m) => memoryValid(m, s, allEvents, viewer))
    .sort(
      (a, b) =>
        end(a) - end(b) || a.created - b.created || a.id.localeCompare(b.id),
    );
  const limit = memoryReadLimit(prefs);
  const defaults = eligible.filter((m) =>
    m.sources.some((ref) => (byId.get(ref.id)?.round ?? Infinity) < first),
  );
  const override = useOverride ? s.memorySelection : undefined;
  const selected = override
    ? eligible.filter((m) => override.ids.includes(m.id))
    : limit
      ? defaults.slice(-limit)
      : [];
  const covered = new Set(
    selected.flatMap((m) => m.sources.map((ref) => ref.id)),
  );
  const gaps = window.rounds
    .filter(
      (r) =>
        r.number < first &&
        r.events.some(
          (e) =>
            usableEvent(e, s) &&
            visibleText(e, viewer, s) &&
            !covered.has(e.id),
        ),
    )
    .map((r) => r.number);
  return {
    ...window,
    history,
    eligible,
    selected,
    gaps,
    limit,
    selectionToken: override?.token,
    byId,
  };
}
