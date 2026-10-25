import { afterEach, expect, it, vi } from "vitest";
import { requestImage } from "../src/image-provider";
import { imageProfileSchema } from "../src/image-types";
import {
  imageDiagnosticText,
  type ImageDiagnostic,
} from "../src/image-diagnostics";
import { readImageResponse } from "../src/image-protocol";

const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lS8AAAAASUVORK5CYII=";
const bytes = Uint8Array.from(atob(PNG), (x) => x.charCodeAt(0));
const profile = imageProfileSchema.parse({
  id: "fixture",
  name: "fixture",
  url: "https://image.fixture.test/v1/chat/completions",
  model: "fixture",
  protocol: "chat",
  stream: false,
  timeout: 10,
});
const url =
  "https://cdn.fixture.test/image.png?signature=private-fixture-signature";
const response = () =>
  Response.json({ choices: [{ message: { content: `![image](${url})` } }] });
const never = <T>() => new Promise<T>(() => {});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("identifies a non-stream request with no response and never resubmits", async () => {
  vi.useFakeTimers();
  const fetcher = vi.fn(() => never<Response>());
  let diagnostic: ImageDiagnostic | undefined;
  const result = requestImage(
    profile,
    "fixture-secret",
    "private-story",
    [],
    new AbortController().signal,
    fetcher,
    undefined,
    (d) => {
      diagnostic = d;
    },
  );
  const rejected = expect(result).rejects.toThrow("等待接口响应超时");
  await vi.advanceTimersByTimeAsync(10000);
  await rejected;
  expect(diagnostic).toMatchObject({
    stage: "requesting",
    outcome: "timeout",
    responseBytes: 0,
  });
  expect(diagnostic?.httpStatus).toBeUndefined();
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it("distinguishes a stalled non-stream JSON body from waiting for response headers", async () => {
  vi.useFakeTimers();
  const cancel = vi.fn();
  const prefix = new TextEncoder().encode('{"choices":[');
  const fetcher = vi.fn(
    async () =>
      new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(prefix);
          },
          cancel,
        }),
        { headers: { "Content-Type": "application/json" } },
      ),
  );
  let diagnostic: ImageDiagnostic | undefined;
  const result = requestImage(
    profile,
    "fixture-secret",
    "private-story",
    [],
    new AbortController().signal,
    fetcher,
    undefined,
    (d) => {
      diagnostic = d;
    },
  );
  const rejected = expect(result).rejects.toThrow(
    `接收生图结果超时（已接收 ${prefix.length} 字节）`,
  );
  await vi.advanceTimersByTimeAsync(10000);
  await rejected;
  expect(diagnostic).toMatchObject({
    stage: "receiving",
    outcome: "timeout",
    httpStatus: 200,
    responseType: "json",
    responseBytes: prefix.length,
  });
  expect(cancel).toHaveBeenCalledOnce();
  expect(fetcher).toHaveBeenCalledOnce();
});

it("gives image download its full budget after a slow non-stream generation", async () => {
  vi.useFakeTimers();
  const later = (r: Response) =>
    new Promise<Response>((resolve) => setTimeout(() => resolve(r), 9000));
  const fetcher = vi
    .fn<typeof fetch>()
    .mockImplementationOnce(() => later(response()))
    .mockImplementationOnce(() => later(new Response(bytes)));
  const ready = vi.fn(async () => {});
  let diagnostic: ImageDiagnostic | undefined;
  const result = requestImage(
    profile,
    "fixture-secret",
    "private-story",
    [],
    new AbortController().signal,
    fetcher,
    ready,
    (d) => {
      diagnostic = d;
    },
  );
  await vi.advanceTimersByTimeAsync(18000);
  expect((await result).data).toBe(`data:image/png;base64,${PNG}`);
  expect(ready).toHaveBeenCalledExactlyOnceWith(url);
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(fetcher.mock.calls[1][1]).not.toHaveProperty("headers");
  expect(diagnostic).toMatchObject({
    outcome: "success",
    responseMs: 9000,
    httpStatus: 200,
    downloadStatus: 200,
    downloadBytes: bytes.length,
    resultKind: "url",
  });
  const text = imageDiagnosticText(diagnostic!);
  for (const secret of [
    url,
    "private-fixture-signature",
    "fixture-secret",
    "private-story",
  ])
    expect(text).not.toContain(secret);
});

