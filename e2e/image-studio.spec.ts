import { test, expect, type Page } from "@playwright/test";
import { readFileSync, mkdirSync } from "node:fs";
import { seedJourney, readStore } from "./fixtures";

const bitmap = readFileSync("src/assets/decor/chat-banner-v1.webp");
async function configure(page: Page) {
  await seedJourney(page);
  await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve) => {
      const r = indexedDB.open("little-scene-v1");
      r.onsuccess = () => resolve(r.result);
    });
    const tx = db.transaction(
      ["profiles", "preferences", "events"],
      "readwrite",
    );
    tx.objectStore("profiles").put({
      id: "text-studio",
      name: "Text fixture",
      protocol: "chat",
      url: "https://text-studio.fixture.test/v1",
      model: "fixture",
      stream: false,
      context: 64000,
      maxOutput: 4000,
      timeout: 10,
      remember: true,
      key: "fixture-text-key",
    });
    tx.objectStore("preferences").put({
      id: "preferences",
      activeProfile: "text-studio",
      developer: true,
      prompts: {},
    });
    const event = {
      id: "studio-event",
      storyId: "fixture-story",
      kind: "novel",
      origin: "ai",
      seq: Date.now(),
      speaker: "",
      participants: ["fixture-role-a", "fixture-role-b"],
      input: "",
      text: "周屿穿着白衬衫，站在书店窗边递出一杯茶。",
      pin: false,
      deleted: false,
      status: "complete",
      versionId: "studio-v1",
      created: Date.now(),
    };
    tx.objectStore("events").put({
      ...event,
      versions: [
        {
          id: event.versionId,
          text: event.text,
          input: "",
          created: event.created,
        },
      ],
    });
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  });
  await page.goto("/#settings");
  await page.getByLabel("生图接口预设名称", { exact: true }).fill("文字生图");
  await page
    .getByLabel("生图接口地址", { exact: true })
    .fill("https://studio.fixture.test/v1");
  await page
    .getByLabel("生图 API Key", { exact: true })
    .fill("fixture-image-key");
  await page.getByLabel("生图模型", { exact: true }).fill("studio-image");
  await page.getByLabel("在此设备记住生图密钥", { exact: true }).check();
  await page.getByRole("button", { name: "保存生图配置", exact: true }).click();
  await expect
    .poll(async () => (await readStore(page, "imageProfiles")).length)
    .toBe(1);
}

test("image studio presets switch without requests, edit/import/export and preserve distinct keys", async ({
  page,
}) => {
  let calls = 0;
  await page.route("https://*.fixture.test/**", (r) => {
    calls++;
    return r.abort();
  });
  page.on("dialog", (d) => d.accept());
  await configure(page);
  const initial = (await readStore(page, "imageProfiles"))[0];
  await page
    .getByRole("button", { name: "另存为新接口预设", exact: true })
    .click();
  await expect
    .poll(async () => (await readStore(page, "imageProfiles")).length)
    .toBe(2);
  await page.getByLabel("生图接口预设名称", { exact: true }).fill("参考图生图");
  await page
    .getByLabel("生图 API Key", { exact: true })
    .fill("fixture-second-key");
  await page.getByRole("button", { name: "保存生图配置", exact: true }).click();
  const selector = page.getByLabel("当前生图接口预设", { exact: true });
  await selector.selectOption(initial.id);
  await expect(page.getByLabel("生图 API Key", { exact: true })).toHaveValue(
    "fixture-image-key",
  );
  const other = (await readStore(page, "imageProfiles")).find(
    (p) => p.id !== initial.id,
  )!;
  await selector.selectOption(other.id);
  await expect(page.getByLabel("生图 API Key", { exact: true })).toHaveValue(
    "fixture-second-key",
  );
  await page
    .getByRole("button", { name: "复制为自定义画风", exact: true })
    .click();
  await page.getByLabel("画风名称", { exact: true }).fill("我的柔光厚涂");
  await page
    .getByLabel("正向画风提示词", { exact: true })
    .fill("韩系半写实，柔和的暖光与细腻发丝，保留固定骨相。");
  await page.getByRole("button", { name: "保存画风预设", exact: true }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "画风已保存" }),
  ).toBeVisible();
  await page.getByText("画面编排提示词", { exact: true }).click();
  await page
    .getByLabel("正文画面编排", { exact: true })
    .fill("使用克制的中景和侧光。");
  await page.getByLabel("启用此编排提示词", { exact: true }).first().check();
  await page.getByRole("button", { name: "保存正文编排", exact: true }).click();
  const saved = (await readStore(page, "preferences"))[0];
  expect(saved.imagePromptOverrides.novel.text).toContain("中景");
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出绘画预设", exact: true }).click();
  const file = await download;
  const exported = readFileSync((await file.path())!, "utf8");
  expect(exported).toContain("我的柔光厚涂");
  expect(exported).not.toContain("fixture-second-key");
  await page.getByLabel("导入绘画预设", { exact: true }).setInputFiles({
    name: "styles.json",
    mimeType: "application/json",
    buffer: Buffer.from(exported),
  });
  await expect(
    page.getByRole("status").filter({ hasText: "绘画预设已导入" }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page
      .getByLabel("编辑绘画预设", { exact: true })
      .locator("option")
      .filter({ hasText: "我的柔光厚涂" }),
  ).toHaveCount(1);
  await page.setViewportSize({ width: 390, height: 844 });
  await page
    .getByRole("heading", { name: "绘画工作室 · 开发者" })
    .scrollIntoViewIfNeeded();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  mkdirSync("work/image-studio-qa", { recursive: true });
  await page.screenshot({ path: "work/image-studio-qa/developer-mobile.png" });
  await page
    .getByRole("button", { name: "删除当前接口预设", exact: true })
    .click();
  await expect
    .poll(async () => (await readStore(page, "imageProfiles")).length)
    .toBe(1);
  await expect(page.getByLabel("生图 API Key", { exact: true })).toHaveValue(
    "fixture-image-key",
  );
  await page
    .getByRole("button", { name: "新建生图接口预设", exact: true })
    .click();
  await expect(page.getByLabel("生图 API Key", { exact: true })).toHaveValue(
    "",
  );
  await expect(page.getByLabel("生图接口地址", { exact: true })).toHaveValue(
    "",
  );
  expect(calls).toBe(0);
});

