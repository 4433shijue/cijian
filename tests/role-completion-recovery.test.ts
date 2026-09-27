import "fake-indexeddb/auto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { db, sessionKeys } from "../src/db";
import {
  loadCompletionDraft,
  parseCompletionCard,
  recoverCompletionAttempt,
  recoverLegacyCompletionRaw,
  requestCompletionCard,
  saveCompletionDraft,
} from "../src/role-completion";
import {
  completionCardSourceKey,
  completionDimensions,
  completionSourceKey,
  emptyCompletionDraft,
  type CompletionAttempt,
  type CompletionCandidate,
  type CompletionDraft,
  type CompletionInput,
} from "../src/role-completion-types";
import type { Profile } from "../src/types";

// Entirely invented neutral data. User attachments must never become fixtures.
const input: CompletionInput = {
  source: '季禾是园艺师，整理过一本名为"春日笔记"的小册子。叶宁负责图书登记。',
  mode: "multiple",
  targets: "季禾、叶宁",
  guidance: "保留书名，未知处留待补充。",
  creativity: "balanced",
};
const target: CompletionCandidate = {
  id: "recovery-gardener",
  name: "季禾",
  description: "整理植物笔记的园艺师",
  selected: true,
};
const second: CompletionCandidate = {
  id: "recovery-librarian",
  name: "叶宁",
  description: "负责登记图书",
  selected: true,
};
const profile: Profile = {
  id: "recovery-profile",
  name: "隔离结构测试",
  protocol: "chat",
  url: "https://recovery.fixture.test/v1",
  model: "fixture",
  stream: false,
  context: 64000,
  maxOutput: 8192,
  timeout: 10,
  remember: false,
};

function payload(person = target) {
  return {
    candidateId: person.id,
    name: person.name,
    bio: `${person.name}，负责整理资料。`,
    sections: completionDimensions.map((title, index) => ({
      title,
      content:
        index === 1
          ? '手里拿着"春日笔记"，书签上写着"待整理"。'
          : index === 6
            ? '会说"请放在右边"，随后把书本摆齐。'
            : `${title}的其他资料尚待补充。`,
      basis: "unknown",
      evidence: "",
    })),
  };
}

const malformed = (person = target) =>
  "```json\n" +
  JSON.stringify(payload(person), null, 2).replaceAll('\\"', '"') +
  "\n```";

const cardKey = completionCardSourceKey;

function draftWithAttempt(raw = malformed()): CompletionDraft {
  const draft: CompletionDraft = {
    ...emptyCompletionDraft(),
    input: structuredClone(input),
    sourceKey: completionSourceKey(input),
    candidates: structuredClone([target, second]),
    raw,
    error: "上一次解析失败。",
  };
  const attempt: CompletionAttempt = {
    id: "failed-card-request",
    stage: "card",
    target: structuredClone(target),
    inputKey: completionSourceKey(input),
    sourceKey: cardKey(draft),
    raw,
    state: "failed",
    error: draft.error,
    complete: true,
    finishReason: "stop",
    created: 100,
    updated: 100,
  };
  draft.attempts = [attempt];
  return draft;
}

function response(raw: string, finishReason?: string) {
  return new Response(
    JSON.stringify({
      choices: [{ message: { content: raw }, finish_reason: finishReason }],
    }),
    { headers: { "Content-Type": "application/json" } },
  );
}

beforeEach(async () => {
  await db.delete();
  await db.open();
  await db.profiles.put(profile);
  await db.preferences.put({
    id: "preferences",
    activeProfile: profile.id,
    developer: false,
    prompts: {},
  });
  sessionKeys.set(profile.id, "isolated-fixture-key");
});

afterEach(async () => {
  await loadCompletionDraft();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  sessionKeys.clear();
  await db.delete();
});

it("repairs internal quotes without changing text, identities, section order or evidence", () => {
  const raw = malformed();
  const card = parseCompletionCard(raw, input, target);
  expect(card.sections).toEqual(payload().sections);
  expect(card.candidateId).toBe(target.id);
  expect(card.name).toBe(target.name);
  expect(card.parseInfo?.wrapper).toBe("fenced");
  expect(
    card.parseInfo?.repairs.reduce((sum, item) => sum + item.count, 0),
  ).toBe(6);
  expect(card.parseInfo?.repairs.map((item) => item.field)).toEqual([
    "content",
    "content",
  ]);
  expect(card.parseInfo?.repairs.every((item) => item.line > 0)).toBe(true);
  expect(raw).toBe(malformed());
});

