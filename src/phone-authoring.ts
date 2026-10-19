import { assertAutomationIdle } from "./phone-automation";
import { phoneInstruction } from "./phone-prompt-runtime";
import { db, keyFor } from "./db";
import { uid, type Story } from "./types";
import { requireStory } from "./story-service";
import { emptyBody, type PhoneRecord } from "./phone-types";
import { addRecord, editRecord, phoneTime, recordText } from "./phone-store";
import {
  documentSchema,
  compositionSchema,
  type PhoneDocument,
  type DraftLine,
  type PhoneDraft,
  type PhoneEdit,
} from "./work-types";
import { phoneContext } from "./phone-context";
import { assemble } from "./context";
import { generate } from "./model";
import { parseJSON } from "./output";
import { withStoryLock } from "./locks";

export async function savePhoneDocument(
  input: Partial<PhoneDocument> &
    Pick<PhoneDocument, "storyId" | "ownerId" | "kind">,
  expected?: string,
) {
  return db.transaction("rw", db.tables, async () => {
    const story = await requireStory(input.storyId, "phone"),
      old = input.id ? await db.phoneDocuments.get(input.id) : undefined;
    if (
      (input.id && (!old || old.storyId !== story.id)) ||
      (old && expected !== old.versionId)
    )
      throw Error("文档已改变，请重新打开编辑");
    const now = Date.now(),
      id = old?.id || uid(),
      versionId = uid();
    const next = {
      title: "",
      text: "",
      assets: [],
      time: phoneTime(),
      album: "",
      recipientId: "",
      audience: [input.ownerId],
      pinned: false,
      deleted: false,
      created: now,
      versions: [],
      ...old,
      ...input,
      id,
      versionId,
      updated: now,
    };
    if (!next.title.trim()) throw Error("请填写标题");
    if (
      !next.audience.includes(next.ownerId) ||
      [next.ownerId, ...next.audience, next.recipientId]
        .filter(Boolean)
        .some((id) => !story.roles.some((r) => r.id === id))
    )
      throw Error("文档知情范围无效");
    for (const id of next.assets) {
      const a = await db.phoneAssets.get(id);
      if (a?.storyId !== story.id || !a.mime.startsWith("image/"))
        throw Error("请选择本作品的图片素材");
    }
    if (next.kind === "photo" && !next.assets.length)
      throw Error("照片需要至少一张图片");
    const {
      versions: _,
      storyId: _s,
      ownerId: _o,
      kind: _k,
      versionId: _v,
      updated: _u,
      ...version
    } = next;
    const checked = documentSchema.parse({
      ...next,
      versions: [
        ...(old?.versions || []),
        { ...version, id: versionId, created: now },
      ],
    });
    await db.phoneDocuments.put(checked);
    return checked;
  });
}

