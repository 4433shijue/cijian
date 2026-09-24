import {
  test,
  expect,
  type Locator,
  type Page,
  type Route,
} from "@playwright/test";
import { readStore, seedJourney } from "./fixtures";
import { completionDimensions } from "../src/role-completion-types";

// These invented people and network responses belong only to isolated test contexts.
const source =
  "林舟，二十八岁，在河边经营一家旧书店。他习惯先收好桌上的书，再回答别人的问题。" +
  "唐晓是插画师，也是认识他三年的朋友，正为下周的展览准备画稿。" +
  "傍晚下雨，唐晓到书店借画册，林舟把伞放在她手边。送件员进门留下包裹就走了。" +
  "林舟一直保存着一封没有寄出的信，唐晓并不知道。";
const candidates = {
  candidates: [
    {
      name: "林舟",
      description: "旧书店的店主，故事围绕他的举动展开。",
      aliases: [],
    },
    {
      name: "唐晓",
      description: "来借画册的插画师，与林舟认识三年。",
      aliases: [],
    },
    {
      name: "送件员",
      description: "仅出现一次，送完包裹就离开。",
      aliases: [],
    },
  ],
};
const singleCandidate = { candidates: candidates.candidates.slice(0, 1) };
const reply = (value: unknown) => ({
  choices: [
    { message: { content: JSON.stringify(value) }, finish_reason: "stop" },
  ],
});
const assistant = (page: Page) =>
  page.getByRole("dialog", { name: "帮我补全角色", exact: true });
const cards = (page: Page) => assistant(page).getByTestId("completion-card");

async function showBelowDialogHeader(locator: Locator) {
  await locator.evaluate((element) => {
    const modal = element.closest(".modal")!;
    const header = modal.querySelector(":scope > header")!;
    modal.scrollTop +=
      element.getBoundingClientRect().top -
      header.getBoundingClientRect().bottom -
      14;
  });
}

async function seed(page: Page) {
  await seedJourney(page);
  await page.evaluate(async () => {
    const request = indexedDB.open("little-scene-v1");
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const tx = database.transaction(["profiles", "preferences"], "readwrite");
    tx.objectStore("profiles").put({
      id: "completion-model",
      name: "角色补全界面测试",
      protocol: "chat",
      url: "https://completion.fixture.test/v1",
      model: "fixture-model",
      stream: false,
      context: 64000,
      maxOutput: 8192,
      timeout: 30,
      remember: true,
      key: "isolated-completion-fixture-key",
      prefixReuse: "off",
    });
    tx.objectStore("preferences").put({
      id: "preferences",
      activeProfile: "completion-model",
      developer: false,
      prompts: {},
    });
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    database.close();
  });
  await page.goto("/#roles");
  await page.reload();
}

async function openAssistant(page: Page) {
  await page.getByRole("button", { name: "帮我补全", exact: true }).click();
  await expect(assistant(page)).toBeVisible();
  await expect(
    assistant(page).getByRole("textbox", {
      name: "人物或故事素材",
      exact: true,
    }),
  ).toBeEnabled();
}

async function enterSource(page: Page, multiple = false) {
  await openAssistant(page);
  await assistant(page)
    .getByRole("textbox", { name: "人物或故事素材", exact: true })
    .fill(source);
  await assistant(page)
    .getByRole("radio", { name: multiple ? /^多人角色卡/ : /^单人角色卡/ })
    .check();
}

async function generate(page: Page) {
  await assistant(page)
    .getByRole("button", { name: "帮我补全", exact: true })
    .click();
}

