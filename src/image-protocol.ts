import {
  imageConnectionSchema,
  NO_SELFIE,
  type ImageConnection,
} from "./image-types";
import {
  imageHeaders,
  imageBodyChunks,
  type ImageBodyOptions,
  resolveImageEndpoint,
  resolvedImageProtocol,
  safeImageUrl,
} from "./image-connection";

const forbidden =
  /^(?:__proto__|prototype|constructor|authorization|api[-_]?key|access[-_]?token|secret|password|headers)$/i;
function checkObject(value: unknown, depth = 0): void {
  if (depth > 20) throw Error("自定义参数嵌套过深");
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      if (forbidden.test(k))
        throw Error(
          "自定义参数中不能保存密钥、请求头或特殊对象字段；鉴权请使用 API Key 设置",
        );
      checkObject(v, depth + 1);
    }
  }
}
export function parseImageParameters(text: string) {
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(text || "{}");
  } catch {
    throw Error("自定义参数须为合法 JSON 对象");
  }
  if (!data || typeof data !== "object" || Array.isArray(data))
    throw Error("自定义参数须为 JSON 对象");
  checkObject(data);
  return data;
}
function pathKeys(path: string) {
  const normalized = path.replace(/\[(\d+)\]/g, ".$1");
  if (
    !/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/.test(normalized) ||
    normalized
      .split(".")
      .some((k) => /^(?:__proto__|prototype|constructor)$/.test(k))
  )
    throw Error("结果字段路径只支持点分隔的字段和数组下标，例如 data.0.url");
  return normalized.split(".");
}
export function imageValueAt(data: unknown, path: string): unknown {
  if (!path) return undefined;
  let value: any = data;
  for (const k of pathKeys(path))
    value =
      value && typeof value === "object" && Object.hasOwn(value, k)
        ? value[k]
        : undefined;
  return value;
}
export function validateImageConnection(raw: ImageConnection) {
  const p = imageConnectionSchema.parse(raw);
  if (!p.model.trim()) throw Error("请选择或填写生图模型");
  resolveImageEndpoint(p);
  if (p.modelsUrl) {
    const models = safeImageUrl(new URL(p.modelsUrl, p.url).toString(), true);
    if (models.origin !== new URL(p.url).origin)
      throw Error("模型列表地址须与生图接口同源");
  }
  const extra = parseImageParameters(p.extraBody);
  if (
    Object.keys(extra).some((k) =>
      [
        "model",
        "prompt",
        "messages",
        "input",
        "contents",
        "tools",
        "n",
        "stream",
        "images",
        "image",
        "input_references",
      ].includes(k),
    )
  )
    throw Error(
      "额外参数不能覆盖模型、画面、参考图、工具、张数或流式开关，请使用对应设置",
    );
  if (p.resultPath) pathKeys(p.resultPath);
  if (p.pollUrl) {
    if (resolvedImageProtocol(p) !== "custom")
      throw Error("任务查询设置只适用于自定义协议");
    if (!p.pollUrl.includes("{id}"))
      throw Error("任务查询地址须包含 {id} 占位符");
    const poll = safeImageUrl(
      new URL(p.pollUrl.replaceAll("{id}", "example"), p.url).toString(),
      true,
    );
    if (poll.origin !== new URL(p.url).origin)
      throw Error("任务查询地址须与生图接口同源");
    pathKeys(p.taskIdPath);
    pathKeys(p.statusPath);
    if (!p.successStates.trim() || !p.failureStates.trim())
      throw Error("请填写任务成功和失败状态");
  }
  if (resolvedImageProtocol(p) === "custom") {
    const template = parseImageParameters(p.requestTemplate);
    if (!JSON.stringify(Object.values(template)).includes("{{prompt}}"))
      throw Error("自定义请求必须包含 {{prompt}}，以传入画面与禁止自拍规则");
    if (template.n !== undefined && template.n !== 1)
      throw Error("每个配图任务只允许生成一张图片，n 须为 1");
  }
  return p;
}
function expandTemplate(
  value: unknown,
  variables: Record<string, unknown>,
): unknown {
  if (typeof value === "string") {
    const exact = value.match(/^\{\{([A-Za-z]+)\}\}$/);
    if (exact) {
      if (!Object.hasOwn(variables, exact[1]))
        throw Error("自定义请求包含未知占位符");
      return variables[exact[1]];
    }
    return value.replace(/\{\{([A-Za-z]+)\}\}/g, (_, key) => {
      if (!Object.hasOwn(variables, key) || typeof variables[key] === "object")
        throw Error("数组占位符须单独作为字段值，或存在未知占位符");
      return String(variables[key]);
    });
  }
  if (Array.isArray(value))
    return value.map((v) => expandTemplate(v, variables));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, expandTemplate(v, variables)]),
    );
  return value;
}
export function referenceBlob(data: string) {
  if (
    !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=\s]+$/.test(data) ||
    data.length > 15 * 1024 * 1024
  )
    throw Error("参考图格式或大小无效");
  const mime = data.slice(5, data.indexOf(";"));
  const bytes = Uint8Array.from(atob(data.slice(data.indexOf(",") + 1)), (c) =>
    c.charCodeAt(0),
  );
  if (bytes.length > 10 * 1024 * 1024) throw Error("参考图超过 10 MiB");
  const actual =
    bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71
      ? "image/png"
      : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
        ? "image/jpeg"
        : new TextDecoder().decode(bytes.slice(0, 4)) === "RIFF" &&
            new TextDecoder().decode(bytes.slice(8, 12)) === "WEBP"
          ? "image/webp"
          : "";
  if (actual !== mime) throw Error("参考图内容与图片格式不符，请重新上传图片");
  return new Blob([bytes], { type: mime });
}
export function buildImageRequest(
  raw: ImageConnection,
  key: string,
  description: string,
  inputReferences: string[],
) {
  const p = validateImageConnection(raw),
    protocol = resolvedImageProtocol(p),
    headers = imageHeaders(p, key);
  const references = p.references === "off" ? [] : inputReferences;
  references.forEach(referenceBlob);
  const prompt = description.includes(NO_SELFIE)
    ? description
    : `${description}\n${NO_SELFIE}`;
  const url = resolveImageEndpoint(p, references.length > 0);
  if (
    protocol === "images" &&
    /\/images\/edits\/?$/.test(new URL(url).pathname) &&
    !references.length
  )
    throw Error(
      "图片编辑端点需要参考图；请启用参考图并添加图片，或配置可用于纯文字生图的连接",
    );
  if (
    protocol === "images" &&
    /\/images\/generations\/?$/.test(new URL(url).pathname) &&
    references.length
  )
    throw Error(
      "完整 generations 端点不能自动切到 edits；请使用基础地址或编辑端点发送参考图",
    );
  let data: Record<string, unknown>;
  if (protocol === "chat") {
    data = {
      model: p.model.trim(),
      messages: [
        {
          role: "user",
          content: references.length
            ? [
                { type: "text", text: prompt },
                ...references.map((url) => ({
                  type: "image_url",
                  image_url: { url },
                })),
              ]
            : prompt,
        },
      ],
      modalities: ["text", "image"],
      stream: p.stream,
    };
    if (p.aspectRatio || p.resolution)
      data.image_config = {
        ...(p.aspectRatio && { aspect_ratio: p.aspectRatio }),
        ...(p.resolution && { image_size: p.resolution }),
      };
  } else if (protocol === "responses") {
    const tool: Record<string, unknown> = { type: "image_generation" };
    if (p.toolModel.trim()) tool.model = p.toolModel.trim();
    if (p.size) tool.size = p.size;
    if (p.quality) tool.quality = p.quality;
    data = {
      model: p.model.trim(),
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: prompt },
            ...references.map((image_url) => ({
              type: "input_image",
              image_url,
            })),
          ],
        },
      ],
      tools: [tool],
      tool_choice: { type: "image_generation" },
      stream: p.stream,
      store: false,
    };
  } else if (protocol === "gemini") {
    data = {
      contents: [
        {
          role: "user",
          parts: [
            { text: prompt },
            ...references.map((data) => ({
              inlineData: {
                mimeType: data.slice(5, data.indexOf(";")),
                data: data.slice(data.indexOf(",") + 1),
              },
            })),
          ],
        },
      ],
      generationConfig: {
        responseModalities: ["TEXT", "IMAGE"],
        ...((p.aspectRatio || p.resolution) && {
          imageConfig: {
            ...(p.aspectRatio && { aspectRatio: p.aspectRatio }),
            ...(p.resolution && { imageSize: p.resolution }),
          },
        }),
      },
    };
  } else if (protocol === "custom") {
    data = expandTemplate(parseImageParameters(p.requestTemplate), {
      model: p.model.trim(),
      prompt,
      references,
      size: p.size,
      quality: p.quality,
      aspectRatio: p.aspectRatio,
      resolution: p.resolution,
      stream: p.stream,
    }) as Record<string, unknown>;
  } else {
    data = { model: p.model.trim(), prompt, n: 1 };
    if (protocol === "openrouter") {
      if (p.aspectRatio) data.aspect_ratio = p.aspectRatio;
      if (p.resolution) data.resolution = p.resolution;
      if (references.length)
        data.input_references = references.map((url) => ({
          type: "image_url",
          image_url: { url },
        }));
    } else {
      if (p.size) data.size = p.size;
      if (p.responseFormat) data.response_format = p.responseFormat;
      if (references.length && p.references === "json")
        data.images = references.map((image_url) => ({ image_url }));
    }
    if (p.quality) data.quality = p.quality;
    if (p.stream) data.stream = true;
  }
  data = { ...data, ...parseImageParameters(p.extraBody) };
  let body: BodyInit;
  if (protocol === "images" && references.length && p.references !== "json") {
    const form = new FormData();
    for (const [k, v] of Object.entries(data))
      form.append(k, typeof v === "object" ? JSON.stringify(v) : String(v));
    references.forEach((data, i) => {
      const blob = referenceBlob(data);
      form.append(
        "image[]",
        blob,
        `reference-${i + 1}.${blob.type.split("/")[1]}`,
      );
    });
    body = form;
  } else {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(data);
  }
  return { url, headers, body };
}