it("retains correctly escaped quotes, backslashes and line breaks without inventing repairs", () => {
  const value = payload();
  value.sections[1].content =
    '书脊上写着"春日笔记"。\n登记符号为 \\ ，下一页留空。';
  const card = parseCompletionCard(JSON.stringify(value), input, target);
  expect(card.sections).toEqual(value.sections);
  expect(card.parseInfo?.repairs ?? []).toEqual([]);
});

it("normalizes literal-only string concatenation together with quote repairs while preserving the exact joined value", () => {
  const value = payload();
  value.bio = "负责整理图书的资料员。";
  const raw = JSON.stringify(value, null, 2)
    .replaceAll('\\"', '"')
    .replace(
      '"bio": "负责整理图书的资料员。"',
      '"bio": "负责整理图书" + "的资料员。"',
    );
  const card = parseCompletionCard(raw, input, target);
  expect(card.bio).toBe(value.bio);
  expect(card.sections).toEqual(value.sections);
  expect(
    card.parseInfo?.repairs.filter((repair) => repair.kind === "string-concat"),
  ).toEqual([expect.objectContaining({ field: "bio", count: 1 })]);
  expect(
    card.parseInfo?.repairs
      .filter((repair) => repair.kind !== "string-concat")
      .reduce((sum, repair) => sum + repair.count, 0),
  ).toBe(6);
  expect(raw).toContain('"负责整理图书" + "的资料员。"');
});

it("recognizes the only complete JSON object in surrounding explanation while preserving its values", () => {
  const raw = `以下是资料。\n${JSON.stringify(payload())}\n资料整理结束。`;
  const card = parseCompletionCard(raw, input, target);
  expect(card.sections).toEqual(payload().sections);
  expect(card.parseInfo?.wrapper).toBe("embedded");
});

it.each([
  ["truncated", () => JSON.stringify(payload()).slice(0, -9)],
  [
    "missing comma",
    () => JSON.stringify(payload()).replace('","name"', '""name"'),
  ],
  [
    "two objects",
    () => JSON.stringify(payload()) + "\n" + JSON.stringify(payload(second)),
  ],
])("does not guess %s structure into a usable card", (_label, makeRaw) => {
  expect(() => parseCompletionCard(makeRaw(), input, target)).toThrow();
});

it("still rejects the wrong identity, missing dimensions and duplicates after quote repair", () => {
  const wrong = malformed(second);
  expect(() => parseCompletionCard(wrong, input, target)).toThrow("不一致");
  const missing = payload();
  missing.sections.pop();
  expect(() =>
    parseCompletionCard(
      JSON.stringify(missing, null, 2).replaceAll('\\"', '"'),
      input,
      target,
    ),
  ).toThrow("十个维度");
  const duplicate = payload();
  duplicate.sections[1].title = duplicate.sections[0].title;
  expect(() =>
    parseCompletionCard(
      JSON.stringify(duplicate, null, 2).replaceAll('\\"', '"'),
      input,
      target,
    ),
  ).toThrow("重复或遗漏");
});

it("recovers one failed attempt locally, retains a previously edited card and never saves a role", async () => {
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  const draft = draftWithAttempt();
  const previous = parseCompletionCard(
    JSON.stringify(payload(second)),
    input,
    second,
  );
  previous.sourceKey = cardKey(draft);
  previous.sections[0] = {
    ...previous.sections[0],
    content: "这是作者手动编辑的资料。",
    edited: true,
  };
  draft.cards = [previous];
  const snapshot = structuredClone(draft);
  const recovered = recoverCompletionAttempt(draft, "failed-card-request");
  expect(recovered.cards).toHaveLength(2);
  expect(recovered.cards[0]).toEqual(previous);
  expect(recovered.cards[1].sections).toEqual(payload().sections);
  expect(recovered.cards[1].sourceKey).toBe(cardKey(draft));
  expect(recovered.attempts?.[0]).toMatchObject({
    raw: draft.raw,
    state: "recovered",
  });
  expect(draft).toEqual(snapshot);
  expect(fetcher).not.toHaveBeenCalled();
  expect(await db.roles.count()).toBe(0);
  await saveCompletionDraft(recovered);
  expect((await loadCompletionDraft())?.attempts?.[0].raw).toBe(draft.raw);
});

