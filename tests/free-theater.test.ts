import "fake-indexeddb/auto";
import { beforeEach, afterEach, it, expect, vi } from "vitest";
import { db, initialize, sessionKeys, reviseEvent } from "../src/db";
import { generateTheater, validateTheaterResponse } from "../src/theater";
import {
  generateHtmlPage,
  saveHtmlPageState,
  stopHtmlInteraction,
} from "../src/theater-html-interactions";
import { parseStreamingHtml } from "../src/theater-data";
import {
  builtInTheaterPresets,
  theaterInstruction,
} from "../src/theater-presets";
import {
  htmlOutputSchema,
  validateHtmlState,
  htmlPagesText,
} from "../src/theater-html";
import { run, preview } from "../src/engine";
import { requestSpec } from "../src/model";
import { exportBackup, importBackup } from "../src/backup";
import {
  stageBackup,
  commitStaged,
  exportBackupBlob,
} from "../src/backup-transfer";
import {
  uid,
  type SceneEvent,
  type Profile,
  type Protocol,
} from "../src/types";
const html =
  '<style>.anything{color:purple}</style><section class="anything"><h2>幕间观众</h2><p>这一段的番外标记。</p><button onclick="document.body.dataset.clicked=1">展开</button></section><script>const marker="script-body-marker";</script>';
const p: Profile = {
  id: "free-test",
  name: "test",
  protocol: "chat",
  url: "https://free.fixture.test/v1",
  model: "fixture",
  stream: false,
  context: 64000,
  maxOutput: 4096,
  timeout: 10,
  remember: false,
};
const preset = builtInTheaterPresets.find((p) => p.id === "theater-audience")!;
const extra = {
  id: "private-note",
  name: "我的纸条",
  prompt: "可以翻面的纸条",
  experience: "深蓝与金色，自由排版",
  presentation: "custom" as const,
};
const document = (value = html) => ({
  version: 2,
  sections: [
    { id: preset.id, title: preset.name, html: value },
    { id: extra.id, title: extra.name, html: "<h2>纸条栏目保留</h2>" },
  ],
});
const response = (data: unknown) =>
  new Response(
    JSON.stringify({
      choices: [
        { message: { content: JSON.stringify(data) }, finish_reason: "stop" },
      ],
    }),
    { headers: { "content-type": "application/json" } },
  );
