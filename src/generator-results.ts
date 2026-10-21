import type {
  GeneratorResult,
  GeneratorSession,
  GeneratorStep,
} from "./generator-types";

// Titles are editable. Version ancestry, rather than a display name, identifies a world entry.
export function generatorResultGroups(results: GeneratorResult[]) {
  const byId = new Map(results.map((r) => [r.id, r]));
  const ancestry = (r: GeneratorResult) => {
    const seen = new Set<string>();
    while (r.previousId && byId.has(r.previousId) && !seen.has(r.id)) {
      seen.add(r.id);
      r = byId.get(r.previousId)!;
    }
    return { root: r.id, depth: seen.size };
  };
  const groups = new Map<string, GeneratorResult[]>();
  for (const r of [...results].sort(
    (a, b) =>
      a.created - b.created ||
      ancestry(a).depth - ancestry(b).depth ||
      a.id.localeCompare(b.id),
  )) {
    const key = r.kind === "card" ? r.targetId : "world:" + ancestry(r).root;
    groups.set(key, [...(groups.get(key) || []), r]);
  }
  return groups;
}

export function generatorStepTurnIds(
  step: GeneratorStep,
): string[] | undefined {
  try {
    const history = JSON.parse(step.user).history;
    if (
      !Array.isArray(history) ||
      history.some((t) => typeof t?.id !== "string")
    )
      return;
    return [
      ...history.map((t: { id: string }) => t.id),
      ...(step.kind === "interview" &&
      step.status === "complete" &&
      step.resultId
        ? [step.resultId]
        : []),
    ];
  } catch {
    return;
  }
}

export function generatorStepIsCurrent(
  s: GeneratorSession,
  step: GeneratorStep,
) {
  const ids = generatorStepTurnIds(step);
  return (
    s.id === step.sessionId &&
    s.revision === step.revision &&
    !!ids &&
    ids.length === s.turnIds.length &&
    ids.every((id, i) => id === s.turnIds[i])
  );
}
