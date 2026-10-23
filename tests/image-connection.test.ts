import { afterEach, expect, it, vi } from "vitest";
import {
  imageConnectionSchema,
  imageProfileSchema,
  NO_SELFIE,
  type ImageProfile,
} from "../src/image-types";
import {
  fetchImageModels,
  imageModelsEndpoint,
  resolveImageEndpoint,
} from "../src/image-connection";
import {
  buildImageRequest,
  extractImageResult,
  readImageResponse,
  validateImageConnection,
} from "../src/image-protocol";
import { requestImage } from "../src/image-provider";

const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lS8AAAAASUVORK5CYII=";
const dataUrl = "data:image/png;base64," + PNG;
const profile = (patch: Partial<ImageProfile> = {}) =>
  imageProfileSchema.parse({
    id: "fixture",
    name: "fixture",
    url: "https://images.fixture.test/v1",
    model: "image-fixture",
    protocol: "auto",
    size: "",
    ...patch,
  });
const response = (data: unknown) =>
  new Response(JSON.stringify(data), {
    headers: { "content-type": "application/json" },
  });
const run = (
  p: ImageProfile,
  fetcher: typeof fetch,
  refs: string[] = [],
  signal = new AbortController().signal,
) => requestImage(p, "fixture-secret", "窗边的花瓶", refs, signal, fetcher);
afterEach(() => vi.useRealTimers());

