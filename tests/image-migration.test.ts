import "fake-indexeddb/auto";
import Dexie from "dexie";
import { expect, it } from "vitest";
import { SceneDB, db, initialize } from "../src/db";
import { imageConnectionSchema, imageProfileSchema } from "../src/image-types";
import { resolveImageEndpoint } from "../src/image-connection";
import { saveImageProfile } from "../src/image-generation";
import { exportBackup, importBackup, validateBackup } from "../src/backup";
import {
  exportBackupBlob,
  stageBackup,
  commitStaged,
} from "../src/backup-transfer";

it("upgrades an existing v14 profile without changing its effective image route or key", async () => {
  const name = "image-upgrade-" + crypto.randomUUID(),
    legacy = new Dexie(name);
  legacy.version(14).stores({
    imageProfiles: "id",
    imageJobs: "id,storyId,sourceId,runId,status",
    imageAssets: "id,storyId",
  });
  const row = {
    id: "old",
    name: "Old",
    url: "https://fixture.test/proxy/v1/chat/completions",
    model: "old-image",
    references: "multipart",
    remember: true,
    key: "fixture-only-secret",
  };
  await legacy.open();
  await legacy.table("imageProfiles").put(row);
  legacy.close();
  const updated = new SceneDB(name);
  try {
    await updated.open();
    const saved = (await updated.imageProfiles.get("old"))!;
    expect(updated.verno).toBe(16);
    expect(saved.key).toBe(row.key);
    expect(saved.protocol).toBe("images");
    expect(resolveImageEndpoint(imageConnectionSchema.parse(saved))).toBe(
      "https://fixture.test/proxy/v1/images/generations",
    );
    expect(resolveImageEndpoint(imageConnectionSchema.parse(saved), true)).toBe(
      "https://fixture.test/proxy/v1/images/edits",
    );
  } finally {
    await updated.delete();
  }
});

it("round-trips protocol settings and historical combinations through both backup import paths without credentials", async () => {
  await db.delete();
  await db.open();
  await initialize();
  try {
    const p = imageProfileSchema.parse({
      id: "custom-image",
      name: "Custom",
      url: "https://fixture.test/render",
      model: "station-alias",
      protocol: "custom",
      remember: true,
      requestTemplate: '{"model":"{{model}}","input":"{{prompt}}"}',
      extraBody: '{"seed":42}',
      resultPath: "output.0.url",
      pollUrl: "/task/{id}",
      taskIdPath: "task.id",
    });
    p.verified = [
      { testedAt: 1234, connection: imageConnectionSchema.parse(p) },
    ];
    await saveImageProfile(p, "fixture-only-secret");
    const backup = await exportBackup();
    expect(backup.version).toBe(12);
    expect(JSON.stringify(backup)).not.toContain("fixture-only-secret");
    expect(backup.imageProfiles[0]).toMatchObject({
      protocol: "custom",
      pollUrl: "/task/{id}",
      verified: p.verified,
      remember: false,
    });
    const v9 = {
      ...backup,
      version: 9,
      imageProfiles: [
        {
          id: "legacy",
          name: "Legacy",
          url: "https://fixture.test/v1/chat/completions",
          model: "old-image",
        },
      ],
    };
    expect(validateBackup(v9).imageProfiles[0].protocol).toBe("images");
    await importBackup(backup);
    const imported = (await db.imageProfiles.toArray()).find(
      (x) => x.id !== p.id,
    )!;
    expect(imported).toMatchObject({
      protocol: "custom",
      requestTemplate: p.requestTemplate,
      verified: p.verified,
      remember: false,
    });
    expect(imported.key).toBeUndefined();
    const exported = await exportBackupBlob("image-protocol-export");
    const portable = await exported.blob.text();
    expect(portable).not.toContain("fixture-only-secret");
    const session = "image-protocol-import";
    await stageBackup(new File([portable], "fixture.json"), session);
    await commitStaged(session, { replace: false, applySettings: true });
    const copies = await db.imageProfiles.toArray();
    expect(copies.length).toBeGreaterThan(2);
    expect(
      copies.every((x) => x.protocol === "custom" && x.verified.length === 1),
    ).toBe(true);
  } finally {
    await db.delete();
  }
});
