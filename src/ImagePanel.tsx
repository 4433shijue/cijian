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
import { ImageStylePicker } from "./ImageStylePicker";
import {
  resolveImageStyle,
  referenceViews,
  type CharacterImageReference,
} from "./image-styles";
import { adoptImageReference } from "./image-character";
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
  const [adopting, setAdopting] = useState(false);
  const prefs = useLiveQuery(
    () => (readOnly ? undefined : db.preferences.get("preferences")),
    [readOnly],
  );
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
        {!readOnly &&
          asset &&
          job.sourceKind === "novel" &&
          !!job.plan?.roleIds.length && (
            <button onClick={() => setAdopting(true)}>采用为角色定妆图</button>
          )}
      </div>
      {(job.error || error) && <p className="hint">{error || job.error}</p>}
      {!readOnly && <ImageDiagnostics diagnostic={job.diagnostic} />}
      {!readOnly && (
        <details className="image-job-settings">
          <summary>
            生图设定{job.styleSnapshot ? ` · ${job.styleSnapshot.name}` : ""}
          </summary>
          <p className="hint">
            接口：{job.connectionName || "创建时的默认接口"}。
            {job.referenceMode === "text"
              ? "本次选择仅用文字外貌。"
              : "参考图按接口设置使用。"}
          </p>
          {job.identityInputs?.map((r) => (
            <p key={r.id} className="hint">
              {r.name}：
              {
                {
                  text: "文字外貌",
                  reference: "参考图外貌",
                  both: "文字外貌 + 参考图",
                  scene: "仅场景描述（未设定固定长相）",
                }[r.method]
              }
              {r.references.length ? `；${r.references.join("、")}` : ""}
              {r.note ? `。${r.note}` : ""}
            </p>
          ))}
          {!job.identityInputs && (
            <p className="hint">
              整理画面后，会记录实际采用的人物文字和参考图。
            </p>
          )}
          {prefs?.developer && (
            <>
              <label className="field">
                实际发送的生图提示词
                <textarea
                  aria-label="实际发送的生图提示词"
                  readOnly
                  rows={8}
                  value={
                    job.prompt ||
                    "尚未发送生图请求；画面整理完成后显示完整提示词"
                  }
                />
              </label>
              <details>
                <summary>本次画风与编排快照</summary>
                <pre>
                  {job.style}
                  {job.styleSnapshot?.negative
                    ? `\n避免元素：${job.styleSnapshot.negative}`
                    : ""}
                  {job.planningPrompt ? `\n编排：${job.planningPrompt}` : ""}
                </pre>
              </details>
            </>
          )}
        </details>
      )}
      {adopting && (
        <AdoptReference job={job} onClose={() => setAdopting(false)} />
      )}
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
  const [styleId, setStyleId] = useState("");
  const [textOnly, setTextOnly] = useState(false);
  const story = useLiveQuery(
    () => db.stories.get(event.storyId),
    [event.storyId],
  );
  const prefs = useLiveQuery(
    () => (readOnly ? undefined : db.preferences.get("preferences")),
    [readOnly],
  );
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
                await createNovelImage(event.id, false, {
                  styleId,
                  referenceMode: textOnly ? "text" : "configured",
                });
                setError("");
              } catch (e) {
                setError(String(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            {current.some((j) => j.status === "complete")
              ? styleId
                ? "按新画风重绘"
                : "再画一张"
              : "为这一幕配图"}
          </button>
        )}
      </div>
      {!readOnly && (
        <details className="image-scene-options">
          <summary>本张画风与人物外貌</summary>
          <ImageStylePicker
            value={styleId}
            label="本张画风"
            inherited={`跟随作品 · ${story ? resolveImageStyle(story, prefs?.imageStylePresets).name : "默认画风"}`}
            fallback={story?.images?.stylePresetSnapshot}
            disabled={busy || current.some((j) => imageWorking(j.status))}
            onChange={setStyleId}
          />
          <label>
            <input
              type="checkbox"
              checked={textOnly}
              onChange={(e) => setTextOnly(e.target.checked)}
            />
            本次仅用文字外貌（适合不支持参考图的模型）
          </label>
          <p className="hint">
            切换不生图。点击配图或重绘会调用接口并可能计费，旧图会保留在下方。固定长相与本场造型在作品角色设置中编辑。
          </p>
        </details>
      )}
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
  const [styleId, setStyleId] = useState("");
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
      {!job && (
        <ImageStylePicker
          value={styleId}
          label="本张照片风格"
          inherited="跟随作品照片风格"
          onChange={setStyleId}
        />
      )}
      {job ? (
        <ImageJobCard job={job} showImage={false} />
      ) : (
        <button
          onClick={() =>
            void createPhoneImage(record.id, false, undefined, {
              styleId,
            }).catch((e) => setError(String(e)))
          }
        >
          生成这张照片
        </button>
      )}
      {error && <p role="alert">{error}</p>}
    </div>
  );
}

function AdoptReference({
  job,
  onClose,
}: {
  job: ImageJob;
  onClose: () => void;
}) {
  const roles = job.roles.filter((r) => job.plan?.roleIds.includes(r.id));
  const [roleId, setRoleId] = useState(roles[0]?.id || "");
  const [name, setName] = useState("已确认的角色定妆");
  const [view, setView] = useState<CharacterImageReference["view"]>("other");
  const [styleId, setStyleId] = useState(job.styleSnapshot?.id || "");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <Modal title="采用为角色定妆图" onClose={onClose}>
      <p>
        确认这张图的长相符合角色后再采用。仅保存到本作品的角色，角色库不受影响。多人图片请选准人物；清晰的单人参考更便于模型识别。
      </p>
      <label className="field">
        对应角色
        <select
          aria-label="对应角色"
          value={roleId}
          onChange={(e) => setRoleId(e.target.value)}
        >
          {roles.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        定妆图名称
        <input
          maxLength={100}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </label>
      <label className="field">
        参考视角
        <select
          aria-label="参考视角"
          value={view}
          onChange={(e) =>
            setView(e.target.value as CharacterImageReference["view"])
          }
        >
          {Object.entries(referenceViews).map(([id, text]) => (
            <option value={id} key={id}>
              {text}
            </option>
          ))}
        </select>
      </label>
      <ImageStylePicker
        value={styleId}
        label="定妆适用画风"
        inherited="通用定妆 · 所有画风"
        fallback={job.styleSnapshot}
        onChange={setStyleId}
      />
      <button
        disabled={busy || !roleId || !name.trim()}
        onClick={async () => {
          setBusy(true);
          try {
            await adoptImageReference(job.id, roleId, { name, view, styleId });
            onClose();
          } catch (e) {
            setError(String(e));
          } finally {
            setBusy(false);
          }
        }}
      >
        确认采用定妆图
      </button>
      {error && <p role="alert">{error}</p>}
    </Modal>
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
