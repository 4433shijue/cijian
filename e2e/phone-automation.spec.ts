import { test, expect, type Page } from "@playwright/test";
import { seedJourney, seedPhone, readStore } from "./fixtures";
import { mkdir } from "node:fs/promises";
const baseAction = {
  kind: "wait",
  conversationId: "",
  recipientId: "",
  parentId: "",
  replyTo: "",
  documentId: "",
  audience: [],
  reason: "雨还没停，先安静一会儿。",
  instruction: "",
  awaitUser: false,
};
const body = {
  type: "text",
  text: "雨把书店门前的路灯晕成了一圈。",
  assets: [],
  quoteId: "",
  amount: "",
  duration: "",
  callState: "completed",
};
async function setup(page: Page) {
  await seedJourney(page);
  await seedPhone(page);
  await page.evaluate(async () => {
    const { db } = await import("/src/db.ts");
    await db.profiles.put({
      id: "auto-e2e",
      name: "自动推进模拟接口",
      protocol: "chat",
      url: "https://automation.fixture.test/v1",
      model: "fixture",
      context: 128000,
      maxOutput: 2000,
      timeout: 60,
      stream: false,
      remember: true,
      key: "fictional-key",
      temperature: 0.42,
    });
    await db.preferences.update("preferences", { activeProfile: "auto-e2e" });
  });
  await page.goto("/#story/fixture-story-phone");
  await page.getByRole("button", { name: "让故事继续", exact: true }).click();
}
async function respond(route: any, value: unknown) {
  await route.fulfill({
    json: {
      choices: [
        { message: { content: JSON.stringify(value) }, finish_reason: "stop" },
      ],
    },
  });
}
const close = async (page: Page) =>
  page
    .getByRole("dialog")
    .getByRole("button", { name: "关闭", exact: true })
    .click();

