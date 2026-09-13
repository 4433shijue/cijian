import React from "react";
import { createRoot } from "react-dom/client";
import { initialize } from "./db";
import App from "./App";
import "./style.css";
initialize()
  .then(() =>
    createRoot(document.getElementById("root")!).render(
      <React.StrictMode>
        <App />
      </React.StrictMode>,
    ),
  )
  .catch((e) => {
    document.getElementById("root")!.textContent =
      "本地资料库无法打开，请检查浏览器存储权限。" + String(e);
  });
