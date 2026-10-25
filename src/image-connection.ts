import {
  imageConnectionSchema,
  type ImageConnection,
  type ImageProtocol,
} from "./image-types";
import { imageAbortable } from "./image-diagnostics";

export const imageProtocols: Record<ImageProtocol, string> = {
  auto: "自动识别",
  images: "Images · 生成 / 编辑",
  chat: "Chat Completions · 聊天生图",
  responses: "Responses · 生图工具",
  gemini: "Gemini · 原生",
  openrouter: "OpenRouter · Image API",
  custom: "自定义 JSON / 异步任务",
};
export function safeImageUrl(raw: string, configuration = false) {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw Error("请填写有效的完整接口地址");
  }
  if (
    u.username ||
    u.password ||
    u.hash ||
    (u.protocol !== "https:" &&
      !(
        u.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname)
      ))
  )
    throw Error("图片接口和图片地址需要 HTTPS；本机 localhost 可使用 HTTP");
  if (
    configuration &&
    [...u.searchParams.keys()].some((k) =>
      /^(?:key|api[-_]?key|access[-_]?token|token|authorization|secret)$/i.test(
        k,
      ),
    )
  )
    throw Error("请把密钥填入 API Key，不要放在接口地址的查询参数中");
  return u;
}
const routePattern =
  /\/(chat\/completions|responses|images(?:\/(?:generations|edits))?|models\/[^/]+:(?:streamGenerateContent|generateContent))\/?$/;
