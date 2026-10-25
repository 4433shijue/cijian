import { imageSchemas, imageWorking, type ImageJob } from "./image-types";

export function imageLinks(table: string, row: any): [string, string][] {
  if (table === "imageProfiles") return [];
  const links: [string, string][] = [["stories", row.storyId]];
  if (table === "imageJobs") {
    for (const role of row.roles)
      if (role.reference) links.push(["imageAssets", role.reference]);
    links.push([
      row.sourceKind === "novel" ? "events" : "phoneRecords",
      row.sourceId,
    ]);
    if (row.assetId)
      links.push([
        row.sourceKind === "novel" ? "imageAssets" : "phoneAssets",
        row.assetId,
      ]);
  }
  return links;
}
export function checkImageRow(
  table: string,
  row: any,
  related: Map<string, any>,
) {
  if (table === "imageProfiles") return;
  const story = related.get(`stories:${row.storyId}`);
  if (!story) throw Error("配图所属作品不存在");
  for (const [t, id] of imageLinks(table, row)) {
    const target = related.get(`${t}:${id}`);
    if (!target || (t !== "stories" && target.storyId !== row.storyId))
      throw Error("配图关联缺失或跨越作品");
  }
  if (table === "imageJobs") {
    const job = row as ImageJob;
    const source = related.get(
      `${job.sourceKind === "novel" ? "events" : "phoneRecords"}:${job.sourceId}`,
    );
    if (
      story.kind !== job.sourceKind ||
      !source.versions.some((v: any) => v.id === job.sourceVersionId) ||
      (job.status === "complete" && !job.assetId)
    )
      throw Error("配图来源版本或图片数据无效");
    // A saved task keeps the audience from when it was created. Later edits must
    // not make an otherwise valid historical task impossible to back up.
    if (
      job.sourceKind === "phone" &&
      (source.speakerId !== job.actorId ||
        !job.audience.includes(job.actorId) ||
        job.audience.some((id) => !story.roles.some((r: any) => r.id === id)))
    )
      throw Error("照片任务的角色或受众关联无效");
    if (job.plan?.roleIds.some((id) => !job.roles.some((r) => r.id === id)))
      throw Error("配图人物参考无效");
  }
  if (
    table === "imageAssets" &&
    (!row.data.startsWith(`data:${row.mime};base64,`) ||
      !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(row.data))
  )
    throw Error("配图格式无效");
}
export function remapImage(
  table: string,
  row: any,
  map: (id: string) => string,
) {
  const clean = imageSchemas[table as keyof typeof imageSchemas].parse(row);
  if (table === "imageProfiles")
    return { ...clean, id: map(row.id), remember: false };
  if (table === "imageAssets")
    return { ...clean, id: map(row.id), storyId: map(row.storyId) };
  const j = clean as ImageJob;
  return {
    ...j,
    id: map(j.id),
    storyId: map(j.storyId),
    sourceId: map(j.sourceId),
    sourceVersionId: map(j.sourceVersionId),
    groupId: map(j.groupId),
    runId: map(j.runId),
    actorId: map(j.actorId),
    audience: j.audience.map(map),
    assetId: map(j.assetId),
    roles: j.roles.map((r) => ({
      ...r,
      id: map(r.id),
      reference: map(r.reference),
    })),
    plan: j.plan && { ...j.plan, roleIds: j.plan.roleIds.map(map) },
    status: imageWorking(j.status) ? "interrupted" : j.status,
    leaseUntil: 0,
    executionId: undefined,
    downloadUrl: undefined,
    diagnostic: j.diagnostic && {
      ...j.diagnostic,
      outcome: imageWorking(j.status) ? "stopped" : j.diagnostic.outcome,
    },
    error: imageWorking(j.status)
      ? "导入的生图任务已中断，点击重试才会请求"
      : j.error,
  };
}