export function parseScript(
  text: string,
  story: Story,
  mapping: Record<string, string> = {},
) {
  const rows: {
    label: string;
    text: string;
    speakerId: string;
    error: string;
  }[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const match = line.match(/^([^：:]{1,80})[：:]\s*(.*)$/);
    if (!match) {
      if (rows.length) rows[rows.length - 1].text += "\n" + line;
      else
        rows.push({
          label: "未识别",
          text: line,
          speakerId: "",
          error: "请使用 角色名：内容",
        });
      continue;
    }
    const label = match[1].trim(),
      roles = story.roles.filter((r) => r.name === label);
    const speakerId = mapping[label] || (roles.length === 1 ? roles[0].id : "");
    rows.push({
      label,
      text: match[2],
      speakerId,
      error: !speakerId ? "请指定角色" : !match[2].trim() ? "消息内容为空" : "",
    });
  }
  return rows;
}
async function editable(storyId: string, conversationId: string) {
  await assertAutomationIdle(storyId);
  await requireStory(storyId, "phone");
  const c = await db.phoneConversations.get(conversationId);
  if (c?.storyId !== storyId) throw Error("会话不存在");
  if (
    (await db.phoneRuns
      .where("storyId")
      .equals(storyId)
      .filter(
        (r) => r.conversationId === conversationId && r.status === "running",
      )
      .count()) ||
    (await db.phoneDrafts
      .where("storyId")
      .equals(storyId)
      .filter(
        (d) =>
          d.conversationId === conversationId &&
          d.generation?.status === "running",
      )
      .count())
  )
    throw Error("本会话正在生成，完成后再批量编排");
  return c;
}
async function snapshotEdit(
  storyId: string,
  conversationId: string,
  title: string,
  records: PhoneRecord[],
): Promise<PhoneEdit> {
  return {
    id: uid(),
    storyId,
    conversationId,
    title,
    created: Date.now(),
    undone: false,
    added: [],
    after: {},
    before: records.map((r) => ({
      id: r.id,
      versionId: r.versionId,
      seq: r.seq,
      time: r.time,
      body: r.body,
      deleted: r.deleted,
    })),
  };
}
export async function saveComposition(draft: PhoneDraft) {
  return db.transaction("rw", db.tables, async () => {
    const c = await editable(draft.storyId, draft.conversationId),
      story = await requireStory(draft.storyId, "phone");
    if (
      draft.lines.some(
        (l) =>
          !story.roles.some((r) => r.id === l.speakerId) ||
          (!l.body.text.trim() &&
            !l.body.assets.length &&
            !["call", "transfer"].includes(l.body.type)),
      )
    )
      throw Error("请补全发言角色与消息内容");
    const old = await db.phoneDrafts.get(draft.id);
    if (old && old.updated !== draft.updated)
      throw Error("草稿已在别处修改，请重新打开");
    const checked = compositionSchema.parse({
      ...draft,
      lines: draft.lines.map((l) => ({
        ...l,
        audience: l.sourceId ? l.audience : c.members,
      })),
      updated: Math.max(Date.now(), (old?.updated || 0) + 1),
    });
    await db.phoneDrafts.put(checked);
    return checked;
  });
}
export async function copyComposition(
  storyId: string,
  conversationId: string,
  ids: string[],
) {
  return db.transaction("rw", db.tables, async () => {
    await editable(storyId, conversationId);
    const records = (await db.phoneRecords.bulkGet(ids)).filter(
      (r): r is PhoneRecord =>
        !!r &&
        r.storyId === storyId &&
        r.conversationId === conversationId &&
        !r.deleted,
    );
    if (records.length !== ids.length || !records.length)
      throw Error("请选择有效消息");
    records.sort((a, b) => a.seq - b.seq);
    const draft: PhoneDraft = {
      id: uid(),
      storyId,
      conversationId,
      title: "对话变体",
      status: "draft",
      updated: Date.now(),
      sourceVersions: Object.fromEntries(
        records.map((r) => [r.id, r.versionId]),
      ),
      lines: records.map((r) => ({
        id: uid(),
        speakerId: r.speakerId,
        body: r.body,
        time: r.time,
        audience: r.audience,
        sourceId: r.id,
        sourceVersion: r.versionId,
      })),
    };
    await db.phoneDrafts.add(draft);
    return draft;
  });
}
export async function adoptComposition(id: string) {
  return db.transaction("rw", db.tables, async () => {
    const d = await db.phoneDrafts.get(id);
    if (!d || d.status !== "draft") throw Error("草稿不存在或已经采用");
    const c = await editable(d.storyId, d.conversationId);
    const originals: PhoneRecord[] = [];
    for (const [id, v] of Object.entries(d.sourceVersions)) {
      const r = await db.phoneRecords.get(id);
      if (!r || r.versionId !== v || r.deleted)
        throw Error("原消息已修改，草稿未覆盖原稿");
      originals.push(r);
    }
    const edit = await snapshotEdit(d.storyId, c.id, "采用编排草稿", originals);
    for (const r of originals) {
      await editRecord(r.id, { deleted: true }, r.versionId);
      edit.after[r.id] = (await db.phoneRecords.get(r.id))!.versionId;
    }
    let index = 0;
    const first = originals.length
      ? Math.min(...originals.map((r) => r.seq))
      : undefined;
    for (const l of d.lines) {
      const source = l.sourceId
        ? originals.find((r) => r.id === l.sourceId)
        : undefined;
      if (l.sourceId && !source) throw Error("变体来源不完整");
      const audience = source?.audience || c.members;
      if (!audience.includes(l.speakerId))
        throw Error("发言角色不在该消息原有受众中");
      const record = await addRecord(
        d.storyId,
        {
          conversationId: c.id,
          speakerId: l.speakerId,
          body: l.body,
          time: l.time,
          audience,
          ...(first === undefined
            ? {}
            : { seq: first + (++index / (d.lines.length + 1)) * 0.001 }),
        },
        !!source,
      );
      edit.added.push(record.id);
      edit.after[record.id] = record.versionId;
    }
    await db.phoneEdits.add(edit);
    await db.phoneDrafts.update(id, { status: "adopted", updated: Date.now() });
    return edit;
  });
}
export async function batchMessages(
  storyId: string,
  conversationId: string,
  versions: Record<string, string>,
  options: { time?: string; order?: string[] },
) {
  return db.transaction("rw", db.tables, async () => {
    await editable(storyId, conversationId);
    const records: PhoneRecord[] = [];
    for (const [id, v] of Object.entries(versions)) {
      const r = await db.phoneRecords.get(id);
      if (
        !r ||
        r.versionId !== v ||
        r.storyId !== storyId ||
        r.conversationId !== conversationId ||
        r.deleted
      )
        throw Error("消息已改变，请刷新后重试");
      records.push(r);
    }
    if (!records.length) throw Error("请先选择消息");
    if (
      options.order &&
      (new Set(options.order).size !== records.length ||
        options.order.some((id) => !versions[id]))
    )
      throw Error("排序范围已改变");
    const edit = await snapshotEdit(
      storyId,
      conversationId,
      options.order ? "调整消息顺序" : "批量剧情时间",
      records,
    );
    const positions = records.map((r) => r.seq).sort((a, b) => a - b);
    for (const r of records) {
      await editRecord(
        r.id,
        options.time ? { time: options.time } : {},
        r.versionId,
      );
      if (options.order)
        await db.phoneRecords.update(r.id, {
          seq: positions[options.order.indexOf(r.id)],
        });
      edit.after[r.id] = (await db.phoneRecords.get(r.id))!.versionId;
    }
    await db.phoneEdits.add(edit);
    return edit;
  });
}
export async function undoPhoneEdit(id: string) {
  return db.transaction("rw", db.tables, async () => {
    const edit = await db.phoneEdits.get(id);
    if (!edit || edit.undone) throw Error("操作已撤销");
    await editable(edit.storyId, edit.conversationId);
    for (const [id, v] of Object.entries(edit.after))
      if ((await db.phoneRecords.get(id))?.versionId !== v)
        throw Error("消息在操作后已修改，不能直接撤销");
    for (const b of edit.before) {
      await editRecord(
        b.id,
        { body: b.body, time: b.time, deleted: b.deleted },
        edit.after[b.id],
      );
      await db.phoneRecords.update(b.id, { seq: b.seq });
    }
    for (const id of edit.added)
      await editRecord(id, { deleted: true }, edit.after[id]);
    await db.phoneEdits.update(edit.id, { undone: true });
  });
}

