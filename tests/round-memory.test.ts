import "fake-indexeddb/auto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  db,
  initialize,
  ensureStoryRounds,
  reviseEvent,
  sessionKeys,
} from "../src/db";
import { preview, run } from "../src/engine";
import { sendChatMessage, replyChat, previewChat } from "../src/chat";
import { active, stop } from "../src/generation-state";
import { memoryBatches, organizeMemory } from "../src/round-memory";
import { memoryValid, selectRoundContext } from "../src/rounds";
import { exportBackup, importBackup } from "../src/backup";
import {
  commitStaged,
  exportBackupBlob,
  stageBackup,
} from "../src/backup-transfer";
import {
  uid,
  type Memory,
  type Profile,
  type SceneEvent,
  type Story,
} from "../src/types";

let s: Story;
const profile: Profile = {
  id: "round-test",
  name: "fixture",
  protocol: "chat",
  model: "deepseek-chat",
  url: "https://round.fixture.test/v1",
  stream: false,
  context: 128000,
  maxOutput: 2000,
  timeout: 10,
  remember: false,
};
const response = (data: unknown, finish = "stop") =>
  new Response(
    JSON.stringify({
      choices: [
        { message: { content: JSON.stringify(data) }, finish_reason: finish },
      ],
    }),
    { headers: { "content-type": "application/json" } },
  );
const rows = () => db.events.where("storyId").equals(s.id).sortBy("seq");
const marker = (n: number) => `BODY_${String(n).padStart(3, "0")}_END`;
function event(n: number, patch: Partial<SceneEvent> = {}): SceneEvent {
  return {
    id: `event-${n}`,
    storyId: s.id,
    seq: n,
    kind: "novel",
    origin: "ai",
    speaker: "",
    participants: s.roles.map((r) => r.id),
    input: `INPUT_${n}_END`,
    text: marker(n),
    versionId: `v-${n}`,
    versions: [
      { id: `v-${n}`, input: "", text: marker(n), facts: [], created: n },
    ],
    facts: [],
    status: "complete",
    deleted: false,
    review: false,
    raw: "",
    error: "",
    created: n,
    ...patch,
  };
}
async function seed(n: number) {
  await db.events.bulkAdd(Array.from({ length: n }, (_, i) => event(i + 1)));
  s = await ensureStoryRounds(s.id);
}
async function memory(
  id: string,
  sources: SceneEvent[],
  text = id,
): Promise<Memory> {
  const m: Memory = {
    id,
    storyId: s.id,
    text,
    knownBy: s.roles.map((r) => r.id),
    scope: "story",
    status: "accepted",
    created: 1,
    kind: "round",
    rounds: sources.map((e) => e.round!),
    batchRounds: sources.map((e) => e.round!),
    timelineMode: "shared",
    sources: sources.map((e) => ({ id: e.id, versionId: e.versionId })),
  };
  await db.memories.add(m);
  return m;
}
beforeEach(async () => {
  await db.delete();
  await db.open();
  await initialize();
  s = (await db.stories.toArray())[0];
  await db.stories.update(s.id, { autoMemory: false });
  await db.profiles.put(profile);
  await db.preferences.update("preferences", { activeProfile: profile.id });
  sessionKeys.set(profile.id, "fixture-key");
});
afterEach(() => {
  active.clear();
  sessionKeys.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("bounds actual requests through 105 mixed rounds, bubbles, reloads and mode changes", async () => {
  let turn = 0;
  const requests: any[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      requests.push(body);
      return response(
        body.messages[0].content.includes('{"messages":')
          ? { messages: [marker(turn), `SECOND_${turn}_END`] }
          : { text: marker(turn) },
      );
    }),
  );
  const contents: string[] = [];
  for (turn = 1; turn <= 105; turn++) {
    if (turn % 17 === 0) {
      db.close();
      await db.open();
    }
    const kind = turn % 4 < 2 ? "novel" : "chat";
    let reference;
    if (kind === "chat") {
      for (let j = 1; j <= 3; j++)
        await sendChatMessage(
          s.id,
          s.player,
          s.partner,
          `USER_${turn}_${j}_END`,
        );
      reference = await previewChat(s.id);
      await replyChat(s.id);
    } else {
      reference = await preview(s.id, "novel", `INPUT_${turn}_END`);
      await run(s.id, "novel", `INPUT_${turn}_END`);
    }
    const request = requests.at(-1);
    expect(request.messages).toEqual(reference.messages);
    const length = turn - 1 <= 20 ? turn - 1 : 16 + ((turn - 22) % 5);
    expect(reference.history?.rounds).toHaveLength(length);
    const start = turn - length;
    const input = JSON.stringify(request.messages);
    for (let n = 1; n < turn; n++)
      expect(input.includes(marker(n)), `turn ${turn} reference ${n}`).toBe(
        n >= start,
      );
    expect(reference.history?.rounds).toEqual(
      Array.from({ length }, (_, i) => start + i),
    );
    if (turn > 22 && (turn - 22) % 5 === 0)
      expect(reference.prefixReuse?.state).toBe("window");
    contents.push(input);
  }
  expect(requests).toHaveLength(105);
  const all = await rows();
  expect(new Set(all.map((e) => e.round)).size).toBe(105);
  expect(all.filter((e) => e.round === 2)).toHaveLength(5); // 3 user + 2 AI bubbles
  expect(contents.at(-1)!.length).toBeLessThan(contents[40].length * 2);
}, 60000);

