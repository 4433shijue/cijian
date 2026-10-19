import { checkPhoneRow } from "./phone-backup";
import { remapPhone } from "./phone-store";
import { automationTables } from "./work-types";

export const isAutomationTable = (table: string) =>
  (automationTables as string[]).includes(table);
const payloadRows = (p: any): [string, any][] =>
  p
    ? [
        ...p.records.map((r: any) => ["phoneRecords", r]),
        ...p.documents.map((r: any) => ["phoneDocuments", r]),
        ...p.events.map((r: any) => ["phoneWorldEvents", r]),
        ...p.conversations.map((r: any) => ["phoneConversations", r]),
      ]
    : [];

export function automationLinks(table: string, r: any): [string, string][] {
  const links: [string, string][] = [];
  if (r.runId) links.push(["phoneAutomationRuns", r.runId]);
  if (r.stepId) links.push(["phoneAutomationSteps", r.stepId]);
  if (table === "phoneKnowledge") links.push(["phoneRecords", r.targetId]);
  if (table === "phoneAutomationSteps") {
    links.push(...r.refs.map((x: any): [string, string] => [x.table, x.id]));
    links.push(...r.consumedIds.map((id:string):[string,string]=>["phoneRecords",id]));
    links.push(
      ...r.assets.map((a: any): [string, string] => ["phoneAssets", a.id]),
    );
    for (const [t, x] of [
      ...payloadRows(r.snapshot),
      ...payloadRows(r.result),
    ]) {
      if (t === "phoneRecords")
        for (const a of [x.body, ...x.versions.map((v: any) => v.body)].flatMap(
          (b) => b.assets,
        ))
          links.push(["phoneAssets", a]);
      if (t === "phoneDocuments")
        for (const a of [x, ...x.versions].flatMap((v) => v.assets))
          links.push(["phoneAssets", a]);
    }
  }
  return links;
}

export function checkAutomation(
  table: string,
  r: any,
  related: Map<string, any>,
) {
  const story = related.get(`stories:${r.storyId}`);
  const valid = new Set(story.roles.map((x: any) => x.id));
  const checkRoles = (ids: string[]) => {
    if (ids.filter(Boolean).some((id) => !valid.has(id)))
      throw Error("自动推进引用了其他作品的角色");
  };
  const options = table === "phoneAutomationSettings" ? r : r.options;
  if (options)
    checkRoles([
      ...options.roles,
      options.controlledRole,
      ...Object.keys(options.habits),
    ]);
  if (r.actorId) checkRoles([r.actorId]);
  if (r.audience) checkRoles(r.audience);
  if (table === "phoneAutomationSteps") {
    const virtual = new Map(related);
    for (const [t, x] of [
      ...payloadRows(r.snapshot),
      ...payloadRows(r.result),
      ...r.beforeDocuments.map((d: any): [string, any] => [
        "phoneDocuments",
        d,
      ]),
    ])
      virtual.set(`${t}:${x.id}`, x);
    checkRoles(r.roles.map((x: any) => x.id));
    if (r.action) checkRoles([r.action.recipientId, ...r.action.audience]);
    for (const [t, x] of [
      ...payloadRows(r.snapshot),
      ...payloadRows(r.result),
    ]) {
      if (x.storyId !== r.storyId) throw Error("自动推进快照跨作品引用");
      if (t === "phoneRecords" || t === "phoneConversations")
        checkPhoneRow(t, x, virtual);
      else {
        checkRoles([x.ownerId || x.actorId, x.recipientId, ...x.audience]);
        if (!x.audience.includes(x.ownerId || x.actorId))
          throw Error("自动内容的创建者不可见");
      }
    }
    for (const l of [...r.snapshot.likes, ...(r.result?.likes || [])]) {
      checkRoles([l.actorId]);
      const target = virtual.get(`phoneRecords:${l.recordId}`);
      if (
        !target ||
        target.storyId !== r.storyId ||
        target.kind !== "moment" ||
        !target.audience.includes(l.actorId)
      )
        throw Error("自动点赞关联无效");
    }
    const run = related.get(`phoneAutomationRuns:${r.runId}`);
    if (
      !run ||
      !r.options.roles.includes(r.actorId) ||
      (!r.options.takeover && r.actorId === r.options.controlledRole)
    )
      throw Error("自动任务角色授权无效");
    for (const [t, x] of payloadRows(r.result)) {
      if (
        (t === "phoneRecords" && x.speakerId !== r.actorId) ||
        (t === "phoneDocuments" && x.ownerId !== r.actorId) ||
        (t === "phoneWorldEvents" && x.actorId !== r.actorId)
      )
        throw Error("自动结果身份无效");
    }
  }
  if (
    r.stepId &&
    related.get(`phoneAutomationSteps:${r.stepId}`)?.runId !== r.runId
  )
    throw Error("自动步骤与批次不匹配");
}

