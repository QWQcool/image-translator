'use client';

import { useEffect, useState } from 'react';

type ConfigView = {
  baseUrl: string;
  apiKeyMasked: string;
  ocrModel: string;
  imageModel: string;
};

export default function AiSettingsClient() {
  const [config, setConfig] = useState<ConfigView | null>(null);
  const [baseUrl, setBaseUrl] = useState('');
  const [ocrModel, setOcrModel] = useState('');
  const [imageModel, setImageModel] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [ocrReady, setOcrReady] = useState(false);
  const [inpaintReady, setInpaintReady] = useState(false);
  const [notice, setNotice] = useState<{ type: 'ok' | 'error'; text: string } | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch('/api/ai/config');
        const data = await res.json();
        setConfig(data.config);
        setOcrReady(Boolean(data.ocrReady));
        setInpaintReady(Boolean(data.inpaintReady));
        setBaseUrl(data.config.baseUrl ?? '');
        setOcrModel(data.config.ocrModel ?? '');
        setImageModel(data.config.imageModel ?? '');
      } catch {
        setNotice({ type: 'error', text: '配置加载失败' });
      }
    })();
  }, []);

  async function save(clearKey = false) {
    setSaving(true);
    setNotice(null);
    try {
      const res = await fetch('/api/ai/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          baseUrl,
          ocrModel,
          imageModel,
          apiKey: clearKey ? 'clear' : apiKey.trim() || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setNotice({ type: 'error', text: data.error ?? '保存失败' });
        return;
      }
      setConfig(data.config);
      setOcrReady(Boolean(data.ocrReady));
      setInpaintReady(Boolean(data.inpaintReady));
      setApiKey('');
      setNotice({ type: 'ok', text: '已保存' });
    } catch {
      setNotice({ type: 'error', text: '保存过程中发生网络错误' });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-5">
      <div>
        <h1 className="font-display text-xl text-ink-100">AI 设置</h1>
        <p className="mt-1 text-sm text-ink-400">
          填入你自己的 OpenAI 兼容服务（DeepSeek / GPT / GLM / Qwen…）。
          配置按账号各自保存，互不可见；谁配置了 token，谁就能用 AI 识别与 AI 去字。
          Key 存在服务器数据库（不进仓库），页面上只显示尾 4 位。
        </p>
      </div>

      <div className="card max-w-2xl space-y-4">
        <label className="block text-sm">
          <span className="label">Base URL</span>
          <input
            className="input mt-1"
            placeholder="https://api.deepseek.com/v1"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
          />
        </label>

        <label className="block text-sm">
          <span className="label">
            API Key {config?.apiKeyMasked ? `（当前 ${config.apiKeyMasked}）` : '（未设置）'}
          </span>
          <input
            className="input mt-1"
            type="password"
            placeholder={config?.apiKeyMasked ? '留空则保持不变' : 'sk-…'}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
          />
        </label>

        <label className="block text-sm">
          <span className="label">OCR 视觉模型</span>
          <input
            className="input mt-1"
            placeholder="deepseek-v4-flash-vision-exp / gpt-4o-mini / glm-4v…"
            value={ocrModel}
            onChange={(e) => setOcrModel(e.target.value)}
          />
          <span className="mt-1 block text-[11px] text-ink-500">
            调用 {`{Base URL}/chat/completions`}，传图片并要求返回归一化坐标 JSON。
          </span>
        </label>

        <label className="block text-sm">
          <span className="label">去字图像编辑模型（可选）</span>
          <input
            className="input mt-1"
            placeholder="gpt-image-1（留空 = 不启用 AI 去字）"
            value={imageModel}
            onChange={(e) => setImageModel(e.target.value)}
          />
          <span className="mt-1 block text-[11px] text-ink-500">
            调用 {`{Base URL}/images/edits`}（图 + 蒙版）。生成式模型可能轻微改动线稿，
            服务端会做蒙版外像素校验，超阈值自动回退本地填充。
          </span>
        </label>

        <div className="flex flex-wrap items-center gap-3">
          <button type="button" className="btn-primary" disabled={saving} onClick={() => void save(false)}>
            {saving ? '保存中…' : '保存'}
          </button>
          {config?.apiKeyMasked && (
            <button type="button" className="btn-ghost" disabled={saving} onClick={() => void save(true)}>
              清除 Key
            </button>
          )}
          <span className={`rounded px-2 py-1 text-xs ${ocrReady ? 'bg-emerald-500/15 text-emerald-700' : 'bg-ink-800 text-ink-400'}`}>
            OCR {ocrReady ? '就绪' : '未配置'}
          </span>
          <span className={`rounded px-2 py-1 text-xs ${inpaintReady ? 'bg-emerald-500/15 text-emerald-700' : 'bg-ink-800 text-ink-400'}`}>
            AI 去字 {inpaintReady ? '就绪' : '未配置'}
          </span>
        </div>

        {notice && (
          <p className={notice.type === 'ok' ? 'text-sm text-emerald-700' : 'text-sm text-blush'}>
            {notice.text}
          </p>
        )}
      </div>

      <div className="card max-w-2xl text-xs leading-relaxed text-ink-500">
        <p className="font-medium text-ink-300">引擎优先级说明</p>
        <p className="mt-1">
          OCR：AI 视觉模型（已配置时优先）→ 本机 sidecar（SIDECAR_URL，默认
          http://127.0.0.1:8765）。两者都没有时提示 503。
        </p>
        <p className="mt-1">
          去字：本机 sidecar 的 LaMa（确定性最好）→ AI 图像编辑（你的 token）→
          telea 算法兜底（免费、确定性 100%，蒙版外零改动）。
        </p>
      </div>
    </div>
  );
}
