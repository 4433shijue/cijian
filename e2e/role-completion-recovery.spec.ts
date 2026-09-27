import {
  expect,
  test,
  type Locator,
  type Page,
  type Route,
} from "@playwright/test";
import { readStore, seedJourney } from "./fixtures";
import {
  completionCardSourceKey,
  completionDimensions,
  completionSourceKey,
  emptyCompletionDraft,
  type CompletionCandidate,
  type CompletionDraft,
  type CompletionInput,
} from "../src/role-completion-types";

const appPath = process.env.CIJIAN_TEST_PATH || "/";
const capturePath =
  process.env.CIJIAN_TEST_CAPTURE || "work/v2.3.2-role-json-qa";

// Synthetic neutral text only. Never use real user material in browser fixtures.
const source =
  '季禾是园艺师，整理过一本名为"春日笔记"的小册子。叶宁负责图书登记。';
const input: CompletionInput = {
  source,
  mode: "single",
  targets: "",
  guidance: "",
  creativity: "balanced",
};
const target: CompletionCandidate = {
  id: "recovery-gardener",
  name: "季禾",
  description: "负责整理植物资料",
  selected: true,
};
const second: CompletionCandidate = {
  id: "recovery-librarian",
  name: "叶宁",
  description: "负责登记图书",
  selected: true,
};
const api = "https://recovery.fixture.test/**";
const dialog = (page: Page) =>
  page.getByRole("dialog", { name: "帮我补全角色", exact: true });
const cards = (page: Page) => dialog(page).getByTestId("completion-card");
const localRecover = (page: Page) =>
  dialog(page).getByRole("button", {
    name: "重新解析已收到内容（不调用 AI）",
    exact: true,
  });
const editedRecover = (page: Page) =>
  dialog(page).getByRole("button", {
    name: "解析修正后的内容（不调用 AI）",
    exact: true,
  });

function payload(person = target, marker = "") {
  return {
    candidateId: person.id,
    name: person.name,
    bio: `${person.name}，负责整理资料。${marker}`,
    sections: completionDimensions.map((title, index) => ({
      title,
      content:
        index === 0
          ? `${person.name}负责整理"春日笔记"，纸签上写着"待归档"。`
          : `${title}的其他资料尚待补充。`,
      basis: "unknown",
      evidence: "",
    })),
  };
}

const malformed = (person = target) =>
  "```json\n" +
  JSON.stringify(payload(person), null, 2)
    .replaceAll('\\"', '"')
    .replace(
      /"bio": "[^\n]*",/,
      `"bio": ${JSON.stringify(person.name)} + "，负责整理资料。",`,
    ) +
  "\n```";
const response = (raw: string, finishReason = "stop") => ({
  choices: [{ message: { content: raw }, finish_reason: finishReason }],
});

function requestedPerson(route: Route): CompletionCandidate {
  const prompt = route.request().postDataJSON().messages.at(-1)
    .content as string;
  const match = /生成目标角色卡：(\{[^\n]+\})/.exec(prompt);
  expect(match).toBeTruthy();
  const parsed = JSON.parse(match![1]);
  return {
    id: parsed.candidateId,
    name: parsed.name,
    description: "隔离测试主角",
    selected: true,
  };
}

async function seed(page: Page, draft?: CompletionDraft) {
  await seedJourney(page, appPath);
  await page.evaluate(async (draft) => {
    const request = indexedDB.open("little-scene-v1");
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const tx = database.transaction(
      ["profiles", "preferences", "roleCompletionDrafts"],
      "readwrite",
    );
    tx.objectStore("profiles").put({
      id: "recovery-model",
      name: "本地恢复浏览器测试",
      protocol: "chat",
      url: "https://recovery.fixture.test/v1",
      model: "fixture",
      stream: false,
      context: 64000,
      maxOutput: 8192,
      timeout: 30,
      remember: true,
      key: "isolated-recovery-fixture-key",
      prefixReuse: "off",
    });
    tx.objectStore("preferences").put({
      id: "preferences",
      activeProfile: "recovery-model",
      developer: false,
      prompts: {},
    });
    if (draft) tx.objectStore("roleCompletionDrafts").put(draft);
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    database.close();
  }, draft);
  await page.goto(appPath + "#roles");
  await page.reload();
}

