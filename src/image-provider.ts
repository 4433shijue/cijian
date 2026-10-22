import type { ImageProfile } from "./image-types";

const MAX_IMAGE = 10 * 1024 * 1024;
function safeUrl(raw: string) {
  const u = new URL(raw);
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
  return u;
}
export function imageEndpoint(raw: string, edits = false) {
  const u = safeUrl(raw.trim());
  if (u.search)
    throw Error("请把密钥填入 API Key，不要放在接口地址的查询参数中");
  let path = u.pathname
    .replace(/\/+$/, "")
    .replace(
      /\/(?:chat\/completions|responses|images\/(?:generations|edits))$/,
      "",
    );
  if (!path) path = "/v1";
  u.pathname = path + (edits ? "/images/edits" : "/images/generations");
  return u.toString();
}
async function limitedBody(response: Response, max: number) {
  if (Number(response.headers.get("content-length")) > max)
    throw Error("图片响应过大，未写入本机");
  const reader = response.body?.getReader();
  if (!reader) throw Error("生图服务返回了空响应");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > max) {
        await reader.cancel();
        throw Error("图片响应过大，未写入本机");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}
function mimeOf(b: Uint8Array) {
  if (b[0] === 137 && b[1] === 80 && b[2] === 78 && b[3] === 71)
    return "image/png" as const;
  if (b[0] === 255 && b[1] === 216 && b[2] === 255)
    return "image/jpeg" as const;
  if (
    new TextDecoder().decode(b.slice(0, 4)) === "RIFF" &&
    new TextDecoder().decode(b.slice(8, 12)) === "WEBP"
  )
    return "image/webp" as const;
  throw Error("服务未返回有效的 PNG、JPEG 或 WebP 图片");
}
function base64(bytes: Uint8Array) {
  let result = "";
  for (let i = 0; i < bytes.length; i += 8192)
    result += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(result);
}
function fromDataUrl(data: string) {
  if (
    !/^data:image\/(png|jpeg|webp);base64,/.test(data) ||
    data.length > 15 * 1024 * 1024
  )
    throw Error("参考图格式或大小无效");
  const bytes = Uint8Array.from(atob(data.split(",")[1]), (x) =>
    x.charCodeAt(0),
  );
  return new Blob([bytes], { type: mimeOf(bytes) });
}
export async function normalizeImage(bytes: Uint8Array) {
  if (!bytes.length || bytes.length > MAX_IMAGE)
    throw Error("图片须不超过 10 MiB，请降低生成尺寸");
  let mime = mimeOf(bytes),
    data = `data:${mime};base64,${base64(bytes)}`,
    size = bytes.length;
  if (
    typeof createImageBitmap !== "undefined" &&
    typeof document !== "undefined"
  ) {
    const bitmap = await createImageBitmap(
      new Blob([new Uint8Array(bytes)], { type: mime }),
    );
    try {
      if (
        !bitmap.width ||
        !bitmap.height ||
        bitmap.width * bitmap.height > 64_000_000
      )
        throw Error("图片尺寸过大或无法读取");
      const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      canvas
        .getContext("2d")!
        .drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      data = canvas.toDataURL("image/webp", 0.9);
      mime = data.startsWith("data:image/webp") ? "image/webp" : "image/png";
      size = Math.floor((data.split(",")[1].length * 3) / 4);
    } finally {
      bitmap.close();
    }
  }
  return { data, mime, size };
}
export async function referenceFile(file: File) {
  return (await normalizeImage(new Uint8Array(await file.arrayBuffer()))).data;
}

/** Exactly one provider request. Never fallback/retry a possibly billed request. */
export async function requestImage(
  profile: ImageProfile,
  key: string,
  prompt: string,
  references: string[],
  signal: AbortSignal,
  fetcher = fetch,
) {
  if (!key.trim() || !profile.model.trim())
    throw Error("请先保存生图模型和 API Key");
  const edits = !!references.length && profile.references !== "off";
  if (edits) references.forEach(fromDataUrl);
  const options: Record<string, unknown> = {
    model: profile.model.trim(),
    prompt,
    n: 1,
  };
  if (profile.size) options.size = profile.size;
  if (profile.quality) options.quality = profile.quality;
  if (profile.responseFormat) options.response_format = profile.responseFormat;
  const headers: Record<string, string> = { Authorization: `Bearer ${key}` };
  let body: BodyInit;
  if (edits && profile.references === "multipart") {
    const form = new FormData();
    for (const [k, v] of Object.entries(options)) form.append(k, String(v));
    references.forEach((data, i) =>
      form.append("image[]", fromDataUrl(data), `reference-${i + 1}.png`),
    );
    body = form;
  } else {
    headers["Content-Type"] = "application/json";
    if (edits) options.images = references.map((image_url) => ({ image_url }));
    body = JSON.stringify(options);
  }
  const timeout = AbortSignal.timeout(profile.timeout * 1000);
  const requestSignal = AbortSignal.any([signal, timeout]);
  try {
    const response = await fetcher(imageEndpoint(profile.url, edits), {
      method: "POST",
      headers,
      body,
      signal: requestSignal,
      credentials: "omit",
      redirect: "error",
    });
    if (!response.ok)
      throw Error(
        `生图接口返回 HTTP ${response.status}，请核对模型、尺寸、质量、额度与协议。未自动重试。`,
      );
    const json = JSON.parse(
      new TextDecoder().decode(await limitedBody(response, 20 * 1024 * 1024)),
    );
    const item = json?.data?.[0];
    let bytes: Uint8Array;
    if (typeof item?.b64_json === "string") {
      if (item.b64_json.length > 15 * 1024 * 1024)
        throw Error("生成图片超过 10 MiB");
      bytes = Uint8Array.from(atob(item.b64_json), (x) => x.charCodeAt(0));
    } else if (typeof item?.url === "string") {
      const url = safeUrl(item.url);
      const download = await fetcher(url.toString(), {
        signal: requestSignal,
        credentials: "omit",
        referrerPolicy: "no-referrer",
      });
      if (!download.ok) throw Error("图片已生成，但下载失败；未自动重新生图");
      bytes = await limitedBody(download, MAX_IMAGE);
    } else
      throw Error(
        "响应没有图片数据；此处需要 Images API，文字聊天接口不能直接用于生图",
      );
    requestSignal.throwIfAborted();
    return await normalizeImage(bytes);
  } catch (e) {
    if (signal.aborted)
      throw Error("生图已停止；服务端可能已计费，请确认后再重试");
    if (timeout.aborted)
      throw Error("生图等待超时；服务端可能已计费，未自动重试");
    if (e instanceof TypeError)
      throw Error(
        "无法连接图片服务或下载图片，请检查网络和浏览器跨域支持；未自动重试",
      );
    throw e;
  }
}