for (const protocol of ["chat", "responses", "claude", "gemini"]) {
  test(`automatic decisions preserve temperature with ${protocol}`, async ({
    page,
  }) => {
    await setup(page);
    await page.evaluate(async (protocol) => {
      const { db } = await import("/src/db.ts");
      await db.profiles.update("auto-e2e", { protocol, temperature: 0.42 });
    }, protocol);
    let body: any;
    await page.route("https://automation.fixture.test/**", async (route) => {
      body = route.request().postDataJSON();
      const text = JSON.stringify(baseAction);
      await route.fulfill({
        json:
          protocol === "chat"
            ? {
                choices: [
                  { message: { content: text }, finish_reason: "stop" },
                ],
              }
            : protocol === "responses"
              ? {
                  status: "completed",
                  output: [
                    {
                      type: "message",
                      content: [{ type: "output_text", text }],
                    },
                  ],
                }
              : protocol === "claude"
                ? { content: [{ type: "text", text }], stop_reason: "end_turn" }
                : {
                    candidates: [
                      { content: { parts: [{ text }] }, finishReason: "STOP" },
                    ],
                  },
      });
    });
    await page.getByLabel("本次临时回合", { exact: true }).fill("1");
    await page
      .getByRole("button", { name: "让故事继续 1 回合", exact: true })
      .click();
    await expect
      .poll(
        async () => (await readStore(page, "phoneAutomationRuns"))[0]?.status,
      )
      .toBe("complete");
    expect(
      protocol === "gemini"
        ? body.generationConfig.temperature
        : body.temperature,
    ).toBe(0.42);
  });
}
test("five AI opportunities continue across pages with the frozen temperature", async ({
  page,
}) => {
  await setup(page);
  const requests: any[] = [];
  await page.route("https://automation.fixture.test/**", async (route) => {
    requests.push(route.request().postDataJSON());
    await new Promise((resolve) => setTimeout(resolve, 120));
    await respond(route, baseAction);
  });
  await page
    .getByRole("button", { name: "让故事继续 5 回合", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await close(page);
  await page.getByRole("link", { name: "我的作品", exact: false }).click();
  await expect(
    page.getByRole("complementary", { name: "全局推进任务" }),
  ).toBeVisible();
  await expect
    .poll(async () => (await readStore(page, "phoneAutomationRuns"))[0]?.status)
    .toBe("complete");
  expect(requests).toHaveLength(5);
  expect(requests.every((x) => x.temperature === 0.42)).toBe(true);
  expect(await readStore(page, "phoneRecords")).toHaveLength(0);
});
test("pause and refresh require explicit resume and do not repeat completed steps", async ({
  page,
}) => {
  await setup(page);
  let calls = 0;
  await page.route("https://automation.fixture.test/**", async (route) => {
    calls++;
    await new Promise((resolve) =>
      setTimeout(resolve, calls === 2 ? 1000 : 30),
    );
    await respond(route, baseAction).catch(() => {});
  });
  await page
    .getByRole("button", { name: "让故事继续 5 回合", exact: true })
    .click();
  await expect.poll(() => calls).toBe(2);
  await page.getByRole("button", { name: "暂停推进", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "继续未完成步骤", exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("complementary", { name: "全局推进任务" }),
  ).toContainText("已暂停");
  expect(calls).toBe(2);
  await page
    .getByRole("complementary", { name: "全局推进任务" })
    .getByRole("button")
    .first()
    .click();
  await page
    .getByRole("button", { name: "继续未完成步骤", exact: true })
    .click();
  await expect
    .poll(async () => (await readStore(page, "phoneAutomationRuns"))[0]?.status)
    .toBe("complete");
  expect(calls).toBe(6);
});
test("moments can generate into the editor, be edited and published without duplicate automatic posts", async ({
  page,
}) => {
  await setup(page);
  await page.route("https://automation.fixture.test/**", (route) =>
    respond(route, { messages: [{ type: "text", text: body.text }] }),
  );
  await page.getByRole("button", { name: "角色手机", exact: true }).click();
  await page.getByRole("button", { name: "朋友圈", exact: true }).click();
  await page.getByRole("button", { name: "发布动态", exact: true }).click();
  await page
    .getByRole("button", { name: "AI 生成到编辑器", exact: true })
    .click();
  await expect(page.getByLabel("动态内容", { exact: true })).toHaveValue(
    body.text,
  );
  expect(await readStore(page, "phoneRecords")).toHaveLength(0);
  await page.getByLabel("动态内容", { exact: true }).fill("雨停了，晚安。");
  await page.getByRole("button", { name: "发布这条动态", exact: true }).click();
  await expect(page.locator(".phone-moment-body")).toContainText(
    "雨停了，晚安。",
  );
  expect(await readStore(page, "phoneRecords")).toHaveLength(1);
});
test("isolated automatic draft can be adopted and undone from task details", async ({
  page,
}) => {
  await setup(page);
  await page.route("https://automation.fixture.test/**", (route) => {
    const request = route.request().postDataJSON();
    return respond(
      route,
      request.messages[1].content.includes("【已确定行动】")
        ? { messages: [body], title: "", text: "", assets: [] }
        : { ...baseAction, kind: "moment", audience: ["fixture-role-b"] },
    );
  });
  await page.getByLabel("本次临时回合", { exact: true }).fill("1");
  await page.getByLabel("结果保存方式").selectOption("draft");
  await page
    .getByRole("button", { name: "让故事继续 1 回合", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "采用整批草稿", exact: true }),
  ).toBeVisible();
  expect(await readStore(page, "phoneRecords")).toHaveLength(0);
  await page.getByRole("button", { name: "采用整批草稿", exact: true }).click();
  await expect
    .poll(async () => (await readStore(page, "phoneRecords")).length)
    .toBe(1);
  await page.getByRole("button", { name: "撤销本批次", exact: true }).click();
  await expect
    .poll(async () => (await readStore(page, "phoneRecords"))[0]?.deleted)
    .toBe(true);
  expect((await readStore(page, "phoneAutomationSettings"))[0].rounds).toBe(5);
});
test("two tabs share one task lock while handwritten inputs remain available", async ({
  page,
  context,
}) => {
  await setup(page);
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let requested = false;
  await page.route("https://automation.fixture.test/**", async (route) => {
    requested = true;
    await held;
    await respond(route, baseAction);
  });
  await page
    .getByRole("button", { name: "让故事继续 5 回合", exact: true })
    .click();
  await expect
    .poll(async () => (await readStore(page, "phoneAutomationRuns"))[0]?.status)
    .toBe("running");
  await expect.poll(() => requested).toBe(true);
  const other = await context.newPage();
  await other.goto("/#story/fixture-story-phone");
  const error = await other.evaluate(async () => {
    const { ensureAutomation, startAutomation } =
      await import("/src/phone-automation.ts");
    try {
      await startAutomation(
        "fixture-story-phone",
        await ensureAutomation("fixture-story-phone"),
      );
      return "unexpected";
    } catch (e) {
      return String(e);
    }
  });
  expect(error).toMatch(/标签页|正在自动推进/);
  await other.evaluate(async () => {
    const { db } = await import("/src/db.ts");
    const { conversation, addRecord } = await import("/src/phone-store.ts");
    const { emptyBody } = await import("/src/phone-types.ts");
    const s = await db.stories.get("fixture-story-phone");
    await addRecord(s.id, {
      speakerId: s.player,
      conversationId: await conversation(s, [s.player, s.partner]),
      body: { ...emptyBody(), text: "等一下，我带了伞。" },
      pending: true,
    });
  });
  expect(await readStore(page, "phoneRecords")).toHaveLength(1);
  await page.getByRole("button", { name: "暂停推进", exact: true }).click();
  release();
  await other.close();
});
for (const width of [1280, 390, 360])
  test(`visual review of automation, task bar, moments and prompts at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: width === 1280 ? 900 : 844 });
    await setup(page);
    await mkdir("work/v31-visual", { recursive: true });
    const overflow = () =>
      page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth + 1,
      );
    expect(await overflow()).toBe(false);
    await page.screenshot({
      path: `work/v31-visual/automation-${width}.png`,
      fullPage: true,
    });
    await page.route("https://automation.fixture.test/**", (route) =>
      respond(route, baseAction),
    );
    await page.getByLabel("请求次数上限（0 为不限）").fill("1");
    await page
      .getByRole("button", { name: "让故事继续 5 回合", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "继续未完成步骤", exact: true }),
    ).toBeVisible();
    await page.screenshot({
      path: `work/v31-visual/task-${width}.png`,
      fullPage: true,
    });
    await close(page);
    await page.evaluate(async () => {
      const { db } = await import("/src/db.ts");
      const { addRecord, updateDevice } = await import("/src/phone-store.ts");
      const { emptyBody } = await import("/src/phone-types.ts");
      const s = await db.stories.get("fixture-story-phone");
      await addRecord(s.id, {
        speakerId: s.partner,
        kind: "moment",
        audience: s.roles.map((r: any) => r.id),
        body: {
          ...emptyBody(),
          text: "有些雨声适合留在今晚。明早的第一杯咖啡，还是老位置。",
        },
      });
      await updateDevice(s.id, s.player, (d: any) => ({
        ...d,
        skin: {
          theme: "dark",
          wallpaper: "",
          mine: "",
          theirs: "",
          fontSize: 16,
        },
      }));
    });
    await page.getByRole("button", { name: "角色手机", exact: true }).click();
    await page.getByRole("button", { name: "朋友圈", exact: true }).click();
    expect(await overflow()).toBe(false);
    await page.screenshot({
      path: `work/v31-visual/moments-dark-${width}.png`,
      fullPage: true,
    });
    await page.evaluate(async () => {
      const { db } = await import("/src/db.ts");
      await db.preferences.update("preferences", { developer: true });
    });
    await page.goto("/#settings");
    await page
      .getByRole("combobox", { name: "编辑提示词", exact: true })
      .selectOption("phoneDecision");
    await page
      .getByLabel("自定义内部提示词", { exact: true })
      .scrollIntoViewIfNeeded();
    expect(await overflow()).toBe(false);
    await page.screenshot({
      path: `work/v31-visual/prompts-${width}.png`,
      fullPage: true,
    });
  });
