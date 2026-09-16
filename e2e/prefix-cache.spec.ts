import { test, expect, type Page } from "@playwright/test";
import { seedJourney, readStore } from "./fixtures";

async function seedDeepSeek(page: Page) {
  await seedJourney(page);
  await page.evaluate(async () => {
    const open = indexedDB.open("little-scene-v1");
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
    const tx = database.transaction(
      ["stories", "profiles", "preferences"],
      "readwrite",
    );
    const story = tx.objectStore("stories").get("fixture-story");
    story.onsuccess = () =>
      tx
        .objectStore("stories")
        .put({ ...story.result, timelineMode: "shared" });
    tx.objectStore("profiles").put({
      id: "ds",
      name: "DeepSeek 测试",
      protocol: "chat",
      url: "https://api.deepseek.com",
      model: "deepseek-chat",
      stream: true,
      context: 16000,
      maxOutput: 2048,
      timeout: 10,
      remember: true,
      key: "fixture-key",
    });
    tx.objectStore("preferences").put({
      id: "preferences",
      activeProfile: "ds",
      developer: true,
      novelContextRounds: 1,
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
  test(`${mobile ? "mobile" : "desktop"} DeepSeek preserves exact turns after refresh and reports server cache usage`, async ({
    page,
  }) => {
    if (mobile) await page.setViewportSize({ width: 390, height: 844 });
    const errors: string[] = [],
      requests: any[] = [],
      responses: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await seedDeepSeek(page);
    await page.route("https://api.deepseek.com/**", async (route) => {
      const body = route.request().postDataJSON();
      requests.push(body);
      expect(body.stream_options).toEqual({ include_usage: true });
      const raw = JSON.stringify(
        body.messages[0].content.includes('"messages"')
          ? { messages: ["第一条回复。", "第二条补充。"] }
          : { text: `第${requests.length}段，他把杯子放下。`, facts: [] },
      );
      responses.push(raw);
      await route.fulfill({
        contentType: "text/event-stream",
        body:
          `data: ${JSON.stringify({ choices: [{ delta: { content: raw }, finish_reason: "stop" }] })}\n\n` +
          `data: ${JSON.stringify({
            choices: [],
            usage: {
              prompt_tokens: 1000,
              completion_tokens: 50,
              prompt_cache_hit_tokens: 800,
              prompt_cache_miss_tokens: 200,
            },
          })}\n\ndata: [DONE]\n\n`,
      });
    });
    for (let n = 1; n <= 3; n++) {
      if (n === 2) await page.reload();
      await page.locator(".composer textarea").fill(`第${n}轮，他把杯子放下。`);
      await page
        .getByRole("button", { name: "扩写这一刻", exact: true })
        .click();
      await expect(page.locator(".prose-event .event-text")).toHaveCount(n);
      await expect(
        page.locator(".prose-event").last().locator(".event-text"),
      ).toHaveText(`第${n}段，他把杯子放下。`);
      if (n > 1)
        expect(requests[n - 1].messages.slice(0, -1)).toEqual([
          ...requests[n - 2].messages,
          { role: "assistant", content: responses[n - 2] },
        ]);
    }
    await page
      .locator(".prose-event")
      .last()
      .getByRole("button", { name: "参考内容", exact: true })
      .click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText("缓存命中 800 token · 命中率 80.0%");
    await expect(dialog).toContainText("缓存未命中 200 token");
    await expect(dialog).toContainText("已原样保留前轮请求与回复");
    await dialog.getByText("最终请求文本（不含密钥）", { exact: true }).click();
    await expect(dialog.locator("details").last()).toContainText(
      '"role": "assistant"',
    );
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: `work/cache-${mobile ? "mobile" : "desktop"}.png`,
    });
    await dialog.getByRole("button", { name: "关闭", exact: true }).click();
    await page.getByRole("button", { name: "手机聊天", exact: true }).click();
    for (let n = 1; n <= 2; n++) {
      for (const text of ["今天见面", `补充第${n}条`]) {
        await page.getByLabel("聊天消息").fill(text);
        await page
          .getByRole("button", { name: "发送消息", exact: true })
          .click();
        await expect(page.getByLabel("聊天消息")).toHaveValue("");
      }
      await page
        .getByRole("button", { name: "让 TA 回复（2）", exact: true })
        .click();
      await expect(page.locator(".message-event.theirs")).toHaveCount(n * 2);
    }
    expect(requests[3].messages).toHaveLength(2);
    expect(requests[4].messages.slice(0, -1)).toEqual([
      ...requests[3].messages,
      { role: "assistant", content: responses[3] },
    ]);
    expect(await readStore(page, "promptSessions")).toHaveLength(2);
    expect(errors).toEqual([]);
  });