async function open(page: Page) {
  await expect(dialog(page)).toHaveCount(0);
  await page.getByRole("button", { name: "帮我补全", exact: true }).click();
  await expect(
    dialog(page).getByRole("textbox", { name: "人物或故事素材", exact: true }),
  ).toBeEnabled();
}

async function closeAndReopen(page: Page) {
  await dialog(page).getByRole("button", { name: "关闭", exact: true }).click();
  await open(page);
}

async function showBelowHeader(locator: Locator) {
  await locator.evaluate((element) => {
    const modal = element.closest(".modal")!;
    const header = modal.querySelector(":scope > header")!;
    modal.scrollTop +=
      element.getBoundingClientRect().top -
      header.getBoundingClientRect().bottom -
      14;
  });
}

const legacyDraft = (raw = malformed()): CompletionDraft => ({
  ...emptyCompletionDraft(),
  input: { ...input },
  candidates: [{ ...target }],
  sourceKey: completionSourceKey(input),
  raw,
  error: "AI 返回的角色资料不是完整 JSON，原始回复已保留，请手动重试。",
});

function failedAttemptDraft(raw = malformed()): CompletionDraft {
  const draft = legacyDraft(raw);
  draft.attempts = [
    {
      id: "previous-card-attempt",
      stage: "card",
      target: { ...target },
      inputKey: completionSourceKey(draft.input),
      sourceKey: completionCardSourceKey(draft),
      raw,
      state: "failed",
      error: draft.error,
      complete: true,
      finishReason: "stop",
      created: 100,
      updated: 100,
    },
  ];
  return draft;
}

test("new malformed quotes are repaired with a visible notice, original text and no additional model request", async ({
  page,
}) => {
  let calls = 0;
  let original = "";
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route(api, async (route) => {
    calls += 1;
    if (calls === 1)
      return route.fulfill({
        json: response(
          JSON.stringify({
            candidates: [
              {
                name: target.name,
                description: target.description,
                aliases: [],
              },
            ],
          }),
        ),
      });
    original = malformed(requestedPerson(route));
    await route.fulfill({ json: response(original) });
  });
  await seed(page);
  await open(page);
  await dialog(page)
    .getByRole("textbox", { name: "人物或故事素材", exact: true })
    .fill(source);
  await dialog(page)
    .getByRole("button", { name: "帮我补全", exact: true })
    .click();
  await expect(cards(page)).toHaveCount(1);
  await expect(
    cards(page).first().locator(".completion-dimensions details"),
  ).toHaveCount(10);
  await expect(
    cards(page).getByRole("textbox", { name: "基础身份", exact: true }),
  ).toHaveValue(payload().sections[0].content);
  await expect(
    dialog(page)
      .getByText(/(?:自动|本地).*(?:修复|转义)|(?:修复|补齐).*引号/)
      .first(),
  ).toBeVisible();
  await expect
    .poll(
      async () =>
        (await readStore(page, "roleCompletionDrafts"))[0].attempts?.filter(
          (item: { stage: string }) => item.stage === "card",
        ).length,
    )
    .toBe(1);
  const draft = (await readStore(page, "roleCompletionDrafts"))[0];
  expect(draft.attempts.at(-1).raw).toBe(original);
  expect(draft.cards[0].sections).toEqual(payload().sections);
  expect(draft.cards[0].bio).toBe(payload().bio);
  expect(
    draft.cards[0].parseInfo.repairs
      .filter((item: { kind?: string }) => item.kind !== "string-concat")
      .reduce((sum: number, item: { count: number }) => sum + item.count, 0),
  ).toBe(4);
  expect(
    draft.cards[0].parseInfo.repairs
      .filter((item: { kind?: string }) => item.kind === "string-concat")
      .reduce((sum: number, item: { count: number }) => sum + item.count, 0),
  ).toBe(1);
  expect(await readStore(page, "roles")).toHaveLength(2);
  expect(calls).toBe(2);
  for (const [name, width, height] of [
    ["desktop", 1440, 1000],
    ["mobile", 390, 844],
    ["landscape", 844, 390],
  ] as const) {
    await page.setViewportSize({ width, height });
    await showBelowHeader(cards(page).first());
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: `${capturePath}/${name}-repaired-card.png`,
      fullPage: true,
    });
  }
  await closeAndReopen(page);
  await expect(cards(page)).toHaveCount(1);
  expect(calls).toBe(2);
  expect(errors).toEqual([]);
});

