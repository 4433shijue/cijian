import "fake-indexeddb/auto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { db, sessionKeys, makeStory } from "../src/db";
import { uid, paragraphs, type Profile, type Role } from "../src/types";
import {
  completionDimensions,
  emptyCompletionDraft,
} from "../src/role-completion-types";
import {
  createGenerator,
  configureGenerator,
  advanceGenerator,
  generatorData,
  retryGenerator,
  stopGenerator,
  reviseGenerator,
  editGeneratorResult,
  saveGeneratorResults,
  saveGeneratorConnection,
  migrateCompletionGenerator,
  deleteGenerator,
  recoverGeneratorStep,
} from "../src/generator";
import {
  generatorTables,
  newGeneratorInput,
  type GeneratorCard,
} from "../src/generator-types";
import { exportBackup, importBackup, validateBackup } from "../src/backup";
import {
  exportBackupBlob,
  stageBackup,
  commitStaged,
} from "../src/backup-transfer";
const profile: Profile = {
  id: "general",
  name: "模拟接口",
  protocol: "chat",
  url: "https://generator.fixture.test/v1",
  model: "fixture",
  stream: false,
  context: 64000,
  maxOutput: 6000,
  timeout: 20,
  temperature: 0.53,
  remember: true,
  key: "fixture-key-only",
};
const role: Role = {
  id: "original-role",
  name: "林舟",
  persona: "他留在海边。秘密是他曾烧掉一封信。",
  bio: "修船匠",
  paragraphs: paragraphs("他留在海边。秘密是他曾烧掉一封信。"),
  avatar: "",
  updated: 1,
};
const world = {
  id: "original-world",
  title: "海边小镇",
  text: "这里每年冬天封港。",
  type: "world" as const,
  enabled: true,
  always: true,
  keywords: [],
  roleIds: [role.id],
  storyIds: [],
  knownBy: [],
  audience: "all" as const,
};
const ready = {
  message: "方向清楚了，开始写第一版。",
  confirmed: ["留在海边"],
  conflicts: [],
  unknown: [],
  questions: [],
  ready: true,
};
const interview = {
  ...ready,
  ready: false,
  questions: [
    {
      id: "q1",
      text: "为什么留下？",
      multiple: true,
      options: [
        { id: "a", text: "照顾家人" },
        { id: "b", text: "有人挽留" },
      ],
    },
    {
      id: "q2",
      text: "他如何解释？",
      multiple: false,
      options: [
        { id: "a", text: "坦然承认" },
        { id: "b", text: "嘴硬" },
      ],
    },
  ],
};
function card(targetId: string, name: string): GeneratorCard {
  return {
    targetId,
    name,
    bio: "修船匠",
    sections: completionDimensions.map((title) => ({
      title,
      content: `${name}的${title}，可以继续调整。`,
      basis: "created",
      evidence: "",
      sourceIds: [],
    })),
    preserved: ["嘴硬心软"],
    changed: ["没有离乡"],
    reasons: ["作者选择"],
  };
}
const response = (value: unknown) =>
  new Response(
    JSON.stringify({
      choices: [
        { message: { content: JSON.stringify(value) }, finish_reason: "stop" },
      ],
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
function mock(handler?: (payload: any, body: any, index: number) => unknown) {
  let index = 0;
  const requests: any[] = [];
  const fetcher = vi.fn(async (_url: unknown, init: any) => {
    const body = JSON.parse(init.body),
      payload = JSON.parse(body.messages.at(-1).content);
    requests.push({ body, payload });
    const target = payload.input.targets.find(
      (t: any) => t.id === payload.targetId,
    );
    const value = handler
      ? await handler(payload, body, index++)
      : target
        ? card(target.id, target.name)
        : payload.task === "world"
          ? { worlds: [] }
          : ready;
    return value instanceof Response ? value : response(value);
  });
  vi.stubGlobal("fetch", fetcher);
  return { requests, fetcher };
}
async function setup(multiple = false) {
  const s = await createGenerator();
  return configureGenerator(
    s.id,
    {
      ...newGeneratorInput(),
      mode: "if",
      core: "嘴硬心软",
      targets: [
        { id: "target-a", name: "林舟" },
        ...(multiple ? [{ id: "target-b", name: "唐晓" }] : []),
      ],
      multiple,
    },
    [
      { kind: "role", sourceId: role.id, purpose: "target" },
      { kind: "world", sourceId: world.id, purpose: "world" },
    ],
  );
}
beforeEach(async () => {
  await db.open();
  for (const t of db.tables) await t.clear();
  sessionKeys.clear();
  await db.roles.add(role);
  await db.world.add(world);
  await db.profiles.add(profile);
  await db.preferences.add({
    id: "preferences",
    activeProfile: profile.id,
    developer: false,
    prompts: {},
  });
});
afterEach(() => vi.unstubAllGlobals());
it("reads only selected library snapshots and automatically composes without modifying original materials", async () => {
  await db.roles.add({ ...role, id: "unselected", name: "UNSELECTED_SECRET" });
  const s = await setup(),
    { requests } = mock();
  await db.roles.update(role.id, { persona: "CHANGED_AFTER_SNAPSHOT" });
  const original = await db.roles.get(role.id);
  await advanceGenerator(s.id);
  const d = await generatorData(s.id);
  expect(requests).toHaveLength(3);
  expect(JSON.stringify(requests)).toContain("烧掉一封信");
  expect(JSON.stringify(requests)).not.toContain("UNSELECTED_SECRET");
  expect(JSON.stringify(requests)).not.toContain("CHANGED_AFTER_SNAPSHOT");
  await saveGeneratorResults(
    s.id,
    d.results.map((r) => r.id),
  );
  expect(await db.roles.get(role.id)).toEqual(original);
  expect(await db.world.get(world.id)).toEqual(world);
  expect(
    (await db.roles.toArray()).filter(
      (r) => r.id !== role.id && r.id !== "unselected",
    ),
  ).toHaveLength(1);
  expect(d.steps.every((s) => s.status === "complete")).toBe(true);
});
it("accepts multi-select, custom text, delegation and starts generation only after an answer", async () => {
  const s = await setup(),
    m = mock((p, b, i) =>
      i === 0
        ? interview
        : p.targetId
          ? card(p.targetId, "林舟")
          : p.task === "world"
            ? { worlds: [] }
            : ready,
    );
  await advanceGenerator(s.id);
  expect(m.requests).toHaveLength(1);
  await advanceGenerator(s.id, "A 和 B 都有，但不承认", [
    { questionId: "q1", options: ["a", "b"], text: "", disposition: "answer" },
    { questionId: "q2", options: [], text: "", disposition: "delegate" },
  ]);
  expect(m.requests).toHaveLength(4);
  expect(JSON.stringify(m.requests[1].payload.history)).toContain("不承认");
});
it("rejects invalid options and two choices on a single-select without sending", async () => {
  const s = await setup(),
    m = mock(() => interview);
  await advanceGenerator(s.id);
  await expect(
    advanceGenerator(s.id, "", [
      {
        questionId: "q2",
        options: ["a", "b"],
        text: "",
        disposition: "answer",
      },
    ]),
  ).rejects.toThrow("不匹配");
  await expect(
    advanceGenerator(s.id, "", [
      { questionId: "bad", options: [], text: "x", disposition: "answer" },
    ]),
  ).rejects.toThrow("不匹配");
  expect(m.requests).toHaveLength(1);
});
it("keeps each successful character and retries only the unfinished steps with original prompts", async () => {
  const s = await setup(true);
  let failed = false;
  const m = mock((p, b) => {
    if (p.targetId === "target-b" && !failed) {
      failed = true;
      return new Response("temporary", { status: 500 });
    }
    return p.targetId
      ? card(
          p.targetId,
          p.input.targets.find((t: any) => t.id === p.targetId).name,
        )
      : { worlds: [] };
  });
  await db.preferences.update("preferences", {
    prompts: { generatorCompose: { text: "OLD_COMPOSE", enabled: true } },
  });
  await expect(advanceGenerator(s.id, "", [], true)).rejects.toThrow();
  let d = await generatorData(s.id);
  expect(d.results).toHaveLength(1);
  await db.preferences.update("preferences", {
    prompts: { generatorCompose: { text: "NEW_COMPOSE", enabled: true } },
  });
  await retryGenerator(s.id, d.steps[0].batchId);
  d = await generatorData(s.id);
  expect(d.results).toHaveLength(2);
  expect(
    m.requests.filter((x) => x.payload.targetId === "target-a"),
  ).toHaveLength(1);
  expect(m.requests[2].body.messages[0].content).toContain("OLD_COMPOSE");
  expect(m.requests[2].body.messages[0].content).not.toContain("NEW_COMPOSE");
  expect(m.requests[2].payload.completedCards[0].targetId).toBe("target-a");
});
it("saves new cards and optional world references atomically, and repeated saves are idempotent", async () => {
  const s = await setup();
  mock((p) =>
    p.targetId
      ? card(p.targetId, "林舟")
      : {
          worlds: [
            {
              title: "IF 小镇",
              text: "冬天不再封港",
              type: "world",
              audience: "roles",
              roleIds: ["target-a"],
              knownBy: ["target-a"],
            },
          ],
        },
  );
  await advanceGenerator(s.id, "", [], true);
  const d = await generatorData(s.id),
    w = d.results.find((r) => r.kind === "world")!;
  await expect(saveGeneratorResults(s.id, [w.id])).rejects.toThrow("同时勾选");
  expect(await db.world.count()).toBe(1);
  await saveGeneratorResults(
    s.id,
    d.results.map((r) => r.id),
  );
  await saveGeneratorResults(
    s.id,
    d.results.map((r) => r.id),
  );
  const novel = (await db.roles.toArray()).find((r) => r.id !== role.id)!;
  const nw = (await db.world.toArray()).find((x) => x.id !== world.id)!;
  expect(nw.knownBy).toEqual([novel.id]);
  expect(nw.storyIds).toEqual([]);
  expect(await db.roles.count()).toBe(2);
  expect(novel.paragraphs.every((p) => !p.public)).toBe(true);
});
it("retains earlier branches and invalidates old results when changing an answer", async () => {
  const s = await setup();
  mock();
  await advanceGenerator(s.id);
  const d = await generatorData(s.id),
    first = d.turns.find((t) => t.kind === "user")!;
  const next = await reviseGenerator(s.id, first.id);
  expect(next.turnIds).toEqual([]);
  expect(await db.generatorTurns.count()).toBe(2);
  expect((await db.generatorResults.toArray())[0].needsReview).toBe(true);
  await expect(
    saveGeneratorResults(
      s.id,
      d.results.map((r) => r.id),
    ),
  ).rejects.toThrow("复核");
});
it("copies edited and restored result versions and leaves saved cards unchanged", async () => {
  const s = await setup();
  mock();
  await advanceGenerator(s.id);
  let d = await generatorData(s.id);
  const r = d.results[0];
  await saveGeneratorResults(s.id, [r.id]);
  const saved = (await db.generatorResults.get(r.id))!.savedId;
  const updated = await editGeneratorResult(r.id, {
    card: { ...r.card!, name: "林知舟", bio: "新简介" },
  });
  await saveGeneratorResults(s.id, [updated.id]);
  expect((await db.roles.get(saved))!.bio).toBe("修船匠");
  expect(await db.roles.count()).toBe(3);
  const continuation = mock();
  await advanceGenerator(s.id, "保留手动修改，完善说话方式");
  expect(
    continuation.requests.every(
      (r) => r.payload.input.targets[0].name === "林知舟",
    ),
  ).toBe(true);
  expect(
    (await generatorData(s.id)).results.filter((r) => r.kind === "card").at(-1)!
      .card!.name,
  ).toBe("林知舟");
  const restored = await editGeneratorResult(updated.id, { card: r.card });
  expect(restored.previousId).toBe(updated.id);
  expect(restored.card!.bio).toBe("修船匠");
});
it("isolates dedicated settings, keeps custom prompts active outside developer mode, and omits credentials", async () => {
  await saveGeneratorConnection(
    "dedicated",
    { ...profile, url: "https://dedicated.fixture.test/v1", temperature: 0.21 },
    "private-fixture-key",
  );
  const prefs = (await db.preferences.get("preferences"))!;
  expect(prefs.activeProfile).toBe("general");
  expect((await db.profiles.get("general"))!.temperature).toBe(0.53);
  await db.preferences.update("preferences", {
    prompts: {
      generatorInterview: { text: "MY_INTERVIEW", enabled: true },
      generatorIf: { text: "MY_IF", enabled: true },
      generatorCompose: { text: "MY_CARD", enabled: true },
    },
  });
  const s = await setup(),
    m = mock();
  await advanceGenerator(s.id);
  expect(m.requests.every((x) => x.body.temperature === 0.21)).toBe(true);
  expect(m.requests[0].body.messages[0].content).toContain("MY_INTERVIEW");
  expect(m.requests[0].body.messages[0].content).toContain("MY_IF");
  expect(m.requests[1].body.messages[0].content).toContain("MY_CARD");
  expect(JSON.stringify(await db.generatorSteps.toArray())).not.toContain(
    "private-fixture-key",
  );
  expect(JSON.stringify(await exportBackup())).not.toContain(
    "private-fixture-key",
  );
});
it("rejects fabricated target identities and unauthorized world audience references", async () => {
  const s = await setup();
  mock(() => card("unselected", "林舟"));
  await expect(advanceGenerator(s.id, "", [], true)).rejects.toThrow("身份");
  expect(await db.generatorResults.count()).toBe(0);
  mock((p) =>
    p.targetId
      ? card(p.targetId, "林舟")
      : {
          worlds: [
            {
              title: "秘密",
              text: "秘密",
              type: "fact",
              audience: "roles",
              roleIds: [],
              knownBy: [role.id],
            },
          ],
        },
  );
  await expect(advanceGenerator(s.id, "", [], true)).rejects.toThrow(
    "本次目标",
  );
});
it("preserves invalid raw output for local repair without making another request", async () => {
  const s = await setup(),
    m = mock(() => ({ wrong: "value" }));
  await expect(advanceGenerator(s.id, "", [], true)).rejects.toThrow();
  const step = (await db.generatorSteps.toArray()).find(
    (x) => x.status === "failed",
  )!;
  await recoverGeneratorStep(step.id, JSON.stringify(card("target-a", "林舟")));
  expect(m.requests).toHaveLength(1);
  expect(await db.generatorResults.count()).toBe(1);
});
it("fails oversized context before any paid request while preserving the author's input", async () => {
  const s = await setup(),
    m = mock();
  await db.profiles.update(profile.id, { context: 7000, maxOutput: 6000 });
  await expect(
    advanceGenerator(s.id, "x".repeat(20000), [], true),
  ).rejects.toThrow("超出");
  expect(m.requests).toHaveLength(0);
  expect(
    (await generatorData(s.id)).turns.some((t) => t.text.length === 20000),
  ).toBe(true);
});
it("rejects repeated clicks and discards a late response after cancellation", async () => {
  const s = await setup();
  let release: () => void = () => {};
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  mock(async (p) => {
    await waiting;
    return card(p.targetId, "林舟");
  });
  const run = advanceGenerator(s.id, "", [], true);
  const observed = run.catch((e) => e);
  await vi.waitFor(async () =>
    expect(
      await db.generatorSteps.where("status").equals("running").count(),
    ).toBe(1),
  );
  await expect(advanceGenerator(s.id)).rejects.toThrow("生成");
  stopGenerator(s.id);
  release();
  await observed;
  expect(await db.generatorResults.count()).toBe(0);
  expect(
    (await db.generatorSteps.toArray()).some((x) => x.status === "interrupted"),
  ).toBe(true);
});
it("uses persisted leases to reject another tab", async () => {
  const s = await setup();
  await db.generatorSessions.update(s.id, {
    lease: { token: "other-tab", until: Date.now() + 60000 },
  });
  await expect(advanceGenerator(s.id)).rejects.toThrow("标签页");
});
it("migrates old drafts and failure records once without requests or loss of save mappings", async () => {
  const old = emptyCompletionDraft();
  old.input.source = "旧素材";
  old.candidates = [
    { id: "old-target", name: "旧人物", description: "", selected: true },
  ];
  old.cards = [
    {
      id: "old-card",
      candidateId: "old-target",
      name: "旧人物",
      bio: "",
      sections: completionDimensions.map((title) => ({
        title,
        content: "旧设定",
        basis: "created",
        evidence: "",
      })),
      selected: true,
      savedRoleId: role.id,
    },
  ];
  old.raw = "unfinished";
  await db.roleCompletionDrafts.add(old);
  const m = mock();
  await migrateCompletionGenerator();
  await migrateCompletionGenerator();
  expect(await db.generatorSessions.count()).toBe(1);
  expect((await db.generatorResults.toArray())[0].savedId).toBe(role.id);
  expect((await db.generatorSteps.toArray())[0].raw).toBe("unfinished");
  expect(m.requests).toHaveLength(0);
  expect(await db.roleCompletionDrafts.get(old.id)).toEqual(old);
});
it("round-trips complete sessions with remapped identities in both backup paths and excludes them from work backups", async () => {
  const s = await setup();
  mock();
  await advanceGenerator(s.id);
  const b = await exportBackup();
  expect(b.version).toBe(8);
  validateBackup(b);
  await importBackup(b);
  expect(await db.generatorSessions.count()).toBe(2);
  const copy = (await db.generatorSessions.toArray()).find(
    (x) => x.id !== s.id,
  )!;
  const d = await generatorData(copy.id);
  expect(d.results[0].card!.targetId).toBe(copy.input.targets[0].id);
  expect(d.steps[0].profile).not.toHaveProperty("key");
  const portable = await exportBackupBlob(uid());
  const sid = uid();
  await stageBackup(portable.blob, sid);
  await commitStaged(sid, { replace: false, applySettings: false });
  expect(await db.generatorSessions.count()).toBe(4);
  const story = makeStory("novel", "独立小说", [role]);
  await db.stories.add(story);
  const one = JSON.parse(
    await (await exportBackupBlob(uid(), story.id)).blob.text(),
  );
  for (const t of generatorTables) expect(one[t]).toEqual([]);
});
it("accepts legacy version 7 backups and rejects broken or cross-session references", async () => {
  const s = await setup();
  mock();
  await advanceGenerator(s.id);
  const b: any = await exportBackup();
  const legacy = { ...b, version: 7 };
  for (const t of generatorTables) delete legacy[t];
  expect(validateBackup(legacy).generatorSessions).toEqual([]);
  const bad = structuredClone(b);
  bad.generatorSessions[0].materialIds = ["missing"];
  expect(() => validateBackup(bad)).toThrow("关联");
});
it("deleting a conversation preserves saved output and reference materials", async () => {
  const s = await setup();
  mock();
  await advanceGenerator(s.id);
  await saveGeneratorResults(
    s.id,
    (await generatorData(s.id)).results.map((r) => r.id),
  );
  await deleteGenerator(s.id);
  for (const t of generatorTables) expect(await db.table(t).count()).toBe(0);
  expect(await db.roles.count()).toBe(2);
  expect(await db.world.get(world.id)).toEqual(world);
});
it.each(["chat", "responses", "claude", "gemini"] as const)(
  "passes explicit temperature through %s and accepts structured output",
  async (protocol) => {
    await db.profiles.update(profile.id, {
      protocol,
      outputMode: "schema",
      temperature: 0.47,
    });
    const s = await setup();
    const requests: any[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, init: any) => {
        const b = JSON.parse(init.body);
        requests.push(b);
        const input = JSON.parse(
          protocol === "responses"
            ? b.input
            : protocol === "gemini"
              ? b.contents[0].parts[0].text
              : b.messages.at(-1).content,
        );
        const value =
            input.task === "card"
              ? card(input.targetId, "林舟")
              : { worlds: [] },
          text = JSON.stringify(value);
        if (protocol === "chat") return response(value);
        return new Response(
          JSON.stringify(
            protocol === "responses"
              ? {
                  status: "completed",
                  output: [{ content: [{ type: "output_text", text }] }],
                }
              : protocol === "claude"
                ? { content: [{ type: "text", text }], stop_reason: "end_turn" }
                : {
                    candidates: [
                      { content: { parts: [{ text }] }, finishReason: "STOP" },
                    ],
                  },
          ),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }),
    );
    await advanceGenerator(s.id, "", [], true);
    expect(requests).toHaveLength(2);
    expect(
      requests.every(
        (b) =>
          (protocol === "gemini"
            ? b.generationConfig.temperature
            : b.temperature) === 0.47,
      ),
    ).toBe(true);
  },
);
it("restores a migrated legacy failed card after backup import without querying the original draft", async () => {
  const old = emptyCompletionDraft();
  old.input.source = "旧人物留在海边";
  old.candidates = [
    { id: "old-target", name: "旧人物", description: "", selected: true },
  ];
  old.attempts = [
    {
      id: "old-attempt",
      stage: "card",
      target: old.candidates[0],
      inputKey: "old",
      sourceKey: "old",
      raw: "broken",
      state: "failed",
      error: "旧请求中断",
      created: 1,
      updated: 1,
    },
  ];
  await db.roleCompletionDrafts.add(old);
  await migrateCompletionGenerator();
  const b = await exportBackup();
  await importBackup(b);
  await db.roleCompletionDrafts.clear();
  const copy = (await db.generatorSessions.toArray()).find(
    (s) => s.id !== "legacy-role-completion",
  )!;
  const step = (
    await db.generatorSteps.where("sessionId").equals(copy.id).toArray()
  )[0];
  const m = mock();
  const target = copy.input.targets[0];
  await recoverGeneratorStep(
    step.id,
    JSON.stringify({
      candidateId: target.id,
      name: target.name,
      bio: "",
      sections: completionDimensions.map((title) => ({
        title,
        content: "恢复的旧设定",
        basis: "created",
        evidence: "",
      })),
    }),
  );
  expect(m.requests).toHaveLength(0);
  expect((await generatorData(copy.id)).results[0].card!.targetId).toBe(
    target.id,
  );
});
it("does not let a stale request overwrite a step completed by a replacement owner", async () => {
  const s = await setup();
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  mock(async (p) => {
    await waiting;
    return card(p.targetId, "林舟");
  });
  const run = advanceGenerator(s.id, "", [], true).catch((e) => e);
  await vi.waitFor(async () =>
    expect(
      await db.generatorSteps.where("status").equals("running").count(),
    ).toBe(1),
  );
  const step = (
    await db.generatorSteps.where("status").equals("running").toArray()
  )[0];
  await db.generatorSessions.update(s.id, {
    lease: { token: "replacement", until: Date.now() + 60000 },
  });
  await db.generatorSteps.update(step.id, {
    status: "complete",
    raw: "replacement output",
  });
  release();
  await run;
  expect((await db.generatorSteps.get(step.id))!.raw).toBe(
    "replacement output",
  );
  expect((await db.generatorSteps.get(step.id))!.status).toBe("complete");
});
it("records migration independently so deleting or importing a compatibility session does not recreate it", async () => {
  const old = emptyCompletionDraft();
  old.input.source = "只迁移一次";
  await db.roleCompletionDrafts.add(old);
  await migrateCompletionGenerator();
  const b = await exportBackup();
  await deleteGenerator("legacy-role-completion");
  await migrateCompletionGenerator();
  expect(await db.generatorSessions.count()).toBe(0);
  await importBackup(b, true);
  const count = await db.generatorSessions.count();
  await migrateCompletionGenerator();
  expect(await db.generatorSessions.count()).toBe(count);
});
