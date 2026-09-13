import { useEffect, useRef, useState } from "react";
import { Check, LoaderCircle, PlugZap, ChevronDown } from "lucide-react";
import { db, keyFor, saveProfile } from "./db";
import { generate, modelList } from "./model";
import { uid, type Profile } from "./types";

export function newProfile(): Profile {
  return {
    id: uid(),
    name: "我的接口",
    protocol: "chat",
    url: "",
    model: "",
    stream: true,
    context: 32000,
    maxOutput: 4096,
    timeout: 120,
    remember: false,
  };
}
export const protocols = {
  chat: "OpenAI 兼容 · Chat Completions",
  responses: "OpenAI 原生 · Responses",
  claude: "Claude 原生 · Messages",
  gemini: "Gemini 原生 · GenerateContent",
};
function connectionError(error: unknown) {
  const detail = error instanceof Error ? error.message : String(error);
  if (/401|403|unauthor|forbidden|鉴权|密钥/i.test(detail))
    return "密钥未通过验证。请检查 API Key 是否完整、是否有这个模型的使用权限。";
  if (/404|not found|模型不存在/i.test(detail))
    return "没有找到这个接口或模型。请核对接口地址、模型名和「高级设置」中的协议。";
  if (/429|quota|余额|额度/i.test(detail))
    return "服务暂时限流或额度不足。请到服务提供方检查额度，稍后再试。";
  if (/timeout|timed out|超时|abort/i.test(detail))
    return "连接等待超时。请检查网络，或在「高级设置」中延长等待时间。";
  if (/fetch|network|cors|网络|跨域/i.test(detail))
    return "浏览器没有连上服务。请检查地址和网络，并确认服务允许网页访问（CORS）。";
  return "连接还没有通过。请核对地址、密钥、模型名和所选协议后重试。";
}

