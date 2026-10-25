import { db } from "./db";
import { uid } from "./types";

export async function imageContentHash(data: string) {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(data),
  );
  return Array.from(new Uint8Array(bytes), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}

/** Caller owns the imageAssets transaction; hashing happens before it starts. */
export async function storeImageReference(
  storyId: string,
  name: string,
  data: string,
  hash: string,
) {
  const existing = await db.imageAssets
    .where("[storyId+contentHash]")
    .equals([storyId, hash])
    .first();
  if (existing?.data === data) return existing.id;
  const match =
    /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(data);
  if (!match || match[2].length > 14 * 1024 * 1024)
    throw Error("人物参考图格式或大小无效，请重新上传");
  const id = uid();
  await db.imageAssets.add({
    id,
    storyId,
    name: name + "参考图",
    contentHash: hash,
    mime: match[1] as "image/png" | "image/jpeg" | "image/webp",
    data,
    size: atob(match[2]).length,
  });
  return id;
}

export async function imageStorageUsage(storyId: string) {
  let count = 0,
    bytes = 0;
  await db.imageAssets
    .where("storyId")
    .equals(storyId)
    .each((a) => {
      count++;
      bytes += a.size;
    });
  return { count, bytes };
}

/** Preserve every job and historical picture. Remove only identical copies or
 * assets with no job references, rechecking in the same transaction as deletion. */
export async function compactImageStorage(storyId: string) {
  let after = "",
    removed = 0;
  for (;;) {
    const asset = await db.imageAssets
      .where(":id")
      .above(after)
      .filter((a) => a.storyId === storyId)
      .first();
    if (!asset) break;
    after = asset.id;
    const hash = await imageContentHash(asset.data);
    await db.transaction("rw", db.imageAssets, db.imageJobs, async () => {
      const current = await db.imageAssets.get(asset.id);
      if (!current || current.data !== asset.data) return;
      const jobs = await db.imageJobs
        .where("storyId")
        .equals(storyId)
        .toArray();
      const linked = jobs.filter(
        (j) =>
          j.assetId === asset.id ||
          j.roles.some(
            (r) =>
              r.reference === asset.id ||
              r.references?.some((ref) => ref.reference === asset.id),
          ),
      );
      if (!linked.length) {
        await db.imageAssets.delete(asset.id);
        removed++;
        return;
      }
      const duplicate = await db.imageAssets
        .where("[storyId+contentHash]")
        .equals([storyId, hash])
        .filter((a) => a.id !== asset.id && a.data === asset.data)
        .first();
      if (duplicate) {
        for (const job of linked)
          await db.imageJobs.update(job.id, {
            assetId: job.assetId === asset.id ? duplicate.id : job.assetId,
            roles: job.roles.map((r) => ({
              ...r,
              reference: r.reference === asset.id ? duplicate.id : r.reference,
              references: r.references?.map((ref) => ({
                ...ref,
                reference:
                  ref.reference === asset.id ? duplicate.id : ref.reference,
              })),
            })),
          });
        await db.imageAssets.delete(asset.id);
        removed++;
      } else await db.imageAssets.update(asset.id, { contentHash: hash });
    });
  }
  return removed;
}
