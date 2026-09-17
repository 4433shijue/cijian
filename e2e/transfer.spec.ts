import { test, expect, type Page } from "@playwright/test";
import { mkdir, readFile, open, stat, writeFile } from "node:fs/promises";
import { unzipSync, strFromU8 } from "fflate";
import { createReadStream } from "node:fs";
import { BackupParser } from "../src/backup-parser";
import { seedJourney, readStore } from "./fixtures";

test.beforeEach(async ({ page }) => {
  await seedJourney(page);
  await page.evaluate(async () => {
    const req = indexedDB.open("little-scene-v1");
    const d = await new Promise<IDBDatabase>((r) => {
      req.onsuccess = () => r(req.result);
    });
    const tx = d.transaction(["events"], "readwrite");
    for (let i = 1; i <= 5; i++) {
      const text =
        i === 5
          ? "草稿不能导出"
          : `导出正文第${i}段。中文🫖，她说“好呀”。\n换行保留。`;
      tx.objectStore("events").put({
        id: `export-${i}`,
        storyId: "fixture-story",
        seq: i,
        kind: i === 3 ? "message" : "novel",
        speaker: i === 3 ? "fixture-role-b" : "",
        participants: ["fixture-role-a", "fixture-role-b"],
        input: "测试输入",
        text,
        facts: [],
        versions: [
          { id: `version-${i}`, text, input: "", created: i, facts: [] },
        ],
        versionId: `version-${i}`,
        status: i === 5 ? "draft" : "complete",
        raw: "",
        error: "",
        review: false,
        deleted: i === 4,
        created: i,
      });
    }
    await new Promise<void>((r) => {
      tx.oncomplete = () => r();
    });
    d.close();
  });
  await page.reload();
});

async function settings(page: Page) {
  await page.getByRole("link", { name: "设置", exact: true }).click();
}
async function exportFile(page: Page) {
  const pending = page.waitForEvent("download");
  await page.getByRole("button", { name: "生成作品文件", exact: true }).click();
  return pending;
}
async function smallBackup(page: Page) {
  await settings(page);
  const pending = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出完整备份（不含 Key）" }).click();
  const download = await pending;
  return JSON.parse(await readFile((await download.path())!, "utf8"));
}
async function makeLargeBackup(page: Page, name: string, count = 1200) {
  const b = await smallBackup(page);
  b.roles[0].persona = "很长的人设与中文分界🫖".repeat(25000);
  b.roles[0].avatar = "data:image/png;base64," + "A".repeat(2_500_000);
  b.stories[0].roles[0] = { ...b.roles[0], sourceId: b.roles[0].id };
  b.memories = [];
  b.chatBatches = [];
  const template = { ...b.events[0], status: "complete", deleted: false };
  delete b.events;
  const path = `work/${name}.json`;
  await mkdir("work", { recursive: true });
  const handle = await open(path, "w");
  await handle.write(JSON.stringify(b).slice(0, -1) + ',"events":[');
  for (let i = 0; i < count; i++) {
    const text = `大文件节点${i}。` + "中文分块读取。".repeat(2200);
    const e = {
      ...template,
      id: `large-${i}`,
      seq: i + 1,
      versionId: `large-version-${i}`,
      text,
      versions: [
        { id: `large-version-${i}`, text, input: "", facts: [], created: i },
      ],
    };
    await handle.write((i ? "," : "") + JSON.stringify(e));
  }
  await handle.write("]}");
  await handle.close();
  return { path, count, size: (await stat(path)).size };
}

