import { useEffect, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { db } from "./db";
import type { Story } from "./types";
import type {
  PhoneAutomationSettings,
  PhoneAutomationRun,
  PhoneHabit,
} from "./work-types";
import {
  ensureAutomation,
  saveAutomation,
  startAutomation,
  pauseAutomation,
  cancelAutomation,
  continueAutomation,
  adoptAutomation,
  undoAutomation,
  defaultHabit,
  suggestHabits,
  extendRequestLimit,
} from "./phone-automation";
import { Modal } from "./Modal";
import { recordText } from "./phone-store";
import "./automation.css";

const statuses = {
  running: "正在推进",
  paused: "已暂停",
  failed: "需要处理",
  interrupted: "等待恢复",
  complete: "已完成",
  adopted: "已采用",
  undone: "已撤销",
  cancelled: "已结束",
};
const kinds: Record<string, string> = {
  chat: "聊天",
  moment: "发朋友圈",
  comment: "评论",
  like: "点赞",
  note: "备忘录",
  draft: "未发送草稿",
  event: "剧情事件",
  wait: "暂不行动",
};
function HabitEditor({
  value,
  onChange,
}: {
  value: PhoneHabit;
  onChange: (v: PhoneHabit) => void;
}) {
  return (
    <div className="auto-grid">
      <label>
        主动程度
        <select
          value={value.initiative}
          onChange={(e) =>
            onChange({
              ...value,
              initiative: e.target.value as PhoneHabit["initiative"],
            })
          }
        >
          <option value="quiet">安静</option>
          <option value="balanced">适中</option>
          <option value="active">主动</option>
        </select>
      </label>
      <label>
        表达倾向
        <select
          value={value.expression}
          onChange={(e) =>
            onChange({
              ...value,
              expression: e.target.value as PhoneHabit["expression"],
            })
          }
        >
          <option value="private">偏向私下</option>
          <option value="balanced">视情况而定</option>
          <option value="public">偏向公开</option>
        </select>
      </label>
      <label>
        新消息延后几回合阅读
        <input
          type="number"
          min="0"
          max="10"
          value={value.replyDelay}
          onChange={(e) =>
            onChange({ ...value, replyDelay: Number(e.target.value) })
          }
        />
      </label>
      <label>
        每几回合浏览朋友圈
        <input
          type="number"
          min="1"
          max="20"
          value={value.browseEvery}
          onChange={(e) =>
            onChange({ ...value, browseEvery: Number(e.target.value) })
          }
        />
      </label>
      <label className="auto-wide">
        行动偏好
        <textarea
          value={value.preference}
          onChange={(e) => onChange({ ...value, preference: e.target.value })}
          placeholder="例如喜欢给朋友留言，心事更愿意写进备忘录"
        />
      </label>
    </div>
  );
}

export function PhoneAutomation({ story }: { story: Story }) {
  const [settings, setSettings] = useState<PhoneAutomationSettings>(),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false);
  const [temporary, setTemporary] = useState<number>(),
    [open, setOpen] = useState(""),
    [suggestion, setSuggestion] = useState<{
      actorId: string;
      value: PhoneHabit;
    }>();
  const [habitControl, setHabitControl] = useState<AbortController>();
  const runs =
    useLiveQuery(
      () =>
        db.phoneAutomationRuns
          .where("storyId")
          .equals(story.id)
          .reverse()
          .sortBy("created"),
      [story.id],
    ) || [];
  const events =
    useLiveQuery(
      () =>
        db.phoneWorldEvents
          .where("storyId")
          .equals(story.id)
          .filter((e) => !e.deleted)
          .toArray(),
      [story.id],
    ) || [];
  useEffect(() => {
    void ensureAutomation(story.id)
      .then(setSettings)
      .catch((e) => setError(String(e)));
  }, [story.id]);
  useEffect(() => () => habitControl?.abort(), [habitControl]);
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await fn();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  if (!settings) return <p>{error || "正在读取推进设置…"}</p>;
  const patch = (p: Partial<PhoneAutomationSettings>) =>
    setSettings({ ...settings, ...p });
  const active = runs.some((r) => r.status === "running");
  const count = settings.roles.filter(
    (id) => settings.takeover || id !== settings.controlledRole,
  ).length;
  return (
    <div className="automation-panel">
      <header>
        <span className="auto-eyebrow">把接下来的时间，交给角色</span>
        <h2>让故事继续</h2>
        <p>
          一回合，每位选中的 AI
          角色获得一次行动机会。聊天、动态、备忘录，或是暂时沉默，都由角色决定。
        </p>
      </header>
      {error && (
        <p role="alert" className="auto-error">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      <div className="auto-grid">
        <label>
          由你控制的角色
          <select
            aria-label="由你控制的角色"
            value={settings.controlledRole}
            onChange={(e) => patch({ controlledRole: e.target.value })}
          >
            {story.roles.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
        </label>
        <label className="auto-check">
          <input
            type="checkbox"
            checked={settings.takeover}
            onChange={(e) => patch({ takeover: e.target.checked })}
          />
          全员托管，允许 AI 决定我的角色的行动
        </label>
      </div>
      <fieldset>
        <legend>按下列顺序行动</legend>
        <div className="auto-roles">
          {story.roles.map((r) => (
            <label key={r.id}>
              <input
                type="checkbox"
                checked={settings.roles.includes(r.id)}
                onChange={(e) =>
                  patch({
                    roles: e.target.checked
                      ? [...settings.roles, r.id]
                      : settings.roles.filter((id) => id !== r.id),
                  })
                }
              />
              {r.name}
              {!settings.takeover && settings.controlledRole === r.id
                ? " · 由你控制"
                : ""}
            </label>
          ))}
        </div>
        <p className="muted">
          实际顺序：
          {settings.roles
            .filter((id) => settings.takeover || id !== settings.controlledRole)
            .map((id) => story.roles.find((r) => r.id === id)?.name)
            .join(" → ") || "尚未选择 AI 角色"}
          。取消再勾选可调整顺序。
        </p>
      </fieldset>
      <div className="auto-grid">
        <label>
          默认推进回合
          <input
            aria-label="默认推进回合"
            type="number"
            min="1"
            max="100"
            value={settings.rounds}
            onChange={(e) => patch({ rounds: Number(e.target.value) })}
          />
        </label>
        <label>
          每回合剧情分钟
          <input
            type="number"
            min="1"
            max="60"
            value={settings.minutes}
            onChange={(e) => patch({ minutes: Number(e.target.value) })}
          />
        </label>
        <label>
          开始剧情时间
          <input
            type="datetime-local"
            value={settings.startTime.slice(0, 16)}
            onChange={(e) => patch({ startTime: e.target.value })}
          />
        </label>
        <label>
          结束剧情时间（可选）
          <input
            type="datetime-local"
            value={settings.endTime}
            onChange={(e) => patch({ endTime: e.target.value })}
          />
        </label>
        <label>
          请求次数上限（0 为不限）
          <input
            type="number"
            min="0"
            max="10000"
            value={settings.maxRequests}
            onChange={(e) => patch({ maxRequests: Number(e.target.value) })}
          />
        </label>
        <label>
          结果保存方式
          <select
            value={settings.mode}
            onChange={(e) =>
              patch({ mode: e.target.value as "live" | "draft" })
            }
          >
            <option value="live">直接保存，可整批撤销</option>
            <option value="draft">先放入隔离草稿，检查后采用</option>
          </select>
        </label>
        <label>
          剧情自由度
          <select
            value={settings.freedom}
            onChange={(e) =>
              patch({ freedom: e.target.value as "limited" | "active" })
            }
          >
            <option value="limited">有限创造 · 日常小事</option>
            <option value="active">主动发展 · 推动事件与关系</option>
          </select>
        </label>
        <label>
          本次临时回合（不覆盖默认）
          <input
            aria-label="本次临时回合"
            type="number"
            min="1"
            max="100"
            placeholder={String(settings.rounds)}
            value={temporary ?? ""}
            onChange={(e) =>
              setTemporary(e.target.value ? Number(e.target.value) : undefined)
            }
          />
        </label>
        <label className="auto-wide">
          导演提示
          <textarea
            value={settings.direction}
            onChange={(e) => patch({ direction: e.target.value })}
            placeholder="今晚下雨了。让他们各自过一个普通的夜晚。"
          />
          <small>运行中保存的新提示、习惯和自由度，从下一回合生效。</small>
        </label>
      </div>
      <details>
        <summary>角色行动习惯</summary>
        {story.roles.map((r) => (
          <section className="auto-habit" key={r.id}>
            <h3>{r.name}</h3>
            <HabitEditor
              value={settings.habits[r.id] || defaultHabit()}
              onChange={(v) =>
                patch({ habits: { ...settings.habits, [r.id]: v } })
              }
            />
            <button
              disabled={busy || active}
              onClick={() =>
                void act(async () => {
                  const c = new AbortController();
                  setHabitControl(c);
                  setSuggestion({
                    actorId: r.id,
                    value: await suggestHabits(story.id, r.id, c.signal),
                  });
                })
              }
            >
              让 AI 拟定 {r.name} 的习惯
            </button>
          </section>
        ))}
      </details>
      <div className="auto-actions">
        <button
          disabled={busy}
          onClick={() =>
            void act(async () => {
              setSettings(await saveAutomation(settings));
              setNotice("推进设置已保存。");
            })
          }
        >
          保存推进设置
        </button>
        <button
          className="primary"
          disabled={busy || active || !count}
          onClick={() =>
            void act(async () => {
              await saveAutomation(settings);
              const id = await startAutomation(story.id, {
                ...settings,
                rounds: temporary ?? settings.rounds,
              });
              setOpen(id);
            })
          }
        >
          让故事继续 {temporary ?? settings.rounds} 回合
        </button>
        {habitControl && busy && (
          <button onClick={() => habitControl.abort()}>停止整理</button>
        )}
      </div>
      <p className="muted">
        共 {count * (temporary ?? settings.rounds)}{" "}
        次行动机会。等待你回复时，角色可以去做其他事。离开本页不会停止；刷新后需手动恢复。
      </p>
      <h3>推进记录</h3>
      <div className="auto-history">
        {runs
          .slice()
          .sort((a, b) => b.created - a.created)
          .map((r) => (
            <button
              className="auto-run-row"
              key={r.id}
              onClick={() => setOpen(r.id)}
            >
              <strong>{statuses[r.status]}</strong>
              <span>
                {r.round} / {r.options.rounds} 回合 · {r.requests} 次请求 ·{" "}
                {r.options.mode === "draft" ? "隔离草稿" : "直接保存"}
              </span>
              <small>{new Date(r.created).toLocaleString()}</small>
            </button>
          ))}
        {!runs.length && (
          <p className="muted">还没有推进记录。准备好后，开始第一回合。</p>
        )}
      </div>
      {!!events.length && (
        <details>
          <summary>本作品发生的剧情事件（{events.length}）</summary>
          {events.map((e) => (
            <article className="auto-result" key={e.id}>
              <h4>{e.title}</h4>
              <p>{e.text}</p>
              <small>
                {e.time} · 知情：
                {e.audience
                  .map((id) => story.roles.find((r) => r.id === id)?.name)
                  .join("、")}
              </small>
            </article>
          ))}
        </details>
      )}
      {open && <AutomationTask id={open} onClose={() => setOpen("")} />}
      {suggestion && (
        <Modal
          title="确认角色行动习惯"
          onClose={() => setSuggestion(undefined)}
        >
          <HabitEditor
            value={suggestion.value}
            onChange={(value) => setSuggestion({ ...suggestion, value })}
          />
          <button
            onClick={() =>
              void act(async () => {
                const next = {
                  ...settings,
                  habits: {
                    ...settings.habits,
                    [suggestion.actorId]: suggestion.value,
                  },
                };
                setSettings(await saveAutomation(next));
                setSuggestion(undefined);
                setNotice("已保存角色行动习惯。");
              })
            }
          >
            确认保存
          </button>
        </Modal>
      )}
    </div>
  );
}

export function AutomationTask({
  id,
  onClose,
}: {
  id: string;
  onClose: () => void;
}) {
  const run = useLiveQuery(() => db.phoneAutomationRuns.get(id), [id]);
  const steps =
    useLiveQuery(
      () => db.phoneAutomationSteps.where("runId").equals(id).toArray(),
      [id],
    ) || [];
  const prefs = useLiveQuery(() => db.preferences.get("preferences"), []);
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [limit, setLimit] = useState<number>();
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  if (!run) return null;
  const done = steps.filter((s) => s.status === "complete").length;
  const total =
    run.options.rounds *
    run.options.roles.filter(
      (id) => run.options.takeover || id !== run.options.controlledRole,
    ).length;
  return (
    <Modal title="故事推进记录" onClose={onClose}>
      <div className="auto-task">
        <div className="auto-progress">
          <strong>{statuses[run.status]}</strong>
          <span>
            {done} / {total} 次行动机会 · {run.requests} 次请求
          </span>
          <progress value={done} max={total || 1} />
        </div>
        <p>
          {run.options.mode === "draft"
            ? "隔离草稿：采用后才进入正式经历。"
            : "直接保存：每个成功步骤已独立保存。"}
        </p>
        {(error || run.error) && (
          <p role="alert" className="auto-error">
            {error || run.error}
          </p>
        )}
        <div className="auto-actions">
          {["paused", "failed", "interrupted"].includes(run.status) && (
            <button
              disabled={busy}
              onClick={() => void act(() => cancelAutomation(id))}
            >
              结束任务，保留结果
            </button>
          )}
          {run.status === "running" ? (
            <button
              disabled={busy}
              onClick={() => void act(() => pauseAutomation(id))}
            >
              暂停推进
            </button>
          ) : (
            ["paused", "failed", "interrupted"].includes(run.status) && (
              <button
                disabled={busy}
                onClick={() => {
                  setError("");
                  void continueAutomation(id).catch((e) => setError(String(e)));
                }}
              >
                继续未完成步骤
              </button>
            )
          )}
          {run.status !== "running" &&
            run.options.mode === "draft" &&
            !["adopted", "undone"].includes(run.status) &&
            done > 0 && (
              <button
                disabled={busy}
                onClick={() => void act(() => adoptAutomation(id))}
              >
                采用整批草稿
              </button>
            )}
          {run.status !== "running" && steps.some((s) => s.applied) && (
            <>
              <button
                disabled={busy}
                onClick={() => void act(() => undoAutomation(id))}
              >
                撤销本批次
              </button>
              {error.includes("后续自动批次") && (
                <button
                  disabled={busy}
                  onClick={() => void act(() => undoAutomation(id, true))}
                >
                  逆序撤销本批次及依赖它的自动批次
                </button>
              )}
            </>
          )}
        </div>
        {["paused", "failed", "interrupted"].includes(run.status) && (
          <label>
            调整本次请求上限（0 为不限）
            <div className="auto-actions">
              <input
                type="number"
                min="0"
                max="10000"
                value={limit ?? run.options.maxRequests}
                onChange={(e) => setLimit(Number(e.target.value))}
              />
              <button
                disabled={busy}
                onClick={() =>
                  void act(() =>
                    extendRequestLimit(id, limit ?? run.options.maxRequests),
                  )
                }
              >
                保存上限
              </button>
            </div>
          </label>
        )}
        {steps
          .slice()
          .sort((a, b) => a.round - b.round || a.order - b.order)
          .map((s) => (
            <details
              className="auto-result"
              key={s.id}
              open={s.status === "failed" || undefined}
            >
              <summary>
                第 {s.round} 回合 ·{" "}
                {s.roles.find((r) => r.id === s.actorId)?.name} ·{" "}
                {s.action ? kinds[s.action.kind] : "判断行动"} ·{" "}
                {s.status === "complete"
                  ? "完成"
                  : s.status === "running"
                    ? "执行中"
                    : s.status === "failed"
                      ? "未完成"
                      : "等待"}
              </summary>
              {s.action && <p>{s.action.reason}</p>}
              {s.error && <p className="auto-error">{s.error}</p>}
              {s.result?.records.map((r) => (
                <article key={r.id}>
                  <small>
                    {r.time} · {kinds[r.kind] || "聊天"}
                  </small>
                  <p>{recordText(r)}</p>
                </article>
              ))}
              {[
                ...(s.result?.documents || []),
                ...(s.result?.events || []),
              ].map((d) => (
                <article key={d.id}>
                  <strong>{d.title}</strong>
                  <p>{d.text}</p>
                </article>
              ))}
              {s.result?.likes.length ? <p>点赞已收录。</p> : null}
              {prefs?.developer && (
                <details>
                  <summary>开发者：实际请求与参考资料</summary>
                  <pre>
                    {JSON.stringify(
                      {
                        profile: s.profile,
                        refs: s.refs,
                        known: s.readIds,
                        decision: s.decisionRequest,
                        content: s.contentRequest,
                      },
                      null,
                      2,
                    )}
                  </pre>
                </details>
              )}
            </details>
          ))}
      </div>
    </Modal>
  );
}

export function AutomationTaskbar() {
  const rows = useLiveQuery(() => db.phoneAutomationRuns.toArray(), []) || [];
  const stories = useLiveQuery(() => db.stories.toArray(), []) || [];
  const [open, setOpen] = useState("");
  const tasks = rows.filter((r) =>
    ["running", "paused", "failed", "interrupted"].includes(r.status),
  );
  if (!tasks.length && !open) return null;
  return (
    <>
      <aside className="automation-taskbar" aria-label="全局推进任务">
        {tasks.map((r: PhoneAutomationRun) => (
          <div key={r.id}>
            <button onClick={() => setOpen(r.id)}>
              <strong>{stories.find((s) => s.id === r.storyId)?.title}</strong>{" "}
              · {statuses[r.status]} · {r.round}/{r.options.rounds} 回合 ·
              查看结果
            </button>
            {r.status === "running" && (
              <button onClick={() => void pauseAutomation(r.id)}>暂停</button>
            )}
          </div>
        ))}
      </aside>
      {open && <AutomationTask id={open} onClose={() => setOpen("")} />}
    </>
  );
}
