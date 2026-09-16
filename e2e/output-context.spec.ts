import { test, expect, type Page } from "@playwright/test";
import { readStore, seedJourney } from "./fixtures";

async function seed(page: Page, rounds = 0) {
  await seedJourney(page);
  await page.evaluate(async (rounds) => {
    const open = indexedDB.open("little-scene-v1");
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
    const tx = database.transaction(
      ["stories", "profiles", "preferences", "events"],
      "readwrite",
    );
    const request = tx.objectStore("stories").get("fixture-story");
    request.onsuccess = () =>
      tx.objectStore("stories").put({
        ...request.result,
        autoMemory: false,
        inspiration: { options: [], sources: [], created: 1 },
      });
    tx.objectStore("profiles").put({
      id: "output-profile",
      name: "格式测试接口",
      protocol: "chat",
      url: "https://output.fixture.test/v1",
      model: "fixture-model",
      stream: false,
      context: 32000,
      maxOutput: 2048,
      timeout: 30,
      remember: true,
      key: "isolated-output-fixture-key",
    });
    tx.objectStore("preferences").put({
      id: "preferences",
      activeProfile: "output-profile",
      developer: false,
      prompts: {},
    });
    for (let seq = 1; seq <= rounds; seq++)
      tx.objectStore("events").put({
        id: "past-" + seq,
        storyId: "fixture-story",
        seq,
        kind: "novel",
        speaker: "",
        participants: [],
        input: "递伞",
        text: `过去正文${seq}。`,
        facts: [],
        versions: [
          {
            id: "v-" + seq,
            text: `过去正文${seq}。`,
            input: "递伞",
            facts: [],
            created: seq,
          },
        ],
        versionId: "v-" + seq,
        status: "complete",
        raw: "",
        error: "",
        review: false,
        deleted: false,
        created: seq,
      });
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    database.close();
  }, rounds);
  await page.goto("/#story/fixture-story");
}

for (const mobile of [false, true])
  test(`${mobile ? "mobile" : "desktop"} malformed prose stays editable until explicit author consent`, async ({
    page,
  }) => {
    if (mobile) await page.setViewportSize({ width: 390, height: 844 });
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await seed(page);
    const requests: any[] = [];
    await page.route("https://output.fixture.test/**", async (route) => {
      requests.push(route.request().postDataJSON());
      await route.fulfill({
        json: {
          choices: [
            {
              message: {
                content:
                  requests.length === 1
                    ? "莫先生站在门边。"
                    : '{"text":"他转过身。","facts":[]}',
              },
              finish_reason: "stop",
            },
          ],
        },
      });
    });
    await page.getByRole("button", { name: "扩写这一刻", exact: true }).click();
    await expect(page.locator(".prose-event .event-text")).toHaveText(
      "莫先生站在门边。",
    );
    await expect(page.getByText("文字正在路上…", { exact: true })).toHaveCount(
      0,
    );
    await page.getByRole("button", { name: "检查并采用", exact: true }).click();
    let dialog = page.getByRole("dialog", { name: "检查草稿并采用" });
    await expect(dialog.getByLabel("准备采用的正文")).toHaveValue(
      "莫先生站在门边。",
    );
    await expect(dialog.getByText("「拿着」", { exact: true })).toHaveCount(0);
    await dialog.getByRole("button", { name: "先保留草稿" }).click();
    expect((await readStore(page, "events"))[0].status).toBe("draft");
    await page.getByRole("button", { name: "检查并采用", exact: true }).click();
    dialog = page.getByRole("dialog", { name: "检查草稿并采用" });
    await dialog.getByLabel("准备采用的正文").fill("");
    await expect(
      dialog.getByRole("button", { name: "我同意，采用为正文" }),
    ).toBeDisabled();
    await dialog
      .getByLabel("准备采用的正文")
      .fill("莫先生站在门边，把伞靠在墙上。");
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await dialog.getByRole("button", { name: "我同意，采用为正文" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByText("作者确认采用", { exact: true })).toBeVisible();
    expect(requests).toHaveLength(1);
    const accepted = (await readStore(page, "events"))[0];
    expect(accepted.status).toBe("complete");
    expect(accepted.versions).toHaveLength(1);
    expect((await readStore(page, "stories"))[0].inspiration).toBeUndefined();
    await page.reload();
    await expect(page.locator(".prose-event .event-text")).toHaveText(
      "莫先生站在门边，把伞靠在墙上。",
    );
    await page.getByRole("button", { name: "折叠本段", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "展开本段", exact: true }),
    ).toBeVisible();
    await page.locator(".composer textarea").fill("他转过身。");
    await page.getByRole("button", { name: "扩写这一刻", exact: true }).click();
    await expect(page.locator(".prose-event")).toHaveCount(2);
    await expect(page.locator(".prose-event .event-text").last()).toHaveText(
      "他转过身。",
    );
    expect(requests).toHaveLength(2);
    expect(requests[1].messages[1].content).toContain(
      "莫先生站在门边，把伞靠在墙上。",
    );
    expect(errors).toEqual([]);
  });

