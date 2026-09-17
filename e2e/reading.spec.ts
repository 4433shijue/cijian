import { test, expect, type Page } from "@playwright/test";
import { readStore, seedJourney } from "./fixtures";

async function seed(page: Page) {
  await seedJourney(page);
  await page.evaluate(async () => {
    const open = indexedDB.open("little-scene-v1");
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
    const tx = database.transaction(
      ["stories", "events", "profiles", "preferences"],
      "readwrite",
    );
    const story = tx.objectStore("stories").get("fixture-story");
    story.onsuccess = () =>
      tx
        .objectStore("stories")
        .put({ ...story.result, timelineMode: "shared" });
    for (let seq = 1; seq <= 8; seq++) {
      const text =
        `第${seq}段，风吹过书店。\n` +
        "他们把窗边的书整理好，等雨停下来。\n".repeat(6);
      tx.objectStore("events").put({
        id: "reading-" + seq,
        storyId: "fixture-story",
        seq,
        kind: "novel",
        speaker: "",
        participants: ["fixture-role-a", "fixture-role-b"],
        input: "放下书",
        text,
        facts: [],
        versions: [
          {
            id: "reading-v" + seq,
            text,
            input: "放下书",
            facts: [],
            created: seq,
          },
        ],
        versionId: "reading-v" + seq,
        status: "complete",
        raw: "",
        error: "",
        review: false,
        deleted: false,
        created: seq,
        collapsed: seq === 2,
      });
    }
    tx.objectStore("profiles").put({
      id: "reading",
      name: "阅读测试",
      protocol: "chat",
      url: "https://reading.fixture.test/v1",
      model: "deepseek-fixture",
      stream: false,
      context: 20000,
      maxOutput: 2048,
      timeout: 10,
      remember: true,
      key: "fixture-key",
    });
    tx.objectStore("preferences").put({
      id: "preferences",
      activeProfile: "reading",
      developer: false,
      prompts: {},
    });
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    database.close();
  });
  await page.goto("/#story/fixture-story");
}

for (const mobile of [false, true])
  test(`${mobile ? "mobile" : "desktop"} reading controls reach both ends and restore folds and drafts`, async ({
    page,
  }) => {
    if (mobile) await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await seed(page);
    const sourceVersions = (await readStore(page, "events")).map(
      (e) => e.versionId,
    );
    await page
      .getByLabel("本段动作或台词")
      .fill("还没写完的输入，收起后保留。");
    await page
      .getByRole("button", { name: "回到故事顶部", exact: true })
      .click();
    await expect
      .poll(() => page.evaluate(() => window.scrollY))
      .toBeLessThan(40);
    await page
      .getByRole("button", { name: "回到故事底部", exact: true })
      .click();
    await expect
      .poll(async () => {
        const last = await page
          .locator(".prose-event .event-text")
          .last()
          .boundingBox();
        const composer = await page.locator(".composer").boundingBox();
        return last && composer && last.y + last.height <= composer.y;
      })
      .toBeTruthy();
    const editorHeight = (await page.locator(".composer").boundingBox())!
      .height;
    await page.getByRole("button", { name: "收起输入框", exact: true }).click();
    await expect(page.getByLabel("本段动作或台词")).toBeHidden();
    expect(
      (await page.locator(".composer").boundingBox())!.height,
    ).toBeLessThan(editorHeight / 2);
    await page
      .getByRole("button", { name: "回到故事顶部", exact: true })
      .click();
    await page.getByRole("button", { name: "收起功能栏", exact: true }).click();
    await expect(page.locator("#story-tools")).toBeHidden();
    await page.reload();
    await expect(
      page.getByRole("button", { name: "展开功能栏", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "展开输入框", exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "沉浸阅读", exact: true }).click();
    await expect(page.locator(".sidebar")).toBeHidden();
    await expect(page.locator(".composer")).toBeHidden();
    await expect(
      page.locator(".prose-event").nth(1).locator(".event-text"),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "展开本段" })).toHaveCount(0);
    expect((await readStore(page, "events"))[1].collapsed).toBe(true);
    await page
      .getByRole("button", { name: "回到故事底部", exact: true })
      .click();
    await expect
      .poll(async () => {
        const last = await page
          .locator(".prose-event .event-text")
          .last()
          .boundingBox();
        const controls = await page
          .locator(".story-reader-controls")
          .boundingBox();
        return last && controls && last.y + last.height <= controls.y;
      })
      .toBeTruthy();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: `work/reading-${mobile ? "mobile" : "desktop"}.png`,
    });
    await page.keyboard.press("Escape");
    await expect(page.locator(".sidebar")).toBeVisible();
    await expect(page.locator("#story-tools")).toBeHidden();
    await expect(
      page.locator(".prose-event").nth(1).locator(".event-text"),
    ).toBeHidden();
    await page.getByRole("button", { name: "展开输入框", exact: true }).click();
    await expect(page.getByLabel("本段动作或台词")).toHaveValue(
      "还没写完的输入，收起后保留。",
    );
    await page
      .getByRole("button", { name: "回到故事顶部", exact: true })
      .click();
    await page.getByRole("button", { name: "展开功能栏", exact: true }).click();
    await page.getByRole("button", { name: "手机聊天", exact: true }).click();
    await page.getByLabel("聊天消息").fill("手机消息也还没发出去。");
    await page.getByRole("button", { name: "收起输入框", exact: true }).click();
    await page.getByRole("button", { name: "沉浸阅读", exact: true }).click();
    await page.getByRole("button", { name: "退出阅读", exact: true }).click();
    await page.getByRole("button", { name: "展开输入框", exact: true }).click();
    await expect(page.getByLabel("聊天消息")).toHaveValue(
      "手机消息也还没发出去。",
    );
    expect((await readStore(page, "events")).map((e) => e.versionId)).toEqual(
      sourceVersions,
    );
    expect(errors).toEqual([]);
  });

