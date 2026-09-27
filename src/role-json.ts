import type { CompletionParseInfo } from "./role-completion-types";

type ErrorKind = "syntax" | "truncated" | "ambiguous";
type Location = { line?: number; column?: number; field?: string };

export class CompletionJSONError extends Error {
  readonly kind: ErrorKind;
  readonly line?: number;
  readonly column?: number;
  readonly field?: string;

  constructor(kind: ErrorKind, location: Location = {}, detail?: string) {
    const position = location.line
      ? `第 ${location.line} 行${location.column ? `、第 ${location.column} 列` : ""}`
      : "";
    const field = location.field ? `（字段 ${location.field}）` : "";
    const reason =
      detail ??
      {
        syntax: "存在语法错误",
        truncated: "尚未形成完整 JSON，未自动补写缺失内容",
        ambiguous: "结构存在歧义，无法安全自动修复",
      }[kind];
    super(
      `角色资料 JSON${position ? ` 在${position}` : ""}${field}${reason}，原始回复已保留。`,
    );
    this.name = "CompletionJSONError";
    this.kind = kind;
    this.line = location.line;
    this.column = location.column;
    this.field = location.field;
  }
}

interface Span {
  start: number;
  end: number;
}
interface TextEdit extends Span {
  replacement: string;
}
interface RepairPlan {
  text: string;
  edits: TextEdit[];
  repairs: CompletionParseInfo["repairs"];
}
const naturalFields = new Set(["bio", "content", "evidence", "description"]);

function locate(text: string, offset: number, field?: string): Location {
  const bounded = Math.max(0, Math.min(offset, text.length));
  let line = 1;
  let lineStart = 0;
  for (let i = 0; i < bounded; i++) {
    if (text[i] === "\n") {
      line++;
      lineStart = i + 1;
    }
  }
  return { line, column: bounded - lineStart + 1, field };
}

// All edits refer to the original response. Insertion and deletion mappings keep
// errors on later lines/columns accurate, including a possible Markdown fence.
function originalOffset(offset: number, edits: TextEdit[]): number {
  let delta = 0;
  for (const edit of edits) {
    const repairedStart = edit.start + delta;
    if (offset < repairedStart) break;
    if (offset < repairedStart + edit.replacement.length) return edit.start;
    delta += edit.replacement.length - (edit.end - edit.start);
  }
  return offset - delta;
}

function syntaxError(
  error: unknown,
  json: string,
  start: number,
  raw: string,
  edits: TextEdit[] = [],
): CompletionJSONError {
  const message = error instanceof Error ? error.message : "";
  const position = /\bposition\s+(\d+)/i.exec(message);
  const lineColumn = /\bline\s+(\d+)\s+column\s+(\d+)/i.exec(message);
  let offset: number | undefined;
  if (position) offset = Number(position[1]);
  else if (lineColumn) {
    const targetLine = Number(lineColumn[1]);
    let line = 1;
    let index = 0;
    while (index < json.length && line < targetLine) {
      if (json[index++] === "\n") line++;
    }
    offset = index + Number(lineColumn[2]) - 1;
  }
  const truncated =
    /unexpected end|unterminated string|end of (?:json|data|input)/i.test(
      message,
    );
  if (offset === undefined && truncated) offset = json.length;
  return new CompletionJSONError(
    truncated ? "truncated" : "syntax",
    offset === undefined
      ? {}
      : locate(raw, originalOffset(start + offset, edits)),
  );
}

function quoteEnd(text: string, start: number): number {
  for (let i = start + 1; i < text.length; i++) {
    if (text[i] === "\\") i++;
    else if (text[i] === '"') return i;
  }
  return text.length;
}

