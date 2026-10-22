import { db } from "./db";
import { download } from "./backup";
import { xmlText, safeFilename } from "./work-export";

export async function illustratedStoryHtml(storyId: string) {
  return db.transaction(
    "r",
    db.stories,
    db.events,
    db.imageJobs,
    db.imageAssets,
    async () => {
      const story = await db.stories.get(storyId);
      if (!story || story.kind !== "novel")
        throw Error("只能导出小说图文阅读页");
      const events = (
        await db.events.where("storyId").equals(storyId).sortBy("seq")
      ).filter(
        (e) => e.kind === "novel" && e.status === "complete" && !e.deleted,
      );
      const jobs = await db.imageJobs
        .where("storyId")
        .equals(storyId)
        .sortBy("created");
      const blocks: string[] = [];
      for (const event of events) {
        const job = jobs
          .filter(
            (j) =>
              j.sourceId === event.id &&
              j.sourceVersionId === event.versionId &&
              j.status === "complete",
          )
          .at(-1);
        const asset = job?.assetId
          ? await db.imageAssets.get(job.assetId)
          : undefined;
        blocks.push(
          `<article><div class="prose">${xmlText(event.text)}</div>${asset ? `<figure><img src="${xmlText(asset.data)}" alt="${xmlText(job?.plan?.description || "正文插画")}" /></figure>` : ""}</article>`,
        );
      }
      return {
        title: story.title,
        html: `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'"><title>${xmlText(story.title)}</title><style>body{margin:0;background:#f7f6ef;color:#263c35;font:18px/1.9 system-ui,sans-serif}main{max-width:740px;margin:auto;padding:36px 22px}h1{font-size:1.7em}article{margin:2em 0 3em}.prose{white-space:pre-wrap;overflow-wrap:anywhere}figure{margin:1.3em 0}img{display:block;max-width:100%;height:auto;border-radius:12px}@media print{body{background:white}article{break-inside:avoid}}</style><main><h1>${xmlText(story.title)}</h1>${blocks.join("")}</main></html>`,
      };
    },
  );
}
export async function exportIllustratedStory(storyId: string) {
  const { title, html } = await illustratedStoryHtml(storyId);
  download(
    `${safeFilename(title)}-图文阅读.html`,
    html,
    "text/html;charset=utf-8",
  );
}
