import { test, expect, type Page } from "@playwright/test";
import { seedJourney, seedPhone, readStore, openPhoneChat } from "./fixtures";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { writeFile } from "node:fs/promises";

async function seedReader(page: Page) {
  await seedPhone(page);
  return page.evaluate(async () => {
    const { db } = await import("/src/db.ts");
    const { conversation, addRecord, saveAsset, updateDevice } =
      await import("/src/phone-store.ts");
    const { savePhoneDocument } = await import("/src/phone-authoring.ts");
    const { ensureReading, saveReading } = await import("/src/phone-reader.ts");
    const { emptyBody } = await import("/src/phone-types.ts");
    const s = await db.stories.get("fixture-story-phone"),
      a = s.player,
      b = s.partner,
      cid = await conversation(s, [a, b]);
    await db.stories.update(s.id, {
      title: "雨停之前 · 虚构示例",
      background: "AUTHOR_SECRET_NOT_EXPORTED",
    });
    const first = await addRecord(s.id, {
      speakerId: a,
      conversationId: cid,
      body: { ...emptyBody(), text: "书店的灯还亮着，你带伞了吗？" },
      time: "2026-06-12T21:04",
    });
    const second = await addRecord(s.id, {
      speakerId: b,
      conversationId: cid,
      body: { ...emptyBody(), text: "带了。雨停之前，我们都不着急。" },
      time: "2026-06-12T21:05",
    });
    const clue = await savePhoneDocument({
      storyId: s.id,
      ownerId: b,
      kind: "note",
      title: "书签背面",
      text: "他把书签留在第 612 页。记住：612。",
      time: "2026-06-12T20:00",
    });
    const secret = await savePhoneDocument({
      storyId: s.id,
      ownerId: a,
      kind: "draft",
      title: "没有发出的晚安",
      text: "其实，我一直在等你。",
      recipientId: b,
      time: "2026-06-12T21:06",
    });
    const canvas = document.createElement("canvas");
    canvas.width = 480;
    canvas.height = 320;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#213946";
    ctx.fillRect(0, 0, 480, 320);
    ctx.fillStyle = "#e4bf77";
    ctx.fillRect(90, 60, 300, 170);
    ctx.fillStyle = "#365866";
    ctx.fillRect(100, 70, 280, 150);
    ctx.strokeStyle = "#9ed2df";
    for (let x = 20; x < 480; x += 40) {
      ctx.beginPath();
      ctx.moveTo(x, 10);
      ctx.lineTo(x - 30, 160);
      ctx.stroke();
    }
    ctx.fillStyle = "#e8d7ac";
    ctx.font = "24px sans-serif";
    ctx.fillText("河畔书屋 · 雨夜", 140, 280);
    const blob = await new Promise<Blob>((resolve) =>
      canvas.toBlob((b) => resolve(b!), "image/png"),
    );
    const assetId = await saveAsset(
      s.id,
      new File([blob], "雨夜示意图.png", { type: "image/png" }),
    );
    await savePhoneDocument({
      storyId: s.id,
      ownerId: a,
      kind: "photo",
      title: "书店还亮着灯",
      text: "作者绘制的虚构场景示意图。",
      assets: [assetId],
      album: "雨夜",
      time: "2026-06-12T21:00",
    });
    await addRecord(s.id, {
      speakerId: a,
      kind: "moment",
      audience: [a, b],
      body: {
        ...emptyBody(),
        text: "等一场雨停，也等一个人。",
        assets: [assetId],
      },
      time: "2026-06-12T21:00",
    });
    const cfg = await ensureReading(s.id);
    await saveReading({
      ...cfg,
      opening: "雨夜，你在书店窗台捡到两部手机。故事和人物均为虚构。",
      password: "0612",
      notification: "许知：我到门口了。",
      mode: "clues",
      rules: [
        {
          id: "rain-clue",
          title: "雨夜的约定",
          targets: [{ ownerId: a, type: "document", id: secret.id }],
          match: "all",
          conditions: [
            {
              type: "read",
              target: { ownerId: b, type: "document", id: clue.id },
            },
            { type: "password", answers: ["612", "第612页"] },
          ],
          hint: "先翻翻另一部手机的备忘录，再输入书页号码。",
          error: "还不是那一页。",
          notification: "一条没有发出的消息，终于被看见。",
        },
      ],
      performances: [
        {
          id: "rain-play",
          title: "雨中的对话",
          conversationId: cid,
          steps: [
            { recordId: first.id, delay: 6000, typing: true, retractAfter: 0 },
            { recordId: second.id, delay: 6000, typing: true, retractAfter: 0 },
          ],
        },
      ],
    });
    await updateDevice(s.id, b, (d) => ({
      ...d,
      skin: {
        theme: "dark",
        fontSize: 16,
        mine: "",
        theirs: "",
        wallpaper: "",
      },
    }));
    return { a, b, cid, clue: clue.id, secret: secret.id };
  });
}

