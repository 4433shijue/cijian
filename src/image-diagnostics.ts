import { z } from "zod";

// Deliberately allow only counters/enums: no keys, prompts, response bodies or signed URLs.
export const imageDiagnosticSchema = z.object({
  operation: z.enum(["generate", "download"]).default("generate"),
  stage: z.enum([
    "requesting",
    "receiving",
    "polling",
    "downloading",
    "processing",
    "complete",
  ]),
  outcome: z.enum(["running", "success", "failed", "timeout", "stopped"]),
  startedAt: z.number(),
  updatedAt: z.number(),
  stageStartedAt: z.number(),
  responseMs: z.number().nonnegative().optional(),
  httpStatus: z.number().int().optional(),
  responseType: z.enum(["json", "sse", "image", "other"]).optional(),
  responseBytes: z.number().nonnegative(),
  responseLastByteAt: z.number().nonnegative().optional(),
  jsonState: z.enum(["incomplete", "complete", "invalid"]).optional(),
  downloadBytes: z.number().nonnegative(),
  downloadStatus: z.number().int().optional(),
  resultKind: z.enum(["url", "base64", "binary"]).optional(),
  polls: z.number().int().nonnegative(),
});
export type ImageDiagnostic = z.infer<typeof imageDiagnosticSchema>;
export type ImageProgress = (
  diagnostic: ImageDiagnostic,
) => void | Promise<void>;
export const imageStageLabels: Record<ImageDiagnostic["stage"], string> = {
  requesting: "等待接口响应",
  receiving: "接收生图结果",
  polling: "等待图片任务完成",
  downloading: "下载图片",
  processing: "处理图片",
  complete: "图片已接收",
};
export function imageReporter(onProgress?: ImageProgress) {
  const now = Date.now();
  let value: ImageDiagnostic = {
      operation: "generate",
      stage: "requesting",
      outcome: "running",
      startedAt: now,
      updatedAt: now,
      stageStartedAt: now,
      responseBytes: 0,
      downloadBytes: 0,
      polls: 0,
    },
    lastSent = 0;
  return {
    get value() {
      return value;
    },
    async update(patch: Partial<ImageDiagnostic>, throttle = false) {
      const now = Date.now();
      value = {
        ...value,
        ...patch,
        updatedAt: now,
        stageStartedAt:
          patch.stage && patch.stage !== value.stage
            ? now
            : value.stageStartedAt,
      };
      if (throttle && now - lastSent < 1000) return;
      lastSent = now;
      await onProgress?.({ ...value });
    },
  };
}
export function imageResponseType(
  response: Response,
): ImageDiagnostic["responseType"] {
  const type = (response.headers.get("content-type") || "").toLowerCase();
  return type.includes("text/event-stream")
    ? "sse"
    : type.startsWith("image/")
      ? "image"
      : type.includes("json")
        ? "json"
        : "other";
}
export function imageDiagnosticText(d: ImageDiagnostic) {
  const type = {
    json: "JSON（非流式）",
    sse: "SSE（流式）",
    image: "图片文件",
    other: "其他／未声明",
  };
  const outcome = {
    running: "进行中",
    success: "完成",
    failed: "失败",
    timeout: "超时",
    stopped: "已停止",
  };
  return [
    `本次操作：${d.operation === "download" ? "重新下载，没有重新生图" : "生成图片"}`,
    `阶段：${imageStageLabels[d.stage]}（${outcome[d.outcome]}）`,
    `总耗时：${((d.updatedAt - d.startedAt) / 1000).toFixed(1)} 秒`,
    `接口响应：${d.httpStatus === undefined ? "尚未收到响应头" : `HTTP ${d.httpStatus}`}`,
    ...(d.responseMs === undefined
      ? []
      : [`收到响应头：${(d.responseMs / 1000).toFixed(1)} 秒`]),
    `返回类型：${d.responseType ? type[d.responseType] : "未知"}`,
    `已接收结果：${d.responseBytes} 字节`,
    ...(d.responseLastByteAt === undefined
      ? []
      : [
          `距最后收到数据：${(Math.max(0, d.updatedAt - d.responseLastByteAt) / 1000).toFixed(1)} 秒`,
        ]),
    ...(d.jsonState === undefined
      ? []
      : [
          `JSON 完整性：${d.jsonState === "complete" ? "已收完整并通过格式校验" : d.jsonState === "invalid" ? "格式无效" : "尚未收完整"}`,
        ]),
    `图片结果：${d.resultKind === "url" ? "图片地址" : d.resultKind === "base64" ? "Base64" : d.resultKind === "binary" ? "图片文件" : "尚未解析出图片"}`,
    `图片下载：${d.downloadStatus === undefined ? "尚未收到下载响应" : `HTTP ${d.downloadStatus}`}；${d.downloadBytes} 字节`,
    `任务查询次数：${d.polls}`,
  ].join("\n");
}

export function imageDeadline(parent: AbortSignal, ms: number) {
  const control = new AbortController();
  const timer = setTimeout(
    () =>
      control.abort(new DOMException("Image phase timed out", "TimeoutError")),
    ms,
  );
  return {
    signal: AbortSignal.any([parent, control.signal]),
    stop: () => clearTimeout(timer),
    get expired() {
      return control.signal.aborted;
    },
  };
}
export function imageAbortable<T>(
  work: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!signal) return work;
  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    work
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
}
