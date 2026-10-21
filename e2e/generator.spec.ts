import { test, expect, type Page } from "@playwright/test";
import { seedJourney, readStore } from "./fixtures";
import { completionDimensions } from "../src/role-completion-types";
import { mkdir } from "node:fs/promises";
test.use({ actionTimeout: 10000 });
const dialog = (p: Page) =>
  p.getByRole("dialog", { name: "角色卡生成器", exact: true });
const ask = {
  message: "读完资料了，我们先聊留下的原因。",
  confirmed: ["保留嘴硬心软"],
  conflicts: [],
  unknown: [],
  ready: false,
  questions: [
    {
      id: "reason",
      text: "他为什么留下？",
      multiple: true,
      options: [
        { id: "family", text: "照顾家人" },
        { id: "love", text: "有人挽留" },
      ],
    },
    {
      id: "voice",
      text: "他会怎样解释？",
      multiple: false,
      options: [
        { id: "honest", text: "坦然说出心意" },
        { id: "shy", text: "只说为了家人" },
      ],
    },
  ],
};
async function seed(page: Page) {
  await seedJourney(page);
  await page.evaluate(async () => {
    const { db } = await import("/src/db.ts");
    await db.profiles.put({
      id: "generator-test",
      name: "生成器模拟接口",
      url: "https://generator.fixture.test/v1",
      protocol: "chat",
      model: "fixture",
      stream: false,
      context: 64000,
      maxOutput: 7000,
      timeout: 20,
      temperature: 0.41,
      remember: true,
      key: "isolated-generator-fixture-key",
    });
    await db.preferences.put({
      id: "preferences",
      activeProfile: "generator-test",
      developer: false,
      prompts: {},
    });
  });
  await page.goto("/#roles");
}
async function open(page: Page) {
  await page.getByRole("button", { name: "帮我补全", exact: true }).click();
  await expect(dialog(page)).toBeVisible();
  await expect(
    dialog(page).getByText("正在读取会话…", { exact: true }),
  ).toHaveCount(0);
}
async function setup(page: Page) {
  await open(page);
  const d = dialog(page);
  await d.getByLabel("创作方式", { exact: true }).selectOption("if");
  await d.getByLabel("必须保留的角色内核").fill("嘴硬心软");
  await d.getByLabel("这次想怎么写").fill("如果周屿没有离开小镇");
  await d.getByRole("checkbox", { name: "参考角色 周屿" }).check();
  await d.getByLabel("周屿的参考用途").selectOption("target");
  await d.getByRole("checkbox", { name: "参考世界书 河畔书屋" }).check();
  await d.getByRole("button", { name: "添加目标人物" }).click();
  await d.getByLabel("目标人物 1", { exact: true }).fill("周屿");
}
async function mocked(
  page: Page,
  { failCard = false }: { failCard?: boolean } = {},
) {
  const requests: any[] = [];
  let interviews = 0,
    failed = false;
  await page.route("https://generator.fixture.test/**", async (route) => {
    const body = route.request().postDataJSON(),
      p = JSON.parse(body.messages.at(-1).content);
    requests.push({ body, p });
    if (p.task === "card" && failCard && !failed) {
      failed = true;
      await route.fulfill({ status: 500, body: "模拟中断" });
      return;
    }
    const content =
      p.task === "interview"
        ? interviews++ === 0
          ? ask
          : {
              ...ask,
              questions: [],
              ready: true,
              message: "方向够清楚了，我来整理第一版。",
            }
        : p.task === "card"
          ? {
              targetId: p.targetId,
              name: p.input.targets.find((t: any) => t.id === p.targetId).name,
              bio: "河畔书屋的店主",
              sections: completionDimensions.map((title) => ({
                title,
                content: `${title}：他留下照顾家人，嘴硬但会把关心落在行动上。`,
                basis: "created",
                evidence: "",
                sourceIds: [],
              })),
              preserved: ["嘴硬心软"],
              changed: ["留在小镇"],
              reasons: ["作者确认选择"],
            }
          : {
              worlds: [
                {
                  title: "IF 河畔书屋",
                  text: "这条线里，书店冬天仍开门。",
                  type: "world",
                  audience: "roles",
                  roleIds: p.input.targets.map((t: any) => t.id),
                  knownBy: p.input.targets.map((t: any) => t.id),
                },
              ],
            };
    await route.fulfill({
      json: {
        choices: [
          {
            message: { content: JSON.stringify(content) },
            finish_reason: "stop",
          },
        ],
      },
    });
  });
  return requests;
}
async function answer(page: Page) {
  const d = dialog(page);
  await d.getByRole("checkbox", { name: "照顾家人", exact: true }).check();
  await d.getByRole("checkbox", { name: "有人挽留", exact: true }).check();
  await d.getByRole("radio", { name: "只说为了家人", exact: true }).check();
  await d
    .getByLabel("补充想法", { exact: true })
    .fill("两种原因都有，但他不肯承认第二种");
  await d.getByRole("button", { name: "发送并继续", exact: true }).click();
}
test("IF interview selects library snapshots, automatically composes, edits new versions and saves new cards and worlds", async ({
  page,
}) => {
  await seed(page);
  const originals = await readStore(page, "roles"),
    originalWorld = await readStore(page, "world"),
    requests = await mocked(page);
  await setup(page);
  await dialog(page)
    .getByRole("button", { name: "确认目标与参考，开始访谈" })
    .click();
  await expect(
    dialog(page).getByRole("checkbox", { name: "照顾家人", exact: true }),
  ).toBeVisible();
  expect(requests).toHaveLength(1);
  await answer(page);
  await expect(dialog(page).getByTestId("generator-result")).toHaveCount(2);
  expect(requests).toHaveLength(4);
  expect(requests.every((x) => x.body.temperature === 0.41)).toBeTruthy();
  await dialog(page).getByRole("button", { name: "勾选当前全部结果" }).click();
  await dialog(page)
    .getByRole("button", { name: "将勾选结果另存到库" })
    .click();
  await expect
    .poll(async () => (await readStore(page, "roles")).length)
    .toBe(3);
  expect(
    (await readStore(page, "roles")).filter((r) =>
      originals.some((o) => o.id === r.id),
    ),
  ).toEqual(originals);
  expect(
    (await readStore(page, "world")).find((w) => w.id === originalWorld[0].id),
  ).toEqual(originalWorld[0]);
  await dialog(page).getByRole("button", { name: "编辑这版" }).first().click();
  await dialog(page)
    .getByLabel("公开简介", { exact: true })
    .fill("IF 线的新简介");
  await dialog(page)
    .getByRole("button", { name: "保存为新的结果版本" })
    .click();
  await expect(
    dialog(page).getByText("IF 线的新简介", { exact: true }),
  ).toBeVisible();
  await dialog(page).getByText("与上一版对照", { exact: true }).click();
  await expect(dialog(page).locator(".generator-compare")).toContainText(
    "IF 线的新简介",
  );
  await expect(dialog(page).locator(".generator-compare")).not.toContainText(
    "targetId",
  );
  await dialog(page)
    .getByLabel("结果版本")
    .first()
    .selectOption({ label: "版本 1 · 已保存" });
  await dialog(page).getByRole("button", { name: "恢复为新版本" }).click();
  await expect(
    dialog(page).getByLabel("结果版本").first().locator("option"),
  ).toHaveCount(3);
  expect(await readStore(page, "generatorSessions")).toHaveLength(1);
});
test("refresh restores answers and original snapshots; retry keeps original prompts and does not repeat successful steps", async ({
  page,
}) => {
  await seed(page);
  const requests = await mocked(page, { failCard: true });
  await setup(page);
  await dialog(page)
    .getByRole("button", { name: "确认目标与参考，开始访谈" })
    .click();
  await expect(
    dialog(page).getByRole("checkbox", { name: "照顾家人", exact: true }),
  ).toBeVisible();
  await dialog(page)
    .getByRole("checkbox", { name: "照顾家人", exact: true })
    .check();
  await expect(
    dialog(page).getByText("已自动保存", { exact: true }),
  ).toBeVisible();
  await dialog(page).getByRole("button", { name: "关闭", exact: true }).click();
  await page.reload();
  await open(page);
  await expect(
    dialog(page).getByRole("checkbox", { name: "照顾家人", exact: true }),
  ).toBeChecked();
  await answer(page);
  await expect(dialog(page).getByRole("alert")).toContainText("500");
  await page.evaluate(async () => {
    const { db } = await import("/src/db.ts");
    await db.preferences.update("preferences", {
      prompts: {
        generatorCompose: {
          text: "NEW_PROMPT_SHOULD_NOT_ENTER_RETRY",
          enabled: true,
        },
      },
    });
  });
  await dialog(page).getByText("请求记录与恢复", { exact: true }).click();
  await dialog(page)
    .getByRole("button", { name: "从此批次未完成处继续" })
    .first()
    .click();
  await expect(dialog(page).getByTestId("generator-result")).toHaveCount(2);
  expect(JSON.stringify(requests.at(-2))).not.toContain(
    "NEW_PROMPT_SHOULD_NOT_ENTER_RETRY",
  );
  expect(requests.filter((x) => x.p.task === "interview")).toHaveLength(2);
});
for (const width of [1280, 390, 360])
  test(`draft ${width}: collapse, reload and resume preserve manual edits; world rename keeps versions`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await seed(page);
    const requests = await mocked(page);
    await setup(page);
    const d = dialog(page);
    await d.getByRole("button", { name: "确认目标与参考，开始访谈" }).click();
    await expect(
      d.getByRole("checkbox", { name: "照顾家人", exact: true }),
    ).toBeVisible();
    await answer(page);
    if (width < 700)
      await d.getByRole("tab", { name: "结果", exact: true }).click();
    await expect(d.getByTestId("generator-result")).toHaveCount(2);
    const roleResult = d
      .getByTestId("generator-result")
      .filter({ hasText: "河畔书屋的店主" });
    await roleResult.getByRole("button", { name: "编辑这版" }).click();
    await d
      .getByLabel("公开简介", { exact: true })
      .fill("还没采用的修改，收起之后也要在。");
    await d.getByRole("button", { name: "收起编辑草稿" }).click();
    await expect(d.getByLabel("公开简介", { exact: true })).toHaveCount(0);
    await d
      .getByRole("button", { name: "继续编辑草稿" })
      .scrollIntoViewIfNeeded();
    await mkdir("outputs/generator-fixes", { recursive: true });
    await page.screenshot({
      path: `outputs/generator-fixes/${width}-collapsed.png`,
      fullPage: true,
    });
    await d.getByRole("button", { name: "关闭", exact: true }).click();
    await page.reload();
    await open(page);
    if (width < 700)
      await d.getByRole("tab", { name: "结果", exact: true }).click();
    await expect(d.getByRole("button", { name: "继续编辑草稿" })).toBeVisible();
    // Re-selecting the same version resumes the draft instead of resetting it.
    await roleResult.getByRole("button", { name: "编辑这版" }).click();
    await expect(d.getByLabel("公开简介", { exact: true })).toHaveValue(
      "还没采用的修改，收起之后也要在。",
    );
    page.once("dialog", (confirm) => confirm.dismiss());
    await d.getByRole("button", { name: "放弃修改", exact: true }).click();
    await expect(d.getByLabel("公开简介", { exact: true })).toHaveValue(
      "还没采用的修改，收起之后也要在。",
    );
    await d.getByRole("button", { name: "保存为新的结果版本" }).click();
    await expect(d.getByLabel("公开简介", { exact: true })).toHaveCount(0);
    const worldResult = d
      .getByTestId("generator-result")
      .filter({ hasText: "IF 河畔书屋" });
    await worldResult.getByRole("button", { name: "编辑这版" }).click();
    await d.getByLabel("标题", { exact: true }).fill("深冬仍然亮灯的书屋");
    await d.getByRole("button", { name: "保存为新的结果版本" }).click();
    await expect(d.getByTestId("generator-result")).toHaveCount(2);
    const renamed = d
      .getByTestId("generator-result")
      .filter({ hasText: "深冬仍然亮灯的书屋" });
    await expect(renamed.getByLabel("结果版本").locator("option")).toHaveCount(
      2,
    );
    await renamed.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: `outputs/generator-fixes/${width}-versions.png`,
      fullPage: true,
    });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await renamed.getByLabel("结果版本").selectOption({ label: "版本 1" });
    await worldResult.getByRole("button", { name: "恢复为新版本" }).click();
    await expect(
      worldResult.getByLabel("结果版本").locator("option"),
    ).toHaveCount(3);
    expect(requests).toHaveLength(4);
  });

