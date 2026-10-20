import { db, keyFor, saveProfile } from "./db";
import { uid, paragraphs, type Profile, type Preferences } from "./types";
import { assemble } from "./context";
import { generate } from "./model";
import { samplingParameters } from "./sampling";
import { prompt } from "./prompts";
import { parseCompletionJSON } from "./role-json";
import { completionDimensions } from "./role-completion-types";
import {
  completionFinishError,
  parseCompletionCard,
  parseCompletionCandidates,
} from "./role-completion";

import {
  generatorTables,
  generatorSchemas,
  generatorWire,
  frozenProfileSchema,
  inputSchema,
  interviewSchema,
  cardSchema,
  worldsSchema,
  newGeneratorInput,
  type GeneratorInput,
  type GeneratorSelection,
  type GeneratorSession,
  type GeneratorMaterial,
  type GeneratorTurn,
  type GeneratorAnswer,
  type GeneratorStep,
  type GeneratorResult,
} from "./generator-types";

const MAX_RECORD = 10 * 1024 * 1024;
const active = new Map<string, AbortController>();
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
function bounded<T>(value: T): T {
  if (new TextEncoder().encode(JSON.stringify(value)).length > MAX_RECORD)
    throw Error(
      "这条生成资料超过 10 MiB，请减少素材或拆分会话；编辑内容仍保留。",
    );
  return value;
}
function idle(s: GeneratorSession) {
  if (s.lease && s.lease.until > Date.now())
    throw Error("这个会话正在生成，请先停止；其他标签页也不能重复执行。");
}
async function session(id: string) {
  const s = await db.generatorSessions.get(id);
  if (!s) throw Error("生成会话已不存在");
  return s;
}
export async function createGenerator(source = "") {
  const s: GeneratorSession = {
    id: uid(),
    title: "新的角色访谈",
    revision: 0,
    version: 0,
    input: { ...newGeneratorInput(), source },
    materialIds: [],
    turnIds: [],
    created: Date.now(),
    updated: Date.now(),
    draft: "",
    answers: [],
  };
  await db.generatorSessions.add(bounded(s));
  return s;
}
export async function saveGeneratorDraft(value: GeneratorSession) {
  return db.transaction("rw", db.generatorSessions, async () => {
    const s = await session(value.id);
    idle(s);
    if (s.version !== value.version)
      throw Error("会话已在其他窗口修改，请重新打开后继续。当前输入未被覆盖。");
    const next = bounded({
      ...s,
      title: value.title,
      draft: value.draft,
      answers: value.answers,
      selectionDraft: value.selectionDraft,
      setupDraft: value.setupDraft,
      editor: value.editor,
      input: s.turnIds.length ? s.input : inputSchema.parse(value.input),
      version: s.version + 1,
      updated: Date.now(),
    });
    await db.generatorSessions.put(next);
    return next;
  });
}
export async function configureGenerator(
  id: string,
  input: GeneratorInput,
  selections: GeneratorSelection[],
) {
  input = inputSchema.parse(input);
  if (
    input.targets.some((t) => !t.name.trim()) ||
    !input.targets.length ||
    (!input.multiple && input.targets.length !== 1)
  )
    throw Error("请确认本次生成的目标名单；单人模式只能选择一位。");
  if (
    new Set(input.targets.map((t) => t.id)).size !== input.targets.length ||
    new Set(input.targets.map((t) => t.name.trim())).size !==
      input.targets.length
  )
    throw Error("目标人物的编号和姓名不能重复，请用称呼区分同名人物。");
  if (!input.source.trim() && !input.guidance.trim() && !selections.length)
    throw Error("请填写创作需求或选择参考资料。");
  return db.transaction(
    "rw",
    db.generatorSessions,
    db.generatorMaterials,
    db.generatorResults,
    db.roles,
    db.world,
    async () => {
      const s = await session(id);
      idle(s);
      const materials: GeneratorMaterial[] = [];
      for (const x of selections) {
        if (
          materials.some((m) => m.sourceId === x.sourceId && m.kind === x.kind)
        )
          throw Error("参考资料重复");
        const row =
          x.kind === "role"
            ? await db.roles.get(x.sourceId)
            : await db.world.get(x.sourceId);
        if (!row)
          throw Error("选中的资料已删除，请重新选择。已有会话仍保留原快照。");
        // Embedded IDs are provenance only; no transitive database reads.
        const text = JSON.stringify(row);
        materials.push(
          bounded({
            id: uid(),
            sessionId: id,
            sourceId: row.id,
            kind: x.kind,
            purpose: x.kind === "world" ? "world" : x.purpose,
            label: "name" in row ? row.name : row.title,
            text,
            created: Date.now(),
          }),
        );
      }
      await db.generatorMaterials.bulkAdd(materials);
      if (s.turnIds.length)
        await db.generatorResults
          .where("sessionId")
          .equals(id)
          .modify({ needsReview: true });
      // A material revision starts a fresh active branch. All previous turns remain in history.
      const next = bounded({
        ...s,
        input,
        materialIds: materials.map((m) => m.id),
        selectionDraft: selections,
        setupDraft: undefined,
        revision: s.revision + 1,
        turnIds: [],
        draft: "",
        answers: [],
        version: s.version + 1,
        title:
          input.targets.map((t) => t.name).join("、") +
          (input.mode === "if" ? " · IF" : " · 角色访谈"),
        updated: Date.now(),
      });
      await db.generatorSessions.put(next);
      return next;
    },
  );
}
export async function generatorData(id: string) {
  const s = await session(id);
  const [materials, turns, steps, results] = await Promise.all([
    db.generatorMaterials.where("sessionId").equals(id).toArray(),
    db.generatorTurns.where("sessionId").equals(id).toArray(),
    db.generatorSteps.where("sessionId").equals(id).toArray(),
    db.generatorResults.where("sessionId").equals(id).toArray(),
  ]);
  return { session: s, materials, turns, steps, results };
}
export async function deleteGenerator(id: string) {
  await db.transaction(
    "rw",
    generatorTables.map((t) => db.table(t)),
    async () => {
      idle(await session(id));
      for (const t of generatorTables.filter((t) => t !== "generatorSessions"))
        await db.table(t).where("sessionId").equals(id).delete();
      await db.generatorSessions.delete(id);
    },
  );
}
export async function reviseGenerator(id: string, beforeTurnId: string) {
  return db.transaction(
    "rw",
    db.generatorSessions,
    db.generatorTurns,
    db.generatorResults,
    async () => {
      const s = await session(id);
      idle(s);
      const at = s.turnIds.indexOf(beforeTurnId);
      const turn = await db.generatorTurns.get(beforeTurnId);
      if (at < 0 || turn?.kind !== "user")
        throw Error("只能从当前分支的用户回答开始修改");
      await db.generatorResults
        .where("sessionId")
        .equals(id)
        .modify({ needsReview: true });
      const next = {
        ...s,
        revision: s.revision + 1,
        version: s.version + 1,
        turnIds: s.turnIds.slice(0, at),
        draft: turn.text,
        answers: turn.answers,
        updated: Date.now(),
      };
      await db.generatorSessions.put(next);
      return next;
    },
  );
}
export async function editGeneratorResult(
  id: string,
  changes: Partial<Pick<GeneratorResult, "card" | "world">>,
) {
  return db.transaction(
    "rw",
    db.generatorSessions,
    db.generatorResults,
    async () => {
      const r = await db.generatorResults.get(id);
      if (!r) throw Error("结果已不存在");
      const s = await session(r.sessionId);
      idle(s);
      const next = generatorSchemas.generatorResults.parse({
        ...r,
        ...changes,
        id: uid(),
        previousId: r.id,
        savedId: "",
        created: Date.now(),
      });
      validateResult(
        next,
        s.input.targets.map((t) => t.id),
      );
      await db.generatorResults.add(bounded(next));
      return next;
    },
  );
}
function validateResult(r: GeneratorResult, targets: string[]) {
  if (r.kind === "card") {
    const c = cardSchema.parse(r.card);
    if (
      r.targetId !== c.targetId ||
      !targets.includes(c.targetId) ||
      new Set(c.sections.map((s) => s.title)).size !== 10
    )
      throw Error("角色目标或十个维度不完整");
  } else {
    const w = r.world!;
    if (!w || [...w.roleIds, ...w.knownBy].some((id) => !targets.includes(id)))
      throw Error("新世界书只能关联本次目标人物");
    if (w.audience === "roles" && !w.knownBy.length)
      throw Error("请选择世界书的知情角色，或改为仅作者可见");
    if (w.audience !== "roles" && w.knownBy.length)
      throw Error("仅指定角色可知的世界书可以填写知情角色");
  }
}
export async function saveGeneratorResults(
  sessionId: string,
  resultIds: string[],
) {
  return db.transaction(
    "rw",
    db.generatorSessions,
    db.generatorResults,
    db.roles,
    db.world,
    async () => {
      const s = await session(sessionId);
      idle(s);
      const selected = await db.generatorResults.bulkGet([
        ...new Set(resultIds),
      ]);
      if (
        !selected.length ||
        selected.some(
          (r) =>
            !r ||
            r.sessionId !== sessionId ||
            r.revision !== s.revision ||
            r.needsReview,
        )
      )
        throw Error("请选择当前修订已复核的结果");
      const rows = selected as GeneratorResult[];
      rows.forEach((r) =>
        validateResult(
          r,
          s.input.targets.map((t) => t.id),
        ),
      );
      if (
        new Set(rows.filter((r) => r.kind === "card").map((r) => r.targetId))
          .size !== rows.filter((r) => r.kind === "card").length
      )
        throw Error("同一人物只能同时保存一个版本");
      const mapping = new Map<string, string>();
      // Explicitly selected cards define the world links; never silently link a reference character.
      for (const r of rows.filter((r) => r.kind === "card")) {
        let saved = r.savedId && (await db.roles.get(r.savedId));
        if (!saved) {
          const c = r.card!;
          const persona = c.sections
            .map((s) => s.title + "\n" + s.content)
            .join("\n\n");
          saved = {
            id: uid(),
            name: c.name,
            bio: c.bio,
            persona,
            avatar: "",
            paragraphs: paragraphs(persona).map((p) => ({
              ...p,
              public: false,
            })),
            updated: Date.now(),
          };
          await db.roles.add(saved);
          await db.generatorResults.update(r.id, { savedId: saved.id });
        }
        mapping.set(r.targetId, saved.id);
      }
      for (const r of rows.filter((r) => r.kind === "world")) {
        if (r.savedId && (await db.world.get(r.savedId))) continue;
        const w = r.world!;
        if ([...w.roleIds, ...w.knownBy].some((id) => !mapping.has(id)))
          throw Error("请同时勾选世界书所关联的人物卡，或先修改关联。");
        const next = {
          ...w,
          id: uid(),
          roleIds: w.roleIds.map((id) => mapping.get(id)!),
          knownBy: w.knownBy.map((id) => mapping.get(id)!),
          storyIds: [],
          enabled: true,
          always: true,
          keywords: [],
        };
        await db.world.add(next);
        await db.generatorResults.update(r.id, { savedId: next.id });
      }
    },
  );
}
export async function saveGeneratorConnection(
  mode: "inherit" | "dedicated",
  profile?: Profile,
  key = "",
) {
  const prefs = await db.preferences.get("preferences");
  if (!prefs) throw Error("请先完成应用初始化");
  let id = prefs.generatorProfileId;
  if (mode === "dedicated") {
    if (!profile) throw Error("请填写专用接口");
    samplingParameters(profile);
    if (
      !profile.url.trim() ||
      !profile.model.trim() ||
      ![profile.context, profile.maxOutput, profile.timeout].every(
        (n) => Number.isFinite(n) && n > 0,
      )
    )
      throw Error("请填写有效地址、模型、容量和超时设置");
    // A dedicated copy never edits the application's active profile.
    if (!id || id === prefs.activeProfile) id = uid();
    await saveProfile({ ...profile, id, name: "角色生成器专用接口" }, key);
  }
  await db.preferences.update("preferences", {
    generatorConnection: mode,
    generatorProfileId: id,
  });
}
async function connection() {
  const prefs = await db.preferences.get("preferences");
  const id =
    prefs?.generatorConnection === "dedicated"
      ? prefs.generatorProfileId
      : prefs?.activeProfile;
  const p = id ? await db.profiles.get(id) : undefined;
  if (!prefs || !p) throw Error("请在生成器的接口设置中配置可用连接");
  return { prefs, profile: frozenProfileSchema.parse(p) };
}
function wire(kind: GeneratorStep["kind"]) {
  const schema =
    kind === "interview"
      ? interviewSchema
      : kind === "card"
        ? cardSchema
        : worldsSchema;
  return generatorWire(schema) as Record<string, unknown>;
}
const cardRules = `角色输出 targetId、name、bio、sections（以下十个维度恰好各一次：${completionDimensions.join("、")}）、preserved、changed、reasons。sections 每项有 title、content、basis、evidence、sourceIds。source/mixed 必须提供逐字连续的 evidence 和材料或问答 sourceIds；其余可为空。不得改目标 ID 或姓名。作者输入可引用 sourceIds=["input"]；其他引用使用 materials 或 history 里的 id。`;
async function makeSteps(
  s: GeneratorSession,
  kind: "interview" | "compose",
  batchId: string = uid(),
  frozen?: Awaited<ReturnType<typeof connection>>,
) {
  const { prefs, profile } = frozen || (await connection());
  const materials = (await db.generatorMaterials.bulkGet(s.materialIds)).filter(
    (m): m is GeneratorMaterial => !!m,
  );
  if (materials.length !== s.materialIds.length)
    throw Error("参考快照缺失，请重新选择资料");
  const history = (await db.generatorTurns.bulkGet(s.turnIds)).filter(Boolean);
  const existing = (
    await db.generatorResults.where("sessionId").equals(s.id).toArray()
  ).filter((r) => r.revision === s.revision && !r.needsReview);
  const latest = [
    ...new Map(
      existing
        .sort((a, b) => a.created - b.created)
        .map((r) => [
          r.kind === "card" ? r.targetId : "world:" + r.world?.title,
          r,
        ]),
    ).values(),
  ];
  // Manual renaming changes the next request's display name, never its stable target ID.
  const input = {
    ...s.input,
    targets: s.input.targets.map((t) => ({
      ...t,
      name:
        latest.find((r) => r.kind === "card" && r.targetId === t.id)?.card
          ?.name || t.name,
    })),
  };
  if (
    new Set(input.targets.map((t) => t.name.trim())).size !==
    input.targets.length
  )
    throw Error("手动编辑后的目标姓名重复，请用称呼区分人物后继续。");
  const plan: { kind: GeneratorStep["kind"]; targetId: string }[] =
    kind === "interview"
      ? [{ kind: "interview", targetId: "" }]
      : [
          ...s.input.targets.map((t) => ({
            kind: "card" as const,
            targetId: t.id,
          })),
          { kind: "world", targetId: "" },
        ];
  const output = [];
  for (const [ordinal, task] of plan.entries()) {
    const system =
      prompt(
        task.kind === "interview" ? "generatorInterview" : "generatorCompose",
        prefs,
      ) +
      (s.input.mode === "if" ? "\n" + prompt("generatorIf", prefs) : "") +
      "\n" +
      (task.kind === "interview"
        ? "输出 message、confirmed、conflicts、unknown、questions、ready。问题和选项各有唯一 id；选项文本用 text，问题用 text 和 multiple。ready=true 时 questions 必须为空。"
        : task.kind === "card"
          ? cardRules
          : "只生成本次需要的新世界书，使用 worlds 数组，可为空。每项 title、text、type、audience、roleIds、knownBy。角色关联只可用目标名单 ID；公开范围不确定设 author，knownBy 为空。") +
      "\n返回符合以下结构的完整 JSON：" +
      JSON.stringify(wire(task.kind));
    const user = JSON.stringify({
      task: task.kind,
      input,
      targetId: task.targetId,
      materials: materials.map((m) => ({
        id: m.id,
        label: m.label,
        purpose: m.purpose,
        text: m.text,
      })),
      history,
      existingResults: latest.map((r) => ({ card: r.card, world: r.world })),
      instruction:
        task.kind === "interview"
          ? "继续访谈，或在足够时声明 ready。"
          : "作者要求现在成稿。缺少细节可以标为待补充；不要为填满捏造事实。",
    });
    assemble(
      system,
      "角色创作",
      [
        {
          id: "generator",
          label: "完整创作材料",
          text: user,
          mandatory: true,
          priority: 0,
        },
      ],
      profile.context,
      profile.maxOutput,
    );
    output.push(
      bounded({
        id: uid(),
        sessionId: s.id,
        revision: s.revision,
        batchId,
        ordinal,
        ...task,
        targets: input.targets,
        materialIds: s.materialIds,
        status: "pending" as const,
        created: Date.now(),
        raw: "",
        error: "",
        system,
        user,
        profile,
        promptTexts: Object.fromEntries(
          (
            ["generatorInterview", "generatorIf", "generatorCompose"] as const
          ).map((k) => [k, prompt(k, prefs)]),
        ),
      }),
    );
  }
  return output;
}
async function acquire(id: string, controller: AbortController) {
  if (active.has(id)) throw Error("这个会话已经在生成");
  const token = uid();
  await db.transaction("rw", db.generatorSessions, async () => {
    const s = await session(id);
    idle(s);
    await db.generatorSessions.update(id, {
      lease: { token, until: Date.now() + 45000 },
    });
  });
  active.set(id, controller);
  return token;
}
async function checkRun(
  id: string,
  token: string,
  revision: number,
  signal: AbortSignal,
) {
  const s = await session(id);
  if (signal.aborted || s.lease?.token !== token || s.revision !== revision)
    throw Error("生成已停止或资料已变化，迟到输出不会写入结果");
  return s;
}
export function stopGenerator(id: string) {
  active.get(id)?.abort();
}
async function withRun(
  id: string,
  work: (token: string, signal: AbortSignal) => Promise<void>,
) {
  const controller = new AbortController(),
    token = await acquire(id, controller);
  const heartbeat = setInterval(() => {
    void db
      .transaction("rw", db.generatorSessions, async () => {
        const s = await session(id);
        if (s.lease?.token !== token) controller.abort();
        else
          await db.generatorSessions.update(id, {
            lease: { token, until: Date.now() + 45000 },
          });
      })
      .catch(() => controller.abort());
  }, 15000);
  try {
    await work(token, controller.signal);
  } finally {
    clearInterval(heartbeat);
    active.delete(id);
    await db.transaction("rw", db.generatorSessions, async () => {
      const s = await db.generatorSessions.get(id);
      if (s?.lease?.token === token)
        await db.generatorSessions.update(id, { lease: undefined });
    });
  }
}
function evidenceTexts(value: unknown): string[] {
  if (typeof value === "string") {
    try {
      return [value, ...evidenceTexts(JSON.parse(value))];
    } catch {
      return [value];
    }
  }
  if (Array.isArray(value)) return value.flatMap(evidenceTexts);
  if (value && typeof value === "object")
    return Object.values(value).flatMap(evidenceTexts);
  return [];
}
function readJSON(raw: string) {
  return parseCompletionJSON(raw).value;
}
function validateInterview(value: unknown) {
  const v = interviewSchema.parse(value);
  if (
    new Set(v.questions.map((q) => q.id)).size !== v.questions.length ||
    v.questions.some(
      (q) => new Set(q.options.map((o) => o.id)).size !== q.options.length,
    )
  )
    throw Error("问题或选项 ID 重复，原始回复已保留");
  if (
    (v.ready && (v.questions.length || v.conflicts.length)) ||
    (!v.ready && !v.questions.length)
  )
    throw Error("访谈状态与问题不一致，原始回复已保留");
  return v;
}
async function executeStep(
  step: GeneratorStep,
  token: string,
  signal: AbortSignal,
  onRaw?: (raw: string) => void,
) {
  if (step.status === "complete") return;
  if (step.kind === "legacy")
    throw Error("旧请求保存在兼容恢复入口；可重新解析或建立新访谈。");
  await checkRun(step.sessionId, token, step.revision, signal);
  if (!step.profile) throw Error("这一步缺少接口快照，请使用当前设置重新生成");
  const profiles = await db.profiles.toArray();
  const live =
    profiles.find(
      (p) =>
        p.id === step.profile!.id &&
        p.url === step.profile!.url &&
        p.protocol === step.profile!.protocol,
    ) ||
    profiles.find(
      (p) =>
        p.url === step.profile!.url &&
        p.protocol === step.profile!.protocol &&
        p.model === step.profile!.model,
    );
  const profile: Profile = { ...step.profile, remember: false };
  let raw = "",
    lastSaved = 0,
    writes = Promise.resolve<unknown>(undefined);
  try {
    if (step.status === "pending" && step.kind !== "interview") {
      const preceding = (
        await db.generatorResults
          .where("batchId")
          .equals(step.batchId)
          .toArray()
      ).filter((r) => r.kind === "card" && !r.previousId);
      step.user = JSON.stringify({
        ...JSON.parse(step.user),
        completedCards: preceding.map((r) => r.card),
      });
    }
    assemble(
      step.system,
      "角色创作",
      [
        {
          id: "generator",
          label: "完整创作材料",
          text: step.user,
          mandatory: true,
          priority: 0,
        },
      ],
      profile.context,
      profile.maxOutput,
    );
    await db.transaction(
      "rw",
      db.generatorSessions,
      db.generatorSteps,
      async () => {
        await checkRun(step.sessionId, token, step.revision, signal);
        await db.generatorSteps.update(
          step.id,
          bounded({ status: "running", error: "", raw: "", user: step.user }),
        );
      },
    );
    const result = await generate(
      profile,
      live ? keyFor(live) : "",
      step.system,
      step.user,
      signal,
      (value) => {
        raw = value;
        onRaw?.(raw);
        if (Date.now() - lastSaved > 500) {
          lastSaved = Date.now();
          const snapshot = raw;
          writes = writes
            .then(async () => {
              await db.transaction(
                "rw",
                db.generatorSessions,
                db.generatorSteps,
                async () => {
                  await checkRun(step.sessionId, token, step.revision, signal);
                  if (
                    (await db.generatorSteps.get(step.id))?.status !==
                    "complete"
                  )
                    await db.generatorSteps.update(
                      step.id,
                      bounded({ raw: snapshot }),
                    );
                },
              );
            })
            .catch(() => {});
        }
      },
      fetch,
      { schema: wire(step.kind), schemaName: "cijian_generator_" + step.kind },
    );
    raw = result.text;
    await writes;
    if (!result.complete) throw Error(completionFinishError(result.reason));
    await acceptStep(step, raw, token, signal);
  } catch (e) {
    await writes;
    await db.transaction(
      "rw",
      db.generatorSessions,
      db.generatorSteps,
      async () => {
        const owner = await db.generatorSessions.get(step.sessionId);
        const current = await db.generatorSteps.get(step.id);
        if (
          owner?.lease?.token === token &&
          current &&
          current.status !== "complete"
        )
          await db.generatorSteps.update(
            step.id,
            bounded({
              raw,
              status: signal.aborted ? "interrupted" : "failed",
              error: message(e),
            }),
          );
      },
    );
    throw e;
  }
}
async function acceptStep(
  step: GeneratorStep,
  raw: string,
  token: string,
  signal: AbortSignal,
) {
  const parsed = readJSON(raw);
  await db.transaction(
    "rw",
    db.generatorSessions,
    db.generatorSteps,
    db.generatorTurns,
    db.generatorResults,
    async () => {
      const s = await checkRun(step.sessionId, token, step.revision, signal);
      if ((await db.generatorSteps.get(step.id))?.status === "complete") return;
      let resultId = "";
      if (step.kind === "interview") {
        const interview = validateInterview(parsed);
        resultId = uid();
        const turn: GeneratorTurn = {
          id: resultId,
          sessionId: s.id,
          revision: s.revision,
          kind: "assistant",
          text: interview.message,
          answers: [],
          interview,
          created: Date.now(),
        };
        await db.generatorTurns.add(bounded(turn));
        await db.generatorSessions.update(
          s.id,
          bounded({
            turnIds: [...s.turnIds, turn.id],
            version: s.version + 1,
            updated: Date.now(),
          }),
        );
      } else {
        const results: GeneratorResult[] = [];
        const base = {
          sessionId: s.id,
          revision: s.revision,
          batchId: step.batchId,
          created: Date.now(),
          previousId: "",
          savedId: "",
          needsReview: false,
        };
        if (step.kind === "card") {
          const card = cardSchema.parse(parsed);
          const target = step.targets.find((t) => t.id === step.targetId);
          if (card.targetId !== target?.id || card.name !== target.name)
            throw Error("模型改变了目标人物身份，回复未采用");
          const payload = JSON.parse(step.user);
          const sources = new Map<string, string[]>([
            ["input", evidenceTexts(payload.input)],
            ...payload.materials.map((m: any) => [m.id, evidenceTexts(m.text)]),
            ...payload.history.map((t: any) => [t.id, evidenceTexts(t)]),
          ]);
          for (const section of card.sections) {
            if (section.sourceIds.some((id) => !sources.has(id)))
              throw Error("角色卡引用了未提供的资料");
            if (
              ["source", "mixed"].includes(section.basis) &&
              (!section.evidence ||
                !section.sourceIds.some((id) =>
                  sources
                    .get(id)
                    ?.some((text) => text.includes(section.evidence)),
                ))
            )
              throw Error("角色卡的原文依据无法核验，请在恢复区修正或重试");
          }
          results.push({
            ...base,
            id: uid(),
            targetId: card.targetId,
            kind: "card",
            card,
          });
        } else {
          for (const world of worldsSchema.parse(parsed).worlds)
            results.push({
              ...base,
              id: uid(),
              targetId: "",
              kind: "world",
              world,
            });
        }
        results.forEach((r) => {
          validateResult(
            r,
            step.targets.map((t) => t.id),
          );
          bounded(r);
        });
        await db.generatorResults.bulkAdd(results);
        resultId = results[0]?.id || "";
      }
      await db.generatorSteps.update(
        step.id,
        bounded({ status: "complete", raw, error: "", resultId }),
      );
    },
  );
}
async function validateAnswers(
  s: GeneratorSession,
  answers: GeneratorAnswer[],
  text: string,
) {
  const last = s.turnIds.length
    ? await db.generatorTurns.get(s.turnIds.at(-1)!)
    : undefined;
  const questions = last?.interview?.questions || [];
  if (new Set(answers.map((a) => a.questionId)).size !== answers.length)
    throw Error("回答的问题重复");
  for (const a of answers) {
    const q = questions.find((q) => q.id === a.questionId);
    if (
      !q ||
      a.options.some((id) => !q.options.some((o) => o.id === id)) ||
      new Set(a.options).size !== a.options.length ||
      (!q.multiple && a.options.length > 1)
    )
      throw Error("回答与当前问题不匹配");
    if (
      a.disposition === "answer" &&
      !a.options.length &&
      !a.text.trim() &&
      !text.trim()
    )
      throw Error("请回答问题、交给 AI 决定，或选择暂时留白");
  }
  if (
    questions.length &&
    !text.trim() &&
    questions.some((q) => !answers.some((a) => a.questionId === q.id))
  )
    throw Error("请处理每个问题，也可直接填写一段补充回答");
}
export async function advanceGenerator(
  id: string,
  text = "",
  answers: GeneratorAnswer[] = [],
  force = false,
  onRaw?: (raw: string) => void,
) {
  return withRun(id, async (token, signal) => {
    let s = await session(id);
    if (!s.input.targets.length) throw Error("请先确认目标名单和参考资料");
    await validateAnswers(s, answers, force ? text || "先生成一版" : text);
    const frozen = await connection();
    await db.transaction(
      "rw",
      db.generatorSessions,
      db.generatorTurns,
      async () => {
        s = await checkRun(id, token, s.revision, signal);
        const turn: GeneratorTurn = {
          id: uid(),
          sessionId: id,
          revision: s.revision,
          created: Date.now(),
          kind: "user",
          text:
            text ||
            (force
              ? "先生成一版，缺少的细节可留白。"
              : "请阅读已选资料，开始访谈。"),
          answers,
        };
        await db.generatorTurns.add(bounded(turn));
        s = {
          ...s,
          turnIds: [...s.turnIds, turn.id],
          draft: "",
          answers: [],
          version: s.version + 1,
          updated: Date.now(),
        };
        await db.generatorSessions.put(bounded(s));
      },
    );
    const batch = uid();
    let steps = await makeSteps(
      s,
      force ? "compose" : "interview",
      batch,
      frozen,
    );
    await db.generatorSteps.bulkAdd(steps);
    for (const step of steps) await executeStep(step, token, signal, onRaw);
    if (!force) {
      s = await session(id);
      const last = await db.generatorTurns.get(s.turnIds.at(-1)!);
      if (last?.interview?.ready) {
        steps = await makeSteps(s, "compose", batch, frozen);
        await db.generatorSteps.bulkAdd(steps);
        for (const step of steps) await executeStep(step, token, signal, onRaw);
      }
    }
  });
}
export async function retryGenerator(
  id: string,
  batchId: string,
  onRaw?: (raw: string) => void,
) {
  return withRun(id, async (token, signal) => {
    const s = await session(id);
    const steps = (
      await db.generatorSteps.where("batchId").equals(batchId).toArray()
    ).sort((a, b) => a.ordinal - b.ordinal);
    if (
      !steps.length ||
      steps.some((x) => x.sessionId !== id || x.revision !== s.revision)
    )
      throw Error("资料修订已变化，请用当前设置发起新生成；旧输出仍保留。");
    for (const step of steps.filter((s) => s.status !== "complete"))
      await executeStep(step, token, signal, onRaw);
    // A recovered ready answer also continues to composition without repeating that answer.
    const decision = steps.find((s) => s.kind === "interview");
    const finished = decision && (await db.generatorSteps.get(decision.id));
    if (finished?.resultId && !steps.some((s) => s.kind === "card")) {
      const turn = await db.generatorTurns.get(finished.resultId);
      if (turn?.interview?.ready) {
        const current = await session(id);
        const prefs: Preferences = {
          id: "preferences",
          activeProfile: "",
          developer: false,
          prompts: Object.fromEntries(
            Object.entries(finished.promptTexts || {}).map(([k, text]) => [
              k,
              { text, enabled: true },
            ]),
          ),
        };
        // Composition is a new step; the completed interview never gets sent again.
        const next = await makeSteps(current, "compose", batchId, {
          prefs: prefs!,
          profile: finished.profile!,
        });
        await db.generatorSteps.bulkAdd(next);
        for (const step of next) await executeStep(step, token, signal, onRaw);
      }
    }
  });
}
export async function recoverGeneratorStep(stepId: string, editedRaw: string) {
  const step = await db.generatorSteps.get(stepId);
  if (!step) throw Error("请求已不存在");
  if (step.kind !== "legacy")
    return withRun(step.sessionId, (token, signal) =>
      acceptStep(step, editedRaw, token, signal),
    );
  return withRun(step.sessionId, async (token, signal) => {
    const archive = JSON.parse(step.legacyData || "{}");
    const s = await checkRun(step.sessionId, token, step.revision, signal);
    const input = archive.input || {
      source: s.input.source,
      guidance: s.input.guidance,
      targets: s.input.targets.map((t) => t.name).join("、"),
      mode: s.input.multiple ? "multiple" : "single",
      creativity: "balanced",
    };
    await db.transaction(
      "rw",
      db.generatorSessions,
      db.generatorSteps,
      db.generatorResults,
      async () => {
        await checkRun(step.sessionId, token, step.revision, signal);
        if ((await db.generatorSteps.get(step.id))?.status === "complete")
          throw Error("这条回复已经恢复，不会重复创建结果");
        if (archive.attempt?.stage === "candidates") {
          const candidates = parseCompletionCandidates(editedRaw, input);
          await db.generatorSessions.update(s.id, {
            input: {
              ...s.input,
              targets: candidates
                .filter((c) => c.selected)
                .map((c) => ({ id: c.id, name: c.name })),
            },
            version: s.version + 1,
          });
          await db.generatorSteps.update(step.id, {
            status: "complete",
            raw: editedRaw,
            error: "",
          });
          return;
        }
        const json = readJSON(editedRaw) as { candidateId?: string };
        const target =
          s.input.targets.find(
            (t) => t.id === (json.candidateId || archive.attempt?.target?.id),
          ) || (s.input.targets.length === 1 ? s.input.targets[0] : undefined);
        if (!target)
          throw Error(
            "旧回复的目标不明确，请在 JSON 中填写当前目标 candidateId，或使用旧版恢复入口。",
          );
        if (
          (
            await db.generatorResults.where("sessionId").equals(s.id).toArray()
          ).some((r) => r.targetId === target.id && r.revision === s.revision)
        )
          throw Error(
            "这个人物已有恢复结果，请在结果区编辑或恢复版本，不重复采用旧回复。",
          );
        const parsed = parseCompletionCard(editedRaw, input, {
          ...target,
          description: "",
          selected: true,
        });
        const result: GeneratorResult = {
          id: uid(),
          sessionId: s.id,
          revision: s.revision,
          batchId: step.batchId,
          targetId: target.id,
          created: Date.now(),
          previousId: "",
          savedId: "",
          needsReview: false,
          kind: "card",
          card: {
            targetId: target.id,
            name: parsed.name,
            bio: parsed.bio,
            sections: parsed.sections.map((x) => ({
              ...x,
              title: x.title as (typeof completionDimensions)[number],
              sourceIds: x.evidence ? step.materialIds : [],
            })),
            preserved: [],
            changed: [],
            reasons: ["从旧请求在本地恢复，未调用模型。"],
          },
        };
        await db.generatorResults.add(bounded(result));
        await db.generatorSteps.update(step.id, {
          status: "complete",
          raw: editedRaw,
          error: "",
          resultId: result.id,
        });
      },
    );
  });
}
export async function migrateCompletionGenerator() {
  return db.transaction(
    "rw",
    [
      db.roleCompletionDrafts,
      db.preferences,
      ...generatorTables.map((t) => db.table(t)),
    ],
    async () => {
      if ((await db.preferences.get("preferences"))?.generatorLegacyMigrated)
        return;
      if (await db.generatorSessions.get("legacy-role-completion")) {
        await db.preferences.update("preferences", {
          generatorLegacyMigrated: true,
        });
        return;
      }
      const old = await db.roleCompletionDrafts.get("role-completion");
      if (!old) return;
      await db.preferences.update("preferences", {
        generatorLegacyMigrated: true,
      });
      const id = "legacy-role-completion",
        materialId = uid();
      const input: GeneratorInput = {
        ...newGeneratorInput(),
        mode: "refine",
        source: old.input.source,
        guidance: old.input.guidance,
        multiple: old.input.mode === "multiple",
        targets: old.candidates
          .filter((c) => c.selected)
          .map((c) => ({ id: c.id, name: c.name })),
      };
      const s: GeneratorSession = {
        id,
        title: "旧版补全 · 兼容恢复",
        revision: 0,
        version: 0,
        input,
        materialIds: [materialId],
        turnIds: [],
        created: old.updated,
        updated: old.updated,
        legacy: true,
        draft: "",
        answers: [],
      };
      await db.generatorSessions.add(bounded(s));
      await db.generatorMaterials.add(
        bounded({
          id: materialId,
          sessionId: id,
          sourceId: "",
          kind: "text",
          purpose: "source",
          label: "旧补全原始素材",
          text: old.input.source,
          created: old.updated,
        }),
      );
      for (const c of old.cards) {
        if (!s.input.targets.some((t) => t.id === c.candidateId))
          s.input.targets.push({ id: c.candidateId, name: c.name });
        await db.generatorResults.add(
          bounded({
            id: uid(),
            sessionId: id,
            revision: 0,
            batchId: uid(),
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
              sections: c.sections.map((x) => ({
                ...x,
                title: x.title as (typeof completionDimensions)[number],
                sourceIds: x.evidence ? [materialId] : [],
              })),
              preserved: [],
              changed: [],
              reasons: ["从旧版补全迁入；原始版本仍可在兼容入口查看。"],
            },
          }),
        );
      }
      await db.generatorSessions.put(s);
      const attempts = old.attempts?.length
        ? old.attempts
        : old.raw
          ? [
              {
                id: uid(),
                raw: old.raw,
                error: old.error,
                state: "interrupted",
              },
            ]
          : [];
      for (const a of attempts)
        await db.generatorSteps.add(
          bounded({
            id: uid(),
            sessionId: id,
            revision: 0,
            batchId: uid(),
            ordinal: 0,
            kind: "legacy",
            targetId: "",
            targets: input.targets,
            materialIds: [materialId],
            status: ["parsed", "recovered"].includes(a.state)
              ? "complete"
              : "interrupted",
            created: old.updated,
            raw: a.raw,
            error: a.error || "旧请求保留为恢复资料",
            system: "",
            user: "",
            legacyData: JSON.stringify({
              attempt: a,
              input: old.input,
              candidates: old.candidates,
            }),
          }),
        );
    },
  );
}
