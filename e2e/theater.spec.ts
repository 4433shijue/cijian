import { test, expect, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { readStore, seedJourney } from "./fixtures";

const mockHtml = `<style>.stage{padding:23px;border:1px solid #c8d7bf;border-radius:16px;background:linear-gradient(135deg,#fffdf0,#edf4e6)}.eyebrow{font-size:11px;letter-spacing:.18em;color:#8c9279}.stage h2{font-family:serif;font-size:24px;color:#435d45;margin:5px 0 18px}.line{display:grid;grid-template-columns:44px 1fr;gap:12px;margin:12px 0}.name{padding-top:8px;font-size:12px;color:#6d7d61}.bubble{padding:10px 15px;background:#ffffffb5;border-radius:3px 15px 15px;font-size:15px}.note{border-top:1px dashed #bdcbae;margin-top:18px;padding-top:14px;font-size:13px;color:#7d886d}@media(max-width:420px){.stage{padding:15px}.line{grid-template-columns:34px 1fr;gap:8px}}</style><section class="stage" data-theater-template="forum"><div class="eyebrow" data-forum-board>MOCK · 仅用于界面验证</div><h2 data-forum-title>伞柄上的那点心思</h2><article class="line" data-floor="1" data-certainty="visible"><div data-forum-meta><span class="name" data-forum-author>周屿</span><span data-forum-badge>楼主 · 细节党</span></div><p class="bubble" data-floor-body>我只是顺手递把伞。为什么你们都看着我？</p></article><article class="line" data-floor="2" data-reply-to="1" data-certainty="inference"><div data-forum-meta><span class="name" data-forum-author>许知</span><span data-forum-badge>角色厨</span></div><p class="bubble" data-floor-body>那你倒是先松手呀。</p></article><div class="note" data-forum-rule>观众席 · 仅讨论当前回合已公开内容。</div></section>`;

async function seed(page: Page, options: { saved?: boolean; automatic?: boolean; html?: string; developer?: boolean } = {}) {
  await seedJourney(page);
  await page.evaluate(async ({ saved, automatic, html, developer }) => {
    const request = indexedDB.open("little-scene-v1");
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    const tx = database.transaction(["stories", "events", "profiles", "preferences", "theaters"], "readwrite");
    const story = tx.objectStore("stories").get("fixture-story");
    story.onsuccess = () => tx.objectStore("stories").put({ ...story.result, autoMemory: false, timelineMode: "shared", theaterAuto: !!automatic, theaterPresetIds: ["theater-roast", "theater-audience"] });
    const text = "周屿把伞递到许知面前，握着伞柄的手稍稍向前伸了些。\n\n“拿着。”声音不高，说话时也没有转过头来看她。";
    tx.objectStore("events").put({ id: "theater-event", storyId: "fixture-story", seq: 1, round: 1, kind: "novel", speaker: "", participants: ["fixture-role-a", "fixture-role-b"], input: "周屿递伞。", text,
      facts: [], versions: [{ id: "theater-source", text, input: "周屿递伞。", facts: [], created: 1 }], versionId: "theater-source", status: "complete", raw: "", error: "", review: false, deleted: false, created: 1,
      ...(saved ? { theater: { id: "theater-saved", sourceVersionId: "theater-source", status: "complete" } } : {}),
    });
    if (saved) tx.objectStore("theaters").put({ id: "theater-saved", storyId: "fixture-story", eventId: "theater-event", sourceVersionId: "theater-source", presets: [{ id: "theater-roast", name: "主角们的吐槽", prompt: "mock", presentation: "dialogue" }, { id: "theater-audience", name: "来自第四面墙的观众", prompt: "mock", presentation: "forum" }], html, text: "MOCK 界面验证", raw: JSON.stringify({ html }), status: "complete", error: "", created: 1, updated: 1 });
    tx.objectStore("profiles").put({ id: "theater-profile", name: "小剧场 mock 接口", protocol: "chat", url: "https://theater.fixture.test/v1", model: "fixture-model", stream: true, context: 20000, maxOutput: 4096, timeout: 15, remember: true, key: "fixture-key", prefixReuse: "off" });
    tx.objectStore("preferences").put({ id: "preferences", activeProfile: "theater-profile", developer: !!developer, prompts: {} });
    await new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); });
    database.close();
  }, { ...options, html: options.html || mockHtml });
  await page.goto("/#story/fixture-story");
  await expect(page.locator(".prose-event")).toHaveCount(1);
}