const variantControllers = new Map<string, AbortController>();
export const stopVariant = (id: string) => variantControllers.get(id)?.abort();
export async function generateVariant(id: string, situation: string) {
  const initial = await db.phoneDrafts.get(id);
  if (!initial) throw Error("草稿不存在");
  return withStoryLock(`phone:${initial.storyId}`, async () => {
    if (variantControllers.has(id)) throw Error("变体正在生成");
    await editable(initial.storyId, initial.conversationId);
    const story = await requireStory(initial.storyId, "phone"),
      prefs = await db.preferences.get("preferences"),
      profile = prefs && (await db.profiles.get(prefs.activeProfile));
    if (!prefs || !profile || !keyFor(profile)) throw Error("请先配置模型接口");
    const control = new AbortController();
    variantControllers.set(id, control);
    const speakers = [...new Set(initial.lines.map((l) => l.speakerId))];
    const contexts = await db.transaction("r", db.tables, async () =>
      Promise.all(
        initial.lines.map(async (line) => ({
          speaker: line.speakerId,
          sourceLine: line.id,
          context: await phoneContext(
            story.id,
            line.speakerId,
            line.audience,
            situation,
            prefs,
          ),
          lines: initial.lines
            .filter((l) => l.audience.includes(line.speakerId))
            .map((l) => ({
              speaker: story.roles.find((r) => r.id === l.speakerId)?.name,
              text: recordText({ body: l.body, retracted: false }),
            })),
        })),
      ),
    );
    const savedContext = JSON.stringify(contexts);
    let raw = "";
    await db.phoneDrafts.update(id, {
      generation: { status: "running", context: savedContext, raw, error: "" },
    });
    try {
      const lines: DraftLine[] = [];
      for (const item of contexts) {
        const system =
          phoneInstruction("phoneVariant", prefs) + '\n只扮演当前角色。改写给出的对话草稿，输出 JSON {"messages":[{"text":"内容"}]}，0 到 5 条。不要替其他角色发言。';
        const request = assemble(
          system,
          `${item.context}\n可知草稿：${JSON.stringify(item.lines)}\n本轮改写：${recordText({ body: initial.lines.find((l) => l.id === item.sourceLine)!.body, retracted: false })}\n此前已改写且你可见的消息：${JSON.stringify(lines.filter((l) => l.audience.includes(item.speaker)).map((l) => ({ speaker: l.speakerId, text: l.body.text })))}\n作者要求：${situation}`,
          [],
          profile.context,
          profile.maxOutput,
        );
        const result = await generate(
          profile,
          keyFor(profile),
          request.system,
          request.user,
          control.signal,
          (x) => {
            raw = x;
          },
          fetch,
          {
            kind: "phoneVariant",
            schema: {
              type: "object",
              properties: {
                messages: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: { text: { type: "string" } },
                    required: ["text"],
                    additionalProperties: false,
                  },
                  maxItems: 5,
                },
              },
              required: ["messages"],
              additionalProperties: false,
            },
            schemaName: "phone_variant",
          },
        );
        if (control.signal.aborted) throw Error("变体生成已停止，原草稿保留");
        if (!result.complete) throw Error("变体返回不完整");
        const parsed = parseJSON(result.text) as {
          messages?: { text: string }[];
        };
        if (
          !Array.isArray(parsed.messages) ||
          parsed.messages.length > 5 ||
          parsed.messages.some(
            (m) => typeof m.text !== "string" || !m.text.trim(),
          )
        )
          throw Error("变体格式无效，原草稿保留");
        const template = initial.lines.find((l) => l.id === item.sourceLine)!;
        lines.push(
          ...parsed.messages.map((m) => ({
            ...template,
            id: uid(),
            body: { ...emptyBody(), text: m.text },
          })),
        );
      }
      if (!lines.length) throw Error("角色暂未回应，原草稿保留");
      await db.transaction("rw", db.phoneDrafts, async () => {
        const current = await db.phoneDrafts.get(id);
        if (!current || current.updated !== initial.updated)
          throw Error("草稿已修改，生成结果未覆盖");
        await db.phoneDrafts.update(id, {
          lines,
          updated: Date.now(),
          generation: {
            status: "complete",
            context: savedContext,
            raw,
            error: "",
          },
        });
      });
    } catch (e) {
      await db.phoneDrafts.update(id, {
        generation: {
          status: control.signal.aborted ? "interrupted" : "failed",
          context: savedContext,
          raw,
          error: String(e),
        },
      });
      throw e;
    } finally {
      variantControllers.delete(id);
    }
  });
}
