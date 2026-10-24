import React from "react";
import { createRoot } from "react-dom/client";
import { initialize, db } from "./db";
import App from "./App";
import { initializeImages } from "./image-generation";
import "./style.css";
import { cleanupTransfers } from "./transfer-store";
db.on("blocked", () => {
  const root = document.getElementById("root")!;
  root.textContent =
    "升级正在等待其他页面关闭。请关闭此间的旧标签页，升级会自动继续。";
});
initialize()
  .then(async () => {
    const preferences = await db.preferences.get("preferences");
    if (
      !preferences?.generatorLegacyMigrated &&
      ((await db.roleCompletionDrafts.get("role-completion")) ||
        (await db.generatorSessions.get("legacy-role-completion")))
    ) {
      await (await import("./generator")).migrateCompletionGenerator();
    }
  })
  .then(initializeImages)
  .then(() => cleanupTransfers().catch(() => {}))
  .then(() =>
    createRoot(document.getElementById("root")!).render(
      <React.StrictMode>
        <App />
      </React.StrictMode>,
    ),
  )
  .catch((e) => {
    document.getElementById("root")!.textContent =
      "本地资料未能完成升级，原存档仍保留。请检查存储空间、关闭其他旧页面后重试。" +
      String(e);
    const retry = document.createElement("button");
    retry.textContent = "重试打开与迁移";
    retry.onclick = () => location.reload();
    document.getElementById("root")!.append(retry);
  });
