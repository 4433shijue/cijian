import { useEffect, useRef, useState } from "react";
import { uid, type Role, type WorldEntry } from "./types";
import type { GeneratorInput, GeneratorSelection } from "./generator-types";

export function GuidedStart({
  input,
  onChange,
  roles,
  worlds,
  selections,
  onSelect,
  disabled,
  onStart,
}: {
  input: GeneratorInput;
  onChange: (v: GeneratorInput) => void;
  roles: Role[];
  worlds: WorldEntry[];
  selections: GeneratorSelection[];
  onSelect: (v: GeneratorSelection[]) => void;
  disabled: boolean;
  onStart: () => void;
}) {
  const kind = input.creationKind || "solo";
  const [search, setSearch] = useState("");
  const targets = input.targets.length
    ? input.targets
    : [{ id: uid(), name: "", roleKind: "暂不定" }];
  const chooseKind = (creationKind: GeneratorInput["creationKind"]) => {
    const next = targets.slice(0, creationKind === "pair" ? 2 : 1);
    if (creationKind === "pair" && next.length < 2)
      next.push({ id: uid(), name: "", roleKind: "暂不定" });
    onChange({
      ...input,
      creationKind,
      multiple: creationKind === "pair",
      targets: next,
    });
  };
  return (
    <fieldset className="workshop-start" disabled={disabled}>
      <legend>从一点喜欢的感觉开始</legend>
      <label>
        这次想怎么捏
        <select
          aria-label="这次想怎么捏"
          value={kind}
          onChange={(e) => chooseKind(e.target.value as typeof kind)}
        >
          <option value="solo">先捏一个人</option>
          <option value="partner">给已有角色捏搭档</option>
          <option value="pair">一起捏一对</option>
        </select>
      </label>
      <div className="workshop-targets">
        {targets.map((t, i) => (
          <div key={t.id}>
            <label>
              {targets.length > 1 ? `第 ${i + 1} 位的定位` : "角色定位"}
              <select
                aria-label={`角色定位 ${i + 1}`}
                value={t.roleKind || "暂不定"}
                onChange={(e) =>
                  onChange({
                    ...input,
                    targets: targets.map((x) =>
                      x.id === t.id ? { ...x, roleKind: e.target.value } : x,
                    ),
                  })
                }
              >
                {["暂不定", "攻", "受", "男主", "女主", "其他"].map((k) => (
                  <option key={k}>{k}</option>
                ))}
              </select>
            </label>
            <label>
              名字或暂称（可以不填）
              <input
                aria-label={`角色名字 ${i + 1}`}
                value={t.autoName ? "" : t.name}
                onChange={(e) =>
                  onChange({
                    ...input,
                    targets: targets.map((x) =>
                      x.id === t.id
                        ? { ...x, name: e.target.value, autoName: false }
                        : x,
                    ),
                  })
                }
                placeholder="名字可以聊着再想"
              />
            </label>
          </div>
        ))}
      </div>
      {kind === "partner" && (
        <label>
          为谁捏搭档
          <select
            aria-label="为谁捏搭档"
            value={
              selections.find(
                (x) => x.kind === "role" && x.purpose === "relationship",
              )?.sourceId || ""
            }
            onChange={(e) =>
              onSelect([
                ...selections.filter(
                  (x) => !(x.kind === "role" && x.purpose === "relationship"),
                ),
                ...(e.target.value
                  ? [
                      {
                        kind: "role" as const,
                        sourceId: e.target.value,
                        purpose: "relationship" as const,
                      },
                    ]
                  : []),
              ])
            }
          >
            <option value="">选择一位已有角色</option>
            {roles.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
        </label>
      )}
      <label>
        你现在有的想法
        <textarea
          aria-label="你现在有的想法"
          value={input.guidance}
          onChange={(e) =>
            onChange({ ...input, guidance: e.target.value, targets })
          }
          placeholder="比如：想要一个温柔但有距离感的攻。也可以什么都不填，我们一起想。"
        />
      </label>
      <label>
        聊天节奏
        <select
          aria-label="聊天节奏"
          value={input.pace || "gentle"}
          onChange={(e) =>
            onChange({
              ...input,
              pace: e.target.value as GeneratorInput["pace"],
              targets,
            })
          }
        >
          <option value="gentle">慢慢聊 · 一次一个问题</option>
          <option value="quick">快速聊 · 一次两三个问题</option>
        </select>
      </label>
      <details>
        <summary>
          已有设定与参考资料
          {selections.length ? ` · 已选 ${selections.length} 项` : "（可选）"}
        </summary>
        <label>
          已经写下的设定
          <textarea
            aria-label="已经写下的设定"
            value={input.source}
            onChange={(e) =>
              onChange({ ...input, source: e.target.value, targets })
            }
          />
        </label>
        <label>
          搜索参考
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="角色或世界书"
          />
        </label>
        <div className="generator-library">
          {[
            ...roles.map((r) => ({
              id: r.id,
              label: r.name,
              text: r.persona,
              kind: "role" as const,
            })),
            ...worlds.map((w) => ({
              id: w.id,
              label: w.title,
              text: w.text,
              kind: "world" as const,
            })),
          ]
            .filter((r) => (r.label + r.text).includes(search))
            .map((r) => {
              const selected = selections.find(
                (s) => s.sourceId === r.id && s.kind === r.kind,
              );
              return (
                <article key={r.kind + r.id}>
                  <label className="generator-check">
                    <input
                      type="checkbox"
                      checked={!!selected}
                      onChange={(e) =>
                        onSelect(
                          e.target.checked
                            ? [
                                ...selections,
                                {
                                  sourceId: r.id,
                                  kind: r.kind,
                                  purpose:
                                    r.kind === "role"
                                      ? "relationship"
                                      : "world",
                                },
                              ]
                            : selections.filter((s) => s !== selected),
                        )
                      }
                    />
                    {r.label}
                  </label>
                  {selected && r.kind === "role" && (
                    <label>
                      参考用途
                      <select
                        value={selected.purpose}
                        onChange={(e) =>
                          onSelect(
                            selections.map((s) =>
                              s === selected
                                ? {
                                    ...s,
                                    purpose: e.target
                                      .value as GeneratorSelection["purpose"],
                                  }
                                : s,
                            ),
                          )
                        }
                      >
                        <option value="relationship">人物关系参考</option>
                        <option value="style">风格参考</option>
                        <option value="target">改写目标</option>
                      </select>
                    </label>
                  )}
                  <details>
                    <summary>预览{r.label}</summary>
                    <p>{r.text}</p>
                  </details>
                </article>
              );
            })}
        </div>
        <p className="hint">只参考你选中的资料；已有角色与世界书会保留原样。</p>
      </details>
      <button className="primary" onClick={onStart}>
        开始一起捏角色
      </button>
    </fieldset>
  );
}

export function FloatingSettings({
  items,
  conflicts,
  unknown,
  disabled,
  onSave,
}: {
  items: string[];
  conflicts: string[];
  unknown: string[];
  disabled: boolean;
  onSave: (from: string, to: string) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [edit, setEdit] = useState<{ from: string; text: string }>();
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const root = useRef<HTMLElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      const top = Array.from(document.querySelectorAll('[role="dialog"]')).at(
        -1,
      );
      if (top && !top.contains(root.current)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      setOpen(false);
      toggle.current?.focus();
    };
    document.addEventListener("keydown", close, true);
    return () => document.removeEventListener("keydown", close, true);
  }, [open]);
  useEffect(() => {
    const viewport = window.visualViewport;
    const adjust = () =>
      root.current?.style.setProperty(
        "--keyboard-inset",
        `${Math.max(0, window.innerHeight - (viewport?.height || window.innerHeight) - (viewport?.offsetTop || 0))}px`,
      );
    adjust();
    viewport?.addEventListener("resize", adjust);
    viewport?.addEventListener("scroll", adjust);
    return () => {
      viewport?.removeEventListener("resize", adjust);
      viewport?.removeEventListener("scroll", adjust);
    };
  }, []);
  function collapse() {
    setOpen(false);
    toggle.current?.focus();
  }
  return (
    <aside
      ref={root}
      className={`workshop-floating ${open ? "expanded" : ""}`}
      aria-label="已确定设定浮窗"
      onKeyDown={(e) => {
        if (e.key === "Escape" && open) {
          e.preventDefault();
          e.stopPropagation();
          collapse();
        }
      }}
    >
      <button
        ref={toggle}
        className="workshop-floating-toggle"
        aria-expanded={open}
        aria-controls="workshop-confirmed"
        onClick={() => setOpen(!open)}
      >
        {open ? "收起已确定设定" : `已确定设定 · ${items.length}`}
        <span aria-hidden="true">{open ? "⌄" : "⌃"}</span>
      </button>
      {open && (
        <div id="workshop-confirmed" className="workshop-floating-body">
          <p className="hint">随时改一条，后面的对话会跟着调整。</p>
          <ul>
            {items.map((text, i) => (
              <li key={i}>
                <span>{text}</span>
                <button
                  disabled={disabled || saving}
                  aria-label={`修改设定 ${i + 1}`}
                  onClick={() => {
                    setEdit({ from: text, text });
                    setError("");
                  }}
                >
                  修改
                </button>
              </li>
            ))}
          </ul>
          {!items.length && <p>聊过的确定设定会收在这里。</p>}
          <button
            disabled={disabled || saving}
            onClick={() => {
              setEdit({ from: "", text: "" });
              setError("");
            }}
          >
            补充一条设定
          </button>
          {edit && (
            <div className="workshop-setting-editor">
              <label>
                修改设定
                <textarea
                  autoFocus
                  aria-label="修改设定内容"
                  value={edit.text}
                  disabled={saving}
                  onChange={(e) => setEdit({ ...edit, text: e.target.value })}
                />
              </label>
              <p className="hint">
                清空后保存可撤回这条设定。保存前的输入会保留在浮窗中。
              </p>
              <div className="generator-inline">
                <button
                  disabled={disabled || saving}
                  onClick={async () => {
                    setSaving(true);
                    setError("");
                    try {
                      await onSave(edit.from, edit.text);
                      setEdit(undefined);
                    } catch (e) {
                      setError(e instanceof Error ? e.message : String(e));
                    } finally {
                      setSaving(false);
                    }
                  }}
                >
                  保存设定
                </button>
                <button disabled={saving} onClick={() => setEdit(undefined)}>
                  取消修改
                </button>
              </div>
            </div>
          )}
          {error && (
            <p role="alert" className="error">
              {error}
            </p>
          )}
          {!!conflicts.length && (
            <details>
              <summary>还需要讨论</summary>
              {conflicts.map((x, i) => (
                <p key={i}>{x}</p>
              ))}
            </details>
          )}
          {!!unknown.length && (
            <details>
              <summary>暂时留白</summary>
              {unknown.map((x, i) => (
                <p key={i}>{x}</p>
              ))}
            </details>
          )}
        </div>
      )}
    </aside>
  );
}