test("superseded requests recover in an independent conversation without another automatic API call", async ({
  page,
}) => {
  await seed(page);
  await setup(page);
  await page.route("https://generator.fixture.test/**", (route) =>
    route.fulfill({ status: 500, body: "旧请求失败" }),
  );
  const d = dialog(page);
  await d.getByRole("button", { name: "确认目标与参考，开始访谈" }).click();
  await expect(d.getByRole("alert")).toContainText("500");
  await page.unroute("https://generator.fixture.test/**");
  const requests = await mocked(page);
  await d
    .getByLabel("补充想法", { exact: true })
    .fill("这是新的方向，不要被旧回复覆盖");
  await d.getByRole("button", { name: "发送并继续", exact: true }).click();
  await expect(
    d.getByRole("checkbox", { name: "照顾家人", exact: true }),
  ).toBeVisible();
  const before = (await readStore(page, "generatorSessions"))[0];
  await d.getByText("请求记录与恢复", { exact: true }).click();
  await expect(
    d.getByRole("button", { name: "从此批次未完成处继续" }),
  ).toBeDisabled();
  await d.getByRole("button", { name: "在独立会话恢复" }).click();
  await expect
    .poll(async () => (await readStore(page, "generatorSessions")).length)
    .toBe(2);
  await expect(
    d.getByRole("button", { name: "从此批次未完成处继续" }),
  ).toBeEnabled();
  expect(requests).toHaveLength(1);
  await mkdir("outputs/generator-fixes", { recursive: true });
  await d
    .getByRole("button", { name: "从此批次未完成处继续" })
    .scrollIntoViewIfNeeded();
  await page.screenshot({
    path: "outputs/generator-fixes/recovery.png",
    fullPage: true,
  });
  await d.getByRole("button", { name: "从此批次未完成处继续" }).click();
  await expect(d.getByTestId("generator-result")).toHaveCount(2);
  expect(requests[1].p.history.map((t: any) => t.text)).not.toContain(
    "这是新的方向，不要被旧回复覆盖",
  );
  expect(
    (await readStore(page, "generatorSessions")).find((s) => s.id === before.id)
      .turnIds,
  ).toEqual(before.turnIds);
});

