import { test, expect, type Page } from "@playwright/test";
import { readFileSync, mkdirSync } from "node:fs";
import { seedJourney, openPhoneChat, readStore } from "./fixtures";

// Existing bundled artwork is a transport fixture, not a claimed provider output.
const bitmap = readFileSync("src/assets/decor/chat-banner-v1.webp").toString(
  "base64",
);
async function setup(page: Page, chat = false) {
  await seedJourney(page);
  await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const r = indexedDB.open("little-scene-v1");
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    const tx = db.transaction(
      ["profiles", "preferences", "stories"],
      "readwrite",
    );
    tx.objectStore("profiles").put({
      id: "image-text-fixture",
      name: "Text fixture",
      protocol: "chat",
      url: "https://text-image.fixture.test/v1",
      model: "fixture",
      stream: false,
      context: 64000,
      maxOutput: 4000,
      timeout: 10,
      remember: true,
      key: "fixture-text-key",
      prefixReuse: "off",
    });
    tx.objectStore("preferences").put({
      id: "preferences",
      activeProfile: "image-text-fixture",
      developer: false,
      prompts: {},
    });
    const source = tx.objectStore("stories").get("fixture-story");
    source.onsuccess = () =>
      tx.objectStore("stories").put({ ...source.result, autoMemory: false });
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  });
  await page.goto("/#settings");
  await page
    .getByLabel("生图接口地址", { exact: true })
    .fill("https://image.fixture.test/v1" + (chat ? "/chat/completions" : ""));
  await page
    .getByLabel("生图 API Key", { exact: true })
    .fill("fixture-image-key");
  await page
    .getByLabel("生图模型", { exact: true })
    .fill("fixture-image-model");
  await page.getByRole("button", { name: "保存生图配置", exact: true }).click();
  await expect
    .poll(async () => (await readStore(page, "imageProfiles")).length)
    .toBe(1);
  expect((await readStore(page, "imageProfiles"))[0].key).toBeUndefined();
}
async function mock(
  page: Page,
  options: { selfie?: boolean; failFirstImage?: boolean; chat?: boolean } = {},
) {
  const calls = { text: 0, image: 0, plan: 0 };
  await page.route("https://text-image.fixture.test/**", async (route) => {
    calls.text++;
    const request = route.request().postDataJSON();
    const system = String(request.messages?.[0]?.content);
    let content: unknown;
    if (system.includes("作品配图助手")) {
      calls.plan++;
      content = {
        generate: true,
        description: "书店窗边的一杯热茶，窗外是雨后的树木",
        selfie: false,
        roleIds: [],
        reason: "",
      };
    } else if (system.includes("当前指定角色")) {
      content = {
        messages: [
          {
            type: "image",
            text: options.selfie ? "给你看看。" : "刚泡好的，还是热的。",
            imagePrompt: options.selfie ? "镜子前的自拍" : "书店窗边的一杯热茶",
            assets: [],
            amount: "",
            duration: "",
            callState: "completed",
          },
        ],
      };
    } else
      content = {
        text: "窗边的茶杯冒着热气。许知将杯子往里挪了挪，雨后的树影落在桌面上。",
        facts: [],
      };
    await route.fulfill({
      json: {
        choices: [
          {
            message: { content: JSON.stringify(content) },
            finish_reason: "stop",
          },
        ],
      },
    });
  });
  await page.route("https://image.fixture.test/**", async (route) => {
    calls.image++;
    const request = route.request().postDataJSON();
    if (options.chat) {
      expect(route.request().url()).toContain("/chat/completions");
      expect(request.messages[0].content).toContain("禁止生成自拍");
    } else {
      expect(request.n).toBe(1);
      expect(request.prompt).toContain("禁止生成自拍");
    }
    if (options.failFirstImage && calls.image === 1)
      return route.fulfill({
        status: 429,
        json: { error: { message: "fixture quota failure" } },
      });
    await route.fulfill({
      json: options.chat
        ? {
            choices: [
              {
                message: {
                  images: [
                    { image_url: { url: "data:image/webp;base64," + bitmap } },
                  ],
                },
              },
            ],
          }
        : { data: [{ b64_json: bitmap }] },
    });
  });
  return calls;
}
test("novel auto illustration, persisted image, export and responsive settings", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const calls = await mock(page);
  await setup(page);
  expect(calls.image).toBe(0);
  await page.goto("/#story/fixture-story");
  await page.getByRole("button", { name: "故事设置", exact: true }).click();
  await page.getByLabel("正文配图方式", { exact: true }).selectOption("every");
  await page
    .getByLabel("插画画风", { exact: true })
    .fill("柔和水彩，安静的书店");
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await page.getByLabel("本段动作或台词").fill("许知把热茶放在书店的窗台上。");
  await page.getByRole("button", { name: "扩写这一刻", exact: true }).click();
  await expect(
    page.locator('.novel-image-panel [data-image-status="complete"]'),
  ).toBeVisible();
  await expect(page.locator(".generated-image-open img")).toBeVisible();
  expect(calls.image).toBe(1);
  mkdirSync("work/image-qa", { recursive: true });
  await page.getByRole("button", { name: "收起输入框", exact: true }).click();
  await page.locator(".novel-image-panel").scrollIntoViewIfNeeded();
  await page.screenshot({
    path: "work/image-qa/novel-desktop.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "查看配图大图", exact: true }).click();
  await expect(page.getByRole("dialog").locator("img")).toBeVisible();
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await page.reload();
  await expect(page.locator(".generated-image-open img")).toBeVisible();
  expect(calls.image).toBe(1);
  await page.getByRole("button", { name: "故事设置", exact: true }).click();
  const download = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "导出图文阅读页", exact: true })
    .click();
  expect((await download).suggestedFilename()).toContain("图文阅读.html");
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/#settings");
  await page.getByLabel("生图模型", { exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({
    path: "work/image-qa/settings-mobile.png",
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  expect(errors).toEqual([]);
});

test("phone image failure can retry without regenerating its reply or its image plan", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const calls = await mock(page, { failFirstImage: true, chat: true });
  await setup(page, true);
  await openPhoneChat(page);
  await page.getByRole("button", { name: "作品设置", exact: true }).click();
  await page
    .getByRole("checkbox", { name: "允许角色根据语境生成照片", exact: true })
    .check();
  await page.getByLabel("每轮最多生图请求数", { exact: true }).fill("2");
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await page
    .getByLabel("手机消息内容", { exact: true })
    .fill("你在喝什么，拍给我看看。");
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  await page.getByRole("button", { name: "让 TA 回复", exact: true }).click();
  await expect(page.locator('[data-image-status="failed"]')).toBeVisible();
  await expect(
    page.getByText("刚泡好的，还是热的。", { exact: true }),
  ).toBeVisible();
  const textCount = calls.text;
  await page.getByRole("button", { name: "重试配图", exact: true }).click();
  await expect(page.locator(".phone-media")).toHaveCount(1);
  expect(calls.image).toBe(2);
  expect(calls.text).toBe(textCount);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  mkdirSync("work/image-qa", { recursive: true });
  await page.locator(".phone-media").scrollIntoViewIfNeeded();
  await page.screenshot({
    path: "work/image-qa/phone-mobile.png",
    fullPage: true,
  });
  await page.reload();
  await page.getByRole("button", { name: "联系人", exact: true }).click();
  await page
    .getByRole("button", { name: "发消息", exact: true })
    .first()
    .click();
  await expect(page.locator(".phone-media")).toHaveCount(1);
  expect(calls.image).toBe(2);
});

test("a model-requested selfie is visibly blocked and never reaches the image API", async ({
  page,
}) => {
  const calls = await mock(page, { selfie: true });
  await setup(page);
  await openPhoneChat(page);
  await page.getByRole("button", { name: "作品设置", exact: true }).click();
  await page
    .getByRole("checkbox", { name: "允许角色根据语境生成照片", exact: true })
    .check();
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await page.getByLabel("手机消息内容", { exact: true }).fill("发张照片。");
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  await page.getByRole("button", { name: "让 TA 回复", exact: true }).click();
  await expect(page.locator('[data-image-status="blocked"]')).toContainText(
    "自拍",
  );
  expect(calls.image).toBe(0);
  expect(calls.plan).toBe(0);
});
