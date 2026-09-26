import { test, expect, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { seedJourney, readStore } from "./fixtures";
import type { TheaterData, TheaterItem } from "../src/types";
const appPath = process.env.CIJIAN_TEST_PATH || "/";
const capturePath = process.env.CIJIAN_TEST_CAPTURE || "work/v2.3-theater-qa";

const prose = "周屿把伞递到许知面前，右手还握着伞柄。他的肩膀稍稍放松。许知抬眼看他，轻轻吸了一口气。";
const item = (id: string, text: string, extra: Partial<TheaterItem> = {}): TheaterItem => ({ id, author: "檐下听雨", badge: "细节党", title: "", text, quote: "", certainty: "observed", replyTo: "", group: "", status: "", fields: [], ...extra });
const structured: TheaterData = { version: 1, sections: [
  { id: "theater-audience", title: "伞递过去了，人怎么还没走", presentation: "forum", theme: "forest", html: "", items: [
    item("f1", "他把伞递过去，却还握着伞柄。这个停顿比那句话长。", { quote: "右手还握着伞柄" }),
    item("f2", "可能只是怕伞掉了，先别替他把心事说完。", { author: "理性路人", badge: "路过", certainty: "inferred", replyTo: "f1" }),
    item("f3", "我也觉得，等她接稳再松手挺正常的。", { author: "书页里的风", badge: "接话", certainty: "inferred", replyTo: "f2" }),
    item("f4", "我注意到的是肩膀。他刚才一直绷着吗？", { author: "微表情记录员", quote: "他的肩膀稍稍放松", certainty: "inferred" }),
    item("f5", "MOCK 未定位引用，只用于界面测试。", { author: "另一位观众", quote: "正文里并不存在的引句", certainty: "inferred" }),
  ] },
  { id: "theater-body", title: "动作停下来的这一刻", presentation: "body-status", theme: "paper", html: "", items: [
    item("b1", "右手仍环着伞柄，递出的动作还留在指间。", { author: "周屿", title: "右手与手指", group: "上肢", status: "subtle", quote: "右手还握着伞柄", fields: [{ label: "变化", value: "递出后仍未松开" }, { label: "持续时间", value: "正文描写的这一刻" }] }),
    item("b2", "肩膀稍稍放松，没有更多动作变化。", { author: "周屿", title: "肩膀", group: "肩颈", status: "subtle", quote: "他的肩膀稍稍放松" }),
    item("b3", "本回合未提及。", { author: "周屿", title: "左脚踝", group: "下肢", status: "unmentioned", certainty: "unknown" }),
    item("b4", "轻轻吸气。", { author: "许知", title: "呼吸", group: "躯干", status: "clear", quote: "轻轻吸了一口气" }),
    item("b5", "抬起视线看向周屿。", { author: "许知", title: "眼睛与视线", group: "头面", status: "subtle", quote: "许知抬眼看他" }),
  ] },
  { id: "theater-subtext", title: "没说出口的半句", presentation: "subtext-card", theme: "night", html: "", items: [
    item("s1", "把伞递出去之后，两个人都停了一下。", { author: "周屿", title: "递伞的停顿", certainty: "inferred", fields: [{ label: "可能没说出口", value: "雨还没停，你再等等。" }, { label: "另一种理解", value: "也可能只是在等对方把伞接稳。" }] }),
  ] },
] };

async function seed(page: Page, legacy = false) {
  await seedJourney(page, appPath);
  await page.evaluate(async ({ data, prose, legacy }) => {
    const req = indexedDB.open("little-scene-v1");
    const database = await new Promise<IDBDatabase>((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
    const tx = database.transaction(["stories", "events", "theaters", "preferences", "profiles"], "readwrite");
    const story = tx.objectStore("stories").get("fixture-story");
    story.onsuccess = () => tx.objectStore("stories").put({ ...story.result, autoMemory: false, theaterPresetIds: data.sections.map((s) => s.id) });
    tx.objectStore("events").put({ id: "interactive-event", storyId: "fixture-story", kind: "novel", seq: 1, round: 1, speaker: "", participants: [], input: "递伞。", text: prose, facts: [], versions: [{ id: "iv1", text: prose, input: "递伞。", facts: [], created: 1 }], versionId: "iv1", status: "complete", raw: "", error: "", review: false, deleted: false, created: 1, theater: { id: "interactive-record", sourceVersionId: "iv1", status: "complete" } });
    tx.objectStore("theaters").put({ id: "interactive-record", storyId: "fixture-story", eventId: "interactive-event", sourceVersionId: "iv1", status: "complete", presets: data.sections.map((s) => ({ id: s.id, name: s.title, prompt: "MOCK", presentation: s.presentation })), ...(legacy ? {} : { data }), html: '<style>body{background:#111;color:#111}p{color:rgba(255,255,255,.05)!important;opacity:.05;filter:blur(2px);mix-blend-mode:screen;-webkit-text-fill-color:transparent;background:linear-gradient(#fff,#fff)}</style><section style="background:#fff"><p style="font-size:8px;color:#fff">旧内容也要清楚可读</p><details><summary>旧折叠内容</summary><p>这句话也能正常阅读</p></details></section>', text: "MOCK", raw: "", error: "", created: 1, updated: 1 });
    tx.objectStore("profiles").put({ id: "theater-profile", name: "交互 MOCK", protocol: "chat", url: "https://theater.fixture.test/v1", model: "fixture", stream: false, context: 64000, maxOutput: 4096, timeout: 15, remember: true, key: "fixture-key" });
    tx.objectStore("preferences").put({ id: "preferences", activeProfile: "theater-profile", developer: false, prompts: {} });
    await new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); });
    database.close();
  }, { data: structured, prose, legacy });
  await page.goto(appPath + "#story/fixture-story");
  await expect(page.locator(".prose-event")).toHaveCount(1);
}