it("keeps edited repair text separate from the original response and checks it before adopting", () => {
  const incomplete = JSON.stringify(payload()).slice(0, -9);
  const draft = draftWithAttempt(incomplete);
  expect(() =>
    recoverCompletionAttempt(draft, "failed-card-request"),
  ).toThrow();
  expect(draft.cards).toEqual([]);
  expect(draft.attempts?.[0].raw).toBe(incomplete);
  const edited = JSON.stringify(payload());
  const recovered = recoverCompletionAttempt(
    draft,
    "failed-card-request",
    edited,
  );
  expect(recovered.cards[0].sections).toEqual(payload().sections);
  expect(recovered.attempts?.[0]).toMatchObject({
    raw: incomplete,
    recoveryText: edited,
    state: "recovered",
  });
});

it("recovers candidate JSON without regenerating cards or losing an existing candidate identity", () => {
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  const draft = draftWithAttempt();
  const earlier = parseCompletionCard(
    JSON.stringify(payload(second)),
    input,
    second,
  );
  earlier.sourceKey = cardKey(draft);
  earlier.bio = "已经检查过的资料。";
  draft.cards = [earlier];
  draft.attempts![0] = {
    ...draft.attempts![0],
    stage: "candidates",
    target: undefined,
    sourceKey: completionSourceKey(input),
    raw: JSON.stringify(
      {
        candidates: [
          { name: target.name, description: '整理"植物"资料。', aliases: [] },
        ],
      },
      null,
      2,
    ).replaceAll('\\"', '"'),
  };
  const recovered = recoverCompletionAttempt(draft, "failed-card-request");
  expect(recovered.candidates).toEqual([target, second]);
  expect(recovered.cards).toEqual([earlier]);
  expect(recovered.attempts![0].state).toBe("recovered");
  expect(fetcher).not.toHaveBeenCalled();
});

it("does not discard a manually added selected person when an earlier candidate attempt is recovered", () => {
  const draft = draftWithAttempt();
  const manual: CompletionCandidate = {
    id: "author-added-candidate",
    name: "余青",
    description: "作者亲自补充的图书管理员",
    selected: true,
  };
  draft.candidates.push(manual);
  draft.attempts![0] = {
    ...draft.attempts![0],
    stage: "candidates",
    target: undefined,
    sourceKey: completionSourceKey(input),
    raw: JSON.stringify({
      candidates: [
        { name: target.name, description: target.description, aliases: [] },
      ],
    }),
  };
  const recovered = recoverCompletionAttempt(draft, "failed-card-request");
  expect(recovered.candidates).toContainEqual(manual);
  expect(recovered.candidates).toContainEqual(second);
  expect(recovered.cards).toEqual([]);
});

it("marks a persisted running attempt interrupted after reload and preserves received bytes for explicit recovery", async () => {
  const draft = draftWithAttempt();
  draft.attempts![0].state = "running";
  await saveCompletionDraft(draft);
  const reloaded = (await loadCompletionDraft())!;
  expect(reloaded.attempts![0]).toMatchObject({
    state: "interrupted",
    raw: draft.raw,
  });
  expect(reloaded.cards).toEqual([]);
  expect(
    (await db.roleCompletionDrafts.get(draft.id))?.attempts?.[0].state,
  ).toBe("interrupted");
  const recovered = recoverCompletionAttempt(reloaded, "failed-card-request");
  expect(recovered.cards).toHaveLength(1);
  expect(await db.roles.count()).toBe(0);
});

it("does not overwrite a successful or manually edited card when an older attempt is reparsed", () => {
  const draft = draftWithAttempt();
  const card = parseCompletionCard(JSON.stringify(payload()), input, target);
  card.sourceKey = cardKey(draft);
  card.bio = "作者已经确认的简介。";
  card.sections[0].content = "作者已经修正的身份。";
  card.sections[0].edited = true;
  draft.cards = [card];
  const snapshot = structuredClone(draft);
  expect(() =>
    recoverCompletionAttempt(draft, "failed-card-request"),
  ).toThrow();
  expect(draft).toEqual(snapshot);
});

it.each([
  [
    "source",
    (draft: CompletionDraft) => {
      draft.input.source += "补充了新素材。";
    },
  ],
  [
    "guidance",
    (draft: CompletionDraft) => {
      draft.input.guidance = "新的补全要求。";
    },
  ],
  [
    "candidate name",
    (draft: CompletionDraft) => {
      draft.candidates[0].name = "季禾的新称呼";
    },
  ],
  [
    "candidate description",
    (draft: CompletionDraft) => {
      draft.candidates[0].description = "更新后的识别线索";
    },
  ],
  [
    "other candidate",
    (draft: CompletionDraft) => {
      draft.candidates[1].description = "关系资料已经更新";
    },
  ],
  [
    "selection",
    (draft: CompletionDraft) => {
      draft.candidates[0].selected = false;
    },
  ],
])("refuses recovery after the %s has changed", (_label, change) => {
  const draft = draftWithAttempt();
  change(draft);
  expect(() =>
    recoverCompletionAttempt(draft, "failed-card-request"),
  ).toThrow();
  expect(draft.cards).toEqual([]);
  expect(draft.attempts?.[0].raw).toBe(malformed());
});

