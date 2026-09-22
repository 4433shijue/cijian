import Dexie, { type Table } from "dexie";
import { db } from "./db";
import { recordSchemas, mergeTheaterPresets } from "./backup";
import { samplingParameters } from "./sampling";
import { uid, type Preferences, type Role, type Story } from "./types";
import { BackupParser, READ_CHUNK_BYTES } from "./backup-parser";
import {
  backupTables,
  emptyCounts,
  type BackupTable,
  type ImportOptions,
  type ImportSummary,
  type TransferRecord,
} from "./transfer-types";
import { TransferControl, exportSnapshot, visitRows } from "./transfer-store";

async function eachStaged(
  session: string,
  table: BackupTable,
  visit: (value: any) => Promise<void>,
) {
  let order = -1;
  for (;;) {
    const row = await db.transferRecords
      .where("[session+table+order]")
      .between([session, table, order], [session, table, Infinity], false, true)
      .first();
    if (!row) return;
    order = row.order;
    await visit(row.value);
  }
}
const staged = async (session: string, table: BackupTable, id: string) =>
  (await db.transferRecords.get([session, table, id]))?.value;

export async function stageBackup(
  file: Blob,
  session: string,
  control = new TransferControl(),
): Promise<ImportSummary> {
  await db.transferSessions.put({ id: session, touched: Date.now() });
  const counts = emptyCounts();
  let pending: TransferRecord[] = [],
    chars = 0,
    records = 0;
  const flush = async () => {
    control.check();
    if (!pending.length) return;
    await db.transaction(
      "rw",
      db.transferRecords,
      db.transferSessions,
      async () => {
        await db.transferRecords.bulkAdd(pending);
        await db.transferSessions.update(session, { touched: Date.now() });
      },
    );
    pending = [];
    chars = 0;
  };
  const parser = new BackupParser(async (name, raw) => {
    const table = name as BackupTable;
    const value = recordSchemas[table].parse(raw);
    if (!value.id || value.id.length > 2048) throw Error("备份资料 ID 无效");
    if (table === "profiles") {
      samplingParameters(value as any);
      delete (value as any).key;
      (value as any).remember = false;
    }
    const size = JSON.stringify(value).length;
    if (chars + size > READ_CHUNK_BYTES) await flush();
    pending.push({
      session,
      table,
      id: value.id,
      order: counts[table]++,
      value,
    });
    chars += size;
    records++;
    if (pending.length >= 32 || chars >= READ_CHUNK_BYTES) await flush();
  });
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for (let offset = 0; offset < file.size; offset += READ_CHUNK_BYTES) {
    control.check();
    const end = Math.min(offset + READ_CHUNK_BYTES, file.size);
    const bytes = await file.slice(offset, end).arrayBuffer();
    await parser.push(decoder.decode(bytes, { stream: end < file.size }));
    await flush();
    control.report({
      phase: "reading",
      bytes: end,
      totalBytes: file.size,
      records,
    });
  }
  const meta = parser.finish();
  if (counts.preferences > 1) throw Error("备份有多份全局设置");
  await checkStaged(session, control, records, file.size);
  const summary: ImportSummary = {
    session,
    created: String(meta.created),
    scope: meta.scope === "story" ? "story" : "library",
    title: meta.title as string | undefined,
    counts,
    bytes: file.size,
  };
  if (summary.scope === "story" && counts.stories !== 1)
    throw Error("单本备份的故事数量不正确");
  await db.transferSessions.update(session, { summary, touched: Date.now() });
  return summary;
}

