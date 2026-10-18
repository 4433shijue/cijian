import { test, expect, type Page } from "@playwright/test";
import { seedJourney, readStore } from "./fixtures";
async function open(page: Page) {
  await page.goto("/#story/fixture-story");
  await page.getByRole("button", { name: "角色手机", exact: true }).click();
  await page.getByRole("button", { name: "联系人", exact: true }).click();
  await page.getByRole("button", { name: "发消息", exact: true }).click();
}
async function send(page: Page, text: string) {
  await page.getByLabel("手机消息内容", { exact: true }).fill(text);
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  await expect(page.getByLabel("手机消息内容", { exact: true })).toHaveValue(
    "",
  );
}
async function configure(page: Page) {
  await page.evaluate(async () => {
    const d = await new Promise<IDBDatabase>((resolve) => {
      const r = indexedDB.open("little-scene-v1");
      r.onsuccess = () => resolve(r.result);
    });
    const tx = d.transaction(["profiles", "preferences"], "readwrite");
    tx.objectStore("profiles").put({
      id: "phone-e2e",
      name: "fixture",
      protocol: "chat",
      url: "https://phone.fixture.test/v1",
      model: "fixture",
      context: 64000,
      maxOutput: 2000,
      timeout: 10,
      stream: false,
      remember: true,
      key: "fixture-key",
    });
    tx.objectStore("preferences").put({
      id: "preferences",
      activeProfile: "phone-e2e",
      developer: false,
      prompts: {},
    });
    await new Promise<void>((resolve) => {
      tx.oncomplete = () => resolve();
    });
    d.close();
  });
}
test.beforeEach(async ({ page }) => {
  await seedJourney(page);
});
test("ordered sends survive refresh; failed multi-role work resumes without duplicates", async ({
  page,
}) => {
  await configure(page);
  let calls = 0;
  await page.route("https://phone.fixture.test/**", (route) => {
    calls++;
    return route.fulfill({
      json: {
        choices: [
          {
            message: {
              content:
                calls === 1
                  ? '{"messages":'
                  : JSON.stringify({
                      messages: [
                        { type: "text", text: "今天可以。" },
                        { type: "text", text: "六点去接你。" },
                      ],
                    }),
            },
            finish_reason: "stop",
          },
        ],
      },
    });
  });
  await open(page);
  for (const text of ["明天见面", "改成今天", "六点下班"])
    await send(page, text);
  expect(calls).toBe(0);
  await page.reload();
  await open(page);
  await expect(page.locator(".phone-message.mine")).toHaveCount(3);
  await page.getByRole("button", { name: "让 TA 回复", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "继续未完成角色", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "继续未完成角色", exact: true })
    .click();
  await expect(page.locator(".phone-message.theirs")).toHaveCount(2);
  expect(calls).toBe(2);
  expect(
    (await readStore(page, "events")).filter((e) => e.kind === "message"),
  ).toHaveLength(0);
  await page.getByLabel("手机机主").selectOption("fixture-role-b");
  await page.getByRole("button", { name: "联系人", exact: true }).click();
  await page.getByRole("button", { name: "发消息", exact: true }).click();
  await expect(page.locator(".phone-message.mine")).toHaveCount(2);
  await expect(page.locator(".phone-message.theirs")).toHaveCount(3);
});
for (const width of [1280, 390, 360])
  test(`phone UI, media, skin and export at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: width > 700 ? 1000 : 844 });
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await open(page);
    await page.getByRole("button", { name: "翻看与编排", exact: true }).click();
    await page.getByLabel("编排发言角色").selectOption("fixture-role-b");
    await send(page, "路过书店的时候，替我看看窗边的小花吧。");
    await page.getByRole("button", { name: "参与聊天", exact: true }).click();
    await send(page, "今天路过书店，门口的花开了。🌷");
    await page.getByLabel("消息形式", { exact: true }).selectOption("image");
    await page.getByLabel("手机消息内容", { exact: true }).fill("窗边的小花");
    const png = await page.evaluate(() => {
      const c = document.createElement("canvas");
      c.width = 120;
      c.height = 80;
      const ctx = c.getContext("2d")!;
      ctx.fillStyle = "#a1cbb5";
      ctx.fillRect(0, 0, 120, 80);
      ctx.fillStyle = "#ffe4ed";
      ctx.beginPath();
      ctx.arc(60, 40, 24, 0, Math.PI * 2);
      ctx.fill();
      return c.toDataURL().split(",")[1];
    });
    await page.getByLabel("上传手机图片").setInputFiles({
      name: "flower.png",
      mimeType: "image/png",
      buffer: Buffer.from(png, "base64"),
    });
    await expect(page.locator(".phone-attachments img")).toHaveCount(1);
    if (width === 360) {
      await page.reload();
      await open(page);
      await expect(page.getByLabel("消息形式", { exact: true })).toHaveValue(
        "image",
      );
      await expect(
        page.getByLabel("手机消息内容", { exact: true }),
      ).toHaveValue("窗边的小花");
      await expect(page.locator(".phone-attachments img")).toHaveCount(1);
    }

    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await expect(page.locator(".phone-message .phone-media")).toHaveCount(1);
    await page.getByRole("button", { name: "查看完整图片" }).click();
    await expect(
      page.getByRole("dialog").getByAltText("完整图片"),
    ).toBeVisible();
    await page.getByRole("button", { name: "关闭", exact: true }).click();

    await page.getByRole("button", { name: "手机设置", exact: true }).click();
    await page.getByLabel("手机主题").selectOption("dark");
    await expect(page.locator(".phone-panel")).toHaveClass(/phone-theme-dark/);
    await page.getByLabel("手机字号").fill("18");
    await page.getByRole("button", { name: "消息", exact: true }).click();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page
      .locator(".phone-panel")
      .screenshot({ path: `work/phone-${width}-dark.png` });
    await page.getByRole("button", { name: "导出长图", exact: true }).click();
    const downloading = page.waitForEvent("download");
    await page
      .getByRole("button", { name: "保存 PNG 长图", exact: true })
      .click();
    const download = await downloading;
    await download.saveAs(`work/phone-export-${width}.png`);
    expect(download.suggestedFilename()).toMatch(/\.png$/);
    await page.getByRole("button", { name: "手机设置", exact: true }).click();
    await page.getByLabel("手机主题").selectOption("light");
    await page.getByRole("button", { name: "消息", exact: true }).click();
    await page
      .locator(".phone-panel")
      .screenshot({ path: `work/phone-${width}-light.png` });
    await page.getByRole("button", { name: "沉浸阅读", exact: true }).click();
    await expect(page.locator(".phone-composer")).toHaveCount(0);
    await page
      .getByRole("button", { name: "退出手机阅读", exact: true })
      .click();
    expect(errors).toEqual([]);
  });
test("group composition, moments visibility and backup restore", async ({
  page,
}) => {
  await configure(page);
  await page.route("https://phone.fixture.test/**", (route) =>
    route.fulfill({
      json: {
        choices: [
          {
            message: {
              content: JSON.stringify({
                messages: [{ type: "text", text: "一起去书店看看吧。" }],
              }),
            },
            finish_reason: "stop",
          },
        ],
      },
    }),
  );
  await open(page);
  await page.getByRole("button", { name: "新建群聊" }).click();
  await page.getByLabel("群名").fill("书店朋友");
  await page
    .getByRole("dialog")
    .getByRole("checkbox", { name: "许知" })
    .check();
  await page.getByRole("button", { name: "保存群聊", exact: true }).click();
  await page.getByRole("button", { name: "翻看与编排", exact: true }).click();
  await page.getByLabel("手机生成情境").fill("讨论一起去书店");
  await page.getByRole("button", { name: "生成一轮对话", exact: true }).click();
  await expect(page.locator(".phone-message")).toHaveCount(2);
  await expect
    .poll(async () => (await readStore(page, "phoneRuns"))[0].status)
    .toBe("complete");
  await page.getByRole("button", { name: "朋友圈", exact: true }).click();
  await page.getByRole("button", { name: "发布动态", exact: true }).click();
  await page.getByLabel("动态内容").fill("只有自己知道的小心事");
  await page.getByLabel("动态可见范围").selectOption("self");
  await page.getByRole("button", { name: "发布这条动态", exact: true }).click();
  await expect(page.locator(".phone-moment")).toHaveCount(1);
  await page.getByLabel("手机机主").selectOption("fixture-role-b");
  await expect(page.locator(".phone-moment")).toHaveCount(0);
  await page.getByLabel("手机机主").selectOption("fixture-role-a");
  await page.getByRole("button", { name: "发布动态", exact: true }).click();
  await page.getByLabel("动态内容").fill("大家都能看到的日常");
  await page.getByLabel("动态可见范围").selectOption("all");
  await page.getByRole("button", { name: "发布这条动态", exact: true }).click();
  await page.getByLabel("手机机主").selectOption("fixture-role-b");
  await expect(page.locator(".phone-moment")).toHaveCount(1);
  await page.getByRole("button", { name: "♡ 点赞" }).click();
  await page.getByRole("button", { name: "评论", exact: true }).click();
  await page.getByLabel("朋友圈评论内容").fill("我也想去");
  await page.getByRole("button", { name: "发送评论", exact: true }).click();
  await expect(page.locator(".phone-comments")).toContainText("我也想去");
  await page
    .locator(".phone-panel")
    .screenshot({ path: "work/phone-moments.png" });
  await page.getByRole("link", { name: "设置", exact: true }).click();
  const downloading = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出完整备份（不含 Key）" }).click();
  const download = await downloading;
  await page
    .locator("input[type=file]")
    .setInputFiles((await download.path())!);
  await page.getByRole("button", { name: "作为副本合并" }).click();
  await expect
    .poll(async () => (await readStore(page, "stories")).length)
    .toBe(2);
  const copied = (await readStore(page, "stories")).find(
    (s) => s.id !== "fixture-story",
  );
  expect(
    (await readStore(page, "phoneRecords")).filter(
      (r) => r.storyId === copied.id,
    ),
  ).toHaveLength(5);
});
test("local audio plays, edits and versions restore, long records split into ZIP", async ({
  page,
}) => {
  await open(page);
  const pcm = Buffer.alloc(44 + 8000);
  pcm.write("RIFF");
  pcm.writeUInt32LE(pcm.length - 8, 4);
  pcm.write("WAVEfmt ", 8);
  pcm.writeUInt32LE(16, 16);
  pcm.writeUInt16LE(1, 20);
  pcm.writeUInt16LE(1, 22);
  pcm.writeUInt32LE(8000, 24);
  pcm.writeUInt32LE(8000, 28);
  pcm.writeUInt16LE(1, 32);
  pcm.writeUInt16LE(8, 34);
  pcm.write("data", 36);
  pcm.writeUInt32LE(8000, 40);
  pcm.fill(128, 44);
  await page.getByLabel("消息形式", { exact: true }).selectOption("audio");
  await page.getByLabel("手机消息内容", { exact: true }).fill("晚安，明天见");
  await page.getByLabel("上传手机音频").setInputFiles({
    name: "goodnight.wav",
    mimeType: "audio/wav",
    buffer: pcm,
  });
  await expect(page.locator(".phone-attachments audio")).toHaveCount(1);
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  const audio = page.locator(".phone-message audio");
  await expect(audio).toHaveCount(1);
  await audio.evaluate(async (el: HTMLAudioElement) => {
    await el.play();
  });
  await expect
    .poll(() => audio.evaluate((el: HTMLAudioElement) => el.currentTime))
    .toBeGreaterThan(0);
  await page
    .locator(".phone-message")
    .getByRole("button", { name: "编辑", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByLabel("手机消息内容", { exact: true })
    .fill("修改后的语音文字");
  await page.getByRole("button", { name: "保存修改" }).click();
  await page
    .locator(".phone-message")
    .getByRole("button", { name: "版本", exact: true })
    .click();
  await page.getByRole("button", { name: "恢复这个版本" }).first().click();
  await expect(page.locator(".phone-bubble")).toContainText("晚安，明天见");
  await send(
    page,
    "很长的中文消息，用来验证分页导出不会截断文字。".repeat(600),
  );
  await page.getByRole("button", { name: "导出长图", exact: true }).click();
  const downloading = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "保存 PNG 长图", exact: true })
    .click();
  expect((await downloading).suggestedFilename()).toMatch(/\.zip$/);
});

test("AI moments and comments remain manual and export with nine local photos", async ({
  page,
}) => {
  await configure(page);
  let calls = 0;
  await page.route("https://phone.fixture.test/**", (route) => {
    calls++;
    return route.fulfill({
      json: {
        choices: [
          {
            message: {
              content: JSON.stringify({
                messages: [
                  {
                    type: "text",
                    text:
                      calls === 1 ? "今天的花开得很好。" : "明天一起去看看。",
                  },
                ],
              }),
            },
            finish_reason: "stop",
          },
        ],
      },
    });
  });
  await open(page);
  await page.getByRole("button", { name: "朋友圈", exact: true }).click();
  expect(calls).toBe(0);
  await page.getByRole("button", { name: "发布动态", exact: true }).click();
  await page.getByLabel("动态内容").fill("写一条关于书店的小日常");
  await page
    .getByRole("button", { name: "让 AI 写一条动态", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.locator(".phone-moment")).toContainText(
    "今天的花开得很好。",
  );
  await page.getByRole("button", { name: "评论", exact: true }).click();
  await page
    .getByRole("button", { name: "让选中角色评论", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.locator(".phone-comments")).toContainText(
    "明天一起去看看。",
  );
  expect(calls).toBe(2);
  await page.getByRole("button", { name: "发布动态", exact: true }).click();
  await page.getByLabel("动态内容").fill("九张窗边照片");
  const png = await page.evaluate(() => {
    const c = document.createElement("canvas");
    c.width = 100;
    c.height = 60;
    const ctx = c.getContext("2d")!;
    ctx.fillStyle = "#a2ddc9";
    ctx.fillRect(0, 0, 100, 60);
    return c.toDataURL().split(",")[1];
  });
  await page.getByLabel("上传手机图片").setInputFiles(
    Array.from({ length: 9 }, (_, i) => ({
      name: `photo-${i}.png`,
      mimeType: "image/png",
      buffer: Buffer.from(png, "base64"),
    })),
  );
  await expect(page.locator(".phone-attachments img")).toHaveCount(9);
  await page.getByRole("button", { name: "发布这条动态", exact: true }).click();
  await expect(page.locator(".phone-moment .phone-media")).toHaveCount(9);
  for (const width of [1280, 390, 360])
    for (const theme of ["light", "dark"]) {
      await page.setViewportSize({ width, height: 844 });
      await page.getByRole("button", { name: "手机设置", exact: true }).click();
      await page.getByLabel("手机主题").selectOption(theme);
      await page.getByRole("button", { name: "朋友圈", exact: true }).click();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await page
        .locator(".phone-panel")
        .screenshot({ path: `work/phone-moments-${width}-${theme}.png` });
    }
  await page.getByRole("button", { name: "导出朋友圈", exact: true }).click();
  const download = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "保存 PNG 长图", exact: true })
    .click();
  const file = await download;
  await file.saveAs("work/phone-moments-export.png");
  expect(file.suggestedFilename()).toMatch(/\.png$/);
  await page.reload();
  await page.getByRole("button", { name: "角色手机", exact: true }).click();
  await page.getByRole("button", { name: "朋友圈", exact: true }).click();
  await expect(page.locator(".phone-moment")).toHaveCount(2);
  expect(calls).toBe(2);
});
