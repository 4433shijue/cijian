import { test, expect, type Page } from "@playwright/test";
import { seedJourney, readStore } from "./fixtures";
import { completionDimensions } from "../src/role-completion-types";

const d = (page: Page) =>
  page.getByRole("dialog", { name: "写角色卡 · 陪我捏角色", exact: true });
async function seed(page: Page) {
  await seedJourney(page);
  await page.evaluate(async () => {
    const { db } = await import("/src/db.ts");
    await db.profiles.put({
      id: "workshop-fixture",
      name: "模拟创作",
      url: "https://workshop.fixture.test/v1",
      protocol: "chat",
      model: "fixture",
      stream: false,
      context: 64000,
      maxOutput: 6000,
      timeout: 20,
      remember: true,
      key: "workshop-fixture-only",
    });
    await db.preferences.put({
      id: "preferences",
      activeProfile: "workshop-fixture",
      developer: false,
      prompts: {},
    });
  });
  await page.goto("/#roles");
}
async function mock(page: Page, bad = false) {
  const requests: any[] = [];
  await page.route("https://workshop.fixture.test/**", async (route) => {
    const body = route.request().postDataJSON(),
      p = JSON.parse(body.messages.at(-1).content);
    requests.push(p);
    const swapped = p.history.at(-1)?.action === "refresh";
    const directions = swapped
      ? ["好奇探索", "追求事业", "重建家园", "艺术表达"]
      : ["习惯独立", "守护秘密", "人生志向", "天性自在"];
    const texts = swapped
      ? [
          "想去陌生地方发现未被记载的事物。",
          "把一门手艺做到极致是他全部的愿望。",
          "失去的故乡需要有人重新建起家园。",
          "通过画笔表达心中无法说出口的感受。",
        ]
      : [
          "从小独立生活，不习惯接受他人的照顾。",
          "需要隐藏身份，亲近他会让别人遇到危险。",
          "计划远赴异乡实现梦想，不愿留下感情牵挂。",
          "喜欢自由来往，认为亲密也应该留有个人空间。",
        ];
    const q = {
      id: "distance",
      text: "他为何保持距离？",
      multiple: false,
      options: directions
        .slice(0, bad ? 3 : 4)
        .map((direction, i) => ({ id: String(i), direction, text: texts[i] })),
    };
    const content =
      p.task === "interview"
        ? {
            message: "我们先把这个人的内心想清楚。",
            confirmed: p.confirmedSettings.length
              ? p.confirmedSettings
              : ["温柔但有距离感"],
            conflicts: [],
            unknown: ["姓名可以稍后确定"],
            questions:
              p.input.pace === "quick"
                ? [q, { ...q, id: "life", text: "他想过怎样的生活？" }]
                : [q],
            ready: false,
          }
        : p.task === "card"
          ? {
              targetId: p.targetId,
              name: p.input.targets.find((t: any) => t.id === p.targetId)
                .autoName
                ? `人物${p.input.targets.findIndex((t: any) => t.id === p.targetId) + 1}`
                : p.input.targets.find((t: any) => t.id === p.targetId).name,
              bio: "住在海边的修船匠",
              sections: completionDimensions.map((title) => ({
                title,
                content: `${title}：温柔而独立，习惯把关心落实在行动里。`,
                basis: "created",
                evidence: "",
                sourceIds: [],
              })),
              preserved: [],
              changed: [],
              reasons: [],
            }
          : { worlds: [] };
    if (p.task === "interview" && p.history.at(-1)?.text === "请整理第一版") {
      (content as any).questions = [];
      (content as any).ready = true;
    }
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
async function open(page: Page) {
  await (
    (await page.getByRole("dialog").count()) ? page.getByRole("dialog") : page
  )
    .getByRole("button", { name: "陪我捏角色", exact: true })
    .click();
  await expect(d(page).getByLabel("这次想怎么捏")).toBeVisible();
}
async function start(page: Page) {
  await d(page)
    .getByRole("button", { name: "开始一起捏角色", exact: true })
    .click();
  await expect(
    d(page).getByRole("button", { name: "5. 我自己写", exact: true }).first(),
  ).toBeVisible();
}

test("handwritten draft, four choices, custom correction, floating settings, refresh resume and return to writing", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await seed(page);
  const requests = await mock(page);
  await page.getByRole("button", { name: "添加角色", exact: true }).click();
  await page.getByLabel("名字", { exact: true }).fill("沈遥");
  await page.getByLabel("完整人设").fill("温柔但有距离感，不要情伤套路。");
  await open(page);
  await d(page).getByLabel("角色定位 1", { exact: true }).selectOption("攻");
  await start(page);
  expect(requests[0].input.source).toContain("不要情伤套路");
  await expect(d(page).locator(".generator-option")).toHaveCount(4);
  await page.screenshot({
    path: "outputs/workshop/desktop-options.png",
    fullPage: true,
  });
  await d(page).getByRole("radio").first().check();
  await d(page)
    .getByLabel("自定义补充", { exact: true })
    .fill("选一，但不要安排悲惨身世。");
  await d(page)
    .getByRole("button", { name: "发送并继续", exact: true })
    .click();
  await expect.poll(() => requests.length).toBe(2);
  await expect(
    d(page).getByRole("button", { name: "发送并继续", exact: true }),
  ).toBeEnabled();
  expect(requests[1].history.at(-1).answers[0].text).toContain(
    "不要安排悲惨身世",
  );
  await d(page)
    .getByRole("button", { name: "已确定设定 · 1", exact: true })
    .click();
  await d(page)
    .getByRole("button", { name: "修改设定 1", exact: true })
    .click();
  await d(page)
    .getByLabel("修改设定内容")
    .fill("他是温柔独立的修船匠，没有情伤");
  await d(page).getByRole("button", { name: "保存设定", exact: true }).click();
  await expect(d(page).getByLabel("修改设定内容")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(d(page)).toBeVisible();
  await expect(d(page).locator(".workshop-floating-toggle")).toHaveAttribute(
    "aria-expanded",
    "false",
  );
  await d(page)
    .getByRole("button", { name: "5. 我自己写", exact: true })
    .click();
  await d(page)
    .getByLabel("自定义补充", { exact: true })
    .fill("他习惯独立，也愿意学习依赖别人");
  await d(page)
    .getByRole("button", { name: "发送并继续", exact: true })
    .click();
  await expect.poll(() => requests.length).toBe(3);
  await expect(
    d(page).getByRole("button", { name: "发送并继续", exact: true }),
  ).toBeEnabled();
  expect(requests[2].confirmedSettings).toContain(
    "他是温柔独立的修船匠，没有情伤",
  );
  expect(requests[2].history.at(-1).answers[0].options).toEqual([]);
  await page.reload();
  await page.getByRole("button", { name: "陪我捏角色", exact: true }).click();
  await expect(
    d(page).getByRole("button", { name: "5. 我自己写", exact: true }),
  ).toBeVisible();
  expect(requests).toHaveLength(3);
  await d(page)
    .getByRole("button", { name: "换一组选项", exact: true })
    .click();
  await expect(d(page).getByText("1. 好奇探索", { exact: true })).toBeVisible();
  expect(requests.at(-1).history.at(-1).answers).toEqual([]);
  await d(page)
    .getByRole("button", { name: "先生成一版", exact: true })
    .click();
  await expect(d(page).getByTestId("generator-result")).toHaveCount(1);
  await d(page)
    .getByRole("button", { name: "带回自己写", exact: true })
    .click();
  await expect(page.getByLabel("名字", { exact: true })).toHaveValue("沈遥");
  await expect(page.getByLabel("完整人设")).toHaveValue(/基础身份/);
  await page.getByRole("button", { name: "保存角色", exact: true }).click();
  expect(await readStore(page, "roles")).toHaveLength(3);
});

for (const width of [360, 390])
  test(`mobile ${width} floating settings fold without hiding the conversation, drafts survive switching`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 844 });
    await seed(page);
    await mock(page);
    await open(page);
    await start(page);
    await d(page)
      .getByRole("button", { name: "已确定设定 · 1", exact: true })
      .click();
    const box = await d(page).locator(".workshop-floating").boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(width);
    expect(box!.y).toBeGreaterThanOrEqual(0);
    expect(box!.y + box!.height).toBeLessThanOrEqual(844);
    await page.screenshot({
      path: `outputs/workshop/mobile-${width}-settings.png`,
      fullPage: true,
    });
    await d(page)
      .getByRole("button", { name: "收起已确定设定", exact: true })
      .click();
    await d(page)
      .getByLabel("自定义补充", { exact: true })
      .fill("还没有发送的自定义想法");
    await d(page).getByRole("button", { name: "自己写", exact: true }).click();
    await page.getByLabel("完整人设").fill("在自己写里添加了修船匠的职业");
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "陪我捏角色", exact: true })
      .click();
    await expect(d(page).getByLabel("自定义补充", { exact: true })).toHaveValue(
      "还没有发送的自定义想法",
    );
    expect(
      await d(page).evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
    ).toBe(true);
    await page.screenshot({
      path: `outputs/workshop/mobile-${width}-folded.png`,
      fullPage: true,
    });
  });