test("a pre-upgrade failed raw response can be recovered after refresh without a model call or role adoption", async ({
  page,
}) => {
  let calls = 0;
  await page.route(api, async (route) => {
    calls += 1;
    await route.abort();
  });
  const legacy = legacyDraft();
  await seed(page, legacy);
  await open(page);
  await expect(cards(page)).toHaveCount(0);
  await expect(localRecover(page).first()).toBeEnabled();
  await localRecover(page).first().click();
  await expect(cards(page)).toHaveCount(1);
  await expect(
    cards(page).getByRole("textbox", { name: "基础身份", exact: true }),
  ).toHaveValue(payload().sections[0].content);
  await closeAndReopen(page);
  await page.reload();
  await open(page);
  await expect(cards(page)).toHaveCount(1);
  const draft = (await readStore(page, "roleCompletionDrafts"))[0];
  expect(
    draft.attempts.some((item: { raw: string }) => item.raw === legacy.raw),
  ).toBe(true);
  expect(draft.cards[0].savedRoleId).toBeUndefined();
  expect(await readStore(page, "roles")).toHaveLength(2);
  expect(calls).toBe(0);
});

test("truncated output keeps previous cards and original raw while an explicitly edited JSON recovers only the missing person", async ({
  page,
}) => {
  let calls = 0;
  let broken = "";
  let fixed = "";
  await page.route(api, async (route) => {
    calls += 1;
    if (calls === 1)
      return route.fulfill({
        json: response(
          JSON.stringify({
            candidates: [target, second].map(({ name, description }) => ({
              name,
              description,
              aliases: [],
            })),
          }),
        ),
      });
    const person = requestedPerson(route);
    if (calls === 2)
      return route.fulfill({ json: response(JSON.stringify(payload(person))) });
    fixed = JSON.stringify(payload(person));
    broken = fixed.slice(0, -9);
    await route.fulfill({ json: response(broken) });
  });
  await seed(page);
  await open(page);
  await dialog(page)
    .getByRole("textbox", { name: "人物或故事素材", exact: true })
    .fill(source);
  await dialog(page)
    .getByRole("radio", { name: /^多人角色卡/ })
    .check();
  await dialog(page)
    .getByRole("button", { name: "帮我补全", exact: true })
    .click();
  await dialog(page)
    .getByRole("button", { name: "生成选中的角色卡", exact: true })
    .click();
  await expect(dialog(page).getByRole("alert").first()).toBeVisible();
  await expect(cards(page)).toHaveCount(1);
  await cards(page)
    .getByRole("textbox", { name: "公开简介", exact: true })
    .fill("这是我在恢复前修改的简介。");
  const recoverButton = localRecover(page).last();
  await recoverButton.click();
  await expect(cards(page)).toHaveCount(1);
  await expect(dialog(page).getByRole("alert").first()).toBeVisible();
  // Recovery editor is separate from the immutable original response viewer.
  await dialog(page)
    .getByRole("button", { name: "检查并修正格式", exact: true })
    .click();
  const editor = dialog(page).getByRole("textbox", {
    name: "用于重新解析的副本",
    exact: true,
  });
  await expect(editor).toBeVisible();
  await editor.fill(fixed);
  const recovery = dialog(page).getByRole("region", {
    name: "生成记录与格式恢复",
    exact: true,
  });
  for (const [name, width, height] of [
    ["desktop", 1440, 1000],
    ["mobile", 390, 844],
    ["landscape", 844, 390],
  ] as const) {
    await page.setViewportSize({ width, height });
    await showBelowHeader(recovery);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: `${capturePath}/${name}-recovery-full.png`,
      fullPage: true,
    });
    await showBelowHeader(editor);
    await editor.screenshot({
      path: `${capturePath}/${name}-recovery-editor.png`,
    });
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await editedRecover(page).last().click();
  await expect(cards(page)).toHaveCount(2);
  await expect(
    cards(page).first().getByRole("textbox", { name: "公开简介", exact: true }),
  ).toHaveValue("这是我在恢复前修改的简介。");
  await closeAndReopen(page);
  const stored = (await readStore(page, "roleCompletionDrafts"))[0];
  const failed = stored.attempts.find(
    (item: { raw: string }) => item.raw === broken,
  );
  expect(failed).toMatchObject({
    raw: broken,
    recoveryText: fixed,
    state: "recovered",
  });
  expect(stored.cards).toHaveLength(2);
  expect(
    stored.cards.every((card: { savedRoleId?: string }) => !card.savedRoleId),
  ).toBe(true);
  expect(await readStore(page, "roles")).toHaveLength(2);
  expect(calls).toBe(3);
});

