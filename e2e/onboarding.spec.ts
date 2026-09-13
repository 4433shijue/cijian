import { test, expect, type Page } from "@playwright/test";
import { readStore } from "./fixtures";

const base = "https://onboarding.fixture.test/v1";
async function modelFixture(
  page: Page,
  options: { failConnection?: boolean; failNovel?: boolean } = {},
) {
  await page.route("https://onboarding.fixture.test/**", async (route) => {
    const body = route.request().postDataJSON();
    const connection = body.messages?.[0]?.content === "Reply briefly.";
    if (connection && options.failConnection) {
      options.failConnection = false;
      await route.fulfill({
        status: 401,
        contentType: "application/json",
        body: '{"error":{"message":"Invalid API key"}}',
      });
      return;
    }
    let text = "连接成功";
    if (!connection) {
      if (options.failNovel) {
        options.failNovel = false;
        text = JSON.stringify({ text: "不完整的片段。", facts: [] });
      } else
        text = JSON.stringify({
          text: "顾言轻轻合上书，指尖在封面上停了片刻，抬头说：“你来了。”",
          facts: [],
        });
    }
    await route.fulfill({
      contentType: "text/event-stream",
      body:
        "data: " +
        JSON.stringify({
          choices: [{ delta: { content: text }, finish_reason: "stop" }],
        }) +
        "\n\ndata: [DONE]\n\n",
    });
  });
}
async function connect(page: Page, remember = true) {
  await page.getByLabel("接口 URL").fill(base);
  await page
    .getByLabel("API Key", { exact: true })
    .fill("onboarding-fixture-key");
  await page.getByLabel("模型名", { exact: true }).fill("fixture-model");
  if (remember)
    await page.getByRole("checkbox", { name: "记住此设备的 Key" }).check();
  await page.getByRole("button", { name: "测试连接并继续" }).click();
}
async function createRole(page: Page, name = "顾言") {
  await page.getByLabel("角色名字", { exact: true }).fill(name);
  await page
    .getByLabel("角色人设", { exact: true })
    .fill("在旧书店工作，说话温和，关心别人时习惯先做事。");
  await page.getByRole("button", { name: "保存角色，继续" }).click();
}
async function createStory(page: Page) {
  await page.getByLabel("故事名字", { exact: true }).fill("风经过书页");
  await page.getByLabel("开场背景").fill("傍晚的旧书店，风吹动了门口的书页。");
  await page.getByRole("button", { name: "保存故事，继续" }).click();
}
async function starterState(page: Page) {
  return page.evaluate(() =>
    JSON.parse(localStorage.getItem("little-scene-onboarding-v2") || "{}"),
  );
}

test("first visit, failed connection, refresh recovery, first real save and completion", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await modelFixture(page, { failConnection: true, failNovel: true });
  await page.goto("/");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("button", { name: "带我开始", exact: true }).click();
  await expect(
    page.getByRole("button", { name: /02 创建角色/ }),
  ).toBeDisabled();
  await connect(page, false);
  await expect(page.getByRole("alert")).toContainText("密钥未通过验证");
  expect((await starterState(page)).step).toBe(0);
  expect(await readStore(page, "profiles")).toHaveLength(0);
  await page.getByRole("button", { name: "测试连接并继续" }).click();
  await expect(page.getByLabel("角色名字", { exact: true })).toBeVisible();
  await page.getByLabel("角色名字", { exact: true }).fill("顾言");
  await page
    .getByLabel("角色人设", { exact: true })
    .fill("在旧书店工作，习惯先做事再说话。");
  await page.reload();
  await expect(page.getByLabel("角色名字", { exact: true })).toHaveValue(
    "顾言",
  );
  await expect(page.getByText(/刷新后请重新填写未记住的密钥/)).toBeVisible();
  expect(JSON.stringify(await starterState(page))).not.toContain(
    "onboarding-fixture-key",
  );
  expect((await readStore(page, "profiles"))[0].key).toBeUndefined();
  await page.getByRole("button", { name: "保存角色，继续" }).click();
  await page.getByLabel("故事名字", { exact: true }).fill("风经过书页");
  await page.getByLabel("开场背景").fill("傍晚的旧书店。");
  await page.reload();
  await expect(page.getByLabel("故事名字", { exact: true })).toHaveValue(
    "风经过书页",
  );
  await expect(
    page.getByRole("button", { name: /顾言/, exact: false }),
  ).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "添加角色", exact: true }).click();
  await createRole(page, "许枝");
  await expect(page.getByLabel("故事名字", { exact: true })).toHaveValue(
    "风经过书页",
  );
  await page.getByRole("button", { name: "保存故事，继续" }).click();
  await expect(
    page.getByRole("heading", { name: "风经过书页", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "先完成模型连接", exact: true })
    .click();
  await expect(page.getByLabel("API Key", { exact: true })).toHaveValue("");
  await connect(page, true);
  await expect(
    page.getByRole("button", { name: "进入故事，写第一段" }),
  ).toBeVisible();
  expect(await readStore(page, "roles")).toHaveLength(2);
  expect(await readStore(page, "stories")).toHaveLength(1);
  await page.getByRole("button", { name: "进入故事，写第一段" }).click();
  await page.getByRole("button", { name: "填入一句示例" }).click();
  await page.getByRole("button", { name: "扩写这一刻", exact: true }).click();
  await expect(page.locator(".draft-label")).toBeVisible();
  expect((await starterState(page)).status).toBe("active");
  await page.getByRole("button", { name: "扩写这一刻", exact: true }).click();
  await expect(
    page.getByLabel("新手引导已完成", { exact: true }),
  ).toBeVisible();
  expect((await starterState(page)).status).toBe("complete");
  await page.getByRole("button", { name: "看看手机聊天" }).click();
  await expect(
    page.getByLabel("选好身份，再开始聊天", { exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("我扮演", { exact: true })).toHaveValue(
    (await readStore(page, "stories"))[0].player,
  );
  await page.getByRole("button", { name: "故事记忆", exact: true }).click();
  await expect(
    page.getByLabel("记住什么，由你决定", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await page.reload();
  await expect(page.getByLabel("新手引导已完成", { exact: true })).toHaveCount(
    0,
  );
  await page.getByRole("button", { name: "新手引导", exact: true }).click();
  await page.getByRole("button", { name: /连接模型 已完成/ }).click();
  await expect(page.getByText("你的模型已经接好了")).toBeVisible();
  expect(await readStore(page, "roles")).toHaveLength(2);
  expect(errors).toEqual([]);
});

test("pause preserves nonsecret connection draft and does not mark completion", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "带我开始" }).click();
  await page.getByLabel("接口 URL").fill(base);
  await page.getByLabel("API Key", { exact: true }).fill("never-persist-this");
  await page.getByLabel("模型名", { exact: true }).fill("my-model");
  await page.getByRole("button", { name: "暂时收起" }).click();
  await expect(page.getByLabel("第一次来此间")).toHaveCount(0);
  expect((await starterState(page)).status).toBe("paused");
  await page.reload();
  await page.getByRole("button", { name: "继续新手引导" }).click();
  await expect(page.getByLabel("接口 URL")).toHaveValue(base);
  await expect(page.getByLabel("模型名", { exact: true })).toHaveValue(
    "my-model",
  );
  await expect(page.getByLabel("API Key", { exact: true })).toHaveValue("");
  expect(JSON.stringify(await starterState(page))).not.toContain(
    "never-persist-this",
  );
});