function pathProtocol(
  path: string,
): Exclude<ImageProtocol, "auto"> | undefined {
  if (/\/chat\/completions\/?$/.test(path)) return "chat";
  if (/\/responses\/?$/.test(path)) return "responses";
  if (/\/images\/(?:generations|edits)\/?$/.test(path)) return "images";
  if (/\/images\/?$/.test(path)) return "openrouter";
  if (/:(?:streamGenerateContent|generateContent)$/.test(path)) return "gemini";
}
export function resolvedImageProtocol(
  p: ImageConnection,
): Exclude<ImageProtocol, "auto"> {
  if (p.protocol && p.protocol !== "auto") return p.protocol;
  const u = safeImageUrl(p.url, true);
  return (
    pathProtocol(u.pathname) ||
    (u.hostname === "generativelanguage.googleapis.com"
      ? "gemini"
      : u.hostname === "openrouter.ai"
        ? "openrouter"
        : "images")
  );
}
function isBase(path: string) {
  return (
    !path ||
    path === "/" ||
    /\/(?:api|v\d+(?:beta\d*|alpha\d*)?)\/?$/.test(path)
  );
}
export function resolveImageEndpoint(
  raw: ImageConnection,
  withReferences = false,
) {
  const p = imageConnectionSchema.parse(raw),
    u = safeImageUrl(p.url, true),
    protocol = resolvedImageProtocol(p);
  const full =
    p.endpointMode === "full" ||
    (p.endpointMode === "auto" && !isBase(u.pathname));
  if (full || protocol === "custom") {
    const detected = pathProtocol(u.pathname);
    if (detected && detected !== protocol && protocol !== "custom")
      throw Error(
        "完整端点与所选协议不一致，请调整协议或地址；不会改写完整端点",
      );
    if (protocol === "gemini" && /\/models\/[^/]+:/.test(u.pathname)) {
      const embedded = decodeURIComponent(
        u.pathname.match(/\/models\/([^/]+):/)![1],
      );
      if (p.model && embedded !== p.model.replace(/^models\//, ""))
        throw Error(
          "完整 Gemini 地址中的模型与所选模型不一致，请使用基础地址或调整模型",
        );
    }
    return u.toString();
  }
  let base = u.pathname.replace(/\/+$/, "");
  if (!base)
    base =
      protocol === "gemini"
        ? "/v1beta"
        : u.hostname === "openrouter.ai"
          ? "/api/v1"
          : "/v1";
  const suffix =
    protocol === "chat"
      ? "/chat/completions"
      : protocol === "responses"
        ? "/responses"
        : protocol === "openrouter"
          ? "/images"
          : protocol === "gemini"
            ? `/models/${encodeURIComponent(p.model.replace(/^models\//, ""))}:${p.stream ? "streamGenerateContent" : "generateContent"}`
            : `/images/${withReferences ? "edits" : "generations"}`;
  u.pathname = base + suffix;
  if (protocol === "gemini" && p.stream) u.searchParams.set("alt", "sse");
  return u.toString();
}
// Explicit opt-in only; never use this to resubmit a failed generation.
export function chatImageCompatibility(
  p: ImageConnection,
): ImageConnection | undefined {
  try {
    if (resolvedImageProtocol(p) !== "images") return;
    const url = safeImageUrl(resolveImageEndpoint(p), true);
    if (!/\/images\/(?:generations|edits)\/?$/.test(url.pathname)) return;
    url.pathname = url.pathname.replace(
      /\/images\/(?:generations|edits)\/?$/,
      "/chat/completions",
    );
    return imageConnectionSchema.parse({
      ...p,
      url: url.toString(),
      protocol: "chat",
      endpointMode: "full",
      stream: true,
      references: p.references === "off" ? "off" : "auto",
      extraBody: "",
      resultPath: "",
      pollUrl: "",
      toolModel: "",
    });
  } catch {
    return;
  }
}

// Compatibility entry point for callers that only need address validation.
export function imageEndpoint(url: string, edits = false) {
  return resolveImageEndpoint(
    imageConnectionSchema.parse({ url, model: "" }),
    edits,
  );
}
export function imageModelsEndpoint(p: ImageConnection) {
  const endpoint = safeImageUrl(p.url, true);
  if (p.modelsUrl.trim()) {
    const u = safeImageUrl(new URL(p.modelsUrl, endpoint).toString(), true);
    if (u.origin !== endpoint.origin)
      throw Error("模型列表地址须与生图接口同源，避免把密钥发往其他站点");
    return u.toString();
  }
  let base = endpoint.pathname.replace(/\/+$/, "").replace(routePattern, "");
  if (
    !isBase(endpoint.pathname) &&
    base === endpoint.pathname.replace(/\/+$/, "")
  )
    throw Error(
      "无法推断这个自定义端点的模型列表地址，请在兼容设置中填写模型列表地址",
    );
  if (!base)
    base =
      resolvedImageProtocol(p) === "gemini"
        ? "/v1beta"
        : endpoint.hostname === "openrouter.ai"
          ? "/api/v1"
          : "/v1";
  endpoint.pathname = base + "/models";
  endpoint.search = "";
  return endpoint.toString();
}
export function imageHeaders(p: ImageConnection, key: string) {
  const auth =
    p.auth === "auto"
      ? resolvedImageProtocol(p) === "gemini"
        ? "x-goog-api-key"
        : "bearer"
      : p.auth;
  if (auth === "none") return {} as Record<string, string>;
  if (!key.trim()) throw Error("请填写生图 API Key");
  return {
    [auth === "bearer" ? "Authorization" : auth]:
      auth === "bearer" ? `Bearer ${key.trim()}` : key.trim(),
  };
}
export interface ImageBodyOptions {
  signal?: AbortSignal;
  onBytes?: (bytes: number) => void | Promise<void>;
}
export async function* imageBodyChunks(
  response: Response,
  max = 20 * 1024 * 1024,
  options: ImageBodyOptions = {},
) {
  if (Number(response.headers.get("content-length")) > max)
    throw Error("接口响应过大，已停止读取");
  const reader = response.body?.getReader();
  if (!reader) throw Error("服务返回了空响应");
  let size = 0;
  let finished = false;
  try {
    for (;;) {
      options.signal?.throwIfAborted();
      const { done, value } = await imageAbortable(
        reader.read(),
        options.signal,
      );
      if (done) {
        finished = true;
        break;
      }
      size += value.length;
      if (size > max) {
        throw Error("接口响应过大，已停止读取");
      }
      await options.onBytes?.(size);
      yield value;
    }
  } finally {
    // Some gateways never close after [DONE]. Cancellation must not wait for them.
    if (!finished) void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
export async function limitedImageBody(
  response: Response,
  max = 20 * 1024 * 1024,
  options: ImageBodyOptions = {},
) {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const value of imageBodyChunks(response, max, options)) {
    chunks.push(value);
    size += value.length;
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}
export function imageHttpError(status: number, listing = false) {
  const reason =
    status === 401 || status === 403
      ? "密钥无效、权限不足或服务拒绝访问"
      : status === 404
        ? "端点或模型不存在"
        : status === 429
          ? "额度不足或请求过于频繁"
          : status === 400 || status === 422
            ? "模型、协议、参考图或生成参数不匹配"
            : "服务暂时无法完成请求";
  return Error(
    `${listing ? "模型列表" : "生图接口"}返回 HTTP ${status} · ${reason}。${listing ? "可以手动填写模型名。" : "未自动重试。"}`,
  );
}
export interface ImageModelOption {
  id: string;
  name: string;
  outputImage?: boolean;
  inputImage?: boolean;
}
function modalities(value: unknown): string[] | undefined {
  return Array.isArray(value)
    ? value.filter((x): x is string => typeof x === "string")
    : undefined;
}
export async function fetchImageModels(
  raw: ImageConnection,
  key: string,
  signal: AbortSignal,
  fetcher = fetch,
) {
  const p = imageConnectionSchema.parse(raw),
    initial = new URL(imageModelsEndpoint(p));
  const headers = imageHeaders(p, key),
    models = new Map<string, ImageModelOption>(),
    seen = new Set<string>();
  let url: URL | undefined = initial;
  const timeout = AbortSignal.timeout(20000),
    combined = AbortSignal.any([signal, timeout]);
  try {
    for (let page = 0; url && page < 20; page++) {
      if (seen.has(url.toString()))
        throw Error("模型列表分页重复，请使用自定义列表地址或手填模型");
      seen.add(url.toString());
      const r = await fetcher(url.toString(), {
        headers,
        signal: combined,
        credentials: "omit",
        redirect: "error",
      });
      if (!r.ok) throw imageHttpError(r.status, true);
      let data: any;
      try {
        data = JSON.parse(
          new TextDecoder().decode(await limitedImageBody(r, 4 * 1024 * 1024)),
        );
      } catch {
        throw Error("模型列表不是可读取的 JSON，可以手动填写模型名");
      }
      const entries = Array.isArray(data) ? data : data?.data || data?.models;
      if (!Array.isArray(entries))
        throw Error("服务未返回模型数组，可以手动填写模型名");
      for (const entry of entries) {
        const candidate =
          typeof entry === "string" ? entry : entry?.id || entry?.name;
        if (typeof candidate !== "string") continue;
        const id = candidate.replace(/^models\//, "").trim();
        if (!id || id.length > 500) continue;
        const output = modalities(
            entry?.architecture?.output_modalities ?? entry?.output_modalities,
          ),
          input = modalities(
            entry?.architecture?.input_modalities ?? entry?.input_modalities,
          );
        models.set(id, {
          id,
          name:
            typeof entry?.displayName === "string"
              ? entry.displayName
              : typeof entry?.name === "string" &&
                  !entry.name.startsWith("models/")
                ? entry.name
                : id,
          outputImage: output?.includes("image"),
          inputImage: input?.includes("image"),
        });
        if (models.size > 10000)
          throw Error("模型列表过大，请使用服务的筛选列表地址");
      }
      url = undefined;
      if (typeof data.nextPageToken === "string" && data.nextPageToken) {
        url = new URL(initial);
        url.searchParams.set("pageToken", data.nextPageToken);
      } else if (data.has_more === true && entries.length) {
        const last = entries.at(-1)?.id;
        if (typeof last !== "string") throw Error("无法读取模型分页游标");
        url = new URL(initial);
        url.searchParams.set("after", last);
      }
    }
    if (url) throw Error("模型列表分页过多，请使用筛选后的模型列表地址");
    combined.throwIfAborted();
    return [...models.values()];
  } catch (e) {
    if (signal.aborted) throw Error("已停止拉取模型");
    if (timeout.aborted) throw Error("拉取模型超时，可以重试或手动填写模型名");
    if (e instanceof TypeError)
      throw Error(
        "无法读取模型列表，请检查网络和浏览器跨域支持；也可以手动填写模型名",
      );
    throw e;
  }
}