it("deletion leaves ordinal gaps and never backfills old originals; rewrites never see future memory", async () => {
  await seed(26);
  const before = await rows();
  await memory("FUTURE_MEMORY", [before[24]], "FUTURE_SUMMARY");
  await db.stories.update(s.id, {
    memorySelection: { token: "future", ids: ["FUTURE_MEMORY"] },
  });
  await reviseEvent(before[11].id, before[11].text, true);
  const report = await preview(s.id, "novel", "继续");
  expect(report.history?.rounds).toEqual([
    11,
    ...Array.from({ length: 14 }, (_, i) => i + 13),
  ]);
  expect(report.user).not.toContain(marker(10));
  expect(report.user).not.toContain(marker(12));
  const calls: any[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      calls.push(JSON.parse(init.body as string));
      return response({ text: "NEW_REWRITE" });
    }),
  );
  await run(s.id, "novel", "重写", before[14].id);
  expect(JSON.stringify(calls[0])).not.toContain("FUTURE_SUMMARY");
  expect(JSON.stringify(calls[0])).not.toContain(marker(15));
  expect(JSON.stringify(calls[0])).not.toContain(marker(26));
  expect((await db.events.get(before[14].id))?.round).toBe(15);
  const next = await preview(s.id, "novel", "继续");
  expect(next.user).toContain("NEW_REWRITE");
  expect(next.user).not.toContain(marker(15));
});

it("one-reply memory selection survives preview/failure and is removed from retained cache after success", async () => {
  await seed(26);
  await db.preferences.update("preferences", { memoryAutoReadLimit: 0 });
  const m = await memory(
    "one-off",
    (await rows()).slice(0, 5),
    "ONE_OFF_SECRET_REFERENCE",
  );
  await db.stories.update(s.id, {
    memorySelection: { token: "one-shot", ids: [m.id] },
  });
  expect((await preview(s.id, "novel", "这一刻")).user).toContain(m.text);
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(response({ text: "draft" }, "length"))
    .mockImplementation(() => response({ text: "ADOPTED" }));
  vi.stubGlobal("fetch", fetcher);
  await expect(run(s.id, "novel", "这一刻")).rejects.toThrow();
  expect((await db.stories.get(s.id))?.memorySelection?.token).toBe("one-shot");
  await run(s.id, "novel", "这一刻");
  expect((await db.stories.get(s.id))?.memorySelection).toBeUndefined();
  const next = await preview(s.id, "novel", "下一刻");
  expect(next.prefixReuse?.state).toBe("selection");
  expect(JSON.stringify(next.messages)).not.toContain(m.text);
});

it("keeps a newer selection made during generation for the following reply", async () => {
  await seed(2);
  await db.stories.update(s.id, { memorySelection: { token: "old", ids: [] } });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      await db.stories.update(s.id, {
        memorySelection: { token: "new", ids: [] },
      });
      return response({ text: "新的正文" });
    }),
  );
  await run(s.id, "novel", "继续");
  expect((await db.stories.get(s.id))?.memorySelection?.token).toBe("new");
});

