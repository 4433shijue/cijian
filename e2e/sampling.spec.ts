import { test, expect, type Page } from "@playwright/test";
import { readStore, seedJourney } from "./fixtures";

async function fillConnection(page: Page) {
  await page.getByLabel("接口 URL").fill("https://sampling.fixture.test/v1");
  await page
    .getByLabel("API Key", { exact: true })
    .fill("sampling-fixture-key");
  await page.getByLabel("模型名", { exact: true }).fill("fixture-model");
}

test("saved temperature reaches connection tests and story generation after reload", async ({
  page,
}) => {
  await seedJourney(page);
  const bodies: any[] = [];
  await page.route("https://sampling.fixture.test/**", async (route) => {
    const body = route.request().postDataJSON();
    bodies.push(body);
    await route.fulfill({
      json: {
        choices: [
          {
            message: {
              content:
                body.messages[0].content === "Reply briefly."
                  ? "连接成功"
                  : JSON.stringify({ text: "周屿把伞递了过去。", facts: [] }),
            },
            finish_reason: "stop",
          },
        ],
      },
    });
  });
  await page.goto("/#settings");
  await page.getByRole("button", { name: "添加接口" }).click();
  await fillConnection(page);
  await expect(page.getByLabel("重复惩罚", { exact: true })).toHaveValue("2");
  await expect(page.getByLabel("温度", { exact: true })).toHaveValue("");
  await page.getByLabel("温度", { exact: true }).fill("1.35");
  await page.getByLabel("记住此设备的 Key").check();
  await page.getByRole("button", { name: "保存并选用" }).click();
  await expect(page.locator(".profile-row")).toContainText("fixture-model");
  await page.reload();
  await page.getByRole("button", { name: "配置", exact: true }).click();
  await expect(page.getByLabel("温度", { exact: true })).toHaveValue("1.35");
  await expect(page.getByLabel("重复惩罚", { exact: true })).toHaveValue("2");
  await page.getByRole("button", { name: "测试连接", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("浏览器连接成功");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "关闭", exact: true })
    .click();
  await page.goto("/#story/fixture-story");
  await page.getByRole("button", { name: "扩写这一刻", exact: true }).click();
  await expect(page.locator(".prose-event .event-text")).toContainText(
    "周屿把伞递了过去。",
  );
  expect(bodies).toHaveLength(2);
  for (const body of bodies)
    expect(body).toMatchObject({ temperature: 1.35, frequency_penalty: 2 });
});

test("mobile protocol changes use valid limits and preserve zero and cleared defaults", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/#settings");
  await page.getByRole("button", { name: "添加接口" }).click();
  await fillConnection(page);
  const temperature = page.getByLabel("温度", { exact: true });
  const penalty = page.getByLabel("重复惩罚", { exact: true });
  await temperature.fill("1.8");
  await penalty.fill("2");
  await page.getByText("高级设置", { exact: true }).click();
  const protocol = page.getByRole("combobox", { name: "协议", exact: true });
  await protocol.selectOption("claude");
  await expect(temperature).toHaveAttribute("max", "1");
  await expect(temperature).toHaveValue("1");
  await expect(penalty).toBeDisabled();
  await protocol.selectOption("responses");
  await expect(penalty).toBeDisabled();
  await expect(temperature).toHaveAttribute("max", "2");
  await protocol.selectOption("gemini");
  await expect(penalty).toBeEnabled();
  await expect(penalty).toHaveValue("1.99");
  await temperature.fill("0");
  await penalty.fill("");
  await page.getByLabel("记住此设备的 Key").check();
  await page.getByRole("button", { name: "保存并选用" }).click();
  await expect(page.locator(".profile-row")).toBeVisible();
  await page.reload();
  await page.getByRole("button", { name: "配置", exact: true }).click();
  await expect(temperature).toHaveValue("0");
  await expect(penalty).toHaveValue("");
  const profiles = await readStore(page, "profiles");
  expect(profiles[0]).toMatchObject({ temperature: 0, frequencyPenalty: null });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page
    .locator(".connection-sampling")
    .screenshot({ path: "outputs/sampling/mobile.png" });
  let config: any;
  await page.route("https://sampling.fixture.test/**", async (route) => {
    config = route.request().postDataJSON().generationConfig;
    await route.fulfill({
      json: {
        candidates: [
          { content: { parts: [{ text: "连接成功" }] }, finishReason: "STOP" },
        ],
      },
    });
  });
  await page.getByRole("button", { name: "测试连接", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("浏览器连接成功");
  expect(config).toMatchObject({ temperature: 0 });
  expect(config).not.toHaveProperty("frequencyPenalty");
});

test("onboarding restores sampling drafts and blocks out of range temperatures", async ({
  page,
}) => {
  await page.goto("/#start");
  await fillConnection(page);
  await page.getByLabel("温度", { exact: true }).fill("0.65");
  await page.getByLabel("重复惩罚", { exact: true }).fill("1.5");
  await page.reload();
  const temperature = page.getByLabel("温度", { exact: true });
  await expect(temperature).toHaveValue("0.65");
  await expect(page.getByLabel("重复惩罚", { exact: true })).toHaveValue("1.5");
  await expect(page.getByLabel("API Key", { exact: true })).toHaveValue("");
  let requests = 0;
  await page.route("https://sampling.fixture.test/**", async (route) => {
    requests += 1;
    const body = route.request().postDataJSON();
    expect(body.temperature).toBeUndefined();
    expect(body.frequency_penalty).toBe(1.5);
    await route.fulfill({
      json: {
        choices: [{ message: { content: "连接成功" }, finish_reason: "stop" }],
      },
    });
  });
  await page
    .getByLabel("API Key", { exact: true })
    .fill("sampling-fixture-key");
  await temperature.fill("2.1");
  await page.getByRole("button", { name: "测试连接并继续" }).click();
  expect(
    await temperature.evaluate(
      (input: HTMLInputElement) => input.validity.rangeOverflow,
    ),
  ).toBe(true);
  expect(requests).toBe(0);
  await temperature.fill("");
  await page
    .locator(".connection-sampling")
    .screenshot({ path: "outputs/sampling/desktop.png" });
  await page.getByRole("button", { name: "测试连接并继续" }).click();
  await expect(page.getByLabel("角色名字", { exact: true })).toBeVisible();
  expect(requests).toBe(1);
});
