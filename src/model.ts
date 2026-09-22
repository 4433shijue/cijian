import type { Profile, ModelResult, PromptKind, ModelUsage, PromptMessage } from "./types";
import { samplingParameters } from "./sampling";
import { outputSchemas, novelTheaterSchema } from "./output";
export interface GenerationOptions {
  kind?: PromptKind;
  theater?: boolean;
  stablePrefix?: string;
  messages?: PromptMessage[];
}
function nativeSchema(p: Profile) {
  const host = new URL(p.url).hostname;
  if (p.protocol === "chat" || p.protocol === "responses")
    return (
      host === "api.openai.com" &&
      /^(?:gpt-(?:4o(?:$|-mini|-(?:2024-08|2024-11))|4\.1|5(?:[.-]|$))|o[34](?:-|$))/.test(
        p.model,
      )
    );
  if (p.protocol === "claude")
    return (
      host === "api.anthropic.com" &&
      /^claude-(?:opus|sonnet|haiku)-(?:4-[567]|5)(?:-|$)/.test(p.model)
    );
  return (
    host === "generativelanguage.googleapis.com" &&
    /^(?:models\/)?gemini-(?:2\.5|3[.-])/.test(p.model)
  );
}
export function endpoint(p: Profile, stream = p.stream) {
  let url = new URL(p.url);
  if (!["https:", "http:"].includes(url.protocol))
    throw Error("接口地址必须使用 http 或 https");
  let path = url.pathname.replace(/\/+$/, "");
  if (p.protocol === "gemini") {
    if (
      /:((stream)?GenerateContent|generateContent|streamGenerateContent)$/.test(
        path,
      )
    )
      path = path.replace(
        /:[^:]+$/,
        stream ? ":streamGenerateContent" : ":generateContent",
      );
    else
      path +=
        (/\/v1(beta)?$/.test(path) ? "" : "/v1beta") +
        "/models/" +
        encodeURIComponent(p.model.replace(/^models\//, "")) +
        (stream ? ":streamGenerateContent" : ":generateContent");
    if (stream) url.searchParams.set("alt", "sse");
    else url.searchParams.delete("alt");
  } else {
    const suffix =
      p.protocol === "chat"
        ? "/chat/completions"
        : p.protocol === "responses"
          ? "/responses"
          : "/messages";
    if (!path.endsWith(suffix))
      path += (/\/v\d+(beta)?$/.test(path) ? "" : "/v1") + suffix;
  }
  url.pathname = path;
  return url.toString();
}
export function requestSpec(
  p: Profile,
  key: string,
  system: string,
  user: string,
  options: GenerationOptions = {},
) {
  const { temperature, frequencyPenalty } = samplingParameters(p);
  const sampling = temperature === undefined ? {} : { temperature };
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  let body: Record<string, unknown>;
  if (p.protocol === "gemini") {
    headers["x-goog-api-key"] = key;
    body = {
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: "user", parts: [{ text: user }] }],
      generationConfig: {
        maxOutputTokens: p.maxOutput,
        ...sampling,
        ...(frequencyPenalty === undefined ? {} : { frequencyPenalty }),
      },
    };
  } else if (p.protocol === "claude") {
    headers["x-api-key"] = key;
    headers["anthropic-version"] = "2023-06-01";
    headers["anthropic-dangerous-direct-browser-access"] = "true";
    body = {
      model: p.model,
      system,
      messages: [{ role: "user", content: user }],
      max_tokens: p.maxOutput,
      stream: p.stream,
      ...sampling,
    };
  } else {
    headers.Authorization = "Bearer " + key;
    body =
      p.protocol === "chat"
        ? {
            model: p.model,
            messages: options.messages || [
              { role: "system", content: system },
              { role: "user", content: user },
            ],
            max_tokens: p.maxOutput,
            stream: p.stream,
            ...sampling,
            ...(frequencyPenalty === undefined
              ? {}
              : { frequency_penalty: frequencyPenalty }),
          }
        : {
            model: p.model,
            instructions: system,
            input: user,
            max_output_tokens: p.maxOutput,
            stream: p.stream,
            ...sampling,
          };
  }
  const mode = p.outputMode || "auto";
  if (options.kind && mode !== "compatible") {
    const schemaMode =
      mode === "schema" || (mode === "auto" && nativeSchema(p));
    const schema = options.kind === "novel" && options.theater ? novelTheaterSchema : outputSchemas[options.kind];
    const format = schemaMode
      ? {
          type: "json_schema",
          name: "cijian_" + options.kind,
          strict: true,
          schema,
        }
      : mode === "json"
        ? { type: "json_object" }
        : undefined;
    if (format) {
      if (p.protocol === "chat")
        body.response_format = schemaMode
          ? {
              type: "json_schema",
              json_schema: { name: format.name, strict: true, schema },
            }
          : format;
      else if (p.protocol === "responses") body.text = { format };
      else if (p.protocol === "claude") {
        if (!schemaMode)
          throw Error(
            "Claude 协议不支持 JSON 模式，请选择自动、严格结构或兼容模式。",
          );
        body.output_config = { format: { type: "json_schema", schema } };
      } else
        body.generationConfig = {
          ...(body.generationConfig as object),
          responseMimeType: "application/json",
          ...(schemaMode ? { responseJsonSchema: schema } : {}),
        };
    }
  }
  const prefix = options.stablePrefix;
  if (
    p.cachePolicy !== "off" &&
    prefix &&
    user.startsWith(prefix) &&
    prefix.length < user.length
  ) {
    if (p.protocol === "claude")
      body.messages = [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: prefix,
              cache_control: { type: "ephemeral" },
            },
            { type: "text", text: user.slice(prefix.length) },
          ],
        },
      ];
    if (
      p.protocol === "responses" &&
      new URL(p.url).hostname === "api.openai.com" &&
      /^gpt-5\.6(?:-|$)/.test(p.model)
    ) {
      body.prompt_cache_options = { mode: "explicit" };
      body.input = [
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: prefix,
              prompt_cache_breakpoint: { mode: "explicit" },
            },
            { type: "input_text", text: user.slice(prefix.length) },
          ],
        },
      ];
    }
  }
  if (
    p.protocol === "chat" &&
    p.stream &&
    ["api.openai.com", "api.deepseek.com"].includes(new URL(p.url).hostname)
  )
    body.stream_options = { include_usage: true };
  return { url: endpoint(p), headers, body };
}
export async function* sse(response: Response) {
  if (!response.body) throw Error("服务没有返回响应流");
  const reader = response.body.getReader(),
    decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      let match: RegExpExecArray | null;
      while ((match = /\r?\n\r?\n/.exec(buffer))) {
        const block = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        const data = block
          .split(/\r?\n/)
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).trimStart())
          .join("\n");
        if (data) yield data;
      }
      if (done) {
        if (buffer.trim()) {
          const data = buffer
            .split(/\r?\n/)
            .filter((l) => l.startsWith("data:"))
            .map((l) => l.slice(5).trimStart())
            .join("\n");
          if (data) yield data;
        }
        break;
      }
    }
  } finally {
    reader.releaseLock();
  }
}
function errorMessage(e: any) {
  return e?.error?.message || e?.message || "服务返回未知错误";
}
export async function generate(
  p: Profile,
  key: string,
  system: string,
  user: string,
  signal: AbortSignal,
  onDelta: (s: string) => void = () => {},
  fetcher: typeof fetch = fetch,
  options: GenerationOptions = {},
): Promise<ModelResult> {
  const started = Date.now();
  if (!key.trim()) throw Error("请先在设置中填写 API Key");
  if (!p.model.trim()) throw Error("请填写模型名称");
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) controller.abort();
  let timeout = false;
  const timer = setTimeout(() => {
    timeout = true;
    controller.abort();
  }, p.timeout * 1000);
  let text = "",
    reason = "",
    complete = false,
    usage: ModelResult["usage"];
  try {
    const spec = requestSpec(p, key, system, user, options);
    const r = await fetcher(spec.url, {
      method: "POST",
      headers: spec.headers,
      body: JSON.stringify(spec.body),
      signal: controller.signal,
    });
    if (!r.ok) {
      let detail = "";
      try {
        detail = errorMessage(await r.json());
      } catch {
        detail = r.statusText;
      }
      if ([400, 422].includes(r.status)) {
        if (/cache_control|prompt_cache|breakpoint/i.test(detail))
          throw Error(
            "接口不接受显式缓存参数。请在 API 设置中关闭显式缓存标记，再手动重试。",
          );
        if (
          /response_format|json_schema|responseJsonSchema|responseMimeType|output_config|text\.format|structured.output/i.test(
            detail,
          )
        )
          throw Error(
            "接口不接受这个输出格式。请在 API 设置中将输出格式设为兼容模式，再手动重试。",
          );
        if (/temperature|温度/i.test(detail))
          throw Error(
            "模型没有接受这个温度值。请在 API 设置中调整温度，或清空以使用模型默认值。",
          );
        if (/frequency.?penalty|repetition.?penalty|重复惩罚/i.test(detail))
          throw Error(
            "模型没有接受这个重复惩罚值。请在 API 设置中调低重复惩罚，或清空以使用模型默认值。",
          );
      }
      throw Error(`接口 ${r.status} · ${detail}`);
    }
    const add = (s: string) => {
      if (typeof s === "string" && s) {
        text += s;
        onDelta(text);
      }
    };
    const mergeUsage = (next: ModelUsage) => {
      const valid = Object.fromEntries(
        Object.entries(next).filter(
          ([, v]) => typeof v === "number" && Number.isFinite(v) && v >= 0,
        ),
      );
      if (Object.keys(valid).length) usage = { ...usage, ...valid };
    };
    let claudeInput: number | undefined;
    const consume = (d: any, stream: boolean) => {
      if (!d || typeof d !== "object")
        throw Error("接口返回了无法读取的响应格式，已保留收到的内容。");
      if (d.error || d.type === "error") throw Error(errorMessage(d));
      if (p.protocol === "chat") {
        const c = d.choices?.[0];
        add(stream ? c?.delta?.content || "" : c?.message?.content || "");
        if (c?.finish_reason) {
          reason = c.finish_reason;
          complete = reason === "stop";
        }
        if (d.usage) {
          const hit = d.usage.prompt_cache_hit_tokens;
          const miss = d.usage.prompt_cache_miss_tokens;
          const hasCounts = [hit, miss].every((n) => typeof n === "number" && Number.isFinite(n) && n >= 0);
          mergeUsage({
            input: d.usage.prompt_tokens ?? (hasCounts ? hit + miss : undefined),
            output: d.usage.completion_tokens,
            cachedInput:
              hit ?? d.usage.prompt_tokens_details?.cached_tokens,
            uncachedInput: miss,
            cacheWriteInput: d.usage.prompt_tokens_details?.cache_write_tokens,
          });
        }
      }
      if (p.protocol === "responses") {
        if (stream && d.type === "response.output_text.delta")
          add(d.delta || "");
        if (!stream) {
          add(
            (d.output || [])
              .flatMap((x: any) => x.content || [])
              .filter((x: any) => x.type === "output_text")
              .map((x: any) => x.text)
              .join(""),
          );
          reason = d.status;
          complete = reason === "completed";
        }
        if (d.type === "response.completed") {
          reason = "completed";
          complete = true;
        }
        if (d.type === "response.incomplete" || d.type === "response.failed") {
          reason = d.type;
          complete = false;
        }
        const u = (d.response || d).usage;
        if (u)
          mergeUsage({
            input: u.input_tokens,
            output: u.output_tokens,
            cachedInput: u.input_tokens_details?.cached_tokens,
            cacheWriteInput: u.input_tokens_details?.cache_write_tokens,
          });
      }
      if (p.protocol === "claude") {
        if (
          stream &&
          d.type === "content_block_delta" &&
          d.delta?.type === "text_delta"
        )
          add(d.delta.text);
        if (!stream)
          add(
            (d.content || [])
              .filter((x: any) => x.type === "text")
              .map((x: any) => x.text)
              .join(""),
          );
        const stop = d.stop_reason || d.delta?.stop_reason;
        if (stop) {
          reason = stop;
          complete = ["end_turn", "stop_sequence"].includes(stop);
        }
        const u = d.usage || d.message?.usage;
        if (u) {
          if (
            typeof u.input_tokens === "number" &&
            Number.isFinite(u.input_tokens) &&
            u.input_tokens >= 0
          )
            claudeInput = u.input_tokens;
          mergeUsage({
            output: u.output_tokens,
            cachedInput: u.cache_read_input_tokens,
            cacheWriteInput: u.cache_creation_input_tokens,
          });
          if (claudeInput !== undefined)
            mergeUsage({
              input:
                claudeInput +
                (usage?.cachedInput || 0) +
                (usage?.cacheWriteInput || 0),
            });
        }
      }
      if (p.protocol === "gemini") {
        const c = d.candidates?.[0];
        add(
          (c?.content?.parts || [])
            .filter((x: any) => !x.thought)
            .map((x: any) => x.text || "")
            .join(""),
        );
        if (c?.finishReason) {
          reason = c.finishReason;
          complete = reason === "STOP";
        }
        if (d.usageMetadata)
          mergeUsage({
            input: d.usageMetadata.promptTokenCount,
            output: d.usageMetadata.candidatesTokenCount,
            cachedInput: d.usageMetadata.cachedContentTokenCount,
          });
        if (d.promptFeedback?.blockReason)
          throw Error("服务拦截了请求 · " + d.promptFeedback.blockReason);
      }
    };
    if (r.headers.get("content-type")?.includes("text/event-stream")) {
      for await (const data of sse(r)) {
        if (data === "[DONE]") continue;
        let obj;
        try {
          obj = JSON.parse(data);
        } catch {
          throw Error("流式数据格式不完整，已保留收到的内容");
        }
        consume(obj, true);
      }
    } else {
      let data;
      const raw = await r.text();
      try {
        data = JSON.parse(raw);
      } catch {
        add(raw);
        throw Error(
          "接口返回了无法读取的响应格式，请检查接口地址和协议。已保留收到的内容。",
        );
      }
      consume(data, false);
    }
    return {
      text,
      complete: complete && !!text.trim(),
      reason: reason || "连接结束但未收到完成标记",
      usage,
      durationMs: Date.now() - started,
    };
  } catch (e) {
    if (controller.signal.aborted)
      throw Error(
        timeout
          ? "请求超时，收到的内容已保留为草稿"
          : "已停止，收到的内容已保留为草稿",
      );
    if (e instanceof TypeError)
      throw Error(
        "无法连接接口。请检查地址、网络与服务的浏览器跨域（CORS）支持。",
      );
    throw e;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
  }
}
export async function modelList(p: Profile, key: string) {
  const url = new URL(endpoint(p, false));
  url.search = "";
  const headers: Record<string, string> = {};
  if (p.protocol === "gemini") {
    url.pathname = url.pathname.replace(/\/models\/[^/]+$/, "/models");
    headers["x-goog-api-key"] = key;
  } else {
    url.pathname = url.pathname.replace(
      /\/(chat\/completions|responses|messages)$/,
      "/models",
    );
    if (p.protocol === "claude") {
      headers["x-api-key"] = key;
      headers["anthropic-version"] = "2023-06-01";
      headers["anthropic-dangerous-direct-browser-access"] = "true";
    } else headers.Authorization = "Bearer " + key;
  }
  const r = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
  if (!r.ok)
    throw Error(`接口 ${r.status} · 无法获取模型列表，可以直接手填模型名`);
  const data = await r.json();
  const entries = Array.isArray(data) ? data : data?.data || data?.models;
  if (!Array.isArray(entries)) return [];
  return [
    ...new Set(
      entries.flatMap((entry: any) => {
        const value =
          typeof entry === "string"
            ? entry
            : entry?.id ||
              (typeof entry?.name === "string"
                ? entry.name.replace(/^models\//, "")
                : "");
        if (typeof value !== "string") return [];
        const id = value.trim();
        return id ? [id] : [];
      }),
    ),
  ];
}
