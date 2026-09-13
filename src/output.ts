import type { PromptKind } from "./types";

const unwrap = (raw: string) =>
  raw
    .trim()
    .replace(/^```(?:json)?\s*\n?([\s\S]*?)\s*```$/i, "$1")
    .trim();

// Accept wrappers around one complete JSON value, but never repair missing data.
export function parseJSON(raw: string): any {
  const text = unwrap(raw);
  try {
    return JSON.parse(text);
  } catch {
    /* Inspect complete containers below. */
  }
  const values: unknown[] = [];
  let start = -1,
    depth = 0,
    quoted = false,
    escaped = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (start < 0) {
      if (c === "{" || c === "[") {
        start = i;
        depth = 1;
      }
      continue;
    }
    if (quoted) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') quoted = false;
      continue;
    }
    if (c === '"') quoted = true;
    else if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") {
      if (--depth === 0) {
        try {
          values.push(JSON.parse(text.slice(start, i + 1)));
        } catch {
          /* Invalid container. */
        }
        start = -1;
      }
    }
  }
  if (values.length === 1 && start < 0) return values[0];
  throw Error(
    values.length > 1
      ? "模型返回了多份 JSON，无法确定要采用哪一份。"
      : "模型返回的 JSON 格式不完整或无法解析。",
  );
}

export function draftText(raw: string): string {
  try {
    const data = parseJSON(raw);
    if (typeof data?.text === "string") return data.text;
    if (Array.isArray(data?.messages))
      return data.messages
        .filter((x: unknown) => typeof x === "string")
        .join("\n");
    return typeof data === "string" ? data : "";
  } catch {
    const text = unwrap(raw);
    const m = text.match(/"text"\s*:\s*"((?:[^"\\]|\\.)*)/s);
    if (m) {
      try {
        return JSON.parse('"' + m[1] + '"');
      } catch {
        return m[1].replace(/\\n/g, "\n").replace(/\\"/g, '"');
      }
    }
    // Plain prose is recoverable; protocol objects and broken JSON stay in raw details.
    return /^[\[{]/.test(text) || /"(?:text|messages|error)"\s*:/.test(text)
      ? ""
      : text;
  }
}

export function quotedDialogue(input: string) {
  const matches = [
    ...input.matchAll(
      /“([^”]+)”|「([^」]+)」|『([^』]+)』|"((?:[^"\\]|\\.)+)"/g,
    ),
  ];
  return matches.flatMap((m) => {
    const before = input.slice(Math.max(0, m.index! - 14), m.index);
    const after = input.slice(m.index! + m[0].length);
    const spoken =
      /(?:说|问|答|喊|道|回复|台词|开口)[^。！？\n]{0,8}$/.test(before) ||
      /^[，,]?\s*[^。！？\n]{0,8}(?:说|问|答|喊|道)/.test(after);
    if (
      !spoken &&
      /^(?:的(?:表情|眼神|感觉|样子|意思|语气)|这个(?:词|字|称呼)|一词|二字)/.test(
        after,
      )
    )
      return [];
    return [(m[1] || m[2] || m[3] || m[4]).replace(/\\"/g, '"')];
  });
}
const dialogueForm = (text: string) =>
  text
    .normalize("NFC")
    .replace(/\s+/g, "")
    .replace(/(?:…+|\.{3,}|⋯+)/g, "…")
    .replace(/[“”「」『』]/g, '"');
export function missingQuotes(input: string, text: string) {
  const body = dialogueForm(text);
  return quotedDialogue(input).filter((q) => !body.includes(dialogueForm(q)));
}
export function checkQuotes(input: string, text: string) {
  const missing = missingQuotes(input, text);
  if (missing.length)
    throw Error(
      "以下台词可能被改动或遗漏，已保留草稿，请检查后重写或确认采用。\n" +
        missing.map((q) => `「${q}」`).join("\n"),
    );
}

const string = { type: "string" };
const array = (items: unknown) => ({ type: "array", items });
const object = (properties: Record<string, unknown>) => ({
  type: "object",
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});
const fact = object({ quote: string, knownBy: array(string) });
export const outputSchemas: Record<PromptKind, ReturnType<typeof object>> = {
  novel: object({ text: string, facts: array(fact) }),
  chat: object({ messages: array(string) }),
  facts: object({ facts: array(fact) }),
  memory: object({
    memories: array(
      object({
        text: string,
        sourceIds: array(string),
        knownBy: array(string),
        scope: { type: "string", enum: ["story", "roles"] },
      }),
    ),
  }),
  inspiration: object({
    options: array(
      object({
        direction: {
          type: "string",
          enum: ["relationship", "discovery", "external", "decision"],
        },
        title: string,
        text: string,
      }),
    ),
  }),
};