test("desktop exports TXT, Markdown, DOCX/EPUB documents and adjustable print preview", async ({
  page,
  context,
}) => {
  test.setTimeout(120000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/#story/fixture-story");
  await page.getByRole("button", { name: "故事设置", exact: true }).click();
  await page.getByRole("button", { name: "导出作品", exact: true }).click();
  await page.getByLabel("导出范围", { exact: true }).selectOption("selection");
  await page.getByLabel("从第几项开始").fill("2");
  await page.getByLabel("到第几项结束").fill("2");
  let d = await exportFile(page);
  const text = await readFile((await d.path())!, "utf8");
  expect(text).toContain("第2段");
  expect(text).not.toContain("第1段");
  expect(text).not.toContain("草稿不能导出");
  await page.getByLabel("导出内容", { exact: true }).selectOption("all");
  await page.getByLabel("附上人物介绍（名字与简介）").check();
  await page.getByLabel("附上开场背景").check();
  for (const format of ["md", "docx", "epub"]) {
    await page.getByLabel("文件格式").selectOption(format);
    d = await exportFile(page);
    await d.saveAs(`work/export-sample.${format}`);
    const bytes = await readFile((await d.path())!);
    if (format === "md") expect(bytes.toString()).toContain("## 人物介绍");
    else {
      const files = unzipSync(bytes);
      expect(
        strFromU8(
          files[format === "docx" ? "word/document.xml" : "OEBPS/story.xhtml"],
        ),
      ).toContain("中文🫖");
    }
  }
  await page.getByLabel("文件格式").selectOption("print");
  const popupPending = context.waitForEvent("page");
  await page.getByRole("button", { name: "打开打印预览", exact: true }).click();
  const popup = await popupPending;
  await expect(
    popup.getByRole("heading", { name: "雨声未歇", exact: true }),
  ).toBeVisible();
  await popup.getByLabel("预览字号").fill("20");
  await popup.getByLabel("预览行距").fill("2");
  await popup.getByLabel("正文段落另起一页").check();
  expect(
    await popup
      .locator("article")
      .evaluate((el) => getComputedStyle(el).fontSize),
  ).toBe("20px");
  await popup.screenshot({
    path: "work/export-print-desktop.png",
    fullPage: true,
  });
  await popup.pdf({
    path: "work/export-sample.pdf",
    printBackground: true,
    preferCSSPageSize: true,
  });
  expect(errors).toEqual([]);
});

test("mobile export controls and single-story backup round trip", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/#story/fixture-story");
  await page.getByRole("button", { name: "故事设置", exact: true }).click();
  await page.getByRole("button", { name: "导出作品", exact: true }).click();
  await page.getByLabel("文件格式").selectOption("epub");
  await page.locator(".story-transfer").scrollIntoViewIfNeeded();
  await page.screenshot({ path: "work/export-mobile.png", fullPage: true });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  const pending = page.waitForEvent("download");
  await page.getByRole("button", { name: "备份这本故事", exact: true }).click();
  const download = await pending;
  const path = (await download.path())!;
  const backup = JSON.parse(await readFile(path, "utf8"));
  expect(backup.scope).toBe("story");
  expect(backup.events).toHaveLength(5);
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await settings(page);
  await page.locator("input[type=file]").setInputFiles(path);
  await expect(page.getByRole("dialog", { name: "导入预览" })).toBeVisible();
  await expect(page.getByRole("button", { name: "替换全部资料" })).toHaveCount(
    0,
  );
  await page.screenshot({
    path: "work/import-preview-mobile.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "作为副本合并", exact: true }).click();
  await expect(
    page.getByText("备份已导入，关联资料已完整保存", { exact: true }),
  ).toBeVisible();
  expect(await readStore(page, "stories")).toHaveLength(2);
  expect(await readStore(page, "transferRecords")).toHaveLength(0);
});

test("100 MB backup imports and exports without blocking the main UI or whole-file text reads", async ({
  page,
}) => {
  test.setTimeout(240000);
  const fixture = await makeLargeBackup(page, "large-transfer-fixture");
  expect(fixture.size).toBeGreaterThan(100 * 1024 * 1024);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Performance.enable");
  const heap = async () =>
    (await cdp.send("Performance.getMetrics")).metrics.find(
      (m) => m.name === "JSHeapUsedSize",
    )!.value;
  const startHeap = await heap();
  await page.evaluate(() => {
    const state = { maxGap: 0, ticks: 0, last: performance.now() };
    (window as any).transferPerf = state;
    setInterval(() => {
      const now = performance.now();
      state.maxGap = Math.max(state.maxGap, now - state.last);
      state.last = now;
      state.ticks++;
    }, 50);
    File.prototype.text = () =>
      Promise.reject(Error("Whole-file text read forbidden"));
  });
  let peakHeap = startHeap;
  const started = Date.now();
  await page.locator("input[type=file]").setInputFiles(fixture.path);
  await expect(page.getByText("正在分块读取", { exact: true })).toBeVisible();
  const monitor = setInterval(() => {
    void heap()
      .then((value) => {
        peakHeap = Math.max(peakHeap, value);
      })
      .catch(() => {});
  }, 200);
  await expect(page.getByRole("dialog", { name: "导入预览" })).toBeVisible({
    timeout: 120000,
  });
  const parsedMs = Date.now() - started;
  // A second tab's startup must not remove a live preview owned by the worker.
  const other = await page.context().newPage();
  await other.goto("/#settings");
  await expect(
    other.getByRole("heading", { name: "保存与迁移" }),
  ).toBeVisible();
  await other.close();
  await page.getByRole("button", { name: "作为副本合并", exact: true }).click();
  await expect(
    page.getByText("备份已导入，关联资料已完整保存", { exact: true }),
  ).toBeVisible({ timeout: 120000 });
  clearInterval(monitor);
  const perf = await page.evaluate(() => (window as any).transferPerf);
  const rows = await page.evaluate(async () => {
    const req = indexedDB.open("little-scene-v1");
    const d = await new Promise<IDBDatabase>((r) => {
      req.onsuccess = () => r(req.result);
    });
    const tx = d.transaction(["events", "stories", "transferRecords"]);
    const get = <T>(r: IDBRequest<T>) =>
      new Promise<T>((resolve) => {
        r.onsuccess = () => resolve(r.result);
      });
    const result = {
      events: await get(tx.objectStore("events").count()),
      stories: await get(tx.objectStore("stories").count()),
      staged: await get(tx.objectStore("transferRecords").count()),
    };
    d.close();
    return result;
  });
  expect(rows).toEqual({ events: fixture.count + 5, stories: 2, staged: 0 });
  expect(perf.ticks).toBeGreaterThan(10);
  expect(perf.maxGap).toBeLessThan(1500);
  expect(peakHeap - startHeap).toBeLessThan(60 * 1024 * 1024);
  const pending = page.waitForEvent("download", { timeout: 120000 });
  await page.getByRole("button", { name: "导出完整备份（不含 Key）" }).click();
  const exported = await pending;
  const exportedSize = (await stat((await exported.path())!)).size;
  expect(exportedSize).toBeGreaterThan(fixture.size);
  await exported.saveAs("work/large-transfer-roundtrip.json");
  let verifiedEvents = 0,
    verifiedAvatars = 0;
  const parser = new BackupParser(async (table, value: any) => {
    if (table === "events" && value.text.startsWith("大文件节点")) {
      expect(value.text).toBe(
        `大文件节点${value.seq - 1}。` + "中文分块读取。".repeat(2200),
      );
      expect(value.versions[0].text).toBe(value.text);
      verifiedEvents++;
    }
    if (table === "roles" && value.avatar.length > 2_000_000) {
      expect(value.avatar).toBe(
        "data:image/png;base64," + "A".repeat(2_500_000),
      );
      expect(value.persona).toBe("很长的人设与中文分界🫖".repeat(25000));
      verifiedAvatars++;
    }
  });
  const stream = createReadStream("work/large-transfer-roundtrip.json", {
    encoding: "utf8",
    highWaterMark: 1024 * 1024,
  });
  for await (const chunk of stream) await parser.push(chunk as string);
  parser.finish();
  expect(verifiedEvents).toBe(fixture.count);
  expect(verifiedAvatars).toBe(1);
  await writeFile(
    "work/large-transfer-evidence.json",
    JSON.stringify(
      {
        fileBytes: fixture.size,
        records: fixture.count,
        parseMs: parsedMs,
        totalMs: Date.now() - started,
        mainHeapBefore: startHeap,
        mainHeapPeak: peakHeap,
        ...perf,
        rows,
        exportedSize,
        verifiedEvents,
        verifiedAvatars,
      },
      null,
      2,
    ),
  );
});

test("cancel and a terminated import worker leave the previous archive intact, and reload removes abandoned staging", async ({
  page,
}) => {
  test.setTimeout(180000);
  const fixture = await makeLargeBackup(
    page,
    "interrupted-transfer-fixture",
    250,
  );
  await page.locator("input[type=file]").setInputFiles(fixture.path);
  await expect(page.getByText("正在分块读取", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "取消操作", exact: true }).click();
  await expect(
    page.getByText("已取消，原资料未改变", { exact: true }),
  ).toBeVisible();
  expect(await readStore(page, "stories")).toHaveLength(1);
  expect(await readStore(page, "transferRecords")).toHaveLength(0);
  await page.evaluate(() => {
    const NativeWorker = Worker;
    (window as any).Worker = class extends NativeWorker {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        this.addEventListener("message", ({ data }) => {
          if (data.type === "progress" && data.progress.phase === "importing") {
            this.terminate();
            (window as any).workerTerminated = true;
          }
        });
      }
    };
  });
  await page.locator("input[type=file]").setInputFiles(fixture.path);
  await expect(page.getByRole("dialog", { name: "导入预览" })).toBeVisible({
    timeout: 60000,
  });
  page.on("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "替换全部资料", exact: true }).click();
  await page.waitForFunction(() => (window as any).workerTerminated);
  await page.reload();
  await expect(page.getByRole("heading", { name: "保存与迁移" })).toBeVisible();
  expect(await readStore(page, "stories")).toHaveLength(1);
  expect(await readStore(page, "events")).toHaveLength(5);
  expect(await readStore(page, "transferRecords")).toHaveLength(0);
  expect(await readStore(page, "transferSessions")).toHaveLength(0);
});
