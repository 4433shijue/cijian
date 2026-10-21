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
  forkGeneratorRecovery,
  saveGeneratorDraft,
} from "../src/generator";
import { generatorResultGroups } from "../src/generator-results";
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
  // IndexedDB returns UUID key order, which does not identify the latest generation.
  const regenerated = (await generatorData(s.id)).results.filter(
    (result) =>
      result.kind === "card" && ![r.id, updated.id].includes(result.id),
  );
  expect(regenerated).toHaveLength(1);
  expect(regenerated[0].card!.name).toBe("林知舟");
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
  ).find((s) => s.status !== "complete")!;
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
it("preserves collapsed manual drafts through both backup paths", async () => {
  const s = await setup();
  mock();
  await advanceGenerator(s.id, "", [], true);
  const d = await generatorData(s.id),
    r = d.results[0];
  await saveGeneratorDraft({
    ...d.session,
    editor: {
      resultId: r.id,
      card: { ...r.card!, bio: "尚未采用的手写修改" },
      collapsed: true,
    },
  });
  for (const b of [
    await exportBackup(),
    JSON.parse(await (await exportBackupBlob(uid())).blob.text()),
  ]) {
    validateBackup(b);
    expect(b.generatorSessions[0].editor.collapsed).toBe(true);
    await importBackup(b, true);
    const restored = (await db.generatorSessions.toArray())[0];
    expect(restored.editor?.card?.bio).toBe("尚未采用的手写修改");
    expect(restored.editor?.collapsed).toBe(true);
    expect(
      await db.generatorResults.get(restored.editor!.resultId),
    ).toBeDefined();
  }
});

it.each(["direct", "streamed"])(
  "backs up latest legacy edits and recovery data after migration with %s export",
  async (path) => {
    const old = emptyCompletionDraft();
    old.input.source = "迁移之前";
    await db.roleCompletionDrafts.put(old);
    await migrateCompletionGenerator();
    old.input.source = "迁移之后又编辑的原文";
    old.input.creativity = "creative";
    old.input.targets = "新的候选";
    old.candidates = [
      {
        id: "latest-target",
        name: "新人物",
        description: "未生成的候选",
        selected: true,
      },
    ];
    old.cards = [
      {
        id: "latest-card",
        candidateId: "latest-target",
        name: "新人物",
        bio: "最新手写简介",
        sections: completionDimensions.map((title) => ({
          title,
          content: "新设定",
          basis: "created",
          evidence: "",
          edited: true,
        })),
        selected: false,
        savedRoleId: role.id,
      },
    ];
    old.raw = "另外保留的未完成输出";
    old.attempts = [
      {
        id: "latest-attempt",
        stage: "card",
        target: old.candidates[0],
        inputKey: "new",
        sourceKey: "new",
        raw: "失败输出",
        recoveryText: "手工修复中",
        state: "failed",
        error: "连接中断",
        created: 2,
        updated: 3,
      },
    ];
    await db.roleCompletionDrafts.put(old);
    await migrateCompletionGenerator();
    const b: any =
      path === "direct"
        ? await exportBackup()
        : JSON.parse(await (await exportBackupBlob(uid())).blob.text());
    const snapshot = b.generatorSessions.find(
      (s: any) => s.title === "旧版补全 · 最新编辑备份",
    );
    expect(snapshot.input.source).toBe(old.input.source);
    expect(
      (await db.generatorSessions.get("legacy-role-completion"))!.input.source,
    ).toBe("迁移之前");
    expect(await db.roleCompletionDrafts.get(old.id)).toEqual(old);
    validateBackup(b);
    await db.roleCompletionDrafts.clear();
    if (path === "direct") await importBackup(b, true);
    else {
      const sid = uid();
      await stageBackup(new Blob([JSON.stringify(b)]), sid);
      await commitStaged(sid, { replace: true, applySettings: true });
    }
    const imported = (await db.generatorSessions.toArray()).find(
      (s) => s.title === snapshot.title,
    )!;
    const data = await generatorData(imported.id);
    expect(data.results[0].card!.bio).toBe("最新手写简介");
    expect(await db.roles.get(data.results[0].savedId)).toBeDefined();
    const archive = data.steps.map((s) => JSON.parse(s.legacyData!));
    expect(
      archive.some(
        (a) =>
          a.input?.creativity === "creative" &&
          a.candidates[0].description === "未生成的候选",
      ),
    ).toBe(true);
    expect(archive.some((a) => a.attempt?.recoveryText === "手工修复中")).toBe(
      true,
    );
    expect(
      archive.some(
        (a) => a.card?.sections[0].edited && a.card?.selected === false,
      ),
    ).toBe(true);
    expect(data.steps.some((s) => s.raw === old.raw)).toBe(true);
    expect(await db.roleCompletionDrafts.count()).toBe(0);
  },
);

