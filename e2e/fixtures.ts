import { expect, type Page } from "@playwright/test";

/** Test data belongs to the isolated browser context, never to production seeds. */
export async function seedJourney(page: Page, basePath = "/") {
  await page.goto(basePath);
  await expect(
    page.getByRole("heading", { name: "故事在此间生长" }),
  ).toBeVisible();
  await page.evaluate(async () => {
    const open = indexedDB.open("little-scene-v1");
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
    const persona = (id: string, name: string) => ({
      id,
      name,
      bio: "书店里的朋友。",
      persona: `${name}，说话温和直接，关心别人时习惯先做事。`,
      avatar: "",
      paragraphs: [
        {
          id: id + "-p",
          text: `${name}，说话温和直接，关心别人时习惯先做事。`,
          pin: true,
          public: false,
        },
      ],
      updated: Date.now(),
    });
    const roles = [
      persona("fixture-role-a", "周屿"),
      persona("fixture-role-b", "许知"),
    ];
    const transaction = database.transaction(
      ["roles", "world", "stories"],
      "readwrite",
    );
    roles.forEach((role) => transaction.objectStore("roles").put(role));
    transaction
      .objectStore("world")
      .put({
        id: "fixture-world",
        title: "河畔书屋",
        text: "初夏，河边的书店，门边放着一架旧雨伞。两人是认识三年的朋友。",
        type: "world",
        enabled: true,
        always: true,
        keywords: [],
        roleIds: [],
        storyIds: [],
        knownBy: [],
        audience: "all",
      });
    transaction
      .objectStore("stories")
      .put({
        id: "fixture-story",
        title: "雨声未歇",
        background: "傍晚，许知来到书店门口。雨还没有停。",
        roles: roles.map((r) => ({ ...r, sourceId: r.id })),
        worldIds: ["fixture-world"],
        created: Date.now(),
        updated: Date.now(),
        draft: "周屿把伞递给许知，说“拿着”，但没有看她。",
        chatDraft: "",
        player: roles[0].id,
        partner: roles[1].id,
        length: "适中",
        style: "自然白描",
        psychology: false,
        autoMemory: true,
        chatThreshold: 20,
        novelThreshold: 5,
        memoryCursor: 0,
        memoryState: "idle",
        memoryError: "",
      });
    await new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
    database.close();
  });
  await page.reload();
}

export async function readStore(page: Page, name: string) {
  return page.evaluate(async (name) => {
    const open = indexedDB.open("little-scene-v1");
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
    const request = database.transaction(name).objectStore(name).getAll();
    const rows = await new Promise<any[]>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    database.close();
    return rows;
  }, name);
}