test("creation requires mode first, keeps type fixed and copies templates", async ({
  page,
}) => {
  await seedJourney(page);
  await page.goto("/#stories");
  await page.getByRole("button", { name: "开启一个故事", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "先选择作品模式" }),
  ).toBeVisible();
  await expect(page.getByLabel("作品名字")).toHaveCount(0);
  await page.getByRole("button", { name: /手机模式/ }).click();
  await page.getByLabel("作品名字").fill("我的第一部手机");
  await page
    .getByRole("checkbox", { name: "周屿", exact: true })
    .first()
    .check();
  await page
    .getByRole("checkbox", { name: "许知", exact: true })
    .first()
    .check();
  await page.getByLabel("手机开场背景").fill("两个人在同一家书店工作。");
  await page.getByText("带入世界书副本", { exact: true }).click();
  await page.getByRole("checkbox", { name: "河畔书屋", exact: true }).check();
  await page.getByRole("button", { name: "创建手机作品", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "我的第一部手机" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "扩写这一刻", exact: true }),
  ).toHaveCount(0);
  await expect(page.getByRole("button", { name: "重新选择模式" })).toHaveCount(
    0,
  );
  const s = (await readStore(page, "stories")).find(
    (s) => s.title === "我的第一部手机",
  );
  expect(s.kind).toBe("phone");
  expect(s.roles.every((r: any) => r.id !== r.sourceId)).toBe(true);
  expect(
    (await readStore(page, "storyWorld")).some((w) => w.storyId === s.id),
  ).toBe(true);
  await page.goto("/#stories");
  await page.getByLabel("作品类型").selectOption("novel");
  await expect(page.getByText("我的第一部手机", { exact: true })).toHaveCount(
    0,
  );
  await page.getByLabel("作品类型").selectOption("phone");
  await expect(page.getByText("我的第一部手机", { exact: true })).toBeVisible();
});