it("rejects stale interview retries and local recovery, then resumes independently with frozen settings", async () => {
  const s = await setup();
  mock(() => new Response("failed", { status: 500 }));
  await expect(advanceGenerator(s.id, "旧回答")).rejects.toThrow();
  const failed = (await generatorData(s.id)).steps[0];
  const m = mock(() => ({ ...interview, confirmed: ["新的方向"] }));
  await advanceGenerator(s.id, "新回答");
  const before = await generatorData(s.id);
  await expect(retryGenerator(s.id, failed.batchId)).rejects.toThrow(
    "独立会话恢复",
  );
  await expect(
    recoverGeneratorStep(failed.id, JSON.stringify(interview)),
  ).rejects.toThrow("独立会话恢复");
  expect(m.requests).toHaveLength(1);
  expect((await generatorData(s.id)).session.turnIds).toEqual(
    before.session.turnIds,
  );
  expect(await db.generatorSteps.get(failed.id)).toEqual(failed);
  await db.profiles.update(profile.id, { temperature: 0.9 });
  const fork = await forkGeneratorRecovery(failed.id);
  expect(m.requests).toHaveLength(1);
  const copied = (await generatorData(fork.id)).steps[0];
  await retryGenerator(fork.id, copied.batchId);
  expect(m.requests).toHaveLength(2);
  expect(m.requests[1].body.temperature).toBe(failed.profile!.temperature);
  expect(m.requests[1].payload.history.map((t: any) => t.text)).toEqual([
    "旧回答",
  ]);
  expect((await generatorData(s.id)).session.turnIds).toEqual(
    before.session.turnIds,
  );
  expect((await generatorData(fork.id)).session.turnIds).toHaveLength(2);
  validateBackup(await exportBackup());
});

it("recovers a superseded multi-person batch without regenerating its successful cards", async () => {
  const s = await setup(true);
  mock((p) =>
    p.targetId === "target-b"
      ? new Response("failed", { status: 500 })
      : card(p.targetId, "林舟"),
  );
  await expect(
    advanceGenerator(s.id, "旧版双人卡", [], true),
  ).rejects.toThrow();
  const failed = (await generatorData(s.id)).steps.find(
    (s) => s.status === "failed",
  )!;
  mock();
  await advanceGenerator(s.id, "已继续下一轮", [], true);
  const original = await generatorData(s.id);
  const fork = await forkGeneratorRecovery(failed.id);
  const copy = await generatorData(fork.id);
  const m = mock();
  await retryGenerator(fork.id, copy.steps[0].batchId);
  expect(m.requests.map((r) => r.payload.task)).toEqual(["card", "world"]);
  expect(m.requests[0].payload.targetId).toBe(fork.input.targets[1].id);
  expect(m.requests[0].payload.completedCards[0].targetId).toBe(
    fork.input.targets[0].id,
  );
  expect((await generatorData(s.id)).results).toEqual(original.results);
  expect(
    (await generatorData(fork.id)).results.filter((r) => !r.needsReview),
  ).toHaveLength(2);
  validateBackup(await exportBackup());
});

it("refuses retries based on edited result versions and preserves them in a recovery fork", async () => {
  const s = await setup();
  mock();
  await advanceGenerator(s.id, "", [], true);
  const result = (await generatorData(s.id)).results[0];
  mock(() => new Response("failed", { status: 500 }));
  await expect(advanceGenerator(s.id, "请再想想")).rejects.toThrow();
  const failed = (await generatorData(s.id)).steps.find(
    (s) => s.status === "failed",
  )!;
  await editGeneratorResult(result.id, {
    card: { ...result.card!, bio: "之后手改的设定" },
  });
  const m = mock(() => interview);
  await expect(retryGenerator(s.id, failed.batchId)).rejects.toThrow(
    "参考结果已被编辑",
  );
  expect(m.requests).toHaveLength(0);
  const fork = await forkGeneratorRecovery(failed.id);
  const step = (await generatorData(fork.id)).steps[0];
  await retryGenerator(fork.id, step.batchId);
  expect(m.requests[0].payload.existingResults[0].card.bio).toBe(
    result.card!.bio,
  );
  expect(
    (await generatorData(s.id)).results.some(
      (r) => r.card?.bio === "之后手改的设定",
    ),
  ).toBe(true);
});

it("keeps renamed worlds in one version chain and distinct same-title worlds separate in requests and backups", async () => {
  const s = await setup();
  const world = {
    title: "旧标题",
    text: "旧设定",
    type: "world",
    audience: "author",
    roleIds: [],
    knownBy: [],
  };
  mock((p) =>
    p.task === "world"
      ? { worlds: [world, { ...world, text: "同名的另一条设定" }] }
      : card(p.targetId, "林舟"),
  );
  await advanceGenerator(s.id, "", [], true);
  const original = (await generatorData(s.id)).results.find(
    (r) => r.world?.text === "旧设定",
  )!;
  // Even same-millisecond edits/restores must remain ordered by version ancestry.
  const clock = vi.spyOn(Date, "now").mockReturnValue(original.created);
  const renamed = await editGeneratorResult(original.id, {
    world: { ...original.world!, title: "新标题" },
  });
  const d = await generatorData(s.id);
  expect(
    [...generatorResultGroups(d.results).values()].map((l) => l.length).sort(),
  ).toEqual([1, 1, 2]);
  await expect(
    saveGeneratorResults(s.id, [original.id, renamed.id]),
  ).rejects.toThrow("一个版本");
  const m = mock(() => interview);
  await advanceGenerator(s.id, "继续完善");
  const refs = m.requests[0].payload.existingResults
    .filter((r: any) => r.world)
    .map((r: any) => r.world);
  expect(refs).toHaveLength(2);
  expect(refs.find((r: any) => r.text === "旧设定").title).toBe("新标题");
  await importBackup(await exportBackup(), true);
  const copy = (await db.generatorSessions.toArray())[0];
  const restored = await generatorData(copy.id);
  const chain = [...generatorResultGroups(restored.results).values()].find(
    (l) => l.length === 2,
  )!;
  expect(chain[1].world!.title).toBe("新标题");
  await editGeneratorResult(chain[0].id, { world: chain[0].world });
  expect(
    [...generatorResultGroups((await generatorData(copy.id)).results).values()]
      .find((l) => l.length === 3)!
      .at(-1)!.world!.title,
  ).toBe("旧标题");
  clock.mockRestore();
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