test("saved theater mounts only while open, preserves prose, and unloads with its parent", async ({ page }) => {
  await seed(page, { saved: true });
  const panel = page.getByRole("region", { name: "本段小剧场" });
  const prose = await page.locator(".event-text").textContent();
  await expect(page.locator("iframe")).toHaveCount(0);
  await panel.getByRole("button", { name: /小剧场.*这一刻的幕间/ }).click();
  await expect(page.frameLocator(".theater-frame").getByText("伞柄上的那点心思")).toBeVisible();
  await panel.getByRole("button", { name: "收起小剧场", exact: true }).click();
  await expect(page.locator("iframe")).toHaveCount(0);
  await panel.getByRole("button", { name: /小剧场.*这一刻的幕间/ }).click();
  await page.getByRole("button", { name: "折叠本段", exact: true }).click();
  await expect(page.locator(".theater-panel")).toHaveCount(0);
  await expect(page.locator("iframe")).toHaveCount(0);
  await page.getByRole("button", { name: "展开本段", exact: true }).click();
  await expect(page.locator(".event-text")).toHaveText(prose!);
  await expect(page.locator("iframe")).toHaveCount(0);
});

test("manual click makes one request with only target prose and settings, then reopening reuses the saved result", async ({ page }) => {
  await seed(page);
  const requests: any[] = [];
  await page.route("https://theater.fixture.test/**", async (route) => {
    requests.push(route.request().postDataJSON());
    await route.fulfill({ contentType: "text/event-stream", body: "data: " + JSON.stringify({ choices: [{ delta: { content: JSON.stringify({ theaterHtml: mockHtml }) }, finish_reason: "stop" }] }) + "\n\ndata: [DONE]\n\n" });
  });
  await page.locator(".theater-toggle").click();
  await expect(page.frameLocator(".theater-frame").getByText("伞柄上的那点心思")).toBeVisible();
  await expect.poll(async () => (await readStore(page, "theaters"))[0]?.status).toBe("complete");
  expect(requests).toHaveLength(1);
  const prompt = JSON.stringify(requests[0]);
  expect(prompt).toContain("周屿把伞递到许知面前");
  expect(prompt).toContain("河畔书屋");
  expect(prompt).not.toContain("傍晚，许知来到书店门口");
  await page.getByRole("button", { name: "收起小剧场", exact: true }).click();
  await page.locator(".theater-toggle").click();
  await expect(page.frameLocator(".theater-frame").getByText("伞柄上的那点心思")).toBeVisible();
  expect(requests).toHaveLength(1);
  expect((await readStore(page, "events"))[0].text).not.toContain("MOCK");
});

test("automatic theater shares the prose request and stays collapsed until opened", async ({ page }) => {
  await seed(page, { automatic: true });
  let requests = 0;
  await page.route("https://theater.fixture.test/**", async (route) => {
    requests++;
    await route.fulfill({ contentType: "text/event-stream", body: "data: " + JSON.stringify({ choices: [{ delta: { content: JSON.stringify({ text: "MOCK 新正文，周屿把伞递了过去。", facts: [], theaterHtml: mockHtml }) }, finish_reason: "stop" }] }) + "\n\ndata: [DONE]\n\n" });
  });
  await page.getByRole("button", { name: "扩写这一刻", exact: true }).click();
  await expect(page.locator(".prose-event").last().locator(".event-text")).toHaveText("MOCK 新正文，周屿把伞递了过去。");
  await expect.poll(async () => (await readStore(page, "theaters"))[0]?.status).toBe("complete");
  expect(requests).toBe(1);
  await expect(page.locator("iframe")).toHaveCount(0);
  const events = await readStore(page, "events");
  expect(events.find((event) => event.id !== "theater-event").raw).not.toContain("伞柄上的那点心思");
  expect((await readStore(page, "theaters"))[0].raw).toContain("伞柄上的那点心思");
  await page.locator(".prose-event").last().locator(".theater-toggle").click();
  await expect(page.frameLocator(".theater-frame").getByText("伞柄上的那点心思")).toBeVisible();
  expect(requests).toBe(1);
});

