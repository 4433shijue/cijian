import { test, expect, type Page } from "@playwright/test";
import { readStore, seedJourney } from "./fixtures";

const titles = [
  "把伞留给对方",
  "翻到一张旧纸条",
  "门外传来敲门声",
  "决定把话问清楚",
];
const texts = [
  "周屿把伞放在许知手边，邀请她等雨小些再走，两个人坐到了同一张桌旁。",
  "许知翻动书页，一张写着旧地址的纸条掉下来，她把纸条推给周屿看。",
  "门外有人敲了两下，送错地方的包裹让两人暂时停下了交谈。",
  "许知决定不再绕着话题走，她收起画稿，问周屿明天是否还会来书店。",
];
const round = (number: number) => ({
  options: titles.map((_, i) => ({
    title: `${titles[i]} ${number}`,
    text: `${texts[i]}（方案${number}）`,
  })),
});
const reply = (value: unknown, finish_reason = "stop") => ({
  choices: [{ message: { content: JSON.stringify(value) }, finish_reason }],
});

async function seed(page: Page) {
  await seedJourney(page);
  await page.evaluate(async () => {
    const open = indexedDB.open("little-scene-v1");
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
    const tx = database.transaction(
      ["stories", "events", "profiles", "preferences"],
      "readwrite",
    );
    const request = tx.objectStore("stories").get("fixture-story");
    request.onsuccess = () =>
      tx
        .objectStore("stories")
        .put({ ...request.result, draft: "", autoMemory: false });
    tx.objectStore("profiles").put({
      id: "ideas-model",
      name: "fixture",
      protocol: "chat",
      url: "https://ideas.fixture.test/v1",
      model: "fixture-model",
      stream: false,
      context: 32000,
      maxOutput: 2048,
      timeout: 30,
      remember: true,
      key: "isolated-ideas-fixture-key",
    });
    tx.objectStore("preferences").put({
      id: "preferences",
      activeProfile: "ideas-model",
      developer: false,
      prompts: {},
    });
    for (let n = 1; n <= 5; n++)
      tx.objectStore("events").put({
        id: `fixture-prose-${n}`,
        storyId: "fixture-story",
        seq: n,
        kind: "novel",
        origin: "ai",
        speaker: "",
        participants: ["fixture-role-a", "fixture-role-b"],
        input: "人物在书店说话。",
        text: `第${n}段正文标记。周屿把借阅本放在桌边，许知合上画册，等他继续说下去。`,
        facts: [],
        versions: [
          {
            id: `fixture-version-${n}`,
            text: `第${n}段正文标记。`,
            input: "",
            created: 1,
            facts: [],
          },
        ],
        versionId: `fixture-version-${n}`,
        status: "complete",
        raw: "",
        error: "",
        review: false,
        deleted: false,
        created: 1,
      });
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    database.close();
  });
  await page.reload();
  await page.getByRole("link").filter({ hasText: "雨声未歇" }).click();
}
const assistant = (page: Page) =>
  page.getByRole("dialog", { name: "灵感小助手", exact: true });
async function openAssistant(page: Page) {
  await page.getByRole("button", { name: "灵感小助手", exact: true }).click();
  await expect(assistant(page)).toBeVisible();
}

