import { test, expect } from "@playwright/test";
import { seedJourney } from "./fixtures";
test.beforeEach(async ({ page }) => {
  await seedJourney(page);
});

test("desktop full journey with controlled protocol fixture", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.route("https://fixture.test/**", async (route) => {
    const body = route.request().postDataJSON();
    const system = body.messages?.[0]?.content || "";
    const rows = system.includes("memories")
      ? JSON.parse(body.messages[1].content.split("【当前任务】\n")[1])
      : [];
    const last = rows.at(-1);
    const response = system.includes("memories")
      ? JSON.stringify({
          memories: last
            ? [
                {
                  text: "对方说伞可以明天归还。",
                  sourceIds: [last.id],
                  knownBy: last.knownBy,
                  scope: "story",
                },
              ]
            : [],
        })
      : system.includes("messages")
        ? JSON.stringify({
            messages: ["伞先放你那里。", "明天路过书店再给我。"],
          })
        : JSON.stringify({
            text: "周屿把伞递到许知面前，握着伞柄的手稍稍向前伸了些。“拿着。”声音不高，说话时也没有转过头来看她。",
            facts: [{ quote: "周屿把伞递到许知面前", knownBy: [] }],
          });
    await route.fulfill({
      contentType: "text/event-stream",
      body:
        "data: " +
        JSON.stringify({
          choices: [{ delta: { content: response }, finish_reason: "stop" }],
        }) +
        "\n\ndata: [DONE]\n\n",
    });
  });
  await page.goto("/");
  await expect(page.getByText("故事在此间生长")).toBeVisible();
  await page.getByRole("link", { name: "设置", exact: true }).click();
  await page.getByRole("button", { name: "添加接口" }).click();
  await page.getByLabel("接口 URL").fill("https://fixture.test/v1");
  await page.getByLabel("API Key", { exact: true }).fill("fixture-key");
  await page.getByLabel("模型名", { exact: true }).fill("fixture-model");
  await page.getByRole("button", { name: "保存并选用" }).click();
  await page.getByRole("checkbox", { name: "显示内部提示词编辑器" }).check();
  await page
    .getByLabel("自定义内部提示词")
    .fill("用自然的中文，写清具体的动作。");
  await page.getByRole("button", { name: "保存并启用" }).click();
  await page.getByRole("checkbox", { name: "显示内部提示词编辑器" }).uncheck();
  await expect(page.getByLabel("自定义内部提示词")).toHaveCount(0);
  await page.getByRole("link", { name: "角色", exact: true }).click();
  await page.getByRole("button", { name: "添加角色" }).click();
  await page.getByLabel("名字", { exact: true }).fill("测试角色");
  await page.getByLabel("导入 TXT").setInputFiles({
    name: "persona.md",
    mimeType: "text/markdown",
    buffer: Buffer.from("这是测试角色的人设。\n\n只有自己知道的小事。"),
  });
  await page.getByRole("button", { name: "保存角色", exact: true }).click();
  await expect(page.getByRole("heading", { name: "测试角色" })).toBeVisible();
  await page.getByRole("link", { name: "世界书", exact: true }).click();
  await page.getByRole("button", { name: "写一条设定" }).click();
  await page.getByLabel("标题", { exact: true }).fill("雨天约定");
  await page.getByLabel("设定正文").fill("借走的伞明天归还。");
  await page.getByRole("button", { name: "保存设定" }).click();
  await page.getByRole("link", { name: "故事", exact: true }).click();
  await page.getByRole("link").filter({ hasText: "雨声未歇" }).click();
  await page.getByRole("button", { name: "扩写这一刻", exact: true }).click();
  await expect(page.locator(".prose-event .event-text")).toContainText(
    "“拿着。”",
  );
  await page
    .locator(".prose-event")
    .getByRole("button", { name: "编辑", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "许知", exact: true })
    .click();
  await page.getByRole("button", { name: "保存新版本" }).click();
  await page.getByRole("button", { name: "手机聊天", exact: true }).click();
  await page.getByLabel("聊天消息").fill("伞我明天还你。");
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  await page.getByRole("button", { name: "让 TA 回复（1）", exact: true }).click();
  await expect(page.locator(".message-event")).toHaveCount(3);
  await expect(page.getByText("伞先放你那里。", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "故事记忆" }).click();
  await page.getByRole("button", { name: "立即整理" }).click();
  await expect(page.getByText("处理进度 · 节点 4")).toBeVisible();
  await expect(page.getByText("待确认", { exact: true }).first()).toBeVisible();
  await page.getByRole("button", { name: "接受", exact: true }).last().click();
  await expect(page.getByText("已记住", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await page.reload();
  await page.getByRole("button", { name: "手机聊天", exact: true }).click();
  await expect(page.locator(".message-event")).toHaveCount(3);
  await page.getByRole("link", { name: "设置", exact: true }).click();
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出完整备份（不含 Key）" }).click();
  const download = await downloadPromise;
  const path = await download.path();
  await page.locator("input[type=file]").setInputFiles(path!);
  await expect(page.getByRole("dialog", { name: "导入预览" })).toBeVisible();
  await page.getByRole("button", { name: "作为副本合并" }).click();
  await page.getByRole("link", { name: "故事", exact: true }).click();
  await expect(
    page.getByText("雨声未歇（导入副本）", { exact: true }),
  ).toBeVisible();
  expect(errors).toEqual([]);
  await page.screenshot({ path: "work/desktop-verified.png", fullPage: true });
});
test("mobile layout and Chinese text editing", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "故事在此间生长" }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.getByRole("link").filter({ hasText: "雨声未歇" }).click();
  await page.getByLabel("本段动作或台词").fill("她停在门边，没有再往前走。");
  await page.reload();
  await expect(page.getByLabel("本段动作或台词")).toHaveValue(
    "她停在门边，没有再往前走。",
  );
  await page.screenshot({ path: "work/mobile-verified.png", fullPage: true });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

test("create single and multiple role stories; mobile keyboard viewport", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "开启一个故事", exact: true }).click();
  await page.getByLabel("故事名字").fill("一个人的书页");
  await page.getByRole("button", { name: "周屿", exact: true }).click();
  await page.getByRole("button", { name: "翻开第一页" }).click();
  await expect(
    page.getByRole("heading", { name: "一个人的书页" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "手机聊天", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "发送消息", exact: true }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "打开故事设置", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "许知", exact: true })
    .click();
  await expect(
    page.getByText("角色已带入这本故事", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await page.getByLabel("聊天消息").fill("你也来书店了吗？");
  await expect(
    page.getByRole("button", { name: "发送消息", exact: true }),
  ).toBeEnabled();
  await page.getByRole("link", { name: "返回故事列表" }).click();
  await page.getByRole("button", { name: "开启一个故事", exact: true }).click();
  await page.getByLabel("故事名字").fill("两个人的书页");
  await page.getByRole("button", { name: "周屿", exact: true }).click();
  await page.getByRole("button", { name: "许知", exact: true }).click();
  await page.getByRole("checkbox", { name: "河畔书屋" }).check();
  await page.getByRole("button", { name: "翻开第一页" }).click();
  await expect(
    page.getByRole("heading", { name: "两个人的书页" }),
  ).toBeVisible();
  await page.setViewportSize({ width: 390, height: 460 });
  await page.getByLabel("本段动作或台词").fill("他站在门边。");
  await page.getByLabel("本段动作或台词").focus();
  const box = await page
    .getByRole("button", { name: "扩写这一刻", exact: true })
    .boundingBox();
  expect(box!.y + box!.height).toBeLessThan(400);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
