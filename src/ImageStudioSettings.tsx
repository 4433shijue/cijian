import { useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { db } from "./db";
import { uid } from "./types";
import {
  builtInImageStyles,
  imageStyleOptions,
  imageStyleSchema,
  imagePlanningDefaults,
  imageStudioExportSchema,
  type ImageStyle,
} from "./image-styles";
import { isSelfie } from "./image-types";

export default function ImageStudioSettings() {
  const prefs = useLiveQuery(() => db.preferences.get("preferences"), []);
  const [selected, setSelected] = useState("korean-3d");
  const [draft, setDraft] = useState<ImageStyle>();
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const options = imageStyleOptions(prefs?.imageStylePresets);
  const value = draft || options.find((p) => p.id === selected) || options[0];
  const change = (patch: Partial<ImageStyle>) =>
    setDraft({ ...value, ...patch });
  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    try {
      await work();
    } catch (e) {
      setMessage(String(e));
    } finally {
      setBusy(false);
    }
  };
  const save = async (presets: ImageStyle[]) => {
    await db.transaction("rw", db.preferences, db.stories, async () => {
      await db.preferences.update("preferences", {
        imageStylePresets: presets,
      });
      const available = imageStyleOptions(presets);
      // Existing pictures/jobs keep their snapshots; only future pictures change.
      for (const story of await db.stories.toArray()) {
        const preset = available.find(
          (p) => p.id === story.images?.stylePresetId,
        );
        if (preset)
          await db.stories.update(story.id, {
            images: { ...story.images!, stylePresetSnapshot: preset },
          });
      }
    });
  };
  if (!prefs) return null;
  return (
    <section className="settings-card image-settings image-studio-settings">
      <h2>绘画工作室 · 开发者</h2>
      <p className="hint">
        编辑画风和画面编排。保存只影响以后的配图，旧图与已排队任务保留原来的设定。切换画风在作品设置或单张配图处完成。
      </p>
      <fieldset disabled={busy}>
        <label className="field">
          编辑绘画预设
          <select
            aria-label="编辑绘画预设"
            value={value.id}
            onChange={(e) => {
              if (draft && !confirm("放弃未保存的画风修改？")) return;
              setSelected(e.target.value);
              setDraft(undefined);
              setMessage("");
            }}
          >
            {options.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          画风名称
          <input
            maxLength={80}
            value={value.name}
            onChange={(e) => change({ name: e.target.value })}
          />
        </label>
        <label className="field">
          正向画风提示词
          <textarea
            aria-label="正向画风提示词"
            rows={7}
            maxLength={6000}
            value={value.positive}
            onChange={(e) => change({ positive: e.target.value })}
          />
        </label>
        <label className="field">
          避免元素
          <textarea
            aria-label="避免元素"
            rows={4}
            maxLength={3000}
            value={value.negative}
            onChange={(e) => change({ negative: e.target.value })}
          />
        </label>
        <div className="row image-connection-actions">
          <button
            onClick={() =>
              void run(async () => {
                const clean = imageStyleSchema.parse(value);
                if (isSelfie(clean.positive))
                  throw Error(
                    "画风提示词包含自拍要求，请删除；禁止自拍规则由系统统一追加",
                  );
                const current = await db.preferences.get("preferences");
                await save([
                  ...(current?.imageStylePresets || []).filter(
                    (p) => p.id !== clean.id,
                  ),
                  clean,
                ]);
                setDraft(undefined);
                setMessage("画风已保存，未发送生图请求");
              })
            }
          >
            保存画风预设
          </button>
          <button
            onClick={() =>
              void run(async () => {
                const clean = imageStyleSchema.parse({
                  ...value,
                  id: uid(),
                  name: value.name.slice(0, 70) + " · 副本",
                });
                const current = await db.preferences.get("preferences");
                if ((current?.imageStylePresets?.length || 0) >= 100)
                  throw Error("最多保存 100 个自定义预设");
                await save([...(current?.imageStylePresets || []), clean]);
                setSelected(clean.id);
                setDraft(undefined);
                setMessage("已复制为独立画风，可以继续编辑");
              })
            }
          >
            复制为自定义画风
          </button>
          <button
            onClick={() => {
              if (
                confirm(
                  builtInImageStyles.some((p) => p.id === value.id)
                    ? "恢复这项画风的内置默认提示词？"
                    : "删除这个自定义画风？作品已保存的画风副本仍会保留。",
                )
              )
                void run(async () => {
                  const current = await db.preferences.get("preferences");
                  await save(
                    (current?.imageStylePresets || []).filter(
                      (p) => p.id !== value.id,
                    ),
                  );
                  setDraft(undefined);
                  setSelected(
                    builtInImageStyles.some((p) => p.id === value.id)
                      ? value.id
                      : "korean-3d",
                  );
                  setMessage("已更新画风预设");
                });
            }}
          >
            {builtInImageStyles.some((p) => p.id === value.id)
              ? "恢复此画风默认"
              : "删除自定义画风"}
          </button>
        </div>
        <details>
          <summary>画面编排提示词</summary>
          {(["novel", "phone"] as const).map((kind) => (
            <PlanningEditor
              key={kind + JSON.stringify(prefs.imagePromptOverrides?.[kind])}
              kind={kind}
              value={prefs.imagePromptOverrides?.[kind]}
              onSave={(text, enabled) =>
                run(async () => {
                  await db.transaction("rw", db.preferences, async () => {
                    const current = await db.preferences.get("preferences");
                    await db.preferences.update("preferences", {
                      imagePromptOverrides: {
                        ...current?.imagePromptOverrides,
                        [kind]: { text, enabled },
                      },
                    });
                  });
                  setMessage("画面编排已保存");
                })
              }
            />
          ))}
        </details>
        <p className="hint">
          禁止自拍、手机拍摄者不入镜、人物知情范围与结构化输出规则固定保留。每张配图的“生图设定”中可查看实际发送的最终提示词。
        </p>
        <div className="row image-connection-actions">
          <button
            onClick={() => {
              const data = imageStudioExportSchema.parse({
                format: "cijian-image-studio",
                version: 1,
                presets: options,
                planning: prefs.imagePromptOverrides,
              });
              const url = URL.createObjectURL(
                new Blob([JSON.stringify(data, null, 2)], {
                  type: "application/json",
                }),
              );
              const a = document.createElement("a");
              a.href = url;
              a.download = "此间-绘画预设.json";
              a.click();
              setTimeout(() => URL.revokeObjectURL(url), 1000);
              setMessage(
                "已导出已保存的画风与编排提示词，不包含密钥或角色图片",
              );
            }}
          >
            导出绘画预设
          </button>
          <label className="field">
            导入绘画预设
            <input
              type="file"
              accept=".json,application/json"
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = "";
                if (!file) return;
                void run(async () => {
                  if (file.size > 2 * 1024 * 1024)
                    throw Error("预设文件不能超过 2 MiB");
                  const data = imageStudioExportSchema.parse(
                    JSON.parse(await file.text()),
                  );
                  if (data.presets.some((p) => isSelfie(p.positive)))
                    throw Error("导入的正向画风包含自拍要求，未导入");
                  if (
                    !confirm(
                      `导入 ${data.presets.length} 项画风？同名编号会覆盖已保存预设，旧图保留。`,
                    )
                  )
                    return;
                  const current = await db.preferences.get("preferences");
                  const merged = new Map(
                    (current?.imageStylePresets || []).map((p) => [p.id, p]),
                  );
                  data.presets.forEach((p) => merged.set(p.id, p));
                  if (merged.size > 100)
                    throw Error(
                      "合并后超过 100 项预设，请先删除不需要的自定义画风",
                    );
                  await save([...merged.values()]);
                  if (data.planning)
                    await db.preferences.update("preferences", {
                      imagePromptOverrides: data.planning,
                    });
                  setDraft(undefined);
                  setMessage("绘画预设已导入，未发送生图请求");
                });
              }}
            />
          </label>
        </div>
      </fieldset>
      <p role="status">{message}</p>
    </section>
  );
}
function PlanningEditor({
  kind,
  value,
  onSave,
}: {
  kind: "novel" | "phone";
  value?: { text: string; enabled: boolean };
  onSave: (text: string, enabled: boolean) => Promise<void>;
}) {
  const [text, setText] = useState(value?.text ?? imagePlanningDefaults[kind]);
  const [enabled, setEnabled] = useState(value?.enabled || false);
  return (
    <div className="image-planning-editor">
      <label className="field">
        {kind === "novel" ? "正文画面编排" : "手机照片编排"}
        <textarea
          aria-label={kind === "novel" ? "正文画面编排" : "手机照片编排"}
          rows={5}
          maxLength={6000}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
      </label>
      <label>
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
        />
        启用此编排提示词
      </label>
      <div className="row">
        <button onClick={() => void onSave(text, enabled)}>
          保存{kind === "novel" ? "正文" : "手机"}编排
        </button>
        <button
          onClick={() => {
            setText(imagePlanningDefaults[kind]);
            setEnabled(false);
            void onSave(imagePlanningDefaults[kind], false);
          }}
        >
          恢复{kind === "novel" ? "正文" : "手机"}默认编排
        </button>
      </div>
    </div>
  );
}
