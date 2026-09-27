import { expect, test, type Page, type Route } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { readStore, seedJourney } from "./fixtures";
import type { TheaterData, TheaterItem } from "../src/types";

const appPath = process.env.CIJIAN_TEST_PATH || "/";
const capturePath = process.env.CIJIAN_TEST_CAPTURE || "work/v2.3.1-theater-qa";
const prose = "周屿把伞递到许知面前，右手仍握着伞柄。许知接住伞，抬眼看他。";
const oldHtml = '<section><h2>MOCK 旧格式论坛</h2><p>看起来像帖子，实际只是一份静态阅读内容。</p><button>假回复按钮</button></section>';
const item = (id: string, text: string, extra: Partial<TheaterItem> = {}): TheaterItem => ({
  id, author: "檐下听雨", badge: "细节党", title: "", text, quote: "", certainty: "inferred", replyTo: "", group: "", status: "", fields: [], ...extra,
});
const forum: TheaterData = { version: 1, sections: [
  { id: "theater-audience", title: "MOCK 他还握着伞柄", presentation: "forum", theme: "forest", html: "", items: [
    item("f1", "伞递出去了，右手还没有松开。", { quote: "右手仍握着伞柄", certainty: "observed" }),
    item("f2", "可能只是等她拿稳，先别急着解释。", { author: "理性路人", replyTo: "f1" }),
  ] },
] };

async function response(route: Route, value: unknown) {
  await route.fulfill({ contentType: "text/event-stream", body: "data: " + JSON.stringify({ choices: [{ delta: { content: JSON.stringify(value) }, finish_reason: "stop" }] }) + "\n\ndata: [DONE]\n\n" });
}

async function seed(page: Page, options: { automatic?: boolean; custom?: boolean; explicitCustom?: boolean; developer?: boolean; saved?: boolean; structured?: boolean } = {}) {
  await seedJourney(page, appPath);
  await page.evaluate(async ({ prose, oldHtml, forum, options }) => {
    const req = indexedDB.open("little-scene-v1");
    const database = await new Promise<IDBDatabase>((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
    const tx = database.transaction(["stories", "events", "theaters", "preferences", "profiles"], "readwrite");
    // This is the real upgrade shape: an old edited builtin only stores its name and prompt.
    const preset = options.custom
      ? { id: "custom-readonly", name: "伞的自由随笔", prompt: "用静态美化框写两句伞的旁白。", presentation: "custom" }
      : { id: "theater-audience", name: "我改过名字的观众席", prompt: "保留我的自定义要求，观众认真讨论伞柄上的动作。", ...(options.explicitCustom ? { presentation: "custom" } : {}) };
    const story = tx.objectStore("stories").get("fixture-story");
    story.onsuccess = () => tx.objectStore("stories").put({ ...story.result, autoMemory: false, timelineMode: "shared", theaterAuto: !!options.automatic, theaterPresetIds: [preset.id] });
    tx.objectStore("events").put({ id: "recovery-event", storyId: "fixture-story", kind: "novel", seq: 1, round: 1, speaker: "", participants: [], input: "递伞。", text: prose, facts: [], versions: [{ id: "recovery-source", text: prose, input: "递伞。", facts: [], created: 1 }], versionId: "recovery-source", status: "complete", raw: "", error: "", review: false, deleted: false, created: 1,
      ...(options.saved ? { theater: { id: "recovery-saved", sourceVersionId: "recovery-source", status: "complete" } } : {}),
    });
    if (options.saved) tx.objectStore("theaters").put({ id: "recovery-saved", storyId: "fixture-story", eventId: "recovery-event", sourceVersionId: "recovery-source", presets: [preset], ...(options.structured ? { data: forum } : {}), html: oldHtml, text: "MOCK 旧结果", raw: JSON.stringify({ theaterHtml: oldHtml }), status: "complete", error: "", created: 1, updated: 1 });
    tx.objectStore("profiles").put({ id: "recovery-profile", name: "格式回归 MOCK", protocol: "chat", url: "https://theater.fixture.test/v1", model: "fixture", stream: true, context: 64000, maxOutput: 4096, timeout: 15, remember: true, key: "fixture-key", prefixReuse: "off" });
    tx.objectStore("preferences").put({ id: "preferences", activeProfile: "recovery-profile", developer: !!options.developer, prompts: {}, theaterPresets: [preset] });
    await new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); });
    database.close();
  }, { prose, oldHtml, forum, options });
  await page.goto(appPath + "#story/fixture-story");
  await expect(page.locator(".prose-event")).toHaveCount(1);
}

