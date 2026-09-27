import { test, expect, type Page } from "@playwright/test";
import { seedJourney, readStore } from "./fixtures";
const appPath = process.env.CIJIAN_TEST_PATH || "/";
const capture = process.env.CIJIAN_TEST_CAPTURE || "work/v2.4-free-theater-qa";
const html = `<style>body{background:#142c3c;color:#f9efd9;padding:22px}.free-board{border:2px dashed #cfb572;border-radius:25px;padding:18px}button,input{font:inherit;padding:10px;border-radius:12px;background:#f9efd9;color:#142c3c;border:0}button{margin:6px}svg{width:65px}</style><main class="free-board"><h2>MOCK · 观众的夜间论坛</h2><p>伞递过去了，他的手还没松开。</p><svg viewBox="0 0 40 40"><circle cx="20" cy="20" r="16" fill="#cfb572"/></svg><p id="count">本地标记 0</p><button id="mark" onclick="mark()">我也注意到了</button><details><summary>翻开这条回复</summary><p>也可能只是等对方接稳。</p></details><button id="ask">让观众接着聊 · AI</button><p id="result"></p></main><script>let n=(cijian.getState()||{}).n||0;document.getElementById('count').textContent='本地标记 '+n;async function mark(){n++;await cijian.saveState({n});document.getElementById('count').textContent='本地标记 '+n}document.getElementById('ask').onclick=async()=>{try{await cijian.generate({prompt:'围绕伞柄再聊一句。'})}catch(e){document.getElementById('result').textContent=e.message}};cijian.generate({prompt:'不应自动发送'}).catch(()=>{document.body.dataset.autoblocked='yes'});try{parent.document.body.dataset.attacked='yes'}catch(e){document.body.dataset.opaque='yes'}</script>`;
const customHtml = `<style>body{background:#fbe6d4;color:#382f45;padding:25px}details{border:2px solid #ab694d;padding:15px;border-radius:8px}</style><h2>MOCK · 未寄出的纸条</h2><details><summary>拆开信封</summary><p>这次先把伞接住。</p></details>`;
async function seed(page: Page, content = html) {
  await seedJourney(page, appPath);
  await page.evaluate(
    async ({ content, customHtml }) => {
      const open = indexedDB.open("little-scene-v1");
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        open.onsuccess = () => resolve(open.result);
        open.onerror = () => reject(open.error);
      });
      const tx = db.transaction(
        ["stories", "events", "theaters", "profiles", "preferences"],
        "readwrite",
      );
      const get = tx.objectStore("stories").get("fixture-story");
      get.onsuccess = () =>
        tx.objectStore("stories").put({
          ...get.result,
          autoMemory: false,
          theaterPresetIds: ["theater-audience", "my-letter"],
        });
      const text = "周屿把伞递给许知，手还握着伞柄。";
      tx.objectStore("events").put({
        id: "free-event",
        storyId: "fixture-story",
        seq: 1,
        round: 1,
        kind: "novel",
        speaker: "",
        participants: [],
        input: "递伞",
        text,
        facts: [],
        versions: [
          { id: "free-v1", text, input: "递伞", facts: [], created: 1 },
        ],
        versionId: "free-v1",
        status: "complete",
        raw: "",
        error: "",
        review: false,
        deleted: false,
        created: 1,
        theater: {
          id: "free-record",
          sourceVersionId: "free-v1",
          status: "complete",
        },
      });
      const presets = [
        {
          id: "theater-audience",
          name: "第四面墙",
          prompt: "讨论这一回合",
          presentation: "forum",
        },
        {
          id: "my-letter",
          name: "未寄出的纸条",
          prompt: "一张可以拆开的纸条",
          presentation: "custom",
        },
      ];
      tx.objectStore("theaters").put({
        id: "free-record",
        storyId: "fixture-story",
        eventId: "free-event",
        sourceVersionId: "free-v1",
        presets,
        html: content + customHtml,
        htmlPages: [
          { id: presets[0].id, title: presets[0].name, html: content },
          { id: presets[1].id, title: presets[1].name, html: customHtml },
        ],
        text: "MOCK",
        raw: "",
        status: "complete",
        error: "",
        created: 1,
        updated: 1,
      });
      tx.objectStore("profiles").put({
        id: "free-model",
        name: "MOCK",
        protocol: "chat",
        url: "https://free.fixture.test/v1",
        model: "fixture",
        stream: false,
        context: 64000,
        maxOutput: 4096,
        timeout: 20,
        remember: true,
        key: "fixture-key",
      });
      tx.objectStore("preferences").put({
        id: "preferences",
        activeProfile: "free-model",
        developer: false,
        prompts: {},
        theaterPresets: [presets[1]],
      });
      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
      db.close();
    },
    { content, customHtml },
  );
  await page.goto(appPath + "#story/fixture-story");
  await expect(page.locator(".prose-event")).toHaveCount(1);
}
const inner = (page: Page, id = "theater-audience") =>
  page
    .frameLocator(`iframe.theater-html-frame[data-page-id="${id}"]`)
    .frameLocator("iframe");