for (const width of [1280, 390, 360])
  test(`visual ${width}: material picker, questions, results and connection stay within viewport`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await seed(page);
    await mocked(page);
    await setup(page);
    await mkdir("outputs/generator", { recursive: true });
    await page.screenshot({
      path: `outputs/generator/${width}-materials.png`,
      fullPage: true,
    });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await dialog(page)
      .getByRole("button", { name: "确认目标与参考，开始访谈" })
      .click();
    await expect(
      dialog(page).getByRole("checkbox", { name: "照顾家人", exact: true }),
    ).toBeVisible();
    await dialog(page)
      .getByRole("checkbox", { name: "照顾家人", exact: true })
      .scrollIntoViewIfNeeded();
    await page.screenshot({
      path: `outputs/generator/${width}-questions.png`,
      fullPage: true,
    });
    await answer(page);
    if (width < 700)
      await dialog(page)
        .getByRole("tab", { name: "结果", exact: true })
        .click();
    await expect(dialog(page).getByTestId("generator-result")).toHaveCount(2);
    await dialog(page)
      .getByTestId("generator-result")
      .first()
      .scrollIntoViewIfNeeded();
    await dialog(page)
      .getByTestId("generator-result")
      .first()
      .locator("summary")
      .first()
      .click();
    await page.screenshot({
      path: `outputs/generator/${width}-results.png`,
      fullPage: true,
    });
    await dialog(page)
      .getByRole("button", { name: "接口设置", exact: true })
      .click();
    await dialog(page).getByLabel("连接方式").selectOption("dedicated");
    await page.screenshot({
      path: `outputs/generator/${width}-connection.png`,
      fullPage: true,
    });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  });
