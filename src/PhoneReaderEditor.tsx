import { useEffect, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { db } from "./db";
import { uid, type Story } from "./types";
import {
  ensureReading,
  saveReading,
  buildReaderPackage,
  validateReader,
  createReaderHTML,
  readerTargetKey,
} from "./phone-reader";
import {
  readerApps,
  type PhoneReading,
  type ReaderTarget,
  type ReaderRule,
} from "./work-types";
import { download } from "./export-utils";
import { Modal } from "./Modal";

export function PhoneReaderEditor({ story }: { story: Story }) {
  const [value, setValue] = useState<PhoneReading>(),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [preview, setPreview] = useState(""),
    [checked, setChecked] = useState<string[]>(),
    [performanceConversation, setPerformanceConversation] = useState("");
  const records =
    useLiveQuery(
      () =>
        db.phoneRecords
          .where("storyId")
          .equals(story.id)
          .filter((r) => !r.deleted && !r.legacyDraft)
          .sortBy("seq"),
      [story.id],
    ) || [];
  const docs =
    useLiveQuery(
      () =>
        db.phoneDocuments
          .where("storyId")
          .equals(story.id)
          .filter((d) => !d.deleted)
          .toArray(),
      [story.id],
    ) || [];
  const conversations =
    useLiveQuery(
      () => db.phoneConversations.where("storyId").equals(story.id).toArray(),
      [story.id],
    ) || [];
  useEffect(() => {
    void ensureReading(story.id)
      .then(setValue)
      .catch((e) => setError(String(e)));
  }, [story.id]);
  const labels: Record<string, string> = {
    messages: "消息",
    contacts: "联系人",
    moments: "朋友圈",
    notes: "备忘录",
    photos: "相册",
    drafts: "草稿箱",
  };
  const name = (id: string) =>
    story.roles.find((r) => r.id === id)?.name || "角色";
  const action = async (fn: () => Promise<unknown>) => {
    if (busy) return;
    setError("");
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  if (!value) return <p>{error || "正在打开阅读设置…"}</p>;
  const cfg = value;
  const change = (patch: Partial<PhoneReading>) => {
    setValue({ ...cfg, ...patch });
    setChecked(undefined);
  };
  const updateRule = (id: string, patch: Partial<ReaderRule>) =>
    change({
      rules: cfg.rules.map((r) => (r.id === id ? { ...r, ...patch } : r)),
    });
  const targets = (
    owner: string,
    apps = true,
  ): { target: ReaderTarget; label: string }[] => [
    ...(apps
      ? cfg.apps.map((id) => ({
          target: { ownerId: owner, type: "app" as const, id },
          label: "整个应用 · " + labels[id],
        }))
      : []),
    ...records
      .filter((r) => r.audience.includes(owner))
      .map((r) => ({
        target: { ownerId: owner, type: "record" as const, id: r.id },
        label: `${r.kind === "moment" ? "朋友圈" : r.kind === "comment" ? "评论" : "消息"} · ${name(r.speakerId)} · ${r.retracted ? "已撤回" : r.body.text.slice(0, 65) || r.body.type}`,
      })),
    ...docs
      .filter((d) => d.audience.includes(owner))
      .map((d) => ({
        target: { ownerId: owner, type: "document" as const, id: d.id },
        label: `${d.kind === "note" ? "备忘录" : d.kind === "photo" ? "照片" : "草稿"} · ${d.title}`,
      })),
  ];
  const save = async () => {
    const next = await saveReading(cfg);
    setValue(next);
    return next;
  };
  const pack = async () => {
    const saved = await save();
    const data = await buildReaderPackage(story.id, saved);
    const errors = validateReader(data);
    setChecked(errors);
    if (errors.length) throw Error("请先修正下方阅读依赖问题");
    return data;
  };
  return (
    <section className="work-section">
      <h2>把手机编成一部可探索的作品</h2>
      <p>
        选择可以分享的手机、安排线索与演出，再以读者身份预览。读者从开场就能切换所选机主。
      </p>
      <details open className="work-card">
        <summary>开场与手机桌面</summary>
        <label className="field">
          开场文字
          <textarea
            value={cfg.opening}
            onChange={(e) => change({ opening: e.target.value })}
          />
        </label>
        <fieldset>
          <legend>允许读者切换的手机</legend>
          {story.roles.map((r) => (
            <label className="toggle" key={r.id}>
              <input
                type="checkbox"
                checked={cfg.owners.includes(r.id)}
                onChange={(e) => {
                  const owners = e.target.checked
                    ? [...cfg.owners, r.id]
                    : cfg.owners.filter((id) => id !== r.id);
                  change({
                    owners,
                    initialOwner: owners.includes(cfg.initialOwner)
                      ? cfg.initialOwner
                      : owners[0] || "",
                  });
                }}
              />
              {r.name}
            </label>
          ))}
        </fieldset>
        <label className="field">
          初始机主
          <select
            value={cfg.initialOwner}
            onChange={(e) => change({ initialOwner: e.target.value })}
          >
            {cfg.owners.map((id) => (
              <option key={id} value={id}>
                {name(id)}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          锁屏密码 · 留空直接打开
          <input
            value={cfg.password}
            onChange={(e) => change({ password: e.target.value })}
          />
        </label>
        <label className="field">
          开场通知
          <input
            value={cfg.notification}
            onChange={(e) => change({ notification: e.target.value })}
          />
        </label>
        <p className="hint">
          壁纸和主题沿用各机主的手机设置。密码用于剧情解谜。
        </p>
        <h3>应用顺序</h3>
        {cfg.apps.map((app, index) => (
          <div className="row" key={app}>
            <span>{labels[app]}</span>
            <button
              disabled={index === 0}
              onClick={() => {
                const apps = [...cfg.apps];
                [apps[index - 1], apps[index]] = [apps[index], apps[index - 1]];
                change({ apps });
              }}
            >
              上移
            </button>
            <button
              onClick={() =>
                change({ apps: cfg.apps.filter((a) => a !== app) })
              }
            >
              隐藏应用
            </button>
          </div>
        ))}
        {readerApps
          .filter((a) => !cfg.apps.includes(a))
          .map((a) => (
            <button key={a} onClick={() => change({ apps: [...cfg.apps, a] })}>
              添加{labels[a]}
            </button>
          ))}
      </details>
      <details className="work-card">
        <summary>选择分享内容</summary>
        <p className="hint">
          默认收录可见的当前内容。删除、未采用版本、作者秘密和编辑器草稿不会打包。
        </p>
        <div className="row">
          <button
            onClick={() =>
              change({
                selectedRecords: undefined,
                selectedDocuments: undefined,
              })
            }
          >
            全部收录
          </button>
          <button
            onClick={() =>
              change({ selectedRecords: [], selectedDocuments: [] })
            }
          >
            全部取消
          </button>
        </div>
        <div className="work-rule-targets">
          {records
            .filter((r) => r.audience.some((id) => cfg.owners.includes(id)))
            .map((r) => (
              <label key={r.id}>
                <input
                  type="checkbox"
                  checked={
                    !cfg.selectedRecords || cfg.selectedRecords.includes(r.id)
                  }
                  onChange={(e) => {
                    const current =
                      cfg.selectedRecords || records.map((r) => r.id);
                    change({
                      selectedRecords: e.target.checked
                        ? [...current, r.id]
                        : current.filter((id) => id !== r.id),
                    });
                  }}
                />
                {name(r.speakerId)} ·{" "}
                {r.retracted
                  ? "撤回提示"
                  : r.body.text.slice(0, 90) || r.body.type}
              </label>
            ))}
          {docs
            .filter((d) => d.audience.some((id) => cfg.owners.includes(id)))
            .map((d) => (
              <label key={d.id}>
                <input
                  type="checkbox"
                  checked={
                    !cfg.selectedDocuments ||
                    cfg.selectedDocuments.includes(d.id)
                  }
                  onChange={(e) => {
                    const current =
                      cfg.selectedDocuments || docs.map((d) => d.id);
                    change({
                      selectedDocuments: e.target.checked
                        ? [...current, d.id]
                        : current.filter((id) => id !== d.id),
                    });
                  }}
                />
                {d.title}
              </label>
            ))}
        </div>
      </details>
      <section className="work-card">
        <h3>阅读方式</h3>
        <select
          aria-label="阅读方式"
          value={cfg.mode}
          onChange={(e) =>
            change({ mode: e.target.value as PhoneReading["mode"] })
          }
        >
          <option value="free">自由翻阅</option>
          <option value="clues">线索解锁与轻解谜</option>
        </select>
        {cfg.mode === "clues" && (
          <>
            <p className="hint">
              没有设置条件的内容直接可见。答案区分大小写，忽略首尾空格。
            </p>
            <button
              onClick={() =>
                change({
                  rules: [
                    ...cfg.rules,
                    {
                      id: uid(),
                      title: "新的线索",
                      targets: [],
                      match: "all",
                      conditions: [{ type: "password", answers: ["答案"] }],
                      hint: "",
                      error: "答案还不对，再找找线索。",
                      notification: "",
                    },
                  ],
                })
              }
            >
              添加解锁规则
            </button>
            {cfg.rules.map((rule) => (
              <details className="work-card" key={rule.id} open>
                <summary>{rule.title}</summary>
                <label className="field">
                  线索名称
                  <input
                    value={rule.title}
                    onChange={(e) =>
                      updateRule(rule.id, { title: e.target.value })
                    }
                  />
                </label>
                <details>
                  <summary>
                    选择被锁定内容（已选 {rule.targets.length} 项）
                  </summary>
                  <div className="work-rule-targets">
                    {cfg.owners.map((owner) => (
                      <fieldset key={owner}>
                        <legend>{name(owner)}的手机</legend>
                        {targets(owner).map(({ target, label }) => (
                          <label key={readerTargetKey(target)}>
                            <input
                              type="checkbox"
                              checked={rule.targets.some(
                                (t) =>
                                  readerTargetKey(t) ===
                                  readerTargetKey(target),
                              )}
                              onChange={(e) =>
                                updateRule(rule.id, {
                                  targets: e.target.checked
                                    ? [...rule.targets, target]
                                    : rule.targets.filter(
                                        (t) =>
                                          readerTargetKey(t) !==
                                          readerTargetKey(target),
                                      ),
                                })
                              }
                            />
                            {label}
                          </label>
                        ))}
                      </fieldset>
                    ))}
                  </div>
                </details>
                <label className="field">
                  满足条件
                  <select
                    value={rule.match}
                    onChange={(e) =>
                      updateRule(rule.id, {
                        match: e.target.value as "all" | "any",
                      })
                    }
                  >
                    <option value="all">全部条件</option>
                    <option value="any">任一条件</option>
                  </select>
                </label>
                {rule.conditions.map((condition, i) => {
                  const replace = (next: typeof condition) =>
                    updateRule(rule.id, {
                      conditions: rule.conditions.map((c, j) =>
                        j === i ? next : c,
                      ),
                    });
                  return (
                    <div className="work-condition" key={i}>
                      <label>
                        条件类型
                        <select
                          value={condition.type}
                          onChange={(e) =>
                            replace(
                              e.target.value === "password"
                                ? { type: "password", answers: ["答案"] }
                                : e.target.value === "clue"
                                  ? { type: "clue", ruleId: "" }
                                  : {
                                      type: "read",
                                      target: targets(
                                        cfg.initialOwner,
                                        false,
                                      )[0]?.target || {
                                        ownerId: cfg.initialOwner,
                                        type: "document",
                                        id: "",
                                      },
                                    },
                            )
                          }
                        >
                          <option value="password">输入答案</option>
                          <option value="read">读过指定内容</option>
                          <option value="clue">完成另一条线索</option>
                        </select>
                      </label>
                      {condition.type === "password" && (
                        <label className="field">
                          可接受答案 · 每行一个
                          <textarea
                            value={condition.answers.join("\n")}
                            onChange={(e) =>
                              replace({
                                ...condition,
                                answers: e.target.value.split("\n"),
                              })
                            }
                          />
                        </label>
                      )}
                      {condition.type === "clue" && (
                        <select
                          aria-label="前置线索"
                          value={condition.ruleId}
                          onChange={(e) =>
                            replace({ ...condition, ruleId: e.target.value })
                          }
                        >
                          <option value="">选择线索</option>
                          {cfg.rules
                            .filter((r) => r.id !== rule.id)
                            .map((r) => (
                              <option key={r.id} value={r.id}>
                                {r.title}
                              </option>
                            ))}
                        </select>
                      )}
                      {condition.type === "read" && (
                        <>
                          <select
                            aria-label="线索机主"
                            value={condition.target.ownerId}
                            onChange={(e) =>
                              replace({
                                ...condition,
                                target: targets(e.target.value, false)[0]
                                  ?.target || {
                                  ownerId: e.target.value,
                                  type: "document",
                                  id: "",
                                },
                              })
                            }
                          >
                            {cfg.owners.map((id) => (
                              <option key={id} value={id}>
                                {name(id)}
                              </option>
                            ))}
                          </select>
                          <select
                            aria-label="阅读线索"
                            value={
                              condition.target.type + ":" + condition.target.id
                            }
                            onChange={(e) => {
                              const t = targets(
                                condition.target.ownerId,
                                false,
                              ).find(
                                (t) =>
                                  t.target.type + ":" + t.target.id ===
                                  e.target.value,
                              );
                              if (t)
                                replace({ ...condition, target: t.target });
                            }}
                          >
                            <option value="">选择内容</option>
                            {targets(condition.target.ownerId, false).map(
                              (t) => (
                                <option
                                  key={readerTargetKey(t.target)}
                                  value={t.target.type + ":" + t.target.id}
                                >
                                  {t.label}
                                </option>
                              ),
                            )}
                          </select>
                        </>
                      )}
                      <button
                        onClick={() =>
                          updateRule(rule.id, {
                            conditions: rule.conditions.filter(
                              (_, j) => j !== i,
                            ),
                          })
                        }
                      >
                        移除条件
                      </button>
                    </div>
                  );
                })}
                <button
                  onClick={() =>
                    updateRule(rule.id, {
                      conditions: [
                        ...rule.conditions,
                        { type: "password", answers: ["答案"] },
                      ],
                    })
                  }
                >
                  增加条件
                </button>
                <label className="field">
                  提示
                  <textarea
                    value={rule.hint}
                    onChange={(e) =>
                      updateRule(rule.id, { hint: e.target.value })
                    }
                  />
                </label>
                <label className="field">
                  答错提示
                  <input
                    value={rule.error}
                    onChange={(e) =>
                      updateRule(rule.id, { error: e.target.value })
                    }
                  />
                </label>
                <label className="field">
                  解锁后通知 · 可留空
                  <input
                    value={rule.notification}
                    onChange={(e) =>
                      updateRule(rule.id, { notification: e.target.value })
                    }
                  />
                </label>
                <button
                  onClick={() =>
                    change({ rules: cfg.rules.filter((r) => r.id !== rule.id) })
                  }
                >
                  删除规则
                </button>
              </details>
            ))}
          </>
        )}
      </section>
      <details className="work-card">
        <summary>聊天演出与回放</summary>
        <div className="row">
          <select
            aria-label="演出会话"
            value={performanceConversation}
            onChange={(e) => setPerformanceConversation(e.target.value)}
          >
            <option value="">选择会话</option>
            {conversations.map((c) => (
              <option key={c.id} value={c.id}>
                {c.title || c.members.map(name).join("、")}
              </option>
            ))}
          </select>
          <button
            disabled={!performanceConversation}
            onClick={() =>
              change({
                performances: [
                  ...cfg.performances,
                  {
                    id: uid(),
                    title: "一段对话",
                    conversationId: performanceConversation,
                    steps: records
                      .filter(
                        (r) => r.conversationId === performanceConversation,
                      )
                      .map((r) => ({
                        recordId: r.id,
                        delay: 1000,
                        typing: true,
                        retractAfter: 0,
                      })),
                  },
                ],
              })
            }
          >
            创建演出
          </button>
        </div>
        {cfg.performances.map((p) => {
          const update = (patch: Partial<typeof p>) =>
            change({
              performances: cfg.performances.map((x) =>
                x.id === p.id ? { ...x, ...patch } : x,
              ),
            });
          return (
            <section className="work-card" key={p.id}>
              <label className="field">
                演出名称
                <input
                  value={p.title}
                  onChange={(e) => update({ title: e.target.value })}
                />
              </label>
              {p.steps.map((step, i) => {
                const r = records.find((r) => r.id === step.recordId);
                const patch = (v: Partial<typeof step>) =>
                  update({
                    steps: p.steps.map((s, j) =>
                      i === j ? { ...s, ...v } : s,
                    ),
                  });
                return (
                  <details key={step.recordId}>
                    <summary>
                      {i + 1}.{" "}
                      {r
                        ? name(r.speakerId) +
                          "：" +
                          (r.retracted ? "撤回消息" : r.body.text.slice(0, 50))
                        : "消息已不存在"}
                    </summary>
                    <label className="field">
                      出现前停顿（毫秒）
                      <input
                        type="number"
                        min={0}
                        max={60000}
                        value={step.delay}
                        onChange={(e) =>
                          patch({ delay: Number(e.target.value) })
                        }
                      />
                    </label>
                    <label className="toggle">
                      <input
                        type="checkbox"
                        checked={step.typing}
                        onChange={(e) => patch({ typing: e.target.checked })}
                      />
                      出现前显示正在输入
                    </label>
                    <label className="field">
                      出现后撤回（毫秒，0 为不撤回）
                      <input
                        type="number"
                        min={0}
                        max={60000}
                        value={step.retractAfter}
                        onChange={(e) =>
                          patch({ retractAfter: Number(e.target.value) })
                        }
                      />
                    </label>
                    {r?.retracted && (
                      <label className="field">
                        明确收录撤回前文字 · 留空仅显示撤回提示
                        <textarea
                          value={step.revealedText || ""}
                          onChange={(e) =>
                            patch({ revealedText: e.target.value })
                          }
                        />
                      </label>
                    )}
                    <div className="row">
                      <button
                        disabled={!i}
                        onClick={() => {
                          const steps = [...p.steps];
                          [steps[i - 1], steps[i]] = [steps[i], steps[i - 1]];
                          update({ steps });
                        }}
                      >
                        上移
                      </button>
                      <button
                        onClick={() =>
                          update({ steps: p.steps.filter((_, j) => j !== i) })
                        }
                      >
                        不收录此条
                      </button>
                    </div>
                  </details>
                );
              })}
              <button
                onClick={() =>
                  change({
                    performances: cfg.performances.filter((x) => x.id !== p.id),
                  })
                }
              >
                删除演出
              </button>
            </section>
          );
        })}
      </details>
      {checked && (
        <section
          role="status"
          className={checked.length ? "error work-card" : "work-card"}
        >
          {checked.length ? (
            <>
              <strong>需要调整的阅读依赖</strong>
              <ul>
                {checked.map((e) => (
                  <li key={e}>{e}</li>
                ))}
              </ul>
            </>
          ) : (
            "依赖检查通过，可以预览和导出。"
          )}
        </section>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="work-reader-actions">
        <button disabled={busy} onClick={() => void action(save)}>
          保存阅读设置
        </button>
        <button
          disabled={busy}
          onClick={() =>
            void action(async () => {
              const data = await pack();
              setPreview(createReaderHTML(data));
            })
          }
        >
          读者预览
        </button>
        <button
          className="primary"
          disabled={busy}
          onClick={() =>
            void action(async () => {
              const data = await pack();
              download(
                story.title.replace(/[<>:"/\\|?*]/g, "_") + "-阅读包.html",
                createReaderHTML(data),
                "text/html;charset=utf-8",
              );
            })
          }
        >
          导出离线阅读包
        </button>
      </div>
      {preview && (
        <Modal title="读者预览" onClose={() => setPreview("")}>
          <iframe
            title="手机读者预览"
            className="reader-preview-frame"
            sandbox="allow-scripts allow-same-origin allow-downloads allow-modals allow-forms"
            srcDoc={preview}
          />
        </Modal>
      )}
    </section>
  );
}