test("free HTML retains its own design and scripts, persists local state, and does not call AI on load or reopen", async ({
  page,
}) => {
  await seed(page);
  let calls = 0;
  await page.route("https://free.fixture.test/**", async (route) => {
    calls++;
    await route.abort();
  });
  await expect(page.locator("iframe")).toHaveCount(0);
  await page.locator(".theater-toggle").click();
  await expect(page.getByLabel("清晰阅读", { exact: true })).not.toBeChecked();
  const body = inner(page);
  await expect(
    body.getByText("MOCK · 观众的夜间论坛", { exact: true }),
  ).toBeVisible();
  await expect(body.locator("body")).toHaveAttribute("data-autoblocked", "yes");
  await expect(body.locator("body")).toHaveAttribute("data-opaque", "yes");
  expect(
    await body
      .locator("body")
      .evaluate((el) => getComputedStyle(el).backgroundColor),
  ).toBe("rgb(20, 44, 60)");
  await body.getByRole("button", { name: "我也注意到了", exact: true }).click();
  await expect(body.getByText("本地标记 1", { exact: true })).toBeVisible();
  await expect
    .poll(
      async () =>
        (await readStore(page, "theaters"))[0].htmlStates?.["theater-audience"]
          ?.n,
    )
    .toBe(1);
  await inner(page, "my-letter").getByText("拆开信封", { exact: true }).click();
  await expect(
    inner(page, "my-letter").getByText("这次先把伞接住。", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "收起小剧场", exact: true }).click();
  await expect(page.locator("iframe")).toHaveCount(0);
  await page.locator(".theater-toggle").click();
  await expect(
    inner(page).getByText("本地标记 1", { exact: true }),
  ).toBeVisible();
  await page.reload();
  await page.locator(".theater-toggle").click();
  await expect(
    inner(page).getByText("本地标记 1", { exact: true }),
  ).toBeVisible();
  expect(calls).toBe(0);
});

test("a real AI click updates only its own page and preserves the prior HTML", async ({
  page,
}) => {
  await seed(page);
  let calls = 0;
  await page.route("https://free.fixture.test/**", async (route) => {
    calls++;
    await route.fulfill({
      json: {
        choices: [
          {
            message: {
              content: JSON.stringify({
                theater: {
                  version: 2,
                  sections: [
                    {
                      id: "theater-audience",
                      title: "第四面墙",
                      html: "<h2>MOCK 新的楼层</h2><p>观众接住了这句话。</p>",
                    },
                  ],
                },
              }),
            },
            finish_reason: "stop",
          },
        ],
      },
    });
  });
  await page.locator(".theater-toggle").click();
  await expect(
    inner(page).getByRole("button", { name: "让观众接着聊 · AI" }),
  ).toBeVisible();
  await inner(page).getByRole("button", { name: "让观众接着聊 · AI" }).click();
  await expect(
    inner(page).getByText("MOCK 新的楼层", { exact: true }),
  ).toBeVisible();
  expect(calls).toBe(1);
  const record = (await readStore(page, "theaters"))[0];
  expect(record.htmlPages[1].html).toBe(customHtml);
  expect(record.htmlHistory[0].html).toBe(html);
  expect((await readStore(page, "events"))[0].text).not.toContain("观众接住");
  expect(await readStore(page, "memories")).toHaveLength(0);
});

test("sandbox blocks parent access, storage, external requests, forged bridges and self navigation", async ({
  page,
}) => {
  const forbidden: string[] = [];
  const failures: string[] = [];
  page.on("request", (r) => {
    if (
      r.url().includes("blocked.fixture.test") ||
      r.url().includes("escape-fixture") ||
      r.url().includes("free.fixture.test")
    )
      forbidden.push(r.url());
  });
  let networkAttempts = 0;
  page.on("requestfailed", (r) => {
    if (r.url().includes("blocked.fixture.test"))
      failures.push(r.failure()?.errorText || "");
  });
  await page.route("**/*blocked.fixture.test/**", (route) => {
    networkAttempts++;
    return route.abort();
  });
  await page.route("**/*escape-fixture*", (route) => {
    networkAttempts++;
    return route.abort();
  });
  const attack = `<h2>隔离验证</h2><p id="result"></p><button id="navigate">尝试跳转</button><script>
    let denied=0;try{parent.document.body.innerHTML='bad'}catch(e){denied++}try{localStorage.setItem('x','bad')}catch(e){denied++}
    fetch('https://blocked.fixture.test/fetch').catch(()=>{});const img=new Image();img.src='https://blocked.fixture.test/image';document.body.append(img);
    parent.parent.postMessage({type:'generate',id:1,value:'伪造请求'},'*');cijian.generate('自动请求').catch(()=>{});
    const fake=new MessageChannel();parent.postMessage({type:'cijian-content-port',token:'forged'},'*',[fake.port2]);fake.port1.postMessage({type:'generate',id:1,value:'伪造端口'});
    const synthetic=document.createElement('button');synthetic.onclick=()=>cijian.generate('合成点击').catch(()=>{});document.body.append(synthetic);synthetic.click();
    document.getElementById('result').textContent='已阻止 '+denied;document.getElementById('navigate').onclick=()=>{location.href='https://blocked.fixture.test/navigation'};
    </script>`;
  await seed(page, attack);
  await page.locator(".theater-toggle").click();
  await expect(
    inner(page).getByText("已阻止 2", { exact: true }),
  ).toBeVisible();
  await inner(page).getByRole("button", { name: "尝试跳转" }).click();
  await expect(page.locator(".prose-event .event-text")).toContainText("周屿");
  expect(networkAttempts).toBe(0);
  expect(forbidden.filter((url) => url.includes("free.fixture.test"))).toEqual(
    [],
  );
  expect(failures).toEqual(
    failures.map(() => expect.stringMatching(/CSP|ERR_BLOCKED_BY|ERR_FAILED/i)),
  );
});

