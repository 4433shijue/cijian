import DOMPurify from "dompurify";
import { theaterTemplateStyleTag } from "./theater-template";
import type { TheaterPresentation } from "./types";

export interface TheaterReading {
  clarity: boolean;
  fontSize: number;
}

/** Saved/imported reading settings never get to inject CSS. */
export function theaterReading(value?: Partial<TheaterReading>): TheaterReading {
  return {
    clarity: value?.clarity !== false,
    fontSize: Number.isFinite(value?.fontSize)
      ? Math.max(16, Math.min(24, Math.round(value!.fontSize!)))
      : 16,
  };
}

function containsResourceCss(css: string) {
  const normalized = css.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\\([\da-f]{1,6})\s?|\\([^\r\n])/gi,
    (_match, hex: string | undefined, character: string | undefined) => hex ? String.fromCodePoint(Math.min(0x10ffff, parseInt(hex, 16)) || 0xfffd) : character || "");
  return /@import|@font-face|(?:url|(?:-webkit-)?image-set|image|src)\s*\(|<url>|expression\s*\(|-moz-binding|behavior\s*:/i.test(normalized);
}

const theaterBaseStyles = `html{color-scheme:light;overflow-wrap:anywhere}body{margin:0;padding:12px;box-sizing:border-box;background:#fffdf8;color:#263c32;font:16px/1.8 system-ui,-apple-system,"Segoe UI",sans-serif}*,*::before,*::after{box-sizing:border-box}img,table,pre{max-width:100%}pre{white-space:pre-wrap}a{color:inherit;text-decoration:none}@media(prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important;transition:none!important}}`;

/**
 * Keeps the document-level fallback styles in one place so they are included
 * even when the model omits a style block. The template CSS is static and is
 * inserted only after model markup has passed DOMPurify.
 */
export function theaterHeadStyles(customStyles: string, reading?: Partial<TheaterReading>) {
  const settings = theaterReading(reading);
  const clarity = settings.clarity ? `<style data-theater-clarity-styles>
html,body{color-scheme:light!important;background:#fffdf8!important;color:#263c32!important}
*,*::before,*::after{opacity:1!important;filter:none!important;backdrop-filter:none!important;mix-blend-mode:normal!important;-webkit-text-fill-color:currentColor!important;-webkit-text-stroke:0!important;text-shadow:none!important;animation:none!important;transition:none!important}
body::before,body::after{display:none!important}
</style>` : "";
  // Clear reading is entirely app-styled. This also drops model pseudo-elements
  // that could cover text despite per-element paint overrides.
  return `<style data-theater-base-styles>${theaterBaseStyles}</style>${theaterTemplateStyleTag()}${settings.clarity ? "" : customStyles}<style data-theater-reading-styles>body{font-size:${settings.fontSize}px}</style>${clarity}`;
}

/** Consistent paint and readable type for the trusted fallback templates. */
export function theaterClarityStyle(tagName: string, fontSize: number) {
  const size = theaterReading({ fontSize }).fontSize;
  const heading = /^H[1-6]$/i.test(tagName);
  return {
    color: "#263c32",
    background: /^(HTML|BODY)$/i.test(tagName) ? "#fffdf8" : "transparent",
    opacity: "1",
    filter: "none",
    "backdrop-filter": "none",
    "mix-blend-mode": "normal",
    "-webkit-text-fill-color": "currentColor",
    "-webkit-text-stroke": "0",
    "text-shadow": "none",
    "text-decoration-color": "currentColor",
    "background-clip": "border-box",
    mask: "none",
    "-webkit-mask": "none",
    "clip-path": "none",
    "font-size": `${heading ? Math.round(size * 1.2) : size}px`,
    "font-family": 'system-ui,-apple-system,"Segoe UI",sans-serif',
    "line-height": "1.8",
    animation: "none",
    transition: "none",
  };
}

function templateMarker(value: TheaterPresentation | undefined) {
  switch (value) {
    case "dialogue":
      return "dialogue";
    case "detail-list":
      return "detail-list";
    case "subtext-card":
      return "subtext-card";
    case "forum":
      return "forum";
    case "body-status":
      return "body-card";
    case "evidence-board":
      return "evidence-board";
    case "relationship-card":
      return "relationship-card";
    case "scene-board":
      return "scene-board";
    default:
      return "";
  }
}

export function fallbackTemplateWrapper(markup: string, presentations: TheaterPresentation[] | undefined) {
  if (/data-theater-template\s*=\s*["']/i.test(markup)) return markup;
  const marker = presentations?.map(templateMarker).find(Boolean);
  return marker ? `<div data-theater-template="${marker}">${markup}</div>` : markup;
}

/** Model HTML is display-only. The iframe also independently blocks scripts and network access. */
export function theaterDocument(html: string, presentations?: TheaterPresentation[], reading?: Partial<TheaterReading>): string {
  const settings = theaterReading(reading);
  const clean = DOMPurify.sanitize(html, {
    WHOLE_DOCUMENT: true,
    USE_PROFILES: { html: true },
    ADD_TAGS: settings.clarity ? [] : ["style"],
    FORBID_TAGS: [
      "script", "iframe", "frame", "frameset", "object", "embed", "applet",
      "form", "input", "button", "select", "textarea", "option", "base",
      "meta", "link", "audio", "video", "source", "track", "canvas",
      ...(settings.clarity ? ["style"] : []),
    ],
    FORBID_ATTR: [
      "href", "src", "srcset", "action", "formaction", "target", "ping",
      "poster", "background", "data", "xlink:href", "autofocus", "contenteditable",
      ...(settings.clarity ? ["style", "hidden", "aria-hidden", "width", "height"] : []),
    ],
  });
  const doc = new DOMParser().parseFromString(clean, "text/html");
  // Clear mode keeps semantic markup and native details, but never model layout
  // or paint rules. Original-theme mode still removes all resource-bearing CSS.
  for (const style of doc.querySelectorAll("style")) if (settings.clarity || containsResourceCss(style.textContent || "")) style.remove();
  for (const element of doc.querySelectorAll("[style]")) if (settings.clarity || containsResourceCss(element.getAttribute("style") || "")) element.removeAttribute("style");
  for (const element of [doc.documentElement, doc.body, ...doc.body.querySelectorAll<HTMLElement>("*:not(style)")]) {
    if (settings.clarity) {
      for (const [property, value] of Object.entries(theaterClarityStyle(element.tagName, settings.fontSize)))
        element.style.setProperty(property, value, "important");
    } else {
      // Even the original visual theme respects the reader's minimum type size.
      element.style.setProperty("font-size", `${/^H[1-6]$/i.test(element.tagName) ? Math.round(settings.fontSize * 1.2) : settings.fontSize}px`, "important");
    }
  }
  const styles = Array.from(doc.head.querySelectorAll("style"), (style) => style.outerHTML).join("");
  const body = fallbackTemplateWrapper(doc.body.innerHTML, presentations);
  const escapeAttribute = (value: string | null) => (value || "").replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  return `<!doctype html><html lang="zh-CN" style="${escapeAttribute(doc.documentElement.getAttribute("style"))}"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src 'none'; font-src 'none'; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"><meta name="referrer" content="no-referrer"><meta name="viewport" content="width=device-width,initial-scale=1">${theaterHeadStyles(styles, settings)}</head><body style="${escapeAttribute(doc.body.getAttribute("style"))}">${body}</body></html>`;
}