test("an old renamed builtin keeps its name and prompt but requests a usable forum", async ({ page }) => {
  await seed(page);
  const requests: any[] = [];
  await page.route("https://theater.fixture.test/**", async (route) => {
    requests.push(route.request().postDataJSON());
    await response(route, { theater: forum });
  });
  await page.locator(".theater-toggle").click();
  await expect.poll(async () => (await readStore(page, "theaters"))[0]?.status).toBe("complete");
  const prompt = requests[0].messages.map((message: { content: string }) => message.content).join("\n");
  expect(prompt).toContain('presentation="forum"');
  expect(prompt).toContain("我改过名字的观众席");
  expect(prompt).toContain("保留我的自定义要求，观众认真讨论伞柄上的动作。");
  const record = (await readStore(page, "theaters"))[0];
  expect(record.presets[0]).toMatchObject({ name: "我改过名字的观众席", presentation: "forum" });
  await page.getByPlaceholder("刚才那句话，你是怎么想的？").fill("我也注意到了他的手。");
  await expect(page.getByRole("button", { name: "发送并生成回复", exact: true })).toBeEnabled();
  await page.getByLabel("只看楼主", { exact: true }).check();
  await expect(page.getByTestId("theater-item")).toHaveCount(1);
  expect(requests).toHaveLength(1);
});

for (const viewport of [{ name: "desktop", width: 1440, height: 1000 }, { name: "mobile", width: 390, height: 844 }, { name: "landscape", width: 844, height: 390 }]) {
  test(`old HTML is retained with an explicit failure and recovers only on retry · ${viewport.name}`, async ({ page }, info) => {
    await page.setViewportSize(viewport);
    const errors: string[] = []; page.on("pageerror", (error) => errors.push(error.message));
    await seed(page);
    let requests = 0;
    await page.route("https://theater.fixture.test/**", async (route) => {
      requests++;
      await response(route, requests === 1 ? { theaterHtml: oldHtml } : { theater: forum });
    });
    await page.getByRole("button", { name: "沉浸阅读", exact: true }).click();
    await page.locator(".theater-toggle").click();
    const panel = page.getByRole("region", { name: "本段小剧场" });
    await expect.poll(async () => (await readStore(page, "theaters"))[0]?.status).toBe("failed");
    await expect(panel.getByRole("alert").first()).toContainText("交互格式");
    await expect(panel.getByTestId("theater-readonly-notice")).toContainText("仅阅读");
    await expect(page.frameLocator(".theater-frame").getByText("MOCK 旧格式论坛", { exact: true })).toBeVisible();
    await expect(page.frameLocator(".theater-frame").locator("button")).toHaveCount(0);
    await expect(panel.getByRole("button", { name: "发送并生成回复", exact: true })).toHaveCount(0);
    const failed = (await readStore(page, "theaters"))[0];
    expect(failed.html).toBe(oldHtml);
    expect(failed.raw).toContain(oldHtml);
    expect(failed.error).toContain("仅阅读");
    expect((await readStore(page, "events"))[0].status).toBe("complete");
    await panel.getByText("查看这次小剧场的模型原始输出", { exact: true }).click();
    await expect(panel.locator("details pre")).toContainText('"theaterHtml"');
    await panel.getByText("查看这次小剧场的模型原始输出", { exact: true }).click();
    await mkdir(capturePath, { recursive: true });
    await page.screenshot({ path: `${capturePath}/recovery-${viewport.name}-failed-full.png`, fullPage: true });
    await panel.screenshot({ path: `${capturePath}/recovery-${viewport.name}-failed-detail.png`, style: ".story-reader-controls{visibility:hidden!important}" });
    await panel.getByRole("button", { name: "收起小剧场", exact: true }).click();
    await expect(page.locator("iframe, .theater-structured")).toHaveCount(0);
    await page.locator(".theater-toggle").click();
    await expect(page.getByTestId("theater-readonly-notice")).toBeVisible();
    await page.reload();
    await page.getByRole("button", { name: "沉浸阅读", exact: true }).click();
    await page.locator(".theater-toggle").click();
    await expect(page.getByTestId("theater-readonly-notice")).toBeVisible();
    expect(requests).toBe(1);
    await panel.getByRole("button", { name: "重新生成小剧场", exact: true }).click();
    await expect.poll(async () => (await readStore(page, "theaters")).find((record) => record.id !== failed.id)?.status).toBe("complete");
    await expect(panel.getByRole("button", { name: "发送并生成回复", exact: true })).toBeVisible();
    await expect(panel.getByTestId("theater-readonly-notice")).toHaveCount(0);
    await expect(page.locator("iframe")).toHaveCount(0);
    await panel.getByPlaceholder("刚才那句话，你是怎么想的？").fill("这一次有真正的回复入口了。");
    await expect(panel.getByRole("button", { name: "发送并生成回复", exact: true })).toBeEnabled();
    await expect.poll(async () => (await readStore(page, "theaters")).find((record) => record.status === "complete")?.replyDrafts?.["theater-audience"]).toBe("这一次有真正的回复入口了。");
    expect(requests).toBe(2);
    expect((await readStore(page, "theaters")).find((record) => record.id === failed.id)?.raw).toBe(failed.raw);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(errors).toEqual([]);
    await page.screenshot({ path: `${capturePath}/recovery-${viewport.name}-interactive-full.png`, fullPage: true });
    await panel.screenshot({ path: `${capturePath}/recovery-${viewport.name}-interactive-detail.png`, style: ".story-reader-controls{visibility:hidden!important}" });
    await info.attach(`${viewport.name} format recovery`, { path: `${capturePath}/recovery-${viewport.name}-interactive-detail.png`, contentType: "image/png" });
  });
}

