import { afterEach, expect, it, vi } from "vitest";
import { readImageResponse } from "../src/image-protocol";
import { requestImage } from "../src/image-provider";
import { imageProfileSchema } from "../src/image-types";
import {
  imageDiagnosticText,
  type ImageDiagnostic,
} from "../src/image-diagnostics";

const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lS8AAAAASUVORK5CYII=";
const image = `data:image/png;base64,${PNG}`;
const url = "https://cdn.fixture.test/result.png?signature=private-fixture";
const profile = imageProfileSchema.parse({
  id: "fixture",
  name: "fixture",
  protocol: "images",
  url: "https://image.fixture.test/v1",
  model: "fixture",
  timeout: 10,
});
afterEach(() => vi.useRealTimers());

function openJson(text: string, chunkSize = 16384) {
  const bytes = new TextEncoder().encode(text);
  const cancel = vi.fn(() => new Promise<void>(() => {}));
  const response = new Response(
    new ReadableStream({
      start(c) {
        for (let offset = 0; offset < bytes.length; offset += chunkSize)
          c.enqueue(bytes.slice(offset, offset + chunkSize));
      },
      cancel,
    }),
    { headers: { "Content-Type": "application/json" } },
  );
  return { response, cancel, size: bytes.length };
}

it.each([
  [{ data: [{ b64_json: PNG }] }, "", PNG],
  [{ choices: [{ message: { content: `![image](${url})` } }] }, "", url],
  [
    { candidates: [{ content: { parts: [{ inlineData: { data: PNG } }] } }] },
    "",
    PNG,
  ],
  [{ files: [{ asset: image }] }, "files[0].asset", image],
  [[{ data: [{ b64_json: PNG }] }], "", PNG],
] as const)(
  "reads a complete JSON result without waiting for HTTP EOF %#",
  async (data, path, expected) => {
    const stream = openJson(JSON.stringify(data));
    const state = vi.fn();
    const result = await readImageResponse(stream.response, path, {
      signal: AbortSignal.timeout(2000),
      onJsonState: state,
    });
    expect(result.image).toBe(expected);
    expect(state.mock.calls.map(([value]) => value)).toEqual([
      "incomplete",
      "complete",
    ]);
    expect(stream.cancel).toHaveBeenCalledOnce();
  },
);

it("handles split Unicode, escaped quotes, braces inside strings, and array nesting", async () => {
  const data = {
    note: '窗边 \\ \" } ] { [ \\尾',
    usage: { items: [1, { text: "}" }] },
    data: [{ b64_json: PNG }],
  };
  const stream = openJson(JSON.stringify(data) + " \r\n", 1);
  const result = await readImageResponse(stream.response, "", {
    signal: AbortSignal.timeout(2000),
  });
  expect(result.data).toEqual(data);
  expect(result.image).toBe(PNG);
});

it("accepts a large complete JSON body and finishes the image using a single generation", async () => {
  const stream = openJson(
    JSON.stringify({ note: "x".repeat(1_500_000), data: [{ b64_json: PNG }] }),
  );
  const fetcher = vi.fn(async () => stream.response);
  let diagnostic: ImageDiagnostic | undefined;
  const result = await requestImage(
    profile,
    "fixture-secret",
    "private-prompt",
    [],
    new AbortController().signal,
    fetcher,
    undefined,
    (d) => {
      diagnostic = d;
    },
  );
  expect(result.data).toBe(image);
  expect(fetcher).toHaveBeenCalledOnce();
  expect(diagnostic).toMatchObject({
    outcome: "success",
    jsonState: "complete",
    responseBytes: stream.size,
    resultKind: "base64",
  });
  expect(imageDiagnosticText(diagnostic!)).toContain("已收完整并通过格式校验");
  expect(stream.cancel).toHaveBeenCalledOnce();
});

