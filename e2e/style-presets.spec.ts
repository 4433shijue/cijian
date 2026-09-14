import { test, expect } from "@playwright/test";
import { seedJourney } from "./fixtures";

test.beforeEach(async ({ page }) => {
  await seedJourney(page);
});

test("developer style presets, writing preferences and memory center are available", async ({
  page,
}) => {
  await page.getByRole("link", { name: "设置", exact: true }).click();
  await page.getByRole("checkbox", { name: "显示内部提示词编辑器" }).check();
  await expect(page.getByRole("heading", { name: "文风预设" })).toBeVisible();
  await page.getByRole("button", { name: "新建预设" }).click();
  const editor = page.locator(".style-preset-editor");
  await editor.getByLabel("名称").fill("夜色短句");
  await editor.getByLabel("风格要求").fill("多用短句，少解释情绪。");
  await editor.getByRole("button", { name: "保存预设" }).click();
  await expect(page.getByText("夜色短句", { exact: true })).toBeVisible();

  await page.getByRole("link", { name: "故事", exact: true }).click();
  await page.getByRole("link").filter({ hasText: "雨声未歇" }).click();
  await expect(page.getByText(/故事状态/)).toBeVisible();
  await expect(page.getByText(/写作偏好/)).toBeVisible();
  await page.getByRole("button", { name: "故事记忆", exact: true }).click();
  await expect(page.getByRole("heading", { name: "记忆中心" })).toBeVisible();
  await expect(page.getByRole("tab", { name: /原文事实/ })).toBeVisible();
});