function character(candidateId: string, name = "林舟", suffix = "") {
  const isOwner = name === "林舟";
  const texts = [
    isOwner
      ? "林舟，二十八岁，在河边经营一家旧书店。"
      : "唐晓是插画师，也是认识他三年的朋友。",
    "衣着整洁，忙起来会挽起袖口。对陌生人保持礼貌，熟悉之后表情才逐渐放松。",
    "具体的成长经历尚待补充。现有素材只能确认他在小城有稳定的工作和熟悉的朋友。",
    "关心别人时通常先做一件小事。被直接询问感受时会稍作停顿，努力把真实想法说清楚。" +
      suffix,
    "珍惜长期建立的信任，不愿通过逼问换取亲近。眼下希望把手里的事做好，也给朋友留一点余地。",
    isOwner
      ? "擅长整理书目，会留意借阅习惯。不擅长突然向人解释私事，晚间常独自核对账目。"
      : "擅长观察日常细节并把它们画下来。为下周展览准备画稿，休息时喜欢到书店找资料。",
    "用词具体，语气温和，较少空泛劝说。熟人问起小事会认真回答，谈到自己的困扰时说得较慢。",
    "林舟与唐晓是认识三年的朋友。两人能自在地借书、闲谈；原文没有确定恋爱关系。",
    isOwner
      ? "保存着一封没有寄出的信。唐晓并不知道，不能在对话里默认她已经知情。"
      : "尚不知道林舟保存了一封没有寄出的信。她只能根据当下可见的行动判断他的心情。",
    isOwner
      ? "此刻正在下雨的书店里，把伞放在唐晓手边，等待她决定什么时候离开。"
      : "刚来到书店借画册，还在为下周展览准备画稿，暂时被雨留在了店里。",
  ];
  return {
    candidateId,
    name,
    bio: isOwner
      ? "河边旧书店的店主，做事细致，说话温和。"
      : "正在准备展览的插画师，喜欢观察生活中的细节。",
    sections: completionDimensions.map((title, index) => ({
      title,
      content: texts[index],
      basis:
        index === 0
          ? "source"
          : index === 2
            ? "unknown"
            : index === 1
              ? "created"
              : "inferred",
      evidence: index === 0 ? texts[0] : "",
    })),
  };
}

// Target IDs are authored by the application, so mocks echo the requested person.
function requestedCharacter(route: Route, suffix = "") {
  const prompt = route.request().postDataJSON().messages.at(-1)
    .content as string;
  const match = /生成目标角色卡：(\{[^\n]+\})/.exec(prompt);
  expect(
    match,
    "the model request should identify the target candidate",
  ).toBeTruthy();
  const target = JSON.parse(match![1]);
  return character(target.candidateId, target.name, suffix);
}

async function mockSingle(page: Page) {
  let calls = 0;
  await page.route("https://completion.fixture.test/**", async (route) => {
    calls += 1;
    await route.fulfill({
      json: reply(calls === 1 ? singleCandidate : requestedCharacter(route)),
    });
  });
  return () => calls;
}

test("single character preserves all ten dimensions, editable prose and private knowledge when saved", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1100 });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const calls = await mockSingle(page);
  await seed(page);
  await enterSource(page);
  await assistant(page)
    .getByRole("textbox", { name: "想生成谁（可选）", exact: true })
    .fill("林舟");
  await assistant(page)
    .getByRole("textbox", { name: "补充要求（可选）", exact: true })
    .fill("保留没有寄出的信，公开简介不要泄露秘密。");
  await assistant(page)
    .getByRole("combobox", { name: "补全程度", exact: true })
    .selectOption("balanced");
  await page.screenshot({
    path: "outputs/role-completion/desktop-input.png",
    fullPage: true,
  });
  await generate(page);
  await expect(cards(page)).toHaveCount(1);
  const card = cards(page).first();
  await expect(
    card.getByRole("heading", { name: "林舟", exact: true }),
  ).toBeVisible();
  await expect(card.locator("details")).toHaveCount(10);
  for (const dimension of completionDimensions)
    await expect(
      card.locator("summary").filter({ hasText: dimension }),
    ).toBeVisible();
  await expect(card.getByText("原文已有", { exact: true })).toBeVisible();
  await expect(card.getByText("AI 新增", { exact: true })).toBeVisible();
  await expect(card.getByText("尚待补充", { exact: true })).toBeVisible();
  const identity = card.locator("details").first();
  await identity
    .getByRole("textbox", { name: "基础身份", exact: true })
    .fill("林舟，二十九岁，在河边经营一家旧书店。年龄由作者校正。");
  await expect(identity.getByText("已手动修改", { exact: true })).toBeVisible();
  await expect(identity.getByText("生成时参考", { exact: true })).toBeVisible();
  await expect(identity.getByText("原文已有", { exact: true })).toHaveCount(0);
  await card
    .locator("details")
    .filter({ has: page.locator("summary", { hasText: "性格层次" }) })
    .locator("summary")
    .click();
  const edited =
    "关心别人时先做事；需要帮助时会认真开口，不把所有事情闷在心里。";
  await card
    .getByRole("textbox", { name: "性格层次", exact: true })
    .fill(edited);
  await showBelowDialogHeader(card);
  await page.screenshot({
    path: "outputs/role-completion/desktop-results.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 1440, height: 2000 });
  await showBelowDialogHeader(card);
  await card.screenshot({
    path: "outputs/role-completion/desktop-card-detail.png",
  });
  await page.setViewportSize({ width: 1440, height: 1100 });
  await assistant(page)
    .getByRole("button", { name: "保存选中的角色", exact: true })
    .click();
  await expect(card.getByText("已加入角色库", { exact: true })).toBeVisible();
  const roles = await readStore(page, "roles");
  const saved = roles.find((role) => role.name === "林舟");
  expect(saved).toBeTruthy();
  for (const dimension of completionDimensions)
    expect(saved.persona).toContain(dimension);
  expect(saved.persona).toContain(edited);
  expect(saved.persona).toContain("二十九岁");
  expect(saved.persona).toContain("唐晓并不知道");
  expect(saved.bio).not.toContain("信");
  expect(saved.paragraphs.length).toBeGreaterThanOrEqual(10);
  expect(
    saved.paragraphs.every(
      (paragraph: { public: boolean }) => !paragraph.public,
    ),
  ).toBe(true);
  expect(calls()).toBe(2);
  expect(errors).toEqual([]);
});