test("story theater density persists for ordinary users and is sent with the theater request", async ({ page }) => {
  await seed(page);
  let requestBody = "";
  await page.route("https://theater.fixture.test/**", async (route) => {
    requestBody = JSON.stringify(route.request().postDataJSON());
    await route.fulfill({ contentType: "text/event-stream", body: "data: " + JSON.stringify({ choices: [{ delta: { content: JSON.stringify({ theaterHtml: mockHtml }) }, finish_reason: "stop" }] }) + "\n\ndata: [DONE]\n\n" });
  });
  await page.getByRole("button", { name: "故事设置", exact: true }).click();
  await expect(page.getByLabel("小剧场丰富度", { exact: true })).toHaveValue("standard");
  await page.getByLabel("小剧场丰富度", { exact: true }).selectOption("rich");
  await expect.poll(async () => (await readStore(page, "stories")).find((story) => story.id === "fixture-story")?.theaterDensity).toBe("rich");
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await page.locator(".theater-toggle").click();
  await expect(page.frameLocator(".theater-frame").getByText("伞柄上的那点心思")).toBeVisible();
  expect(requestBody).toContain("【小剧场丰富度：丰富】");
  await page.getByRole("button", { name: "故事设置", exact: true }).click();
  await expect(page.getByLabel("小剧场丰富度", { exact: true })).toHaveValue("rich");
});

test("automatic prose rewrite folds its new theater even when the previous theater was open", async ({ page }) => {
  await seed(page, { saved: true, automatic: true });
  let requests = 0;
  await page.route("https://theater.fixture.test/**", async (route) => {
    requests++;
    await route.fulfill({ contentType: "text/event-stream", body: "data: " + JSON.stringify({ choices: [{ delta: { content: JSON.stringify({ text: "MOCK 自动重写正文。周屿把伞递了过去。", facts: [], theaterHtml: "<section><h2>MOCK 自动重写的小剧场</h2><p>伞又有了新的说法。</p></section>" }) }, finish_reason: "stop" }] }) + "\n\ndata: [DONE]\n\n" });
  });
  await page.locator(".theater-toggle").click();
  await expect(page.frameLocator(".theater-frame").getByText("伞柄上的那点心思")).toBeVisible();
  await page.getByRole("button", { name: "重写", exact: true }).click();
  await expect(page.locator(".prose-event .event-text").first()).toHaveText("MOCK 自动重写正文。周屿把伞递了过去。");
  await expect(page.locator(".prose-event")).toHaveCount(1);
  await expect.poll(async () => (await readStore(page, "events")).find((event) => event.id === "theater-event")?.theater?.status).toBe("complete");
  await expect(page.locator(".theater-toggle")).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator("iframe")).toHaveCount(0);
  expect(requests).toBe(1);
  await page.locator(".theater-toggle").click();
  await expect(page.frameLocator(".theater-frame").getByText("MOCK 自动重写的小剧场")).toBeVisible();
});

test("manual HTML streams while open and finishes without remounting after collapse", async ({ page }) => {
  await seed(page);
  await page.evaluate(() => {
    const original = window.fetch;
    window.fetch = async (input, init) => {
      if (!String(input).includes("theater.fixture.test")) return original(input, init);
      const encoder = new TextEncoder();
      const stream = new ReadableStream({ start(controller) {
        const send = (content: string, finished = false) => controller.enqueue(encoder.encode("data: " + JSON.stringify({ choices: [{ delta: { content }, ...(finished ? { finish_reason: "stop" } : {}) }] }) + "\n\n"));
        send('{"theaterHtml":"<section>MOCK 流式第一段');
        (window as any).__finishTheater = () => { send('，全部到齐。</section>"}', true); controller.close(); };
        init?.signal?.addEventListener("abort", () => controller.error(new DOMException("Aborted", "AbortError")), { once: true });
      } });
      return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
    };
  });
  await page.locator(".theater-toggle").click();
  await expect(page.frameLocator(".theater-frame").getByText("MOCK 流式第一段")).toBeVisible();
  await page.getByRole("button", { name: "收起小剧场", exact: true }).click();
  await expect(page.locator("iframe")).toHaveCount(0);
  await page.evaluate(() => (window as any).__finishTheater());
  await expect.poll(async () => (await readStore(page, "theaters"))[0]?.status).toBe("complete");
  await expect(page.locator("iframe")).toHaveCount(0);
  await page.locator(".theater-toggle").click();
  await expect(page.frameLocator(".theater-frame").getByText("MOCK 流式第一段，全部到齐。")).toBeVisible();
});