// Read only known image-bearing fields; a random URL in prose is not an image.
const array = (value: unknown): any[] => (Array.isArray(value) ? value : []);
export function extractImageResult(data: any, path = ""): string | undefined {
  const imageString = (v: unknown): string | undefined => {
    if (
      typeof v === "string" &&
      (/^(?:https?:\/\/|data:image\/)/.test(v) ||
        /^(?:iVBOR|\/9j\/|UklGR)/.test(v))
    )
      return v;
    if (v && typeof v === "object") {
      const x = v as any;
      return imageString(
        x.b64_json ||
          x.url ||
          x.image_url?.url ||
          x.image_url ||
          x.inlineData?.data ||
          x.inline_data?.data,
      );
    }
  };
  if (path) return imageString(imageValueAt(data, path));
  if (Array.isArray(data)) {
    for (const item of data) {
      const found = extractImageResult(item);
      if (found) return found;
    }
    return;
  }
  const direct = imageString(data?.data?.[0]) || imageString(data?.images?.[0]);
  if (direct) return direct;
  if (data?.type === "image_generation_call" && data.status !== "in_progress")
    return imageString(data.result);
  if (
    ["image_generation.completed", "image_edit.completed"].includes(data?.type)
  )
    return imageString(data.b64_json);
  if (data?.output) {
    const found = extractImageResult(data.output);
    if (found) return found;
  }
  if (data?.response) {
    const found = extractImageResult(data.response);
    if (found) return found;
  }
  for (const candidate of array(data?.candidates)) {
    for (const part of array(candidate?.content?.parts)) {
      const found = imageString(part);
      if (found) return found;
    }
  }
  const message = data?.choices?.[0]?.message;
  if (message) {
    for (const item of array(message.images)) {
      const found = imageString(item);
      if (found) return found;
    }
    if (Array.isArray(message.content)) {
      for (const item of message.content) {
        const found = imageString(item);
        if (found) return found;
      }
    }
    const text =
      typeof message.content === "string"
        ? message.content
        : array(message.content)
            .map((p: any) => (typeof p?.text === "string" ? p.text : ""))
            .join("");
    const markdown = text.match(
      /!\[[^\]]*\]\(\s*<?((?:https?:\/\/|data:image\/)[^\s<>]+?)>?(?:\s+"[^"]*")?\s*\)/,
    );
    return markdown ? imageString(markdown[1]) : imageString(text.trim());
  }
}
function providerFailure(data: any) {
  if (
    data?.error ||
    ["error", "response.failed", "response.incomplete"].includes(data?.type) ||
    data?.response?.error ||
    ["failed", "incomplete"].includes(data?.status) ||
    array(data?.choices).some((c: any) =>
      ["length", "content_filter"].includes(c?.finish_reason),
    ) ||
    data?.promptFeedback?.blockReason ||
    array(data?.candidates).some((c: any) =>
      ["SAFETY", "IMAGE_SAFETY", "PROHIBITED_CONTENT", "BLOCKLIST"].includes(
        c?.finishReason,
      ),
    )
  )
    throw Error("服务报告生成失败、受限或未完成；未自动重试，请查看服务记录");
}
export async function readImageResponse(
  response: Response,
  resultPath = "",
  options: ImageBodyOptions & {
    onFormat?: (format: "json" | "sse") => void | Promise<void>;
  } = {},
) {
  let last: any,
    result: string | undefined,
    content = "";
  const imageDeltas = new Map<number, string>();
  const event = (block: string) => {
    const raw = block
      .split(/\r\n|\r|\n/)
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trimStart())
      .join("\n");
    if (raw === "[DONE]") return true;
    if (!raw) return false;
    let data: any;
    try {
      data = JSON.parse(raw);
    } catch {
      throw Error("生图流式响应不完整，未自动重试");
    }
    providerFailure(data);
    last = data;
    result = extractImageResult(data, resultPath) || result;
    const delta = data?.choices?.[0]?.delta;
    if (typeof delta?.content === "string") content += delta.content;
    if (Array.isArray(delta?.content)) {
      for (const part of delta.content) {
        if (typeof part?.text === "string") content += part.text;
        const image = extractImageResult({
          choices: [{ message: { content: [part] } }],
        });
        if (image) result = image;
      }
    }
    for (const [position, item] of array(delta?.images).entries()) {
      const value =
        item?.image_url?.url || item?.image_url || item?.url || item?.b64_json;
      if (typeof value !== "string") continue;
      const index = item.index ?? position,
        prior = imageDeltas.get(index) || "";
      imageDeltas.set(
        index,
        /^(?:data:|https?:\/\/)/.test(value) ? value : prior + value,
      );
    }
    if (data?.choices?.[0]?.finish_reason === "stop") return true;
    return [
      "response.completed",
      "image_generation.completed",
      "image_edit.completed",
    ].includes(data?.type);
  };
  const decoder = new TextDecoder();
  let buffer = "",
    complete = false,
    format: "json" | "sse" | undefined;
  for await (const bytes of imageBodyChunks(response, undefined, options)) {
    buffer += decoder.decode(bytes, { stream: true });
    if (!format) {
      const start = buffer.trimStart();
      // Relays sometimes label SSE as JSON/plain text. Wait for split field prefixes.
      if (/^(?:data:|event:|id:|retry:|:)/.test(start)) format = "sse";
      else if (
        !start ||
        ["data:", "event:", "id:", "retry:"].some((p) => p.startsWith(start))
      )
        continue;
      else format = "json";
      buffer = start;
      await options.onFormat?.(format);
    }
    if (format === "json") continue;
    let separator: RegExpExecArray | null;
    while ((separator = /\r?\n\r?\n|\r\r/.exec(buffer))) {
      const block = buffer.slice(0, separator.index);
      buffer = buffer.slice(separator.index + separator[0].length);
      if (event(block)) {
        complete = true;
        break;
      }
    }
    if (complete) break;
  }
  if (!complete) {
    buffer += decoder.decode();
    if (format === "sse" && buffer.trim()) event(buffer);
  }
  if (format !== "sse") {
    let data: any;
    try {
      data = JSON.parse(buffer);
    } catch {
      throw Error("生图接口未返回可读取的 JSON 或 SSE，请核对协议");
    }
    if (Array.isArray(data)) data.forEach(providerFailure);
    else providerFailure(data);
    return { data, image: extractImageResult(data, resultPath) };
  }
  if (!last) throw Error("生图服务返回了空流式响应");
  result ||= extractImageResult({
    choices: [
      {
        message: {
          content,
          images: [...imageDeltas.values()].map((url) => ({ url })),
        },
      },
    ],
  });
  return { data: last, image: result };
}