test("folded prose persists and inspiration can be reopened, rerolled, selected and cleared by the next prose", async ({
  page,
}) => {
  let calls = 0;
  const prompts: string[] = [];
  await page.route("https://ideas.fixture.test/**", async (route) => {
    const body = route.request().postDataJSON();
    if (body.messages[0].content.includes("灵感小助手")) {
      calls += 1;
      prompts.push(body.messages[1].content);
      await route.fulfill({ json: reply(round(calls)) });
    } else
      await route.fulfill({
        json: reply({
          text: "新一段正文已经写好，许知把伞放在桌上。",
          facts: [],
        }),
      });
  });
  await seed(page);
  const folded = page.locator(".prose-event").nth(2);
  await folded.getByRole("button", { name: "折叠本段" }).click();
  await expect(folded.locator(".event-text")).toBeHidden();
  await page.reload();
  await expect(
    folded.getByRole("button", { name: "展开本段" }),
  ).toHaveAttribute("aria-expanded", "false");
  await page.getByLabel("本段动作或台词").fill("我还没写完的想法。");
  await openAssistant(page);
  await expect(assistant(page).locator(".inspiration-option")).toHaveCount(4);
  expect(calls).toBe(1);
  expect(prompts[0]).toContain("第3段正文标记");
  expect(prompts[0]).toContain("第5段正文标记");
  expect(prompts[0]).not.toContain("第2段正文标记");
  expect(prompts[0]).toContain("周屿，说话温和直接");
  expect(prompts[0]).toContain("世界书 · 河畔书屋");
  await page.screenshot({
    path: "outputs/inspiration/desktop-options.png",
    fullPage: true,
  });
  await assistant(page).getByRole("button", { name: "我自己写" }).click();
  await expect(page.getByLabel("本段动作或台词")).toHaveValue(
    "我还没写完的想法。",
  );
  await openAssistant(page);
  await expect(assistant(page).locator(".inspiration-option")).toHaveCount(4);
  expect(calls).toBe(1);
  await page.reload();
  await openAssistant(page);
  await expect(assistant(page).locator(".inspiration-option")).toHaveCount(4);
  expect(calls).toBe(1);
  await assistant(page).getByRole("button", { name: "你再想想" }).click();
  await expect(
    assistant(page).locator(".inspiration-option").first(),
  ).toContainText(titles[0] + " 2");
  expect(calls).toBe(2);
  expect(prompts[1]).toContain(round(1).options[0].text);
  await assistant(page).locator(".inspiration-option").first().click();
  await expect(assistant(page)).toHaveCount(0);
  await expect(page.getByLabel("本段动作或台词")).toHaveValue(
    "我还没写完的想法。\n\n" + round(2).options[0].text,
  );
  expect(await readStore(page, "events")).toHaveLength(5);
  await openAssistant(page);
  await assistant(page).locator(".inspiration-option").last().click();
  await expect(page.getByLabel("本段动作或台词")).toHaveValue(
    "我还没写完的想法。\n\n" + round(2).options[3].text,
  );
  expect(calls).toBe(2);
  await folded.getByRole("button", { name: "展开本段" }).click();
  await expect(folded.locator(".event-text")).toBeVisible();
  await page.getByRole("button", { name: "扩写这一刻", exact: true }).click();
  await expect(page.locator(".prose-event").last()).toContainText(
    "新一段正文已经写好",
  );
  expect((await readStore(page, "stories"))[0].inspiration).toBeUndefined();
  await openAssistant(page);
  await expect(
    assistant(page).locator(".inspiration-option").first(),
  ).toContainText(titles[0] + " 3");
  expect(prompts[2]).toContain("新一段正文已经写好");
  expect(prompts[2]).not.toContain("上一轮建议");
});

test("failed rerolls and failed prose keep the current inspiration round", async ({
  page,
}) => {
  let calls = 0;
  await page.route("https://ideas.fixture.test/**", async (route) => {
    const body = route.request().postDataJSON();
    if (body.messages[0].content.includes("灵感小助手")) {
      calls += 1;
      await route.fulfill({
        json: reply(
          calls === 2
            ? { options: round(2).options.slice(0, 2) }
            : round(calls),
        ),
      });
    } else
      await route.fulfill({ json: reply({ text: "还没生成完" }, "length") });
  });
  await seed(page);
  await openAssistant(page);
  await expect(assistant(page).locator(".inspiration-option")).toHaveCount(4);
  await assistant(page).getByRole("button", { name: "你再想想" }).click();
  await expect(assistant(page).getByRole("alert")).toContainText(
    "完整的四个选项",
  );
  await expect(
    assistant(page).locator(".inspiration-option").first(),
  ).toContainText(titles[0] + " 1");
  await assistant(page).getByRole("button", { name: "我自己写" }).click();
  await page.getByLabel("本段动作或台词").fill("人物留在书店。");
  await page.getByRole("button", { name: "扩写这一刻", exact: true }).click();
  await expect(page.locator(".prose-event").last()).toContainText("未完成草稿");
  await openAssistant(page);
  await expect(
    assistant(page).locator(".inspiration-option").first(),
  ).toContainText(titles[0] + " 1");
  expect(calls).toBe(2);
});