test("stopping automatic output retains the draft and lazily exposes its original combined response", async ({ page }) => {
  await seed(page, { automatic: true });
  await page.evaluate(() => {
    const original = window.fetch;
    window.fetch = async (input, init) => {
      if (!String(input).includes("theater.fixture.test")) return original(input, init);
      const stream = new ReadableStream({ start(controller) {
        const content = '{"text":"MOCK 已收到正文","facts":[],"theaterHtml":"<section>MOCK 小剧场片段';
        controller.enqueue(new TextEncoder().encode("data: " + JSON.stringify({ choices: [{ delta: { content } }] }) + "\n\n"));
        init?.signal?.addEventListener("abort", () => controller.error(new DOMException("Aborted", "AbortError")), { once: true });
      } });
      return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
    };
  });
  await page.getByRole("button", { name: "扩写这一刻", exact: true }).click();
  const draft = page.locator(".prose-event").last();
  await expect(draft.locator(".event-text")).toHaveText("MOCK 已收到正文");
  await expect(page.locator("iframe")).toHaveCount(0);
  await draft.locator(".theater-toggle").click();
  await expect(page.frameLocator(".theater-frame").getByText("MOCK 小剧场片段")).toBeVisible();
  await draft.getByRole("button", { name: "停止本次生成", exact: true }).click();
  await expect.poll(async () => (await readStore(page, "theaters"))[0]?.status).toBe("interrupted");
  await draft.getByText("查看模型原始输出", { exact: true }).click();
  await expect(draft.locator("details pre")).toContainText('"theaterHtml":"<section>MOCK 小剧场片段');
  const rows = await readStore(page, "events");
  expect(rows.find((event) => event.id !== "theater-event").status).toBe("draft");
  expect(rows.find((event) => event.id !== "theater-event").raw).not.toContain("MOCK 小剧场片段");
  await draft.getByRole("button", { name: "删除草稿", exact: true }).click();
  await expect.poll(async () => (await readStore(page, "theaters")).length).toBe(0);
});

