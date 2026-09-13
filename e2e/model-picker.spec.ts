import { test, expect, type Page } from "@playwright/test";
import { readStore } from "./fixtures";

const base = "https://picker.fixture.test/v1";
const listedModels = ["fixture-chat", "fixture-fast", "fixture-reasoner"];

async function openConnection(page: Page, guided = true) {
  await page.goto(guided ? "/#start" : "/#settings");
  if (!guided) await page.getByRole("button", { name: "添加接口" }).click();
  await page.getByLabel("接口 URL").fill(base);
  await page.getByLabel("API Key", { exact: true }).fill("picker-fixture-key");
}

test("onboarding fetches a visible model selector and uses the selected model", async ({
  page,
}) => {
  const requestedModels: string[] = [];
  await page.route("https://picker.fixture.test/**", async (route) => {
    const request = route.request();
    expect(request.headers().authorization).toBe("Bearer picker-fixture-key");
    if (request.method() === "GET") {
      expect(new URL(request.url()).pathname).toBe("/v1/models");
      await route.fulfill({
        json: {
          data: [
            { id: listedModels[0] },
            { id: listedModels[1] },
            { name: "models/" + listedModels[2] },
            { id: listedModels[0] },
            null,
            {},
            { id: "" },
            { id: 42 },
          ],
        },
      });
    } else {
      requestedModels.push(request.postDataJSON().model);
      await route.fulfill({
        json: {
          choices: [
            {
              message: { content: "连接成功" },
              finish_reason: "stop",
            },
          ],
        },
      });
    }
  });
  await openConnection(page);
  await page.getByRole("button", { name: "尝试获取模型列表" }).click();
  const selector = page.getByRole("combobox", { name: "模型名", exact: true });
  await expect(selector).toBeVisible();
  await expect(selector).toBeFocused();
  await expect(selector).toHaveValue("");
  await expect(selector.getByRole("option")).toHaveText([
    "点击选择模型",
    ...listedModels,
  ]);
  await expect(page.getByRole("status")).toContainText("已获取 3 个模型");
  await selector.selectOption("fixture-fast");
  await page.screenshot({
    path: "outputs/model-picker/onboarding-desktop.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "测试连接并继续" }).click();
  await expect(page.getByLabel("角色名字", { exact: true })).toBeVisible();
  expect(requestedModels).toEqual(["fixture-fast"]);
  const profiles = await readStore(page, "profiles");
  expect(profiles).toHaveLength(1);
  expect(profiles[0].model).toBe("fixture-fast");
  expect(profiles[0].key).toBeUndefined();
});

test("mobile settings allow model selection and manual entry without losing the current value", async ({
  page,
}) => {
  const longModel = "provider/" + "long-model-name-".repeat(12);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route("https://picker.fixture.test/**", (route) =>
    route.fulfill({ json: [...listedModels, longModel] }),
  );
  await openConnection(page, false);
  await page
    .getByLabel("模型名", { exact: true })
    .fill("existing-custom-model");
  await page.getByRole("button", { name: "尝试获取模型列表" }).click();
  const selector = page.getByRole("combobox", { name: "模型名", exact: true });
  await expect(selector).toHaveValue("existing-custom-model");
  await selector.selectOption(longModel);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "outputs/model-picker/settings-mobile.png",
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "手动填写模型名", exact: true })
    .click();
  const manual = page.getByRole("textbox", { name: "模型名", exact: true });
  await expect(manual).toHaveValue(longModel);
  await manual.fill("my-custom-model");
  await page
    .getByRole("button", { name: "从列表选择模型", exact: true })
    .click();
  await expect(selector).toHaveValue("my-custom-model");
  await selector.selectOption("fixture-chat");
  await page.getByRole("button", { name: "保存并选用" }).click();
  await expect(page.locator(".profile-row")).toContainText("fixture-chat");
  await page.reload();
  await page.getByRole("button", { name: "配置", exact: true }).click();
  await expect(page.getByLabel("模型名", { exact: true })).toHaveValue(
    "fixture-chat",
  );
});

test("empty or failed model lists keep manual entry available and changed connections clear old choices", async ({
  page,
}) => {
  let attempts = 0;
  await page.route("https://picker.fixture.test/**", async (route) => {
    attempts += 1;
    await route.fulfill({
      status: attempts === 1 ? 401 : 200,
      json:
        attempts === 1
          ? { error: { message: "Invalid fixture key" } }
          : { data: attempts === 2 ? [] : listedModels.map((id) => ({ id })) },
    });
  });
  await openConnection(page);
  const fetchModels = page.getByRole("button", { name: "尝试获取模型列表" });
  const manual = page.getByRole("textbox", { name: "模型名", exact: true });
  const selector = page.getByRole("combobox", { name: "模型名", exact: true });
  await manual.fill("handwritten-model");
  await fetchModels.click();
  await expect(page.getByRole("alert")).toContainText("密钥未通过验证");
  await expect(manual).toHaveValue("handwritten-model");
  await fetchModels.click();
  await expect(page.getByRole("alert")).toContainText("服务没有返回可选模型");
  await expect(page.getByRole("status")).toHaveCount(0);
  await expect(selector).toHaveCount(0);
  await expect(manual).toHaveValue("handwritten-model");

  for (const changeConnection of [
    () =>
      page.getByLabel("API Key", { exact: true }).fill("another-fixture-key"),
    async () => {
      await page.getByText("高级设置", { exact: true }).click();
      await page
        .getByRole("combobox", { name: "协议", exact: true })
        .selectOption("responses");
    },
    () =>
      page
        .getByLabel("接口 URL")
        .fill("https://picker.fixture.test/another/v1"),
  ]) {
    await fetchModels.click();
    await expect(selector).toBeVisible();
    await selector.selectOption("fixture-reasoner");
    await changeConnection();
    await expect(selector).toHaveCount(0);
    await expect(manual).toHaveValue("fixture-reasoner");
  }
});