test("automatic old HTML fails only the theater and leaves completed prose with one request", async ({ page }) => {
  await seed(page, { automatic: true });
  let requests = 0;
  await page.route("https://theater.fixture.test/**", async (route) => {
    requests++;
    await response(route, { text: "MOCK 新正文。许知把伞拿稳，周屿松开手。", facts: [], theaterHtml: oldHtml });
  });
  await page.getByRole("button", { name: "扩写这一刻", exact: true }).click();
  await expect.poll(async () => (await readStore(page, "events")).find((event) => event.id !== "recovery-event")?.status).toBe("complete");
  await expect.poll(async () => (await readStore(page, "theaters"))[0]?.status).toBe("failed");
  const event = (await readStore(page, "events")).find((event) => event.id !== "recovery-event");
  expect(event.text).toBe("MOCK 新正文。许知把伞拿稳，周屿松开手。");
  expect(event.raw).not.toContain("MOCK 旧格式论坛");
  expect(event.theater.status).toBe("failed");
  await expect(page.locator("iframe")).toHaveCount(0);
  await page.locator(".prose-event").last().locator(".theater-toggle").click();
  await expect(page.getByRole("alert").first()).toContainText("交互格式");
  await expect(page.getByTestId("theater-readonly-notice")).toBeVisible();
  expect(requests).toBe(1);
  expect(await readStore(page, "memories")).toHaveLength(0);
});

test("an explicit custom HTML preset remains supported and is labelled as read only", async ({ page }) => {
  await seed(page, { custom: true });
  let requests = 0;
  await page.route("https://theater.fixture.test/**", async (route) => { requests++; await response(route, { theaterHtml: oldHtml }); });
  await page.locator(".theater-toggle").click();
  await expect.poll(async () => (await readStore(page, "theaters"))[0]?.status).toBe("complete");
  await expect(page.getByTestId("theater-readonly-notice")).toContainText("仅阅读");
  await expect(page.frameLocator(".theater-frame").getByText("MOCK 旧格式论坛", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "发送并生成回复", exact: true })).toHaveCount(0);
  expect(requests).toBe(1);
});