test("legacy low-contrast HTML is readable by default, font choice persists, and folding unloads", async ({ page }) => {
  await seed(page, true);
  let requests = 0;
  await page.route("https://theater.fixture.test/**", () => { requests++; });
  await page.locator(".theater-toggle").click();
  const frame = page.frameLocator(".theater-frame");
  await expect(frame.getByText("旧内容也要清楚可读")).toBeVisible();
  const styles = await frame.getByText("旧内容也要清楚可读").evaluate((el) => {
    const style = getComputedStyle(el);
    return { color: style.color, size: parseFloat(style.fontSize), opacity: style.opacity, filter: style.filter, fill: style.webkitTextFillColor, blend: style.mixBlendMode };
  });
  expect(styles.size).toBeGreaterThanOrEqual(16);
  expect(styles.opacity).toBe("1"); expect(styles.filter).toBe("none"); expect(styles.blend).toBe("normal");
  expect(styles.color).not.toBe("rgb(255, 255, 255)"); expect(styles.fill).not.toBe("rgba(0, 0, 0, 0)");
  await page.getByLabel("小剧场字号", { exact: true }).selectOption("22");
  await expect.poll(async () => (await readStore(page, "theaters"))[0].reading?.fontSize).toBe(22);
  await page.getByRole("button", { name: "收起小剧场", exact: true }).click();
  await expect(page.locator("iframe")).toHaveCount(0);
  await page.locator(".theater-toggle").click();
  await expect(page.getByLabel("小剧场字号", { exact: true })).toHaveValue("22");
  expect(requests).toBe(0);
});