test("dialogue changes save directly by default and format controls persist", async ({
  page,
}) => {
  await seed(page);
  await page.goto("/#settings");
  await page.getByRole("button", { name: "配置", exact: true }).click();
  await page.getByText("高级设置", { exact: true }).click();
  await page
    .getByRole("combobox", { name: "输出格式", exact: true })
    .selectOption("json");
  await page
    .getByRole("combobox", { name: "多轮前缀复用", exact: true })
    .selectOption("off");
  await page.getByRole("button", { name: "保存并选用", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "模型接口" })).toHaveCount(0);
  await page.reload();
  expect((await readStore(page, "profiles"))[0]).toMatchObject({
    outputMode: "json",
    prefixReuse: "off",
  });
  let calls = 0;
  await page.route("https://output.fixture.test/**", async (route) => {
    calls++;
    expect(route.request().postDataJSON().response_format).toEqual({
      type: "json_object",
    });
    await route.fulfill({
      json: {
        choices: [
          {
            message: { content: '{"text":"他说“收下吧”。","facts":[]}' },
            finish_reason: "stop",
          },
        ],
      },
    });
  });
  await page.goto("/#story/fixture-story");
  await page.getByRole("button", { name: "扩写这一刻", exact: true }).click();
  await expect(page.locator(".prose-event .event-text")).toHaveText("他说“收下吧”。");
  await expect(page.getByRole("button", { name: "检查并采用", exact: true })).toHaveCount(0);
  await expect(page.locator(".prose-event .error")).toHaveCount(0);
  expect((await readStore(page, "events"))[0].status).toBe("complete");
  expect(calls).toBe(1);
});

test("an open reference window receives final usage after generation completes", async ({
  page,
}) => {
  await seed(page);
  await page.goto("/#settings");
  await page.getByRole("checkbox", { name: "显示内部提示词编辑器" }).check();
  await page.goto("/#story/fixture-story");
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("https://output.fixture.test/**", async (route) => {
    await held;
    await route.fulfill({
      json: {
        choices: [
          {
            message: { content: '{"text":"他说“拿着”。","facts":[]}' },
            finish_reason: "stop",
          },
        ],
        usage: {
          prompt_tokens: 100,
          completion_tokens: 10,
          prompt_tokens_details: { cached_tokens: 60 },
        },
      },
    });
  });
  await page.getByRole("button", { name: "扩写这一刻", exact: true }).click();
  await page
    .locator(".prose-event")
    .getByRole("button", { name: "参考内容", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("缓存命中 服务未返回");
  release();
  await expect(dialog).toContainText("缓存命中 60 token");
  await expect(dialog).toContainText("命中率 60.0%");
  expect((await readStore(page, "events"))[0].status).toBe("complete");
});

test("seven-round default and configurable history remain independent of inspiration and expose actual cache usage", async ({
  page,
}) => {
  await seed(page, 9);
  await page
    .locator(".story-toolbar")
    .getByRole("button", { name: "本次参考内容", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toContainText("正文窗口 7 / 7 回合");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "关闭", exact: true })
    .click();
  await page.goto("/#settings");
  await page.getByRole("checkbox", { name: "显示内部提示词编辑器" }).check();
  await expect(page.getByLabel("正文参考回合数", { exact: true })).toHaveValue(
    "7",
  );
  await expect(
    page.getByLabel("灵感小助手参考正文段数", { exact: true }),
  ).toHaveValue("3");
  await page.getByLabel("正文参考回合数", { exact: true }).fill("2");
  await page.getByRole("checkbox", { name: "显示内部提示词编辑器" }).uncheck();
  await page.reload();
  expect((await readStore(page, "preferences"))[0].novelContextRounds).toBe(2);
  await page.getByRole("checkbox", { name: "显示内部提示词编辑器" }).check();
  await page.goto("/#story/fixture-story");
  await page.route("https://output.fixture.test/**", async (route) => {
    const input = route.request().postDataJSON().messages[1].content;
    expect(input).not.toContain("过去正文7。");
    expect(input.indexOf("过去正文8。")).toBeLessThan(
      input.indexOf("过去正文9。"),
    );
    expect(input.indexOf("【世界书")).toBeLessThan(input.indexOf("【角色名单"));
    await route.fulfill({
      json: {
        choices: [
          {
            message: { content: '{"text":"他递伞，说“拿着”。","facts":[]}' },
            finish_reason: "stop",
          },
        ],
        usage: {
          prompt_tokens: 200,
          completion_tokens: 30,
          prompt_tokens_details: { cached_tokens: 100 },
        },
      },
    });
  });
  await page.getByRole("button", { name: "扩写这一刻", exact: true }).click();
  await expect(page.locator(".prose-event")).toHaveCount(10);
  const latest = page.locator(".prose-event").last();
  await expect(
    latest.getByRole("button", { name: "折叠本段", exact: true }),
  ).toBeVisible();
  await latest.getByRole("button", { name: "参考内容", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("正文窗口 2 / 2 回合");
  await expect(dialog).toContainText("缓存命中 100 token");
  await expect(dialog).toContainText("命中率 50.0%");
  await expect(dialog).toContainText("缓存写入 服务未返回");
});