async function checkStaged(
  session: string,
  control: TransferControl,
  totalRecords: number,
  bytes: number,
) {
  const stories = new Map<string, Set<string>>();
  let records = 0;
  const progress = () => {
    control.check();
    records++;
    if (records === 1 || records % 32 === 0)
      control.report({
        phase: "checking",
        bytes,
        totalBytes: bytes,
        records,
        totalRecords,
      });
  };
  await eachStaged(session, "stories", async (s: Story) => {
    progress();
    const roles = new Set(s.roles.map((r) => r.id));
    if (
      roles.size !== s.roles.length ||
      [s.player, s.partner].some((id) => id && !roles.has(id))
    )
      throw Error("故事角色关联不完整");
    stories.set(s.id, roles);
  });
  await eachStaged(session, "events", async (e) => {
    progress();
    if (
      !stories.has(e.storyId) ||
      (e.status === "complete" &&
        !e.versions.some((v: any) => v.id === e.versionId))
    )
      throw Error("备份时间线关联不完整");
    if (new Set(e.versions.map((v: any) => v.id)).size !== e.versions.length)
      throw Error("段落版本 ID 重复");
    if (e.rewriteOf) {
      const target = await staged(session, "events", e.rewriteOf.id);
      if (
        !target ||
        target.id === e.id ||
        target.storyId !== e.storyId ||
        target.kind !== e.kind ||
        !target.versions.some((v: any) => v.id === e.rewriteOf.versionId)
      )
        throw Error("重写草稿的原文关联无效");
    }
    if (e.chatBatchId) {
      const batch = await staged(session, "chatBatches", e.chatBatchId);
      if (
        !batch ||
        batch.storyId !== e.storyId ||
        e.kind !== "message" ||
        (e.origin === "user" && !batch.sources.some((r: any) => r.id === e.id))
      )
        throw Error("备份消息的回复批次无效");
    }
    if (e.theater) {
      const t = await staged(session, "theaters", e.theater.id);
      if (!t || t.storyId !== e.storyId || t.eventId !== e.id ||
        t.sourceVersionId !== e.theater.sourceVersionId || t.status !== e.theater.status ||
        t.previousId !== e.theater.previousId)
        throw Error("备份正文的小剧场关联无效");
    }
  });
  await eachStaged(session, "theaters", async (t) => {
    progress();
    const e = await staged(session, "events", t.eventId);
    if (!e || e.storyId !== t.storyId || e.kind !== "novel" ||
      (!e.versions.some((v: any) => v.id === t.sourceVersionId) &&
        !(e.status === "draft" && e.versionId === t.sourceVersionId)))
      throw Error("备份小剧场的正文来源不完整");
    if (t.previousId) {
      const previous = await staged(session, "theaters", t.previousId);
      if (!previous || previous.id === t.id || previous.storyId !== t.storyId ||
        previous.eventId !== t.eventId ||
        previous.status !== "complete")
        throw Error("备份小剧场的已有结果关联无效");
    }
  });
  await eachStaged(session, "memories", async (m) => {
    progress();
    if (!stories.has(m.storyId)) throw Error("备份记忆来源不完整");
    for (const ref of m.sources) {
      const e = await staged(session, "events", ref.id);
      if (
        !e ||
        e.storyId !== m.storyId ||
        !e.versions.some((v: any) => v.id === ref.versionId)
      )
        throw Error("备份记忆来源不完整");
    }
  });
  await eachStaged(session, "chatBatches", async (b) => {
    progress();
    const roles = stories.get(b.storyId);
    if (
      !roles ||
      b.player === b.partner ||
      !roles.has(b.player) ||
      !roles.has(b.partner) ||
      new Set(b.sources.map((r: any) => r.id)).size !== b.sources.length ||
      new Set(b.replyIds).size !== b.replyIds.length ||
      (b.sources.length && b.sources.length !== b.messages.length)
    )
      throw Error("备份聊天批次关联不完整");
    for (const ref of [
      ...b.sources.map((r: any) => ({ ...r, user: true })),
      ...b.replyIds.map((id: string) => ({ id, user: false })),
    ]) {
      const e = await staged(session, "events", ref.id);
      if (
        !e ||
        e.storyId !== b.storyId ||
        e.kind !== "message" ||
        e.chatBatchId !== b.id ||
        e.speaker !== (ref.user ? b.player : b.partner) ||
        e.participants.length !== 2 ||
        !e.participants.includes(b.player) ||
        !e.participants.includes(b.partner) ||
        (ref.user
          ? e.origin !== "user" ||
            !e.versions.some((v: any) => v.id === ref.versionId)
          : e.origin === "user")
      )
        throw Error("备份聊天批次关联不完整");
    }
  });
  control.report({
    phase: "checking",
    bytes,
    totalBytes: bytes,
    records: totalRecords,
    totalRecords,
  });
}