test("forum filters, nested replies, evidence, reactions, body parts and unsent draft work without AI", async ({ page }) => {
  await seed(page);
  let requests = 0;
  await page.route("https://theater.fixture.test/**", () => { requests++; });
  await expect(page.locator(".theater-structured")).toHaveCount(0);
  await page.locator(".theater-toggle").click();
  const forum = page.locator('[data-section-id="theater-audience"]');
  await forum.locator('[data-item-id="f1"]').getByText("查看正文依据", { exact: true }).click();
  await expect(forum.getByRole("blockquote")).toContainText("右手还握着伞柄");
  await forum.getByRole("button", { name: /展开.*楼中楼/ }).first().click();
  // Deeper branches remain reachable.
  const nested = forum.getByRole("button", { name: /展开.*楼中楼/ });
  if (await nested.count()) await nested.first().click();
  await expect(forum.getByText("我也觉得，等她接稳再松手挺正常的。", { exact: true })).toBeVisible();
  await forum.getByLabel("只看楼主", { exact: true }).check();
  await expect(forum.getByText("我也觉得，等她接稳再松手挺正常的。", { exact: true })).toHaveCount(0);
  await forum.getByLabel("只看楼主", { exact: true }).uncheck();
  await forum.getByLabel("隐藏猜测", { exact: true }).check();
  await expect(forum.getByTestId("theater-item")).toHaveCount(1);
  await forum.getByRole("button", { name: "赞", exact: true }).click();
  await forum.getByRole("button", { name: "收藏", exact: true }).click();
  await expect.poll(async () => (await readStore(page, "theaters"))[0].likes).toEqual(["theater-audience/f1"]);
  await forum.getByPlaceholder("刚才那句话，你是怎么想的？").fill("我还没点发送。");
  const body = page.locator('[data-section-id="theater-body"]');
  await body.getByRole("button", { name: "许知", exact: true }).click();
  await body.getByRole("button", { name: /眼睛与视线/ }).click();
  await expect(body.getByText("抬起视线看向周屿。", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "收起小剧场", exact: true }).click();
  await expect(page.locator(".theater-structured")).toHaveCount(0);
  await page.locator(".theater-toggle").click();
  await expect(forum.getByPlaceholder("刚才那句话，你是怎么想的？")).toHaveValue("我还没点发送。");
  expect(requests).toBe(0);
});

test("a forum reply appends once and a failed section expansion preserves prior content", async ({ page }) => {
  await seed(page);
  let requests = 0;
  await page.route("https://theater.fixture.test/**", async (route) => {
    requests++;
    if (requests === 2) return route.fulfill({ status: 503, json: { error: { message: "MOCK 暂时不可用" } } });
    await route.fulfill({ json: { choices: [{ message: { content: JSON.stringify({ theater: { version: 1, sections: [{ ...structured.sections[0], items: [item("new1", "MOCK 接住你的话了，我也注意到他的手。", { replyTo: "f1", certainty: "inferred" })] }] } }) }, finish_reason: "stop" }] } });
  });
  await page.locator(".theater-toggle").click();
  const forum = page.locator('[data-section-id="theater-audience"]');
  await forum.getByPlaceholder("刚才那句话，你是怎么想的？").fill("他真的没松手呢。");
  await forum.getByRole("button", { name: "发送并生成回复", exact: true }).click();
  await expect.poll(async () => (await readStore(page, "theaters"))[0].interaction?.status).toBe("complete");
  expect(requests).toBe(1);
  await expect.poll(async () => (await readStore(page, "theaters"))[0].data.sections[0].items.length).toBe(7);
  await forum.getByRole("button", { name: "追加讨论 · AI", exact: true }).click();
  await expect.poll(async () => (await readStore(page, "theaters"))[0].interaction?.status).toBe("failed");
  expect((await readStore(page, "theaters"))[0].data.sections[0].items).toHaveLength(7);
  expect((await readStore(page, "events"))[0].text).toBe(prose);
  expect(await readStore(page, "memories")).toHaveLength(0);
});