test("pair creates two cards, quick mode has two questions, library sources remain untouched", async ({
  page,
}) => {
  await seed(page);
  const original = await readStore(page, "roles");
  const requests = await mock(page);
  await open(page);
  await d(page).getByLabel("这次想怎么捏").selectOption("pair");
  await d(page).getByLabel("角色定位 1", { exact: true }).selectOption("男主");
  await d(page).getByLabel("角色定位 2", { exact: true }).selectOption("女主");
  await d(page).getByLabel("聊天节奏").selectOption("quick");
  await start(page);
  await expect(
    d(page).getByRole("button", { name: "5. 我自己写", exact: true }),
  ).toHaveCount(2);
  await d(page)
    .getByRole("button", { name: "这轮先跳过", exact: true })
    .click();
  await expect.poll(() => requests.length).toBe(2);
  await expect(
    d(page).getByRole("button", { name: "先生成一版", exact: true }),
  ).toBeEnabled();
  expect(
    requests[1].history
      .at(-1)
      .answers.every((a: any) => a.disposition === "blank"),
  ).toBe(true);
  await d(page)
    .getByRole("button", { name: "先生成一版", exact: true })
    .click();
  await expect(d(page).getByTestId("generator-result")).toHaveCount(2);
  for (const article of await d(page).getByTestId("generator-result").all())
    await article.getByRole("checkbox").first().check();
  await d(page)
    .getByRole("button", { name: "将勾选结果另存到库", exact: true })
    .click();
  await expect
    .poll(async () => (await readStore(page, "roles")).length)
    .toBe(4);
  const after = await readStore(page, "roles");
  for (const r of original)
    expect(after.find((a: any) => a.id === r.id)).toEqual(r);
});

