import { useEffect, useRef, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { Modal } from "./Modal";
import { RoleCompletionAssistant } from "./RoleCompletionAssistant";
import { db, keyFor } from "./db";
import { uid, type Profile } from "./types";
import { completionBasisLabels } from "./role-completion-types";
import {
  createGenerator,
  configureGenerator,
  generatorData,
  saveGeneratorDraft,
  deleteGenerator,
  migrateCompletionGenerator,
  advanceGenerator,
  retryGenerator,
  forkGeneratorRecovery,
  stopGenerator,
  reviseGenerator,
  editGeneratorResult,
  saveGeneratorResults,
  recoverGeneratorStep,
  saveGeneratorConnection,
} from "./generator";
import {
  newGeneratorInput,
  type GeneratorSession,
  type GeneratorInput,
  type GeneratorSelection,
  type GeneratorAnswer,
  type GeneratorResult,
} from "./generator-types";
import "./generator.css";
import {
  generatorResultGroups,
  generatorStepIsCurrent,
} from "./generator-results";

type Props = {
  onClose: () => void;
  notify: (message: string) => void;
  initialSource?: string;
};
type Data = Awaited<ReturnType<typeof generatorData>>;
const err = (e: unknown) => (e instanceof Error ? e.message : String(e));
const purposeLabels = {
  target: "改写目标",
  relationship: "人物关系参考",
  style: "风格参考",
  world: "世界书",
  source: "原始素材",
};
function comparisonText(
  result: GeneratorResult,
  targets: GeneratorInput["targets"],
) {
  if (result.card) {
    const c = result.card;
    return [
      c.name,
      "公开简介\n" + (c.bio || "留白"),
      ...c.sections.map(
        (s) =>
          `${s.title} · ${completionBasisLabels[s.basis]}\n${s.content}${s.evidence ? "\n依据：" + s.evidence : ""}`,
      ),
      "保留：" + c.preserved.join("；"),
      "改变：" + c.changed.join("；"),
      "变化依据：" + c.reasons.join("；"),
    ].join("\n\n");
  }
  const w = result.world!;
  const names = (ids: string[]) =>
    ids
      .map((id) => targets.find((t) => t.id === id)?.name || "原目标人物")
      .join("、");
  return [
    w.title,
    w.text,
    "关联人物：" + (names(w.roleIds) || "无"),
    "知情范围：" +
      (w.audience === "all"
        ? "所有角色"
        : w.audience === "author"
          ? "仅作者"
          : names(w.knownBy)),
  ].join("\n\n");
}
export function RoleGenerator(props: Props) {
  const [legacy, setLegacy] = useState(false);
  return legacy ? (
    <RoleCompletionAssistant {...props} />
  ) : (
    <GeneratorDialog {...props} onLegacy={() => setLegacy(true)} />
  );
}
function GeneratorDialog({
  onClose,
  notify,
  initialSource,
  onLegacy,
}: Props & { onLegacy: () => void }) {
  const sessions =
    useLiveQuery(
      () => db.generatorSessions.orderBy("updated").reverse().toArray(),
      [],
    ) || [];
  const roles = useLiveQuery(() => db.roles.toArray(), []) || [];
  const worlds = useLiveQuery(() => db.world.toArray(), []) || [];
  const [data, setData] = useState<Data>();
  const [current, setCurrent] = useState<GeneratorSession>();
  const ref = useRef<GeneratorSession | undefined>(undefined);
  const [input, setInput] = useState<GeneratorInput>(newGeneratorInput);
  const [selections, setSelections] = useState<GeneratorSelection[]>([]);
  const [search, setSearch] = useState("");
  const [setup, setSetup] = useState(true);
  const [tab, setTab] = useState("对话");
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState("");
  const [raw, setRaw] = useState("");
  const [connection, setConnection] = useState(false);
  const [selectedResults, setSelectedResults] = useState<string[]>([]);
  const [versions, setVersions] = useState<Record<string, string>>({});
  const pending = useRef(Promise.resolve());
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const mounted = useRef(true);
  const initialization = useRef<Promise<GeneratorSession> | undefined>(
    undefined,
  );
  async function refresh(id: string, restoreForm = true) {
    const d = await generatorData(id);
    if (!mounted.current) return;
    setData(d);
    ref.current = d.session;
    setCurrent(d.session);
    if (restoreForm) {
      setInput(d.session.setupDraft || d.session.input);
      setSelections(
        d.session.selectionDraft ||
          d.materials
            .filter(
              (m) => d.session.materialIds.includes(m.id) && m.kind !== "text",
            )
            .map((m) => ({
              sourceId: m.sourceId,
              kind: m.kind as "role" | "world",
              purpose: m.purpose,
            })),
      );
    }
  }
  useEffect(() => {
    mounted.current = true;
    initialization.current ||= migrateCompletionGenerator().then(async () => {
      const last = await db.generatorSessions.orderBy("updated").last();
      return initialSource?.trim()
        ? createGenerator(initialSource)
        : last || createGenerator();
    });
    void initialization.current
      .then(async (s) => {
        await refresh(s.id);
        setSetup(!s.turnIds.length && !s.legacy);
      })
      .catch((e) => setError(err(e)));
    return () => {
      mounted.current = false;
      clearTimeout(timer.current);
      if (ref.current) stopGenerator(ref.current.id);
    };
  }, []);
  function patch(patch: Partial<GeneratorSession>) {
    if (!ref.current) return;
    ref.current = { ...ref.current, ...patch };
    setCurrent(ref.current);
    clearTimeout(timer.current);
    setSaving("正在保存…");
    timer.current = setTimeout(() => {
      void flush().catch((e) => setError(err(e)));
    }, 350);
  }
  async function flush() {
    clearTimeout(timer.current);
    const write = pending.current.then(async () => {
      if (!ref.current) return;
      const before = ref.current;
      const saved = await saveGeneratorDraft(before);
      if (ref.current?.id === saved.id) {
        ref.current = { ...ref.current, version: saved.version };
        if (mounted.current) setCurrent(ref.current);
      }
      if (mounted.current) setSaving("已自动保存");
    });
    pending.current = write.catch(() => {});
    return write;
  }
  function changeInput(next: GeneratorInput) {
    setInput(next);
    patch({
      setupDraft: next,
      ...(!data?.session.turnIds.length ? { input: next } : {}),
    });
  }
  function choose(next: GeneratorSelection[]) {
    setSelections(next);
    patch({ selectionDraft: next });
  }
  async function perform(work: () => Promise<unknown>) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError("");
    let persisted = false;
    try {
      await flush();
      persisted = true;
      await work();
    } catch (e) {
      setError(err(e));
    } finally {
      if (persisted && ref.current && mounted.current)
        await refresh(ref.current.id, false).catch((e) => setError(err(e)));
      busyRef.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  async function close(next = onClose) {
    if (busyRef.current) {
      if (ref.current) stopGenerator(ref.current.id);
      setError("正在停止请求，已有内容会保留；停止后可关闭。");
      return;
    }
    try {
      await flush();
      next();
    } catch (e) {
      setError(err(e));
    }
  }
  async function open(id?: string) {
    try {
      await flush();
      const s = id
        ? await db.generatorSessions.get(id)
        : await createGenerator();
      if (s) {
        await refresh(s.id);
        setSetup(!s.turnIds.length && !s.legacy);
        setSelectedResults([]);
        setVersions({});
        setError("");
        setTab("对话");
      }
    } catch (e) {
      setError(err(e));
    }
  }
  const turns =
    data?.session.turnIds
      .map((id) => data.turns.find((t) => t.id === id))
      .filter((t) => !!t) || [];
  const questions = turns.at(-1)?.interview?.questions || [];
  const answerLabel = (turnId: string, a: GeneratorAnswer) => {
    const q = turns
      .slice(
        0,
        turns.findIndex((t) => t.id === turnId),
      )
      .reverse()
      .flatMap((t) => t.interview?.questions || [])
      .find((q) => q.id === a.questionId);
    return a.options
      .map((id) => q?.options.find((o) => o.id === id)?.text || "原选项")
      .join("、");
  };
  const knowledge = [...turns].reverse().find((t) => t.interview)?.interview;
  const candidates = (data?.results || []).filter(
    (r) => r.revision === current?.revision && !r.needsReview,
  );
  const groups = generatorResultGroups(candidates);
  const displayed = [...groups].map(([key, list]) => ({
    key,
    list,
    r: list.find((r) => r.id === versions[key]) || list.at(-1)!,
  }));
  const visibleSelection = selectedResults.filter((id) =>
    displayed.some((x) => x.r.id === id),
  );
  const changeAnswer = (id: string, update: Partial<GeneratorAnswer>) => {
    const previous = ref.current?.answers.find((a) => a.questionId === id) || {
      questionId: id,
      options: [],
      text: "",
      disposition: "answer" as const,
    };
    patch({
      answers: [
        ...(ref.current?.answers || []).filter((a) => a.questionId !== id),
        { ...previous, ...update },
      ],
    });
  };
  return (
    <Modal
      title="角色卡生成器"
      onClose={() => {
        void close();
      }}
    >
      <div className="generator">
        <header className="generator-intro">
          <span className="eyebrow">CHARACTER WORKSHOP</span>
          <h3>聊一聊，让人物慢慢清晰。</h3>
          <p>选择参考，回答几个问题，写出属于你的新角色。原始资料始终保留。</p>
        </header>
        <div className="generator-toolbar">
          <label>
            生成会话
            <select
              aria-label="生成会话"
              disabled={busy}
              value={current?.id || ""}
              onChange={(e) => void open(e.target.value)}
            >
              {sessions.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.title}
                </option>
              ))}
            </select>
          </label>
          <button disabled={busy} onClick={() => void open()}>
            新建访谈
          </button>
          <button disabled={busy} onClick={() => setConnection(!connection)}>
            接口设置
          </button>
          <button disabled={busy} onClick={() => void close(onLegacy)}>
            旧版快速补全与恢复
          </button>
          {current && (
            <button
              disabled={busy}
              onClick={() => {
                if (
                  confirm(
                    "删除此访谈和恢复记录？已经保存到库里的新资料会保留。",
                  )
                )
                  void perform(async () => {
                    await deleteGenerator(current.id);
                    const s = await createGenerator();
                    await refresh(s.id);
                    setSetup(true);
                  });
              }}
            >
              删除会话
            </button>
          )}
        </div>
        {connection && (
          <GeneratorConnection onError={setError} disabled={busy} />
        )}
        <div aria-live="polite" className="generator-status">
          {busy ? "正在整理人物…" : saving}
          {current?.lease && !busy && current.lease.until > Date.now() && (
            <span> · 此会话正在另一标签页处理，刷新中断后请稍后恢复</span>
          )}
        </div>
        {error && (
          <div role="alert" className="error">
            {error}
          </div>
        )}
        {!current && <p>正在读取会话…</p>}
        {current && (
          <>
            <div
              className="generator-tabs"
              role="tablist"
              aria-label="生成器视图"
            >
              {["对话", "设定", "结果"].map((x) => (
                <button
                  role="tab"
                  aria-selected={tab === x}
                  key={x}
                  onClick={() => setTab(x)}
                >
                  {x}
                </button>
              ))}
            </div>
            <div className="generator-columns">
              <section
                className="generator-conversation"
                data-visible={tab === "对话"}
              >
                <div className="generator-section-heading">
                  <h3>一起完善人物</h3>
                  <button disabled={busy} onClick={() => setSetup(!setup)}>
                    {setup ? "收起参考与目标" : "参考资料与目标"}
                  </button>
                </div>
                {setup && (
                  <fieldset disabled={busy} className="generator-setup">
                    <label>
                      创作方式
                      <select
                        aria-label="创作方式"
                        value={input.mode}
                        onChange={(e) =>
                          changeInput({
                            ...input,
                            mode: e.target.value as GeneratorInput["mode"],
                          })
                        }
                      >
                        <option value="create">从零创作</option>
                        <option value="refine">完善已有角色</option>
                        <option value="if">制作 IF 角色</option>
                      </select>
                    </label>
                    {input.mode === "if" && (
                      <>
                        <label>
                          IF 自由度
                          <select
                            aria-label="IF 自由度"
                            value={input.freedom}
                            onChange={(e) =>
                              changeInput({
                                ...input,
                                freedom: e.target
                                  .value as GeneratorInput["freedom"],
                              })
                            }
                          >
                            <option value="faithful">沿原设定推演</option>
                            <option value="free">自由 IF 推演</option>
                          </select>
                        </label>
                        <label>
                          必须保留的角色内核
                          <textarea
                            aria-label="必须保留的角色内核"
                            value={input.core}
                            onChange={(e) =>
                              changeInput({ ...input, core: e.target.value })
                            }
                            placeholder="例如：嘴硬心软，不背叛朋友"
                          />
                        </label>
                      </>
                    )}
                    <label>
                      人物或故事素材
                      <textarea
                        aria-label="人物或故事素材"
                        value={input.source}
                        onChange={(e) =>
                          changeInput({ ...input, source: e.target.value })
                        }
                        placeholder="可粘贴角色卡，也可只勾选下面的资料"
                      />
                    </label>
                    <label>
                      这次想怎么写
                      <textarea
                        aria-label="这次想怎么写"
                        value={input.guidance}
                        onChange={(e) =>
                          changeInput({ ...input, guidance: e.target.value })
                        }
                        placeholder="写下希望完善或改变的方向"
                      />
                    </label>
                    <label className="generator-check">
                      <input
                        type="checkbox"
                        checked={input.multiple}
                        onChange={(e) =>
                          changeInput({ ...input, multiple: e.target.checked })
                        }
                      />
                      一起完善多位人物
                    </label>
                    <div className="generator-roster">
                      <strong>本次生成的目标名单</strong>
                      {input.targets.map((t, i) => (
                        <div className="generator-inline" key={t.id}>
                          <input
                            aria-label={`目标人物 ${i + 1}`}
                            value={t.name}
                            onChange={(e) =>
                              changeInput({
                                ...input,
                                targets: input.targets.map((x) =>
                                  x.id === t.id
                                    ? { ...x, name: e.target.value }
                                    : x,
                                ),
                              })
                            }
                          />
                          <button
                            onClick={() =>
                              changeInput({
                                ...input,
                                targets: input.targets.filter(
                                  (x) => x.id !== t.id,
                                ),
                              })
                            }
                          >
                            移除目标
                          </button>
                        </div>
                      ))}
                      <button
                        disabled={!input.multiple && input.targets.length > 0}
                        onClick={() =>
                          changeInput({
                            ...input,
                            targets: [
                              ...input.targets,
                              { id: uid(), name: "" },
                            ],
                          })
                        }
                      >
                        添加目标人物
                      </button>
                      <p className="hint">
                        填写姓名或暂用称呼。参考人物不会自动成为生成目标。
                      </p>
                    </div>
                    <label>
                      搜索参考资料
                      <input
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        placeholder="角色姓名、世界书标题或内容"
                      />
                    </label>
                    <p className="hint">
                      已勾选 {selections.length} 项 ·
                      作为作者资料完整读取，包括私密设定
                    </p>
                    <div className="generator-library">
                      {roles
                        .filter((r) => (r.name + r.persona).includes(search))
                        .map((r) => {
                          const chosen = selections.find(
                            (x) => x.kind === "role" && x.sourceId === r.id,
                          );
                          return (
                            <article key={r.id}>
                              <label className="generator-check">
                                <input
                                  type="checkbox"
                                  aria-label={`参考角色 ${r.name}`}
                                  checked={!!chosen}
                                  onChange={(e) =>
                                    choose(
                                      e.target.checked
                                        ? [
                                            ...selections,
                                            {
                                              kind: "role",
                                              sourceId: r.id,
                                              purpose: "relationship",
                                            },
                                          ]
                                        : selections.filter(
                                            (x) =>
                                              !(
                                                x.kind === "role" &&
                                                x.sourceId === r.id
                                              ),
                                          ),
                                    )
                                  }
                                />
                                {r.name}
                              </label>
                              {chosen && (
                                <select
                                  aria-label={`${r.name}的参考用途`}
                                  value={chosen.purpose}
                                  onChange={(e) =>
                                    choose(
                                      selections.map((x) =>
                                        x === chosen
                                          ? {
                                              ...x,
                                              purpose: e.target
                                                .value as GeneratorSelection["purpose"],
                                            }
                                          : x,
                                      ),
                                    )
                                  }
                                >
                                  {["target", "relationship", "style"].map(
                                    (p) => (
                                      <option key={p} value={p}>
                                        {
                                          purposeLabels[
                                            p as keyof typeof purposeLabels
                                          ]
                                        }
                                      </option>
                                    ),
                                  )}
                                </select>
                              )}
                              <details>
                                <summary>预览角色资料</summary>
                                <p>{r.bio}</p>
                                <pre>{r.persona}</pre>
                              </details>
                              {(!input.targets.length || input.multiple) && (
                                <button
                                  onClick={() =>
                                    changeInput({
                                      ...input,
                                      targets: [
                                        ...input.targets,
                                        { id: uid(), name: r.name },
                                      ],
                                    })
                                  }
                                >
                                  加入目标名单
                                </button>
                              )}
                            </article>
                          );
                        })}
                      {worlds
                        .filter((w) => (w.title + w.text).includes(search))
                        .map((w) => (
                          <article key={w.id}>
                            <label className="generator-check">
                              <input
                                type="checkbox"
                                aria-label={`参考世界书 ${w.title}`}
                                checked={selections.some(
                                  (x) =>
                                    x.kind === "world" && x.sourceId === w.id,
                                )}
                                onChange={(e) =>
                                  choose(
                                    e.target.checked
                                      ? [
                                          ...selections,
                                          {
                                            kind: "world",
                                            sourceId: w.id,
                                            purpose: "world",
                                          },
                                        ]
                                      : selections.filter(
                                          (x) =>
                                            !(
                                              x.kind === "world" &&
                                              x.sourceId === w.id
                                            ),
                                        ),
                                  )
                                }
                              />
                              {w.title}
                            </label>
                            <details>
                              <summary>预览世界书</summary>
                              <pre>{w.text}</pre>
                              <small>
                                {w.audience === "all"
                                  ? "所有角色可知"
                                  : w.audience === "author"
                                    ? "仅作者可见"
                                    : "指定角色可知"}
                              </small>
                            </details>
                          </article>
                        ))}
                    </div>
                    {!!selections.length && (
                      <div className="generator-chips">
                        {selections.map((x) => (
                          <button
                            key={x.kind + x.sourceId}
                            onClick={() =>
                              choose(selections.filter((y) => y !== x))
                            }
                          >
                            {(x.kind === "role"
                              ? roles.find((r) => r.id === x.sourceId)?.name
                              : worlds.find((w) => w.id === x.sourceId)
                                  ?.title) || "源资料已删除"}{" "}
                            ×
                          </button>
                        ))}
                      </div>
                    )}
                    <button
                      className="primary"
                      onClick={() =>
                        void perform(async () => {
                          const s = await configureGenerator(
                            current.id,
                            input,
                            selections,
                          );
                          ref.current = s;
                          setCurrent(s);
                          setSetup(false);
                          await advanceGenerator(s.id, "", [], false, setRaw);
                        })
                      }
                    >
                      {turns.length
                        ? "更新参考并开始新修订"
                        : "确认目标与参考，开始访谈"}
                    </button>
                  </fieldset>
                )}
                <div className="generator-thread" aria-label="访谈记录">
                  {turns.map((t) => (
                    <article
                      className={`generator-bubble ${t.kind}`}
                      key={t.id}
                    >
                      <strong>
                        {t.kind === "user" ? "你的想法" : "角色生成器"}
                      </strong>
                      <p>{t.text}</p>
                      {t.answers.map((a) => (
                        <p key={a.questionId}>
                          回答：
                          {a.disposition === "delegate"
                            ? "交给 AI 决定"
                            : a.disposition === "blank"
                              ? "暂时留白"
                              : answerLabel(t.id, a)}
                          {a.text && " · " + a.text}
                        </p>
                      ))}
                      {t.kind === "user" && (
                        <button
                          disabled={busy}
                          onClick={() =>
                            void perform(async () => {
                              const next = await reviseGenerator(
                                current.id,
                                t.id,
                              );
                              ref.current = next;
                              setCurrent(next);
                            })
                          }
                        >
                          从这里修改回答
                        </button>
                      )}
                    </article>
                  ))}
                </div>
                {!setup && (
                  <fieldset disabled={busy} className="generator-answer-form">
                    {questions.map((q) => {
                      const a = current.answers.find(
                        (a) => a.questionId === q.id,
                      );
                      return (
                        <fieldset key={q.id}>
                          <legend>
                            {q.text}
                            <small>
                              （{q.multiple ? "可多选" : "单选"}，也可自定义）
                            </small>
                          </legend>
                          {q.options.map((o) => (
                            <label className="generator-option" key={o.id}>
                              <input
                                type={q.multiple ? "checkbox" : "radio"}
                                name={q.id}
                                checked={a?.options.includes(o.id) || false}
                                onChange={(e) =>
                                  changeAnswer(q.id, {
                                    disposition: "answer",
                                    options: q.multiple
                                      ? e.target.checked
                                        ? [...(a?.options || []), o.id]
                                        : (a?.options || []).filter(
                                            (x) => x !== o.id,
                                          )
                                      : [o.id],
                                  })
                                }
                              />
                              <span>{o.text}</span>
                            </label>
                          ))}
                          <label>
                            自定义补充
                            <textarea
                              aria-label="自定义补充"
                              value={a?.text || ""}
                              onChange={(e) =>
                                changeAnswer(q.id, {
                                  text: e.target.value,
                                  disposition: "answer",
                                })
                              }
                            />
                          </label>
                          <div className="generator-inline">
                            <button
                              aria-pressed={a?.disposition === "delegate"}
                              onClick={() =>
                                changeAnswer(q.id, {
                                  disposition: "delegate",
                                  options: [],
                                })
                              }
                            >
                              交给 AI 决定
                            </button>
                            <button
                              aria-pressed={a?.disposition === "blank"}
                              onClick={() =>
                                changeAnswer(q.id, {
                                  disposition: "blank",
                                  options: [],
                                })
                              }
                            >
                              暂时留白
                            </button>
                          </div>
                        </fieldset>
                      );
                    })}
                    <label>
                      {displayed.length ? "继续修改这版角色" : "补充想法"}
                      <textarea
                        aria-label={
                          displayed.length ? "继续修改这版角色" : "补充想法"
                        }
                        value={current.draft}
                        onChange={(e) => patch({ draft: e.target.value })}
                        placeholder="也可以直接用一段话回答，或提出新的要求"
                      />
                    </label>
                    <div className="generator-inline">
                      <button
                        className="primary"
                        onClick={() =>
                          void perform(async () => {
                            await advanceGenerator(
                              current.id,
                              ref.current!.draft,
                              ref.current!.answers,
                              false,
                              setRaw,
                            );
                          })
                        }
                      >
                        发送并继续
                      </button>
                      <button
                        onClick={() =>
                          void perform(async () => {
                            await advanceGenerator(
                              current.id,
                              ref.current!.draft,
                              ref.current!.answers,
                              true,
                              setRaw,
                            );
                            setTab("结果");
                          })
                        }
                      >
                        先生成一版
                      </button>
                    </div>
                  </fieldset>
                )}
                {busy && (
                  <button onClick={() => stopGenerator(current.id)}>
                    停止生成
                  </button>
                )}
                {busy && raw && (
                  <details>
                    <summary>正在收到的内容</summary>
                    <pre>{raw}</pre>
                  </details>
                )}
              </section>
              <aside
                className="generator-reference"
                data-visible={tab === "设定"}
              >
                <h3>设定与参考</h3>
                {[
                  ["已经确定", knowledge?.confirmed],
                  ["需要讨论的冲突", knowledge?.conflicts],
                  ["暂时留白", knowledge?.unknown],
                ].map(([label, items]) => (
                  <section key={String(label)}>
                    <h4>{String(label)}</h4>
                    {Array.isArray(items) && items.length ? (
                      <ul>
                        {items.map((x, i) => (
                          <li key={i}>{x}</li>
                        ))}
                      </ul>
                    ) : (
                      <p className="hint">暂无记录</p>
                    )}
                  </section>
                ))}
                <h4>本次参考快照</h4>
                {data?.materials
                  .filter((m) => current.materialIds.includes(m.id))
                  .map((m) => (
                    <details key={m.id}>
                      <summary>
                        {m.label} · {purposeLabels[m.purpose]}
                      </summary>
                      <pre>{m.text}</pre>
                    </details>
                  ))}
                <details>
                  <summary>历史分支与修订</summary>
                  {data?.turns
                    .filter((t) => !current.turnIds.includes(t.id))
                    .map((t) => (
                      <article key={t.id}>
                        <small>修订 {t.revision}</small>
                        <pre>{t.text}</pre>
                        {t.interview && (
                          <pre>{JSON.stringify(t.interview, null, 2)}</pre>
                        )}
                      </article>
                    ))}
                </details>
                <details>
                  <summary>请求记录与恢复</summary>
                  {data?.steps.map((step) => (
                    <article key={step.id} className="generator-request">
                      <strong>
                        {step.kind} · {step.status}
                      </strong>
                      {step.error && <p>{step.error}</p>}
                      <details>
                        <summary>查看请求和原始输出</summary>
                        <pre>{step.system}</pre>
                        <pre>{step.user}</pre>
                        <pre>{step.raw}</pre>
                        {step.legacyData && <pre>{step.legacyData}</pre>}
                      </details>
                      {step.status !== "complete" && step.kind !== "legacy" && (
                        <>
                          {!generatorStepIsCurrent(current, step) && (
                            <p className="hint">
                              后续对话或资料已变化，请在独立会话恢复原请求。
                            </p>
                          )}
                          <button
                            disabled={
                              busy || !generatorStepIsCurrent(current, step)
                            }
                            onClick={() =>
                              void perform(() =>
                                retryGenerator(
                                  current.id,
                                  step.batchId,
                                  setRaw,
                                ),
                              )
                            }
                          >
                            从此批次未完成处继续
                          </button>
                          <button
                            disabled={busy}
                            onClick={() =>
                              void perform(async () => {
                                const next = await forkGeneratorRecovery(
                                  step.id,
                                );
                                await refresh(next.id);
                                setSetup(false);
                                setSelectedResults([]);
                                setVersions({});
                                setRaw("");
                                notify(
                                  "已建立独立恢复会话；点击继续才会发送请求",
                                );
                              })
                            }
                          >
                            在独立会话恢复
                          </button>
                          <RecoveryEditor
                            raw={step.raw}
                            disabled={
                              busy || !generatorStepIsCurrent(current, step)
                            }
                            onRecover={(value) =>
                              void perform(() =>
                                recoverGeneratorStep(step.id, value),
                              )
                            }
                          />
                        </>
                      )}
                      {step.kind === "legacy" && (
                        <>
                          <RecoveryEditor
                            raw={step.raw}
                            disabled={busy || step.status === "complete"}
                            onRecover={(value) =>
                              void perform(() =>
                                recoverGeneratorStep(step.id, value),
                              )
                            }
                          />
                          <button onClick={() => void close(onLegacy)}>
                            打开旧版恢复
                          </button>
                        </>
                      )}
                    </article>
                  ))}
                </details>
              </aside>
              <section
                className="generator-results"
                data-visible={tab === "结果"}
              >
                <h3>新角色与世界书</h3>
                <p className="hint">
                  生成后可继续聊着修改。勾选保存的内容都使用新编号，不覆盖原始资料。
                </p>
                {!displayed.length && (
                  <div className="generator-empty">
                    角色还在慢慢成形。聊清楚以后，第一版会出现在这里。
                  </div>
                )}
                {displayed.map(({ key, list, r }) => (
                  <article
                    key={key}
                    className="generator-result"
                    data-testid="generator-result"
                  >
                    <label className="generator-check">
                      <input
                        type="checkbox"
                        checked={selectedResults.includes(r.id)}
                        onChange={(e) =>
                          setSelectedResults(
                            e.target.checked
                              ? [...selectedResults, r.id]
                              : selectedResults.filter((id) => id !== r.id),
                          )
                        }
                      />
                      {r.card?.name || r.world?.title}
                      {r.savedId && <small>已保存</small>}
                    </label>
                    <label>
                      结果版本
                      <select
                        aria-label="结果版本"
                        disabled={busy}
                        value={r.id}
                        onChange={(e) => {
                          setVersions({ ...versions, [key]: e.target.value });
                          setSelectedResults(
                            selectedResults.filter(
                              (id) => !list.some((x) => x.id === id),
                            ),
                          );
                        }}
                      >
                        {list.map((x, i) => (
                          <option key={x.id} value={x.id}>
                            版本 {i + 1}
                            {x.savedId ? " · 已保存" : ""}
                          </option>
                        ))}
                      </select>
                    </label>
                    {r.card ? (
                      <>
                        <p>{r.card.bio || "公开简介留白"}</p>
                        {r.card.sections.map((section) => (
                          <details key={section.title}>
                            <summary>
                              {section.title} ·{" "}
                              {completionBasisLabels[section.basis]}
                            </summary>
                            <p>{section.content}</p>
                            {section.evidence && (
                              <blockquote>{section.evidence}</blockquote>
                            )}
                          </details>
                        ))}
                        <details>
                          <summary>保留、改变与依据</summary>
                          <p>保留：{r.card.preserved.join("；") || "暂无"}</p>
                          <p>改变：{r.card.changed.join("；") || "暂无"}</p>
                          <p>依据：{r.card.reasons.join("；") || "暂无"}</p>
                        </details>
                      </>
                    ) : (
                      <>
                        <p>{r.world?.text}</p>
                        <p>
                          知情范围：
                          {r.world?.audience === "all"
                            ? "所有角色"
                            : r.world?.audience === "author"
                              ? "仅作者"
                              : r.world?.knownBy
                                  .map(
                                    (id) =>
                                      input.targets.find((t) => t.id === id)
                                        ?.name,
                                  )
                                  .join("、")}
                        </p>
                      </>
                    )}
                    <div className="generator-inline">
                      <button
                        disabled={busy}
                        onClick={() => {
                          const draft = ref.current?.editor;
                          if (draft?.resultId === r.id) {
                            patch({ editor: { ...draft, collapsed: false } });
                            return;
                          }
                          if (
                            draft &&
                            !window.confirm(
                              "已有尚未保存为结果版本的编辑草稿。放弃这些修改，改为编辑另一版？",
                            )
                          )
                            return;
                          patch({
                            editor: {
                              resultId: r.id,
                              card: r.card && structuredClone(r.card),
                              world: r.world && structuredClone(r.world),
                            },
                          });
                        }}
                      >
                        编辑这版
                      </button>
                      {r !== list.at(-1) && (
                        <button
                          disabled={busy}
                          onClick={() =>
                            void perform(async () => {
                              await editGeneratorResult(r.id, {
                                card: r.card,
                                world: r.world,
                              });
                              setVersions({ ...versions, [key]: "" });
                            })
                          }
                        >
                          恢复为新版本
                        </button>
                      )}
                    </div>
                    {list.indexOf(r) > 0 && (
                      <details>
                        <summary>与上一版对照</summary>
                        <div className="generator-compare">
                          <section>
                            <h4>上一版</h4>
                            <pre>
                              {comparisonText(
                                list[list.indexOf(r) - 1],
                                input.targets,
                              )}
                            </pre>
                          </section>
                          <section>
                            <h4>当前版本</h4>
                            <pre>{comparisonText(r, input.targets)}</pre>
                          </section>
                        </div>
                      </details>
                    )}
                  </article>
                ))}
                {current.editor?.collapsed && (
                  <div
                    className="generator-result generator-inline"
                    role="status"
                  >
                    <span>编辑草稿已收起，修改内容仍保留。</span>
                    <button
                      disabled={busy}
                      onClick={() =>
                        patch({
                          editor: { ...current.editor!, collapsed: false },
                        })
                      }
                    >
                      继续编辑草稿
                    </button>
                  </div>
                )}
                {current.editor && !current.editor.collapsed && (
                  <fieldset disabled={busy} className="generator-editor">
                    <legend>编辑内容 · 自动保存为编辑草稿</legend>
                    {current.editor.card && (
                      <>
                        <label>
                          姓名
                          <input
                            aria-label="姓名"
                            value={current.editor.card.name}
                            onChange={(e) =>
                              patch({
                                editor: {
                                  ...current.editor!,
                                  card: {
                                    ...current.editor!.card!,
                                    name: e.target.value,
                                  },
                                },
                              })
                            }
                          />
                        </label>
                        <label>
                          公开简介
                          <textarea
                            aria-label="公开简介"
                            value={current.editor.card.bio}
                            onChange={(e) =>
                              patch({
                                editor: {
                                  ...current.editor!,
                                  card: {
                                    ...current.editor!.card!,
                                    bio: e.target.value,
                                  },
                                },
                              })
                            }
                          />
                        </label>
                        {current.editor.card.sections.map((s, i) => (
                          <label key={s.title}>
                            {s.title}
                            <textarea
                              aria-label={s.title}
                              value={s.content}
                              onChange={(e) =>
                                patch({
                                  editor: {
                                    ...current.editor!,
                                    card: {
                                      ...current.editor!.card!,
                                      sections:
                                        current.editor!.card!.sections.map(
                                          (x, j) =>
                                            i === j
                                              ? {
                                                  ...x,
                                                  content: e.target.value,
                                                  basis: "created",
                                                  evidence: "",
                                                  sourceIds: [],
                                                }
                                              : x,
                                        ),
                                    },
                                  },
                                })
                              }
                            />
                          </label>
                        ))}
                      </>
                    )}
                    {current.editor.world && (
                      <>
                        <label>
                          标题
                          <input
                            aria-label="标题"
                            value={current.editor.world.title}
                            onChange={(e) =>
                              patch({
                                editor: {
                                  ...current.editor!,
                                  world: {
                                    ...current.editor!.world!,
                                    title: e.target.value,
                                  },
                                },
                              })
                            }
                          />
                        </label>
                        <label>
                          世界设定
                          <textarea
                            aria-label="世界设定"
                            value={current.editor.world.text}
                            onChange={(e) =>
                              patch({
                                editor: {
                                  ...current.editor!,
                                  world: {
                                    ...current.editor!.world!,
                                    text: e.target.value,
                                  },
                                },
                              })
                            }
                          />
                        </label>
                        <label>
                          知情范围
                          <select
                            aria-label="知情范围"
                            value={current.editor.world.audience}
                            onChange={(e) =>
                              patch({
                                editor: {
                                  ...current.editor!,
                                  world: {
                                    ...current.editor!.world!,
                                    audience: e.target.value as
                                      "all" | "roles" | "author",
                                    knownBy: [],
                                  },
                                },
                              })
                            }
                          >
                            <option value="author">仅作者可见</option>
                            <option value="roles">指定角色可知</option>
                            <option value="all">所有角色可知</option>
                          </select>
                        </label>
                        {(
                          [
                            "roleIds",
                            ...(current.editor.world.audience === "roles"
                              ? ["knownBy"]
                              : []),
                          ] as ("roleIds" | "knownBy")[]
                        ).map((field) => (
                          <fieldset key={field}>
                            <legend>
                              {field === "roleIds" ? "关联人物" : "知情人物"}
                            </legend>
                            {input.targets.map((t) => (
                              <label className="generator-check" key={t.id}>
                                <input
                                  type="checkbox"
                                  checked={current.editor!.world![
                                    field
                                  ].includes(t.id)}
                                  onChange={(e) =>
                                    patch({
                                      editor: {
                                        ...current.editor!,
                                        world: {
                                          ...current.editor!.world!,
                                          [field]: e.target.checked
                                            ? [
                                                ...current.editor!.world![
                                                  field
                                                ],
                                                t.id,
                                              ]
                                            : current.editor!.world![
                                                field
                                              ].filter((id) => id !== t.id),
                                        },
                                      },
                                    })
                                  }
                                />
                                {t.name}
                              </label>
                            ))}
                          </fieldset>
                        ))}
                      </>
                    )}
                    <button
                      onClick={() =>
                        void perform(async () => {
                          const edit = ref.current!.editor!;
                          await editGeneratorResult(edit.resultId, {
                            card: edit.card,
                            world: edit.world,
                          });
                          await db.generatorSessions.update(current.id, {
                            editor: undefined,
                          });
                          setVersions({});
                        })
                      }
                    >
                      保存为新的结果版本
                    </button>
                    <button
                      onClick={() =>
                        patch({
                          editor: { ...current.editor!, collapsed: true },
                        })
                      }
                    >
                      收起编辑草稿
                    </button>
                    <button
                      onClick={() => {
                        if (
                          window.confirm(
                            "放弃这份编辑草稿的修改？已保存的结果版本不受影响。",
                          )
                        )
                          patch({ editor: undefined });
                      }}
                    >
                      放弃修改
                    </button>
                  </fieldset>
                )}
                {!!displayed.length && (
                  <div className="generator-inline">
                    <button
                      onClick={() =>
                        setSelectedResults(displayed.map((x) => x.r.id))
                      }
                    >
                      勾选当前全部结果
                    </button>
                    <button
                      className="primary"
                      disabled={busy || !visibleSelection.length}
                      onClick={() =>
                        void perform(async () => {
                          await saveGeneratorResults(
                            current.id,
                            visibleSelection,
                          );
                          notify("已另存为新资料，原角色与世界书未改变");
                        })
                      }
                    >
                      将勾选结果另存到库
                    </button>
                  </div>
                )}
                {!!data?.results.filter(
                  (r) => r.needsReview || r.revision !== current.revision,
                ).length && (
                  <details>
                    <summary>以前修订的结果（仅供对照）</summary>
                    {data.results
                      .filter(
                        (r) => r.needsReview || r.revision !== current.revision,
                      )
                      .map((r) => (
                        <pre key={r.id}>
                          {JSON.stringify(r.card || r.world, null, 2)}
                        </pre>
                      ))}
                  </details>
                )}
              </section>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
function RecoveryEditor({
  raw,
  disabled,
  onRecover,
}: {
  raw: string;
  disabled: boolean;
  onRecover: (raw: string) => void;
}) {
  const [text, setText] = useState(raw);
  useEffect(() => setText(raw), [raw]);
  return (
    <details>
      <summary>编辑输出并在本地重新解析</summary>
      <textarea
        aria-label="待恢复的原始输出"
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <button disabled={disabled} onClick={() => onRecover(text)}>
        重新解析，不调用 API
      </button>
    </details>
  );
}
function GeneratorConnection({
  disabled,
  onError,
}: {
  disabled: boolean;
  onError: (text: string) => void;
}) {
  const [mode, setMode] = useState<"inherit" | "dedicated">("inherit");
  const [profile, setProfile] = useState<Profile>({
    id: "",
    name: "角色生成器专用接口",
    protocol: "chat",
    url: "",
    model: "",
    stream: true,
    context: 64000,
    maxOutput: 8192,
    timeout: 120,
    temperature: 0.8,
    remember: false,
  });
  const [key, setKey] = useState("");
  const [saved, setSaved] = useState("");
  useEffect(() => {
    void (async () => {
      const p = await db.preferences.get("preferences");
      setMode(p?.generatorConnection || "inherit");
      const dedicated = p?.generatorProfileId
        ? await db.profiles.get(p.generatorProfileId)
        : undefined;
      if (dedicated) {
        setProfile(dedicated);
        setKey(keyFor(dedicated));
      }
    })().catch((e) => onError(err(e)));
  }, []);
  return (
    <fieldset disabled={disabled} className="generator-connection">
      <legend>生成器接口设置</legend>
      <label>
        连接方式
        <select
          aria-label="连接方式"
          value={mode}
          onChange={(e) => setMode(e.target.value as typeof mode)}
        >
          <option value="inherit">跟随通用接口</option>
          <option value="dedicated">使用专用接口</option>
        </select>
      </label>
      {mode === "dedicated" && (
        <>
          <label>
            协议
            <select
              aria-label="协议"
              value={profile.protocol}
              onChange={(e) =>
                setProfile({
                  ...profile,
                  protocol: e.target.value as Profile["protocol"],
                })
              }
            >
              {["chat", "responses", "claude", "gemini"].map((p) => (
                <option key={p}>{p}</option>
              ))}
            </select>
          </label>
          {(
            [
              ["url", "接口地址"],
              ["model", "模型"],
            ] as const
          ).map(([field, label]) => (
            <label key={field}>
              {label}
              <input
                value={profile[field]}
                onChange={(e) =>
                  setProfile({ ...profile, [field]: e.target.value })
                }
              />
            </label>
          ))}
          <label>
            API Key
            <input
              type="password"
              autoComplete="off"
              value={key}
              onChange={(e) => setKey(e.target.value)}
            />
          </label>
          {(
            [
              ["temperature", "温度"],
              ["context", "上下文容量"],
              ["maxOutput", "输出上限"],
              ["timeout", "超时秒数"],
            ] as const
          ).map(([field, label]) => (
            <label key={field}>
              {label}
              <input
                type="number"
                min={field === "temperature" ? 0 : 1}
                max={field === "temperature" ? 2 : undefined}
                step={field === "temperature" ? 0.1 : 1}
                value={profile[field] ?? ""}
                onChange={(e) =>
                  setProfile({
                    ...profile,
                    [field]:
                      e.target.value === "" && field === "temperature"
                        ? undefined
                        : Number(e.target.value),
                  })
                }
              />
            </label>
          ))}
          <label className="generator-check">
            <input
              type="checkbox"
              checked={profile.stream}
              onChange={(e) =>
                setProfile({ ...profile, stream: e.target.checked })
              }
            />
            流式接收
          </label>
          <label className="generator-check">
            <input
              type="checkbox"
              checked={profile.remember}
              onChange={(e) =>
                setProfile({ ...profile, remember: e.target.checked })
              }
            />
            仅在此浏览器记住密钥
          </label>
        </>
      )}
      <button
        onClick={() => {
          void saveGeneratorConnection(mode, profile, key)
            .then(() => setSaved("生成器连接已保存"))
            .catch((e) => onError(err(e)));
        }}
      >
        保存生成器连接
      </button>
      <span role="status">{saved}</span>
    </fieldset>
  );
}