test("HTML and CSS stay isolated; scripts, navigation, forms and remote resources are inert", async ({ page }) => {
  const external: string[] = [];
  page.on("request", (request) => { if (request.url().includes("untrusted.fixture.test")) external.push(request.url()); });
  await seed(page, { saved: true, html: `<style>body{background:rgb(244,247,235)}.paint{background-image:url(https://untrusted.fixture.test/css)}</style><section class="paint"><h2>安全展示</h2><script>parent.document.body.dataset.theaterAttack='yes'</script><a href="https://untrusted.fixture.test/nav" target="_top">这是展示文字</a><img src="https://untrusted.fixture.test/img" onerror="parent.document.body.dataset.theaterAttack='yes'"><iframe src="https://untrusted.fixture.test/frame"></iframe><form action="https://untrusted.fixture.test/form"><input autofocus><button>提交</button></form><meta http-equiv="refresh" content="0;url=https://untrusted.fixture.test/meta"><svg onload="alert(1)"></svg></section>` });
  await page.locator(".theater-toggle").click();
  const frame = page.frameLocator(".theater-frame");
  await expect(frame.getByText("安全展示")).toBeVisible();
  await expect(frame.locator("script,iframe,form,input,button,svg,meta[http-equiv=refresh]")).toHaveCount(0);
  await expect(frame.locator("a")).not.toHaveAttribute("href");
  await frame.getByText("这是展示文字").click();
  await expect(page).toHaveURL(/#story\/fixture-story/);
  await expect(page.locator("body")).not.toHaveAttribute("data-theater-attack");
  await expect(page.locator(".theater-frame")).toHaveAttribute("sandbox", "allow-same-origin");
  expect(external).toEqual([]);
});

test("failed attempts retain the previous complete theater and stale source is labelled", async ({ page }) => {
  await seed(page, { saved: true });
  await page.evaluate(async () => {
    const { db } = await import("/src/db.ts");
    const record = await db.theaters.get("theater-saved");
    await db.theaters.put({ ...record!, id: "theater-failed", previousId: "theater-saved", status: "failed", html: "", error: "MOCK 连接中断" });
    await db.events.update("theater-event", { theater: { id: "theater-failed", previousId: "theater-saved", sourceVersionId: "theater-source", status: "failed" }, versionId: "new-source" });
  });
  await page.locator(".theater-toggle").click();
  await expect(page.getByText("正文已经修改，下面的小剧场仍对应旧版本。可以按当前正文重新生成。")).toBeVisible();
  await expect(page.getByText("这次没能完成，先保留上一次的小剧场。")).toBeVisible();
  await expect(page.frameLocator(".theater-frame").getByText("伞柄上的那点心思")).toBeVisible();
});

test("after prose edits a failed regeneration keeps old theater labelled stale until a new result succeeds", async ({ page }) => {
  await seed(page, { saved: true });
  let attempts = 0;
  await page.route("https://theater.fixture.test/**", async (route) => {
    attempts++;
    if (attempts === 1) {
      await route.fulfill({ status: 503, json: { error: { message: "MOCK 暂时不可用" } } });
      return;
    }
    await route.fulfill({ contentType: "text/event-stream", body: "data: " + JSON.stringify({ choices: [{ delta: { content: JSON.stringify({ theaterHtml: "<section><h2>MOCK 新版小剧场</h2><p>这一次，伞已经放在了桌上。</p></section>" }) }, finish_reason: "stop" }] }) + "\n\ndata: [DONE]\n\n" });
  });
  await page.locator(".prose-event").getByRole("button", { name: "编辑", exact: true }).click();
  await page.getByRole("dialog", { name: "修改这一刻" }).getByLabel("正文 / 消息").fill("周屿把伞放在桌上，松开了手。");
  await page.getByRole("button", { name: "保存新版本", exact: true }).click();
  await page.locator(".theater-toggle").click();
  await page.getByRole("button", { name: "重新生成小剧场", exact: true }).click();
  await expect(page.getByText("上一次的小剧场对应修改前的正文，暂时保留供参考。")).toBeVisible();
  await expect(page.getByText("这次没能完成，先保留上一次的小剧场。")).toBeVisible();
  await expect(page.frameLocator(".theater-frame").getByText("伞柄上的那点心思")).toBeVisible();
  await page.getByRole("button", { name: "重新生成小剧场", exact: true }).click();
  await expect(page.frameLocator(".theater-frame").getByText("MOCK 新版小剧场")).toBeVisible();
  await expect(page.getByText("上一次的小剧场对应修改前的正文，暂时保留供参考。")).toHaveCount(0);
  const records = await readStore(page, "theaters");
  expect(records.find((record) => record.id === "theater-saved").html).toBe(mockHtml);
  expect(attempts).toBe(2);
});

test("developer presets support create, edit, restore, selection and order; auto remains available outside developer mode", async ({ page }) => {
  await seed(page, { developer: true });
  await page.getByRole("link", { name: "设置", exact: true }).click();
  const settings = page.locator(".theater-preset-settings");
  await settings.getByRole("button", { name: "新建小剧场预设" }).click();
  await settings.getByLabel("小剧场预设名称").fill("伞的独白");
  await settings.getByLabel("小剧场内容要求").fill("以这把伞的口吻，说两句旁白。");
  await settings.getByLabel("小剧场专属展示样式").selectOption("forum");
  await settings.getByRole("button", { name: "保存小剧场预设" }).click();
  await expect(settings.locator("article").filter({ has: page.getByText("伞的独白", { exact: true }) })).toContainText("论坛");
  await settings.locator("article").filter({ has: page.getByText("伞的独白", { exact: true }) }).getByRole("button", { name: "复制", exact: true }).click();
  await expect(settings.getByLabel("小剧场预设名称")).toHaveValue("伞的独白（副本）");
  await expect(settings.getByLabel("小剧场内容要求")).toHaveValue("以这把伞的口吻，说两句旁白。");
  await settings.getByRole("button", { name: "保存小剧场预设" }).click();
  const builtin = settings.locator("article").filter({ has: page.getByText("主角们的吐槽", { exact: true }) });
  await builtin.getByRole("button", { name: "编辑", exact: true }).click();
  await settings.getByLabel("小剧场预设名称").fill("主角碎碎念");
  await settings.getByRole("button", { name: "保存小剧场预设" }).click();
  await settings.locator("article").filter({ hasText: "主角碎碎念" }).getByRole("button", { name: "恢复内置" }).click();
  await expect(settings.getByText("主角们的吐槽", { exact: true })).toBeVisible();
  await page.goto("/#story/fixture-story");
  await page.getByRole("button", { name: "故事设置", exact: true }).click();
  await page.getByRole("checkbox", { name: "伞的独白", exact: true }).check();
  await page.getByRole("button", { name: "上移伞的独白" }).click();
  await expect(page.locator(".theater-preset-order li").nth(1)).toContainText("伞的独白");
  await page.getByRole("checkbox", { name: "主角们的吐槽", exact: true }).uncheck();
  await page.getByRole("checkbox", { name: "来自第四面墙的观众", exact: true }).uncheck();
  await page.getByRole("checkbox", { name: "新正文自动生成小剧场" }).check();
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await page.getByRole("link", { name: "设置", exact: true }).click();
  await page.getByRole("checkbox", { name: "显示内部提示词编辑器" }).uncheck();
  await page.goto("/#story/fixture-story");
  await page.getByRole("button", { name: "故事设置", exact: true }).click();
  await expect(page.getByRole("checkbox", { name: "新正文自动生成小剧场" })).toBeChecked();
  await expect(page.locator(".theater-story-presets")).toHaveCount(0);
  await expect(page.getByText(/当前内容：.*伞的独白/)).toBeVisible();
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await page.getByRole("link", { name: "设置", exact: true }).click();
  await page.getByRole("checkbox", { name: "显示内部提示词编辑器" }).check();
  await settings.locator("article").filter({ has: page.getByText("伞的独白", { exact: true }) }).getByRole("button", { name: "删除", exact: true }).click();
  await expect.poll(async () => (await readStore(page, "stories")).find((story) => story.id === "fixture-story")?.theaterPresetIds).toEqual(["theater-roast"]);
});

for (const viewport of [{ name: "desktop", width: 1440, height: 1100 }, { name: "mobile", width: 390, height: 844 }, { name: "landscape", width: 844, height: 390 }]) {
  test(`mock visual ${viewport.name} theater fits the page`, async ({ page }, info) => {
    await page.setViewportSize(viewport);
    await seed(page, { saved: true });
    await page.getByRole("button", { name: "沉浸阅读", exact: true }).click();
    await page.locator(".theater-toggle").click();
    await expect(page.frameLocator(".theater-frame").getByText("伞柄上的那点心思")).toBeVisible();
    await expect.poll(() => page.locator(".theater-frame").evaluate((frame) => frame.getBoundingClientRect().height)).toBeGreaterThan(200);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.evaluate(() => window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "instant" }));
    await expect.poll(() => page.evaluate(() => Math.abs(window.scrollY + window.innerHeight - document.documentElement.scrollHeight))).toBeLessThan(2);
    await page.screenshot({ path: info.outputPath(`mock-theater-${viewport.name}-full.png`), fullPage: true });
    await mkdir("work/v2-theater-qa", { recursive: true });
    await page.screenshot({ path: `work/v2-theater-qa/mock-theater-${viewport.name}-full.png`, fullPage: true });
    // The focused crop omits the unrelated floating reader controls; full-page evidence keeps them.
    const style = ".story-reader-controls{visibility:hidden!important}";
    await page.locator(".theater-panel").screenshot({ path: info.outputPath(`mock-theater-${viewport.name}-detail.png`), style });
    await page.locator(".theater-panel").screenshot({ path: `work/v2-theater-qa/mock-theater-${viewport.name}-detail.png`, style });
  });
}
