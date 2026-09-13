import { test, expect } from "@playwright/test";
import { seedJourney } from "./fixtures";
import { writeFile } from "node:fs/promises";
test("real browser connection, expansion and chat", async ({ page }) => {
  test.skip(
    process.env.RUN_LIVE !== "1",
    "Real calls require explicit RUN_LIVE and environment credentials.",
  );
  test.setTimeout(240000);
  const key = process.env.OPENAI_API_KEY,
    url = process.env.OPENAI_BASE_URL;
  if (!key || !url) throw Error("Live credentials unavailable");
  const evidence: { stage: string; status: number; cors: string | null }[] = [];
  page.on("response", (r) => {
    if (r.url().startsWith(url) && r.request().method() === "POST")
      evidence.push({
        stage: "browser fetch",
        status: r.status(),
        cors: r.headers()["access-control-allow-origin"] || null,
      });
  });
  await seedJourney(page);
  await page.getByRole("link", { name: "设置", exact: true }).click();
  await page.getByRole("button", { name: "添加接口" }).click();
  await page.getByLabel("接口 URL").fill(url);
  await page.getByLabel("API Key", { exact: true }).fill(key);
  await page.getByLabel("模型名", { exact: true }).fill("gpt-5.4-mini");
  await page.getByRole("button", { name: "测试连接", exact: true }).click();
  await expect(page.locator(".connection-result")).toContainText(
    "浏览器连接成功",
    { timeout: 120000 },
  );
  await page.getByRole("button", { name: "保存并选用" }).click();
  await page.getByRole("link", { name: "故事", exact: true }).click();
  await page.getByRole("link").filter({ hasText: "雨声未歇" }).click();
  await page.getByRole("button", { name: "扩写这一刻", exact: true }).click();
  await expect(page.locator(".prose-event .event-actions")).toBeVisible({
    timeout: 120000,
  });
  await expect(page.locator(".prose-event .event-text")).toContainText("拿着");
  await page.screenshot({ path: "work/live-novel.png", fullPage: true });
  await page.getByRole("button", { name: "手机聊天", exact: true }).click();
  await page.getByLabel("聊天消息").fill("刚才递给你的伞还好用吗？");
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  await expect(
    page.locator(".message-event.theirs .event-actions").first(),
  ).toBeVisible({ timeout: 120000 });
  await page.screenshot({ path: "work/live-chat.png", fullPage: true });
  const novel = await page.locator(".node-marker").count();
  const replies = await page
    .locator(".message-event.theirs .event-text")
    .allTextContents();
  await writeFile(
    "work/live-evidence.json",
    JSON.stringify(
      {
        time: new Date().toISOString(),
        protocol: "OpenAI-compatible Chat Completions",
        model: "gpt-5.4-mini",
        requests: evidence,
        novelNodes: novel,
        replies,
        validated:
          "actual browser fetch; no mocked route; key remains session-only",
      },
      null,
      2,
    ),
  );
});