beforeEach(async () => {
  await db.delete();
  await db.open();
  await initialize();
  await db.profiles.put(p);
  sessionKeys.set(p.id, "fixture-only");
  await db.preferences.update("preferences", {
    activeProfile: p.id,
    theaterPresets: [extra],
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  sessionKeys.clear();
});
async function fixture(saved = true) {
  const story = (await db.stories.toArray())[0];
  await db.stories.update(story.id, {
    autoMemory: false,
    theaterPresetIds: [preset.id, extra.id],
  });
  const e: SceneEvent = {
    id: "free-event",
    storyId: story.id,
    seq: 1,
    round: 1,
    kind: "novel",
    speaker: "",
    participants: [],
    input: "递伞。",
    text: "他把伞递过去。",
    facts: [],
    versions: [],
    versionId: "source",
    status: "complete",
    raw: "",
    error: "",
    review: false,
    deleted: false,
    created: 1,
  };
  e.versions = [
    { id: e.versionId, text: e.text, input: e.input, facts: [], created: 1 },
  ];
  if (saved)
    e.theater = {
      id: "free-record",
      sourceVersionId: e.versionId,
      status: "complete",
    };
  await db.events.put(e);
  if (saved)
    await db.theaters.put({
      id: "free-record",
      storyId: story.id,
      eventId: e.id,
      sourceVersionId: e.versionId,
      presets: [preset, extra],
      htmlPages: document().sections,
      html,
      text: htmlPagesText(document().sections),
      raw: "original raw",
      status: "complete",
      error: "",
      created: 1,
      updated: 1,
    });
  return { story, event: e };
}
it("all built-in and custom columns accept arbitrary HTML without prescribed inner fields or templates", () => {
  for (const preset of [...builtInTheaterPresets, extra]) {
    const result = validateTheaterResponse(
      JSON.stringify({
        theater: {
          version: 2,
          sections: [{ id: preset.id, title: "自由页面", html }],
        },
      }),
      [preset],
    );
    expect(result.htmlPages?.[0].html).toBe(html);
    expect(result.data).toBeUndefined();
  }
  const prompt = theaterInstruction([preset, extra]);
  expect(prompt).not.toContain("内置栏目的 html 必须为空");
  expect(prompt).toContain(extra.experience);
  expect(prompt).toContain("cijian.generate");
  expect(htmlOutputSchema.properties.sections.items.required).toEqual([
    "id",
    "title",
    "html",
  ]);
});
it.each<Protocol>(["chat", "responses", "claude", "gemini"])(
  "uses the minimal HTML envelope in %s",
  (protocol) => {
    const encoded = JSON.stringify(
      requestSpec(
        { ...p, protocol, outputMode: "schema" },
        "key",
        "system",
        "task",
        { kind: "novel", theater: true },
      ).body,
    );
    expect(encoded).toContain('"html"');
    expect(encoded).not.toContain('"replyTo"');
    expect(encoded).not.toContain('"theme"');
  },
);
it("streams only complete HTML columns and treats JS string keys as content", () => {
  const first = JSON.stringify(document().sections[0]);
  expect(
    parseStreamingHtml(
      '{"theater":{"version":2,"sections":[' + first + ',{"id":"unfinished',
      [preset, extra],
    )?.sections,
  ).toHaveLength(1);
  expect(
    parseStreamingHtml(
      '{"nested":{"theater":{"version":2,"sections":[' + first + "]}}}",
      [preset],
    ),
  ).toBeUndefined();
});
it("manual and automatic generations save free HTML in one request and keep it out of canonical context", async () => {
  const { story } = await fixture(false);
  const fetcher = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(response({ theater: document() }));
  await generateTheater("free-event");
  expect(fetcher).toHaveBeenCalledTimes(1);
  const id = (await db.events.get("free-event"))!.theater!.id;
  expect((await db.theaters.get(id))?.htmlPages).toEqual(document().sections);
  await db.stories.update(story.id, { theaterAuto: true });
  fetcher.mockResolvedValue(
    response({ text: "正文新段。", facts: [], theater: document() }),
  );
  await run(story.id, "novel", "看一眼门外。");
  expect(fetcher).toHaveBeenCalledTimes(2);
  const events = await db.events
    .where("storyId")
    .equals(story.id)
    .sortBy("seq");
  expect(events.at(-1)?.raw).not.toContain("番外标记");
  await db.stories.update(story.id, { theaterAuto: false });
  expect(
    JSON.stringify(await preview(story.id, "novel", "收好伞。")),
  ).not.toContain("番外标记");
});
it("one page update preserves other pages, state, history and the request's output limit", async () => {
  await fixture();
  await saveHtmlPageState("free-record", preset.id, html, {
    selected: "second",
    draft: "本地未发留言",
  });
  const fetcher = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(
      response({
        theater: {
          version: 2,
          sections: [
            { id: preset.id, title: "更新观众", html: "<p>新楼层</p>" },
          ],
        },
      }),
    );
  const a = generateHtmlPage("free-record", preset.id, "再聊一句"),
    b = generateHtmlPage("free-record", preset.id, "再聊一句");
  expect(a).toBe(b);
  await a;
  const saved = (await db.theaters.get("free-record"))!;
  expect(saved.htmlPages?.[1]).toEqual(document().sections[1]);
  expect(saved.htmlHistory?.[0].html).toBe(html);
  expect(saved.htmlStates?.[preset.id]).toEqual({
    selected: "second",
    draft: "本地未发留言",
  });
  expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body)).max_tokens).toBe(
    p.maxOutput,
  );
});
it.each(["stop", "edit", "invalid"])(
  "preserves the page when an update ends with %s",
  async (kind) => {
    await fixture();
    let release!: (r: Response) => void;
    const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const pending = generateHtmlPage(
      "free-record",
      preset.id,
      "更多细节",
    ).catch(() => undefined);
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    if (kind === "stop") stopHtmlInteraction("free-record");
    if (kind === "edit")
      await reviseEvent("free-event", "新的正文", false, [], "source");
    release(
      response(
        kind === "invalid"
          ? { theater: { version: 2, sections: [] } }
          : {
              theater: {
                version: 2,
                sections: [
                  { id: preset.id, title: "新", html: "<p>迟到回复</p>" },
                ],
              },
            },
      ),
    );
    await pending;
    expect((await db.theaters.get("free-record"))?.htmlPages?.[0].html).toBe(
      html,
    );
  },
);
it.each(["legacy", "stream"])(
  "backup v4 round-trips HTML, script state and conflict remaps through %s",
  async (method) => {
    const { story } = await fixture();
    await saveHtmlPageState("free-record", preset.id, html, { value: 3 });
    await db.preferences.update("preferences", {
      theaterPresets: [extra, { ...preset, experience: "深色论坛" }],
    });
    const backup =
      method === "legacy"
        ? await exportBackup()
        : JSON.parse(
            await (await exportBackupBlob(uid(), story.id)).blob.text(),
          );
    expect(backup.version).toBe(4);
    if (method === "legacy") await importBackup(backup);
    else {
      const staged = await stageBackup(
        new Blob([JSON.stringify(backup)]),
        uid(),
      );
      await commitStaged(staged.session, {
        replace: false,
        applySettings: false,
      });
    }
    const copy = (await db.stories.toArray()).find(
      (item) => item.id !== story.id,
    )!;
    const result = (await db.theaters
      .where("storyId")
      .equals(copy.id)
      .first())!;
    expect(result.htmlPages?.[0].html).toBe(html);
    expect(result.htmlStates?.[result.htmlPages![0].id]).toEqual({ value: 3 });
  },
);
it("bounds serialized states and never turns code into executable work exports", () => {
  expect(() => validateHtmlState({ bad: Infinity })).toThrow();
  expect(() => validateHtmlState({ large: "a".repeat(66000) })).toThrow();
  expect(() => validateHtmlState(JSON.parse('{"__proto__":{}}'))).toThrow();
  expect(htmlPagesText(document().sections)).not.toContain(
    "script-body-marker",
  );
});
