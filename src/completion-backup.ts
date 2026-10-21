import { uid } from "./types";
import {
  completionDimensions,
  type CompletionDraft,
} from "./role-completion-types";
import {
  generatorSchemas,
  newGeneratorInput,
  type GeneratorSession,
  type GeneratorMaterial,
  type GeneratorTurn,
  type GeneratorStep,
  type GeneratorResult,
} from "./generator-types";

// The legacy editor remains usable after its one-time migration. Export its
// current state as portable compatibility records without modifying either editor.
export function completionBackupRows(old?: CompletionDraft) {
  const rows: {
    generatorSessions: GeneratorSession[];
    generatorMaterials: GeneratorMaterial[];
    generatorTurns: GeneratorTurn[];
    generatorSteps: GeneratorStep[];
    generatorResults: GeneratorResult[];
  } = {
    generatorSessions: [],
    generatorMaterials: [],
    generatorTurns: [],
    generatorSteps: [],
    generatorResults: [],
  };
  if (!old) return rows;
  const id = uid(),
    materialId = uid();
  const targets = old.candidates
    .filter((c) => c.selected)
    .map((c) => ({ id: c.id, name: c.name }));
  for (const c of old.cards)
    if (!targets.some((t) => t.id === c.candidateId))
      targets.push({ id: c.candidateId, name: c.name });
  rows.generatorSessions.push({
    id,
    title: "旧版补全 · 最新编辑备份",
    revision: 0,
    version: 0,
    input: {
      ...newGeneratorInput(),
      mode: "refine",
      source: old.input.source,
      guidance: old.input.guidance,
      freedom: old.input.creativity === "creative" ? "free" : "faithful",
      multiple: old.input.mode === "multiple",
      targets,
    },
    materialIds: [materialId],
    turnIds: [],
    created: old.updated,
    updated: old.updated,
    legacy: true,
    draft: "",
    answers: [],
  });
  rows.generatorMaterials.push({
    id: materialId,
    sessionId: id,
    sourceId: "",
    kind: "text",
    purpose: "source",
    label: "旧补全最新原始素材",
    text: old.input.source,
    created: old.updated,
  });
  const archive = (
    data: unknown,
    raw = "",
    error = "",
    status: GeneratorStep["status"] = "complete",
  ) => {
    const step: GeneratorStep = {
      id: uid(),
      sessionId: id,
      revision: 0,
      batchId: uid(),
      ordinal: rows.generatorSteps.length,
      kind: "legacy",
      targetId: "",
      targets,
      materialIds: [materialId],
      status,
      created: old.updated,
      raw,
      error,
      system: "",
      user: "",
      legacyData: JSON.stringify(data),
    };
    rows.generatorSteps.push(step);
    return step;
  };
  // Keep per-card/per-attempt records instead of one unbounded legacy blob.
  archive({
    input: old.input,
    candidates: old.candidates,
    sourceKey: old.sourceKey,
    error: old.error,
  });
  for (const c of old.cards) {
    const step = archive({ card: c });
    const r: GeneratorResult = {
      id: uid(),
      sessionId: id,
      revision: 0,
      batchId: step.batchId,
      targetId: c.candidateId,
      created: old.updated,
      previousId: "",
      kind: "card",
      savedId: c.savedRoleId || "",
      needsReview: false,
      card: {
        targetId: c.candidateId,
        name: c.name,
        bio: c.bio,
        sections: c.sections.map((s) => ({
          ...s,
          title: s.title as (typeof completionDimensions)[number],
          sourceIds: s.evidence ? [materialId] : [],
        })),
        preserved: [],
        changed: [],
        reasons: ["从旧版入口的最新编辑备份恢复，原资料未修改。"],
      },
    };
    rows.generatorResults.push(r);
    step.resultId = r.id;
  }
  for (const a of old.attempts || [])
    archive(
      { attempt: a, input: old.input, candidates: old.candidates },
      a.raw,
      a.error,
      ["parsed", "recovered"].includes(a.state) ? "complete" : "interrupted",
    );
  if (old.raw && !old.attempts?.some((a) => a.raw === old.raw))
    archive(
      { input: old.input, candidates: old.candidates },
      old.raw,
      old.error,
      "interrupted",
    );
  for (const [table, records] of Object.entries(rows))
    for (const record of records) {
      generatorSchemas[table as keyof typeof generatorSchemas].parse(record);
      if (
        new TextEncoder().encode(JSON.stringify(record)).length >
        10 * 1024 * 1024
      )
        throw Error(
          "旧版补全的单条恢复资料超过 10 MiB，请减少素材或拆分后再备份；原稿仍保留。",
        );
    }
  return rows;
}