/** Remap only structural IDs and those exact IDs embedded in frozen requests. */
export function remapAutomation(
  table: string,
  row: any,
  mapId: (id: string) => string,
) {
  const replacements = new Map<string, string>();
  const id = (v: string) => {
    if (!v) return v;
    const next = mapId(v);
    replacements.set(v, next);
    return next;
  };
  const refs = (o: any) =>
    Object.fromEntries(
      Object.entries(o).map(([k, v]) => [id(k), id(v as string)]),
    );
  const options = (o: any) => ({
    ...o,
    roles: o.roles.map(id),
    controlledRole: id(o.controlledRole),
    habits: Object.fromEntries(
      Object.entries(o.habits).map(([k, v]) => [id(k), v]),
    ),
  });
  const document = (d: any) => ({
    ...d,
    id: id(d.id),
    storyId: id(d.storyId),
    ownerId: id(d.ownerId),
    versionId: id(d.versionId),
    assets: d.assets.map(id),
    audience: d.audience.map(id),
    recipientId: id(d.recipientId),
    versions: d.versions.map((v: any) => ({
      ...v,
      id: id(v.id),
      assets: v.assets.map(id),
      audience: v.audience.map(id),
      recipientId: id(v.recipientId),
    })),
  });
  const event = (e: any) => ({
    ...e,
    id: id(e.id),
    storyId: id(e.storyId),
    actorId: id(e.actorId),
    audience: e.audience.map(id),
    versionId: id(e.versionId),
    runId: id(e.runId),
    stepId: id(e.stepId),
  });
  const payload = (p: any) => ({
    ...p,
    records: p.records.map((x: any) => remapPhone("phoneRecords", x, id)),
    conversations: p.conversations.map((x: any) =>
      remapPhone("phoneConversations", x, id),
    ),
    documents: p.documents.map(document),
    events: p.events.map(event),
    likes: p.likes.map((x: any) => ({
      ...x,
      recordId: id(x.recordId),
      actorId: id(x.actorId),
      versionId: id(x.versionId || ""),
      beforeVersion: id(x.beforeVersion || ""),
    })),
  });
  const r = structuredClone(row);
  r.id = id(r.id);
  r.storyId = id(r.storyId);
  if (table === "phoneAutomationSettings") Object.assign(r, options(r));
  if (r.options) r.options = options(r.options);
  if (r.actorId) r.actorId = id(r.actorId);
  if (r.runId) r.runId = id(r.runId);
  if (r.stepId) r.stepId = id(r.stepId);
  if (table === "phoneWorldEvents") return event(row);
  if (table === "phoneKnowledge") {
    r.targetId = id(r.targetId);
    r.versionId = id(r.versionId);
  }
  if (table === "phoneAutomationRuns") {
    r.waiting = Object.fromEntries(
      Object.entries(r.waiting).map(([k, v]) => [id(k), v]),
    );
    if (r.status === "running") r.status = "interrupted";
  }
  if (table === "phoneAutomationSteps") {
    r.snapshot = payload(r.snapshot);
    if (r.result) r.result = payload(r.result);
    r.beforeDocuments = r.beforeDocuments.map(document);
    r.afterVersions = refs(r.afterVersions);
    r.roles = r.roles.map((x: any) => ({ ...x, id: id(x.id) }));
    r.assets = r.assets.map((x: any) => ({ ...x, id: id(x.id) }));
    r.readIds = r.readIds.map(id);
    r.consumedIds = r.consumedIds.map(id);
    r.refs = r.refs.map((x: any) => ({
      ...x,
      id: id(x.id),
      version:
        x.table === "phoneConversations"
          ? JSON.stringify(JSON.parse(x.version).map(id))
          : id(x.version),
    }));
    if (r.action) {
      for (const key of [
        "conversationId",
        "recipientId",
        "parentId",
        "replyTo",
        "documentId",
      ])
        r.action[key] = id(r.action[key]);
      r.action.audience = r.action.audience.map(id);
    }
    if (r.status === "running") r.status = "failed";
    // Profiles are application-level. Single-work imports reconnect using the saved protocol, URL and model.
    const rewrite = (text: string) =>
      text.replace(
        /[0-9a-zA-Z_-]{6,}(?:-[0-9a-zA-Z_-]+)*/g,
        (match) => replacements.get(match) || match,
      );
    r.context = rewrite(r.context);
    // Material hashes include template provenance; re-established by the importer after every row is remapped.
    if (r.materialVersion) {
      const ids = new Set(["id", "sourceId", "storyId", "ownerId"]),
        lists = new Set([
          "worldIds",
          "roleIds",
          "storyIds",
          "knownBy",
          "audience",
        ]);
      const remapMaterial = (v: any, key = ""): any =>
        key === "source"
          ? v
          : Array.isArray(v)
            ? v.map((x) => (lists.has(key) ? id(x) : remapMaterial(x)))
            : v && typeof v === "object"
              ? Object.fromEntries(
                  Object.entries(v).map(([k, x]) => [k, remapMaterial(x, k)]),
                )
              : typeof v === "string" && ids.has(key)
                ? id(v)
                : v;
      const material = remapMaterial(JSON.parse(r.materialVersion));
      material[1] = material[1].map(id);
      r.materialVersion = JSON.stringify(material);
    }
    for (const key of ["decisionRequest", "contentRequest"])
      if (r[key]) {
        r[key].user = rewrite(r[key].user);
        r[key].raw = rewrite(r[key].raw);
      }
  }
  return r;
}
