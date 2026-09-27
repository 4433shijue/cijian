import { describe, expect, it } from "vitest";
import { CompletionJSONError, parseCompletionJSON } from "../src/role-json";

const withContent = (content: string) => `{\n  "content": "${content}"\n}`;
const getError = (raw: string): CompletionJSONError => {
  try {
    parseCompletionJSON(raw);
  } catch (error) {
    expect(error).toBeInstanceOf(CompletionJSONError);
    return error as CompletionJSONError;
  }
  throw new Error("Expected invalid JSON to be rejected");
};

describe("completion JSON extraction", () => {
  it("preserves strict JSON and never changes valid quotes or escapes", () => {
    const expected = { bio: 'A "B" C', nested: [{ description: "\\路径 😀" }] };
    const json = JSON.stringify(expected, null, 2);
    expect(parseCompletionJSON(`\n${json}\n`)).toEqual({
      value: expected,
      json,
      info: { wrapper: "none", repairs: [] },
    });
  });

  it.each([
    ['```json\n{"bio":"A"}\n```', "fenced"],
    ['说明文字。\n```JSON\n{"bio":"A"}\n```\n结束。', "fenced"],
    ['```json\n{"bio":"A"}', "fenced"],
    ['```json {"bio":"A"} ```', "fenced"],
    ['说明文字。\n{"bio":"A"}\n结束。', "embedded"],
  ])("accepts a unique complete object with wrapper %s", (raw, wrapper) => {
    expect(parseCompletionJSON(raw)).toEqual({
      value: { bio: "A" },
      json: '{"bio":"A"}',
      info: { wrapper, repairs: [] },
    });
  });

  it("extracts arrays while ignoring quoted braces and escaped quotes", () => {
    const value = [{ content: '{ "nested" [ text ] }', second: '\\"' }];
    const parsed = parseCompletionJSON(`开始\n${JSON.stringify(value)}\n结束`);
    expect(parsed.value).toEqual(value);
    expect(parsed.info.repairs).toEqual([]);
  });

  it.each([
    '{"bio":"A"}\n{"bio":"B"}',
    '{broken}\n{"bio":"B"}',
    '{"bio":"B"}\n{broken}',
    '```json\n{"bio":"A"}\n```\n```json\n{"bio":"B"}\n```',
    '{"bio":"A"}\n{"bio":',
  ])(
    "never chooses one candidate over another complete or damaged container",
    (raw) => {
      expect(getError(raw).kind).toBe("ambiguous");
    },
  );

  it.each([
    '{"bio":"A"',
    '```json\n{"bio":"A"',
    '{\n "content": "unfinished\n}',
    '{"content":"unfinished',
  ])("never manufactures missing JSON ends", (raw) => {
    expect(getError(raw).kind).toBe("truncated");
  });

  it("leaves schema decisions to the caller for otherwise valid JSON", () => {
    expect(parseCompletionJSON("null").value).toBeNull();
    expect(parseCompletionJSON('"plain string"').value).toBe("plain string");
  });
});

