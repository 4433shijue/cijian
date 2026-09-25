import DOMPurify from "dompurify";
import { theaterTemplateStyleTag } from "./theater-template";
import type { TheaterPresentation } from "./types";

function containsResourceCss(css: string) {
  const normalized = css.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\\([\da-f]{1,6})\s?|\\([^\r\n])/gi,
    (_match, hex: string | undefined, character: string | undefined) => hex ? String.fromCodePoint(Math.min(0x10ffff, parseInt(hex, 16)) || 0xfffd) : character || "");
  return /@import|@font-face|(?:url|(?:-webkit-)?image-set|image|src)\s*\(|<url>|expression\s*\(|-moz-binding|behavior\s*:/i.test(normalized);
}

const theaterBaseStyles = `html{color-scheme:light;overflow-wrap:anywhere}body{margin:0;padding:12px;box-sizing:border-box;background:transparent;color:#324c40;font:15px/1.8 system-ui,-apple-system,"Segoe UI",sans-serif}*,*::before,*::after{box-sizing:border-box}img,table,pre{max-width:100%}pre{white-space:pre-wrap}a{color:inherit;text-decoration:none}@media(prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important;transition:none!important}}`;

/**
 * Keeps the document-level fallback styles in one place so they are included
 * even when the model omits a style block. The template CSS is static and is
 * inserted only after model markup has passed DOMPurify.
 */
export function theaterHeadStyles(customStyles: string) {
  return `<style data-theater-base-styles>${theaterBaseStyles}</style>${theaterTemplateStyleTag()}${customStyles}`;
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
export function theaterDocument(html: string, presentations?: TheaterPresentation[]): string {
  const clean = DOMPurify.sanitize(html, {
    WHOLE_DOCUMENT: true,
    USE_PROFILES: { html: true },
    ADD_TAGS: ["style"],
    FORBID_TAGS: [
      "script", "iframe", "frame", "frameset", "object", "embed", "applet",
      "form", "input", "button", "select", "textarea", "option", "base",
      "meta", "link", "audio", "video", "source", "track", "canvas",
    ],
    FORBID_ATTR: [
      "href", "src", "srcset", "action", "formaction", "target", "ping",
      "poster", "background", "data", "xlink:href", "autofocus", "contenteditable",
    ],
  });
  const doc = new DOMParser().parseFromString(clean, "text/html");
  // Remove resource-bearing CSS before it reaches a live document. CSP remains the final boundary.
  for (const style of doc.querySelectorAll("style")) if (containsResourceCss(style.textContent || "")) style.remove();
  for (const element of doc.querySelectorAll("[style]")) if (containsResourceCss(element.getAttribute("style") || "")) element.removeAttribute("style");
  const styles = Array.from(doc.head.querySelectorAll("style"), (style) => style.outerHTML).join("");
  const body = fallbackTemplateWrapper(doc.body.innerHTML, presentations);
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src 'none'; font-src 'none'; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"><meta name="referrer" content="no-referrer"><meta name="viewport" content="width=device-width,initial-scale=1">${theaterHeadStyles(styles)}</head><body>${body}</body></html>`;
}
