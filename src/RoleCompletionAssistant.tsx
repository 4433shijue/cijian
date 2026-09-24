import { useEffect, useRef, useState } from "react";
import { Check, Feather, Plus, RefreshCw, Square, Trash2 } from "lucide-react";
import { Modal } from "./Modal";
import { uid } from "./types";
import {
  loadCompletionDraft,
  saveCompletionDraft,
  saveCompletionCards,
  requestCompletionCandidates,
  requestCompletionCard,
} from "./role-completion";
import {
  completionBasisLabels,
  completionSourceKey,
  emptyCompletionDraft,
  type CompletionCard,
  type CompletionCandidate,
  type CompletionDraft,
  type CompletionInput,
} from "./role-completion-types";
import "./role-completion.css";

type Props = {
  onClose: () => void;
  notify: (message: string) => void;
  initialSource?: string;
};
const messageOf = (error: unknown) =>
  error instanceof Error ? error.message : "暂时没能完成，请再试一次。";
const nameKey = (name: string) => name.trim().replace(/\s+/g, "").toLowerCase();
const cardSourceKey = (value: CompletionDraft) =>
  JSON.stringify([
    value.input,
    value.candidates
      .map(({ id, name, description }) => ({
        id,
        name,
        description,
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
  ]);

export function RoleCompletionAssistant({
  onClose,
  notify,
  initialSource,
}: Props) {
  const [draft, setDraft] = useState<CompletionDraft>(emptyCompletionDraft);
  const current = useRef(draft);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [busy, setBusy] = useState("");
  const [closing, setClosing] = useState(false);
  const [saveStatus, setSaveStatus] = useState<
    "idle" | "saving" | "saved" | "error"
  >("idle");
  const [storageError, setStorageError] = useState("");
  const [broughtSource, setBroughtSource] = useState(false);
  const mounted = useRef(false);
  const controller = useRef<AbortController | null>(null);
  const busyRef = useRef(false);
  const savingRoles = useRef(false);
  const closingRef = useRef(false);
  const persistence = useRef<Promise<unknown>>(Promise.resolve());
  const revision = useRef(0);

  function persist(value: CompletionDraft) {
    const edit = ++revision.current;
    if (mounted.current) setSaveStatus("saving");
    // Enqueue immediately so a quick reopen reads even the last keystroke.
    const pending = saveCompletionDraft(value);
    persistence.current = pending;
    void pending.then(
      () => {
        if (mounted.current && edit === revision.current) {
          setSaveStatus("saved");
          setStorageError("");
        }
      },
      (error: unknown) => {
        if (mounted.current && edit === revision.current) {
          setSaveStatus("error");
          setStorageError(
            `草稿暂时没能保存，请保留窗口并重试。${messageOf(error)}`,
          );
        }
      },
    );
    return pending;
  }

  function update(
    change:
      | Partial<CompletionDraft>
      | ((value: CompletionDraft) => Partial<CompletionDraft>),
    save = true,
  ) {
    const next = {
      ...current.current,
      ...(typeof change === "function" ? change(current.current) : change),
      updated: Date.now(),
    };
    current.current = next;
    if (mounted.current) setDraft(next);
    if (save) void persist(next);
    return next;
  }

  useEffect(() => {
    let active = true;
    mounted.current = true;
    setLoading(true);
    setLoadError("");
    void loadCompletionDraft()
      .then((saved) => {
        if (!active) return;
        const next = saved || emptyCompletionDraft();
        // Existing work always wins over text carried from the manual role editor.
        if (
          !next.input.source.trim() &&
          !next.candidates.length &&
          !next.cards.length &&
          initialSource?.trim()
        ) {
          next.input = { ...next.input, source: initialSource };
          setBroughtSource(true);
        } else if (
          initialSource?.trim() &&
          next.input.source !== initialSource
        ) {
          setBroughtSource(false);
        }
        current.current = next;
        setDraft(next);
        setLoading(false);
        if (next.input.source === initialSource && initialSource?.trim())
          void persist(next);
      })
      .catch((error: unknown) => {
        if (!active) return;
        setLoadError(
          `补全草稿没能读取，已有内容不会被覆盖。${messageOf(error)}`,
        );
        setLoading(false);
      });
    return () => {
      active = false;
      mounted.current = false;
      controller.current?.abort();
    };
  }, [loadAttempt]);

  function stopTask() {
    controller.current?.abort();
    controller.current = null;
    busyRef.current = false;
    setBusy("");
    update({ error: "已停止生成。已完成的角色卡仍在这里，可以继续。" });
  }

  async function close() {
    if (savingRoles.current || closingRef.current) return;
    if (loading || loadError) {
      onClose();
      return;
    }
    if (busyRef.current) stopTask();
    closingRef.current = true;
    busyRef.current = true;
    setClosing(true);
    try {
      await persist(current.current);
      onClose();
    } catch {
      // Keep the editor open so a storage error cannot silently lose its input.
    } finally {
      closingRef.current = false;
      busyRef.current = false;
      if (mounted.current) setClosing(false);
    }
  }

  function changeInput(patch: Partial<CompletionInput>) {
    if (busyRef.current || loading || loadError) return;
    update((value) => ({ input: { ...value.input, ...patch }, error: "" }));
  }

  async function generateCards(
    targets: CompletionCandidate[],
    signal: AbortSignal,
    replaceCardId?: string,
  ) {
    for (let index = 0; index < targets.length; index += 1) {
      if (signal.aborted || !mounted.current) return;
      const target = targets[index];
      setBusy(`正在补全 ${target.name} · ${index + 1} / ${targets.length}`);
      update({ raw: "", error: "" });
      const snapshot = current.current;
      const sourceKey = cardSourceKey(snapshot);
      const completed = snapshot.cards.filter(
        (card) =>
          card.candidateId !== target.id && card.sourceKey === sourceKey,
      );
      const card = await requestCompletionCard(
        snapshot.input,
        snapshot.candidates,
        target,
        completed,
        signal,
        (raw) => {
          if (!signal.aborted && mounted.current) update({ raw }, false);
        },
      );
      if (signal.aborted || !mounted.current) return;
      update((value) => ({
        cards: replaceCardId
          ? [
              ...value.cards.filter(
                (previous) =>
                  previous.id !== replaceCardId || previous.savedRoleId,
              ),
              { ...card, sourceKey },
            ]
          : [...value.cards, { ...card, sourceKey }],
        error: "",
      }));
    }
  }

  async function runTask(task: (signal: AbortSignal) => Promise<void>) {
    if (busyRef.current || loading || loadError) return;
    busyRef.current = true;
    const request = new AbortController();
    controller.current = request;
    setBusy("正在阅读素材…");
    update({ error: "" });
    try {
      await task(request.signal);
    } catch (error) {
      if (mounted.current && controller.current === request) {
        update({
          error: request.signal.aborted
            ? "已停止生成。已完成的角色卡仍在这里，可以继续。"
            : messageOf(error),
        });
      }
    } finally {
      if (controller.current === request) {
        controller.current = null;
        busyRef.current = false;
        if (mounted.current) setBusy("");
      }
    }
  }

  function identify() {
    const input = current.current.input;
    if (!input.source.trim()) {
      update({ error: "先写下一段人物描述、故事或零散设定吧。" });
      return;
    }
    void runTask(async (signal) => {
      update({ raw: "" });
      const found = await requestCompletionCandidates(input, signal, (raw) => {
        if (!signal.aborted && mounted.current) update({ raw }, false);
      });
      if (signal.aborted || !mounted.current) return;
      const sameSource =
        current.current.sourceKey === completionSourceKey(input);
      const candidates = found.map((candidate) => {
        const previous =
          sameSource &&
          current.current.candidates.find(
            (item) => nameKey(item.name) === nameKey(candidate.name),
          );
        return previous ? { ...previous } : candidate;
      });
      update({ candidates, sourceKey: completionSourceKey(input), error: "" });
      const specified = input.targets
        .split(/[,，、;；\n]+/)
        .map(nameKey)
        .filter(Boolean);
      const exactTargets =
        specified.length > 0 &&
        specified.every((name) =>
          candidates.some((candidate) => nameKey(candidate.name) === name),
        );
      if (
        (input.mode === "single" && candidates.length === 1) ||
        (input.mode === "multiple" && exactTargets)
      ) {
        const selected = candidates.map((candidate) => ({
          ...candidate,
          selected:
            input.mode === "single" ||
            specified.includes(nameKey(candidate.name)),
        }));
        update({ candidates: selected });
        const missing = selected.filter(
          (candidate) =>
            candidate.selected &&
            !current.current.cards.some(
              (card) =>
                card.candidateId === candidate.id &&
                card.sourceKey === cardSourceKey(current.current),
            ),
        );
        if (missing.length) await generateCards(missing, signal);
      }
    });
  }

  function generateSelected() {
    const value = current.current;
    if (value.sourceKey !== completionSourceKey(value.input)) return;
    const targets = value.candidates.filter(
      (candidate) =>
        candidate.selected &&
        !value.cards.some(
          (card) =>
            card.candidateId === candidate.id &&
            card.sourceKey === cardSourceKey(value),
        ),
    );
    if (!targets.length) return;
    if (targets.some((candidate) => !candidate.name.trim())) {
      update({ error: "给选中的主角填一个名字或称呼，再开始生成。" });
      return;
    }
    void runTask((signal) => generateCards(targets, signal));
  }

  function retryCard(card: CompletionCard) {
    if (
      card.savedRoleId ||
      current.current.sourceKey !== completionSourceKey(current.current.input)
    )
      return;
    const candidate = current.current.candidates.find(
      (item) => item.id === card.candidateId,
    );
    if (!candidate?.selected) return;
    void runTask((signal) => generateCards([candidate], signal, card.id));
  }

  function editCandidate(id: string, patch: Partial<CompletionCandidate>) {
    if (busyRef.current) return;
    update((value) => ({
      candidates: value.candidates.map((candidate) => {
        if (candidate.id === id) return { ...candidate, ...patch };
        return patch.selected && value.input.mode === "single"
          ? { ...candidate, selected: false }
          : candidate;
      }),
    }));
  }

  function editCard(id: string, patch: Partial<CompletionCard>) {
    if (busyRef.current) return;
    update((value) => ({
      cards: value.cards.map((card) =>
        card.id === id && !card.savedRoleId ? { ...card, ...patch } : card,
      ),
    }));
  }

  async function saveCards(all = false) {
    if (busyRef.current) return;
    const ids = current.current.cards
      .filter((card) => !card.savedRoleId && (all || card.selected))
      .map((card) => card.id);
    if (!ids.length) return;
    busyRef.current = true;
    savingRoles.current = true;
    setBusy("正在加入角色库…");
    try {
      await persistence.current.catch(() => undefined);
      const saved = await saveCompletionCards(current.current, ids);
      current.current = saved;
      if (mounted.current) {
        setDraft(saved);
        setSaveStatus("saved");
        setStorageError("");
        notify(`已将 ${ids.length} 位角色加入角色库`);
      }
    } catch (error) {
      if (mounted.current)
        update({
          error: `角色没能保存，草稿仍在，请重试。${messageOf(error)}`,
        });
    } finally {
      busyRef.current = false;
      savingRoles.current = false;
      if (mounted.current) setBusy("");
    }
  }

  const stale =
    draft.candidates.length > 0 &&
    draft.sourceKey !== completionSourceKey(draft.input);
  const unsaved = draft.cards.filter((card) => !card.savedRoleId);
  const selectedCards = unsaved.filter((card) => card.selected);
  const sourceSignature = cardSourceKey(draft);
  const pendingCandidates = draft.candidates.filter(
    (candidate) =>
      candidate.selected &&
      !draft.cards.some(
        (card) =>
          card.candidateId === candidate.id &&
          card.sourceKey === sourceSignature,
      ),
  );
  const disabled = !!busy || closing || loading || !!loadError;

  return (
    <Modal title="帮我补全角色" onClose={close}>
      <div className="role-completion">
        <div className="completion-intro">
          <span className="eyebrow">LET THEM COME INTO FOCUS</span>
          <p>把脑海里的那个人，慢慢写清楚。</p>
          <span>
            放进人设、故事、对白或零散想法，整理成可以继续写戏的角色档案。
          </span>
        </div>
        {loading && (
          <p className="hint" role="status">
            正在读取上次的补全草稿…
          </p>
        )}
        {loadError && (
          <div className="error" role="alert">
            <p>{loadError}</p>
            <button onClick={() => setLoadAttempt((value) => value + 1)}>
              重新读取草稿
            </button>
          </div>
        )}
        {initialSource?.trim() && !loading && !loadError && (
          <p className="hint">
            {broughtSource
              ? "已带入刚才填写的人设。手动创建的角色草稿也会保留。"
              : "已恢复上次的补全草稿，刚才手动填写的人设仍留在角色编辑器中。"}
          </p>
        )}
        <fieldset className="completion-fields" disabled={disabled}>
          <label className="field">
            <span>人物或故事素材</span>
            <textarea
              className="completion-source"
              value={draft.input.source}
              onChange={(event) => changeInput({ source: event.target.value })}
              placeholder="他是怎样的人？他们经历过什么？写一句话也好，放进一整段故事也好。"
            />
          </label>
          <div className="completion-mode" role="group" aria-label="角色卡人数">
            <label className={draft.input.mode === "single" ? "selected" : ""}>
              <input
                type="radio"
                name="completion-mode"
                checked={draft.input.mode === "single"}
                onChange={() => changeInput({ mode: "single" })}
              />
              <span>
                单人角色卡<small>把一个人写得更清楚</small>
              </span>
            </label>
            <label
              className={draft.input.mode === "multiple" ? "selected" : ""}
            >
              <input
                type="radio"
                name="completion-mode"
                checked={draft.input.mode === "multiple"}
                onChange={() => changeInput({ mode: "multiple" })}
              />
              <span>
                多人角色卡<small>找出主角，分别建立档案</small>
              </span>
            </label>
          </div>
          <div className="completion-input-grid">
            <label className="field">
              <span>想生成谁（可选）</span>
              <textarea
                rows={2}
                value={draft.input.targets}
                onChange={(event) =>
                  changeInput({ targets: event.target.value })
                }
                placeholder="名字、称呼或人物描述；多个人可用顿号分开。"
              />
            </label>
            <label className="field">
              <span>补充要求（可选）</span>
              <textarea
                rows={2}
                value={draft.input.guidance}
                onChange={(event) =>
                  changeInput({ guidance: event.target.value })
                }
                placeholder="必须保留的设定，或者希望着重描写的部分。"
              />
            </label>
          </div>
          <label className="field">
            <span>补全程度</span>
            <select
              value={draft.input.creativity}
              onChange={(event) =>
                changeInput({
                  creativity: event.target
                    .value as CompletionInput["creativity"],
                })
              }
            >
              <option value="faithful">忠于原文 · 未知处留待补充</option>
              <option value="balanced">适度补全 · 保留设定，丰富细节</option>
              <option value="creative">自由丰富 · 允许创作经历与动机</option>
            </select>
          </label>
          <p className="hint">
            明确写下的设定会优先保留。推测和新增内容会在卡片中标明，保存前可以修改。
          </p>
          <div className="completion-actions">
            <button
              className="primary"
              type="button"
              onClick={identify}
              disabled={disabled || !draft.input.source.trim()}
            >
              <Feather size={17} />
              帮我补全
            </button>
            <span className="hint">使用你在设置中配置的模型</span>
          </div>
        </fieldset>

        {!!draft.candidates.length && (
          <section className="completion-candidates" aria-label="确认主角">
            <div className="completion-section-heading">
              <div>
                <span className="eyebrow">01 · THE PEOPLE</span>
                <h3>这次，想写清楚谁？</h3>
              </div>
              <span className="hint">
                {draft.input.mode === "single"
                  ? "选择一位主角"
                  : "可以选择多位主角"}
              </span>
            </div>
            <p className="hint">
              检查名字和识别线索；称呼含糊时，可以直接改清楚。
            </p>
            {stale && (
              <p className="completion-warning" role="status">
                素材或补全要求已经修改。之前的卡片仍保留，请重新点击「帮我补全」识别主角。
              </p>
            )}
            <fieldset
              className="completion-fields"
              disabled={disabled || stale}
            >
              {draft.candidates.map((candidate, index) => (
                <div className="completion-candidate" key={candidate.id}>
                  <input
                    aria-label={`选择主角 ${candidate.name}`}
                    type={draft.input.mode === "single" ? "radio" : "checkbox"}
                    name="completion-candidate"
                    checked={candidate.selected}
                    onChange={(event) =>
                      editCandidate(candidate.id, {
                        selected: event.target.checked,
                      })
                    }
                  />
                  <div>
                    <input
                      aria-label={`主角名字 ${index + 1}`}
                      value={candidate.name}
                      onChange={(event) =>
                        editCandidate(candidate.id, {
                          name: event.target.value,
                        })
                      }
                    />
                    <textarea
                      aria-label={`主角线索 ${index + 1}`}
                      rows={2}
                      value={candidate.description}
                      onChange={(event) =>
                        editCandidate(candidate.id, {
                          description: event.target.value,
                        })
                      }
                    />
                  </div>
                  <button
                    type="button"
                    aria-label={`移除主角 ${candidate.name}`}
                    onClick={() =>
                      update((value) => ({
                        candidates: value.candidates.filter(
                          (item) => item.id !== candidate.id,
                        ),
                      }))
                    }
                  >
                    <Trash2 size={16} />
                  </button>
                </div>
              ))}
              <div className="completion-actions">
                <button
                  type="button"
                  onClick={() =>
                    update((value) => ({
                      candidates: [
                        ...value.candidates,
                        {
                          id: uid(),
                          name: "",
                          description: "",
                          selected:
                            value.input.mode === "multiple" ||
                            !value.candidates.some(
                              (candidate) => candidate.selected,
                            ),
                        },
                      ],
                    }))
                  }
                >
                  <Plus size={16} />
                  添加一位主角
                </button>
                <button
                  className="primary"
                  type="button"
                  disabled={disabled || stale || !pendingCandidates.length}
                  onClick={generateSelected}
                >
                  {draft.cards.length
                    ? "继续生成未完成角色"
                    : "生成选中的角色卡"}
                </button>
              </div>
            </fieldset>
          </section>
        )}

        {busy && (
          <div className="completion-progress" role="status">
            <span>
              <Feather size={17} />
              {busy}
            </span>
            {!savingRoles.current && (
              <button type="button" onClick={stopTask}>
                <Square size={14} />
                停止生成
              </button>
            )}
            <small>已完成的卡片会逐张保留。关闭窗口会停止本次生成。</small>
          </div>
        )}
        {draft.error && (
          <p className="error completion-error" role="alert">
            {draft.error}
          </p>
        )}
        {storageError && (
          <div className="error completion-error" role="alert">
            <p>{storageError}</p>
            <button
              type="button"
              disabled={!!busy}
              onClick={() => void persist(current.current)}
            >
              重试保存草稿
            </button>
          </div>
        )}

        {!!draft.cards.length && (
          <section className="completion-results" aria-label="角色卡预览">
            <div className="completion-section-heading">
              <div>
                <span className="eyebrow">02 · THEIR STORIES</span>
                <h3>让他们成为你笔下的人</h3>
              </div>
              <span className="hint">{draft.cards.length} 份角色卡</span>
            </div>
            <p className="hint">
              十个维度都可以展开修改。公开简介会让其他角色看到，秘密与未公开经历请留在人设正文中。
            </p>
            {draft.cards.map((card) => (
              <article
                className={`completion-card${card.savedRoleId ? " is-saved" : ""}`}
                key={card.id}
                data-testid="completion-card"
              >
                <header className="completion-card-heading">
                  <div>
                    <span className="completion-avatar" aria-hidden="true">
                      {card.name.slice(0, 1) || "人"}
                    </span>
                    <h3>{card.name || "未命名角色"}</h3>
                  </div>
                  {card.savedRoleId ? (
                    <span className="completion-saved">
                      <Check size={15} />
                      已加入角色库
                    </span>
                  ) : (
                    <label className="completion-select">
                      <input
                        type="checkbox"
                        aria-label={`保存 ${card.name}`}
                        checked={card.selected}
                        disabled={disabled}
                        onChange={(event) =>
                          editCard(card.id, { selected: event.target.checked })
                        }
                      />
                      选中保存
                    </label>
                  )}
                </header>
                {card.sourceKey !== sourceSignature && (
                  <p className="completion-warning">
                    这份卡片来自之前的素材或主角名单，仍可编辑保存。它不会作为本轮生成的关系依据。
                  </p>
                )}
                <fieldset
                  className="completion-fields"
                  disabled={disabled || !!card.savedRoleId}
                >
                  <label className="field">
                    <span>角色名字</span>
                    <input
                      aria-label="角色名字"
                      value={card.name}
                      onChange={(event) =>
                        editCard(card.id, { name: event.target.value })
                      }
                    />
                  </label>
                  <label className="field">
                    <span>公开简介</span>
                    <textarea
                      aria-label="公开简介"
                      value={card.bio}
                      onChange={(event) =>
                        editCard(card.id, { bio: event.target.value })
                      }
                    />
                  </label>
                  <p className="hint">
                    其他角色可以看到这段简介，请确认其中没有秘密。
                  </p>
                </fieldset>
                <div className="completion-dimensions">
                  {card.sections.map((section, index) => (
                    <details
                      key={`${card.id}-${index}`}
                      open={index === 0 ? true : undefined}
                    >
                      <summary>
                        <span>{section.title}</span>
                        <span
                          className={`completion-basis basis-${section.basis}`}
                        >
                          {section.edited
                            ? "已手动修改"
                            : completionBasisLabels[section.basis]}
                        </span>
                      </summary>
                      <textarea
                        aria-label={section.title}
                        value={section.content}
                        disabled={disabled || !!card.savedRoleId}
                        onChange={(event) =>
                          editCard(card.id, {
                            sections: card.sections.map((item, position) =>
                              position === index
                                ? {
                                    ...item,
                                    content: event.target.value,
                                    edited: true,
                                  }
                                : item,
                            ),
                          })
                        }
                      />
                      {section.evidence && (
                        <p className="completion-evidence">
                          <strong>
                            {section.edited ? "生成时参考" : "依据"}
                          </strong>
                          {section.evidence}
                        </p>
                      )}
                    </details>
                  ))}
                </div>
                {!card.savedRoleId && (
                  <div className="completion-actions">
                    <button
                      type="button"
                      disabled={
                        disabled ||
                        stale ||
                        card.sourceKey !== sourceSignature ||
                        !draft.candidates.some(
                          (candidate) =>
                            candidate.id === card.candidateId &&
                            candidate.selected,
                        )
                      }
                      onClick={() => retryCard(card)}
                      aria-label={`重新生成 ${card.name}`}
                    >
                      <RefreshCw size={15} />
                      重新生成这位
                    </button>
                    <span className="hint">新卡成功生成后才会替换这一份</span>
                  </div>
                )}
              </article>
            ))}
            <div className="completion-save-bar">
              <span>
                {unsaved.length
                  ? `${selectedCards.length} 位已选中，等你收入角色库`
                  : "这些角色已经收进角色库了。"}
              </span>
              <div>
                <button
                  type="button"
                  disabled={disabled || !unsaved.length}
                  onClick={() => void saveCards(true)}
                >
                  保存全部角色
                </button>
                <button
                  className="primary"
                  type="button"
                  disabled={disabled || !selectedCards.length}
                  onClick={() => void saveCards()}
                >
                  <Check size={16} />
                  保存选中的角色
                </button>
              </div>
            </div>
          </section>
        )}
        {draft.raw && (
          <details className="completion-raw">
            <summary>查看本次模型原始输出</summary>
            <pre>{draft.raw}</pre>
          </details>
        )}
        <p className="hint">
          补全草稿只保存在当前浏览器。角色卡加入角色库后，才会随资料备份一起导出。
        </p>
        {!loading && !loadError && (
          <div className="completion-footer">
            <span className="hint" role="status">
              {saveStatus === "saving"
                ? "正在保存草稿…"
                : saveStatus === "saved"
                  ? "草稿已自动保存"
                  : saveStatus === "error"
                    ? "草稿尚未保存，请重试"
                    : "输入与已完成的卡片会自动保存到本机"}{" "}
              · 下次打开可以继续
            </span>
            <button
              type="button"
              disabled={disabled}
              onClick={() => {
                if (
                  (draft.input.source ||
                    draft.input.targets ||
                    draft.input.guidance ||
                    draft.candidates.length ||
                    draft.raw ||
                    draft.cards.length) &&
                  !window.confirm(
                    "开始一份新素材会清空本机这份素材、候选名单和卡片预览，已存入角色库的档案会保留。确定继续吗？",
                  )
                )
                  return;
                update(emptyCompletionDraft());
                setBroughtSource(false);
              }}
            >
              开始一份新素材
            </button>
          </div>
        )}
      </div>
    </Modal>
  );
}
