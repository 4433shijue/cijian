import { useEffect, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { db, keyFor } from "./db";
import { uid, type Role, type Story } from "./types";
import {
  imageSettings,
  imageProfileSchema,
  NO_SELFIE,
  type ImageProfile,
  type ImageSettings,
} from "./image-types";
import { imageKey, saveImageProfile } from "./image-generation";
import { imageEndpoint, referenceFile, requestImage } from "./image-provider";
import { StoryImageJobs } from "./ImagePanel";
import { exportIllustratedStory } from "./image-export";
import "./images.css";

export function ImageConnectionSettings() {
  const state = useLiveQuery(async () => {
    const prefs = await db.preferences.get("preferences");
    return {
      profile: prefs?.activeImageProfile
        ? await db.imageProfiles.get(prefs.activeImageProfile)
        : undefined,
    };
  }, []);
  if (!state) return null;
  return (
    <ImageConnectionForm
      key={state.profile?.id || "new"}
      value={state.profile}
    />
  );
}
function ImageConnectionForm({ value }: { value?: ImageProfile }) {
  const [profile, setProfile] = useState<ImageProfile>(
    () =>
      value ||
      imageProfileSchema.parse({
        id: uid(),
        name: "我的生图接口",
        url: "",
        model: "",
      }),
  );
  const [key, setKey] = useState(() => (value ? imageKey(value) : ""));
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState("");
  const [controller, setController] = useState<AbortController>();
  const change = (patch: Partial<ImageProfile>) => {
    setProfile((p) => ({ ...p, ...patch }));
    setMessage("");
  };
  return (
    <section className="settings-card image-settings">
      <h2>图片生成</h2>
      <p className="hint">
        文字模型整理画面，生图模型负责画图。支持 Images API
        兼容服务；保存配置不会请求模型。所有生成都禁止自拍。
      </p>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setMessage("");
          try {
            await saveImageProfile(
              imageProfileSchema.parse(profile),
              key.trim(),
            );
            setMessage("生图配置已保存。请到作品设置选择自动配图方式。");
          } catch (error) {
            setMessage(String(error));
          } finally {
            setBusy(false);
          }
        }}
      >
        <fieldset disabled={busy}>
          <label className="field">
            生图接口地址
            <input
              required
              type="url"
              value={profile.url}
              onChange={(e) => change({ url: e.target.value })}
              placeholder="https://你的服务/v1"
            />
          </label>
          <label className="field">
            生图 API Key
            <input
              type="password"
              autoComplete="off"
              value={key}
              onChange={(e) => {
                setKey(e.target.value);
                setMessage("");
              }}
            />
          </label>
          <label className="field">
            生图模型
            <input
              required
              value={profile.model}
              onChange={(e) => change({ model: e.target.value })}
              placeholder="填写服务提供的图片模型名"
            />
          </label>
          <button
            type="button"
            onClick={async () => {
              const prefs = await db.preferences.get("preferences"),
                p = prefs && (await db.profiles.get(prefs.activeProfile));
              if (!p) {
                setMessage("请先配置文字接口");
                return;
              }
              try {
                const url = imageEndpoint(p.url).replace(
                  /\/images\/generations$/,
                  "",
                );
                change({ url });
                setKey(keyFor(p));
                setMessage("已带入地址与密钥，请填写生图模型，再保存。");
              } catch (e) {
                setMessage(String(e));
              }
            }}
          >
            带入当前文字接口的地址与密钥
          </button>
          <div className="image-settings-grid">
            <label className="field">
              图片尺寸
              <select
                value={profile.size}
                onChange={(e) => change({ size: e.target.value })}
              >
                <option value="">服务默认</option>
                <option value="1024x1024">方图 · 1024 × 1024</option>
                <option value="1536x1024">横图 · 1536 × 1024</option>
                <option value="1024x1536">竖图 · 1024 × 1536</option>
                <option value="1792x1024">横图 · 1792 × 1024</option>
                <option value="1024x1792">竖图 · 1024 × 1792</option>
              </select>
            </label>
            <label className="field">
              图片质量
              <select
                value={profile.quality}
                onChange={(e) => change({ quality: e.target.value })}
              >
                <option value="">服务默认</option>
                {["auto", "low", "medium", "high", "standard", "hd"].map(
                  (q) => (
                    <option key={q}>{q}</option>
                  ),
                )}
              </select>
            </label>
          </div>
          <details>
            <summary>接口兼容设置</summary>
            <label className="field">
              人物参考图
              <select
                value={profile.references}
                onChange={(e) =>
                  change({
                    references: e.target.value as ImageProfile["references"],
                  })
                }
              >
                <option value="off">仅使用外貌文字</option>
                <option value="multipart">
                  支持参考图 · multipart 图片编辑接口
                </option>
                <option value="json">支持参考图 · JSON 图片编辑接口</option>
              </select>
            </label>
            <p className="hint">
              只有服务支持图片编辑接口时才启用参考图。参考图只用于正文人物插画，手机照片不发送人物参考图。
            </p>
            <label className="field">
              图片返回格式
              <select
                value={profile.responseFormat}
                onChange={(e) =>
                  change({
                    responseFormat: e.target
                      .value as ImageProfile["responseFormat"],
                  })
                }
              >
                <option value="">服务默认</option>
                <option value="b64_json">Base64</option>
                <option value="url">图片链接</option>
              </select>
            </label>
            <label className="field">
              生图等待秒数
              <input
                type="number"
                min={10}
                max={600}
                value={profile.timeout}
                onChange={(e) => change({ timeout: Number(e.target.value) })}
              />
            </label>
            <p className="hint">
              尺寸、质量和参考图能力依服务而定。网页直连需要服务允许跨域访问；返回图片链接时，下载地址也须允许访问。
            </p>
          </details>
          <label className="check">
            <input
              type="checkbox"
              checked={profile.remember}
              onChange={(e) => change({ remember: e.target.checked })}
            />
            在此设备记住生图密钥
          </label>
          <p className="hint">
            未勾选时密钥只保留在当前页面；任何备份与阅读页都不包含密钥。
          </p>
          <div className="row">
            <button className="primary" type="submit">
              保存生图配置
            </button>
            <button
              type="button"
              disabled={!profile.url || !profile.model || !key}
              onClick={async () => {
                setBusy(true);
                setMessage("正在生成测试图…");
                const c = new AbortController();
                setController(c);
                try {
                  const image = await requestImage(
                    imageProfileSchema.parse(profile),
                    key,
                    `一盆放在窗台上的绿植，柔和日光，无人物。${NO_SELFIE}`,
                    [],
                    c.signal,
                  );
                  setPreview(image.data);
                  setMessage("测试图片已收到。满意后请保存配置。");
                } catch (e) {
                  setMessage(String(e));
                } finally {
                  setBusy(false);
                  setController(undefined);
                }
              }}
            >
              生成测试图（消耗一次额度）
            </button>
          </div>
        </fieldset>
      </form>
      {controller && (
        <button onClick={() => controller.abort()}>停止测试</button>
      )}
      {message && <p role="status">{message}</p>}
      {preview && (
        <img
          className="image-test-preview"
          src={preview}
          alt="生图接口测试结果：窗台绿植"
        />
      )}
    </section>
  );
}