describe("bounded internal quote recovery", () => {
  it("repairs eleven natural-text fields containing 46 quotes without changing their decoded text", () => {
    const expected = {
      candidateId: "fixture-01",
      name: "测试角色",
      bio: 'A "one" B "two" C "three" D',
      sections: Array.from({ length: 10 }, (_, index) => ({
        title: `维度${index + 1}`,
        content: `A${index} "first" B "second" C`,
        basis: "unknown",
        evidence: "",
      })),
    };
    const correct = JSON.stringify(expected, null, 2);
    const raw = `\`\`\`json\n${correct.replace(/\\"/g, '"')}\n\`\`\``;
    const parsed = parseCompletionJSON(raw);
    expect(parsed.value).toEqual(expected);
    expect(parsed.json).toBe(correct);
    expect(parsed.info.wrapper).toBe("fenced");
    expect(parsed.info.repairs).toHaveLength(11);
    expect(
      parsed.info.repairs.reduce((sum, repair) => sum + repair.count, 0),
    ).toBe(46);
    expect(parsed.info.repairs[0]).toEqual({
      field: "bio",
      line: 5,
      count: 6,
      kind: "quote-escape",
    });
  });

  it.each(["bio", "content", "evidence", "description"])(
    "only inserts escapes into the bounded %s value",
    (field) => {
      const raw = `{\n  "${field}": "A "B" C"\n}`;
      const parsed = parseCompletionJSON(raw);
      expect(parsed.value).toEqual({ [field]: 'A "B" C' });
      expect(parsed.json.replace(/\\"/g, '"')).toBe(raw);
      expect(parsed.info.repairs).toEqual([
        { field, line: 2, count: 2, kind: "quote-escape" },
      ]);
    },
  );

  it("retains already escaped quotes and backslashes alongside recovered quotes", () => {
    const raw = withContent(String.raw`A \"kept\" and "fixed" then C:\\tmp`);
    const parsed = parseCompletionJSON(raw);
    expect(parsed.value).toEqual({
      content: 'A "kept" and "fixed" then C:\\tmp',
    });
    expect(parsed.info.repairs).toEqual([
      { field: "content", line: 2, count: 2, kind: "quote-escape" },
    ]);
  });

  it("uses even and odd backslash counts to locate internal quotes", () => {
    const expected = { content: 'A "C:\\tmp\\" B' };
    const correct = JSON.stringify(expected, null, 2);
    const raw = correct.replace(/\\"/g, '"');
    const parsed = parseCompletionJSON(raw);
    expect(parsed.json).toBe(correct);
    expect(parsed.value).toEqual(expected);
  });

  it("retains Unicode, CRLF, valid surrogate escapes and literal non-ASCII quotation marks", () => {
    const raw = `{\r\n  "content": "甲 “乙” 😀 "丙" \\uD83D\\uDE00 \\uD800"\r\n}`;
    const parsed = parseCompletionJSON(raw);
    expect(parsed.value).toEqual({ content: '甲 “乙” 😀 "丙" 😀 \ud800' });
    expect(parsed.json).toContain("\r\n");
    expect(parsed.json).toContain("\\uD800");
  });

  it("keeps braces inside recovered quoted phrases out of structural extraction", () => {
    const raw = withContent('A "看 {x}" B "[y]" C');
    expect(
      parseCompletionJSON(`说明\n\`\`\`json\n${raw}\n\`\`\`\n结束`).value,
    ).toEqual({ content: 'A "看 {x}" B "[y]" C' });
    expect(parseCompletionJSON(withContent('A "}" B')).value).toEqual({
      content: 'A "}" B',
    });
  });

  it("does not rewrite an already valid inline field when another field needs repair", () => {
    const raw = '{\n  "content": "A", "name": "B",\n  "bio": "C "D" E"\n}';
    expect(parseCompletionJSON(raw).value).toEqual({
      content: "A",
      name: "B",
      bio: 'C "D" E',
    });
  });

  it.each([
    withContent('A "B C'),
    '{"content":"A "B" C"}',
    '{\n  "name": "A "B" C"\n}',
    '{\n  "content": "A "B" C\n}',
    '{\n  "content": "A "B" C"\n',
    withContent(String.raw`A "B" \q`),
    withContent(String.raw`A "B" \u12XY`),
    withContent('A "B"\tC'),
  ])("rejects syntax outside the single-line quote boundary", (raw) => {
    expect(getError(raw)).toBeInstanceOf(CompletionJSONError);
  });

  it.each([
    '"content": "A" "name": "B"',
    '"content": "A", "B"',
    '"content": "A" "B"',
    '"content": "A", name:"B"',
    '"content": "A", ["B"]',
    '"content": "A", {"name":"B"}',
    '"content": "A "key": "value" Z"',
  ])(
    "refuses to swallow structural fragments as string contents: %s",
    (line) => {
      const raw = `{\n  ${line},\n  "bio": "C "D" E"\n}`;
      expect(getError(raw).kind).toBe("ambiguous");
    },
  );

  it("rejects a missing separator after repairing a string", () => {
    const raw = '{\n  "content": "A "B" C"\n  "bio": "D"\n}';
    expect(getError(raw).kind).toBe("syntax");
  });

  it("does not hide duplicate keys after repair, even when key escapes differ", () => {
    const raw = '{\n  "content": "A "B" C",\n  "\\u0063ontent": "D"\n}';
    const error = getError(raw);
    expect(error.kind).toBe("ambiguous");
    expect(error.field).toBe("content");
    expect(error.line).toBe(3);
  });

  it("rejects duplicate keys in valid JSON while allowing equal keys in separate sections", () => {
    expect(getError('{"bio":"A","bio":"B"}').kind).toBe("ambiguous");
    expect(
      parseCompletionJSON('[{"content":"A"},{"content":"B"}]').value,
    ).toEqual([{ content: "A" }, { content: "B" }]);
  });

  it("does not prefer a repaired result over a second malformed candidate", () => {
    expect(getError(`${withContent('A "B" C')}\n{broken}`).kind).toBe(
      "ambiguous",
    );
  });

  it("reports source positions without echoing model text into errors", () => {
    const error = getError(
      '{\n  "content": "PRIVATE_A "PRIVATE_B" PRIVATE_C"\n  "bio": "D"\n}',
    );
    expect(error.line).toBe(3);
    expect(error.column).toBe(3);
    expect(error.message).not.toMatch(/PRIVATE_/);
    expect(error.message).toContain("第 3 行");
  });
});

describe("literal-only string concatenation recovery", () => {
  it.each(["bio", "content", "evidence", "description"])(
    "joins independently valid literals in %s",
    (field) => {
      const raw = `{\n  "${field}": "原句甲。" + "[注]"\n}`;
      const parsed = parseCompletionJSON(raw);
      expect(parsed.value).toEqual({ [field]: "原句甲。[注]" });
      expect(parsed.info.repairs).toEqual([
        { field, line: 2, count: 1, kind: "string-concat" },
      ]);
      expect(parsed.json).toBe(`{\n  "${field}": "原句甲。[注]"\n}`);
    },
  );

  it("joins longer chains and preserves escaped quotes, whitespace, backslashes and Unicode", () => {
    const raw = `{\r\n  "evidence": ${String.raw`" A\n" + "\"B\" \\ " + "\uD83D\uDE00" + ""`}\r\n}`;
    const parsed = parseCompletionJSON(raw);
    expect(parsed.value).toEqual({ evidence: ' A\n"B" \\ 😀' });
    expect(parsed.json).toContain("\r\n");
    expect(parsed.json).toContain("\\uD83D\\uDE00");
    expect(parsed.info.repairs).toEqual([
      { field: "evidence", line: 2, count: 3, kind: "string-concat" },
    ]);
  });

  it("recovers mixed quote and concatenation failures with distinct counts", () => {
    const quotePairs = [4, 4, 3, 3, 3];
    const sections = Array.from({ length: 6 }, (_, index) => {
      const content =
        index < quotePairs.length
          ? "A " +
            Array.from(
              { length: quotePairs[index] },
              (_, quote) => `"item${quote}" tail`,
            ).join(" / ")
          : "plain";
      return { content, evidence: `E${index} note` };
    });
    const expected = { sections };
    let raw = JSON.stringify(expected, null, 2).replace(/\\"/g, '"');
    raw = raw.replace(
      /"evidence": "E(\d) note"/g,
      '"evidence": "E$1" + " note"',
    );
    const parsed = parseCompletionJSON(`\`\`\`json\n${raw}\n\`\`\``);
    expect(parsed.value).toEqual(expected);
    expect(parsed.info.repairs).toHaveLength(11);
    expect(
      parsed.info.repairs
        .filter((repair) => repair.kind === "quote-escape")
        .reduce((count, repair) => count + repair.count, 0),
    ).toBe(34);
    expect(
      parsed.info.repairs
        .filter((repair) => repair.kind === "string-concat")
        .reduce((count, repair) => count + repair.count, 0),
    ).toBe(6);
  });

  it("leaves literal plus signs and valid expression-looking strings unchanged", () => {
    const expected = { content: 'A + B; "C" + "D"; helper("E")' };
    const json = JSON.stringify(expected, null, 2);
    expect(parseCompletionJSON(json)).toEqual({
      value: expected,
      json,
      info: { wrapper: "none", repairs: [] },
    });
  });

  it.each([
    '"A" + name + "B"',
    '"A" + helper("B")',
    '"A" + globalThis["payload"]',
    '"A" + 1 + "B"',
    '"A" + true + "B"',
    '"A" + null + "B"',
    '"A" ++ "B"',
    '"A" + ("B")',
    '"A" /* gap */ + "B"',
    '"A".concat("B")',
    '"A" + "B".toString()',
    '"A" + "B" || "C"',
    '"A" + "B", "bio": "C"',
    String.raw`"A" + "B\q"`,
    String.raw`"A\q" + "B"`,
    '"A" + "B',
    '"A" + "B" +',
  ])("does not evaluate, coerce or absorb expressions: %s", (expression) => {
    expect(getError(`{\n  "evidence": ${expression}\n}`)).toBeInstanceOf(
      CompletionJSONError,
    );
  });

  it("retains the whitelist and physical-line member boundary", () => {
    expect(getError('{\n  "name": "A" + "B"\n}')).toBeInstanceOf(
      CompletionJSONError,
    );
    expect(getError('{"evidence":"A" + "B"}')).toBeInstanceOf(
      CompletionJSONError,
    );
    expect(getError('{\n  "evidence": "A" +\n  "B"\n}')).toBeInstanceOf(
      CompletionJSONError,
    );
  });

  it("keeps original positions after deletion and insertion edits", () => {
    const raw =
      '```json\n{\n  "evidence": "A" + "B" + "C",\n  "content": "D "E" F"\n  "bio": "G"\n}\n```';
    const error = getError(raw);
    expect(error.line).toBe(5);
    expect(error.column).toBe(3);
  });

  it("still rejects duplicate keys and multiple roots after joining literals", () => {
    const duplicate = '{\n  "evidence": "A" + "B",\n  "evidence": "C"\n}';
    const duplicateError = getError(duplicate);
    expect(duplicateError.kind).toBe("ambiguous");
    expect(duplicateError.line).toBe(3);
    expect(duplicateError.column).toBe(3);
    expect(getError('{\n  "evidence": "A" + "B"\n}\n{broken}').kind).toBe(
      "ambiguous",
    );
  });
});
