import { useEffect, useRef, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { db, keyFor } from "./db";
import { uid } from "./types";
import {
  imageConnectionSchema,
  imageProfileSchema,
  type ImageProfile,
} from "./image-types";
import { imageKey, saveImageProfile } from "./image-generation";
import { requestImage, referenceFile } from "./image-provider";
import {
  fetchImageModels,
  imageModelsEndpoint,
  imageProtocols,
  resolveImageEndpoint,
  resolvedImageProtocol,
  type ImageModelOption,
} from "./image-connection";
import { validateImageConnection } from "./image-protocol";

export function ImageConnectionSettings() {
  const state = useLiveQuery(async () => {
    const prefs = await db.preferences.get("preferences");
    return {
      profile: prefs?.activeImageProfile
        ? await db.imageProfiles.get(prefs.activeImageProfile)
        : undefined,
    };
  }, []);
  return state ? (
    <ImageConnectionForm
      key={state.profile?.id || "new"}
      value={state.profile}
    />
  ) : null;
}
function ImageConnectionForm({ value }: { value?: ImageProfile }) {
  const [profile, setProfile] = useState<ImageProfile>(() =>
    imageProfileSchema.parse(
      value || {
        id: uid(),
        name: "我的生图接口",
        url: "",
        model: "",
        protocol: "auto",
        size: "",
      },
    ),
  );
  const [key, setKey] = useState(() => (value ? imageKey(value) : ""));
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState("");
  const [models, setModels] = useState<ImageModelOption[]>([]);
  const [manual, setManual] = useState(true);
  const [search, setSearch] = useState("");
  const [imageOnly, setImageOnly] = useState(false);
  const [preview, setPreview] = useState("");
  const [reference, setReference] = useState("");
  const [tested, setTested] = useState("");
  const [listed, setListed] = useState(false);
  const control = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      control.current?.abort();
    };
  }, []);
  const change = (patch: Partial<ImageProfile>) => {
    if (
      ["url", "protocol", "modelsUrl", "auth", "endpointMode"].some(
        (k) => k in patch,
      )
    ) {
      control.current?.abort();
      setModels([]);
      setManual(true);
      setListed(false);
      setSearch("");
    }
    setProfile((p) => ({ ...p, ...patch }));
    setMessage("");
    setTested("");
    setPreview("");
  };
  let connectionId = "";
  const normalized = imageConnectionSchema.safeParse(profile);
  if (normalized.success) connectionId = JSON.stringify(normalized.data);
  const visibleModels = models.filter(
    (m) =>
      (!imageOnly || m.outputImage === true) &&
      `${m.id} ${m.name}`.toLowerCase().includes(search.toLowerCase()),
  );
  let endpoint = "",
    modelsEndpoint = "",
    protocol = profile.protocol === "auto" ? "images" : profile.protocol;
  try {
    protocol = resolvedImageProtocol(profile);
    endpoint = resolveImageEndpoint(
      profile,
      !!reference && profile.references !== "off",
    );
    try {
      modelsEndpoint = imageModelsEndpoint(profile);
    } catch {
      /* Optional for providers without discovery. */
    }
  } catch (e) {
    endpoint = profile.url ? (e as Error).message : "填写地址后显示";
  }
  const task = async (
    kind: string,
    run: (signal: AbortSignal) => Promise<void>,
  ) => {
    if (control.current) return;
    const controller = new AbortController();
    control.current = controller;
    setBusy(kind);
    setMessage("");
    try {
      await run(controller.signal);
    } catch (e) {
      if (mounted.current)
        setMessage(e instanceof Error ? e.message : "连接操作未完成");
    } finally {
      if (control.current === controller) control.current = null;
      if (mounted.current) setBusy("");
    }
  };
  const textField = (
    label: string,
    field: keyof ImageProfile,
    placeholder = "",
  ) => (
    <label className="field">
      {label}
      <input
        value={String(profile[field] ?? "")}
        onChange={(e) => change({ [field]: e.target.value })}
        placeholder={placeholder}
      />
    </label>
  );
  return (
    <section className="settings-card image-settings">
      <h2>图片生成</h2>
      <p className="hint">
        填写地址和密钥后拉取模型，也可手动填写。支持
        Images、聊天生图、Responses、Gemini
        和自定义接口。保存与拉取模型不会生成图片；所有配图禁止自拍。
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void task("save", async () => {
            validateImageConnection(profile);
            await saveImageProfile(
              imageProfileSchema.parse(profile),
              key.trim(),
            );
            if (mounted.current)
              setMessage("生图配置已保存。请到作品设置选择自动配图方式。");
          });
        }}
      >
        <fieldset disabled={!!busy}>
          <label className="field">
            生图接口地址
            <input
              required
              type="url"
              value={profile.url}
              onChange={(e) => change({ url: e.target.value })}
              placeholder="https://你的服务/v1 或完整端点"
            />
          </label>
          <label className="field">
            生图 API Key
            <input
              type="password"
              autoComplete="off"
              value={key}
              onChange={(e) => {
                control.current?.abort();
                setKey(e.target.value);
                setModels([]);
                setManual(true);
                setListed(false);
                setMessage("");
                setTested("");
                setPreview("");
              }}
            />
          </label>
          <div className="row image-connection-actions">
            <button
              type="button"
              disabled={!profile.url || (!key && profile.auth !== "none")}
              onClick={() =>
                void task("models", async (signal) => {
                  setListed(false);
                  setModels([]);
                  setManual(true);
                  const entries = await fetchImageModels(profile, key, signal);
                  if (!mounted.current || signal.aborted) return;
                  setModels(entries);
                  setManual(entries.length === 0);
                  setSearch("");
                  setImageOnly(false);
                  setListed(true);
                  setMessage(
                    entries.length
                      ? `已拉取 ${entries.length} 个模型，请选择。列表可读取不代表模型一定能生图。`
                      : "服务返回空模型列表，可以手动填写模型名。",
                  );
                })
              }
            >
              {busy === "models" ? "正在拉取模型…" : "拉取生图模型"}
            </button>
            <button
              type="button"
              onClick={() =>
                void task("copy", async () => {
                  const prefs = await db.preferences.get("preferences"),
                    p = prefs && (await db.profiles.get(prefs.activeProfile));
                  if (!p) throw Error("请先配置文字接口");
                  if (!mounted.current) return;
                  change({
                    url: p.url,
                    protocol:
                      p.protocol === "gemini"
                        ? "gemini"
                        : p.protocol === "responses"
                          ? "responses"
                          : p.protocol === "chat"
                            ? "chat"
                            : "auto",
                    endpointMode: "auto",
                    modelsUrl: "",
                    auth: "auto",
                  });
                  setKey(keyFor(p));
                  setMessage(
                    "已带入地址与密钥，请拉取并选择支持生图的模型，再保存。",
                  );
                })
              }
            >
              带入当前文字接口的地址与密钥
            </button>
          </div>
          {!manual && (
            <>
              <label className="field">
                搜索生图模型
                <input
                  type="search"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="搜索名称或模型 ID"
                />
              </label>
              <label className="check">
                <input
                  type="checkbox"
                  checked={imageOnly}
                  onChange={(e) => setImageOnly(e.target.checked)}
                />
                仅显示服务明确标注支持生图的模型
              </label>
            </>
          )}
          <label className="field">
            生图模型
            {manual ? (
              <input
                required
                value={profile.model}
                onChange={(e) => change({ model: e.target.value })}
                placeholder="也可先拉取模型，再从列表选择"
              />
            ) : (
              <select
                aria-label="生图模型"
                required
                value={profile.model}
                onChange={(e) => change({ model: e.target.value })}
              >
                <option value="">请选择模型</option>
                {profile.model &&
                  !visibleModels.some((m) => m.id === profile.model) && (
                    <option value={profile.model}>
                      {profile.model} · 当前选择
                    </option>
                  )}
                {visibleModels.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.id}
                    {m.name !== m.id ? ` · ${m.name}` : ""}
                    {m.outputImage === true
                      ? " · 支持生图"
                      : m.outputImage === false
                        ? " · 未标注图片输出"
                        : " · 能力待验证"}
                    {m.inputImage === true ? " · 支持图片输入" : ""}
                  </option>
                ))}
              </select>
            )}
          </label>
          {models.length > 0 && (
            <button
              type="button"
              className="text-action"
              onClick={() => setManual((v) => !v)}
            >
              {manual ? "从列表选择模型" : "手动填写模型名"}
            </button>
          )}
          {!manual && !visibleModels.length && (
            <p className="hint">
              没有匹配项，可以清除搜索或关闭生图筛选；未提供能力信息的模型仍可手动选择。
            </p>
          )}
          <label className="field">
            生图协议
            <select
              aria-label="生图协议"
              value={profile.protocol}
              onChange={(e) =>
                change({ protocol: e.target.value as ImageProfile["protocol"] })
              }
            >
              {Object.entries(imageProtocols).map(([id, name]) => (
                <option key={id} value={id}>
                  {name}
                </option>
              ))}
            </select>
          </label>
          <p className="hint image-endpoint">
            {profile.protocol === "auto" &&
              `识别为 ${imageProtocols[protocol]}。`}
            实际请求地址：<code>{endpoint}</code>
          </p>
          {protocol === "responses" && (
            <>
              <p className="hint">
                上方选择能调用生图工具的主模型；工具使用的图片模型可在下方单独填写，留空遵循服务默认。
              </p>
              {textField(
                "Responses 图片工具模型",
                "toolModel",
                "可选，填写服务支持的图片模型 ID",
              )}
            </>
          )}
          <div className="image-settings-grid">
            {(protocol === "images" ||
              protocol === "responses" ||
              protocol === "custom") && (
              <label className="field">
                图片尺寸
                <select
                  aria-label="图片尺寸"
                  value={profile.size}
                  onChange={(e) => change({ size: e.target.value })}
                >
                  <option value="">服务默认</option>
                  {[
                    "1024x1024",
                    "1536x1024",
                    "1024x1536",
                    "1792x1024",
                    "1024x1792",
                  ].map((v) => (
                    <option key={v}>{v}</option>
                  ))}
                </select>
              </label>
            )}
            {(protocol === "images" ||
              protocol === "responses" ||
              protocol === "openrouter" ||
              protocol === "custom") && (
              <label className="field">
                图片质量
                <select
                  aria-label="图片质量"
                  value={profile.quality}
                  onChange={(e) => change({ quality: e.target.value })}
                >
                  <option value="">服务默认</option>
                  {[
                    "auto",
                    "low",
                    "medium",
                    "high",
                    "xhigh",
                    "max",
                    "standard",
                    "hd",
                  ].map((v) => (
                    <option key={v}>{v}</option>
                  ))}
                </select>
              </label>
            )}
            {["chat", "gemini", "openrouter", "custom"].includes(protocol) && (
              <>
                <label className="field">
                  图片比例
                  <select
                    aria-label="图片比例"
                    value={profile.aspectRatio}
                    onChange={(e) => change({ aspectRatio: e.target.value })}
                  >
                    <option value="">服务默认</option>
                    {["1:1", "4:3", "3:4", "16:9", "9:16", "3:2", "2:3"].map(
                      (v) => (
                        <option key={v}>{v}</option>
                      ),
                    )}
                  </select>
                </label>
                <label className="field">
                  图片分辨率
                  <select
                    aria-label="图片分辨率"
                    value={profile.resolution}
                    onChange={(e) => change({ resolution: e.target.value })}
                  >
                    <option value="">服务默认</option>
                    {["1K", "2K", "4K"].map((v) => (
                      <option key={v}>{v}</option>
                    ))}
                  </select>
                </label>
              </>
            )}
          </div>
          <details>
            <summary>接口兼容设置</summary>
            <label className="field">
              地址类型
              <select
                aria-label="地址类型"
                value={profile.endpointMode}
                onChange={(e) =>
                  change({
                    endpointMode: e.target
                      .value as ImageProfile["endpointMode"],
                  })
                }
              >
                <option value="auto">
                  自动 · 根地址和版本路径视为基础地址
                </option>
                <option value="base">基础地址 · 按协议追加路径</option>
                <option value="full">完整端点 · 保留原路径</option>
              </select>
            </label>
            {textField(
              "模型列表地址（可选）",
              "modelsUrl",
              "同站点的完整地址或 /v1/models",
            )}
            {modelsEndpoint && (
              <p className="hint image-endpoint">
                列表请求地址：<code>{modelsEndpoint}</code>
              </p>
            )}
            <label className="field">
              生图鉴权方式
              <select
                aria-label="生图鉴权方式"
                value={profile.auth}
                onChange={(e) =>
                  change({ auth: e.target.value as ImageProfile["auth"] })
                }
              >
                <option value="auto">随协议自动选择</option>
                <option value="bearer">Authorization · Bearer</option>
                <option value="x-api-key">x-api-key</option>
                <option value="x-goog-api-key">x-goog-api-key</option>
                <option value="none">无需密钥</option>
              </select>
            </label>
            <label className="field">
              人物参考图
              <select
                aria-label="人物参考图"
                value={profile.references}
                onChange={(e) =>
                  change({
                    references: e.target.value as ImageProfile["references"],
                  })
                }
              >
                <option value="off">仅使用外貌文字</option>
                <option value="auto">启用 · 根据协议发送参考图</option>
                <option value="multipart">Images · multipart 编辑接口</option>
                <option value="json">Images · JSON 编辑接口</option>
              </select>
            </label>
            <p className="hint">
              参考图只用于正文人物插画，手机照片不发送人物参考图。固定 edits
              端点需要图片输入；只有基础地址会按是否携带参考图选择 generations
              或 edits。
            </p>
            {protocol === "images" && (
              <label className="field">
                图片返回格式
                <select
                  aria-label="图片返回格式"
                  value={profile.responseFormat}
                  onChange={(e) =>
                    change({
                      responseFormat: e.target
                        .value as ImageProfile["responseFormat"],
                    })
                  }
                >
                  <option value="">服务默认</option>
                  <option value="b64_json">Base64</option>
                  <option value="url">图片链接</option>
                </select>
              </label>
            )}
            <label className="check">
              <input
                type="checkbox"
                checked={profile.stream}
                onChange={(e) => change({ stream: e.target.checked })}
              />
              请求流式返回（服务需支持）
            </label>
            <label className="field">
              生图等待秒数
              <input
                type="number"
                min={10}
                max={600}
                value={profile.timeout}
                onChange={(e) => change({ timeout: Number(e.target.value) })}
              />
            </label>
            <label className="field">
              额外请求参数（JSON）
              <textarea
                aria-label="额外请求参数（JSON）"
                value={profile.extraBody}
                onChange={(e) => change({ extraBody: e.target.value })}
                placeholder={'例如 {"seed":123}，不要填密钥'}
                spellCheck={false}
              />
            </label>
            <p className="hint">
              只添加服务文档要求的参数；不会覆盖画面、模型、参考图和张数。聊天接口的特殊参数可在这里配置。
            </p>
            {textField(
              "图片结果字段路径（可选）",
              "resultPath",
              "自动读取常见格式，或填写 data.0.url",
            )}
            {protocol === "custom" && (
              <div className="image-custom-settings">
                <label className="field">
                  自定义请求模板（JSON）
                  <textarea
                    aria-label="自定义请求模板（JSON）"
                    value={profile.requestTemplate}
                    onChange={(e) =>
                      change({ requestTemplate: e.target.value })
                    }
                    rows={5}
                    spellCheck={false}
                  />
                </label>
                <p className="hint">
                  支持{" "}
                  {
                    "{{model}}、{{prompt}}、{{references}}、{{size}}、{{quality}}、{{aspectRatio}}、{{resolution}}、{{stream}}"
                  }
                  。必须传入画面 prompt；references
                  是数据地址数组，占位符须单独作为字段值。此处不支持执行脚本。
                </p>
                {textField(
                  "任务查询地址（可选）",
                  "pollUrl",
                  "/tasks/{id} · 留空为同步返回",
                )}
                {profile.pollUrl && (
                  <>
                    {textField("任务编号字段", "taskIdPath", "data.id")}
                    {textField("任务状态字段", "statusPath", "status")}
                    {textField("任务成功状态", "successStates")}
                    {textField("任务失败状态", "failureStates")}
                    <label className="field">
                      查询间隔秒数
                      <input
                        type="number"
                        min={2}
                        max={30}
                        value={profile.pollInterval}
                        onChange={(e) =>
                          change({ pollInterval: Number(e.target.value) })
                        }
                      />
                    </label>
                    <p className="hint">
                      提交一次 POST，然后向同站点查询地址发送
                      GET；以逗号分隔状态。停止或刷新后不会自动重新提交，远端任务可能仍在执行。
                    </p>
                  </>
                )}
              </div>
            )}
            <p className="hint">
              网页直连需要接口和图片下载地址允许跨域访问。未知服务的私有格式需要按其文档配置，无法仅靠地址自动推断。
            </p>
          </details>
          {profile.verified.length > 0 && (
            <label className="field">
              恢复已测通组合（历史记录）
              <select
                aria-label="恢复已测通组合（历史记录）"
                value=""
                onChange={(e) => {
                  const entry = profile.verified[Number(e.target.value)];
                  if (!entry || e.target.value === "") return;
                  change(entry.connection);
                  setReference("");
                  setMessage(
                    "已恢复历史测试组合。当前密钥、服务状态与参考图能力仍需单独验证，请保存后使用。",
                  );
                }}
              >
                <option value="">选择一个历史组合</option>
                {profile.verified.map((entry, i) => (
                  <option key={i} value={i}>
                    {entry.connection.model} ·{" "}
                    {imageProtocols[entry.connection.protocol]} ·{" "}
                    {new Date(entry.testedAt).toLocaleString()}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className="check">
            <input
              type="checkbox"
              checked={profile.remember}
              onChange={(e) => change({ remember: e.target.checked })}
            />
            在此设备记住生图密钥
          </label>
          <p className="hint">
            未勾选时密钥只保留在当前页面；备份与阅读页不包含独立密钥字段。自定义参数、接口地址和历史组合会进入完整备份，请勿在这些字段粘贴秘密。
          </p>
          <details>
            <summary>测试参考图（可选）</summary>
            <label className="field">
              测试用参考图
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = "";
                  if (!file) return;
                  void task("reference", async () => {
                    const data = await referenceFile(file);
                    if (mounted.current) {
                      setReference(data);
                      setTested("");
                      setPreview("");
                    }
                  });
                }}
              />
            </label>
            <p className="hint">
              可上传物品或风景图验证图片编辑。只有启用参考图才会发送；测试图不会存入角色资料或备份。
            </p>
            {reference && (
              <>
                <img
                  className="image-reference-preview"
                  src={reference}
                  alt="测试参考图"
                />
                <button
                  type="button"
                  onClick={() => {
                    setReference("");
                    setTested("");
                  }}
                >
                  移除测试参考图
                </button>
              </>
            )}
          </details>
          <div className="image-connection-status" aria-live="polite">
            <span>模型列表：{listed ? "已读取" : "未验证"}</span>
            <span>
              当前生图：
              {tested && tested === connectionId ? "测试成功" : "未验证"}
            </span>
          </div>
          <div className="row">
            <button className="primary" type="submit">
              保存生图配置
            </button>
            <button
              type="button"
              disabled={
                !profile.url ||
                !profile.model ||
                (!key && profile.auth !== "none")
              }
              onClick={() =>
                void task("image", async (signal) => {
                  setMessage("正在生成测试图…");
                  setPreview("");
                  setTested("");
                  const connection = imageConnectionSchema.parse(profile);
                  const result = await requestImage(
                    profile,
                    key,
                    "一盆放在窗台上的绿植，柔和日光，无人物。若有参考图，保留物品的外观。",
                    reference ? [reference] : [],
                    signal,
                  );
                  if (!mounted.current || signal.aborted) return;
                  setPreview(result.data);
                  setTested(connectionId);
                  setProfile((p) => ({
                    ...p,
                    verified: [
                      { testedAt: Date.now(), connection },
                      ...p.verified.filter(
                        (v) => JSON.stringify(v.connection) !== connectionId,
                      ),
                    ].slice(0, 10),
                  }));
                  setMessage(
                    "测试图片已收到。点击保存，可保留配置与这次测通的组合。",
                  );
                })
              }
            >
              生成测试图（消耗一次额度）
            </button>
          </div>
        </fieldset>
      </form>
      {["models", "image"].includes(busy) && control.current && (
        <button onClick={() => control.current?.abort()}>
          {busy === "models" ? "停止拉取" : "停止测试"}
        </button>
      )}
      {message && (
        <p role="status" className="image-connection-message">
          {message}
        </p>
      )}
      {preview && (
        <img
          className="image-test-preview"
          src={preview}
          alt="生图接口测试结果：窗台绿植"
        />
      )}
    </section>
  );
}
