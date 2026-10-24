import { test, expect } from "@playwright/test";
import { seedJourney } from "./fixtures";

for (const width of [1280, 390])
  test(`nested dialogs close one layer and restore scrolling at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 844 });
    await seedJourney(page);
    await page.goto("/#story/fixture-story");
    await page.getByRole("button", { name: "故事设置", exact: true }).click();
    await page
      .getByRole("button", { name: "编辑故事人设", exact: true })
      .first()
      .click();
    await expect(page.getByRole("dialog")).toHaveCount(2);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(1);
    expect(await page.evaluate(() => document.body.style.overflow)).toBe(
      "hidden",
    );
    await page.keyboard.press("Tab");
    expect(
      await page.evaluate(() =>
        document
          .querySelector('[role="dialog"]')
          ?.contains(document.activeElement),
      ),
    ).toBe(true);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect(await page.evaluate(() => document.body.style.overflow)).toBe("");
    await page.getByRole("button", { name: "故事设置", exact: true }).click();
    await page
      .getByRole("button", { name: "编辑故事人设", exact: true })
      .first()
      .click();
    await expect(page.getByRole("dialog")).toHaveCount(2);
    await page.evaluate(() => {
      location.hash = "stories";
    });
    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect(await page.evaluate(() => document.body.style.overflow)).toBe("");
  });
