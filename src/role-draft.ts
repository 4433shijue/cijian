import { db } from "./db";
import type { Role } from "./types";

const draftId = "new-role";
let pending: Promise<unknown> = Promise.resolve();

// Reopening and submitting wait for every earlier edit, even after a failed write.
function enqueue<T>(operation: () => Promise<T>): Promise<T> {
  const result = pending.then(operation);
  pending = result.catch(() => undefined);
  return result;
}

export function loadRoleDraft() {
  return enqueue(async () => (await db.roleDrafts.get(draftId))?.role);
}

export function saveRoleDraft(role: Role) {
  const snapshot = structuredClone(role);
  return enqueue(() => db.roleDrafts.put({ id: draftId, role: snapshot }));
}

export function saveCreatedRole(role: Role) {
  const snapshot = structuredClone(role);
  return enqueue(() =>
    db.transaction("rw", [db.roles, db.roleDrafts], async () => {
      await db.roles.put(snapshot);
      const draft = await db.roleDrafts.get(draftId);
      if (draft?.role.id === snapshot.id) await db.roleDrafts.delete(draftId);
    }),
  );
}
