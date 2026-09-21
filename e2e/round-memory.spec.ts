import { expect, test, type Page } from "@playwright/test";
import { seedJourney, readStore } from "./fixtures";

async function seed(page: Page) {
  await seedJourney(page);
  await page.evaluate(async () => {
    const open = indexedDB.open("little-scene-v1");
    const db = await new Promise<IDBDatabase>((resolve) => {
      open.onsuccess = () => resolve(open.result);
    });
    const tx = db.transaction(
      ["stories", "events", "profiles", "preferences"],
      "readwrite",
    );
    const get = tx.objectStore("stories").get("fixture-story");
    get.onsuccess = () => {
      const s = get.result;
      tx.objectStore("stories").put({
        ...s,
        timelineMode: "shared",
        autoMemory: false,
      });
      for (let n = 1; n <= 27; n++) {
        const text = `第${n}回，两人在书店整理画册，随后约好下次一同归还借来的书。`;
        tx.objectStore("events").put({
          id: `round-${n}`,
          storyId: s.id,
          seq: n,
          kind: "novel",
          origin: "ai",
          speaker: "",
          participants: s.roles.map((r: any) => r.id),
          input: text,
          text,
          facts: [],
          versions: [
            { id: `v-${n}`, input: text, text, facts: [], created: n },
          ],
          versionId: `v-${n}`,
          status: "complete",
          raw: "",
          error: "",
          review: false,
          deleted: false,
          created: n,
          collapsed: true,
        });
      }
    };
    tx.objectStore("profiles").put({
      id: "round-profile",
      name: "fixture",
      protocol: "chat",
      model: "deepseek-chat",
      url: "https://memory.fixture.test/v1",
      stream: false,
      context: 64000,
      maxOutput: 2000,
      timeout: 10,
      remember: true,
      key: "fixture-key",
    });
    tx.objectStore("preferences").put({
      id: "preferences",
      activeProfile: "round-profile",
      developer: true,
      prompts: {},
      memoryAutoReadLimit: 1,
    });
    await new Promise<void>((resolve) => {
      tx.oncomplete = () => resolve();
    });
    db.close();
  });
  await page.goto("/#story/fixture-story");
  await page.reload();
}

for (const size of [
  { name: "desktop", width: 1440, height: 1000 },
  { name: "mobile", width: 390, height: 844 },
  { name: "landscape", width: 844, height: 390 },
]) {
  test(`${size.name} paragraph backfill, next-reply selection and truthful context preview`, async ({
    page,
  }) => {
    await page.setViewportSize(size);
    const errors: string[] = [],
      requests: any[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await seed(page);
    await page.route("https://memory.fixture.test/**", async (route) => {
      const body = route.request().postDataJSON();
      requests.push(body);
      const isMemory =
        body.messages[0].content.includes('"一段连贯的回合记忆"');
      let text = "周屿把画册放回柜台，伞上的水滴落在脚边。";
      if (isMemory) {
        const input = body.messages[1].content;
        const rows = JSON.parse(input.slice(input.indexOf("[{")));
        text = `这段经历从第${rows[0].round}回开始。两人在书店一起整理画册，讨论归还借书的安排，也逐渐确认了彼此方便的时间。两人的关系仍是相识多年的朋友，许知没有答应额外的邀约，周屿也没有催促。最后画册留在柜台，归还的约定尚未完成，下次见面时需要接上这件事。`;
      }
      await route.fulfill({
        json: {
          choices: [
            {
              message: { content: JSON.stringify({ text }) },
              finish_reason: "stop",
            },
          ],
        },
      });
    });
    await page.getByRole("button", { name: "故事记忆", exact: true }).click();
    const modal = page.getByRole("dialog", { name: "记忆中心" });
    await expect(modal).toContainText("第1～27回");
    await expect(modal).toContainText("6 批");
    await modal.getByRole("button", { name: "一键补齐回合记忆" }).click();
    await expect(modal.locator(".memory-card")).toHaveCount(6);
    await expect(modal.getByRole("status")).toContainText(
      "下次将带入 1 条记忆",
    );
    expect(requests).toHaveLength(6);
    const first = modal
      .locator(".memory-card")
      .filter({
        has: page.getByRole("heading", { name: "第1～5回记忆", exact: true }),
      });
    await first.getByRole("checkbox", { name: "下次带入这条记忆" }).check();
    await expect(modal.getByRole("status")).toContainText(
      "下次将带入 2 条记忆",
    );
    await modal.getByRole("status").scrollIntoViewIfNeeded();
    await page.screenshot({ path: `work/v18-memory-${size.name}.png` });
    await first.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: `work/v18-memory-paragraph-${size.name}.png`,
    });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await modal.getByRole("button", { name: "关闭", exact: true }).click();
    await page
      .locator(".story-toolbar")
      .getByRole("button", { name: "本次参考内容", exact: true })
      .click();
    const reference = page.getByRole("dialog");
    await expect(reference).toContainText("原文窗口 17 / 20 回合");
    await expect(reference).toContainText("第11～27回");
    await expect(reference).toContainText("本次选中 2 条记忆");
    await expect(reference).toContainText("缓存命中 服务未返回");
    await page.screenshot({ path: `work/v18-reference-${size.name}.png` });
    expect(requests).toHaveLength(6); // preview is local
    await reference.getByRole("button", { name: "关闭", exact: true }).click();
    await page.locator(".composer textarea").fill("他放好画册。");
    await page.getByRole("button", { name: "扩写这一刻", exact: true }).click();
    await expect(page.locator(".prose-event")).toHaveCount(28);
    await expect
      .poll(async () => (await readStore(page, "stories"))[0].memorySelection)
      .toBeUndefined();
    expect(requests).toHaveLength(7);
    expect(JSON.stringify(requests.at(-1))).toContain("这段经历从第1回开始");
    expect(JSON.stringify(requests.at(-1))).not.toContain(
      "第1回，两人在书店整理画册",
    );
    await page.getByRole("button", { name: "故事记忆", exact: true }).click();
    await expect(modal.getByRole("status")).toContainText(
      "下次将带入 1 条记忆",
    );
    await expect(first.getByRole("checkbox")).not.toBeChecked();
    await modal.getByRole("button", { name: "关闭", exact: true }).click();
    await page.reload();
    await page
      .locator(".story-toolbar")
      .getByRole("button", { name: "本次参考内容", exact: true })
      .click();
    await expect(page.getByRole("dialog")).toContainText("本次选中 1 条记忆");
    expect(errors).toEqual([]);
  });
}
