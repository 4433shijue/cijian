import { extraTables } from "./work-types";
export function extraLinks(table: string, r: any): [string, string][] {
  const out: [string, string][] = [["stories", r.storyId]];
  const add = (t: string, values: string[]) =>
    values.filter(Boolean).forEach((id) => out.push([t, id]));
  const target = (t: any) => {
    if (t.type !== "app")
      add(t.type === "record" ? "phoneRecords" : "phoneDocuments", [t.id]);
  };
  if (table === "phoneDocuments")
    add(
      "phoneAssets",
      [r, ...r.versions].flatMap((v) => v.assets),
    );
  if (["phoneDrafts", "phoneEdits"].includes(table))
    add("phoneConversations", [r.conversationId]);
  if (table === "phoneDrafts") {
    add("phoneRecords", Object.keys(r.sourceVersions));
    add(
      "phoneAssets",
      r.lines.flatMap((l: any) => l.body.assets),
    );
    add(
      "phoneRecords",
      r.lines.flatMap((l: any) => [l.sourceId, l.body.quoteId]).filter(Boolean),
    );
  }
  if (table === "phoneEdits") {
    add("phoneRecords", [...r.before.map((x: any) => x.id), ...r.added]);
    add(
      "phoneAssets",
      r.before.flatMap((x: any) => x.body.assets),
    );
  }
  if (table === "phoneReading") {
    add("phoneRecords", r.selectedRecords || []);
    add("phoneDocuments", r.selectedDocuments || []);
    for (const rule of r.rules) {
      rule.targets.forEach(target);
      rule.conditions
        .filter((c: any) => c.type === "read")
        .forEach((c: any) => target(c.target));
    }
    for (const p of r.performances) {
      add("phoneConversations", [p.conversationId]);
      add(
        "phoneRecords",
        p.steps.map((s: any) => s.recordId),
      );
    }
  }
  return out;
}
export function checkExtraRow(
  table: string,
  r: any,
  related: Map<string, any>,
) {
  const story = related.get(`stories:${r.storyId}`);
  if (!story) throw Error("作品资料关联缺失");
  if (table.startsWith("phone") && story.kind && story.kind !== "phone")
    throw Error("小说包含手机专属资料");
  for (const [t, id] of extraLinks(table, r)) {
    const row = related.get(`${t}:${id}`);
    if (!row || (t !== "stories" && row.storyId !== r.storyId))
      throw Error("作品资料缺失或跨作品引用");
  }
  let roles: string[] = [];
  if (table === "phoneBackgrounds") roles = r.audience;
  if (table === "phoneDocuments")
    roles = [
      r.ownerId,
      r.recipientId,
      ...r.audience,
      ...r.versions.flatMap((v: any) => [...v.audience, v.recipientId]),
    ].filter(Boolean);
  if (table === "phoneReading")
    roles = [
      r.initialOwner,
      ...r.owners,
      ...r.rules.flatMap((rule: any) =>
        [
          ...rule.targets,
          ...rule.conditions
            .filter((c: any) => c.type === "read")
            .map((c: any) => c.target),
        ].map((t: any) => t.ownerId),
      ),
    ];
  if (table === "phoneDrafts")
    roles = r.lines.flatMap((l: any) => [l.speakerId, ...l.audience]);
  if (roles.some((id) => !story.roles.some((role: any) => role.id === id)))
    throw Error("作品资料引用了未知角色");
  if (table === "phoneDocuments" && !r.audience.includes(r.ownerId))
    throw Error("文档机主必须可见");
}
export function validateExtras(b: any) {
  const related = new Map<string, any>();
  for (const [table, rows] of Object.entries(b))
    if (Array.isArray(rows))
      for (const r of rows) {
        if (!r?.id) continue;
        if (related.has(`${table}:${r.id}`)) throw Error("备份包含重复资料 ID");
        related.set(`${table}:${r.id}`, r);
      }
  for (const table of extraTables)
    for (const row of b[table] || []) checkExtraRow(table, row, related);
  if (b.version >= 6)
    for (const s of b.stories) {
      if (
        s.worldIds.some(
          (id: string) => related.get(`storyWorld:${id}`)?.storyId !== s.id,
        )
      )
        throw Error("作品世界书副本缺失");
      if (s.kind === "phone" && b.events.some((e: any) => e.storyId === s.id))
        throw Error("手机作品不能包含小说事件");
    }
}
export function remapExtra(
  table: string,
  row: any,
  id: (id: string) => string,
) {
  const r = structuredClone(row);
  r.id = id(r.id);
  r.storyId = id(r.storyId);
  const body = (b: any) => ({
    ...b,
    assets: b.assets.map(id),
    quoteId: id(b.quoteId),
  });
  const refs = (o: any) =>
    Object.fromEntries(
      Object.entries(o).map(([k, v]) => [id(k), id(v as string)]),
    );
  if (table === "storyWorld") {
    r.roleIds = r.roleIds.map(id);
    r.knownBy = r.knownBy.map(id);
    r.storyIds = [r.storyId];
    if (r.sourceId) r.sourceId = id(r.sourceId);
  }
  if (table === "storyMigrations") {
    for (const k of ["sourceId", "novelId", "phoneId"]) r[k] = id(r[k]);
    r.map = refs(r.map);
  }
  // Archive payloads and background provenance are historical labels, never runtime references.
  if (table === "phoneBackgrounds") r.audience = r.audience.map(id);
  if (table === "phoneDocuments") {
    r.ownerId = id(r.ownerId);
    r.versionId = id(r.versionId);
    for (const v of [r, ...r.versions]) {
      v.assets = v.assets.map(id);
      v.audience = v.audience.map(id);
      v.recipientId = id(v.recipientId);
    }
    r.versions = r.versions.map((v: any) => ({ ...v, id: id(v.id) }));
  }
  if (table === "phoneReading") {
    r.owners = r.owners.map(id);
    r.initialOwner = id(r.initialOwner);
    const target = (t: any) => ({
      ...t,
      ownerId: id(t.ownerId),
      id: t.type === "app" ? t.id : id(t.id),
    });
    r.rules = r.rules.map((rule: any) => ({
      ...rule,
      id: id(rule.id),
      targets: rule.targets.map(target),
      conditions: rule.conditions.map((c: any) =>
        c.type === "read"
          ? { ...c, target: target(c.target) }
          : c.type === "clue"
            ? { ...c, ruleId: id(c.ruleId) }
            : c,
      ),
    }));
    r.performances = r.performances.map((p: any) => ({
      ...p,
      id: id(p.id),
      conversationId: id(p.conversationId),
      steps: p.steps.map((s: any) => ({ ...s, recordId: id(s.recordId) })),
    }));
    if (r.selectedRecords) r.selectedRecords = r.selectedRecords.map(id);
    if (r.selectedDocuments) r.selectedDocuments = r.selectedDocuments.map(id);
  }
  if (table === "phoneDrafts") {
    r.conversationId = id(r.conversationId);
    r.sourceVersions = refs(r.sourceVersions);
    r.lines = r.lines.map((l: any) => ({
      ...l,
      id: id(l.id),
      speakerId: id(l.speakerId),
      audience: l.audience.map(id),
      body: body(l.body),
      sourceId: l.sourceId && id(l.sourceId),
      sourceVersion: l.sourceVersion && id(l.sourceVersion),
    }));
    if (r.generation?.status === "running") r.generation.status = "interrupted";
  }
  if (table === "phoneEdits") {
    r.conversationId = id(r.conversationId);
    r.after = refs(r.after);
    r.added = r.added.map(id);
    r.before = r.before.map((v: any) => ({
      ...v,
      id: id(v.id),
      versionId: id(v.versionId),
      body: body(v.body),
    }));
  }
  return r;
}
