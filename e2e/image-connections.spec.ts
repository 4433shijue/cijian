import { test, expect, type Page } from "@playwright/test";
import { readFileSync, mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { seedJourney, readStore } from "./fixtures";

const bitmap = readFileSync("src/assets/decor/chat-banner-v1.webp").toString(
  "base64",
);
const image = "data:image/webp;base64," + bitmap;
async function settings(page: Page, url: string) {
  await seedJourney(page);
  await page.goto("/#settings");
  await page.getByLabel("生图接口地址", { exact: true }).fill(url);
  await page
    .getByLabel("生图 API Key", { exact: true })
    .fill("fixture-connection-secret");
}
test("model discovery, chat image stream, tested combinations and responsive settings", async ({
  page,
}) => {
  const calls: string[] = [],
    errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.route("https://connection.fixture.test/**", async (route) => {
    calls.push(
      route.request().method() + " " + new URL(route.request().url()).pathname,
    );
    if (route.request().method() === "GET")
      return route.fulfill({
        json: {
          data: [
            { id: "画室自定义别名" },
            {
              id: "image-output",
              architecture: {
                output_modalities: ["image"],
                input_modalities: ["image"],
              },
            },
            { id: "text-only", architecture: { output_modalities: ["text"] } },
          ],
        },
      });
    const body = route.request().postDataJSON();
    expect(body.model).toBe("image-output");
    expect(body.messages[0].content).toContain("禁止生成自拍");
    expect(body.stream).toBe(true);
    return route.fulfill({
      contentType: "text/event-stream",
      body: `data: ${JSON.stringify({ choices: [{ delta: { images: [{ image_url: { url: image } }] } }] })}\n\ndata: [DONE]\n\n`,
    });
  });
  await settings(
    page,
    "https://connection.fixture.test/proxy/v1/chat/completions",
  );
  await page.getByRole("button", { name: "拉取生图模型", exact: true }).click();
  await expect(
    page.getByLabel("生图模型", { exact: true }).locator("option"),
  ).toHaveCount(4);
  expect(calls).toEqual(["GET /proxy/v1/models"]);
  await page.getByLabel("搜索生图模型", { exact: true }).fill("别名");
  await expect(
    page.getByLabel("生图模型", { exact: true }).locator("option"),
  ).toHaveCount(2);
  await page.getByLabel("搜索生图模型", { exact: true }).fill("");
  await page
    .getByRole("checkbox", { name: "仅显示服务明确标注支持生图的模型" })
    .check();
  await page
    .getByLabel("生图模型", { exact: true })
    .selectOption("image-output");
  await page
    .locator(".image-settings summary")
    .filter({ hasText: "接口兼容设置" })
    .click();
  await page.getByLabel("生图等待秒数", { exact: true }).fill("");
  await expect(
    page.getByRole("heading", { name: "图片生成", exact: true }),
  ).toBeVisible();
  await page.getByLabel("生图等待秒数", { exact: true }).fill("180");
  await page
    .getByRole("checkbox", { name: "请求流式返回（服务需支持）", exact: true })
    .check();
  await page
    .getByRole("button", { name: "生成测试图（消耗一次额度）", exact: true })
    .click();
  await expect(page.locator(".image-test-preview")).toBeVisible();
  expect(calls).toEqual([
    "GET /proxy/v1/models",
    "POST /proxy/v1/chat/completions",
  ]);
  await expect(page.locator(".image-connection-status")).toContainText(
    "当前生图：测试成功",
  );
  await page.getByRole("button", { name: "保存生图配置", exact: true }).click();
  await expect
    .poll(
      async () => (await readStore(page, "imageProfiles"))[0]?.verified.length,
    )
    .toBe(1);
  expect(JSON.stringify(await readStore(page, "imageProfiles"))).not.toContain(
    "fixture-connection-secret",
  );
  await page.reload();
  await expect(page.getByLabel("生图 API Key", { exact: true })).toHaveValue(
    "",
  );
  await expect(page.locator(".image-connection-status")).toContainText(
    "当前生图：未验证",
  );
  await page.getByLabel("生图模型", { exact: true }).fill("other-model");
  await page
    .getByLabel("恢复已测通组合（历史记录）", { exact: true })
    .selectOption("0");
  await expect(page.getByLabel("生图模型", { exact: true })).toHaveValue(
    "image-output",
  );
  expect(calls).toHaveLength(2);
  mkdirSync("work/image-connection-qa", { recursive: true });
  for (const viewport of [
    { width: 1280, height: 900, name: "desktop" },
    { width: 390, height: 844, name: "mobile" },
    { width: 844, height: 390, name: "landscape" },
  ]) {
    await page.setViewportSize(viewport);
    await page
      .getByRole("heading", { name: "图片生成", exact: true })
      .scrollIntoViewIfNeeded();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: `work/image-connection-qa/settings-${viewport.name}.png`,
    });
  }
  expect(errors).toEqual([]);
});
test("missing model list permits manual setup and changing credentials invalidates the list", async ({
  page,
}) => {
  let calls = 0;
  await page.route("https://connection.fixture.test/**", (route) => {
    calls++;
    return route.fulfill({ status: 404, json: { error: "No catalog" } });
  });
  await settings(page, "https://connection.fixture.test/v1");
  await page.getByRole("button", { name: "拉取生图模型", exact: true }).click();
  await expect(page.locator(".image-connection-message")).toContainText("404");
  await page.getByLabel("生图模型", { exact: true }).fill("station-alias");
  await page.getByRole("button", { name: "保存生图配置", exact: true }).click();
  await expect
    .poll(async () => (await readStore(page, "imageProfiles"))[0]?.model)
    .toBe("station-alias");
  expect(calls).toBe(1);
  await page.unroute("https://connection.fixture.test/**");
  await page.route("https://connection.fixture.test/**", (route) =>
    route.fulfill({ json: { data: ["other-alias"] } }),
  );
  await page.getByRole("button", { name: "拉取生图模型", exact: true }).click();
  await expect(
    page.getByLabel("生图模型", { exact: true }).locator("option"),
  ).toHaveCount(3);
  await page
    .getByLabel("生图 API Key", { exact: true })
    .fill("different-fixture-key");
  await expect(page.getByLabel("生图模型", { exact: true })).toHaveAttribute(
    "placeholder",
    /拉取模型/,
  );
  await expect(page.locator(".image-connection-status")).toContainText(
    "模型列表：未验证",
  );
});
test("Gemini discovery and reference image test use native content and header auth", async ({
  page,
}) => {
  let requests = 0;
  await page.route("https://gemini.fixture.test/**", async (route) => {
    requests++;
    expect(route.request().headers()["x-goog-api-key"]).toBe(
      "fixture-connection-secret",
    );
    if (route.request().method() === "GET")
      return route.fulfill({
        json: {
          models: [{ name: "models/native-image", displayName: "Native" }],
        },
      });
    expect(route.request().url()).toBe(
      "https://gemini.fixture.test/v1beta/models/native-image:generateContent",
    );
    const body = route.request().postDataJSON();
    expect(body.contents[0].parts[1].inlineData.mimeType).toBe("image/webp");
    expect(body.generationConfig.responseModalities).toContain("IMAGE");
    return route.fulfill({
      json: {
        candidates: [
          {
            content: {
              parts: [{ inlineData: { mimeType: "image/webp", data: bitmap } }],
            },
          },
        ],
      },
    });
  });
  await settings(page, "https://gemini.fixture.test/v1beta");
  await page.getByLabel("生图协议", { exact: true }).selectOption("gemini");
  await page.getByRole("button", { name: "拉取生图模型", exact: true }).click();
  await page
    .getByLabel("生图模型", { exact: true })
    .selectOption("native-image");
  await page
    .locator(".image-settings summary")
    .filter({ hasText: "接口兼容设置" })
    .click();
  await page.getByLabel("人物参考图", { exact: true }).selectOption("auto");
  await page
    .locator(".image-settings summary")
    .filter({ hasText: "测试参考图" })
    .click();
  await page
    .getByLabel("测试用参考图", { exact: true })
    .setInputFiles("src/assets/decor/chat-banner-v1.webp");
  await expect(page.getByAltText("测试参考图", { exact: true })).toBeVisible();
  await page
    .getByRole("button", { name: "生成测试图（消耗一次额度）", exact: true })
    .click();
  await expect(page.locator(".image-test-preview")).toBeVisible();
  expect(requests).toBe(2);
});
test("custom async generation preserves its endpoint and polls instead of resubmitting", async ({
  page,
}) => {
  const methods: string[] = [];
  await page.route("https://async.fixture.test/**", async (route) => {
    methods.push(route.request().method());
    if (route.request().method() === "POST") {
      expect(route.request().url()).toBe("https://async.fixture.test/render");
      expect(route.request().postDataJSON().input).toContain("禁止生成自拍");
      return route.fulfill({ json: { job: "abc" } });
    }
    expect(route.request().url()).toBe("https://async.fixture.test/jobs/abc");
    return route.fulfill({ json: { status: "done", output: [{ image }] } });
  });
  await settings(page, "https://async.fixture.test/render");
  await page.getByLabel("生图模型", { exact: true }).fill("station-model");
  await page.getByLabel("生图协议", { exact: true }).selectOption("custom");
  await page
    .locator(".image-settings summary")
    .filter({ hasText: "接口兼容设置" })
    .click();
  await page
    .getByLabel("自定义请求模板（JSON）", { exact: true })
    .fill('{"model":"{{model}}","input":"{{prompt}}"}');
  await page
    .getByLabel("图片结果字段路径（可选）", { exact: true })
    .fill("output.0.image");
  await page
    .getByLabel("任务查询地址（可选）", { exact: true })
    .fill("/jobs/{id}");
  await page.getByLabel("任务编号字段", { exact: true }).fill("job");
  await page.getByLabel("查询间隔秒数", { exact: true }).fill("2");
  await page
    .getByRole("button", { name: "生成测试图（消耗一次额度）", exact: true })
    .click();
  await expect(page.locator(".image-test-preview")).toBeVisible();
  expect(methods).toEqual(["POST", "GET"]);
  await page.getByRole("button", { name: "保存生图配置", exact: true }).click();
  await expect
    .poll(async () => (await readStore(page, "imageProfiles"))[0]?.pollUrl)
    .toBe("/jobs/{id}");
});