test("multiple characters exclude a passerby and retain the first card when the second request fails", async ({
  page,
}) => {
  let calls = 0;
  const requestedNames: string[] = [];
  await page.route("https://completion.fixture.test/**", async (route) => {
    calls += 1;
    if (calls === 1) return route.fulfill({ json: reply(candidates) });
    const card = requestedCharacter(route);
    requestedNames.push(card.name);
    if (calls === 3)
      return route.fulfill({
        status: 503,
        json: { error: { message: "fixture temporary unavailable" } },
      });
    await route.fulfill({ json: reply(card) });
  });
  await seed(page);
  await enterSource(page, true);
  await generate(page);
  await assistant(page)
    .getByLabel("选择主角 送件员", { exact: true })
    .uncheck();
  await assistant(page)
    .getByRole("button", { name: "生成选中的角色卡", exact: true })
    .click();
  await expect(cards(page)).toHaveCount(1);
  await expect(assistant(page).getByRole("alert")).toBeVisible();
  expect((await readStore(page, "roleCompletionDrafts"))[0].cards).toHaveLength(
    1,
  );
  expect(await readStore(page, "roles")).toHaveLength(2);
  await assistant(page)
    .getByRole("button", { name: "继续生成未完成角色", exact: true })
    .click();
  await expect(cards(page)).toHaveCount(2);
  expect(requestedNames).toEqual(["林舟", "唐晓", "唐晓"]);
  await page.setViewportSize({ width: 390, height: 844 });
  await showBelowDialogHeader(cards(page).first());
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "outputs/role-completion/mobile-results.png",
    fullPage: false,
  });
  await showBelowDialogHeader(cards(page).first().locator("details").first());
  await page.screenshot({
    path: "outputs/role-completion/mobile-card.png",
    fullPage: false,
  });
  await page.setViewportSize({ width: 844, height: 390 });
  await showBelowDialogHeader(cards(page).first());
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "outputs/role-completion/landscape-results.png",
    fullPage: false,
  });
  await showBelowDialogHeader(cards(page).first().locator("details").first());
  await page.screenshot({
    path: "outputs/role-completion/landscape-card.png",
    fullPage: false,
  });
  await assistant(page)
    .getByRole("button", { name: "保存全部角色", exact: true })
    .click();
  await expect(
    assistant(page).getByText("已加入角色库", { exact: true }),
  ).toHaveCount(2);
  const stored = await readStore(page, "roles");
  expect(stored.map((role) => role.name)).toEqual(
    expect.arrayContaining(["林舟", "唐晓"]),
  );
  expect(stored.some((role) => role.name === "送件员")).toBe(false);
  expect(calls).toBe(4);
});

