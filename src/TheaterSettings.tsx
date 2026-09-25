import { useEffect, useState } from "react";
import { ChevronDown, ChevronUp, Plus } from "lucide-react";
import { db } from "./db";
import { uid, type Preferences, type Story, type TheaterDensity, type TheaterPresentation, type TheaterPreset } from "./types";
import { allTheaterPresets, builtInTheaterPresets, normalizeTheaterPresentation, selectedTheaterPresets } from "./theater-presets";

type EditableTheaterPreset = Omit<TheaterPreset, "presentation"> & {
  presentation: TheaterPresentation;
};

const theaterPresentations: ReadonlyArray<{
  value: TheaterPresentation;
  label: string;
  hint: string;
}> = [
  { value: "forum", label: "论坛", hint: "主帖、回复和观众标签组成的讨论区。" },
  { value: "body-status", label: "身体状态卡", hint: "按身体部位展示当前状态与变化。" },
  { value: "dialogue", label: "对白拆解", hint: "把原话、表面意思和话外之音分开呈现。" },
  { value: "detail-list", label: "细节清单", hint: "用正文落点和短余味整理容易忽略的细节。" },
  { value: "subtext-card", label: "话外音卡", hint: "把原话、未说出口和留白分开呈现。" },
  { value: "evidence-board", label: "证据板", hint: "用来源、线索和可信程度整理细节。" },
  { value: "relationship-card", label: "关系卡", hint: "展示角色关系、触发点和未解决的问题。" },
  { value: "scene-board", label: "场景声画", hint: "用光线、声音、气味和空间整理场景氛围。" },
  { value: "custom", label: "自由 HTML", hint: "由 AI 自由设计安全的 HTML 小剧场。" },
];

function editablePresentation(value: unknown): TheaterPresentation {
  if (value === "freeform") return "custom";
  const normalized = normalizeTheaterPresentation(value);
  return theaterPresentations.some((item) => item.value === normalized)
    ? normalized
    : "custom";
}

function editableTheaterPreset(preset: TheaterPreset): EditableTheaterPreset {
  return {
    id: preset.id,
    name: preset.name,
    prompt: preset.prompt,
    presentation: editablePresentation(
      (preset as TheaterPreset & { presentation?: unknown }).presentation,
    ),
  };
}

function theaterPresentationLabel(value: unknown) {
  return theaterPresentations.find((item) => item.value === editablePresentation(value))?.label || "自由 HTML";
}

function theaterPresentationHint(value: unknown) {
  return theaterPresentations.find((item) => item.value === editablePresentation(value))?.hint || "由 AI 自由设计安全的 HTML 小剧场。";
}

export function StoryTheaterSettings({ story, prefs, update }: {
  story: Story; prefs?: Preferences; update: (patch: Partial<Story>) => Promise<unknown>;
}) {
  const preferences: Preferences = prefs || { id: "preferences", activeProfile: "", developer: false, prompts: {} };
  const [selection, setSelection] = useState(story.theaterPresetIds);
  const [automatic, setAutomatic] = useState(!!story.theaterAuto);
  const [density, setDensity] = useState<TheaterDensity>(story.theaterDensity || "standard");
  useEffect(() => setSelection(story.theaterPresetIds), [story.id, JSON.stringify(story.theaterPresetIds)]);
  useEffect(() => setAutomatic(!!story.theaterAuto), [story.id, story.theaterAuto]);
  useEffect(() => setDensity(story.theaterDensity || "standard"), [story.id, story.theaterDensity]);
  const selected = selectedTheaterPresets({ ...story, theaterPresetIds: selection }, preferences);
  const ids = selected.map((preset) => preset.id);
  const available = allTheaterPresets(preferences);
  const [error, setError] = useState("");
  async function save(patch: Partial<Story>) {
    setError("");
    if (patch.theaterPresetIds) setSelection(patch.theaterPresetIds);
    if (patch.theaterAuto !== undefined) setAutomatic(patch.theaterAuto);
    if (patch.theaterDensity) setDensity(patch.theaterDensity);
    try { await update(patch); }
    catch {
      setSelection(story.theaterPresetIds);
      setAutomatic(!!story.theaterAuto);
      setDensity(story.theaterDensity || "standard");
      setError("小剧场设置没能保存，请再试一次。");
    }
  }
  function move(index: number, by: number) {
    const next = [...ids];
    [next[index], next[index + by]] = [next[index + by], next[index]];
    void save({ theaterPresetIds: next });
  }
  return <section className="story-theater-settings">
    <h3>小剧场</h3>
    <label className="field theater-density-field"><span>小剧场丰富度</span>
      <select aria-label="小剧场丰富度" value={density} onChange={(event) => void save({ theaterDensity: event.target.value as TheaterDensity })}>
        <option value="light">轻量 · 抓住一两个重点</option>
        <option value="standard">标准 · 适度展开（推荐）</option>
        <option value="rich">丰富 · 更多层次和回应</option>
      </select>
    </label>
    <p className="hint">影响每次生成的小剧场展开程度。旧故事没有设置时按“标准”处理；修改后对下一次生成生效。</p>
    <label className="toggle"><input type="checkbox" checked={automatic}
      onChange={(event) => void save({ theaterAuto: event.target.checked })} /><span>新正文自动生成小剧场</span></label>
    <p className="hint">随新正文一起生成，默认收起。未开启时，可以点击每段下方的小剧场单独生成。</p>
    <p className="hint">当前内容：{selected.map((preset) => preset.name).join("、") || "尚未选择"}</p>
    {prefs?.developer && <div className="theater-story-presets">
      <h4>这本故事的小剧场内容</h4>
      <p className="hint">可以选择多项，按下面的顺序呈现。修改后对下一次生成生效。</p>
      <div className="theater-preset-choices">
        {available.map((preset) => <label className="toggle" key={preset.id}>
          <input type="checkbox" checked={ids.includes(preset.id)} disabled={ids.length === 1 && ids.includes(preset.id)}
            onChange={(event) => void save({ theaterPresetIds: event.target.checked ? [...ids, preset.id] : ids.filter((id) => id !== preset.id) })} />
          <span>{preset.name}</span>
        </label>)}
      </div>
      <ol className="theater-preset-order">
        {selected.map((preset, index) => <li key={preset.id}>
          <span>{index + 1}. {preset.name}</span><div>
            <button type="button" aria-label={"上移" + preset.name} disabled={index === 0} onClick={() => move(index, -1)}><ChevronUp size={16} /></button>
            <button type="button" aria-label={"下移" + preset.name} disabled={index === selected.length - 1} onClick={() => move(index, 1)}><ChevronDown size={16} /></button>
          </div>
        </li>)}
      </ol>
    </div>}
    {error && <p className="error" role="alert">{error}</p>}
  </section>;
}