test("test image diagnostics retain download recovery without another paid request", async ({
  page,
}) => {
  let posts = 0,
    downloads = 0;
  await page.route("https://connection.fixture.test/**", (route) => {
    posts++;
    return route.fulfill({
      json: {
        choices: [
          {
            message: {
              content:
                "![image](https://cdn.fixture.test/result.webp?signature=private-download-fixture)",
            },
          },
        ],
      },
    });
  });
  await page.route("https://cdn.fixture.test/**", (route) => {
    downloads++;
    expect(route.request().headers()).not.toHaveProperty("authorization");
    return route.fulfill(
      downloads === 1
        ? { status: 503, body: "not ready" }
        : { contentType: "image/webp", body: Buffer.from(bitmap, "base64") },
    );
  });
  await settings(page, "https://connection.fixture.test/v1/chat/completions");
  await page.getByLabel("生图模型", { exact: true }).fill("fixture-image");
  await page
    .getByRole("button", { name: "生成测试图（消耗一次额度）", exact: true })
    .click();
  const recovery = page.getByRole("button", {
    name: "重新下载测试图（不重新生图）",
    exact: true,
  });
  await expect(recovery).toBeVisible();
  const diagnostic = page.locator(".image-diagnostics");
  await diagnostic.locator("summary").click();
  await expect(diagnostic).toContainText("HTTP 200");
  await expect(diagnostic).toContainText("HTTP 503");
  await expect(diagnostic).toContainText("下载图片（失败）");
  await expect(diagnostic).not.toContainText("private-download-fixture");
  await expect(diagnostic).not.toContainText("fixture-connection-secret");
  await recovery.click();
  await expect(page.locator(".image-test-preview")).toBeVisible();
  await expect(diagnostic).toContainText("重新下载，没有重新生图");
  expect(posts).toBe(1);
  expect(downloads).toBe(2);
});