it("consumes the same one-reply selection only after a complete adopted chat batch", async () => {
  await seed(26);
  await db.preferences.update("preferences", { memoryAutoReadLimit: 0 });
  const m = await memory(
    "chat-one-off",
    (await rows()).slice(0, 5),
    "CHAT_ONE_OFF_REFERENCE",
  );
  await db.stories.update(s.id, {
    memorySelection: { token: "chat-choice", ids: [m.id] },
  });
  await sendChatMessage(s.id, s.player, s.partner, "第一条补充");
  await sendChatMessage(s.id, s.player, s.partner, "第二条补充");
  expect((await previewChat(s.id)).user).toContain(m.text);
  const requests: string[] = [];
  let failed = false;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      requests.push(init.body as string);
      if (!failed) {
        failed = true;
        return response({ messages: ["未完整回复"] }, "length");
      }
      return response({ messages: ["我看到你的补充了。", "我们接着说。"] });
    }),
  );
  await expect(replyChat(s.id)).rejects.toThrow();
  expect((await db.stories.get(s.id))?.memorySelection?.token).toBe(
    "chat-choice",
  );
  await replyChat(s.id, (await db.chatBatches.toArray())[0].id);
  expect(requests.at(-1)).toContain(m.text);
  expect((await db.stories.get(s.id))?.memorySelection).toBeUndefined();
  expect(
    (await rows()).filter((e) => e.round === 27 && !e.deleted),
  ).toHaveLength(4);
  await sendChatMessage(s.id, s.player, s.partner, "再说一句");
  const next = await previewChat(s.id);
  expect(JSON.stringify(next.messages)).not.toContain(m.text);
});

it("creates one paragraph every five newly adopted rounds and does not inject it while raw text covers it", async () => {
  await db.stories.update(s.id, { autoMemory: true });
  let summaryCalls = 0;
  const api = vi.fn(async (_url: string, init: RequestInit) => {
    const content = JSON.parse(init.body as string).messages[0].content;
    if (content.includes('"一段连贯的回合记忆"')) {
      summaryCalls++;
      return response({
        text: "他们先在门口等雨，随后走进书店。两人约好明天归还画册，目前画册仍留在柜台。",
      });
    }
    return response({ text: "他们在书店整理画册。" });
  });
  vi.stubGlobal("fetch", api);
  for (let n = 0; n < 6; n++) await run(s.id, "novel", "整理画册");
  expect(summaryCalls).toBe(1);
  const memories = await db.memories.toArray();
  expect(memories).toHaveLength(1);
  expect(memories[0]).toMatchObject({
    kind: "round",
    rounds: [1, 2, 3, 4, 5],
    status: "accepted",
  });
  expect(memories[0].sources).toHaveLength(5);
  expect(
    (await preview(s.id, "novel", "继续")).memoryContext?.selected,
  ).toEqual([]);
  expect(api).toHaveBeenCalledTimes(7);
});

it("resumes only unfinished backfill batches after failure and leaves pre-upgrade history manual", async () => {
  await seed(12);
  const prefs = (await db.preferences.get("preferences"))!;
  expect(memoryBatches(s, await rows(), [], prefs)).toEqual([]);
  let calls = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      if (++calls === 2) throw Error("fixture offline");
      return response({
        text: "一段完整的经历小结，说明当时发生的事情及随后明确改变的关系，并保留尚未兑现的约定。",
      });
    }),
  );
  await expect(organizeMemory(s.id)).rejects.toThrow();
  expect(await db.memories.count()).toBe(1);
  expect((await db.stories.get(s.id))?.memoryState).toBe("failed");
  await organizeMemory(s.id);
  expect(calls).toBe(4);
  expect(
    (await db.memories.toArray())
      .map((m) => m.rounds)
      .sort((a, b) => a![0] - b![0]),
  ).toEqual([
    [1, 2, 3, 4, 5],
    [6, 7, 8, 9, 10],
    [11, 12],
  ]);
  await organizeMemory(s.id);
  expect(calls).toBe(4);
});

it("cancels without committing a late summary, then permits a clean retry", async () => {
  await seed(5);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      stop(s.id);
      return response({ text: "LATE_SUMMARY" });
    }),
  );
  await expect(organizeMemory(s.id)).rejects.toThrow("停止");
  expect(await db.memories.count()).toBe(0);
  expect((await db.stories.get(s.id))?.memoryState).toBe("interrupted");
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => response({ text: "有效的小结。" })),
  );
  await organizeMemory(s.id);
  expect(await db.memories.count()).toBe(1);
});

