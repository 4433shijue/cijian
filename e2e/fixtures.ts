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
      ["roles", "world", "stories", "storyWorld"],
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
        kind: "novel",
        timelineMode: "shared",
        background: "傍晚，许知来到书店门口。雨还没有停。",
        roles: roles.map((r) => ({ ...r, sourceId: r.id })),
        worldIds: ["fixture-story-world"],
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
    transaction.objectStore("storyWorld").put({id:"fixture-story-world",sourceId:"fixture-world",storyId:"fixture-story",title:"河畔书屋",text:"初夏，河边的书店，门边放着一架旧雨伞。两人是认识三年的朋友。",type:"world",enabled:true,always:true,keywords:[],roleIds:[],storyIds:[],knownBy:[],audience:"all"});
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

/** Opens the shared phone conversation from either owner's perspective. */
export async function seedPhone(page:Page) {
 await page.evaluate(async()=>{
  const d=await new Promise<IDBDatabase>((resolve,reject)=>{const q=indexedDB.open("little-scene-v1");q.onsuccess=()=>resolve(q.result);q.onerror=()=>reject(q.error)});
  const tx=d.transaction(["stories","storyWorld"],"readwrite"),table=tx.objectStore("stories");
  const existing=table.get("fixture-story-phone");existing.onsuccess=()=>{if(existing.result)return;const q=table.get("fixture-story");q.onsuccess=()=>{table.put({...q.result,id:"fixture-story-phone",kind:"phone",title:"雨夜手机",draft:"",background:"",worldIds:["fixture-phone-world"]});const w=tx.objectStore("storyWorld").get("fixture-story-world");w.onsuccess=()=>tx.objectStore("storyWorld").put({...w.result,id:"fixture-phone-world",storyId:"fixture-story-phone"});}};
  await new Promise<void>((resolve,reject)=>{tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error)});d.close();
 });
}
export async function openPhoneChat(page: Page) {
  await seedPhone(page);
  await page.goto("/#story/fixture-story-phone");
  await page.getByRole("button", { name: "角色手机", exact: true }).click();
  await page.getByRole("button", { name: "联系人", exact: true }).click();
  await page.getByRole("button", { name: "发消息", exact: true }).first().click();
}