it("keeps a received URL when download stalls and reports the download stage", async () => {
  vi.useFakeTimers();
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(response())
    .mockImplementationOnce(() => never<Response>());
  const ready = vi.fn(async () => {});
  let diagnostic: ImageDiagnostic | undefined;
  const result = requestImage(
    profile,
    "fixture-secret",
    "test",
    [],
    new AbortController().signal,
    fetcher,
    ready,
    (d) => {
      diagnostic = d;
    },
  );
  const rejected = expect(result).rejects.toThrow("下载图片超时");
  await vi.advanceTimersByTimeAsync(10000);
  await rejected;
  expect(ready).toHaveBeenCalledExactlyOnceWith(url);
  expect(diagnostic).toMatchObject({
    stage: "downloading",
    outcome: "timeout",
    resultKind: "url",
  });
  expect(
    fetcher.mock.calls.filter((c) => c[1]?.method === "POST"),
  ).toHaveLength(1);
});

it("bounds image decoding independently and identifies processing failures", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("createImageBitmap", () => never<ImageBitmap>());
  vi.stubGlobal("document", {});
  const fetcher = vi.fn(
    async () =>
      new Response(bytes, { headers: { "content-type": "image/png" } }),
  );
  let diagnostic: ImageDiagnostic | undefined;
  const result = requestImage(
    profile,
    "fixture-secret",
    "test",
    [],
    new AbortController().signal,
    fetcher,
    undefined,
    (d) => {
      diagnostic = d;
    },
  );
  const rejected = expect(result).rejects.toThrow("处理图片超时");
  await vi.advanceTimersByTimeAsync(30000);
  await rejected;
  expect(diagnostic).toMatchObject({
    stage: "processing",
    resultKind: "binary",
    outcome: "timeout",
  });
  expect(fetcher).toHaveBeenCalledOnce();
});

it.each(["done", "response.completed", "image_generation.completed"])(
  "finishes SSE at %s even when the gateway never closes or acknowledges cancellation",
  async (terminal) => {
    const cancel = vi.fn(() => never<void>());
    const payload =
      terminal === "done"
        ? `data: ${JSON.stringify({ choices: [{ delta: { images: [{ image_url: { url: `data:image/png;base64,${PNG}` } }] } }] })}\r\n\r\ndata: [DONE]\r\n\r\n`
        : `data: ${JSON.stringify(terminal === "response.completed" ? { type: terminal, response: { output: [{ type: "image_generation_call", result: PNG }] } } : { type: terminal, b64_json: PNG })}\n\n`;
    const encoded = new TextEncoder().encode(payload);
    const result = await readImageResponse(
      new Response(
        new ReadableStream({
          start(c) {
            for (let i = 0; i < encoded.length; i += 7)
              c.enqueue(encoded.slice(i, i + 7));
          },
          cancel,
        }),
        { headers: { "content-type": "text/event-stream" } },
      ),
    );
    expect(result.image).toContain(PNG);
    expect(cancel).toHaveBeenCalledOnce();
  },
);

it("stopping a fetch that ignores AbortSignal still settles without retrying", async () => {
  const control = new AbortController();
  const fetcher = vi.fn(() => never<Response>());
  let diagnostic: ImageDiagnostic | undefined;
  const result = requestImage(
    profile,
    "fixture-secret",
    "test",
    [],
    control.signal,
    fetcher,
    undefined,
    (d) => {
      diagnostic = d;
    },
  );
  const rejected = expect(result).rejects.toThrow("已停止");
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
  control.abort();
  await rejected;
  expect(diagnostic?.outcome).toBe("stopped");
  expect(fetcher).toHaveBeenCalledTimes(1);
});