test("partner references a selected existing character without adding it as a target", async ({
  page,
}) => {
  await seed(page);
  const requests = await mock(page);
  await open(page);
  await d(page).getByLabel("这次想怎么捏").selectOption("partner");
  await d(page).getByLabel("为谁捏搭档").selectOption("fixture-role-a");
  await d(page).getByLabel("角色定位 1", { exact: true }).selectOption("受");
  await start(page);
  expect(requests[0].input.targets).toHaveLength(1);
  expect(requests[0].materials[0].purpose).toBe("relationship");
  expect(requests[0].materials[0].text).toContain("周屿");
});

test("invalid four-choice output is recoverable and does not trigger additional requests", async ({
  page,
}) => {
  await seed(page);
  const requests = await mock(page, true);
  await open(page);
  await d(page)
    .getByRole("button", { name: "开始一起捏角色", exact: true })
    .click();
  await expect(d(page).getByRole("alert")).toContainText("四个不同方向");
  await expect(
    d(page).getByRole("button", { name: "发送并继续", exact: true }),
  ).toBeEnabled();
  expect(requests).toHaveLength(1);
  const steps = await readStore(page, "generatorSteps");
  expect(steps[0].status).toBe("failed");
  expect(steps[0].raw).toContain("习惯独立");
});

test("automatic composition opens results and the same conversation can continue", async ({
  page,
}) => {
  await seed(page);
  const requests = await mock(page);
  await open(page);
  await start(page);
  await d(page).getByLabel("补充想法", { exact: true }).fill("请整理第一版");
  await d(page)
    .getByRole("button", { name: "发送并继续", exact: true })
    .click();
  await expect(d(page).getByTestId("generator-result")).toBeVisible();
  await expect(
    d(page).getByRole("tab", { name: "结果", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await d(page).getByRole("tab", { name: "对话", exact: true }).click();
  await d(page)
    .getByLabel("继续修改这版角色", { exact: true })
    .fill("进一步讨论他的说话方式");
  await d(page)
    .getByRole("button", { name: "发送并继续", exact: true })
    .click();
  await expect(
    d(page).getByRole("button", { name: "5. 我自己写", exact: true }),
  ).toBeVisible();
  expect(requests.at(-1).existingResults).toHaveLength(1);
});
