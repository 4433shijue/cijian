import DOMPurify from "dompurify";
import type { TheaterState } from "./types";

const encode = (value: unknown) =>
  JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
type BootConfig = { token: string; state: TheaterState; enabled: boolean };

/** Runs before any author script. The private port is never exposed to the page. */
function contentBoot(config: BootConfig) {
  const channel = new MessageChannel();
  const port = channel.port1;
  const send = port.postMessage.bind(port);
  const stringify = JSON.stringify.bind(JSON),
    parse = JSON.parse.bind(JSON);
  const now = Date.now.bind(Date),
    NativePromise = Promise;
  const listen = window.addEventListener.bind(window);
  const parentSend = parent.postMessage.bind(parent);
  let state = config.state,
    credit = 0,
    seq = 0,
    busy = false,
    enabled = config.enabled;
  const pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  port.onmessage = (event) => {
    const value = event.data;
    if (value?.type === "configure") {
      enabled = value.enabled === true;
      return;
    }
    const handler = pending.get(value?.id);
    if (!handler) return;
    pending.delete(value.id);
    if (value.ok) handler.resolve(value.value);
    else handler.reject(new Error(value.error || "这次操作没能完成"));
  };
  const copy = (value: unknown) => parse(stringify(value));
  const call = (type: string, value: unknown) =>
    new NativePromise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, { resolve, reject });
      send({ type, id, value });
    });
  const gesture = (event: Event) => {
    if (
      event.isTrusted &&
      (event.type === "click" ||
        ["Enter", " "].includes((event as KeyboardEvent).key))
    )
      credit = now();
  };
  listen("click", gesture, true);
  listen("keydown", gesture, true);
  listen("submit", (event) => event.preventDefault(), true);
  const api = Object.freeze({
    getState: () => copy(state),
    saveState: (value: unknown) => {
      let cloned;
      try {
        const json = stringify(value);
        if (typeof json !== "string" || json.length > 65536)
          throw Error("状态过大，未保存");
        cloned = parse(json);
      } catch (error) {
        return NativePromise.reject(error);
      }
      state = cloned;
      return call("save", cloned);
    },
    generate: async (value: string | { prompt: string }) => {
      const prompt = typeof value === "string" ? value : value?.prompt;
      if (!enabled || !credit || now() - credit > 2000 || busy)
        throw Error(
          "请在当前小剧场中点击 AI 按钮后再请求，每次点击只发送一次。",
        );
      credit = 0;
      if (typeof prompt !== "string" || !prompt.trim() || prompt.length > 8000)
        throw Error("请填写有效的补充要求。");
      busy = true;
      try {
        return await call("generate", prompt.trim());
      } finally {
        busy = false;
      }
    },
  });
  Object.defineProperty(window, "cijian", {
    value: api,
    writable: false,
    configurable: false,
  });
  // This first, trusted message transfers the only channel used by the host.
  parentSend({ type: "cijian-content-port", token: config.token }, "*", [
    channel.port2,
  ]);
  let lastHeight = 0,
    lastText = "",
    timer = 0;
  const measure = () => {
    clearTimeout(timer);
    timer = window.setTimeout(() => {
      const height = Math.min(
        12000,
        Math.max(80, Math.ceil(document.body.scrollHeight)),
      );
      if (height !== lastHeight) {
        lastHeight = height;
        send({ type: "height", value: height });
      }
      const snapshot = document.body.cloneNode(true) as HTMLElement;
      snapshot
        .querySelectorAll("script,style,template,noscript")
        .forEach((node) => node.remove());
      snapshot
        .querySelectorAll(
          "h1,h2,h3,h4,h5,h6,p,div,section,article,li,summary,br,tr,pre",
        )
        .forEach((node) => node.append(document.createTextNode("\n")));
      const text = (snapshot.textContent || "")
        .replace(/\n\s*\n\s*\n/g, "\n\n")
        .trim()
        .slice(0, 200000);
      if (text !== lastText) {
        lastText = text;
        send({ type: "text", value: text });
      }
    }, 150);
  };
  listen("error", () => send({ type: "runtime-error" }));
  listen("unhandledrejection", (event: PromiseRejectionEvent) => {
    event.preventDefault();
    send({ type: "runtime-error" });
  });
  listen("DOMContentLoaded", () => {
    new ResizeObserver(measure).observe(document.body);
    new MutationObserver(measure).observe(document.body, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
    });
    measure();
  });
}