test("developer settings persist and mobile suggestions fit without horizontal overflow", async ({
  page,
}) => {
  let sentSystem = "",
    sentUser = "";
  await page.route("https://ideas.fixture.test/**", async (route) => {
    const body = route.request().postDataJSON();
    sentSystem = body.messages[0].content;
    sentUser = body.messages[1].content;
    await route.fulfill({ json: reply(round(1)) });
  });
  await seed(page);
  await page.getByRole("link", { name: "返回故事列表" }).click();
  await page.getByRole("link", { name: "设置", exact: true }).click();
  await page.getByRole("checkbox", { name: "显示内部提示词编辑器" }).check();
  await expect(page.getByLabel("灵感小助手参考正文段数")).toHaveValue("3");
  await page.getByLabel("灵感小助手参考正文段数").fill("5");
  await page
    .getByRole("combobox", { name: "编辑提示词", exact: true })
    .selectOption("inspiration");
  await page
    .getByLabel("自定义内部提示词")
    .fill("请从具体动作开始，保持自然克制。开发测试标记。");
  await page.getByRole("button", { name: "保存并启用", exact: true }).click();
  await page.reload();
  await expect(page.getByLabel("灵感小助手参考正文段数")).toHaveValue("5");
  await page.getByRole("checkbox", { name: "显示内部提示词编辑器" }).uncheck();
  await page.getByRole("link", { name: "故事", exact: true }).click();
  await page.getByRole("link").filter({ hasText: "雨声未歇" }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await openAssistant(page);
  await expect(assistant(page).locator(".inspiration-option")).toHaveCount(4);
  expect(sentSystem).toContain("开发测试标记");
  expect(sentSystem).toContain("恰好四个");
  expect(sentUser).toContain("第1段正文标记");
  expect(sentUser).toContain("第5段正文标记");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "outputs/inspiration/mobile-options.png",
    fullPage: true,
  });
  await assistant(page).getByRole("button", { name: "我自己写" }).click();
  await page
    .locator(".prose-event")
    .first()
    .getByRole("button", { name: "折叠本段" })
    .click();
  await expect(
    page.locator(".prose-event").first().locator(".event-text"),
  ).toBeHidden();
  await page.screenshot({
    path: "outputs/inspiration/mobile-folded.png",
    fullPage: true,
  });
});

test("closing a pending request allows reopening without a second call and stale ideas cannot return", async ({
  page,
}) => {
  let calls = 0;
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("https://ideas.fixture.test/**", async (route) => {
    if (
      route.request().postDataJSON().messages[0].content.includes("灵感小助手")
    ) {
      calls += 1;
      await waiting;
      await route.fulfill({ json: reply(round(1)) });
    } else
      await route.fulfill({
        json: reply({ text: "等灵感的时候，我自己写完了新一段。", facts: [] }),
      });
  });
  await seed(page);
  await openAssistant(page);
  await expect(assistant(page).getByRole("status")).toContainText("正在想四个");
  await expect.poll(() => calls).toBe(1);
  await assistant(page).getByRole("button", { name: "我自己写" }).click();
  await openAssistant(page);
  await expect(assistant(page).getByRole("status")).toContainText("正在想四个");
  expect(calls).toBe(1);
  await assistant(page).getByRole("button", { name: "我自己写" }).click();
  await page.getByLabel("本段动作或台词").fill("我自己想好了。");
  await page.getByRole("button", { name: "扩写这一刻", exact: true }).click();
  await expect(page.locator(".prose-event").last()).toContainText(
    "我自己写完了新一段",
  );
  const finished = page.waitForResponse(
    (response) =>
      response.url().includes("ideas.fixture.test") &&
      response
        .request()
        .postDataJSON()
        .messages[0].content.includes("灵感小助手"),
  );
  release();
  await finished;
  // Reopen after the stale round finishes. Only the fresh request may create options.
  await openAssistant(page);
  await expect(assistant(page).locator(".inspiration-option")).toHaveCount(4);
  expect(calls).toBe(2);
  const stored = (await readStore(page, "stories"))[0].inspiration;
  const events = await readStore(page, "events");
  expect(stored.sources.at(-1).id).toBe(
    events.find((event) => event.text.includes("我自己写完了新一段")).id,
  );
});