it("invalidates source versions, repairs whole ranges, and never accepts stale in-flight summaries", async () => {
  await seed(5);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => response({ text: "OLD_SUMMARY" })),
  );
  await organizeMemory(s.id);
  const old = (await db.memories.toArray())[0];
  const first = (await rows())[0];
  await reviseEvent(first.id, "REPLACED_SOURCE");
  expect(memoryValid(old, s, await rows())).toBe(false);
  const inputs: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      inputs.push(init.body as string);
      return response({ text: "NEW_SUMMARY" });
    }),
  );
  await organizeMemory(s.id);
  expect(inputs[0]).toContain("REPLACED_SOURCE");
  expect(inputs[0]).not.toContain(marker(1));
  expect((await db.memories.get(old.id))?.text).toBe("NEW_SUMMARY");
  await reviseEvent(first.id, "REPLACE_AGAIN");
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      await db.events.update(first.id, {
        versionId: uid(),
        text: "EDIT_DURING_REQUEST",
      });
      return response({ text: "STALE_RESULT" });
    }),
  );
  await expect(organizeMemory(s.id)).rejects.toThrow("已改变");
  expect(
    (await db.memories.toArray()).some((m) => m.text === "STALE_RESULT"),
  ).toBe(false);
});

it("splits large source text and merges sub-results into one visible paragraph", async () => {
  await seed(1);
  await db.events.update("event-1", { text: "长事件。".repeat(800) });
  await db.profiles.update(profile.id, { context: 4000, maxOutput: 700 });
  let calls = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      calls++;
      return response({
        text: "这部分经历围绕一次约定展开，人物的行动和条件保持原有顺序，最后仍在等待对方答复。",
      });
    }),
  );
  await organizeMemory(s.id);
  expect(calls).toBeGreaterThan(1);
  expect(await db.memories.count()).toBe(1);
  expect((await db.memories.toArray())[0].rounds).toEqual([1]);
});

it("persists numbering, window floor and paragraph provenance through backups without transient choices", async () => {
  await seed(26);
  await memory("saved-memory", (await rows()).slice(0, 5));
  await db.preferences.update("preferences", {
    memoryIntervalRounds: 7,
    memoryAutoReadLimit: 3,
  });
  await db.stories.update(s.id, {
    memorySelection: { token: "TRANSIENT_SELECTION", ids: ["saved-memory"] },
  });
  const data = await exportBackup();
  expect(JSON.stringify(data)).not.toContain("TRANSIENT_SELECTION");
  await importBackup(data, true);
  const restored = (await db.stories.toArray())[0],
    events = await db.events.toArray(),
    memories = await db.memories.toArray();
  expect(restored).toMatchObject({
    nextRound: 27,
    contextWindowStart: 11,
    memoryAutoStart: 27,
  });
  expect(memories[0].rounds).toEqual([1, 2, 3, 4, 5]);
  const prefs = (await db.preferences.get("preferences"))!;
  expect(prefs).toMatchObject({
    memoryIntervalRounds: 7,
    memoryAutoReadLimit: 3,
  });
  const selected = selectRoundContext(restored, events, memories, prefs);
  expect(selected.selected.map((m) => m.id)).toEqual([memories[0].id]);
  expect(selected.history.map((e) => e.round)).toEqual(
    Array.from({ length: 16 }, (_, i) => i + 11),
  );
});

it("round-trips v1.8 provenance through chunked backup and remaps all memory sources", async () => {
  await seed(26);
  await memory("chunked-memory", (await rows()).slice(0, 5));
  await db.stories.update(s.id, {
    memorySelection: { token: "EXCLUDED_CHOICE", ids: ["chunked-memory"] },
  });
  const output = await exportBackupBlob("v18-chunked-export");
  expect(await output.blob.text()).not.toContain("EXCLUDED_CHOICE");
  await stageBackup(output.blob, "v18-chunked-import");
  await commitStaged("v18-chunked-import", {
    replace: true,
    applySettings: true,
  });
  const restored = (await db.stories.toArray())[0];
  expect(restored.id).not.toBe(s.id);
  expect(restored.contextWindowStart).toBe(11);
  const events = await db.events.toArray(),
    memories = await db.memories.toArray();
  expect(memories[0].batchRounds).toEqual([1, 2, 3, 4, 5]);
  expect(
    memories[0].sources.every((ref) =>
      events.some(
        (e) =>
          e.id === ref.id && e.versionId === ref.versionId && e.round! <= 5,
      ),
    ),
  ).toBe(true);
  expect(memoryValid(memories[0], restored, events)).toBe(true);
  expect(restored.memorySelection).toBeUndefined();
});