/** Trusted outer document blocks even self-navigation of the generated child. */
function guardBoot(config: { token: string; document: string }) {
  let connected = false;
  const frame = document.createElement("iframe");
  frame.setAttribute("sandbox", "allow-scripts");
  frame.setAttribute("referrerpolicy", "no-referrer");
  frame.title = "AI 设计的小剧场";
  frame.style.cssText =
    "display:block;width:100%;height:100vh;border:0;background:transparent";
  window.addEventListener("message", (event) => {
    if (
      connected ||
      event.source !== frame.contentWindow ||
      event.data?.type !== "cijian-content-port" ||
      event.data.token !== config.token ||
      event.ports.length !== 1
    )
      return;
    connected = true;
    parent.postMessage({ type: "cijian-html-port", token: config.token }, "*", [
      event.ports[0],
    ]);
  });
  const url = URL.createObjectURL(
    new Blob([config.document], { type: "text/html" }),
  );
  frame.src = url;
  document.body.append(frame);
  window.addEventListener("pagehide", () => URL.revokeObjectURL(url), {
    once: true,
  });
}

export function freeTheaterDocument(
  html: string,
  options: {
    token: string;
    state?: TheaterState;
    enabled: boolean;
    fontSize?: number;
  },
) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const scripts = [...doc.querySelectorAll("script")]
    .filter(
      (script) =>
        !script.src &&
        (!script.type ||
          /^(?:text\/javascript|application\/javascript|module)$/i.test(
            script.type,
          )),
    )
    .map((script) => ({
      code: script.textContent || "",
      module: script.type === "module",
    }));
  doc
    .querySelectorAll("script,meta,base,link,iframe,frame,object,embed")
    .forEach((node) => node.remove());
  for (const element of doc.querySelectorAll("[href]")) {
    if (!element.getAttribute("href")?.startsWith("#"))
      element.removeAttribute("href");
  }
  const styles = [...doc.querySelectorAll("style")]
    .map((style) => style.outerHTML)
    .join("");
  doc.querySelectorAll("style").forEach((style) => style.remove());
  const clean = DOMPurify.sanitize(doc.documentElement.outerHTML, {
    WHOLE_DOCUMENT: true,
    USE_PROFILES: { html: true, svg: true },
    ADD_TAGS: ["canvas"],
    ADD_ATTR: (name) => /^on[a-z]+$/i.test(name),
    FORBID_TAGS: [
      "script",
      "iframe",
      "frame",
      "frameset",
      "object",
      "embed",
      "applet",
      "meta",
      "base",
      "link",
    ],
    FORBID_ATTR: [
      "action",
      "formaction",
      "target",
      "formtarget",
      "ping",
      "autofocus",
    ],
  });
  const sanitized = new DOMParser().parseFromString(clean, "text/html");
  const attrs = (element: Element) =>
    [...element.attributes]
      .map(
        (attribute) =>
          ` ${attribute.name}="${attribute.value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;")}"`,
      )
      .join("");
  const size = Math.max(16, Math.min(24, options.fontSize || 16));
  const config: BootConfig = {
    token: options.token,
    state: options.state ?? null,
    enabled: options.enabled,
  };
  const content = `<!doctype html><html${attrs(sanitized.documentElement)}><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src 'none'; connect-src 'none'; frame-src 'none'; child-src 'none'; worker-src 'none'; media-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"><meta name="referrer" content="no-referrer"><meta name="viewport" content="width=device-width,initial-scale=1"><script>(${contentBoot.toString()})(${encode(config)})</script><style>html{overflow-wrap:anywhere}body{margin:0;padding:10px;background:#fffdf8;color:#263c32;font:${size}px/1.7 system-ui}*,*::before,*::after{box-sizing:border-box}img,svg,canvas{max-width:100%}pre{white-space:pre-wrap}@media(prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}</style>${styles}</head><body${attrs(sanitized.body)}>${sanitized.body.innerHTML}${scripts.map((script) => `<script${script.module ? ' type="module"' : ""}>${script.code}</script>`).join("\n")}</body></html>`;
  // Only the trusted guard runs here; generated scripts run in the nested,
  // separately sandboxed blob document. Neither frame receives same-origin.
  const token = options.token.replace(/[^a-zA-Z0-9-]/g, "");
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-src blob:; connect-src 'none'; img-src data: blob:; object-src 'none'; base-uri 'none'; form-action 'none'"><style>html,body{margin:0;padding:0;overflow:hidden}</style></head><body><script nonce="${token}">(${guardBoot.toString()})(${encode({ token: options.token, document: content })})</script></body></html>`;
}