it("retains a URL from complete JSON while its HTTP body stays open and download fails", async () => {
  const stream = openJson(JSON.stringify({ data: [{ url }] }));
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(stream.response)
    .mockResolvedValueOnce(new Response("unavailable", { status: 503 }));
  const ready = vi.fn(async () => {});
  await expect(
    requestImage(
      profile,
      "fixture-secret",
      "test",
      [],
      new AbortController().signal,
      fetcher,
      ready,
    ),
  ).rejects.toThrow("图片已生成，但下载失败");
  expect(ready).toHaveBeenCalledExactlyOnceWith(url);
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(
    fetcher.mock.calls.filter((c) => c[1]?.method === "POST"),
  ).toHaveLength(1);
});

it("returns complete async task metadata before EOF so polling can start", async () => {
  const stream = openJson(
    JSON.stringify({ id: "fixture-task", status: "pending" }),
  );
  const result = await readImageResponse(stream.response, "", {
    signal: AbortSignal.timeout(2000),
  });
  expect(result).toEqual({
    data: { id: "fixture-task", status: "pending" },
    image: undefined,
  });
});

it.each(["eof", "disconnect", "timeout"] as const)(
  "does not salvage a finished image field from an unfinished JSON document on %s",
  async (ending) => {
    const text = `{"data":[{"b64_json":"${PNG}"}],"usage":`;
    const encoded = new TextEncoder().encode(text);
    let pulls = 0;
    const response = new Response(
      new ReadableStream({
        pull(c) {
          if (pulls++ === 0) c.enqueue(encoded);
          else if (ending === "eof") c.close();
          else if (ending === "disconnect")
            c.error(new TypeError("fixture network loss"));
        },
      }),
      { headers: { "Content-Type": "application/json" } },
    );
    if (ending === "timeout") vi.useFakeTimers();
    const fetcher = vi.fn(async () => response);
    let diagnostic: ImageDiagnostic | undefined;
    const result = requestImage(
      profile,
      "fixture-secret",
      "private-prompt",
      [],
      new AbortController().signal,
      fetcher,
      undefined,
      (d) => {
        diagnostic = d;
      },
    );
    const rejected = expect(result).rejects.toThrow(
      ending === "eof"
        ? "JSON 收完整前结束"
        : ending === "disconnect"
          ? "生图响应传输中断"
          : "JSON 尚未收完整",
    );
    if (ending === "timeout") await vi.advanceTimersByTimeAsync(10000);
    await rejected;
    expect(fetcher).toHaveBeenCalledOnce();
    expect(diagnostic).toMatchObject({
      stage: "receiving",
      outcome: ending === "timeout" ? "timeout" : "failed",
      jsonState: "incomplete",
      responseBytes: encoded.length,
    });
    const description = imageDiagnosticText(diagnostic!);
    expect(description).toContain("JSON 完整性：尚未收完整");
    if (ending === "timeout")
      expect(description).toContain("距最后收到数据：10.0 秒");
    for (const secret of [PNG, "fixture-secret", "private-prompt"])
      expect(description).not.toContain(secret);
  },
);

it.each([
  `{"data":[{"b64_json":"${PNG}"}],"bad":}`,
  `{"data":[{"b64_json":"${PNG}"}]}{"error":"private-fixture"}`,
  `{"data":[{"b64_json":"${PNG}"}]]}`,
])(
  "rejects malformed/trailing JSON without revealing its contents %#",
  async (text) => {
    const stream = openJson(text);
    const state = vi.fn();
    const result = readImageResponse(stream.response, "", {
      signal: AbortSignal.timeout(2000),
      onJsonState: state,
    });
    await expect(result).rejects.toThrow("JSON");
    await expect(result).rejects.not.toThrow(PNG);
    expect(state).toHaveBeenLastCalledWith("invalid");
  },
);

it("checks an error field after the image before accepting the complete JSON", async () => {
  const stream = openJson(
    JSON.stringify({
      data: [{ b64_json: PNG }],
      error: { message: "private-fixture" },
    }),
  );
  await expect(
    readImageResponse(stream.response, "", {
      signal: AbortSignal.timeout(2000),
    }),
  ).rejects.toThrow("服务报告生成失败");
});