for (const mobile of [false, true])
  test(`${mobile ? "mobile" : "desktop"} inspiration uses shared history, accepts feedback and requires an explicit refresh after edits`, async ({
    page,
  }) => {
    if (mobile) await page.setViewportSize({ width: 390, height: 844 });
    const errors: string[] = [],
      requests: any[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("https://ideas.fixture.test/**", async (route) => {
      requests.push(route.request().postDataJSON());
      await route.fulfill({ json: reply(round(requests.length)) });
    });
    await seed(page);
    await page.evaluate(async () => {
      const open = indexedDB.open("little-scene-v1");
      const db = await new Promise<IDBDatabase>((resolve) => {
        open.onsuccess = () => resolve(open.result);
      });
      const tx = db.transaction(["stories", "events", "memories"], "readwrite");
      const s = tx.objectStore("stories").get("fixture-story");
      s.onsuccess = () =>
        tx.objectStore("stories").put({ ...s.result, timelineMode: "shared" });
      const e = tx.objectStore("events").get("fixture-prose-5");
      e.onsuccess = () =>
        tx.objectStore("events").put({
          ...e.result,
          id: "fixture-chat",
          seq: 6,
          kind: "message",
          speaker: "fixture-role-b",
          participants: ["fixture-role-a", "fixture-role-b"],
          text: "今天不见面，明天只在书店取书。",
          versionId: "chat-version",
          chatPending: true,
        });
      tx.objectStore("memories").put({
        id: "fixture-memory",
        storyId: "fixture-story",
        text: "许知明确拒绝拥抱，周屿答应先保持距离。",
        knownBy: ["fixture-role-a", "fixture-role-b"],
        scope: "story",
        sources: [{ id: "fixture-prose-1", versionId: "fixture-version-1" }],
        status: "accepted",
        created: 1,
      });
      await new Promise<void>((resolve) => {
        tx.oncomplete = () => resolve();
      });
      db.close();
    });
    await openAssistant(page);
    const dialog = assistant(page);
    await expect(dialog.locator(".inspiration-option")).toHaveCount(4);
    await expect(dialog.locator(".inspiration-option").first()).toBeEnabled();
    expect(requests).toHaveLength(1);
    expect(requests[0].messages[1].content).toContain("许知明确拒绝拥抱");
    expect(requests[0].messages[1].content).toContain(
      "今天不见面，明天只在书店取书",
    );
    expect(requests[0].messages[0].content).not.toContain("各出现一次");
    await dialog
      .getByLabel("这次希望怎么调整？（可选）")
      .fill("他不会主动靠近，别突然变亲密。");
    await dialog.getByRole("button", { name: "你再想想" }).click();
    await expect(dialog.locator(".inspiration-option").first()).toContainText(
      titles[0] + " 2",
    );
    expect(requests).toHaveLength(2);
    expect(requests[1].messages[1].content).toContain(
      "他不会主动靠近，别突然变亲密。",
    );
    expect(requests[1].messages[1].content).toContain(
      "全部仍是候选，不能当作前文",
    );
    // Use the app in a second tab so edits emit the same database notifications
    // as real author actions, rather than bypassing Dexie with a raw IDB write.
    const editor = await page.context().newPage();
    await editor.goto("/#story/fixture-story");
    await editor.getByRole("button", { name: "手机聊天", exact: true }).click();
    await editor
      .locator(".message-event")
      .getByRole("button", { name: "编辑", exact: true })
      .click();
    await editor
      .getByLabel("正文 / 消息")
      .fill("我改变主意，明天也不去书店了。");
    await editor
      .getByRole("button", { name: "保存新版本", exact: true })
      .click();
    await expect(
      editor.getByRole("dialog", { name: "修改这一刻" }),
    ).toHaveCount(0);
    await editor.close();
    await expect(dialog.getByRole("status")).toContainText("这轮灵感需要更新");
    for (const option of await dialog.locator(".inspiration-option").all())
      await expect(option).toBeDisabled();
    expect(requests).toHaveLength(2);
    await dialog.getByRole("button", { name: "我自己写" }).click();
    await page.reload();
    await openAssistant(page);
    await expect(dialog.getByRole("status")).toContainText("这轮灵感需要更新");
    await expect(dialog.getByLabel("这次希望怎么调整？（可选）")).toHaveValue(
      "他不会主动靠近，别突然变亲密。",
    );
    expect(requests).toHaveLength(2);
    await dialog.getByRole("button", { name: "你再想想" }).click();
    await expect(dialog.locator(".inspiration-option").first()).toContainText(
      titles[0] + " 3",
    );
    await expect(dialog.locator(".inspiration-option").first()).toBeEnabled();
    await expect(dialog.locator(".inspiration-stale")).toHaveCount(0);
    expect(requests).toHaveLength(3);
    expect(requests[2].messages[1].content).toContain(
      "我改变主意，明天也不去书店了",
    );
    expect(requests[2].messages[1].content).not.toContain(
      "今天不见面，明天只在书店取书",
    );
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: `work/inspiration-consistency-${mobile ? "mobile" : "desktop"}.png`,
    });
    await dialog.locator(".inspiration-option").first().click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByLabel("本段动作或台词")).toHaveValue(
      round(3).options[0].text,
    );
    expect(errors).toEqual([]);
  });