for (const size of [
  { name: "desktop", width: 1440, height: 1000 },
  { name: "mobile", width: 390, height: 844 },
  { name: "landscape", width: 844, height: 390 },
]) {
  test(`free HTML ${size.name} layout and fallback reading`, async ({
    page,
  }) => {
    await page.setViewportSize(size);
    await seed(page);
    await page.getByRole("button", { name: "沉浸阅读", exact: true }).click();
    await page.locator(".theater-toggle").click();
    await expect(
      inner(page).getByText("MOCK · 观众的夜间论坛", { exact: true }),
    ).toBeVisible();
    await expect
      .poll(() =>
        page
          .locator(".theater-html-frame")
          .first()
          .evaluate((el) => el.getBoundingClientRect().height),
      )
      .toBeGreaterThan(200);
    await expect(
      inner(page, "my-letter").getByText("MOCK · 未寄出的纸条", {
        exact: true,
      }),
    ).toBeVisible();
    await expect
      .poll(() =>
        page
          .locator(".theater-html-frame")
          .last()
          .evaluate((el) => el.getBoundingClientRect().height),
      )
      .not.toBe(180);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    const forumBox = await inner(page)
      .getByRole("button", { name: "我也注意到了", exact: true })
      .boundingBox();
    await page.evaluate(
      (top) => window.scrollBy({ top, behavior: "instant" }),
      forumBox!.y - size.height / 3,
    );
    await page.screenshot({
      path: `${capture}/${size.name}-viewport-forum.png`,
    });
    const previousHeight = await page
      .locator(".theater-html-frame")
      .last()
      .evaluate((el) => el.getBoundingClientRect().height);
    const envelope = inner(page, "my-letter").getByText("拆开信封", {
      exact: true,
    });
    const letterBox = await envelope.boundingBox();
    await page.evaluate(
      (top) => window.scrollBy({ top, behavior: "instant" }),
      letterBox!.y - size.height / 3,
    );
    await envelope.press("Enter");
    await expect(
      inner(page, "my-letter").getByText("这次先把伞接住。", { exact: true }),
    ).toBeVisible();
    await expect
      .poll(() =>
        page
          .locator(".theater-html-frame")
          .last()
          .evaluate((el) => el.getBoundingClientRect().height),
      )
      .toBeGreaterThan(previousHeight);
    await page.screenshot({
      path: `${capture}/${size.name}-viewport-letter.png`,
    });
    // Chromium can omit offscreen opaque child-frame surfaces in fullPage captures.
    // Keep the tested width and expose the complete document for this overview.
    const captureHeight = await page.evaluate(
      () => document.documentElement.scrollHeight,
    );
    await page.setViewportSize({
      width: size.width,
      height: Math.min(6000, captureHeight + 100),
    });
    await page.evaluate(() => window.scrollTo(0, 0));
    await inner(page, "my-letter")
      .locator("body")
      .evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          ),
      );
    await page.screenshot({
      path: `${capture}/${size.name}-full.png`,
      fullPage: true,
    });
    await page.locator(".theater-panel").screenshot({
      path: `${capture}/${size.name}-detail.png`,
      style: ".story-reader-controls{visibility:hidden!important}",
    });
    await page.setViewportSize(size);
    await page.getByLabel("清晰阅读", { exact: true }).check();
    await expect(page.locator(".theater-html-frame")).toHaveCount(0);
    await expect(
      page
        .frameLocator(".theater-frame")
        .first()
        .getByText("MOCK · 观众的夜间论坛", { exact: true }),
    ).toBeVisible();
  });
}