test("closing and refreshing restore source, settings and edited cards without sending another model request", async ({
  page,
}) => {
  const calls = await mockSingle(page);
  await seed(page);
  await enterSource(page);
  await assistant(page)
    .getByRole("combobox", { name: "补全程度", exact: true })
    .selectOption("creative");
  await generate(page);
  await expect(cards(page)).toHaveCount(1);
  await cards(page)
    .getByLabel("公开简介", { exact: true })
    .fill("这句简介是我自己改的，还没有保存成正式角色。");
  await assistant(page)
    .getByRole("button", { name: "关闭", exact: true })
    .click();
  await openAssistant(page);
  await expect(cards(page).getByLabel("公开简介", { exact: true })).toHaveValue(
    "这句简介是我自己改的，还没有保存成正式角色。",
  );
  await assistant(page)
    .getByRole("textbox", { name: "补充要求（可选）", exact: true })
    .fill("最后输入的补充要求也要留住。");
  await page.reload();
  await openAssistant(page);
  await expect(
    assistant(page).getByRole("textbox", {
      name: "人物或故事素材",
      exact: true,
    }),
  ).toHaveValue(source);
  await expect(
    assistant(page).getByRole("combobox", { name: "补全程度", exact: true }),
  ).toHaveValue("creative");
  await expect(
    assistant(page).getByRole("textbox", {
      name: "补充要求（可选）",
      exact: true,
    }),
  ).toHaveValue("最后输入的补充要求也要留住。");
  await expect(cards(page).getByLabel("公开简介", { exact: true })).toHaveValue(
    "这句简介是我自己改的，还没有保存成正式角色。",
  );
  expect(await readStore(page, "roles")).toHaveLength(2);
  expect(calls()).toBe(2);
});

test("stopping generation rejects a late response and keeps the newer completed card", async ({
  page,
}) => {
  let calls = 0;
  let release!: () => void;
  let lateFinished!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  const finished = new Promise<void>((resolve) => {
    lateFinished = resolve;
  });
  await page.route("https://completion.fixture.test/**", async (route) => {
    calls += 1;
    if (calls === 1) return route.fulfill({ json: reply(singleCandidate) });
    const currentCall = calls;
    const card = requestedCharacter(
      route,
      currentCall === 2 ? "已取消的旧结果。" : "这是新完成的结果。",
    );
    if (currentCall === 2) await waiting;
    await route.fulfill({ json: reply(card) }).catch(() => {});
    if (currentCall === 2) lateFinished();
  });
  await seed(page);
  // A transport can still deliver after cancellation; exercise the stale-run guard.
  await page.evaluate(() => {
    const original = window.fetch.bind(window);
    window.fetch = (input, init) =>
      original(
        input,
        String(input).includes("completion.fixture.test")
          ? { ...init, signal: undefined }
          : init,
      );
  });
  await enterSource(page);
  await generate(page);
  await expect.poll(() => calls).toBe(2);
  await assistant(page)
    .getByRole("button", { name: "停止生成", exact: true })
    .click();
  await expect(cards(page)).toHaveCount(0);
  await assistant(page)
    .getByRole("button", { name: /^(生成选中的角色卡|继续生成未完成角色)$/ })
    .click();
  await expect(cards(page)).toHaveCount(1);
  release();
  await finished;
  await assistant(page)
    .getByRole("button", { name: "关闭", exact: true })
    .click();
  await openAssistant(page);
  const draft = (await readStore(page, "roleCompletionDrafts"))[0];
  expect(JSON.stringify(draft.cards)).toContain("这是新完成的结果。");
  expect(JSON.stringify(draft.cards)).not.toContain("已取消的旧结果。");
  expect(calls).toBe(3);
});

test("failed saves retain the generated draft and a later successful save never duplicates the role", async ({
  page,
}) => {
  const calls = await mockSingle(page);
  await seed(page);
  await enterSource(page);
  await generate(page);
  await expect(cards(page)).toHaveCount(1);
  await page.evaluate(() => {
    const original = IDBObjectStore.prototype.add;
    let fail = true;
    IDBObjectStore.prototype.add = function (...args) {
      if (this.name === "roles" && fail) {
        fail = false;
        throw new DOMException(
          "Simulated failed role save",
          "QuotaExceededError",
        );
      }
      return original.apply(this, args);
    };
  });
  await assistant(page)
    .getByRole("button", { name: "保存选中的角色", exact: true })
    .click();
  await expect(assistant(page).getByRole("alert")).toBeVisible();
  expect((await readStore(page, "roleCompletionDrafts"))[0].cards).toHaveLength(
    1,
  );
  expect(await readStore(page, "roles")).toHaveLength(2);
  await assistant(page)
    .getByRole("button", { name: "关闭", exact: true })
    .click();
  await page.reload();
  await openAssistant(page);
  await expect(cards(page)).toHaveCount(1);
  await assistant(page)
    .getByRole("button", { name: "保存选中的角色", exact: true })
    .click();
  await expect(
    cards(page).getByText("已加入角色库", { exact: true }),
  ).toBeVisible();
  const saved = (await readStore(page, "roles")).filter(
    (role) => role.name === "林舟",
  );
  expect(saved).toHaveLength(1);
  await assistant(page)
    .getByRole("button", { name: "关闭", exact: true })
    .click();
  await page.reload();
  await openAssistant(page);
  await expect(
    cards(page).getByText("已加入角色库", { exact: true }),
  ).toBeVisible();
  await expect(
    assistant(page).getByRole("button", {
      name: "保存选中的角色",
      exact: true,
    }),
  ).toBeDisabled();
  await expect(
    assistant(page).getByRole("button", { name: "保存全部角色", exact: true }),
  ).toBeDisabled();
  expect(
    (await readStore(page, "roles")).filter((role) => role.name === "林舟"),
  ).toHaveLength(1);
  expect(calls()).toBe(2);
});