test("documents preserve versions and batch scripts remain drafts until adopted with undo", async ({
  page,
}) => {
  await seedJourney(page);
  await openPhoneChat(page);
  await page.getByRole("button", { name: "备忘录与相册", exact: true }).click();
  await page.getByRole("button", { name: "新增备忘录" }).click();
  await page.getByLabel("标题", { exact: true }).fill("藏在口袋的字条");
  await page.getByLabel("内容", { exact: true }).fill("她喜欢下雨天。");
  await page.getByRole("button", { name: "保存文档", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("button", { name: "编辑与版本", exact: true }).click();
  await page.getByLabel("内容", { exact: true }).fill("她喜欢晴天。");
  await page.getByRole("button", { name: "保存文档", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect((await readStore(page, "phoneDocuments"))[0].versions).toHaveLength(2);
  await page.getByRole("button", { name: "编辑与版本", exact: true }).click();
  await page.getByText("历史版本（2）", { exact: true }).click();
  await page.getByRole("button", { name: "恢复此版本到编辑器" }).last().click();
  await page.getByRole("button", { name: "保存文档", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByText("她喜欢下雨天。", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "批量编排", exact: true }).click();
  await page.getByText("粘贴整段剧本", { exact: true }).click();
  await page
    .getByLabel("每条消息写成「角色名：内容」")
    .fill("周屿：雨还没停。\n许知：那就再等一会儿。");
  await page.getByRole("button", { name: "保存为编排草稿" }).click();
  expect(await readStore(page, "phoneRecords")).toHaveLength(0);
  await page.getByRole("button", { name: "采用这份编排" }).click();
  await expect(page.locator(".work-batch-row")).toHaveCount(2);
  await page
    .locator(".work-batch-row")
    .last()
    .getByRole("button", { name: "上移", exact: true })
    .click();
  await expect(page.locator(".work-batch-row").first()).toContainText(
    "那就再等一会儿。",
  );
  await page.getByText("操作历史与撤销", { exact: true }).click();
  await expect(
    page
      .getByText("操作历史与撤销", { exact: true })
      .locator("..")
      .locator(".row")
      .first(),
  ).toContainText("调整消息顺序");
  await page.getByRole("button", { name: "撤销本次操作" }).first().click();
  await expect(page.locator(".work-batch-row").first()).toContainText(
    "雨还没停。",
  );
});

for (const width of [1280, 390, 360])
  test(`reader preview and offline package: clues, owner privacy, playback at ${width}px`, async ({
    page,
    context,
  }) => {
    await page.setViewportSize({ width, height: width === 1280 ? 900 : 844 });
    await seedJourney(page);
    const ids = await seedReader(page);
    if (width === 1280) {
      const backup = await page.evaluate(async () => {
        const { exportBackup } = await import("/src/backup.ts");
        return exportBackup();
      });
      await writeFile(
        path.resolve("work/v3-demo-backup.json"),
        JSON.stringify(backup),
      );
    }
    await page.goto("/#story/fixture-story-phone");
    await page.getByRole("button", { name: "阅读编排与分享" }).click();
    await page.screenshot({
      path: `work/v3-author-${width}.png`,
      fullPage: true,
    });
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.getByRole("button", { name: "读者预览", exact: true }).click();
    const frame = page.frameLocator('iframe[title="手机读者预览"]');
    await expect(frame.getByRole("button", { name: "打开手机" })).toBeVisible();
    await page.screenshot({ path: `work/v3-preview-${width}.png` });
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "关闭", exact: true })
      .click();
    const dl = page.waitForEvent("download");
    await page.getByRole("button", { name: "导出离线阅读包" }).click();
    const download = await dl,
      filename = path.resolve(`work/v3-demo-${width}.html`);
    await download.saveAs(filename);
    const attempts: string[] = [];
    page.on("request", (req) => {
      if (/^https?:/.test(req.url())) attempts.push(req.url());
    });
    await context.setOffline(true);
    await page.goto(pathToFileURL(filename).href);
    await page.screenshot({ path: `work/v3-lock-${width}.png` });
    await page.getByLabel("手机解锁密码").fill("wrong");
    await page.getByRole("button", { name: "打开手机" }).click();
    await expect(page.getByRole("status")).toContainText("密码不对");
    await page.getByLabel("手机解锁密码").fill("0612");
    await page.getByRole("button", { name: "打开手机" }).click();
    await page.getByRole("button", { name: "关闭", exact: true }).click();
    await page.screenshot({ path: `work/v3-home-${width}.png` });
    await page.getByRole("button", { name: /笺.*草稿箱/ }).click();
    await expect(
      page.getByText("其实，我一直在等你。", { exact: true }),
    ).toHaveCount(0);
    await page.getByLabel("雨夜的约定的答案").fill("111");
    await page.getByRole("button", { name: "解锁", exact: true }).click();
    await expect(page.getByRole("status")).toContainText("还不是那一页");
    await page.getByLabel("雨夜的约定的答案").fill("612");
    await page.getByRole("button", { name: "解锁", exact: true }).click();
    await expect(page.getByText("没有发出的晚安", { exact: true })).toHaveCount(
      0,
    );
    await page.screenshot({ path: `work/v3-clue-${width}.png` });
    await page.getByLabel("切换角色手机").selectOption(ids.b);
    await page.getByRole("button", { name: /记.*备忘录/ }).click();
    await page.getByRole("button", { name: "打开", exact: true }).click();
    await expect(page.getByText(/他把书签留在第 612 页/)).toBeVisible();
    await expect(page.getByRole("status")).toContainText("一条没有发出的消息");
    await page.screenshot({ path: `work/v3-dark-${width}.png` });
    await page.getByLabel("切换角色手机").selectOption(ids.a);
    await page.getByRole("button", { name: /笺.*草稿箱/ }).click();
    await page.getByRole("button", { name: "打开", exact: true }).click();
    await expect(
      page.getByText("其实，我一直在等你。", { exact: true }),
    ).toBeVisible();
    await page.reload();
    await page.getByRole("button", { name: /聊.*消息/ }).click();
    await page.getByRole("button", { name: /许知/ }).click();
    await page.getByRole("button", { name: "播放：雨中的对话" }).click();
    await page.getByRole("button", { name: "暂停", exact: true }).click();
    await expect(page.locator(".reader-message")).toHaveCount(0);
    await page.getByRole("button", { name: "跳过停顿" }).click();
    await expect(page.locator(".reader-message")).toHaveCount(1);
    await page.getByLabel("播放速度").selectOption("4");
    await page.screenshot({ path: `work/v3-chat-${width}.png` });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    expect(attempts).toEqual([]);
    expect(errors).toEqual([]);
    expect(await page.content()).not.toContain("AUTHOR_SECRET_NOT_EXPORTED");
  });

test("an untyped legacy story splits once and retains navigation to both copies", async ({
  page,
}) => {
  await seedJourney(page);
  await page.evaluate(async () => {
    const { db } = await import("/src/db.ts");
    await db.stories.update("fixture-story", { kind: undefined });
  });
  await page.reload();
  await page.goto("/#stories");
  await expect(
    page.getByText("旧故事已拆分为独立的小说与手机作品", { exact: true }),
  ).toBeVisible();
  expect(await readStore(page, "stories")).toHaveLength(2);
  await expect(page.getByText("雨声未歇·小说", { exact: true })).toBeVisible();
  await expect(page.getByText("雨声未歇·手机", { exact: true })).toBeVisible();
  await page.reload();
  expect(await readStore(page, "stories")).toHaveLength(2);
});

test("offline reader offers progress files when browser storage is unavailable", async ({
  page,
  context,
}) => {
  await context.addInitScript(() => {
    Storage.prototype.setItem = () => {
      throw new DOMException("blocked", "SecurityError");
    };
    Storage.prototype.getItem = () => {
      throw new DOMException("blocked", "SecurityError");
    };
  });
  await context.setOffline(true);
  await page.goto(
    pathToFileURL(path.resolve("examples/雨停之前-手机阅读包.html")).href,
  );
  await page.getByLabel("切换角色手机").selectOption({ label: "许知" });
  await page.getByLabel("手机解锁密码").fill("0612");
  await page.getByRole("button", { name: "打开手机" }).click();
  await expect(page.getByRole("heading", { name: "许知的手机" })).toBeVisible();
  await page.getByText("阅读进度", { exact: true }).click();
  await expect(
    page.getByText("此环境无法自动保存进度，可以下载进度文件。", {
      exact: true,
    }),
  ).toBeVisible();
  const pending = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出进度", exact: true }).click();
  const download = await pending;
  await page.locator('input[type="file"]').setInputFiles({
    name: "wrong.json",
    mimeType: "application/json",
    buffer: Buffer.from(
      JSON.stringify({
        format: "cijian-progress",
        id: "wrong",
        revision: "wrong",
        progress: {},
      }),
    ),
  });
  await expect(page.getByRole("status")).toContainText("不属于这一版本");
  await page
    .locator('input[type="file"]')
    .setInputFiles((await download.path())!);
  await expect(page.getByRole("status")).toContainText("进度已恢复");
});

test("reader marks only rendered visible records and hides locked quote text", async ({
  page,
}) => {
  await seedJourney(page);
  const ids = await seedReader(page);
  const last = await page.evaluate(async ({ a, b, cid, secret }) => {
    const { db } = await import("/src/db.ts"),
      { addRecord } = await import("/src/phone-store.ts"),
      { emptyBody } = await import("/src/phone-types.ts"),
      { ensureReading, saveReading } = await import("/src/phone-reader.ts");
    const sid = "fixture-story-phone";
    const locked = await addRecord(sid, {
      conversationId: cid,
      speakerId: b,
      body: { ...emptyBody(), text: "LOCKED_QUOTE_CONTENT" },
    });
    await addRecord(sid, {
      conversationId: cid,
      speakerId: a,
      body: { ...emptyBody(), text: "这句话暂时不能看。", quoteId: locked.id },
    });
    let last = "";
    for (let i = 0; i < 25; i++)
      last = (
        await addRecord(sid, {
          conversationId: cid,
          speakerId: b,
          body: {
            ...emptyBody(),
            text: `第 ${i + 1} 条消息，窗外的雨还没有停。`.repeat(4),
          },
        })
      ).id;
    const cfg = await ensureReading(sid);
    await saveReading({
      ...cfg,
      performances: [],
      rules: [
        {
          id: "private-quote",
          title: "旧消息",
          targets: [{ ownerId: a, type: "record", id: locked.id }],
          conditions: [{ type: "password", answers: ["later"] }],
          match: "all",
          hint: "之后再看",
          error: "不对",
          notification: "",
        },
        {
          id: "scroll-clue",
          title: "读到最后",
          targets: [{ ownerId: a, type: "document", id: secret }],
          conditions: [
            { type: "read", target: { ownerId: a, type: "record", id: last } },
          ],
          match: "all",
          hint: "先读完聊天",
          error: "",
          notification: "读到最后了",
        },
      ],
    });
    return last;
  }, ids);
  await page.goto("/#story/fixture-story-phone");
  await page.getByRole("button", { name: "阅读编排与分享" }).click();
  await page.getByRole("button", { name: "读者预览", exact: true }).click();
  const reader = page.frameLocator('iframe[title="手机读者预览"]');
  await reader.getByLabel("手机解锁密码").fill("0612");
  await reader.getByRole("button", { name: "打开手机" }).click();
  await reader.getByRole("button", { name: /聊.*消息/ }).click();
  await reader.getByRole("button", { name: /许知/ }).click();
  await expect(reader.locator("blockquote")).toHaveText("引用内容暂不可见");
  await expect(
    reader.getByText("LOCKED_QUOTE_CONTENT", { exact: true }),
  ).toHaveCount(0);
  const frame = page.frames().find((f) => f.url() === "about:srcdoc")!;
  await expect
    .poll(() =>
      frame.evaluate(
        () =>
          Object.keys(localStorage)
            .filter((k) => k.startsWith("cijian-reader:"))
            .flatMap((k) => JSON.parse(localStorage.getItem(k)!).read).length,
      ),
    )
    .toBeGreaterThan(0);
  expect(
    await frame.evaluate(
      (last) =>
        Object.keys(localStorage)
          .filter((k) => k.startsWith("cijian-reader:"))
          .some((k) =>
            JSON.parse(localStorage.getItem(k)!).read.some((r: string) =>
              r.endsWith("/" + last),
            ),
          ),
      last,
    ),
  ).toBe(false);
  await reader
    .locator(".reader-content")
    .evaluate((el) => (el.scrollTop = el.scrollHeight));
  await expect(reader.getByRole("status")).toContainText("读到最后了");
});
