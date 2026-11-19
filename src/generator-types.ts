import { z } from "zod";
import { completionDimensions } from "./role-completion-types";

const str = z.string(),
  id = str.min(1),
  ids = z.array(id),
  num = z.number().finite();
export const generatorTables = [
  "generatorSessions",
  "generatorMaterials",
  "generatorTurns",
  "generatorSteps",
  "generatorResults",
] as const;
export const targetSchema = z.object({
  id,
  name: str,
  roleKind: str.optional(),
  autoName: z.boolean().optional(),
});
export const inputSchema = z.object({
  mode: z.enum(["create", "refine", "if"]),
  freedom: z.enum(["faithful", "free"]),
  source: str,
  guidance: str,
  core: str,
  multiple: z.boolean(),
  targets: z.array(targetSchema),
  experience: z.enum(["guided", "classic"]).optional(),
  pace: z.enum(["gentle", "quick"]).optional(),
  creationKind: z.enum(["solo", "partner", "pair"]).optional(),
});
export const questionSchema = z.object({
  id,
  text: id,
  multiple: z.boolean(),
  options: z
    .array(z.object({ id, text: id, direction: str.optional() }))
    .min(2)
    .max(5),
});
export const interviewSchema = z.object({
  message: str,
  confirmed: z.array(str),
  conflicts: z.array(str),
  unknown: z.array(str),
  questions: z.array(questionSchema).max(3),
  ready: z.boolean(),
});
export const answerSchema = z.object({
  questionId: id,
  options: ids,
  text: str,
  disposition: z.enum(["answer", "delegate", "blank"]),
});
export const sectionSchema = z.object({
  title: z.enum(completionDimensions),
  content: id,
  basis: z.enum(["source", "inferred", "created", "unknown", "mixed"]),
  evidence: str,
  sourceIds: ids,
});
export const cardSchema = z.object({
  targetId: id,
  name: id,
  bio: str,
  sections: z.array(sectionSchema).length(10),
  preserved: z.array(str),
  changed: z.array(str),
  reasons: z.array(str),
});
export const worldSchema = z.object({
  title: id,
  text: id,
  type: z.enum(["world", "relationship", "rule", "fact"]),
  audience: z.enum(["all", "roles", "author"]),
  roleIds: ids,
  knownBy: ids,
});
export const worldsSchema = z.object({ worlds: z.array(worldSchema) });
// Intentionally excludes credentials even when a model profile remembers its key.
export const frozenProfileSchema = z.object({
  id,
  name: str,
  protocol: z.enum(["chat", "responses", "claude", "gemini"]),
  url: str,
  model: str,
  stream: z.boolean(),
  context: num,
  maxOutput: num,
  timeout: num,
  temperature: num.optional(),
  frequencyPenalty: num.nullable().optional(),
  outputMode: z.enum(["auto", "schema", "json", "compatible"]).optional(),
  cachePolicy: z.enum(["auto", "off"]).optional(),
  prefixReuse: z.enum(["auto", "on", "off"]).optional(),
});
export const generatorSchemas = {
  generatorSessions: z.object({
    id,
    title: str,
    revision: num.int().nonnegative(),
    version: num.int().nonnegative(),
    input: inputSchema,
    setupDraft: inputSchema.optional(),
    materialIds: ids,
    turnIds: ids,
    created: num,
    updated: num,
    legacy: z.boolean().optional(),
    draftRoleId: str.optional(),
    sourceDraft: str.optional(),
    draft: str,
    answers: z.array(answerSchema),
    selectionDraft: z
      .array(
        z.object({
          kind: z.enum(["role", "world"]),
          sourceId: id,
          purpose: z.enum([
            "target",
            "relationship",
            "style",
            "world",
            "source",
          ]),
        }),
      )
      .optional(),
    editor: z
      .object({
        resultId: id,
        collapsed: z.boolean().optional(),
        card: cardSchema.optional(),
        world: worldSchema.optional(),
      })
      .optional(),
    lease: z.object({ token: id, until: num }).optional(),
  }),
  generatorMaterials: z.object({
    id,
    sessionId: id,
    sourceId: str,
    kind: z.enum(["role", "world", "text"]),
    purpose: z.enum(["target", "relationship", "style", "world", "source"]),
    label: str,
    text: str,
    created: num,
  }),
  generatorTurns: z.object({
    id,
    sessionId: id,
    revision: num,
    created: num,
    kind: z.enum(["user", "assistant"]),
    text: str,
    answers: z.array(answerSchema),
    interview: interviewSchema.optional(),
    settingChange: z.object({ from: str, to: str }).optional(),
    draftUpdate: z.boolean().optional(),
    action: z.enum(["refresh"]).optional(),
  }),
  generatorSteps: z.object({
    id,
    sessionId: id,
    revision: num,
    batchId: id,
    ordinal: num,
    kind: z.enum(["interview", "card", "world", "legacy"]),
    targetId: str,
    targets: z.array(targetSchema),
    materialIds: ids,
    status: z.enum(["pending", "running", "complete", "failed", "interrupted"]),
    created: num,
    raw: str,
    error: str,
    system: str,
    user: str,
    profile: frozenProfileSchema.optional(),
    resultId: str.optional(),
    legacyData: str.optional(),
    promptTexts: z.record(str).optional(),
    referenceResultIds: ids.optional(),
  }),
  generatorResults: z.object({
    id,
    sessionId: id,
    revision: num,
    batchId: id,
    targetId: str,
    created: num,
    previousId: str,
    kind: z.enum(["card", "world"]),
    card: cardSchema.optional(),
    world: worldSchema.optional(),
    savedId: str,
    needsReview: z.boolean(),
  }),
};
export type GeneratorSession = z.infer<
  typeof generatorSchemas.generatorSessions
