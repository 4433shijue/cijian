import { openPhoneChat } from "./fixtures";
import { test, expect, type Page } from "@playwright/test";
import { seedJourney, readStore } from "./fixtures";

async function openChat(page: Page) {
  await page.getByRole("link").filter({ hasText: "雨声未歇" }).click();
  await openPhoneChat(page);
}
async function configure(page: Page) {
  await page.getByRole("link", { name: "设置", exact: true }).click();
  await page.getByRole("button", { name: "添加接口" }).click();
  await page.getByLabel("接口 URL").fill("https://chat-fixture.test/v1");
  await page.getByLabel("API Key", { exact: true }).fill("fixture-key");
  await page.getByLabel("模型名", { exact: true }).fill("fixture");
  await page.getByRole("checkbox", { name: "记住此设备的 Key" }).check();
  await page.getByRole("button", { name: "保存并选用" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("link", { name: "故事", exact: true }).click();
  await openChat(page);
}
async function send(page: Page, text: string) {
  await page.getByLabel("手机消息内容", { exact: true }).fill(text);
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  await expect(page.getByLabel("手机消息内容", { exact: true })).toHaveValue("");
}
const payload = (raw: string) => JSON.stringify({
  choices: [{ message: { content: raw }, finish_reason: "stop" }],
});

test.beforeEach(async ({ page }) => { await seedJourney(page); });

test("three sends survive refresh, call once, and allow the next batch while receiving", async ({ page }) => {
  const errors: string[] = [], requests: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  let release!: () => void;
  const firstResponse = new Promise<void>((resolve) => { release = resolve; });
  await page.route("https://chat-fixture.test/**", async (route) => {
    requests.push(route.request().postDataJSON().messages[1].content);
    const first = requests.length === 1;
    if (first) await firstResponse;
    await route.fulfill({ contentType: "application/json", body: payload(JSON.stringify({
      messages: (first ? ["今天可以。", "六点去接你？"] : ["好，那就在书店等你。"]).map(text => ({ type: "text", text })),
    })) });
  });
  try {
  await configure(page);
  for (const text of ["明天一起吃饭吗", "啊不对，是今天", "我六点下班"]) await send(page, text);
  expect(requests).toHaveLength(0);
  await expect(page.locator(".phone-message.mine")).toHaveCount(3);
  await page.reload();
  await openPhoneChat(page);
  await page.getByRole("button", { name: "让 TA 回复", exact: true }).click();
  await expect.poll(() => requests.length).toBe(1);
  await expect(page.getByRole("status").filter({ hasText: "对方正在输入" })).toBeVisible();
  await send(page, "下一轮补充：在书店碰面");
  await expect(page.locator(".phone-message.theirs")).toHaveCount(0);
  for (const text of ["明天一起吃饭吗", "啊不对，是今天", "我六点下班"]) expect(requests[0]).toContain(text);
  expect(requests[0]).not.toContain("下一轮补充");
  release();
  await expect(page.locator(".phone-message.theirs .phone-bubble p")).toHaveText(["今天可以。", "六点去接你？"]);
  await expect(page.getByRole("button", { name: "让 TA 回复", exact: true })).toBeEnabled();
  await page.screenshot({ path: "work/chat-batches-desktop.png" });
  await page.getByRole("button", { name: "让 TA 回复", exact: true }).click();
  await expect(page.locator(".phone-message.theirs")).toHaveCount(3);
  expect(requests).toHaveLength(2);
  expect(requests[1]).toContain("下一轮补充：在书店碰面");
  expect(errors).toEqual([]);
  } finally { release(); }
});

test("failed batch survives reload and group regeneration changes bubble count without duplicates", async ({ page }) => {
  let calls = 0;
  const outputs = ['{"messages":', JSON.stringify({ messages: ["回复一", "回复二"].map(text => ({ type: "text", text })) }),
    JSON.stringify({ messages: ["新一", "新二", "新三"].map(text => ({ type: "text", text })) }), JSON.stringify({ messages: ["最后一句"].map(text => ({ type: "text", text })) })];
  await page.route("https://chat-fixture.test/**", async (route) => {
    await route.fulfill({ contentType: "application/json", body: payload(outputs[calls++]) });
  });
  await configure(page);
  await send(page, "我说完了");
  await page.getByRole("button", { name: "让 TA 回复", exact: true }).click();
  await expect(page.locator(".phone-runs")).toContainText("待继续");
  await expect(page.locator(".phone-message.theirs")).toHaveCount(0);
  await page.reload();
  await openPhoneChat(page);
  await page.getByRole("button", { name: "继续未完成角色", exact: true }).click();
  await expect(page.locator(".phone-message.theirs .phone-bubble p")).toHaveText(["回复一", "回复二"]);
  await page.locator(".phone-runs").evaluate(el => { (el as HTMLDetailsElement).open = true; });
  await expect(page.getByRole("button", { name: "重新生成本轮", exact: true })).toHaveCount(1);
  await page.getByRole("button", { name: "重新生成本轮", exact: true }).click();
  await expect(page.locator(".phone-message.theirs .phone-bubble p")).toHaveText(["新一", "新二", "新三"]);
  await page.locator(".phone-runs").evaluate(el => { (el as HTMLDetailsElement).open = true; });
  await page.getByRole("button", { name: "重新生成本轮", exact: true }).click();
  await expect(page.locator(".phone-message.theirs .phone-bubble p")).toHaveText(["最后一句"]);
  await expect(page.locator(".phone-message.mine")).toHaveCount(1);
  expect(calls).toBe(4);
  const batches = await readStore(page, "phoneRuns");
  expect(batches).toHaveLength(1);
  expect(batches[0].steps[0].outputIds).toHaveLength(1);
});

test("mobile can send without an API profile and keeps both directions separate", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openChat(page);
  await send(page, "第一条本地消息");
  await page.getByLabel("手机消息内容", { exact: true }).fill("第二条本地消息");
  await page.getByLabel("手机消息内容", { exact: true }).press("Control+Enter");
  await expect(page.getByRole("button", { name: "让 TA 回复", exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect.poll(async () => {
    const bubble = await page.locator(".phone-message.mine .phone-bubble p").last().boundingBox();
    const composer = await page.locator(".phone-composer").boundingBox();
    return bubble !== null && composer !== null && bubble.y + bubble.height <= composer.y;
  }).toBe(true);
  await page.screenshot({ path: "work/chat-batches-mobile.png" });
  await page.getByLabel("手机机主", { exact: true }).selectOption("fixture-role-b");
  await openPhoneChat(page);
  await expect(page.locator(".phone-message.mine")).toHaveCount(0);
  await send(page, "反方向消息");
  await expect(page.getByRole("button", { name: "让 TA 回复", exact: true })).toBeVisible();
  await page.getByLabel("手机机主", { exact: true }).selectOption("fixture-role-a");
  await openPhoneChat(page);
  await expect(page.getByRole("button", { name: "让 TA 回复", exact: true })).toBeVisible();
});
