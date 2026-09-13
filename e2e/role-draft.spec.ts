import { test, expect, type Page } from "@playwright/test";
import { readStore, seedJourney } from "./fixtures";

async function openDraft(page: Page) {
  await page.getByRole("button", { name: "添加角色", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
}
const avatar = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=",
  "base64",
);

test("new role drafts restore every field after closing and refreshing, then clear only on save", async ({
  page,
}) => {
  await page.goto("/#roles");
  await openDraft(page);
  await page
    .getByLabel("名字", { exact: true })
    .pressSequentially("草稿里的新朋友");
  await page.getByLabel("公开简介").fill("喜欢听雨，还没有写完。最后几个字");
  await page.getByLabel("导入 TXT").setInputFiles({
    name: "unfinished-role.md",
    mimeType: "text/markdown",
    buffer: Buffer.from("在书店工作，说话简短。\n\n他独自保存着一封信。"),
  });
  await expect(page.getByLabel("完整人设")).toHaveValue(
    "在书店工作，说话简短。\n\n他独自保存着一封信。",
  );
  await page
    .getByLabel("头像", { exact: true })
    .setInputFiles({
      name: "avatar.png",
      mimeType: "image/png",
      buffer: avatar,
    });
  await expect(page.getByRole("dialog").locator("img.avatar")).toHaveAttribute(
    "src",
    "data:image/png;base64," + avatar.toString("base64"),
  );
  await page.getByText("逐段设置必读 / 公开", { exact: false }).click();
  await page
    .getByRole("checkbox", { name: "每次必读", exact: true })
    .first()
    .check();
  await page
    .getByRole("checkbox", { name: "对其他角色公开", exact: true })
    .last()
    .check();
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  expect(await readStore(page, "roles")).toHaveLength(0);
  await page.getByRole("link", { name: "故事", exact: true }).click();
  await page.getByRole("link", { name: "角色", exact: true }).click();
  await openDraft(page);
  await expect(page.getByLabel("名字", { exact: true })).toHaveValue(
    "草稿里的新朋友",
  );
  await page.getByLabel("公开简介").fill("刷新前最后输入的一句");
  await page.reload();
  await openDraft(page);
  await expect(page.getByLabel("名字", { exact: true })).toHaveValue(
    "草稿里的新朋友",
  );
  await expect(page.getByLabel("公开简介")).toHaveValue("刷新前最后输入的一句");
  await expect(page.getByLabel("完整人设")).toHaveValue(
    "在书店工作，说话简短。\n\n他独自保存着一封信。",
  );
  await expect(page.getByRole("dialog").locator("img.avatar")).toHaveAttribute(
    "src",
    "data:image/png;base64," + avatar.toString("base64"),
  );
  await page.getByText("逐段设置必读 / 公开", { exact: false }).click();
  await expect(
    page.getByRole("checkbox", { name: "每次必读", exact: true }).first(),
  ).toBeChecked();
  await expect(
    page.getByRole("checkbox", { name: "对其他角色公开", exact: true }).last(),
  ).toBeChecked();
  await page.screenshot({
    path: "outputs/role-draft/restored-desktop.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "保存角色", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(await readStore(page, "roles")).toHaveLength(1);
  expect(await readStore(page, "roleDrafts")).toHaveLength(0);
  await page.reload();
  await openDraft(page);
  for (const label of ["名字", "公开简介", "完整人设"])
    await expect(
      page.getByLabel(label, { exact: label === "名字" }),
    ).toHaveValue("");
  await expect(page.getByRole("dialog").locator("img.avatar")).toHaveCount(0);
  expect(await readStore(page, "roleDrafts")).toHaveLength(0);
});

test("mobile drafts survive invalid submissions, edits to saved roles and failed saves", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await seedJourney(page);
  await page.getByRole("link", { name: "角色", exact: true }).click();
  await openDraft(page);
  await page.getByLabel("完整人设").fill("名字还没想好，先把人设写下来。");
  await page.getByRole("button", { name: "保存角色", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await page
    .locator(".role-card")
    .filter({ hasText: "周屿" })
    .getByRole("button", { name: "翻开档案" })
    .click();
  await page.getByLabel("公开简介").fill("正式角色的简介修改。");
  await page.getByRole("button", { name: "保存角色", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await openDraft(page);
  await expect(page.getByLabel("名字", { exact: true })).toHaveValue("");
  await expect(page.getByLabel("完整人设")).toHaveValue(
    "名字还没想好，先把人设写下来。",
  );
  await page.getByLabel("名字", { exact: true }).fill("雨天的新朋友");
  await expect(page.getByRole("dialog").getByRole("status")).toContainText(
    "草稿已自动保存",
  );
  await page.evaluate(() => {
    const original = IDBObjectStore.prototype.put;
    let fail = true;
    IDBObjectStore.prototype.put = function (...args) {
      if (this.name === "roles" && fail) {
        fail = false;
        throw new DOMException("Simulated failed save", "QuotaExceededError");
      }
      return original.apply(this, args);
    };
  });
  await page.getByRole("button", { name: "保存角色", exact: true }).click();
  await expect(page.getByRole("dialog").getByRole("alert")).toContainText(
    "角色没能保存",
  );
  expect(await readStore(page, "roleDrafts")).toHaveLength(1);
  expect(await readStore(page, "roles")).toHaveLength(2);
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await page.reload();
  await openDraft(page);
  await expect(page.getByLabel("名字", { exact: true })).toHaveValue(
    "雨天的新朋友",
  );
  await expect(page.getByLabel("完整人设")).toHaveValue(
    "名字还没想好，先把人设写下来。",
  );
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "outputs/role-draft/restored-mobile.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "保存角色", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(await readStore(page, "roleDrafts")).toHaveLength(0);
  expect(await readStore(page, "roles")).toHaveLength(3);
  await openDraft(page);
  await expect(page.getByLabel("名字", { exact: true })).toHaveValue("");
  await expect(page.getByLabel("完整人设")).toHaveValue("");
});

test("failed autosaves show an error and slow avatar imports preserve newer typing", async ({
  page,
}) => {
  await page.goto("/#roles");
  await openDraft(page);
  await page.evaluate(() => {
    const put = IDBObjectStore.prototype.put;
    let fail = true;
    IDBObjectStore.prototype.put = function (...args) {
      if (this.name === "roleDrafts" && fail) {
        fail = false;
        throw new DOMException(
          "Simulated draft storage failure",
          "QuotaExceededError",
        );
      }
      return put.apply(this, args);
    };
    const read = FileReader.prototype.readAsDataURL;
    FileReader.prototype.readAsDataURL = function (blob) {
      setTimeout(() => read.call(this, blob), 400);
    };
  });
  await page.getByLabel("名字", { exact: true }).fill("起初的名字");
  await expect(page.getByRole("dialog").getByRole("alert")).toContainText(
    "草稿暂时没能保存",
  );
  await page
    .getByLabel("头像", { exact: true })
    .setInputFiles({
      name: "avatar.png",
      mimeType: "image/png",
      buffer: avatar,
    });
  await page.getByLabel("名字", { exact: true }).fill("上传期间输入的新名字");
  await page.getByLabel("公开简介").fill("上传头像时仍然可以写简介。");
  await expect(page.getByRole("dialog").locator("img.avatar")).toBeVisible();
  await expect(page.getByLabel("名字", { exact: true })).toHaveValue(
    "上传期间输入的新名字",
  );
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await openDraft(page);
  await expect(page.getByLabel("名字", { exact: true })).toHaveValue(
    "上传期间输入的新名字",
  );
  await expect(page.getByLabel("公开简介")).toHaveValue(
    "上传头像时仍然可以写简介。",
  );
  await expect(page.getByRole("dialog").locator("img.avatar")).toBeVisible();
});
