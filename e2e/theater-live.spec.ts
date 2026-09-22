import { test, expect } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { seedJourney, readStore } from "./fixtures";

test("real provider automatic and manual theater", async ({ page }) => {
  test.skip(process.env.RUN_THEATER_LIVE !== "1", "Opt-in real provider check; requires configured credentials.");
  test.setTimeout(240000);
  const key = process.env.OPENAI_API_KEY;
  const url = process.env.OPENAI_BASE_URL;
  if (!key || !url) throw Error("Live credentials unavailable");
  const requests: { status: number }[] = [];
  page.on("response", (response) => {
    if (response.url().startsWith(url) && response.request().method() === "POST") requests.push({ status: response.status() });
  });
  await seedJourney(page);
  // Use the app's session-only key storage in this isolated test browser.
  await page.evaluate(async ({ key, url, model }) => {
    const { db, saveProfile } = await import("/src/db.ts");
    await saveProfile({ id: "live-theater", name: "真实接口验收", protocol: "chat", url,
      model, stream: true, context: 32000, maxOutput: 3072, timeout: 100,
      remember: false, outputMode: "compatible", prefixReuse: "off", frequencyPenalty: null }, key);
    await db.preferences.update("preferences", { activeProfile: "live-theater" });
    await db.stories.update("fixture-story", { theaterAuto: true, theaterPresetIds: ["theater-roast", "theater-subtext"], autoMemory: false });
  }, { key, url, model: process.env.OPENAI_MODEL || "gpt-5.4-mini" });
  await page.getByRole("link", { name: "故事", exact: true }).click();
  await page.getByRole("link").filter({ hasText: "雨声未歇" }).click();
  await page.getByRole("button", { name: "扩写这一刻", exact: true }).click();
  await expect.poll(async () => {
    const rows = await readStore(page, "events");
    return rows[0]?.status === "complete" ? "complete" : rows[0]?.error ? "failed" : "pending";
  }, { timeout: 120000 }).not.toBe("pending");
  const events = await readStore(page, "events");
  await mkdir("work/v2-theater-qa", { recursive: true });
  await writeFile("work/v2-theater-qa/live-result.json", JSON.stringify({
    model: process.env.OPENAI_MODEL || "gpt-5.4-mini", requests,
    autoProse: events[0]?.status, error: events[0]?.error || "",
    autoTheater: events[0]?.theater?.status, kind: "real browser request; no mocked routes",
  }, null, 2));
  expect(events[0]?.status, "The real reply must complete before accepting prose").toBe("complete");
  expect(events[0]?.theater?.status).toBe("complete");
  expect(requests).toHaveLength(1);
  expect(await page.locator("iframe.theater-frame").count()).toBe(0);
  await page.locator(".theater-toggle").click();
  await expect(page.frameLocator("iframe.theater-frame").locator("body")).not.toBeEmpty();
  await page.screenshot({ path: "work/v2-theater-qa/live-auto-desktop.png", fullPage: true });
  await page.getByRole("button", { name: "重新生成小剧场", exact: true }).click();
  await expect.poll(async () => (await readStore(page, "theaters")).length, { timeout: 10000 }).toBe(2);
  await expect.poll(async () => (await readStore(page, "theaters")).find((row) => row.id !== events[0]?.theater?.id)?.status,
    { timeout: 120000 }).not.toBe("running");
  const theaters = await readStore(page, "theaters");
  const manual = theaters.find((row) => row.id !== events[0]?.theater?.id);
  expect(manual?.status).toBe("complete");
  expect(requests).toHaveLength(2);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: "work/v2-theater-qa/live-manual-mobile.png", fullPage: true });
  await writeFile("work/v2-theater-qa/live-result.json", JSON.stringify({
    model: process.env.OPENAI_MODEL || "gpt-5.4-mini", requests,
    autoProse: "complete", autoTheater: "complete", manualTheater: manual.status,
    autoPresetNames: theaters.find((row) => row.id === events[0]?.theater?.id)?.presets.map((preset: {name: string}) => preset.name),
    kind: "real browser requests; no mocked routes; session-only key", completedAt: new Date().toISOString(),
  }, null, 2));
});