test("late suggestions after a persona edit stay out of the modal until the author requests another round", async ({
  page,
}) => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const requests: any[] = [];
  await page.route("https://ideas.fixture.test/**", async (route) => {
    requests.push(route.request().postDataJSON());
    if (requests.length === 1) await held;
    await route.fulfill({ json: reply(round(requests.length)) });
  });
  await seed(page);
  await openAssistant(page);
  await expect.poll(() => requests.length).toBe(1);
  await page.evaluate(async () => {
    const open = indexedDB.open("little-scene-v1");
    const db = await new Promise<IDBDatabase>((resolve) => {
      open.onsuccess = () => resolve(open.result);
    });
    const tx = db.transaction("stories", "readwrite");
    const s = tx.objectStore("stories").get("fixture-story");
    s.onsuccess = () =>
      tx.objectStore("stories").put({
        ...s.result,
        roles: s.result.roles.map((r: any) => ({
          ...r,
          persona: "性格慢热，从不主动靠近。",
          paragraphs: [],
        })),
      });
    await new Promise<void>((resolve) => {
      tx.oncomplete = () => resolve();
    });
    db.close();
  });
  release();
  await expect(assistant(page).getByRole("alert")).toContainText(
    "生成期间参考内容发生了变化",
  );
  await expect(assistant(page).locator(".inspiration-option")).toHaveCount(0);
  expect(requests).toHaveLength(1);
  await assistant(page).getByRole("button", { name: "你再想想" }).click();
  await expect(assistant(page).locator(".inspiration-option")).toHaveCount(4);
  expect(requests).toHaveLength(2);
  expect(requests[1].messages[1].content).toContain("性格慢热，从不主动靠近。");
});

test("old-version saved suggestions remain readable and never regenerate on open", async ({
  page,
}) => {
  let calls = 0;
  await page.route("https://ideas.fixture.test/**", async (route) => {
    calls++;
    await route.fulfill({ json: reply(round(2)) });
  });
  await seed(page);
  await page.evaluate(async (options) => {
    const open = indexedDB.open("little-scene-v1");
    const db = await new Promise<IDBDatabase>((resolve) => {
      open.onsuccess = () => resolve(open.result);
    });
    const tx = db.transaction("stories", "readwrite");
    const s = tx.objectStore("stories").get("fixture-story");
    s.onsuccess = () =>
      tx
        .objectStore("stories")
        .put({
          ...s.result,
          inspiration: { options, sources: [], created: 1 },
        });
    await new Promise<void>((resolve) => {
      tx.oncomplete = () => resolve();
    });
    db.close();
  }, round(1).options);
  await page.reload();
  await openAssistant(page);
  await expect(assistant(page).getByRole("status")).toContainText(
    "这轮灵感需要更新",
  );
  await expect(
    assistant(page).locator(".inspiration-option").first(),
  ).toContainText(titles[0] + " 1");
  await expect(
    assistant(page).locator(".inspiration-option").first(),
  ).toBeDisabled();
  expect(calls).toBe(0);
  await assistant(page).getByRole("button", { name: "你再想想" }).click();
  await expect(
    assistant(page).locator(".inspiration-option").first(),
  ).toContainText(titles[0] + " 2");
  await expect(
    assistant(page).locator(".inspiration-option").first(),
  ).toBeEnabled();
  expect(calls).toBe(1);
});