export function backupRemapper() {
  // Only ID metadata is retained; story text, avatars and versions are released
  // after each record. IDs are remapped consistently across tables and versions.
  const ids = new Map<string, string>();
  const id = (old: string): string => {
    if (!old) return "";
    if (!ids.has(old)) ids.set(old, uid());
    return ids.get(old)!;
  };
  const fact = (x: any) => ({ ...x, id: id(x.id), knownBy: x.knownBy.map(id) });
  const role = (x: Role) => ({
    ...x,
    id: id(x.id),
    sourceId: x.sourceId ? id(x.sourceId) : undefined,
    paragraphs: x.paragraphs.map((p) => ({ ...p, id: id(p.id) })),
  });
  const styleIds = new Map<string, string>();
  const theaterPresetIds = new Map<string, string>();
  return {
    id,
    role,
    styleIds,
    theaterPresetIds,
    row(table: BackupTable, x: any, replace: boolean): any {
      switch (table) {
        case "roles":
          return role(x);
        case "world":
          return {
            ...x,
            id: id(x.id),
            roleIds: x.roleIds.map(id),
            storyIds: x.storyIds.map(id),
            knownBy: x.knownBy.map(id),
          };
        case "stories":
          return {
            ...x,
            id: id(x.id),
            title: x.title + (replace ? "" : "（导入副本）"),
            roles: x.roles.map(role),
            worldIds: x.worldIds.map(id),
            player: id(x.player),
            partner: id(x.partner),
            stylePresetId: styleIds.get(x.stylePresetId) || x.stylePresetId,
            theaterPresetIds: (x.theaterPresetIds ?? ["theater-roast"]).map((presetId: string) => theaterPresetIds.get(presetId) || presetId),
            memoryState:
              x.memoryState === "running" ? "interrupted" : x.memoryState,
          };
        case "events":
          return {
            ...x,
            id: id(x.id),
            storyId: id(x.storyId),
            speaker: id(x.speaker),
            participants: x.participants.map(id),
            versionId: id(x.versionId),
            chatBatchId: x.chatBatchId ? id(x.chatBatchId) : undefined,
            theater: x.theater && {
              ...x.theater,
              id: id(x.theater.id),
              sourceVersionId: id(x.theater.sourceVersionId),
              previousId: x.theater.previousId ? id(x.theater.previousId) : undefined,
              status: x.theater.status === "running" ? "interrupted" : x.theater.status,
            },
            rewriteOf: x.rewriteOf && {
              id: id(x.rewriteOf.id),
              versionId: id(x.rewriteOf.versionId),
            },
            facts: x.facts.map(fact),
            versions: x.versions.map((v: any) => ({
              ...v,
              id: id(v.id),
              facts: v.facts.map(fact),
            })),
          };
        case "memories":
          return {
            ...x,
            id: id(x.id),
            storyId: id(x.storyId),
            knownBy: x.knownBy.map(id),
            sources: x.sources.map((r: any) => ({
              id: id(r.id),
              versionId: id(r.versionId),
            })),
          };
        case "chatBatches":
          return {
            ...x,
            id: id(x.id),
            storyId: id(x.storyId),
            player: id(x.player),
            partner: id(x.partner),
            sources: x.sources.map((r: any) => ({
              id: id(r.id),
              versionId: id(r.versionId),
            })),
            replyIds: x.replyIds.map(id),
            status: x.status === "running" ? "interrupted" : x.status,
            error:
              x.status === "running"
                ? "导入的回复尚未完成，可以重试本组。"
                : x.error,
          };
        case "profiles":
          return { ...x, id: id(x.id), remember: false, key: undefined };
        case "theaters":
          return {
            ...x,
            id: id(x.id),
            storyId: id(x.storyId),
            eventId: id(x.eventId),
            sourceVersionId: id(x.sourceVersionId),
            previousId: x.previousId ? id(x.previousId) : undefined,
            presets: x.presets.map((preset: any) => ({ ...preset, id: theaterPresetIds.get(preset.id) || preset.id })),
            status: x.status === "running" ? "interrupted" : x.status,
            error: x.status === "running" ? "导入的小剧场尚未完成，可以重新生成。" : x.error,
          };
        case "roleDrafts":
          return { id: x.id, role: role(x.role) };
        default:
          return x;
      }
    },
  };
}