test("structured streaming publishes complete columns and still finishes while folded", async ({ page }) => {
  await seed(page);
  await page.evaluate((data) => {
    const original = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      if (!String(input).includes("theater.fixture.test")) return original(input, init);
      const encoder = new TextEncoder();
      const stream = new ReadableStream({ start(controller) {
        const send = (content: string, finished = false) => controller.enqueue(encoder.encode("data: " + JSON.stringify({ choices: [{ delta: { content }, ...(finished ? { finish_reason: "stop" } : {}) }] }) + "\n\n"));
        send('{"theater":{"version":1,"sections":[' + JSON.stringify(data.sections[0]) + ',');
        (window as any).__finishStructuredTheater = () => { send(data.sections.slice(1).map((section) => JSON.stringify(section)).join(",") + ']}}', true); controller.close(); };
      } });
      return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
    };
  }, structured);
  await page.locator(".theater-toggle").click();
  await page.getByPlaceholder("刚才那句话，你是怎么想的？").fill("这句留在旧的小剧场里。");
  await expect.poll(async () => (await readStore(page, "theaters"))[0].replyDrafts?.["theater-audience"]).toBe("这句留在旧的小剧场里。");
  await page.getByRole("button", { name: "重新生成小剧场", exact: true }).click();
  await expect.poll(async () => (await readStore(page, "theaters")).find((t) => t.status === "running")?.data?.sections.length).toBe(1);
  await page.getByRole("button", { name: "收起小剧场", exact: true }).click();
  await expect(page.locator(".theater-structured")).toHaveCount(0);
  await page.evaluate(() => (window as any).__finishStructuredTheater());
  await expect.poll(async () => (await readStore(page, "theaters")).find((t) => t.id !== "interactive-record")?.status).toBe("complete");
  await page.locator(".theater-toggle").click();
  await expect(page.locator(".theater-structured-section")).toHaveCount(3);
  await expect(page.getByPlaceholder("刚才那句话，你是怎么想的？")).toHaveValue("");
});

test("another tab does not interrupt or duplicate a running forum reply", async ({ page, context }) => {
  await seed(page);
  let release!: () => void;
  let requests = 0;
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  await context.route("https://theater.fixture.test/**", async (route) => {
    requests++;
    await barrier;
    await route.fulfill({ json: { choices: [{ message: { content: JSON.stringify({ theater: { version: 1, sections: [{ ...structured.sections[0], items: [item("later", "跨标签页的这一句保留下来了。", { replyTo: "f1" })] }] } }) }, finish_reason: "stop" }] } });
  });
  await page.locator(".theater-toggle").click();
  await page.getByPlaceholder("刚才那句话，你是怎么想的？").fill("再等等他的动作。");
  await page.getByRole("button", { name: "发送并生成回复", exact: true }).click();
  await expect.poll(() => requests).toBe(1);
  const second = await context.newPage();
  await second.goto(appPath + "#story/fixture-story");
  await second.locator(".theater-toggle").click();
  await expect(second.getByRole("button", { name: "发送并生成回复", exact: true })).toBeDisabled();
  expect((await readStore(second, "theaters"))[0].interaction.status).toBe("running");
  release();
  await expect.poll(async () => (await readStore(second, "theaters"))[0].interaction.status).toBe("complete");
  expect(requests).toBe(1);
  await second.close();
});

for (const size of [{ name: "desktop", width: 1440, height: 1000 }, { name: "mobile", width: 390, height: 844 }, { name: "landscape", width: 844, height: 390 }]) {
  test(`interactive theater ${size.name} full-page and detail views`, async ({ page }, info) => {
    await page.setViewportSize(size);
    const errors: string[] = []; page.on("pageerror", (error) => errors.push(error.message));
    await seed(page);
    await page.getByRole("button", { name: "沉浸阅读", exact: true }).click();
    await page.locator(".theater-toggle").click();
    await expect(page.locator(".theater-structured-section")).toHaveCount(3);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(errors).toEqual([]);
    await mkdir(capturePath, { recursive: true });
    await page.screenshot({ path: `${capturePath}/${size.name}-full.png`, fullPage: true });
    await page.locator(".theater-panel").screenshot({ path: `${capturePath}/${size.name}-detail.png`, style: ".story-reader-controls{visibility:hidden!important}" });
    await info.attach(`${size.name} mock layout`, { path: `${capturePath}/${size.name}-detail.png`, contentType: "image/png" });
  });
}