test("stale input and renamed targets disable local recovery without touching the stored response", async ({
  page,
}) => {
  let calls = 0;
  await page.route(api, async (route) => {
    calls += 1;
    await route.abort();
  });
  const draft = failedAttemptDraft();
  await seed(page, draft);
  await open(page);
  await expect(localRecover(page).first()).toBeEnabled();
  await dialog(page)
    .getByRole("textbox", { name: "主角名字 1", exact: true })
    .fill("季禾的新称呼");
  await expect(localRecover(page).first()).toBeDisabled();
  await dialog(page)
    .getByRole("textbox", { name: "主角名字 1", exact: true })
    .fill(target.name);
  await expect(localRecover(page).first()).toBeEnabled();
  await dialog(page)
    .getByRole("textbox", { name: "人物或故事素材", exact: true })
    .fill(source + "更新了作者素材。");
  await expect(localRecover(page).first()).toBeDisabled();
  await closeAndReopen(page);
  await expect(localRecover(page).first()).toBeDisabled();
  expect(
    (await readStore(page, "roleCompletionDrafts"))[0].attempts[0].raw,
  ).toBe(draft.raw);
  await expect(cards(page)).toHaveCount(0);
  expect(calls).toBe(0);
  expect(await readStore(page, "roles")).toHaveLength(2);
});

test("retry keeps earlier failure history and cancelled late output cannot replace a newer card after reopening", async ({
  page,
}) => {
  let calls = 0;
  let release!: () => void;
  let finishLate!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  const finished = new Promise<void>((resolve) => {
    finishLate = resolve;
  });
  await page.route(api, async (route) => {
    calls += 1;
    const call = calls;
    const person = requestedPerson(route);
    if (call === 1) await waiting;
    await route
      .fulfill({
        json: response(
          JSON.stringify(
            payload(person, call === 1 ? "迟到的旧结果。" : "新完成的结果。"),
          ),
        ),
      })
      .catch(() => {});
    if (call === 1) finishLate();
  });
  const draft = failedAttemptDraft(JSON.stringify(payload()).slice(0, -9));
  await seed(page, draft);
  await page.evaluate(() => {
    const original = window.fetch.bind(window);
    window.fetch = (url, options) =>
      original(
        url,
        String(url).includes("recovery.fixture.test")
          ? { ...options, signal: undefined }
          : options,
      );
  });
  await open(page);
  await dialog(page)
    .getByRole("button", { name: "生成选中的角色卡", exact: true })
    .click();
  await expect.poll(() => calls).toBe(1);
  await dialog(page)
    .getByRole("button", { name: "停止生成", exact: true })
    .click();
  await dialog(page)
    .getByRole("button", { name: "生成选中的角色卡", exact: true })
    .click();
  await expect(cards(page)).toHaveCount(1);
  release();
  await finished;
  await closeAndReopen(page);
  await page.reload();
  await open(page);
  await expect(cards(page)).toHaveCount(1);
  await expect(
    cards(page).getByRole("textbox", { name: "公开简介", exact: true }),
  ).toHaveValue(/新完成的结果/);
  const saved = (await readStore(page, "roleCompletionDrafts"))[0];
  expect(saved.attempts[0].raw).toBe(draft.raw);
  expect(
    saved.attempts.some(
      (item: { state: string }) => item.state === "interrupted",
    ),
  ).toBe(true);
  expect(saved.attempts).toHaveLength(3);
  expect(JSON.stringify(saved.cards)).not.toContain("迟到的旧结果");
  expect(calls).toBe(2);
  expect(await readStore(page, "roles")).toHaveLength(2);
});