test("non-stream response timeout exposes copyable diagnostics on mobile without resubmission", async ({
  page,
}) => {
  let posts = 0;
  await page.route("https://connection.fixture.test/**", () => {
    posts++;
  });
  await settings(page, "https://connection.fixture.test/v1/chat/completions");
  await page.getByLabel("生图模型", { exact: true }).fill("fixture-image");
  await page
    .locator(".image-settings summary")
    .filter({ hasText: "接口兼容设置" })
    .click();
  await page.getByLabel("生图等待秒数", { exact: true }).fill("10");
  await page
    .getByRole("button", { name: "生成测试图（消耗一次额度）", exact: true })
    .click();
  await expect(page.locator(".image-connection-message")).toContainText(
    "等待接口响应超时",
    { timeout: 15000 },
  );
  const diagnostic = page.locator(".image-diagnostics");
  await diagnostic.locator("summary").click();
  await expect(diagnostic).toContainText("尚未收到响应头");
  await page.evaluate(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async () => {
          throw Error("fixture denied");
        },
      },
    });
  });
  await page.getByRole("button", { name: "复制生图诊断", exact: true }).click();
  await expect(page.getByLabel("请选中复制诊断", { exact: true })).toHaveValue(
    /等待接口响应（超时）/,
  );
  expect(posts).toBe(1);
  await page.setViewportSize({ width: 390, height: 844 });
  await diagnostic.scrollIntoViewIfNeeded();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  mkdirSync("work/image-recovery-qa", { recursive: true });
  await page.screenshot({ path: "work/image-recovery-qa/timeout-mobile.png" });
});

