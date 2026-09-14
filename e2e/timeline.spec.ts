import { expect, test, type Page } from "@playwright/test";
import { seedJourney, readStore } from "./fixtures";

async function seed(page: Page) {
  await seedJourney(page);
  await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve) => { const open = indexedDB.open("little-scene-v1"); open.onsuccess = () => resolve(open.result); });
    const tx = db.transaction(["stories", "events", "profiles", "preferences"], "readwrite");
    const request = tx.objectStore("stories").get("fixture-story");
    request.onsuccess = () => {
      const s = request.result;
      s.draft = "周屿把伞递给许知，说“拿着”。";
      tx.objectStore("stories").put(s);
      for (let seq = 1; seq <= 32; seq++) {
        const text = seq === 1 ? "雾岚岛的船票已经放在蓝色抽屉。" : seq === 2 ? "PRIVATE_SECRET_HIDDEN" : `旧正文第${seq}段，他们在书店整理书架。`;
        tx.objectStore("events").put({ id: "old-" + seq, storyId: s.id, seq, kind: "novel", speaker: "", participants: s.roles.map((r: any) => r.id),
          input: text, text, facts: [], versions: [{ id: "v-" + seq, text, input: text, facts: [], created: seq }],
          versionId: "v-" + seq, status: "complete", raw: "", error: "", review: seq > 10, deleted: false, created: seq,
          ...(seq === 2 ? { visibility: "author" } : {}) });
      }
    };
    tx.objectStore("profiles").put({ id: "timeline-model", name: "fixture", protocol: "chat", url: "https://timeline.fixture.test/v1", model: "fixture",
      stream: false, context: 20000, maxOutput: 2000, timeout: 10, remember: true, key: "fixture-key" });
    tx.objectStore("preferences").put({ id: "preferences", activeProfile: "timeline-model", developer: false, prompts: {} });
    await new Promise<void>((resolve) => { tx.oncomplete = () => resolve(); }); db.close();
  });
  await page.goto("/#story/fixture-story");
  await page.reload();
}

for (const mobile of [false, true]) test(`shared timeline carries old prose into batched chat and back (${mobile ? "mobile" : "desktop"})`, async ({ page }) => {
  if (mobile) await page.setViewportSize({ width: 390, height: 844 });
  const errors: string[] = []; page.on("pageerror", (e) => errors.push(e.message));
  await seed(page);
  await page.getByRole("button", { name: "整本启用自动互通", exact: true }).click();
  await expect(page.getByRole("button", { name: "整本启用自动互通", exact: true })).toHaveCount(0);
  await expect.poll(async () => (await readStore(page, "memories")).length).toBe(32);
  const requests: any[] = [];
  await page.route("https://timeline.fixture.test/**", async (route) => {
    const body = route.request().postDataJSON(); requests.push(body);
    const data = body.messages[0].content.includes('"messages"')
      ? { messages: ["船票在蓝色抽屉。", "下午一起出发。"] }
      : { text: "周屿把伞递过来，说“收下吧”。", facts: "malformed optional facts" };
    await route.fulfill({ json: { choices: [{ message: { content: JSON.stringify(data) }, finish_reason: "stop" }] } });
  });
  await page.getByRole("button", { name: "手机聊天", exact: true }).click();
  await page.getByLabel("聊天消息").fill("雾岚岛的船票放哪了？");
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  await page.getByLabel("聊天消息").fill("顺便说下，上午没空，下午出发吧。");
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  await page.getByRole("button", { name: "让 TA 回复（2）", exact: true }).click();
  await expect(page.locator(".message-event.theirs")).toHaveCount(2);
  expect(requests).toHaveLength(1);
  expect(requests[0].messages[1].content).toContain("雾岚岛的船票已经放在蓝色抽屉。");
  expect(requests[0].messages[1].content).toContain("旧正文第32段");
  expect(requests[0].messages[1].content).not.toContain("PRIVATE_SECRET_HIDDEN");
  await page.screenshot({ path: `work/timeline-${mobile ? "mobile" : "desktop"}.png`, fullPage: false });
  await page.getByRole("button", { name: "正文", exact: true }).click();
  await page.getByRole("button", { name: "扩写这一刻", exact: true }).click();
  await expect(page.locator(".prose-event").last().locator(".event-text")).toHaveText("周屿把伞递过来，说“收下吧”。");
  await expect(page.getByRole("button", { name: "检查并采用", exact: true })).toHaveCount(0);
  expect(requests).toHaveLength(2);
  const proseRequest = requests[1].messages[1].content;
  expect(proseRequest.indexOf("旧正文第32段")).toBeLessThan(proseRequest.indexOf("船票在蓝色抽屉。"));
  expect(proseRequest).toContain("下午一起出发。");
  expect((await readStore(page, "events")).filter((e) => e.status === "draft")).toHaveLength(0);
  expect(errors).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.reload();
  expect((await readStore(page, "stories"))[0].timelineMode).toBe("shared");
});

test("optional dialogue advice and paragraph privacy controls persist without invalidating later prose", async ({ page }) => {
  await seed(page);
  await page.getByRole("button", { name: "整本启用自动互通", exact: true }).click();
  await expect(page.getByRole("button", { name: "整本启用自动互通", exact: true })).toHaveCount(0);
  const before = (await readStore(page, "events")).find((e) => e.id === "old-3");
  await page.locator(".prose-event").first().getByRole("button", { name: "编辑", exact: true }).click();
  await page.getByLabel("本段如何进入手机聊天").selectOption("author");
  await page.getByRole("button", { name: "保存新版本", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "修改这一刻" })).toHaveCount(0);
  expect((await readStore(page, "events")).find((e) => e.id === "old-3").review).toBe(before.review);
  expect((await readStore(page, "events")).find((e) => e.id === "old-1").visibility).toBe("author");
  await page.goto("/#settings");
  await page.getByRole("checkbox", { name: "显示内部提示词编辑器" }).check();
  await page.getByRole("checkbox", { name: "台词检查（只提醒，不拦截）" }).check();
  await page.reload();
  await expect(page.getByRole("checkbox", { name: "台词检查（只提醒，不拦截）" })).toBeChecked();
  await page.route("https://timeline.fixture.test/**", (route) => route.fulfill({ json: {
    choices: [{ message: { content: '{"text":"他说“收下吧”。","facts":[]}' }, finish_reason: "stop" }],
  } }));
  await page.goto("/#story/fixture-story");
  await page.getByRole("button", { name: "扩写这一刻", exact: true }).click();
  await expect(page.getByText("可选检查提醒 · 正文已保存", { exact: true })).toBeVisible();
  await page.getByText("可选检查提醒 · 正文已保存", { exact: true }).click();
  await expect(page.getByText("台词用字可能有调整，仅供参考：", { exact: false })).toBeVisible();
  await expect(page.getByRole("button", { name: "检查并采用", exact: true })).toHaveCount(0);
});