test("only successful new prose folds earlier prose, and a rewrite stays expanded", async ({
  page,
}) => {
  await seed(page);
  let fail = true;
  const requests: any[] = [];
  await page.route("https://reading.fixture.test/**", async (route) => {
    requests.push(route.request().postDataJSON());
    await route.fulfill({
      json: {
        choices: [
          {
            message: {
              content: fail ? '{"text":' : '{"text":"新一段正文。","facts":[]}',
            },
            finish_reason: "stop",
          },
        ],
      },
    });
  });
  await page.getByLabel("本段动作或台词").fill("他放下书。");
  await page.getByRole("button", { name: "扩写这一刻", exact: true }).click();
  await expect(page.locator(".prose-event").last()).toContainText("未完成草稿");
  expect(
    (await readStore(page, "events")).filter((e) => e.collapsed),
  ).toHaveLength(1);
  await expect(
    page.getByRole("button", { name: "扩写这一刻", exact: true }),
  ).toBeVisible();
  fail = false;
  const versions = (await readStore(page, "events"))
    .filter((e) => e.id.startsWith("reading-"))
    .map((e) => e.versionId);
  await page.getByRole("button", { name: "扩写这一刻", exact: true }).click();
  await expect(
    page.locator(".prose-event").last().locator(".event-text"),
  ).toHaveText("新一段正文。");
  await expect(
    page.getByRole("button", { name: "展开本段", exact: true }),
  ).toHaveCount(8);
  await expect(
    page.locator(".prose-event").last().locator(".event-text"),
  ).toBeVisible();
  const stored = await readStore(page, "events");
  expect(
    stored.filter((e) => e.id.startsWith("reading-")).map((e) => e.versionId),
  ).toEqual(versions);
  expect(stored.find((e) => e.status === "draft")?.collapsed).not.toBe(true);
  await page.reload();
  await expect(
    page.getByRole("button", { name: "展开本段", exact: true }),
  ).toHaveCount(8);
  const first = page.locator(".prose-event").first();
  await first.getByRole("button", { name: "展开本段", exact: true }).click();
  await first.getByRole("button", { name: "重写", exact: true }).click();
  await expect(first.locator(".event-text")).toHaveText("新一段正文。");
  await expect(first.locator(".event-text")).toBeVisible();
  await expect(
    page.locator(".prose-event").last().locator(".event-text"),
  ).toBeVisible();
  expect(requests).toHaveLength(3);
});

test("collapsed and immersive controls keep cancellation available while receiving", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await seed(page);
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("https://reading.fixture.test/**", async (route) => {
    await held;
    await route
      .fulfill({
        json: {
          choices: [
            {
              message: { content: '{"text":"迟到的正文"}' },
              finish_reason: "stop",
            },
          ],
        },
      })
      .catch(() => {});
  });
  await page.getByRole("button", { name: "扩写这一刻", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "停止生成", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "收起输入框", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "停止生成", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "沉浸阅读", exact: true }).click();
  await page.getByRole("button", { name: "停止生成", exact: true }).click();
  release();
  await expect(
    page.getByRole("button", { name: "停止生成", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "退出阅读", exact: true }).click();
  expect(
    (await readStore(page, "events")).filter((e) => e.collapsed),
  ).toHaveLength(1);
  await expect(page.locator(".prose-event").last()).toContainText("未完成草稿");
});