// Called only after strict JSON.parse. It therefore needs no permissive grammar,
// and catches duplicate (including escape-equivalent) keys before JSON.parse's
// last-value-wins behaviour can conceal a damaged field.
function assertUniqueKeys(
  json: string,
  start: number,
  raw: string,
  edits: TextEdit[],
) {
  const stack: { object: boolean; keyExpected: boolean; keys: Set<string> }[] =
    [];
  for (let i = 0; i < json.length; i++) {
    const char = json[i];
    if (char === "{" || char === "[") {
      stack.push({
        object: char === "{",
        keyExpected: char === "{",
        keys: new Set(),
      });
    } else if (char === "}" || char === "]") stack.pop();
    else if (char === ",") {
      const context = stack.at(-1);
      if (context?.object) context.keyExpected = true;
    } else if (char === '"') {
      const end = quoteEnd(json, i);
      const context = stack.at(-1);
      if (context?.object && context.keyExpected) {
        const key: string = JSON.parse(json.slice(i, end + 1));
        if (context.keys.has(key)) {
          const field = /^[a-zA-Z_$][\w$.-]{0,60}$/.test(key) ? key : undefined;
          throw new CompletionJSONError(
            "ambiguous",
            locate(raw, originalOffset(start + i, edits), field),
            "存在重复字段，无法安全确定应采用的值",
          );
        }
        context.keys.add(key);
        context.keyExpected = false;
      }
      i = end;
    }
  }
}

function strictParse(
  json: string,
  start: number,
  raw: string,
  edits: TextEdit[] = [],
): unknown {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch (error) {
    throw syntaxError(error, json, start, raw, edits);
  }
  assertUniqueKeys(json, start, raw, edits);
  return value;
}

// Treat every top-level container as a candidate, even when its contents are
// invalid. A valid object must never be selected in preference to another broken
// object in the same response.
function extractOne(text: string, raw: string, edits: TextEdit[] = []): Span {
  const spans: Span[] = [];
  const stack: string[] = [];
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (inString) {
      if (char === "\n" || char === "\r") {
        throw new CompletionJSONError(
          "truncated",
          locate(raw, originalOffset(i, edits)),
        );
      }
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (stack.length && char === '"') {
      inString = true;
      continue;
    }
    if (char === "{" || char === "[") {
      if (!stack.length) start = i;
      stack.push(char);
    } else if (char === "}" || char === "]") {
      if (!stack.length || stack.at(-1) !== (char === "}" ? "{" : "[")) {
        throw new CompletionJSONError(
          "syntax",
          locate(raw, originalOffset(i, edits)),
        );
      }
      stack.pop();
      if (!stack.length) spans.push({ start, end: i + 1 });
    }
  }
  if (spans.length > 1 || (spans.length && stack.length)) {
    const index = spans.length > 1 ? spans[1].start : start;
    throw new CompletionJSONError(
      "ambiguous",
      locate(raw, originalOffset(index, edits)),
      "包含多份或未完成的 JSON，无法确定唯一结果",
    );
  }
  if (stack.length || inString) {
    throw new CompletionJSONError(
      "truncated",
      locate(raw, originalOffset(text.length, edits)),
    );
  }
  if (!spans.length) throw new CompletionJSONError("syntax");
  return spans[0];
}