export function TheaterPresetSettings({ prefs, notify }: { prefs: Preferences; notify: (message: string) => void }) {
  const [editing, setEditing] = useState<EditableTheaterPreset>();
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const custom = (prefs.theaterPresets || []).map(editableTheaterPreset);
  async function persist(next: EditableTheaterPreset[], message: string) {
    setSaving(true);
    setError("");
    try { await db.preferences.update("preferences", { theaterPresets: next as TheaterPreset[] }); notify(message); setEditing(undefined); }
    catch { setError("预设没能保存，请再试一次。"); }
    finally { setSaving(false); }
  }
  async function removePreset(id: string) {
    setSaving(true);
    setError("");
    try {
      await db.transaction("rw", [db.preferences, db.stories], async () => {
        const latest = await db.preferences.get("preferences");
        await db.preferences.update("preferences", {
          theaterPresets: (latest?.theaterPresets || [])
            .filter((item) => item.id !== id)
            .map(editableTheaterPreset) as TheaterPreset[],
        });
        for (const story of await db.stories.toArray()) {
          if (!story.theaterPresetIds?.includes(id)) continue;
          const selected = story.theaterPresetIds.filter((presetId) => presetId !== id);
          await db.stories.update(story.id, { theaterPresetIds: selected.length ? selected : ["theater-roast"] });
        }
      });
      if (editing?.id === id) setEditing(undefined);
      notify("小剧场预设已删除，原有小剧场仍会保留");
    } catch { setError("预设没能删除，请再试一次。"); }
    finally { setSaving(false); }
  }
  return <section className="settings-card theater-preset-settings">
    <div className="section-title"><div><h2>小剧场预设</h2><p className="hint">给幕间内容起个名字，写下你想看的内容。每本故事可以选择多项并调整顺序。</p></div>
      <button onClick={() => setEditing({ id: uid(), name: "", prompt: "", presentation: "custom" })}><Plus size={16} />新建小剧场预设</button></div>
    <div className="style-preset-grid">
      {allTheaterPresets(prefs).map((preset) => {
        const builtin = builtInTheaterPresets.some((item) => item.id === preset.id);
        const overridden = builtin && custom.some((item) => item.id === preset.id);
        return <article className="style-preset-card" key={preset.id}>
          <span className="tag">{builtin ? overridden ? "内置 · 已修改" : "内置" : "自定义"}</span>
          <strong>{preset.name}</strong><p className="theater-preset-description">{preset.prompt}</p>
          <p className="hint">展示样式：{theaterPresentationLabel((preset as TheaterPreset & { presentation?: unknown }).presentation)}</p>
          <div className="row"><button onClick={() => setEditing(editableTheaterPreset(preset))}>编辑</button>
            <button onClick={() => setEditing({ ...editableTheaterPreset(preset), id: uid(), name: preset.name + "（副本）" })}>复制</button>
            {overridden && <button disabled={saving} onClick={() => void persist(custom.filter((item) => item.id !== preset.id), "已恢复内置小剧场预设")}>恢复内置</button>}
            {!builtin && <button disabled={saving} onClick={() => void removePreset(preset.id)}>删除</button>}
          </div>
        </article>;
      })}
    </div>
    {editing && <div className="inline-editor theater-preset-editor">
      <h3>编辑小剧场预设</h3>
      <label className="field"><span>小剧场预设名称</span><input value={editing.name} maxLength={80} onChange={(event) => setEditing({ ...editing, name: event.target.value })} /></label>
      <label className="field"><span>小剧场内容要求</span><textarea className="long-text" value={editing.prompt}
        onChange={(event) => setEditing({ ...editing, prompt: event.target.value })} placeholder="写下这段小剧场想呈现的内容、语气或排版。" /></label>
      <label className="field"><span>专属展示样式</span><select aria-label="小剧场专属展示样式" value={editing.presentation}
        onChange={(event) => setEditing({ ...editing, presentation: editablePresentation(event.target.value) })}>
        {theaterPresentations.map((item) => <option value={item.value} key={item.value}>{item.label}</option>)}
      </select></label>
      <p className="hint">{theaterPresentationHint(editing.presentation)}</p>
      <div className="row"><button className="primary" disabled={saving || !editing.name.trim() || !editing.prompt.trim()}
        onClick={() => void persist([...custom.filter((item) => item.id !== editing.id), {
          ...editing,
          name: editing.name.trim(),
          prompt: editing.prompt.trim(),
          presentation: editablePresentation(editing.presentation),
        }], "小剧场预设已保存")}>保存小剧场预设</button>
        <button disabled={saving} onClick={() => setEditing(undefined)}>取消</button></div>
    </div>}
    {error && <p className="error" role="alert">{error}</p>}
  </section>;
}