test("identifying the same source again preserves saved cards even if the candidate description changes", async ({
  page,
}) => {
  let calls = 0;
  await page.route("https://completion.fixture.test/**", async (route) => {
    calls += 1;
    const value =
      calls === 1
        ? singleCandidate
        : calls === 3
          ? {
              candidates: [
                {
                  name: "林舟",
                  description:
                    "在雨天给朋友留伞的旧书店店主，识别依据换了一种表述。",
                  aliases: [],
                },
              ],
            }
          : requestedCharacter(route);
    await route.fulfill({ json: reply(value) });
  });
  await seed(page);
  await enterSource(page);
  await generate(page);
  await expect(cards(page)).toHaveCount(1);
  await assistant(page)
    .getByRole("button", { name: "保存全部角色", exact: true })
    .click();
  await expect(
    cards(page).getByText("已加入角色库", { exact: true }),
  ).toBeVisible();
  const initial = (await readStore(page, "roleCompletionDrafts"))[0];
  await generate(page);
  await expect(
    assistant(page).getByRole("button", { name: "帮我补全", exact: true }),
  ).toBeEnabled();
  expect(calls).toBe(3);
  await expect(cards(page)).toHaveCount(1);
  const restored = (await readStore(page, "roleCompletionDrafts"))[0];
  expect(restored.cards[0].id).toBe(initial.cards[0].id);
  expect(restored.cards[0].savedRoleId).toBe(initial.cards[0].savedRoleId);
  expect(
    (await readStore(page, "roles")).filter((role) => role.name === "林舟"),
  ).toHaveLength(1);
});

test("a failed draft write keeps the dialog open until the author's input is safely stored", async ({
  page,
}) => {
  await seed(page);
  await openAssistant(page);
  await page.evaluate(() => {
    document.documentElement.dataset.completionStorageBlocked = "true";
    const original = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args) {
      if (
        this.name === "roleCompletionDrafts" &&
        document.documentElement.dataset.completionStorageBlocked
      )
        throw new DOMException(
          "Simulated draft storage failure",
          "QuotaExceededError",
        );
      return original.apply(this, args);
    };
  });
  await assistant(page)
    .getByRole("textbox", { name: "人物或故事素材", exact: true })
    .fill("还没有保存好的珍贵人物设定。");
  await assistant(page)
    .getByRole("button", { name: "关闭", exact: true })
    .click();
  await expect(assistant(page)).toBeVisible();
  await expect(assistant(page).getByRole("alert")).toContainText(
    "草稿暂时没能保存",
  );
  await expect(
    assistant(page).getByRole("textbox", {
      name: "人物或故事素材",
      exact: true,
    }),
  ).toHaveValue("还没有保存好的珍贵人物设定。");
  expect(await readStore(page, "roleCompletionDrafts")).toHaveLength(0);
  await page.evaluate(() => {
    delete document.documentElement.dataset.completionStorageBlocked;
  });
  await assistant(page)
    .getByRole("button", { name: "重试保存草稿", exact: true })
    .click();
  await expect(assistant(page).getByText(/草稿已自动保存/)).toBeVisible();
  await assistant(page)
    .getByRole("button", { name: "关闭", exact: true })
    .click();
  await expect(assistant(page)).toHaveCount(0);
  await openAssistant(page);
  await expect(
    assistant(page).getByRole("textbox", {
      name: "人物或故事素材",
      exact: true,
    }),
  ).toHaveValue("还没有保存好的珍贵人物设定。");
});
