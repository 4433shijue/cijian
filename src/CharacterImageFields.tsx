import { useState } from "react";
import type { Role } from "./types";
import { uid } from "./types";
import { referenceFile } from "./image-provider";
import {
  referenceViews,
  roleImageReferences,
  type CharacterImageReference,
} from "./image-styles";
import { ImageStylePicker } from "./ImageStylePicker";

export function CharacterImageFields({
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
  const refs = roleImageReferences(role);
  const saveRefs = (next: CharacterImageReference[]) =>
    onChange({ imageReference: "", imageReferences: next });
  const add = (data: string, name: string) => {
    if (refs.length >= 12)
      throw Error("每位角色最多保存 12 张定妆图，请先移除不需要的参考");
    if (refs.some((r) => r.data === data))
      throw Error("这张图片已经在定妆图中");
    saveRefs([...refs, { id: uid(), name, data, view: "front", styleId: "" }]);
  };
  const update = (id: string, patch: Partial<CharacterImageReference>) =>
    saveRefs(refs.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  return (
    <details className="role-image-fields">
      <summary>角色定妆与拍照习惯</summary>
      <p className="hint">
        文字外貌始终参与配图，适合所有生图模型。启用参考图的接口会同时使用图片。固定长相与本场造型分开保存，换画风也保留角色特征。
      </p>
      <label className="field">
        插画外貌设定 · 固定长相
        <textarea
          aria-label="插画外貌设定 · 固定长相"
          maxLength={4000}
          value={role.imageAppearance || ""}
          onChange={(e) => onChange({ imageAppearance: e.target.value })}
          placeholder="年龄感、脸型和骨相、眼型与瞳色、发色、身高体型、痣或疤等辨识特征。可只填写文字，不上传图片。"
        />
      </label>
      <label className="field">
        本场造型
        <textarea
          aria-label="本场造型"
          maxLength={2000}
          value={role.imageLook || ""}
          onChange={(e) => onChange({ imageLook: e.target.value })}
          placeholder="衣服、发型整理、首饰等；留空则按正文。换衣服不改变固定长相。"
        />
      </label>
      <label className="field">
        添加人物参考图
        <input
          type="file"
          accept="image/png,image/jpeg,image/webp"
          disabled={busy || refs.length >= 12}
          onChange={async (e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (!file) return;
            setBusy(true);
            onBusyChange?.(true);
            setError("");
            try {
              add(await referenceFile(file), file.name.slice(0, 100));
            } catch (e) {
              setError(String(e));
            } finally {
              setBusy(false);
              onBusyChange?.(false);
            }
          }}
        />
      </label>
      <div className="row">
        <button
          type="button"
          disabled={
            busy || !/^data:image\/(png|jpeg|webp);base64,/.test(role.avatar)
          }
          onClick={() => {
            try {
              add(role.avatar, "角色头像");
              setError("");
            } catch (e) {
              setError(String(e));
            }
          }}
        >
          用现有头像作参考
        </button>
      </div>
      <div className="character-reference-grid">
        {refs.map((ref) => (
          <div className="character-reference-card" key={ref.id}>
            <img
              className="image-reference-preview"
              src={ref.data}
              alt={`${role.name}的定妆图：${ref.name}`}
            />
            <label className="field">
              定妆图名称
              <input
                maxLength={100}
                value={ref.name}
                onChange={(e) => update(ref.id, { name: e.target.value })}
              />
            </label>
            <label className="field">
              参考视角
              <select
                aria-label="参考视角"
                value={ref.view}
                onChange={(e) =>
                  update(ref.id, {
                    view: e.target.value as CharacterImageReference["view"],
                  })
                }
              >
                {Object.entries(referenceViews).map(([id, name]) => (
                  <option key={id} value={id}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
            <ImageStylePicker
              value={ref.styleId}
              label="适用画风"
              inherited="通用定妆 · 所有画风"
              onChange={(styleId) => update(ref.id, { styleId })}
            />
            <button
              type="button"
              onClick={() => saveRefs(refs.filter((r) => r.id !== ref.id))}
            >
              移除此参考图
            </button>
          </div>
        ))}
      </div>
      <p className="hint">
        同画风的定妆图优先，没有时使用通用定妆。每位人物按上方顺序最多使用 3
        张，每次请求合计最多 12
        张；不同人物分别标注，不混用脸。图片无法保证完全一致，模型能力也会影响效果。
      </p>
      <label className="field">
        角色拍照习惯
        <textarea
          aria-label="角色拍照习惯"
          value={role.photoHabit || ""}
          onChange={(e) => onChange({ photoHabit: e.target.value })}
          placeholder="例如偶尔分享风景和食物，被问到时再拍照"
        />
      </label>
      <p className="hint">
        禁止生成自拍。定妆资料用于正文插画；手机照片保持角色实际可拍摄与可分享的范围，拍摄者不入镜。
      </p>
      {busy && <p role="status">正在处理参考图…</p>}
      {error && <p role="alert">{error}</p>}
    </details>
  );
}
