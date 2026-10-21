import { generatorTables, generatorSchemas } from "./generator-types";

export function generatorLinks(table: string, row: any): [string, string][] {
  const links: [string, string][] = [];
  if (table !== "generatorSessions")
    links.push(["generatorSessions", row.sessionId]);
  if (table === "generatorSessions") {
    links.push(
      ...row.materialIds.map((id: string): [string, string] => [
        "generatorMaterials",
        id,
      ]),
    );
    links.push(
      ...row.turnIds.map((id: string): [string, string] => [
        "generatorTurns",
        id,
      ]),
    );
    if (row.editor) links.push(["generatorResults", row.editor.resultId]);
  }
  if (table === "generatorSteps") {
    for (const id of row.referenceResultIds || [])
      links.push(["generatorResults", id]);
    links.push(
      ...row.materialIds.map((id: string): [string, string] => [
        "generatorMaterials",
        id,
      ]),
    );
    if (row.resultId)
      links.push([
        row.kind === "interview" ? "generatorTurns" : "generatorResults",
        row.resultId,
      ]);
  }
  if (table === "generatorResults" && row.previousId)
    links.push(["generatorResults", row.previousId]);
  return links;
}
export function checkGeneratorRow(
  table: string,
  row: any,
  related: Map<string, any>,
) {
  const sessionId = table === "generatorSessions" ? row.id : row.sessionId;
  for (const [t, id] of generatorLinks(table, row)) {
    const other = related.get(`${t}:${id}`);
    if (
      !other ||
      (t === "generatorSessions" ? other.id : other.sessionId) !== sessionId
    )
      throw Error("生成器会话关联缺失或跨会话引用");
  }
  if (
    table === "generatorResults" &&
    ((row.kind === "card") !== !!row.card ||
      (row.kind === "world") !== !!row.world ||
      row.previousId === row.id)
  )
    throw Error("生成器结果类型或版本关联无效");
  if (
    row.card &&
    (row.card.targetId !== row.targetId ||
      new Set(row.card.sections.map((s: any) => s.title)).size !== 10)
  )
    throw Error("生成器角色目标或维度无效");
  if (table === "generatorResults" && row.previousId) {
    const parent = related.get(`generatorResults:${row.previousId}`);
    if (
      parent.kind !== row.kind ||
      parent.targetId !== row.targetId ||
      parent.created > row.created
    )
      throw Error("生成器版本引用了不同目标或未来版本");
  }
  if (table === "generatorSteps" && row.kind === "card" && row.resultId) {
    const result = related.get(`generatorResults:${row.resultId}`);
    if (result.targetId !== row.targetId || result.batchId !== row.batchId)
      throw Error("生成步骤与结果不匹配");
  }
  if (
    table === "generatorSessions" &&
    (new Set(row.input.targets.map((t: any) => t.id)).size !==
      row.input.targets.length ||
      new Set(row.turnIds).size !== row.turnIds.length ||
      new Set(row.materialIds).size !== row.materialIds.length)
  )
    throw Error("生成器目标或参考编号重复");
}
export function validateGeneratorBackup(b: any) {
  const related = new Map<string, any>();
  for (const table of generatorTables)
    for (const row of b[table] || []) {
      const key = `${table}:${row.id}`;
      if (related.has(key)) throw Error("生成器记录 ID 重复");
      related.set(key, row);
    }
  for (const table of generatorTables)
    for (const row of b[table] || []) checkGeneratorRow(table, row, related);
  for (const row of b.generatorResults || []) {
    const seen = new Set<string>();
    let current = row;
    while (current) {
      if (seen.has(current.id)) throw Error("生成器版本存在循环引用");
      seen.add(current.id);
      current = related.get(`generatorResults:${current.previousId}`);
    }
  }
}
export function remapGenerator(
  table: string,
  value: any,
  map: (id: string) => string,
): any {
  const keys = new Set([
    "id",
    "sessionId",
    "batchId",
    "sourceId",
    "targetId",
    "previousId",
    "savedId",
    "resultId",
    "questionId",
    "candidateId",
    "savedRoleId",
  ]);
  const lists = new Set([
    "materialIds",
    "turnIds",
    "sourceIds",
    "roleIds",
    "knownBy",
    "options",
    "referenceResultIds",
  ]);
  const remap = (v: any, key = ""): any => {
    if (Array.isArray(v))
      return v.map((x) =>
        typeof x === "string" && lists.has(key)
          ? x === "input"
            ? x
            : map(x)
          : remap(x),
      );
    if (v && typeof v === "object")
      return Object.fromEntries(
        Object.entries(v)
          .filter(([k]) => !["key", "lease"].includes(k))
          .map(([k, x]) => [k, remap(x, k)]),
      );
    if (typeof v === "string" && keys.has(key)) return v ? map(v) : v;
    return v;
  };
  const row = remap(value);
  if (table === "generatorSteps") {
    if (row.status === "running") row.status = "interrupted";
    for (const field of ["user", "raw", "legacyData"]) {
      try {
        if (value[field])
          row[field] = JSON.stringify(remap(JSON.parse(value[field])));
      } catch {
        /* Incomplete raw output remains recoverable verbatim. */
      }
    }
  }
  return generatorSchemas[table as keyof typeof generatorSchemas].parse(row);
}