>;
export type GeneratorMaterial = z.infer<
  typeof generatorSchemas.generatorMaterials
>;
export type GeneratorTurn = z.infer<typeof generatorSchemas.generatorTurns>;
export type GeneratorStep = z.infer<typeof generatorSchemas.generatorSteps>;
export type GeneratorResult = z.infer<typeof generatorSchemas.generatorResults>;
export type GeneratorInput = z.infer<typeof inputSchema>;
export type GeneratorAnswer = z.infer<typeof answerSchema>;
export type GeneratorInterview = z.infer<typeof interviewSchema>;
export type GeneratorCard = z.infer<typeof cardSchema>;
export type GeneratorWorld = z.infer<typeof worldSchema>;
export type GeneratorSelection = {
  kind: "role" | "world";
  sourceId: string;
  purpose: GeneratorMaterial["purpose"];
};
export const newGeneratorInput = (): GeneratorInput => ({
  mode: "create",
  freedom: "faithful",
  source: "",
  guidance: "",
  core: "",
  multiple: false,
  targets: [],
});

// Old conversations retain their original question format. New guided requests
// have a strict wire contract; persisted questions stay backwards compatible.
export const guidedInterviewSchema = interviewSchema.extend({
  questions: z
    .array(
      questionSchema.extend({
        options: z.array(z.object({ id, text: id, direction: id })).length(4),
      }),
    )
    .max(3),
});

// Only the small, closed output schema vocabulary is converted for provider adapters.
export function generatorWire(schema: z.ZodTypeAny): any {
  if (schema instanceof z.ZodObject) {
    const properties = Object.fromEntries(
      Object.entries(schema.shape)
        .filter(([, v]) => !(v instanceof z.ZodOptional))
        .map(([k, v]) => [k, generatorWire(v as z.ZodTypeAny)]),
    );
    return {
      type: "object",
      properties,
      required: Object.keys(properties),
      additionalProperties: false,
    };
  }
  if (schema instanceof z.ZodArray)
    return {
      type: "array",
      items: generatorWire(schema.element),
      ...(schema._def.exactLength
        ? {
            minItems: schema._def.exactLength.value,
            maxItems: schema._def.exactLength.value,
          }
        : {}),
      ...(schema._def.minLength
        ? { minItems: schema._def.minLength.value }
        : {}),
      ...(schema._def.maxLength
        ? { maxItems: schema._def.maxLength.value }
        : {}),
    };
  if (schema instanceof z.ZodEnum)
    return { type: "string", enum: schema.options };
  if (schema instanceof z.ZodBoolean) return { type: "boolean" };
  if (schema instanceof z.ZodString) return { type: "string" };
  throw Error("Unsupported generator wire schema");
}
export const generatorOutputSchemas = {
  generatorInterview: generatorWire(interviewSchema),
  generatorIf: generatorWire(interviewSchema),
  generatorCompose: generatorWire(cardSchema),
};