test("stored legacy HTML remains readable after reload without silently regenerating", async ({ page }) => {
  await seed(page, { saved: true });
  let requests = 0;
  await page.route("https://theater.fixture.test/**", async (route) => { requests++; await response(route, { theater: forum }); });
  await page.locator(".theater-toggle").click();
  await expect(page.getByTestId("theater-readonly-notice")).toContainText("仅阅读");
  await expect(page.frameLocator(".theater-frame").getByText("MOCK 旧格式论坛", { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.locator("iframe")).toHaveCount(0);
  await page.locator(".theater-toggle").click();
  await expect(page.frameLocator(".theater-frame").getByText("MOCK 旧格式论坛", { exact: true })).toBeVisible();
  expect((await readStore(page, "theaters"))[0].status).toBe("complete");
  expect(requests).toBe(0);
});

test("restoring only a builtin presentation preserves custom wording and historical results without an AI request", async ({ page }) => {
  await seed(page, { saved: true, explicitCustom: true, developer: true });
  const before = (await readStore(page, "theaters"))[0];
  let requests = 0;
  await page.route("https://theater.fixture.test/**", async (route) => { requests++; await response(route, { theater: forum }); });
  await page.getByRole("link", { name: "设置", exact: true }).click();
  const settings = page.locator(".theater-preset-settings");
  const edited = settings.locator("article").filter({ has: page.getByText("我改过名字的观众席", { exact: true }) });
  await expect(edited).toContainText("静态阅读");
  await edited.getByRole("button", { name: "使用内置交互形式", exact: true }).click();
  await expect.poll(async () => (await readStore(page, "preferences"))[0].theaterPresets.find((preset: { id: string }) => preset.id === "theater-audience")?.presentation).toBe("forum");
  await expect(edited).toContainText("论坛");
  const preset = (await readStore(page, "preferences"))[0].theaterPresets.find((preset: { id: string }) => preset.id === "theater-audience");
  expect(preset.name).toBe("我改过名字的观众席");
  expect(preset.prompt).toBe("保留我的自定义要求，观众认真讨论伞柄上的动作。");
  expect((await readStore(page, "theaters"))[0]).toEqual(before);
  expect(requests).toBe(0);
  await page.goto(appPath + "#story/fixture-story");
  await page.locator(".theater-toggle").click();
  await expect(page.getByTestId("theater-readonly-notice")).toBeVisible();
  expect(requests).toBe(0);
  await page.getByRole("button", { name: "重新生成小剧场", exact: true }).click();
  await expect.poll(async () => (await readStore(page, "theaters")).find((record) => record.id !== "recovery-saved")?.status).toBe("complete");
  await expect(page.getByRole("button", { name: "发送并生成回复", exact: true })).toBeVisible();
  expect(requests).toBe(1);
});

test("a fresh static response does not replace the previous successful interactive theater", async ({ page }) => {
  await seed(page, { saved: true, structured: true });
  let requests = 0;
  await page.route("https://theater.fixture.test/**", async (route) => { requests++; await response(route, { theaterHtml: oldHtml }); });
  await page.locator(".theater-toggle").click();
  await page.getByRole("button", { name: "重新生成小剧场", exact: true }).click();
  await expect.poll(async () => (await readStore(page, "theaters")).find((record) => record.id !== "recovery-saved")?.status).toBe("failed");
  await expect(page.getByText("这次没能完成，先保留上一次的小剧场。", { exact: true })).toBeVisible();
  await expect(page.locator(".theater-structured").getByText("MOCK 他还握着伞柄", { exact: true })).toBeVisible();
  expect((await readStore(page, "theaters")).find((record) => record.id === "recovery-saved")?.data).toEqual(forum);
  expect((await readStore(page, "events"))[0].text).toBe(prose);
  expect(requests).toBe(1);
});