it.each([
  [
    "https://images.fixture.test",
    "auto",
    "https://images.fixture.test/v1/images/generations",
  ],
  [
    "https://images.fixture.test/proxy/v1",
    "chat",
    "https://images.fixture.test/proxy/v1/chat/completions",
  ],
  [
    "https://images.fixture.test/v1/chat/completions",
    "auto",
    "https://images.fixture.test/v1/chat/completions",
  ],
  [
    "https://images.fixture.test/v1/images/edits",
    "auto",
    "https://images.fixture.test/v1/images/edits",
  ],
  [
    "https://images.fixture.test/custom/render?format=png",
    "images",
    "https://images.fixture.test/custom/render?format=png",
  ],
  [
    "https://images.fixture.test/v1/responses",
    "auto",
    "https://images.fixture.test/v1/responses",
  ],
  [
    "https://openrouter.ai",
    "openrouter",
    "https://openrouter.ai/api/v1/images",
  ],
] as const)(
  "resolves %s using %s without rewriting full routes",
  (url, protocol, expected) => {
    expect(resolveImageEndpoint(profile({ url, protocol }))).toBe(expected);
  },
);
it("detects route conflicts and preserves explicit arbitrary paths", () => {
  expect(() =>
    resolveImageEndpoint(
      profile({
        url: "https://images.fixture.test/v1/chat/completions",
        protocol: "images",
      }),
    ),
  ).toThrow("不一致");
  expect(
    resolveImageEndpoint(
      profile({
        url: "https://images.fixture.test/proxy",
        endpointMode: "base",
        protocol: "responses",
      }),
    ),
  ).toBe("https://images.fixture.test/proxy/responses");
  expect(resolveImageEndpoint(profile({ endpointMode: "full" }))).toBe(
    "https://images.fixture.test/v1",
  );
  expect(() =>
    resolveImageEndpoint(
      profile({ url: "https://images.fixture.test/v1?key=secret" }),
    ),
  ).toThrow("查询参数");
});
it("keeps old saved connection routing on Images while new connections use auto", () => {
  const old = imageProfileSchema.parse({
    id: "old",
    name: "old",
    url: "https://images.fixture.test/proxy/v1/chat/completions",
    model: "old",
  });
  expect(old.protocol).toBe("images");
  expect(resolveImageEndpoint(old)).toBe(
    "https://images.fixture.test/proxy/v1/images/generations",
  );
  expect(resolveImageEndpoint(old, true)).toBe(
    "https://images.fixture.test/proxy/v1/images/edits",
  );
});
it("lists models without generating; keeps unknown capabilities and malformed IDs out", async () => {
  const transport = vi.fn(async () =>
    response({
      data: [
        "unusual-alias",
        { id: 3 },
        {
          id: "visual",
          architecture: {
            input_modalities: ["image"],
            output_modalities: ["text", "image"],
          },
        },
        { id: "text", output_modalities: ["text"] },
        {
          id: "visual",
          architecture: {
            input_modalities: ["image"],
            output_modalities: ["image"],
          },
        },
      ],
    }),
  );
  const models = await fetchImageModels(
    profile({ url: "https://images.fixture.test/proxy/v1/chat/completions" }),
    "fixture-secret",
    new AbortController().signal,
    transport,
  );
  expect(models).toHaveLength(3);
  expect(
    models.find((m) => m.id === "unusual-alias")?.outputImage,
  ).toBeUndefined();
  expect(models.find((m) => m.id === "visual")).toMatchObject({
    outputImage: true,
    inputImage: true,
  });
  expect(models.find((m) => m.id === "text")?.outputImage).toBe(false);
  expect(transport).toHaveBeenCalledExactlyOnceWith(
    "https://images.fixture.test/proxy/v1/models",
    expect.objectContaining({
      headers: { Authorization: "Bearer fixture-secret" },
      credentials: "omit",
      redirect: "error",
    }),
  );
  expect(transport.mock.calls[0][1]).not.toHaveProperty("body");
});
it("reads Gemini model pagination with header authentication", async () => {
  const transport = vi
    .fn()
    .mockResolvedValueOnce(
      response({
        models: [{ name: "models/first", displayName: "First" }],
        nextPageToken: "next&token",
      }),
    )
    .mockResolvedValueOnce(response({ models: [{ name: "models/second" }] }));
  const result = await fetchImageModels(
    profile({
      url: "https://generativelanguage.googleapis.com",
      protocol: "gemini",
    }),
    "fixture-secret",
    new AbortController().signal,
    transport,
  );
  expect(result.map((m) => m.id)).toEqual(["first", "second"]);
  expect(transport.mock.calls[0][0]).toBe(
    "https://generativelanguage.googleapis.com/v1beta/models",
  );
  expect(transport.mock.calls[1][0]).toContain("pageToken=next%26token");
  expect(transport.mock.calls[0][1].headers).toEqual({
    "x-goog-api-key": "fixture-secret",
  });
});
it("requires explicit same-origin discovery for unknown routes, and does not retry failures", async () => {
  const p = profile({
    url: "https://images.fixture.test/render",
    protocol: "custom",
  });
  expect(() => imageModelsEndpoint(p)).toThrow("无法推断");
  expect(imageModelsEndpoint({ ...p, modelsUrl: "/catalog" })).toBe(
    "https://images.fixture.test/catalog",
  );
  const fetcher = vi.fn(
    async () => new Response("secret echo", { status: 401 }),
  );
  await expect(
    fetchImageModels(
      { ...p, modelsUrl: "/catalog" },
      "fixture-secret",
      new AbortController().signal,
      fetcher,
    ),
  ).rejects.toThrow("401");
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(() =>
    imageModelsEndpoint({
      ...p,
      modelsUrl: "https://another.fixture.test/models",
    }),
  ).toThrow("同源");
});

