import Dexie from "dexie";

// Queue only after the outermost content transaction commits. No network or
// generated attachments can escape a rolled-back draft/adoption transaction.
function afterCommit(work: () => Promise<unknown>) {
  let transaction = Dexie.currentTransaction;
  while (transaction?.parent) transaction = transaction.parent;
  const launch = () => {
    void work().catch(() => {});
  };
  if (transaction) transaction.on("complete", launch);
  else launch();
}
export function schedulePhoneImages(ids: string[], runId?: string) {
  afterCommit(() =>
    import("./image-generation").then((m) => m.queuePhoneImages(ids, runId)),
  );
}
export function scheduleNovelImage(id: string) {
  afterCommit(() =>
    import("./image-generation").then((m) => m.createNovelImage(id, true)),
  );
}
