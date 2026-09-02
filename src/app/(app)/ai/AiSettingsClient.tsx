'use client';

import { useCallback, useEffect, useState } from 'react';

type ProviderView = {
  id: number;
  name: string;
  baseUrl: string;
  apiKeyMasked: string;
  ocrModel: string;
  chatModel: string;
  imageModel: string;
  isDefault: boolean;
};

type ProviderForm = {
  name: string;
  baseUrl: string;
  apiKey: string;
  ocrModel: string;
  chatModel: string;
  imageModel: string;
};

const EMPTY_FORM: ProviderForm = {
  name: '',
  baseUrl: '',
  apiKey: '',
  ocrModel: '',
  chatModel: '',
  imageModel: '',
};

/** 6a 多 Provider：列表管理（添加/编辑/删除/设默认），每人的配置互相不可见 */
export default function AiSettingsClient() {
  const [providers, setProviders] = useState<ProviderView[]>([]);
  const [status, setStatus] = useState({ ocrReady: false, chatReady: false, inpaintReady: false });
  const [notice, setNotice] = useState<{ type: 'ok' | 'error'; text: string } | null>(null);
  const [loading, setLoading] = useState(true);
  /** 编辑中的 Provider id；'new' = 新增表单；null = 列表视图 */
  const [editing, setEditing] = useState<number | 'new' | null>(null);
  const [form, setForm] = useState<ProviderForm>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [providersRes, configRes] = await Promise.all([
        fetch('/api/ai/providers'),
        fetch('/api/ai/config'),
      ]);
      const data = await providersRes.json();
      const cfg = await configRes.json();
      setProviders(Array.isArray(data.providers) ? data.providers : []);
      setStatus({
        ocrReady: Boolean(cfg.ocrReady),
        chatReady: Boolean(cfg.chatReady),
        inpaintReady: Boolean(cfg.inpaintReady),
      });
    } catch {
      setNotice({ type: 'error', text: '配置加载失败' });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  function openNew() {
    setForm(EMPTY_FORM);
    setEditing('new');
  }

  function openEdit(provider: ProviderView) {
    setForm({
      name: provider.name,
      baseUrl: provider.baseUrl,
      apiKey: '',
      ocrModel: provider.ocrModel,
      chatModel: provider.chatModel,
      imageModel: provider.imageModel,
    });
    setEditing(provider.id);
  }

  async function save() {
    setSaving(true);
    setNotice(null);
    try {
      const isNew = editing === 'new';
      const res = await fetch(isNew ? '/api/ai/providers' : `/api/ai/providers/${editing}`, {
        method: isNew ? 'POST' : 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(isNew ? form : { ...form, apiKey: form.apiKey.trim() || undefined }),
      });
      const data = await res.json();
      if (!res.ok) {
        setNotice({ type: 'error', text: data.error ?? '保存失败' });
        return;
      }
      setEditing(null);
      setNotice({ type: 'ok', text: '已保存' });
      await load();
    } catch {
      setNotice({ type: 'error', text: '保存过程中发生网络错误' });
    } finally {
      setSaving(false);
    }
  }

  async function remove(id: number) {
    if (!window.confirm('确定删除这条 AI 服务配置？')) return;
    const res = await fetch(`/api/ai/providers/${id}`, { method: 'DELETE' });
    if (!res.ok) {
      const data = await res.json().catch(() => ({ error: '删除失败' }));
      setNotice({ type: 'error', text: data.error ?? '删除失败' });
      return;
    }
    setNotice({ type: 'ok', text: '已删除' });
    await load();
  }

  async function setDefault(id: number) {
    const res = await fetch(`/api/ai/providers/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ setDefault: true }),
    });
    if (!res.ok) {
      setNotice({ type: 'error', text: '设置默认失败' });
      return;
    }
    setNotice({ type: 'ok', text: '已设为默认' });
    await load();
  }

  const formTitle = editing === 'new' ? '添加 AI 服务' : '编辑 AI 服务';

  return (
    <div className="space-y-5">
      <div>
        <h1 className="font-display text-xl text-ink-100">AI 设置</h1>
        <p className="mt-1 text-sm text-ink-400">
          配置你自己的 OpenAI 兼容服务（DeepSeek / GPT / GLM / Qwen…），可添加多条，
          OCR 识别 / AI 翻译 / AI 去字都会走默认那条。
          配置按账号各自保存，互不可见；Key 存在服务器数据库（不进仓库），页面上只显示尾 4 位。
        </p>
        <div className="mt-2 flex flex-wrap gap-2 text-xs">
          <span className={`rounded px-2 py-1 ${status.ocrReady ? 'bg-emerald-500/15 text-emerald-700' : 'bg-ink-800 text-ink-400'}`}>
            OCR {status.ocrReady ? '就绪' : '未配置'}
          </span>
          <span className={`rounded px-2 py-1 ${status.chatReady ? 'bg-emerald-500/15 text-emerald-700' : 'bg-ink-800 text-ink-400'}`}>
            AI 翻译 {status.chatReady ? '就绪' : '未配置'}
          </span>
          <span className={`rounded px-2 py-1 ${status.inpaintReady ? 'bg-emerald-500/15 text-emerald-700' : 'bg-ink-800 text-ink-400'}`}>
            AI 去字 {status.inpaintReady ? '就绪' : '未配置'}
          </span>
        </div>
      </div>

      {notice && (
        <p className={notice.type === 'ok' ? 'text-sm text-emerald-700' : 'text-sm text-blush'}>
          {notice.text}
        </p>
      )}

      {/* 6e 官方付费渠道占位：暂不开放，后端不做计费 */}
      <div className="card flex max-w-2xl items-center justify-between gap-3 opacity-70">
        <div>
          <p className="text-sm font-medium text-ink-200">官方 AI 渠道</p>
          <p className="mt-0.5 text-xs text-ink-500">无需自备 token 的官方付费通道，即将开放，敬请期待。</p>
        </div>
        <span className="rounded bg-ink-800 px-2 py-1 text-xs text-ink-400">即将开放</span>
      </div>

      <div className="max-w-2xl space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-medium text-ink-100">我的 AI 服务（{providers.length}）</h2>
          {editing === null && (
            <button type="button" className="btn-primary px-3 py-1 text-xs" onClick={openNew}>
              添加服务
            </button>
          )}
        </div>

        {loading ? (
          <p className="text-sm text-ink-500">加载中…</p>
        ) : providers.length === 0 && editing === null ? (
          <div className="card text-sm text-ink-400">
            还没有配置任何 AI 服务。添加一条后即可使用 AI 识别、AI 翻译与 AI 去字。
          </div>
        ) : (
          editing === null &&
          providers.map((provider) => (
            <div key={provider.id} className="card">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium text-ink-100">{provider.name}</span>
                {provider.isDefault && (
                  <span className="rounded bg-sky/15 px-1.5 py-0.5 text-[11px] text-sky-deep">默认</span>
                )}
                <span className="ml-auto flex gap-2">
                  {!provider.isDefault && (
                    <button type="button" className="btn-ghost px-2 py-1 text-[11px]" onClick={() => void setDefault(provider.id)}>
                      设为默认
                    </button>
                  )}
                  <button type="button" className="btn-ghost px-2 py-1 text-[11px]" onClick={() => openEdit(provider)}>
                    编辑
                  </button>
                  <button type="button" className="btn-ghost px-2 py-1 text-[11px] text-blush" onClick={() => void remove(provider.id)}>
                    删除
                  </button>
                </span>
              </div>
              <p className="mt-1 truncate text-xs text-ink-400">{provider.baseUrl}</p>
              <p className="mt-0.5 text-[11px] text-ink-500">
                Key {provider.apiKeyMasked || '未设置'} · OCR {provider.ocrModel || '—'} · 翻译 {provider.chatModel || '—'} · 去字 {provider.imageModel || '—'}
              </p>
            </div>
          ))
        )}

        {editing !== null && (
          <div className="card space-y-3">
            <h3 className="text-sm font-medium text-ink-100">{formTitle}</h3>
            <label className="block text-sm">
              <span className="label">名称</span>
              <input
                className="input mt-1"
                placeholder="例如 DeepSeek / 本地 Ollama"
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              />
            </label>
            <label className="block text-sm">
              <span className="label">Base URL</span>
              <input
                className="input mt-1"
                placeholder="https://api.deepseek.com/v1"
                value={form.baseUrl}
                onChange={(e) => setForm((f) => ({ ...f, baseUrl: e.target.value }))}
              />
            </label>
            <label className="block text-sm">
              <span className="label">
                API Key {editing !== 'new' && '（留空保持不变，输入 clear 清除）'}
              </span>
              <input
                className="input mt-1"
                type="password"
                placeholder={editing === 'new' ? 'sk-…' : '留空则保持不变'}
                value={form.apiKey}
                onChange={(e) => setForm((f) => ({ ...f, apiKey: e.target.value }))}
              />
            </label>
            <label className="block text-sm">
              <span className="label">OCR 视觉模型</span>
              <input
                className="input mt-1"
                placeholder="gpt-4o-mini / glm-4v / qwen3-vl…"
                value={form.ocrModel}
                onChange={(e) => setForm((f) => ({ ...f, ocrModel: e.target.value }))}
              />
              <span className="mt-1 block text-[11px] text-ink-500">
                调用 {`{Base URL}/chat/completions`}，传图片要求返回归一化坐标 JSON + 画面描述。
              </span>
            </label>
            <label className="block text-sm">
              <span className="label">翻译对话模型（可选，留空用 OCR 模型）</span>
              <input
                className="input mt-1"
                placeholder="deepseek-chat / gpt-4o-mini…"
                value={form.chatModel}
                onChange={(e) => setForm((f) => ({ ...f, chatModel: e.target.value }))}
              />
            </label>
            <label className="block text-sm">
              <span className="label">去字图像编辑模型（可选）</span>
              <input
                className="input mt-1"
                placeholder="gpt-image-1（留空 = 不启用 AI 去字）"
                value={form.imageModel}
                onChange={(e) => setForm((f) => ({ ...f, imageModel: e.target.value }))}
              />
              <span className="mt-1 block text-[11px] text-ink-500">
                调用 {`{Base URL}/images/edits`}（图 + 蒙版）。服务端做蒙版外像素校验，超阈值自动回退本地填充。
              </span>
            </label>
            <div className="flex gap-2">
              <button type="button" className="btn-primary" disabled={saving} onClick={() => void save()}>
                {saving ? '保存中…' : '保存'}
              </button>
              <button type="button" className="btn-ghost" onClick={() => setEditing(null)}>
                取消
              </button>
            </div>
          </div>
        )}
      </div>

      <div className="card max-w-2xl text-xs leading-relaxed text-ink-500">
        <p className="font-medium text-ink-300">引擎优先级说明</p>
        <p className="mt-1">
          OCR：AI 视觉模型（默认 Provider 已配置时优先）→ 本机 sidecar（SIDECAR_URL，默认
          http://127.0.0.1:8765）。两者都没有时提示 503。
        </p>
        <p className="mt-1">
          翻译：默认 Provider 的对话模型（未单独配置时复用 OCR 模型）。
        </p>
        <p className="mt-1">
          去字：本机 sidecar 的 LaMa（确定性最好）→ AI 图像编辑（你的 token）→
          telea 算法兜底（免费、确定性 100%，蒙版外零改动）。
        </p>
      </div>
    </div>
  );
}
