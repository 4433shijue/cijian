import "fake-indexeddb/auto";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { db, initialize, sessionKeys } from "../src/db";
import { run, adoptDraft, preview } from "../src/engine";
import { requestSpec } from "../src/model";
import { draftText, topLevelString } from "../src/output";
import type { Profile, Protocol } from "../src/types";

const profile: Profile = {
  id: "theater-fixture", name: "小剧场测试", protocol: "chat",
  url: "https://theater.fixture.test/v1", model: "deepseek-fixture",
  stream: false, context: 64000, maxOutput: 4096, timeout: 10, remember: false,
};
const body = "周屿把伞放在门边，等雨停下来。";
const html = '<style>.aside{color:teal}</style><section class="aside"><h2>主角们的吐槽</h2><p>番外独有标记，他已经看了三次天气预报。</p></section>';
const response = (raw: string, finish_reason = "stop") => new Response(JSON.stringify({
  choices: [{ message: { content: raw }, finish_reason }],
}), { headers: { "content-type": "application/json" } });

beforeEach(async () => {
  await db.delete(); await db.open(); await initialize();
  await db.profiles.put(profile);
  await db.preferences.update("preferences", { activeProfile: profile.id });
  sessionKeys.set(profile.id, "fixture-theater-key");
});
afterEach(() => vi.restoreAllMocks());
async function story() {
  const s = (await db.stories.toArray())[0];
  await db.stories.update(s.id, { autoMemory: false, theaterAuto: true });
  return s.id;
}

describe("separate streaming fields", () => {
  it("reads only the root field and safely decodes partial escapes", () => {
    expect(draftText('{"nested":{"text":"错段"},"theaterHtml":"<p>text</p>')).toBe("");
    expect(topLevelString('{"nested":{"text":"错段"},"text":"正文\\n第二行\\u4f60', "text"))
      .toEqual({ value: "正文\n第二行你", complete: false });
    expect(topLevelString('{"text":"正文","theaterHtml":"<p title=\\"text\\">你好</p>"}', "theaterHtml"))
      .toEqual({ value: '<p title="text">你好</p>', complete: true });
    expect(topLevelString('{"text":"半段\\u4', "text"))
      .toEqual({ value: "半段", complete: false });
    expect(topLevelString('{"text":{"text":"嵌套"}}', "text")).toBeUndefined();
  });
  it.each<Protocol>(["chat", "responses", "claude", "gemini"])("selects combined output only when enabled for %s", (protocol) => {
    const p = { ...profile, protocol, outputMode: "schema" as const };
    const plain = JSON.stringify(requestSpec(p, "fixture", "system", "user", { kind: "novel" }).body);
    const combined = JSON.stringify(requestSpec(p, "fixture", "system", "user", { kind: "novel", theater: true }).body);
    const manual = JSON.stringify(requestSpec(p, "fixture", "system", "user", { kind: "theater" }).body);
    expect(plain).not.toContain("theaterHtml");
    expect(combined).toContain("theaterHtml");
    expect(manual).toContain("theaterHtml");
  });
});

describe("one-request automatic theater", () => {
  it("saves canonical prose separately and keeps side content out of future history", async () => {
    const id = await story();
    const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(response(JSON.stringify({ text: body, facts: [], theaterHtml: html })));
    await run(id, "novel", "他放下伞。");
    expect(fetcher).toHaveBeenCalledTimes(1);
    const sent = JSON.parse(String(fetcher.mock.calls[0][1]?.body));
    expect(sent.messages[0].content).toContain("theaterHtml");
    const e = (await db.events.where("storyId").equals(id).toArray())[0];
    expect(e.text).toBe(body);
    expect(e.raw).not.toContain("番外独有标记");
    const theater = await db.theaters.get(e.theater!.id);
    expect(theater?.status).toBe("complete");
    expect(theater?.html).toBe(html);
    expect(theater?.sourceVersionId).toBe(e.versionId);
    expect(await db.promptSessions.count()).toBe(0);
    await db.stories.update(id, { theaterAuto: false });
    const context = await preview(id, "novel", "他回头。");
    expect(JSON.stringify(context)).not.toContain("番外独有标记");
    expect(context.system).not.toContain("theaterHtml");
    expect(context.user).toContain(body);
    expect(await db.memories.count()).toBe(0);
  });
  it("adopts complete prose when only the theater is missing", async () => {
    const id = await story();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(response(JSON.stringify({ text: body, facts: [] })));
    await run(id, "novel", "他放下伞。");
    const e = (await db.events.toArray())[0];
    expect(e.status).toBe("complete");
    expect(e.theater?.status).toBe("failed");
    expect((await db.theaters.get(e.theater!.id))?.error).toBeTruthy();
  });
  it("keeps a truncated reply as a draft and rebinds its failed theater after adoption", async () => {
    const id = await story();
    const raw = '{"text":' + JSON.stringify(body) + ',"facts":[],"theaterHtml":"<p>没写完';
    vi.spyOn(globalThis, "fetch").mockResolvedValue(response(raw, "length"));
    await expect(run(id, "novel", "他放下伞。")).rejects.toThrow("未完整结束");
    const e = (await db.events.toArray())[0];
    expect(e.status).toBe("draft");
    expect(e.text).toBe(body);
    expect(e.raw).not.toContain("没写完");
    expect((await db.theaters.get(e.theater!.id))?.raw).toBe(raw);
    const adoptedId = await adoptDraft(e.id, body, e.versionId, e.raw);
    const adopted = (await db.events.get(adoptedId))!;
    expect(adopted.status).toBe("complete");
    expect(adopted.theater?.status).toBe("failed");
    expect((await db.theaters.get(adopted.theater!.id))?.sourceVersionId).toBe(adopted.versionId);
    expect(await db.promptSessions.count()).toBe(0);
  });
  it("binds successful rewrites to the final retained event and version", async () => {
    const id = await story();
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => response(JSON.stringify({ text: body, facts: [], theaterHtml: html })));
    await run(id, "novel", "他放下伞。");
    const initial = (await db.events.toArray())[0];
    await run(id, "novel", "他将伞靠在墙上。", initial.id);
    const final = (await db.events.get(initial.id))!;
    expect(await db.events.count()).toBe(1);
    expect(final.versionId).not.toBe(initial.versionId);
    const theater = (await db.theaters.get(final.theater!.id))!;
    expect(theater.eventId).toBe(initial.id);
    expect(theater.sourceVersionId).toBe(final.versionId);
    expect(theater.status).toBe("complete");
    expect(await db.theaters.count()).toBe(2);
  });
});