function wrapperFor(text: string, span: Span): CompletionParseInfo["wrapper"] {
  const prefix = text.slice(0, span.start);
  const suffix = text.slice(span.end);
  if (!prefix.trim() && !suffix.trim()) return "none";
  // Missing closing backticks are only a wrapper error. The contained JSON must
  // still be complete and unique; no JSON brackets or values are synthesized.
  if (/(?:^|\n)[ \t]*```[ \t]*(?:json)?[ \t\r\n]*$/i.test(prefix))
    return "fenced";
  return "embedded";
}

function unescapedQuotes(text: string): number[] {
  const quotes: number[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\\") i++;
    else if (text[i] === '"') quotes.push(i);
  }
  return quotes;
}

// Recover only a sequence of independently valid JSON string literals joined by
// literal + tokens. This is a tiny data grammar, never JavaScript evaluation.
// Removing each closing-quote/+ /opening-quote boundary preserves all literal
// payloads and their original escape spelling when their decoded strings join.
function literalConcatenation(
  valueLine: string,
  fail: (detail?: string) => never,
): TextEdit[] | undefined {
  const skipSpace = (from: number) => {
    let index = from;
    while (valueLine[index] === " " || valueLine[index] === "\t") index++;
    return index;
  };
  let start = 0;
  let end = quoteEnd(valueLine, start);
  let next = skipSpace(end + 1);
  if (valueLine[next] !== "+") return undefined;
  const edits: TextEdit[] = [];
  const validate = () => {
    try {
      if (typeof JSON.parse(valueLine.slice(start, end + 1)) !== "string")
        fail();
    } catch {
      fail("含有无法安全恢复的字符串拼接格式，未改写原始内容");
    }
  };
  validate();
  while (valueLine[next] === "+") {
    const nextStart = skipSpace(next + 1);
    if (valueLine[nextStart] !== '"') {
      fail("拼接项并非全部为 JSON 字符串字面量，未执行或改写表达式");
    }
    edits.push({ start: end, end: nextStart + 1, replacement: "" });
    start = nextStart;
    end = quoteEnd(valueLine, start);
    validate();
    next = skipSpace(end + 1);
  }
  if (!/^[ \t]*,?[ \t]*$/.test(valueLine.slice(next))) {
    fail("字符串拼接后仍有其他表达式或字段，无法安全自动恢复");
  }
  return edits;
}

function repairQuotedFields(raw: string): RepairPlan {
  const edits: TextEdit[] = [];
  const repairs: CompletionParseInfo["repairs"] = [];
  let offset = 0;
  let lineNumber = 1;
  for (const physicalLine of raw.split("\n")) {
    const line = physicalLine.endsWith("\r")
      ? physicalLine.slice(0, -1)
      : physicalLine;
    const prefix =
      /^[ \t]*"(bio|content|evidence|description)"[ \t]*:[ \t]*/.exec(line);
    if (
      prefix &&
      naturalFields.has(prefix[1]) &&
      line[prefix[0].length] === '"'
    ) {
      const field = prefix[1];
      const valueStart = prefix[0].length;
      const valueLine = line.slice(valueStart);
      const quotes = unescapedQuotes(valueLine);
      let validMemberLine = false;
      try {
        JSON.parse(`{${line.replace(/,[ \t]*$/, "")}}`);
        validMemberLine = true;
      } catch {
        /* a valid inline group must be left alone */
      }
      if (!validMemberLine && quotes.length > 2) {
        const fail = (detail?: string): never => {
          throw new CompletionJSONError(
            "ambiguous",
            { line: lineNumber, column: valueStart + 1, field },
            detail,
          );
        };
        const joins = literalConcatenation(valueLine, fail);
        if (joins) {
          edits.push(
            ...joins.map((edit) => ({
              start: offset + valueStart + edit.start,
              end: offset + valueStart + edit.end,
              replacement: edit.replacement,
            })),
          );
          repairs.push({
            field,
            line: lineNumber,
            count: joins.length,
            kind: "string-concat",
          });
        } else {
          const end = quotes.at(-1)!;
          // Exactly one property on this physical line, with a clear last quote.
          // In particular, do not absorb another member, closing brace or array.
          if (
            !/^[ \t]*,?[ \t]*$/.test(valueLine.slice(end + 1)) ||
            quotes.length % 2
          )
            fail();
          // A valid value needs no repair. This also permits valid, escaped quotes
          // in the same response as a damaged field elsewhere.
          let alreadyValid = false;
          try {
            JSON.parse(valueLine.slice(0, end + 1));
            alreadyValid = true;
          } catch {
            /* inspect only this bounded value */
          }
          if (!alreadyValid) {
            for (let q = 1; q < quotes.length - 1; q++) {
              const after = valueLine.slice(quotes[q] + 1);
              if (/^[ \t]*:/.test(after)) fail();
              const between = valueLine.slice(quotes[q], quotes[q + 1] + 1);
              if (/^"[ \t]*(?:[,+:][ \t]*)?"$/.test(between)) fail();
              if (
                /^[ \t]*(?:\/[/*]|[+*\/%=|&?-]|\.[a-zA-Z_$][\w$]*[ \t]*\()/.test(
                  after,
                )
              )
                fail();
              if (/^"[ \t]*,[ \t]*[\[\]{}]*[ \t]*"$/.test(between)) fail();
              if (/^[ \t]*,[ \t]*[^"\s,:{}\[\]]+[ \t]*:/.test(after)) fail();
              if (
                /^"[ \t]*,?[ \t]*[^"\s,:{}\[\]]+[ \t]*:[ \t]*"$/.test(between)
              )
                fail();
            }
            const internal = quotes.slice(1, -1);
            let proposed = "";
            let previous = 0;
            for (const index of internal) {
              proposed += valueLine.slice(previous, index) + "\\";
              previous = index;
            }
            proposed += valueLine.slice(previous, end + 1);
            // Invalid escapes, literal controls and broken surrogate escape syntax
            // are not quote errors. No attempt is made to rewrite those characters.
            try {
              JSON.parse(proposed);
            } catch {
              fail("含有无法安全修复的字符串格式，未改写原始内容");
            }
            edits.push(
              ...internal.map((index) => ({
                start: offset + valueStart + index,
                end: offset + valueStart + index,
                replacement: "\\",
              })),
            );
            repairs.push({
              field,
              line: lineNumber,
              count: internal.length,
              kind: "quote-escape",
            });
          }
        }
      }
    }
    offset += physicalLine.length + 1;
    lineNumber++;
  }
  let text = "";
  let previous = 0;
  for (const edit of edits) {
    text += raw.slice(previous, edit.start) + edit.replacement;
    previous = edit.end;
  }
  text += raw.slice(previous);
  return { text, edits, repairs };
}

export function parseCompletionJSON(raw: string): {
  value: unknown;
  json: string;
  info: CompletionParseInfo;
} {
  const trimmed = raw.trim();
  const start = raw.indexOf(trimmed);
  let pureFailure: CompletionJSONError;
  try {
    const value = strictParse(trimmed, start, raw);
    return { value, json: trimmed, info: { wrapper: "none", repairs: [] } };
  } catch (error) {
    if (!(error instanceof CompletionJSONError)) throw error;
    if (error.kind === "ambiguous") throw error;
    pureFailure = error;
  }
  let extractionFailure: CompletionJSONError;
  try {
    const span = extractOne(raw, raw);
    const json = raw.slice(span.start, span.end);
    const value = strictParse(json, span.start, raw);
    return {
      value,
      json,
      info: { wrapper: wrapperFor(raw, span), repairs: [] },
    };
  } catch (error) {
    if (!(error instanceof CompletionJSONError)) throw error;
    extractionFailure = error;
  }
  const plan = repairQuotedFields(raw);
  if (!plan.edits.length) {
    // For a complete single root, JSON.parse usually has the most precise syntax
    // position. Extraction supplies truncation/multiple-root errors otherwise.
    if (extractionFailure.kind !== "syntax") throw extractionFailure;
    throw pureFailure.line && /^[\[{]/.test(trimmed)
      ? pureFailure
      : extractionFailure;
  }
  const span = extractOne(plan.text, raw, plan.edits);
  const json = plan.text.slice(span.start, span.end);
  const value = strictParse(json, span.start, raw, plan.edits);
  const originalStart = originalOffset(span.start, plan.edits);
  const originalEnd = originalOffset(span.end, plan.edits);
  // A repair proposal in surrounding explanation is never silently applied or
  // reported as a change to the result; it makes extraction unsafe instead.
  if (
    plan.edits.some(
      (edit) => edit.start < originalStart || edit.end >= originalEnd,
    )
  ) {
    throw new CompletionJSONError("ambiguous");
  }
  return {
    value,
    json,
    info: { wrapper: wrapperFor(plan.text, span), repairs: plan.repairs },
  };
}