export async function commitStaged(
  session: string,
  options: ImportOptions,
  control = new TransferControl(),
) {
  const summary = (await db.transferSessions.get(session))?.summary;
  if (!summary) throw Error("导入预览已失效，请重新选择文件");
  if (summary.scope === "story" && options.replace)
    throw Error("单本故事备份只能作为副本合并，不能替换全部资料");
  const remap = backupRemapper();
  const totalRecords = Object.values(summary.counts).reduce((a, b) => a + b, 0);
  await db
    .transaction("rw", db.tables, async () => {
      control.transaction = Dexie.currentTransaction!;
      control.check();
      if (
        (await db.jobs.where("status").equals("running").count()) ||
        (await db.chatBatches.where("status").equals("running").count()) ||
        (await db.theaters.where("status").equals("running").count()) ||
        (await db.stories.filter((s) => s.memoryState === "running").count())
      )
        throw Error(
          "请先停止正在进行的生成或记忆整理，再导入备份。现有资料未改变。",
        );
      const existing = await db.preferences.get("preferences");
      const imported = (await staged(session, "preferences", "preferences")) as
        Preferences | undefined;
      const apply = options.applySettings && summary.scope !== "story";
      const theaterPresets = mergeTheaterPresets(existing?.theaterPresets || [], imported?.theaterPresets || []);
      for (const [before, after] of theaterPresets.ids) remap.theaterPresetIds.set(before, after);
      const styles = [...(existing?.stylePresets || [])];
      for (const preset of imported?.stylePresets || []) {
        const old = styles.find((p) => p.id === preset.id);
        if (
          old &&
          old.name === preset.name &&
          old.description === preset.description &&
          old.prompt === preset.prompt &&
          old.scope === preset.scope
        )
          continue;
        const id = old || preset.id.startsWith("builtin-") ? uid() : preset.id;
        remap.styleIds.set(preset.id, id);
        styles.push({ ...preset, id, builtIn: false });
      }
      if (options.replace) {
        for (const table of db.tables) {
          if (
            table.name.startsWith("transfer") ||
            table.name === "roleDrafts" ||
            (!apply && ["profiles", "preferences"].includes(table.name))
          )
            continue;
          await table.clear();
        }
      }
      let records = 0;
      for (const table of backupTables) {
        if (table === "preferences" || (table === "profiles" && !apply))
          continue;
        await eachStaged(session, table, async (value) => {
          control.check();
          const row = remap.row(table, value, options.replace);
          if (table === "roleDrafts" && (await db.roleDrafts.get(row.id))) {
            // The role editor has one draft slot. Keep both without replacing a
            // draft the author is editing; the imported one remains editable.
            await db.roles.add({
              ...row.role,
              name: row.role.name + "（导入草稿）",
            });
          } else await (db[table] as Table<any, string>).bulkAdd([row]);
          records++;
          if (records === 1 || records % 16 === 0)
            control.report({
              phase: "importing",
              bytes: summary.bytes,
              totalBytes: summary.bytes,
              records,
              totalRecords,
            });
        });
      }
      await db.preferences.put({
        ...(existing || {
          id: "preferences",
          activeProfile: "",
          developer: false,
          prompts: {},
        }),
        ...(apply && imported
          ? { ...imported, activeProfile: remap.id(imported.activeProfile) }
          : {}),
        stylePresets: styles,
        theaterPresets: theaterPresets.presets,
      });
      control.check();
    })
    .finally(() => {
      control.transaction = undefined;
    });
}

