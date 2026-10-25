import { useEffect, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { db } from "./db";
import type { Story } from "./types";
import { imageSettings, type ImageSettings } from "./image-types";
import { ImageStylePicker } from "./ImageStylePicker";
import { resolveImageStyle } from "./image-styles";
import { StoryImageJobs } from "./ImagePanel";
import { exportIllustratedStory } from "./image-export";
import { compactImageStorage, imageStorageUsage } from "./image-storage";
import "./images.css";

export { CharacterImageFields as RoleImageFields } from "./CharacterImageFields";

export function StoryImageSettings({ story }: { story: Story }) {
  const [settings, setSettings] = useState(() => imageSettings(story.images));
  const [error, setError] = useState("");
  const [cleaning, setCleaning] = useState(false);
  const [storageMessage, setStorageMessage] = useState("");
  const usage = useLiveQuery(() => imageStorageUsage(story.id), [story.id]);
  useEffect(
    () => setSettings(imageSettings(story.images)),
    [story.id, story.images],
  );
  const update = async (patch: Partial<ImageSettings>) => {
    setSettings((current) => ({ ...current, ...patch }));
    try {
      await db.transaction("rw", db.stories, async () => {
        const current = await db.stories.get(story.id);
        if (current)
          await db.stories.update(story.id, {
            images: imageSettings({
              ...imageSettings(current.images),
              ...patch,
            }),
          });
      });
      setError("");
    } catch (e) {
      setSettings(imageSettings(story.images));
      setError(String(e));
    }
  };
  return (
    <section className="story-image-settings">
      <h3>{story.kind === "novel" ? "正文配图" : "角色照片"}</h3>
      {story.kind === "novel" ? (
        <label className="field">
          正文配图方式
          <select
            aria-label="正文配图方式"
            value={settings.novelMode}
            onChange={(e) =>
              void update({
                novelMode: e.target.value as ImageSettings["novelMode"],
              })
            }
          >
            <option value="manual">手动点击配图</option>
            <option value="every">每轮正文自动配一张图</option>
            <option value="auto">AI 判断有合适场景时配图</option>
          </select>
        </label>
      ) : (
        <>
          <label className="check">
            <input
              type="checkbox"
              checked={settings.phoneEnabled}
              onChange={(e) => void update({ phoneEnabled: e.target.checked })}
            />
            允许角色根据语境生成照片
          </label>
          <p className="hint">
            适用于聊天、朋友圈和自动推进。隔离草稿采用后才生图。禁止自拍、镜子自拍和拍摄者本人入镜。
          </p>
          <div className="image-settings-grid">
            <label className="field">
              每轮最多生图请求数
              <input
                type="number"
                min={1}
                max={5}
                value={settings.perTurn}
                onChange={(e) => {
                  const n = Number(e.target.value);
                  if (n >= 1 && n <= 5) void update({ perTurn: n });
                }}
              />
            </label>
            <label className="field">
              每次自动推进最多生图请求数
              <input
                type="number"
                min={1}
                max={100}
                value={settings.perRun}
                onChange={(e) => {
                  const n = Number(e.target.value);
                  if (n >= 1 && n <= 100) void update({ perRun: n });
                }}
              />
            </label>
          </div>
        </>
      )}
      <ImageStylePicker
        value={settings.stylePresetId || resolveImageStyle(story).id}
        fallback={settings.stylePresetSnapshot}
        onChange={(stylePresetId, preset) =>
          void update({ stylePresetId, stylePresetSnapshot: preset })
        }
      />
      <label className="field">
        {story.kind === "novel" ? "插画画风" : "照片风格"}
        <textarea
          key={story.id}
          defaultValue={settings.style}
          onBlur={(e) => void update({ style: e.target.value })}
          placeholder={
            story.kind === "novel"
              ? "例如细腻水彩、日系插画、写实叙事"
              : "默认自然的手机随手拍，也可以指定插画风格"
          }
        />
      </label>
      <p className="hint">
        文字先保存，图片随后出现。每张图片会调用文字模型整理画面，再调用生图模型。失败不自动重试，已发出的生图请求计入上限。修改设置不补画旧内容。
      </p>
      {story.kind === "novel" && (
        <button
          onClick={() =>
            void exportIllustratedStory(story.id).catch((e) =>
              setError(String(e)),
            )
          }
        >
          导出图文阅读页
        </button>
      )}
      {error && <p role="alert">{error}</p>}
      {story.kind === "novel" && (
        <div className="image-storage">
          <p className="hint">
            正文配图与任务参考图 {usage?.count ?? 0} 张，图片内容约{" "}
            {((usage?.bytes ?? 0) / 1024 / 1024).toFixed(1)} MiB。
            清理会合并相同图片并移除未引用素材，保留正文、历史版本和所有仍在使用的图片。
          </p>
          <button
            disabled={cleaning}
            onClick={async () => {
              setCleaning(true);
              try {
                const count = await compactImageStorage(story.id);
                setStorageMessage(`清理完成，移除 ${count} 份重复或未引用素材`);
              } catch (e) {
                setError(String(e));
              } finally {
                setCleaning(false);
              }
            }}
          >
            {cleaning ? "正在清理配图素材…" : "清理重复与未引用配图"}
          </button>
          {storageMessage && <p role="status">{storageMessage}</p>}
        </div>
      )}
      <StoryImageJobs storyId={story.id} />
    </section>
  );
}
