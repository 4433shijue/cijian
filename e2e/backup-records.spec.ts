import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { seedJourney } from "./fixtures";

test("a story with ten full-size reference pictures exports and restores through the worker", async ({
  page,
}) => {
  test.setTimeout(120000);
  await seedJourney(page);
  const referenceLength = await page.evaluate(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1600;
    const context = canvas.getContext("2d")!;
    const pixels = context.createImageData(1600, 1600);
    let seed = 721;
    for (let i = 0; i < pixels.data.length; i++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) | 0;
      pixels.data[i] = i % 4 === 3 ? 255 : seed >>> 24;
    }
    context.putImageData(pixels, 0, 0);
    const reference = canvas.toDataURL("image/jpeg", 0.92);
    const request = indexedDB.open("little-scene-v1");
    const db = await new Promise<IDBDatabase>((resolve) => {
      request.onsuccess = () => resolve(request.result);
    });
    const tx = db.transaction("stories", "readwrite");
    const store = tx.objectStore("stories"),
      get = store.get("fixture-story");
    get.onsuccess = () => {
      const story = get.result;
      story.roles = Array.from({ length: 10 }, (_, i) => ({
        ...(story.roles[i] || { ...story.roles[0], id: `reference-role-${i}` }),
        imageReference: reference,
      }));
      store.put(story);
    };
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
    return reference.length;
  });
  expect(referenceLength * 10).toBeGreaterThan(16 * 1024 * 1024);
  await page.goto("/#story/fixture-story");
  await page.getByRole("button", { name: "故事设置", exact: true }).click();
  await page.getByRole("button", { name: "导出作品", exact: true }).click();
  const pending = page.waitForEvent("download");
  await page.getByRole("button", { name: "备份这本故事", exact: true }).click();
  const path = (await (await pending).path())!;
  const wire = JSON.parse(await readFile(path, "utf8"));
  expect(wire.version).toBe(12);
  expect(wire.stories.length).toBeGreaterThan(1);
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await page.goto("/#settings");
  await page.getByLabel("导入备份", { exact: true }).setInputFiles(path);
  await expect(page.getByRole("dialog", { name: "导入预览" })).toBeVisible({
    timeout: 30000,
  });
  await page.getByRole("button", { name: "作为副本合并", exact: true }).click();
  await expect(
    page.getByText("备份已导入，关联资料已完整保存", { exact: true }),
  ).toBeVisible({ timeout: 30000 });
  const restored = await page.evaluate(async () => {
    const request = indexedDB.open("little-scene-v1");
    const db = await new Promise<IDBDatabase>((resolve) => {
      request.onsuccess = () => resolve(request.result);
    });
    const get = db.transaction("stories").objectStore("stories").getAll();
    const stories = await new Promise<any[]>((resolve) => {
      get.onsuccess = () => resolve(get.result);
    });
    db.close();
    const original = stories.find((s) => s.id === "fixture-story"),
      copy = stories.find((s) => s.id !== "fixture-story");
    return {
      count: stories.length,
      roles: copy?.roles.length,
      exact: copy?.roles.every(
        (r: any, i: number) =>
          r.imageReference === original.roles[i].imageReference,
      ),
    };
  });
  expect(restored).toEqual({ count: 2, roles: 10, exact: true });
});
