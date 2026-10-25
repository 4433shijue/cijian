import { useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { db } from "./db";
import type { SceneEvent } from "./types";
import type { PhoneRecord } from "./phone-types";
import {
  createNovelImage,
  createPhoneImage,
  retryImageJob,
  stopImageJob,
} from "./image-generation";
import { imageWorking, type ImageJob } from "./image-types";
import { Modal } from "./Modal";
import { ImageDiagnostics } from "./ImageDiagnostics";
import "./images.css";

const labels: Record<ImageJob["status"], string> = {
  pending: "图片排队中",
  planning: "正在整理画面",
  generating: "正在生成图片",
  complete: "图片已保存",
  failed: "配图未完成",
  interrupted: "配图已中断",
  skipped: "本轮跳过配图",
  blocked: "配图已拦截",
};
export function ImageJobCard({
  job,
  current = true,
  showImage = true,
  readOnly = false,
}: {
  job: ImageJob;
  current?: boolean;
  showImage?: boolean;
  readOnly?: boolean;
}) {
  const [error, setError] = useState("");
  const [expanded, setExpanded] = useState(false);
  const asset = useLiveQuery(
    () =>
      showImage && job.assetId
        ? job.sourceKind === "novel"
          ? db.imageAssets.get(job.assetId)
          : db.phoneAssets.get(job.assetId)
        : undefined,
    [job.assetId, showImage, job.sourceKind],
  );
  const action = async (work: () => Promise<unknown>) => {
    try {
      await work();
      setError("");
    } catch (e) {
      setError(String(e));
    }
  };
  return (
    <div className="image-job" data-image-status={job.status}>
      {asset && (
        <button
          className="generated-image-open"
          aria-label="查看配图大图"
          onClick={() => setExpanded(true)}
        >
          <img
            loading="lazy"
            src={asset.data}
            alt={job.plan?.description || "故事配图"}
          />
        </button>
      )}
      <div className="image-job-caption">
        <span role="status">
          {current ? labels[job.status] : `旧版本 · ${labels[job.status]}`}
        </span>
        {!readOnly && imageWorking(job.status) && (
          <button onClick={() => void action(() => stopImageJob(job.id))}>
            停止配图
          </button>
        )}
        {!readOnly &&
          current &&
          !imageWorking(job.status) &&
          !["complete", "skipped"].includes(job.status) && (
            <>
              <button onClick={() => void action(() => retryImageJob(job.id))}>
                {job.downloadUrl ? "重新下载图片" : "重试配图"}
              </button>
              {job.downloadUrl && (
                <button
                  onClick={() => {
                    if (
                      confirm(
                        "重新生成会再次调用生图服务，可能产生费用。确认重新生成？",
                      )
                    )
                      void action(() => retryImageJob(job.id, true));
                  }}
                >
                  重新生成图片
                </button>
              )}
            </>
          )}
        {asset && (
          <a
            href={asset.data}
            download={`此间配图-${job.id}.${asset.mime === "image/jpeg" ? "jpg" : asset.mime.split("/")[1]}`}
          >
            保存图片
          </a>
        )}
      </div>
      {(job.error || error) && <p className="hint">{error || job.error}</p>}
      {!readOnly && <ImageDiagnostics diagnostic={job.diagnostic} />}
      {expanded && asset && (
        <Modal title="故事配图" onClose={() => setExpanded(false)}>
          <img
            className="image-full"
            src={asset.data}
            alt={job.plan?.description || "故事配图"}
          />
        </Modal>
      )}
    </div>
  );
}
export function NovelImagePanel({
  event,
  readOnly = false,
}: {
  event: SceneEvent;
  readOnly?: boolean;
}) {
  const jobs =
    useLiveQuery(
      () => db.imageJobs.where("sourceId").equals(event.id).sortBy("created"),
      [event.id],
    ) || [];
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const current = jobs.filter((j) => j.sourceVersionId === event.versionId),
    latest = current.at(-1);
  const older = jobs.filter((j) => j.id !== latest?.id);
  return (
    <section className="novel-image-panel" aria-label="正文插画">
      <div className="row">
        <strong>这一幕的插画</strong>
        {!readOnly && (
          <button
            disabled={busy || current.some((j) => imageWorking(j.status))}
            onClick={async () => {
              setBusy(true);
              try {
                await createNovelImage(event.id);
                setError("");
              } catch (e) {
                setError(String(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            {current.some((j) => j.status === "complete")
              ? "再画一张"
              : "为这一幕配图"}
          </button>
        )}
      </div>
      {latest && <ImageJobCard job={latest} readOnly={readOnly} />}
      {error && <p role="alert">{error}</p>}
      {!!older.length && (
        <details>
          <summary>已有配图与旧版本（{older.length}）</summary>
          {older.map((job) => (
            <ImageJobCard
              key={job.id}
              job={job}
              current={job.sourceVersionId === event.versionId}
              readOnly={readOnly}
            />
          ))}
        </details>
      )}
    </section>
  );
}
export function PhoneImageStatus({
  record,
  readOnly = false,
}: {
  record: PhoneRecord;
  readOnly?: boolean;
}) {
  const jobs =
    useLiveQuery(
      () => db.imageJobs.where("sourceId").equals(record.id).sortBy("created"),
      [record.id],
    ) || [];
  const [error, setError] = useState("");
  const job = jobs.filter((j) => j.sourceVersionId === record.versionId).at(-1);
  if (
    record.retracted ||
    record.deleted ||
    record.body.type !== "image" ||
    record.body.assets.length ||
    record.kind === "comment"
  )
    return null;
  if (readOnly) return <small>{job ? labels[job.status] : "图片说明"}</small>;
  return (
    <div className="phone-image-status">
      {job ? (
        <ImageJobCard job={job} showImage={false} />
      ) : (
        <button
          onClick={() =>
            void createPhoneImage(record.id).catch((e) => setError(String(e)))
          }
        >
          生成这张照片
        </button>
      )}
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
export function StoryImageJobs({ storyId }: { storyId: string }) {
  const jobs =
    useLiveQuery(
      () =>
        db.imageJobs
          .where("storyId")
          .equals(storyId)
          .reverse()
          .sortBy("created"),
      [storyId],
    ) || [];
  return (
    <details className="story-image-jobs">
      <summary>配图记录与恢复（{jobs.length}）</summary>
      {jobs.map((job) => (
        <ImageJobCard key={job.id} job={job} showImage={false} />
      ))}
      {!jobs.length && <p className="hint">生成过的图片会出现在这里。</p>}
    </details>
  );
}
