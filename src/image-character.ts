import { db } from "./db";
import { uid } from "./types";
import {
  imageReferenceSchema,
  roleImageReferences,
  type CharacterImageReference,
} from "./image-styles";

export async function adoptImageReference(
  jobId: string,
  roleId: string,
  metadata: Pick<CharacterImageReference, "name" | "view" | "styleId">,
) {
  await db.transaction(
    "rw",
    db.stories,
    db.imageJobs,
    db.imageAssets,
    async () => {
      const job = await db.imageJobs.get(jobId);
      if (
        !job ||
        job.sourceKind !== "novel" ||
        job.status !== "complete" ||
        !job.plan?.roleIds.includes(roleId)
      )
        throw Error("请选择这张正文插画中实际出现的角色");
      const story = await db.stories.get(job.storyId);
      const asset = await db.imageAssets.get(job.assetId);
      const role = story?.roles.find((r) => r.id === roleId);
      if (!story || !role || !asset || asset.storyId !== story.id)
        throw Error("角色或配图已不存在");
      const refs = roleImageReferences(role);
      if (refs.length >= 12)
        throw Error(
          "该角色已有 12 张定妆图，请在作品角色设置中移除不需要的参考",
        );
      if (
        refs.some(
          (r) => r.data === asset.data && r.styleId === metadata.styleId,
        )
      )
        throw Error("这张图已被采用为该画风的定妆图");
      const reference = imageReferenceSchema.parse({
        ...metadata,
        id: uid(),
        data: asset.data,
      });
      await db.stories.update(story.id, {
        roles: story.roles.map((r) =>
          r.id === roleId
            ? {
                ...r,
                imageReference: "",
                imageReferences: [...refs, reference],
              }
            : r,
        ),
      });
    },
  );
}
