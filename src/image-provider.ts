import { imageConnectionSchema, type ImageProfile } from "./image-types";
import {
  imageHeaders,
  imageHttpError,
  limitedImageBody,
  safeImageUrl,
} from "./image-connection";
import {
  buildImageRequest,
  imageValueAt,
  readImageResponse,
} from "./image-protocol";
export { imageEndpoint } from "./image-connection";

const MAX_IMAGE = 10 * 1024 * 1024;
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

function waitForPoll(ms: number, signal: AbortSignal) {
  signal.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal.addEventListener("abort", abort, { once: true });
  });
}
/** One generation POST. Polling/download never resubmit a possibly billed job. */
export async function requestImage(
  profile: ImageProfile,
  key: string,
  prompt: string,
  references: string[],
  signal: AbortSignal,
  fetcher = fetch,
) {
  const p = imageConnectionSchema.parse(profile);
  const request = buildImageRequest(p, key, prompt, references);
  const timeout = AbortSignal.timeout(p.timeout * 1000),
    requestSignal = AbortSignal.any([signal, timeout]);
  try {
    requestSignal.throwIfAborted();
    const response = await fetcher(request.url, {
      method: "POST",
      headers: request.headers,
      body: request.body,
      signal: requestSignal,
      credentials: "omit",
      redirect: "error",
    });
    if (!response.ok) throw imageHttpError(response.status);
    let bytes: Uint8Array;
    if (
      /^image\/(png|jpeg|webp)(?:;|$)/i.test(
        response.headers.get("content-type") || "",
      )
    ) {
      bytes = await limitedImageBody(response, MAX_IMAGE);
    } else {
      let { data, image } = await readImageResponse(response, p.resultPath);
      if (p.pollUrl && !image) {
        const id = imageValueAt(data, p.taskIdPath);
        if (
          (typeof id !== "string" && typeof id !== "number") ||
          !String(id).trim() ||
          String(id).length > 1000
        )
          throw Error("服务已接收请求，但未返回可读取的任务编号；未重新提交");
        const pollUrl = safeImageUrl(
          new URL(
            p.pollUrl.replaceAll("{id}", encodeURIComponent(String(id))),
            request.url,
          ).toString(),
          true,
        );
        if (pollUrl.origin !== new URL(request.url).origin)
          throw Error("任务查询地址须与生图接口同源");
        const success = p.successStates
            .split(",")
            .map((s) => s.trim().toLowerCase()),
          failure = p.failureStates
            .split(",")
            .map((s) => s.trim().toLowerCase());
        for (;;) {
          await waitForPoll(p.pollInterval * 1000, requestSignal);
          const result = await fetcher(pollUrl.toString(), {
            headers: imageHeaders(p, key),
            signal: requestSignal,
            credentials: "omit",
            redirect: "error",
          });
          if (!result.ok) throw imageHttpError(result.status);
          const parsed = await readImageResponse(result, p.resultPath);
          data = parsed.data;
          const state = String(
            imageValueAt(data, p.statusPath) ?? "",
          ).toLowerCase();
          if (failure.includes(state))
            throw Error("服务报告图片任务失败，未重新提交；请查看服务记录");
          if (success.includes(state)) {
            image = parsed.image;
            break;
          }
          if (!state)
            throw Error("任务响应缺少状态字段，请核对状态路径；未重新提交");
        }
      }
      if (!image)
        throw Error(
          "响应中没有可读取的图片；请核对模型是否支持图片输出、所选协议和结果字段路径。未自动重试。",
        );
      if (/^https?:\/\//.test(image)) {
        const url = safeImageUrl(image);
        const download = await fetcher(url.toString(), {
          signal: requestSignal,
          credentials: "omit",
          redirect: "error",
          referrerPolicy: "no-referrer",
        });
        if (!download.ok) throw Error("图片已生成，但下载失败；未自动重新生图");
        bytes = await limitedImageBody(download, MAX_IMAGE);
      } else {
        const b64 = image.startsWith("data:")
          ? image.slice(image.indexOf(",") + 1)
          : image;
        if (b64.length > 15 * 1024 * 1024) throw Error("生成图片超过 10 MiB");
        try {
          bytes = Uint8Array.from(atob(b64), (x) => x.charCodeAt(0));
        } catch {
          throw Error("图片 Base64 不完整或无法解码，未自动重试");
        }
      }
    }
    requestSignal.throwIfAborted();
    const normalized = await normalizeImage(bytes);
    requestSignal.throwIfAborted();
    return normalized;
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