export async function exportBackupBlob(
  session: string,
  storyId?: string,
  control = new TransferControl(),
) {
  const { writer, result: title } = await exportSnapshot(
    session,
    control,
    async (writer) => {
      const s = storyId ? await db.stories.get(storyId) : undefined;
      if (storyId && !s) throw Error("这本故事已不存在");
      const castRoles = new Set(
        s?.roles.flatMap((r) => [r.id, r.sourceId || ""]) || [],
      );
      const relatedRoles = new Set(castRoles);
      const relatedWorld = new Set<string>();
      const relatedTheaterPresets = new Set(s ? s.theaterPresetIds ?? ["theater-roast"] : []);
      if (s) await db.theaters.where("storyId").equals(s.id).each((theater) => {
        for (const preset of theater.presets) relatedTheaterPresets.add(preset.id);
      });
      if (s)
        await visitRows(db.world, async (w) => {
          if (
            s.worldIds.includes(w.id) ||
            ((!w.storyIds.length || w.storyIds.includes(s.id)) &&
              (!w.roleIds.length || w.roleIds.some((id) => castRoles.has(id))))
          ) {
            relatedWorld.add(w.id);
            for (const id of [...w.roleIds, ...w.knownBy]) relatedRoles.add(id);
          }
        });
      await writer.write(
        JSON.stringify({
          format: "little-scene",
          version: 2,
          created: new Date().toISOString(),
          scope: s ? "story" : "library",
          ...(s ? { title: s.title } : {}),
        }).slice(0, -1),
      );
      let records = 0;
      for (const table of backupTables) {
        await writer.write(',"' + table + '":[');
        let first = true;
        await visitRows(db.table(table), async (raw: any) => {
          control.check();
          if (s) {
            if (["profiles", "roleDrafts"].includes(table)) return;
            if (table === "stories" && raw.id !== s.id) return;
            if (
              ["events", "memories", "chatBatches", "theaters"].includes(table) &&
              raw.storyId !== s.id
            )
              return;
            if (table === "roles" && !relatedRoles.has(raw.id)) return;
            if (table === "world" && !relatedWorld.has(raw.id)) return;
          }
          // Schema parsing deliberately excludes request traces, transient ideas,
          // and future internal fields from portable backups.
          const row: any = recordSchemas[table].parse(raw);
          if (table === "profiles") {
            delete row.key;
            row.remember = false;
          }
          if (s && table === "world") row.storyIds = [s.id];
          if (s && table === "preferences") {
            row.activeProfile = "";
            row.developer = false;
            row.prompts = {};
            row.stylePresets = row.stylePresets?.filter(
              (p: any) => p.id === s.stylePresetId,
            );
            row.theaterPresets = row.theaterPresets?.filter(
              (p: any) => relatedTheaterPresets.has(p.id),
            );
          }
          await writer.write((first ? "" : ",") + JSON.stringify(row));
          first = false;
          records++;
          if (records === 1 || records % 16 === 0)
            control.report({
              phase: "exporting",
              bytes: writer.bytes,
              totalBytes: 0,
              records,
            });
        });
        await writer.write("]");
      }
      await writer.write("}");
      return s?.title;
    },
  );
  return {
    blob: await writer.finish("application/json"),
    filename: `${title || "此间"}-${title ? "故事" : "完整"}备份-${new Date().toISOString().slice(0, 10)}.json`,
  };
}
