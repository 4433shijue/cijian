import { Parser } from "htmlparser2";

const ignored = new Set([
  "script",
  "style",
  "template",
  "iframe",
  "object",
  "noscript",
  "head",
]);
const blocks = new Set([
  "address",
  "article",
  "aside",
  "blockquote",
  "br",
  "dd",
  "div",
  "dl",
  "dt",
  "figcaption",
  "figure",
  "footer",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hr",
  "li",
  "main",
  "nav",
  "ol",
  "p",
  "pre",
  "section",
  "table",
  "tbody",
  "td",
  "th",
  "thead",
  "tr",
  "ul",
]);

/** Extract readable text without a DOM, executing code, or fetching resources. */
export function theaterText(html: string): string {
  const parts: string[] = [];
  const stack: boolean[] = [];
  let hidden = 0;
  const parser = new Parser(
    {
      onopentag(name, attributes) {
        const suppress =
          ignored.has(name) ||
          "hidden" in attributes ||
          attributes["aria-hidden"] === "true";
        stack.push(suppress);
        if (suppress) hidden++;
        if (!hidden && blocks.has(name) && name !== "br" && name !== "hr")
          parts.push("\n");
      },
      ontext(text) {
        if (!hidden) parts.push(text);
      },
      onclosetag(name) {
        if (stack.pop()) hidden--;
        if (!hidden && blocks.has(name)) parts.push("\n");
      },
    },
    { decodeEntities: true },
  );
  parser.write(html);
  parser.end();
  return parts
    .join("")
    .replace(/[\t\f\r \u00a0]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