test("mobile forms, keyboard height, steps and texture loading", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await modelFixture(page);
  await page.goto("/");
  await page.screenshot({
    path: "outputs/onboarding/手机-首页.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "带我开始" }).click();
  await expect(page.getByLabel("当前引导步骤", { exact: true })).toBeVisible();
  await page.screenshot({
    path: "outputs/onboarding/手机-连接模型.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 460 });
  await page.getByLabel("接口 URL").fill(base);
  await page
    .getByLabel("API Key", { exact: true })
    .fill("onboarding-fixture-key");
  await page.getByLabel("模型名", { exact: true }).fill("fixture-model");
  const continueButton = page.getByRole("button", { name: "测试连接并继续" });
  await continueButton.scrollIntoViewIfNeeded();
  const box = await continueButton.boundingBox();
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.y + box!.height).toBeLessThanOrEqual(460);
  await continueButton.click();
  await page.setViewportSize({ width: 390, height: 844 });
  await createRole(page);
  await createStory(page);
  await page.getByRole("button", { name: "进入故事，写第一段" }).click();
  await page.getByRole("button", { name: "填入一句示例" }).click();
  await page.setViewportSize({ width: 390, height: 460 });
  await page.getByLabel("本段动作或台词").focus();
  const send = await page
    .getByRole("button", { name: "扩写这一刻", exact: true })
    .boundingBox();
  expect(send!.y + send!.height).toBeLessThan(400);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.setViewportSize({ width: 320, height: 680 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

test("desktop artwork and prepared story; missing story has a recovery path", async ({
  page,
}) => {
  const failedAssets: string[] = [];
  page.on("response", (response) => {
    if (response.url().includes("/assets/") && response.status() >= 400)
      failedAssets.push(response.url());
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await modelFixture(page);
  await page.goto("/");
  await page.screenshot({
    path: "outputs/onboarding/桌面-首页.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "带我开始" }).click();
  await page.screenshot({
    path: "outputs/onboarding/桌面-连接模型.png",
    fullPage: true,
  });
  await connect(page);
  await page.screenshot({
    path: "outputs/onboarding/桌面-创建角色.png",
    fullPage: true,
  });
  await createRole(page);
  await createStory(page);
  await page.screenshot({
    path: "outputs/onboarding/桌面-准备完成.png",
    fullPage: true,
  });
  expect(failedAssets).toEqual([]);
  await page.evaluate(async () => {
    const request = indexedDB.open("little-scene-v1");
    const database = await new Promise<IDBDatabase>((resolve) => {
      request.onsuccess = () => resolve(request.result);
    });
    const transaction = database.transaction("stories", "readwrite");
    transaction.objectStore("stories").clear();
    await new Promise<void>((resolve) => {
      transaction.oncomplete = () => resolve();
    });
    database.close();
  });
  await page.reload();
  await expect(page.getByRole("button", { name: "去选择故事" })).toBeVisible();
  await page.getByRole("button", { name: "去选择故事" }).click();
  await expect(page.getByLabel("故事名字", { exact: true })).toBeVisible();
});

test("leaving a pending connection check does not advance or save later", async ({
  page,
}) => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("https://onboarding.fixture.test/**", async (route) => {
    await pending;
    await route
      .fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          choices: [
            { message: { content: "连接成功" }, finish_reason: "stop" },
          ],
        }),
      })
      .catch(() => {});
  });
  await page.goto("/#start");
  await connect(page);
  await expect(page.getByRole("button", { name: "正在连接…" })).toBeDisabled();
  await page.getByRole("button", { name: "暂时收起" }).click();
  release();
  await expect(
    page.getByRole("heading", { name: "故事在此间生长" }),
  ).toBeVisible();
  expect((await starterState(page)).status).toBe("paused");
  expect(await readStore(page, "profiles")).toHaveLength(0);
});