test("dedicated API and editable generator prompts work while general configuration stays unchanged", async ({
  page,
}) => {
  await seed(page);
  await open(page);
  const d = dialog(page);
  await d.getByRole("button", { name: "接口设置", exact: true }).click();
  await d.getByLabel("连接方式").selectOption("dedicated");
  await d
    .getByLabel("接口地址", { exact: true })
    .fill("https://dedicated.fixture.test/v1");
  await d.getByLabel("模型", { exact: true }).fill("dedicated");
  await d.getByLabel("温度", { exact: true }).fill("0.2");
  await d.getByRole("button", { name: "保存生成器连接" }).click();
  await expect(d.getByText("生成器连接已保存")).toBeVisible();
  const prefs = (await readStore(page, "preferences"))[0];
  expect(prefs.activeProfile).toBe("generator-test");
  expect(prefs.generatorProfileId).not.toBe("generator-test");
  expect(
    (await readStore(page, "profiles")).find(
      (p) => p.id === prefs.generatorProfileId,
    ).temperature,
  ).toBe(0.2);
  await d.getByRole("button", { name: "关闭", exact: true }).click();
  await page.evaluate(async () => {
    const { db } = await import("/src/db.ts");
    await db.preferences.update("preferences", { developer: true });
  });
  await page.goto("/#settings");
  await page.reload();
  await expect(
    page.getByRole("option", { name: "访谈与提问", exact: true }),
  ).toHaveCount(1);
  await expect(
    page.getByRole("option", { name: "IF 线推演", exact: true }),
  ).toHaveCount(1);
  await expect(
    page.getByRole("option", { name: "角色卡与世界书成稿", exact: true }),
  ).toHaveCount(1);
  await page.setViewportSize({ width: 360, height: 900 });
  await page
    .getByRole("combobox", { name: "编辑提示词", exact: true })
    .selectOption("generatorCompose");
  await page
    .getByRole("textbox", { name: "自定义内部提示词", exact: true })
    .scrollIntoViewIfNeeded();
  await page.screenshot({
    path: "outputs/generator/360-prompts.png",
    fullPage: true,
  });
});
test("storage errors keep the author's editor content visible and prevent closing until saved", async ({
  page,
}) => {
  await seed(page);
  await open(page);
  await page.evaluate(async () => {
    const { db } = await import("/src/db.ts");
    const table = db.generatorSessions as any;
    table.originalPut = table.put.bind(table);
    table.put = async () => {
      throw Error("模拟存储空间不足");
    };
  });
  const field = dialog(page).getByLabel("这次想怎么写", { exact: true });
  await field.fill("这段没有保存成功的想法不能丢失");
  await expect(dialog(page).getByRole("alert")).toContainText("存储空间不足");
  await dialog(page)
    .getByRole("button", { name: "确认目标与参考，开始访谈" })
    .click();
  await expect(field).toHaveValue("这段没有保存成功的想法不能丢失");
  await dialog(page).getByRole("button", { name: "关闭", exact: true }).click();
  await expect(dialog(page)).toBeVisible();
  await page.evaluate(async () => {
    const { db } = await import("/src/db.ts");
    const table = db.generatorSessions as any;
    table.put = table.originalPut;
  });
  await dialog(page).getByRole("button", { name: "关闭", exact: true }).click();
  await expect(dialog(page)).toHaveCount(0);
});