export function RoleImageFields({
  role,
  onChange,
  onBusyChange,
}: {
  role: Role;
  onChange: (patch: Partial<Role>) => void;
  onBusyChange?: (busy: boolean) => void;
}) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <details className="role-image-fields">
      <summary>人物插画与拍照习惯</summary>
      <label className="field">
        插画外貌设定
        <textarea
          value={role.imageAppearance || ""}
          onChange={(e) => onChange({ imageAppearance: e.target.value })}
          placeholder="发型、发色、体型、固定特征；只用于配图"
        />
      </label>
      <label className="field">
        人物参考图
        <input
          type="file"
          accept="image/png,image/jpeg,image/webp"
          disabled={busy}
          onChange={async (e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (!file) return;
            setBusy(true);
            onBusyChange?.(true);
            setError("");
            try {
              onChange({ imageReference: await referenceFile(file) });
            } catch (e) {
              setError(String(e));
            } finally {
              setBusy(false);
              onBusyChange?.(false);
            }
          }}
        />
      </label>
      {/^data:image\/(png|jpeg|webp);base64,/.test(
        role.imageReference || "",
      ) && (
        <img
          className="image-reference-preview"
          src={role.imageReference}
          alt={`${role.name}的插画参考图`}
        />
      )}
      <div className="row">
        <button
          type="button"
          disabled={!/^data:image\/(png|jpeg|webp);base64,/.test(role.avatar)}
          onClick={() => onChange({ imageReference: role.avatar })}
        >
          用现有头像作参考
        </button>
        <button
          type="button"
          disabled={!role.imageReference}
          onClick={() => onChange({ imageReference: "" })}
        >
          清除参考图
        </button>
      </div>
      <label className="field">
        角色拍照习惯
        <textarea
          value={role.photoHabit || ""}
          onChange={(e) => onChange({ photoHabit: e.target.value })}
          placeholder="例如偶尔分享风景和食物，被问到时再拍照"
        />
      </label>
      <p className="hint">
        禁止生成自拍。参考图用于正文插画，照片按角色实际能看到和愿意分享的内容生成。
      </p>
      {busy && <p role="status">正在处理参考图…</p>}
      {error && <p role="alert">{error}</p>}
    </details>
  );
}

export function StoryImageSettings({ story }: { story: Story }) {
  const [settings, setSettings] = useState(() => imageSettings(story.images));
  const [error, setError] = useState("");
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
      <StoryImageJobs storyId={story.id} />
    </section>
  );
}