for (const mode of ["sse", "partial-json"] as const) {
  test(`gateway connection stays open after ${mode}`, async ({ page }) => {
    let posts = 0;
    const server = createServer((req, res) => {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader(
        "Access-Control-Allow-Headers",
        "Authorization, Content-Type",
      );
      if (req.method === "OPTIONS") {
        res.end();
        return;
      }
      posts++;
      req.resume();
      res.writeHead(200, {
        "Content-Type":
          mode === "sse" ? "text/event-stream" : "application/json",
      });
      if (mode === "sse") {
        res.write(
          `data: ${JSON.stringify({ choices: [{ delta: { images: [{ image_url: { url: image } }] } }] })}\n\ndata: [DONE]\n\n`,
        );
      } else res.write('{"choices":[');
      // Intentionally never end: reproduce relay responses with an open body.
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address() as { port: number };
    try {
      await settings(
        page,
        `http://127.0.0.1:${address.port}/v1/chat/completions`,
      );
      await page.getByLabel("生图模型", { exact: true }).fill("fixture-image");
      await page
        .locator(".image-settings summary")
        .filter({ hasText: "接口兼容设置" })
        .click();
      await page.getByLabel("生图等待秒数", { exact: true }).fill("10");
      await page
        .getByRole("button", {
          name: "生成测试图（消耗一次额度）",
          exact: true,
        })
        .click();
      if (mode === "sse")
        await expect(page.locator(".image-test-preview")).toBeVisible({
          timeout: 8000,
        });
      else
        await expect(page.locator(".image-connection-message")).toContainText(
          "接收生图结果超时（已接收 12 字节）",
          { timeout: 15000 },
        );
      const diagnostic = page.locator(".image-diagnostics");
      await diagnostic.locator("summary").click();
      await expect(diagnostic).toContainText("HTTP 200");
      await expect(diagnostic).toContainText(
        mode === "sse" ? "SSE（流式）" : "JSON（非流式）",
      );
      expect(posts).toBe(1);
      mkdirSync("work/image-recovery-qa", { recursive: true });
      await diagnostic.scrollIntoViewIfNeeded();
      await page.screenshot({
        path: `work/image-recovery-qa/${mode}-desktop.png`,
      });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
}