export function ConnectionForm({
  value,
  guided = false,
  onSaved,
  onCancel,
  onDraftChange,
}: {
  value: Profile;
  guided?: boolean;
  onSaved: (profile: Profile) => void;
  onCancel?: () => void;
  onDraftChange?: (profile: Omit<Profile, "key">) => void;
}) {
  const [p, setP] = useState(value);
  const [key, setKey] = useState(() => keyFor(value));
  const [busy, setBusy] = useState("");
  const [result, setResult] = useState("");
  const [failure, setFailure] = useState("");
  const [models, setModels] = useState<string[]>([]);
  const [manualModel, setManualModel] = useState(false);
  const modelField = useRef<HTMLInputElement | HTMLSelectElement>(null);
  const request = useRef<AbortController | null>(null);
  const form = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (models.length) modelField.current?.focus();
  }, [models, manualModel]);
  useEffect(
    () => () => {
      request.current?.abort();
    },
    [],
  );
  function change(patch: Partial<Profile>, invalidate = true) {
    if ("url" in patch || "protocol" in patch) setModels([]);
    const next = {
      ...p,
      ...patch,
      ...(invalidate
        ? { testedAt: undefined, testedWithoutKey: undefined }
        : {}),
    };
    setP(next);
    if (invalidate) {
      setResult("");
      setFailure("");
    }
    const { key: _key, ...draft } = next;
    onDraftChange?.(draft);
  }
  async function save(profile: Profile) {
    await db.transaction("rw", db.profiles, db.preferences, async () => {
      await saveProfile(profile, key);
      if (
        !(await db.preferences.update("preferences", {
          activeProfile: profile.id,
        }))
      )
        throw new Error("本机设置尚未准备好，请刷新后重试。");
    });
    onSaved(profile);
  }
  async function test(andSave: boolean) {
    if (!form.current?.reportValidity() || busy) return;
    setBusy("test");
    setFailure("");
    setResult("正在测试连接，请稍等…");
    const controller = new AbortController();
    request.current = controller;
    let savingVerified = false;
    try {
      const checked = { ...p, url: p.url.trim(), model: p.model.trim() };
      const response = await generate(
        { ...checked, maxOutput: 128 },
        key,
        "Reply briefly.",
        "请只回复“连接成功”。",
        controller.signal,
      );
      if (controller.signal.aborted) return;
      if (!response.complete || !response.text.trim())
        throw new Error("接口有响应，但结果不完整。" + response.reason);
      const verified = {
        ...checked,
        testedAt: Date.now(),
        testedWithoutKey: !key.trim(),
      };
      setP(verified);
      onDraftChange?.(verified);
      setResult("浏览器连接成功，可以开始写故事了。");
      if (andSave) {
        savingVerified = true;
        await save(verified);
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        setResult("");
        setFailure(
          savingVerified
            ? "连接已通过，但配置还没有保存成功。请检查浏览器存储空间或权限后重试。"
            : connectionError(error),
        );
      }
    } finally {
      if (!controller.signal.aborted) setBusy("");
    }
  }
  return (
    <form
      ref={form}
      className="connection-form"
      onInvalidCapture={(event) => {
        const details = (event.target as HTMLElement).closest("details");
        if (details) details.open = true;
      }}
      onSubmit={async (event) => {
        event.preventDefault();
        if (guided) return test(true);
        setBusy("save");
        setFailure("");
        try {
          await save({ ...p, url: p.url.trim(), model: p.model.trim() });
        } catch {
          setFailure("配置没有保存成功，请检查浏览器存储权限后重试。");
        } finally {
          setBusy("");
        }
      }}
    >
      {!guided && (
        <p className="form-intro">
          填入服务提供方给你的连接信息。测试只发送一句简短问候。
        </p>
      )}
      <fieldset disabled={!!busy} className="connection-fields">
        <label className="field">
          <span>
            接口 URL <small>基址或完整地址</small>
          </span>
          <input
            type="url"
            required
            value={p.url}
            onChange={(e) => change({ url: e.target.value })}
            placeholder="https://your-service.com/v1"
            autoComplete="url"
          />
        </label>
        <label className="field">
          <span>API Key</span>
          <input
            type="password"
            autoComplete="off"
            value={key}
            onChange={(e) => {
              setKey(e.target.value);
              setModels([]);
              change({});
            }}
            placeholder="粘贴你自己的模型服务密钥"
          />
        </label>
        <label className="field">
          <span>模型名</span>
          {models.length > 0 && !manualModel ? (
            <span className="model-select-control">
              <select
                ref={(element) => {
                  modelField.current = element;
                }}
                aria-label="模型名"
                required
                value={p.model}
                onChange={(e) => change({ model: e.target.value })}
              >
                <option value="">点击选择模型</option>
                {p.model && !models.includes(p.model) && (
                  <option value={p.model}>{p.model}（当前填写）</option>
                )}
                {models.map((model) => (
                  <option key={model} value={model}>
                    {model}
                  </option>
                ))}
              </select>
              <ChevronDown size={18} aria-hidden="true" />
            </span>
          ) : (
            <input
              ref={(element) => {
                modelField.current = element;
              }}
              aria-label="模型名"
              required
              value={p.model}
              onChange={(e) => change({ model: e.target.value })}
              placeholder="填写服务提供方给出的模型 ID"
            />
          )}
        </label>
        <div className="connection-model-actions">
          <button
            type="button"
            className="text-action"
            onClick={async () => {
              if (!p.url.trim()) {
                setFailure("先填写接口地址，再获取模型列表。");
                return;
              }
              setBusy("models");
              setFailure("");
              setResult("");
              setModels([]);
              try {
                const available = await modelList(p, key);
                setModels(available);
                setManualModel(false);
                if (available.length)
                  setResult(
                    `已获取 ${available.length} 个模型，请在「模型名」下拉框中选择。`,
                  );
                else
                  setFailure(
                    "服务没有返回可选模型，可以直接手动填写模型名继续测试。",
                  );
              } catch (error) {
                setFailure(
                  connectionError(error) + "也可以直接填写模型名继续测试。",
                );
              } finally {
                setBusy("");
              }
            }}
          >
            {busy === "models" ? "正在获取模型…" : "尝试获取模型列表"}
          </button>
          {models.length > 0 && (
            <button
              type="button"
              className="text-action"
              onClick={() => setManualModel(!manualModel)}
            >
              {manualModel ? "从列表选择模型" : "手动填写模型名"}
            </button>
          )}
        </div>
        <label className="toggle connection-remember">
          <input
            type="checkbox"
            checked={p.remember}
            onChange={(e) => change({ remember: e.target.checked }, false)}
          />
          <span>记住此设备的 Key</span>
        </label>
        <p className="hint">
          默认刷新后需要重新填写密钥。勾选后会以未加密形式保存在当前浏览器，请只在自己的设备上使用；导出的备份不含密钥。
        </p>
        <p className="hint">
          测试连接和生成内容会使用你的模型额度。密钥和生成所需的角色、剧情将发往你填写的服务，请使用可信的
          HTTPS 接口；存档保存在当前浏览器。
        </p>
        <details className="starter-details">
          <summary>
            <span>高级设置</span>
            <small>协议、容量与超时</small>
            <ChevronDown size={15} />
          </summary>
          <div className="details-content">
            <label className="field">
              <span>配置名称</span>
              <input
                required
                value={p.name}
                onChange={(e) => change({ name: e.target.value }, false)}
              />
            </label>
            <label className="field">
              <span>协议</span>
              <select
                value={p.protocol}
                onChange={(e) =>
                  change({ protocol: e.target.value as Profile["protocol"] })
                }
              >
                {Object.entries(protocols).map(([id, label]) => (
                  <option key={id} value={id}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <div className="two-col">
              <label className="field">
                <span>上下文容量 · token</span>
                <input
                  type="number"
                  min={1024}
                  required
                  value={p.context}
                  onChange={(e) =>
                    change({ context: Number(e.target.value) }, false)
                  }
                />
              </label>
              <label className="field">
                <span>输出限额 · token</span>
                <input
                  type="number"
                  min={128}
                  required
                  value={p.maxOutput}
                  onChange={(e) =>
                    change({ maxOutput: Number(e.target.value) }, false)
                  }
                />
              </label>
              <label className="field">
                <span>超时 · 秒</span>
                <input
                  type="number"
                  min={5}
                  required
                  value={p.timeout}
                  onChange={(e) =>
                    change({ timeout: Number(e.target.value) }, false)
                  }
                />
              </label>
              <label className="toggle">
                <input
                  type="checkbox"
                  checked={p.stream}
                  onChange={(e) => change({ stream: e.target.checked })}
                />
                <span>流式接收</span>
              </label>
            </div>
          </div>
        </details>
      </fieldset>
      {result && (
        <p className="connection-result" role="status">
          {busy ? (
            <LoaderCircle size={17} className="spin" />
          ) : (
            <Check size={17} />
          )}
          {result}
        </p>
      )}
      {failure && (
        <p className="connection-failure" role="alert">
          {failure}
        </p>
      )}
      <div className="starter-actions">
        {onCancel && (
          <button type="button" onClick={onCancel} disabled={!!busy}>
            返回
          </button>
        )}
        {!guided && (
          <button type="button" disabled={!!busy} onClick={() => test(false)}>
            {busy === "test" ? "测试中…" : "测试连接"}
          </button>
        )}
        <button className="primary" disabled={!!busy} type="submit">
          {busy ? (
            <LoaderCircle size={17} className="spin" />
          ) : (
            <PlugZap size={17} />
          )}
          {guided ? (busy ? "正在连接…" : "测试连接并继续") : "保存并选用"}
        </button>
      </div>
    </form>
  );
}