it.each([
  ["images", { data: [{ b64_json: PNG }] }],
  [
    "chat",
    { choices: [{ message: { images: [{ image_url: { url: dataUrl } }] } }] },
  ],
  [
    "responses",
    {
      output: [
        { type: "image_generation_call", status: "completed", result: PNG },
      ],
    },
  ],
  [
    "gemini",
    {
      candidates: [
        {
          content: {
            parts: [
              { text: "完成" },
              { inlineData: { mimeType: "image/png", data: PNG } },
            ],
          },
        },
      ],
    },
  ],
  ["openrouter", { data: [{ b64_json: PNG, media_type: "image/png" }] }],
] as const)(
  "generates once through %s and retains the no-selfie instruction",
  async (protocol, data) => {
    const fetcher = vi.fn(async () => response(data));
    const result = await run(profile({ protocol }), fetcher);
    expect(result.data).toBe(dataUrl);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetcher.mock.calls[0][1].body);
    expect(JSON.stringify(body)).toContain(NO_SELFIE);
    if (protocol === "chat") {
      expect(body.messages[0].content).toContain("花瓶");
      expect(body).not.toHaveProperty("prompt");
      expect(body.modalities).toEqual(["text", "image"]);
    }
    if (protocol === "responses") {
      expect(body.store).toBe(false);
      expect(body.tool_choice.type).toBe("image_generation");
    }
    if (protocol === "gemini") {
      expect(body.generationConfig.responseModalities).toContain("IMAGE");
      expect(fetcher.mock.calls[0][1].headers["x-goog-api-key"]).toBe(
        "fixture-secret",
      );
    }
  },
);
it("builds multipart and JSON edits, and requires reference images for a fixed edits endpoint", async () => {
  const multipart = buildImageRequest(
    profile({ references: "auto" }),
    "fixture-secret",
    "花瓶",
    [dataUrl],
  );
  expect(multipart.url).toContain("/images/edits");
  expect(multipart.headers).not.toHaveProperty("Content-Type");
  expect(multipart.body).toBeInstanceOf(FormData);
  expect((multipart.body as FormData).get("image[]")).toBeInstanceOf(Blob);
  const json = buildImageRequest(
    profile({ references: "json" }),
    "fixture-secret",
    "花瓶",
    [dataUrl],
  );
  expect(JSON.parse(json.body as string).images[0].image_url).toBe(dataUrl);
  const fetcher = vi.fn();
  await expect(
    run(
      profile({ url: "https://images.fixture.test/v1/images/edits" }),
      fetcher,
    ),
  ).rejects.toThrow("需要参考图");
  expect(fetcher).not.toHaveBeenCalled();
  expect(() =>
    buildImageRequest(
      profile({
        url: "https://images.fixture.test/v1/images/generations",
        references: "auto",
      }),
      "fixture-secret",
      "花瓶",
      [dataUrl],
    ),
  ).toThrow("不能自动切");
});
it.each(["chat", "responses", "gemini", "openrouter"] as const)(
  "encodes references for %s without forcing an edits route",
  (protocol) => {
    const p = profile({
      protocol,
      references: "auto",
      toolModel: "tool-image",
      aspectRatio: "3:2",
      resolution: "2K",
    });
    const req = buildImageRequest(p, "fixture-secret", "花瓶", [dataUrl]);
    const data = JSON.parse(req.body as string);
    expect(JSON.stringify(data)).toContain(PNG);
    expect(req.url).not.toContain("/edits");
    if (protocol === "responses")
      expect(data.tools[0].model).toBe("tool-image");
    if (protocol === "openrouter")
      expect(data.input_references).toEqual([
        { type: "image_url", image_url: { url: dataUrl } },
      ]);
    if (protocol === "gemini")
      expect(data.generationConfig.imageConfig).toEqual({
        aspectRatio: "3:2",
        imageSize: "2K",
      });
  },
);
it("supports custom JSON, result extraction and alternate header auth without executing template text", async () => {
  const p = profile({
    protocol: "custom",
    url: "https://images.fixture.test/render",
    auth: "x-api-key",
    references: "auto",
    requestTemplate:
      '{"engine":"{{model}}","query":"{{prompt}}","references":"{{references}}"}',
    extraBody: '{"seed":42}',
    resultPath: "output.files[0].image",
  });
  const fetcher = vi.fn(async () =>
    response({ output: { files: [{ image: dataUrl }] } }),
  );
  expect((await run(p, fetcher, [dataUrl])).data).toBe(dataUrl);
  const req = fetcher.mock.calls[0][1];
  expect(req.headers["x-api-key"]).toBe("fixture-secret");
  expect(JSON.parse(req.body)).toMatchObject({
    engine: "image-fixture",
    references: [dataUrl],
    seed: 42,
  });
  expect(() =>
    validateImageConnection({
      ...p,
      requestTemplate: '{"prompt":"without placeholder"}',
    }),
  ).toThrow("{{prompt}}");
  expect(() =>
    validateImageConnection({ ...p, extraBody: '{"api_key":"sensitive"}' }),
  ).toThrow("密钥");
  expect(() =>
    validateImageConnection({ ...p, resultPath: "__proto__.url" }),
  ).toThrow("字段路径");
});
it("polls an async task without another POST or leaking credentials to the image host", async () => {
  vi.useFakeTimers();
  const p = profile({
    protocol: "custom",
    url: "https://images.fixture.test/jobs",
    pollUrl: "/jobs/{id}",
    taskIdPath: "task.id",
    statusPath: "task.state",
    resultPath: "result.url",
    pollInterval: 2,
  });
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(response({ task: { id: "a/b" } }))
    .mockResolvedValueOnce(response({ task: { state: "working" } }))
    .mockResolvedValueOnce(
      response({
        task: { state: "done" },
        result: { url: "https://cdn.fixture.test/image.png" },
      }),
    )
    .mockResolvedValueOnce(
      new Response(Uint8Array.from(atob(PNG), (c) => c.charCodeAt(0))),
    );
  const result = run(p, fetcher);
  await vi.advanceTimersByTimeAsync(4000);
  expect((await result).data).toBe(dataUrl);
  expect(fetcher.mock.calls.filter((c) => c[1].method === "POST")).toHaveLength(
    1,
  );
  expect(fetcher.mock.calls[1][0]).toBe(
    "https://images.fixture.test/jobs/a%2Fb",
  );
  expect(fetcher.mock.calls[3][1]).not.toHaveProperty("headers");
  expect(fetcher.mock.calls[3][1].credentials).toBe("omit");
});
it("cancels polling and refuses cross-origin task lookup before submitting", async () => {
  vi.useFakeTimers();
  const p = profile({ protocol: "custom", pollUrl: "/jobs/{id}" });
  const fetcher = vi.fn(async () => response({ id: "task" })),
    c = new AbortController();
  const result = run(p, fetcher, [], c.signal);
  const rejected = expect(result).rejects.toThrow("已停止");
  await vi.advanceTimersByTimeAsync(1);
  c.abort();
  await rejected;
  await vi.advanceTimersByTimeAsync(3000);
  expect(fetcher).toHaveBeenCalledTimes(1);
  await expect(
    run({ ...p, pollUrl: "https://another.fixture.test/jobs/{id}" }, fetcher),
  ).rejects.toThrow("同源");
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it.each([
  { choices: [{ message: { content: `画好了：![花瓶](${dataUrl})` } }] },
  {
    choices: [
      {
        message: {
          content: [{ type: "image_url", image_url: { url: dataUrl } }],
        },
      },
    ],
  },
  { candidates: [{ content: { parts: [{ inline_data: { data: PNG } }] } }] },
  { response: { output: [{ type: "image_generation_call", result: PNG }] } },
])("extracts image-bearing output %#", (data) =>
  expect(extractImageResult(data)).toMatch(/^(?:data:image|iVBOR)/),
);
it("reads split UTF-8/SSE events and fragmented chat images", async () => {
  const events =
    [
      {
        choices: [
          {
            delta: {
              content: "给你",
              images: [{ index: 0, image_url: { url: dataUrl.slice(0, 35) } }],
            },
          },
        ],
      },
      {
        choices: [
          {
            delta: {
              content: "看看",
              images: [{ index: 0, image_url: { url: dataUrl.slice(35) } }],
            },
          },
        ],
      },
    ]
      .map((d) => `data: ${JSON.stringify(d)}\r\n\r\n`)
      .join("") + "data: [DONE]\r\n\r\n";
  const bytes = new TextEncoder().encode(events);
  const body = new ReadableStream({
    start(c) {
      for (let i = 0; i < bytes.length; i += 7)
        c.enqueue(bytes.slice(i, i + 7));
      c.close();
    },
  });
  const result = await readImageResponse(
    new Response(body, { headers: { "content-type": "text/event-stream" } }),
  );
  expect(result.image).toBe(dataUrl);
});
it.each([
  { type: "image_generation.completed", b64_json: PNG },
  {
    type: "response.completed",
    response: {
      output: [
        { type: "image_generation_call", status: "completed", result: PNG },
      ],
    },
  },
  { candidates: [{ content: { parts: [{ inlineData: { data: PNG } }] } }] },
])("reads provider SSE image output %#", async (data) => {
  const r = new Response(`data: ${JSON.stringify(data)}\n\n`, {
    headers: { "content-type": "text/event-stream" },
  });
  expect((await readImageResponse(r)).image).toBe(PNG);
});
it("does not treat partial previews or URLs mentioned in prose as completed images", async () => {
  expect(
    extractImageResult({
      type: "image_generation.partial_image",
      partial_image_b64: PNG,
    }),
  ).toBeUndefined();
  expect(
    extractImageResult({
      choices: [{ message: { content: "请去 https://example.test/ 查看" } }],
    }),
  ).toBeUndefined();
  const sse = `data: ${JSON.stringify({ data: [{ b64_json: PNG }] })}\n\ndata: {"type":"response.failed","error":{"message":"fixture-secret"}}\n\n`;
  await expect(
    readImageResponse(
      new Response(sse, { headers: { "content-type": "text/event-stream" } }),
    ),
  ).rejects.toThrow("服务报告");
});
it("reports unsupported output and HTTP failures without endpoint probing or response-body secrets", async () => {
  const failed = vi.fn(
    async () => new Response("fixture-secret", { status: 400 }),
  );
  await expect(run(profile({ protocol: "chat" }), failed)).rejects.toThrow(
    "不匹配",
  );
  expect(failed).toHaveBeenCalledTimes(1);
  const text = vi.fn(async () =>
    response({ choices: [{ message: { content: "I cannot draw" } }] }),
  );
  await expect(run(profile({ protocol: "chat" }), text)).rejects.toThrow(
    "没有可读取的图片",
  );
  expect(text).toHaveBeenCalledTimes(1);
});
it("supports direct raster bodies and bounds response bytes", async () => {
  const fetcher = vi.fn(
    async () =>
      new Response(
        Uint8Array.from(atob(PNG), (c) => c.charCodeAt(0)),
        { headers: { "content-type": "image/png" } },
      ),
  );
  expect((await run(profile(), fetcher)).data).toBe(dataUrl);
  const large = vi.fn(
    async () =>
      new Response("{}", {
        headers: { "content-length": String(21 * 1024 * 1024) },
      }),
  );
  await expect(run(profile(), large)).rejects.toThrow("响应过大");
});
it("keeps generation defaults and credentials out of protocol snapshots", () => {
  const p = profile({ key: "fixture-secret" });
  const snapshot = imageConnectionSchema.parse(p);
  expect(snapshot).not.toHaveProperty("key");
  expect(() =>
    validateImageConnection({ ...p, extraBody: '{"messages":[]}' }),
  ).toThrow("不能覆盖");
  expect(() => validateImageConnection({ ...p, extraBody: '{"n":5}' })).toThrow(
    "不能覆盖",
  );
});

it("allows custom request formats at a known endpoint and rejects corrupt references before sending", async () => {
  const p = profile({
    protocol: "custom",
    url: "https://images.fixture.test/v1/chat/completions",
  });
  expect(resolveImageEndpoint(p)).toBe(p.url);
  const fetcher = vi.fn();
  await expect(
    run({ ...p, references: "auto" }, fetcher, [
      "data:image/png;base64," + btoa("not-an-image"),
    ]),
  ).rejects.toThrow("格式不符");
  expect(fetcher).not.toHaveBeenCalled();
});

it("handles malformed image-bearing fields as unsupported output instead of a network error", async () => {
  const fetcher = vi.fn(async () =>
    response({
      candidates: {},
      choices: [{ message: { images: {}, content: { unexpected: "shape" } } }],
    }),
  );
  await expect(run(profile({ protocol: "chat" }), fetcher)).rejects.toThrow(
    "没有可读取的图片",
  );
});