it.each([
  ["MAX_TOKENS", true],
  ["SAFETY", false],
  ["RECITATION", false],
] as const)(
  "retains Gemini %s as a completion failure without an automatic retry",
  async (finishReason, suggestLimit) => {
    await db.profiles.update(profile.id, { protocol: "gemini" });
    const raw = JSON.stringify(payload());
    const fetcher = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: raw }] }, finishReason }],
        }),
        { headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetcher);
    const retained = vi.fn();
    const failure = await requestCompletionCard(
      input,
      [target],
      target,
      [],
      new AbortController().signal,
      retained,
    ).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain(finishReason);
    expect(
      /(?:可|建议)(?:提高|增加|调高|调整).*输出/.test(
        (failure as Error).message,
      ),
    ).toBe(suggestLimit);
    expect(retained).toHaveBeenLastCalledWith(raw);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(await db.roles.count()).toBe(0);
  },
);

it("recovers a pre-upgrade raw response only when its input and selected identity still match", async () => {
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  const legacy = draftWithAttempt();
  delete legacy.attempts;
  await saveCompletionDraft(legacy);
  const loaded = (await loadCompletionDraft())!;
  const recovered = recoverLegacyCompletionRaw(loaded);
  expect(recovered.cards).toHaveLength(1);
  expect(recovered.cards[0].sections).toEqual(payload().sections);
  expect(recovered.raw).toBe(legacy.raw);
  expect(
    recovered.attempts?.some((attempt) => attempt.raw === legacy.raw),
  ).toBe(true);
  expect(fetcher).not.toHaveBeenCalled();
  expect(await db.roles.count()).toBe(0);
});

it.each([
  [
    "stale input",
    (draft: CompletionDraft) => {
      draft.input.source += "新一版素材。";
    },
  ],
  [
    "absent source signature",
    (draft: CompletionDraft) => {
      draft.sourceKey = "";
    },
  ],
  [
    "renamed candidate",
    (draft: CompletionDraft) => {
      draft.candidates[0].name = "另一个名字";
    },
  ],
  [
    "unselected candidate",
    (draft: CompletionDraft) => {
      draft.candidates[0].selected = false;
    },
  ],
  [
    "unknown identity",
    (draft: CompletionDraft) => {
      draft.raw = malformed({ ...target, id: "unknown" });
    },
  ],
])(
  "does not attach legacy content with %s to the current input",
  (_label, change) => {
    const draft = draftWithAttempt();
    delete draft.attempts;
    change(draft);
    expect(() => recoverLegacyCompletionRaw(draft)).toThrow();
    expect(draft.cards).toHaveLength(0);
  },
);

it("repairs one received model result without an automatic second network request", async () => {
  const raw = malformed();
  const fetcher = vi.fn().mockResolvedValue(response(raw, "stop"));
  vi.stubGlobal("fetch", fetcher);
  const retained = vi.fn();
  const card = await requestCompletionCard(
    input,
    [target],
    target,
    [],
    new AbortController().signal,
    retained,
  );
  expect(card.sections).toEqual(payload().sections);
  expect(card.parseInfo?.repairs.length).toBeGreaterThan(0);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(retained).toHaveBeenLastCalledWith(raw);
  expect(await db.roles.count()).toBe(0);
});

it.each([
  ["length", true],
  ["content_filter", false],
  [undefined, false],
] as const)(
  "keeps %s completion metadata distinct and only suggests more tokens for length",
  async (reason, suggestLimit) => {
    const raw = JSON.stringify(payload());
    const fetcher = vi.fn().mockResolvedValue(response(raw, reason));
    vi.stubGlobal("fetch", fetcher);
    const retained = vi.fn();
    const failure = await requestCompletionCard(
      input,
      [target],
      target,
      [],
      new AbortController().signal,
      retained,
    ).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(Error);
    const message = (failure as Error).message;
    expect(/(?:可|建议)(?:提高|增加|调高|调整).*输出/.test(message)).toBe(
      suggestLimit,
    );
    if (reason === "content_filter")
      expect(message).toMatch(/安全|过滤|拦截|content_filter/);
    if (reason === undefined) expect(message).toMatch(/完成标记|连接/);
    expect(retained).toHaveBeenLastCalledWith(raw);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(await db.roles.count()).toBe(0);
  },
);