test("character appearance, approved references and per-picture repaint preserve history and actual prompt", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const requests: any[] = [];
  await page.route("https://text-studio.fixture.test/**", (route) =>
    route.fulfill({
      json: {
        choices: [
          {
            message: {
              content: JSON.stringify({
                generate: true,
                description: "周屿在书店窗边递出热茶",
                selfie: false,
                roleIds: ["fixture-role-a"],
                reason: "",
              }),
            },
            finish_reason: "stop",
          },
        ],
      },
    }),
  );
  await page.route("https://studio.fixture.test/**", (route) => {
    requests.push(route.request().postDataJSON());
    return route.fulfill({
      json: { data: [{ b64_json: bitmap.toString("base64") }] },
    });
  });
  await configure(page);
  await page.goto("/#story/fixture-story");
  await page.getByRole("button", { name: "故事设置", exact: true }).click();
  await page
    .getByLabel("绘画风格预设", { exact: true })
    .selectOption("korean-3d");
  await page
    .getByRole("button", { name: "编辑故事人设", exact: true })
    .first()
    .click();
  const editor = page.getByRole("dialog").last();
  await editor.getByText("角色定妆与拍照习惯", { exact: true }).click();
  await editor
    .getByLabel("插画外貌设定 · 固定长相", { exact: true })
    .fill("灰绿色眼睛，左眼下有一颗痣，黑色短发。");
  await editor.getByLabel("本场造型", { exact: true }).fill("白衬衫，袖口卷起");
  await editor.getByLabel("添加人物参考图", { exact: true }).setInputFiles({
    name: "identity.webp",
    mimeType: "image/webp",
    buffer: bitmap,
  });
  await expect(editor.locator(".character-reference-card")).toHaveCount(1);
  await editor
    .getByLabel("适用画风", { exact: true })
    .selectOption("korean-3d");
  await page.setViewportSize({ width: 390, height: 844 });
  await editor.getByLabel("本场造型", { exact: true }).scrollIntoViewIfNeeded();
  mkdirSync("work/image-studio-qa", { recursive: true });
  await page.screenshot({ path: "work/image-studio-qa/character-mobile.png" });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await editor.getByRole("button", { name: "保存角色", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(1);
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await page.getByRole("button", { name: "为这一幕配图", exact: true }).click();
  const panel = page.locator(".novel-image-panel");
  await expect(panel.locator('[data-image-status="complete"]')).toHaveCount(1);
  expect(requests).toHaveLength(1);
  expect(requests[0].prompt).toContain("灰绿色眼睛");
  expect(requests[0].prompt).toContain("白衬衫，袖口卷起");
  expect(requests[0].prompt).toContain("韩系高完成度");
  await panel.locator(".image-job-settings > summary").first().click();
  await expect(
    panel.getByLabel("实际发送的生图提示词", { exact: true }),
  ).toHaveValue(requests[0].prompt);
  await expect(panel.locator(".image-job-settings")).toContainText("文字外貌");
  await page
    .getByRole("button", { name: "采用为角色定妆图", exact: true })
    .click();
  await page.getByLabel("定妆适用画风", { exact: true }).selectOption("");
  await page
    .getByRole("button", { name: "确认采用定妆图", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(
    (await readStore(page, "stories")).find((s) => s.id === "fixture-story")
      ?.roles[0].imageReferences,
  ).toHaveLength(2);
  await panel.getByText("本张画风与人物外貌", { exact: true }).click();
  await page.getByLabel("本张画风", { exact: true }).selectOption("watercolor");
  await page
    .getByLabel("本次仅用文字外貌（适合不支持参考图的模型）", { exact: true })
    .check();
  expect(requests).toHaveLength(1);
  await page.getByRole("button", { name: "按新画风重绘", exact: true }).click();
  await expect
    .poll(
      async () =>
        (await readStore(page, "imageJobs")).filter(
          (j) => j.status === "complete",
        ).length,
    )
    .toBe(2);
  expect(requests[1].prompt).toContain("精致水彩绘本");
  expect(requests[1].prompt).toContain("灰绿色眼睛");
  await panel.getByText("已有配图与旧版本（1）", { exact: true }).click();
  await expect(panel.locator(".generated-image-open img")).toHaveCount(2);
  await page.screenshot({ path: "work/image-studio-qa/repaint-mobile.png" });
  await page.reload();
  expect(requests).toHaveLength(2);
  expect(errors).toEqual([]);
});
