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

type DetectionView = {
  source: 'ai' | 'sidecar';
  baseUrl: string;
  apiKeyMasked: string;
  model: string;
  ready: boolean;
};

type SidecarView = { reachable: boolean; engine: string | null; detector: boolean };

const EMPTY_FORM: ProviderForm = {
  name: '',
  baseUrl: '',
  apiKey: '',
  ocrModel: '',
  chatModel: '',
  imageModel: '',
};

const EMPTY_DETECTION_FORM = { source: 'ai', baseUrl: '', apiKey: '', model: '' };

/** 检测服务预设模板：不同渠道只差 Base URL 与提示文案，调用协议统一走 OpenAI 兼容 */
const DETECTION_TEMPLATES: Array<{ id: string; label: string; baseUrl: string; hint: string }> = [
  {
    id: 'paddle',
    label: '飞桨星河 PaddleOCR VL',
    baseUrl: 'https://aistudio.baidu.com/llm/lmapi/v3',
    hint: '飞桨星河社区部署 PaddleOCR-VL 后得到的 OpenAI 兼容端点，检测精度高、框准。',
  },
  {
    id: 'custom',
    label: '自定义 OpenAI 兼容视觉端点',
    baseUrl: '',
    hint: '任何支持「传图 + 返回归一化框 JSON」的 OpenAI 兼容服务（vLLM / Ollama / 各云厂商均可）。',
  },
];

/** 6a 多 Provider：列表管理（添加/编辑/删除/设默认），每人的配置互相不可见 */
export default function AiSettingsClient() {
  const [tab, setTab] = useState<'config' | 'docs'>('config');
  const [providers, setProviders] = useState<ProviderView[]>([]);
  const [status, setStatus] = useState({ ocrReady: false, chatReady: false, inpaintReady: false });
  const [detection, setDetection] = useState<DetectionView | null>(null);
  const [notice, setNotice] = useState<{ type: 'ok' | 'error'; text: string } | null>(null);
  const [loading, setLoading] = useState(true);
  /** 编辑中的 Provider id；'new' = 新增表单；null = 列表视图 */
  const [editing, setEditing] = useState<number | 'new' | null>(null);
  const [form, setForm] = useState<ProviderForm>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  // 文本块检测服务（每用户独立，可选）
  const [detForm, setDetForm] = useState(EMPTY_DETECTION_FORM);
  const [detTemplate, setDetTemplate] = useState('custom');
  const [detEditing, setDetEditing] = useState(false);
  const [detSaving, setDetSaving] = useState(false);
  // 本机检测进程（sidecar）状态
  const [detSidecar, setDetSidecar] = useState<SidecarView | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [providersRes, configRes, detectionRes] = await Promise.all([
        fetch('/api/ai/providers'),
        fetch('/api/ai/config'),
        fetch('/api/ai/detection'),
      ]);
      const data = await providersRes.json();
      const cfg = await configRes.json();
      const det = detectionRes.ok ? await detectionRes.json() : null;
      setProviders(Array.isArray(data.providers) ? data.providers : []);
      setStatus({
        ocrReady: Boolean(cfg.ocrReady),
        chatReady: Boolean(cfg.chatReady),
        inpaintReady: Boolean(cfg.inpaintReady),
      });
      if (det?.config) {
        setDetection({ ...det.config, ready: Boolean(det.ready) });
        setDetForm({
          source: det.config.source === 'sidecar' ? 'sidecar' : 'ai',
          baseUrl: det.config.baseUrl ?? '',
          apiKey: '',
          model: det.config.model ?? '',
        });
        setDetTemplate(det.config.baseUrl.includes('aistudio.baidu.com') ? 'paddle' : 'custom');
      }
      setDetSidecar(det?.sidecar ?? null);
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

  async function saveDetection() {
    setDetSaving(true);
    setNotice(null);
    try {
      const res = await fetch('/api/ai/detection', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(detForm),
      });
      const data = await res.json();
      if (!res.ok) {
        setNotice({ type: 'error', text: data.error ?? '保存失败' });
        return;
      }
      setNotice({ type: 'ok', text: '检测服务配置已保存' });
      setDetEditing(false);
      await load();
    } catch {
      setNotice({ type: 'error', text: '保存过程中发生网络错误' });
    } finally {
      setDetSaving(false);
    }
  }

  return (
    <div className="space-y-5">
      <div>
        <h1 className="font-display text-xl text-ink-100">AI 设置</h1>
        <p className="mt-1 text-sm text-ink-400">
          配置你自己的 OpenAI 兼容服务（DeepSeek / GPT / GLM / Qwen…），可添加多条，
          OCR 识别 / AI 翻译 / AI 去字都会走默认那条。
          配置按账号各自保存，互不可见；Key 存在服务器数据库（不进仓库），页面上只显示尾 4 位。
        </p>
        {/* 两个 Tab：服务配置 / 使用说明 */}
        <div className="seg mt-3 flex w-fit gap-1">
          <button
            type="button"
            className={`seg-btn ${tab === 'config' ? 'seg-btn-on' : ''}`}
            onClick={() => setTab('config')}
          >
            服务配置
          </button>
          <button
            type="button"
            className={`seg-btn ${tab === 'docs' ? 'seg-btn-on' : ''}`}
            onClick={() => setTab('docs')}
          >
            使用说明
          </button>
        </div>
      </div>

      {tab === 'docs' && <AiDocs />}

      {tab === 'config' && (
        <>
      <div>
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
          <span className={`rounded px-2 py-1 ${detection?.ready ? 'bg-emerald-500/15 text-emerald-700' : 'bg-ink-800 text-ink-400'}`}>
            文本块检测 {detection?.ready ? '就绪（两步链路）' : '未配置（单步）'}
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

      {/* Stage 6：文本块检测服务（每用户独立，可选；配置后 OCR 走两步链路） */}
      <div className="card max-w-2xl space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-medium text-ink-100">文本块检测服务（可选）</h2>
          <span className={`rounded px-2 py-1 text-xs ${detection?.ready ? 'bg-emerald-500/15 text-emerald-700' : 'bg-ink-800 text-ink-400'}`}>
            {detection?.ready ? '已启用' : '未配置'}
          </span>
        </div>
        <p className="text-xs text-ink-500">
          配置后 OCR 改走两步链路：检测模型先出文字框（框准、省 token）→
          空框区域裁剪后交给视觉模型补提取文字。未配置时保持单步视觉识别。
          空框补提取用的是上方默认 AI 服务的 OCR 视觉模型，请确保默认服务已配置。
        </p>
        {!detEditing ? (
          <div className="space-y-1 text-xs text-ink-400">
            {detection?.source === 'sidecar' ? (
              <p>
                来源：本机检测进程（sidecar/detector.mjs）· 状态：
                {detSidecar?.reachable
                  ? detSidecar.detector
                    ? detSidecar.engine === 'onnx'
                      ? '运行中（ONNX 模型档）'
                      : '运行中（传统算法档）'
                    : '运行中（旧版 stub，未提供检测，请改跑 node sidecar/detector.mjs）'
                  : '未启动'}
              </p>
            ) : (
              <>
                <p>Base URL：{detection?.baseUrl || '—'}</p>
                <p>
                  Key：{detection?.apiKeyMasked || '未设置'} · 模型：{detection?.model || '—'}
                </p>
              </>
            )}
            <button
              type="button"
              className="btn-ghost px-3 py-1 text-xs"
              onClick={() => {
                setDetForm({
                  source: detection?.source ?? 'ai',
                  baseUrl: detection?.baseUrl ?? '',
                  apiKey: '',
                  model: detection?.model ?? '',
                });
                setDetEditing(true);
              }}
            >
              {detection?.ready || detection?.baseUrl ? '编辑' : '配置检测服务'}
            </button>
          </div>
        ) : (
          <div className="space-y-3">
            <div>
              <span className="label">检测来源</span>
              <div className="mt-1 flex overflow-hidden rounded-md border border-ink-700 text-xs">
                {[
                  { id: 'ai', label: 'AI 检测服务（云端）' },
                  { id: 'sidecar', label: '本机检测进程（免费离线）' },
                ].map((opt) => (
                  <button
                    key={opt.id}
                    type="button"
                    onClick={() => setDetForm((f) => ({ ...f, source: opt.id as 'ai' | 'sidecar' }))}
                    className={`px-3 py-1.5 transition-colors ${
                      detForm.source === opt.id
                        ? 'bg-sky text-white'
                        : 'text-ink-400 hover:text-ink-200'
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>
            {detForm.source === 'sidecar' ? (
              <div className="rounded-lg border border-sky/40 bg-cloud p-3 text-xs text-ink-400">
                <p>
                  本机检测进程状态：
                  {detSidecar?.reachable
                    ? detSidecar.detector
                      ? detSidecar.engine === 'onnx'
                        ? '运行中（ONNX 模型档）'
                        : '运行中（传统算法档，未装模型）'
                      : '运行中（但启动的是旧版 stub，未提供检测，请改跑 node sidecar/detector.mjs）'
                    : '未启动——在服务器上执行 node sidecar/detector.mjs 后即可使用'}
                </p>
                <p className="mt-1">
                  模型下载与配置步骤见「使用说明」Tab 的「本地文本块检测」章节；不装模型也可用传统算法档。
                </p>
              </div>
            ) : (
              <>
            <label className="block text-xs">
              <span className="label">预设模板</span>
              <select
                className="input mt-1"
                value={detTemplate}
                onChange={(e) => {
                  setDetTemplate(e.target.value);
                  const tpl = DETECTION_TEMPLATES.find((t) => t.id === e.target.value);
                  if (tpl?.baseUrl) setDetForm((f) => ({ ...f, baseUrl: tpl.baseUrl }));
                }}
              >
                {DETECTION_TEMPLATES.map((tpl) => (
                  <option key={tpl.id} value={tpl.id}>
                    {tpl.label}
                  </option>
                ))}
              </select>
              <span className="mt-1 block text-[11px] text-ink-500">
                {DETECTION_TEMPLATES.find((t) => t.id === detTemplate)?.hint}
              </span>
            </label>
            <label className="block text-sm">
              <span className="label">Base URL</span>
              <input
                className="input mt-1"
                placeholder="https://aistudio.baidu.com/llm/lmapi/v3"
                value={detForm.baseUrl}
                onChange={(e) => setDetForm((f) => ({ ...f, baseUrl: e.target.value }))}
              />
            </label>
            <label className="block text-sm">
              <span className="label">API Key（留空保持不变，输入 clear 清除）</span>
              <input
                className="input mt-1"
                type="password"
                placeholder={detection?.apiKeyMasked ? `已设置 ${detection.apiKeyMasked}` : 'token…'}
                value={detForm.apiKey}
                onChange={(e) => setDetForm((f) => ({ ...f, apiKey: e.target.value }))}
              />
            </label>
            <label className="block text-sm">
              <span className="label">检测模型</span>
              <input
                className="input mt-1"
                placeholder="paddleocr-vl / mock-detect…"
                value={detForm.model}
                onChange={(e) => setDetForm((f) => ({ ...f, model: e.target.value }))}
              />
              <span className="mt-1 block text-[11px] text-ink-500">
                调用 {`{Base URL}/chat/completions`}，传整图要求返回归一化文字框 JSON。
              </span>
            </label>
              </>
            )}
            <div className="flex gap-2">
              <button
                type="button"
                className="btn-primary"
                disabled={detSaving}
                onClick={() => void saveDetection()}
              >
                {detSaving ? '保存中…' : '保存'}
              </button>
              <button type="button" className="btn-ghost" onClick={() => setDetEditing(false)}>
                取消
              </button>
            </div>
          </div>
        )}
      </div>
        </>
      )}
    </div>
  );
}

/** 使用说明 Tab：完整 AI 文档（静态内容） */
function AiDocs() {
  return (
    <div className="max-w-2xl space-y-4 text-sm leading-relaxed text-ink-300">
      <section className="card space-y-2">
        <h2 className="font-medium text-ink-100">这个页面的四种服务都是干什么的？</h2>
        <ul className="list-disc space-y-1.5 pl-5 text-ink-400">
          <li>
            <strong className="text-ink-200">视觉对话（OCR 与翻译共用）</strong>：
            把图片发给视觉模型识别出文字框（OCR），也用对话模型把识别出的原文翻译成中文。
            不配置就只能用本机 sidecar 识别（需要在服务器上另装）。
          </li>
          <li>
            <strong className="text-ink-200">文本块检测（可选）</strong>：
            专管「文字在图的哪里」的模型。配置后 OCR 走两步链路：先由检测模型出框（框更准、更省 token），
            框内没识别出文字的空框再裁剪成小图交给视觉模型补提取。
          </li>
          <li>
            <strong className="text-ink-200">图像编辑（去字）</strong>：
            传入图片 + 涂改蒙版做生成式填充，把原文从画面上抹掉。服务端会校验蒙版外像素，
            漂移过大自动回退本地填充。
          </li>
        </ul>
      </section>

      <section className="card space-y-2">
        <h2 className="font-medium text-ink-100">本地文本块检测（免费、离线、无需 API）</h2>
        <p className="text-ink-400">
          检测来源选「本机检测进程」后，文字框由服务器上的 <code>sidecar/detector.mjs</code>{' '}
          生成，不消耗任何 API 额度。框内文字仍由默认 AI 服务的视觉模型补提取
          （也可不配 AI，直接手动录入原文）。
        </p>
        <ol className="list-decimal space-y-1.5 pl-5 text-ink-400">
          <li>
            启动检测进程（传统算法档，无需下载模型）：<code>node sidecar/detector.mjs</code>
            ，主站 <code>.env.local</code> 里配 <code>SIDECAR_URL=http://127.0.0.1:8765</code>
          </li>
          <li>
            （可选，精度更高）下载漫画专用检测模型 comic-text-detector.onnx（DBNet 架构，约几十 MB）：
            <a
              className="text-sky-deep underline"
              href="https://huggingface.co/mayocream/comic-text-detector-onnx/resolve/main/comic-text-detector.onnx"
              target="_blank"
              rel="noreferrer"
            >
              HuggingFace下载链接
            </a>
            （上游项目：github.com/dmMaze/comic-text-detector）
          </li>
          <li>
            在项目根安装推理运行时：<code>npm i onnxruntime-node</code>
          </li>
          <li>
            把模型放到 <code>sidecar/models/comic-text-detector.onnx</code>，重启 detector.mjs；
            探活接口 <code>/health</code> 的 <code>engine</code> 变为 <code>onnx</code> 即生效
          </li>
          <li>
            本页「文本块检测服务」选「本机检测进程」保存；标注页的「OCR 自动标号」即走本地检测
          </li>
        </ol>
        <p className="text-xs text-ink-500">
          提示：传统算法档对黑白漫画「气泡内深色文字」效果好；复杂背景 / 彩色页建议下载
          ONNX 模型档，或继续用飞桨 PaddleOCR VL 等云端检测服务。
        </p>
      </section>

      <section className="card space-y-2">
        <h2 className="font-medium text-ink-100">Base URL 和 Key 去哪获取？</h2>
        <ul className="list-disc space-y-1.5 pl-5 text-ink-400">
          <li>
            <strong className="text-ink-200">DeepSeek 开放平台</strong>（platform.deepseek.com）：
            注册后创建 API Key；Base URL 填 <code>https://api.deepseek.com/v1</code>。
            视觉与翻译模型见其模型列表，性价比高。
          </li>
          <li>
            <strong className="text-ink-200">飞桨星河社区</strong>（aistudio.baidu.com）：
            部署 PaddleOCR-VL 服务后得到 OpenAI 兼容端点，适合做「文本块检测」。
          </li>
          <li>
            <strong className="text-ink-200">OpenAI / 云厂商</strong>：
            platform.openai.com 或各厂商控制台创建 Key；Base URL 以官方文档为准（通常以 /v1 结尾）。
          </li>
          <li>
            <strong className="text-ink-200">本地模型</strong>：
            Ollama / vLLM 暴露的 OpenAI 兼容端点（如 http://127.0.0.1:11434/v1），Key 随便填。
          </li>
        </ul>
      </section>

      <section className="card space-y-2">
        <h2 className="font-medium text-ink-100">推荐组合</h2>
        <ul className="list-disc space-y-1.5 pl-5 text-ink-400">
          <li>视觉（OCR + 补提取）：deepseek-v4-flash-vision 或 glm-4v / qwen3-vl 系列</li>
          <li>翻译：deepseek-chat（纯文本对话模型，便宜且质量稳定）</li>
          <li>去字：gpt-image 系列（生成式图像编辑）</li>
          <li>文本块检测：PaddleOCR-VL（框准）或任意支持传图的视觉模型</li>
        </ul>
      </section>

      <section className="card space-y-2">
        <h2 className="font-medium text-ink-100">费用量级参考</h2>
        <p className="text-ink-400">
          一页漫画 OCR + 翻译通常在几千 token 量级。以主流厂商定价折算，
          一页成本约几厘到几分钱人民币；一本 200 页的本子全流程（识别+翻译+去字）
          大致在几元以内。检测模型按 token 计费时比整图识别更省（框数据远小于文字描述）。
          以各平台实时价格为准。
        </p>
      </section>

      <section className="card space-y-2">
        <h2 className="font-medium text-ink-100">隐私说明</h2>
        <p className="text-ink-400">
          使用 AI 功能时，图片（或其局部裁剪）会以 base64 形式发送给你自己配置的服务商，
          识别与翻译的文字也会发给该服务商。本站服务器只做转发与结果落库，
          不经过任何第三方中转；但也请避免上传含敏感个人信息的图片。
          不使用 AI 功能时不会有任何外发请求。
        </p>
      </section>

      <section className="card space-y-2">
        <h2 className="font-medium text-ink-100">常见问题</h2>
        <ul className="list-disc space-y-1.5 pl-5 text-ink-400">
          <li>
            <strong className="text-ink-200">401 / 鉴权失败</strong>：
            Key 填错、Key 被删除或未开通对应模型权限。到服务商控制台重新生成 Key 后在本页更新。
          </li>
          <li>
            <strong className="text-ink-200">429 / 限流</strong>：
            触发服务商速率或余额限制。等一会重试、给账户充值，或换一条 Provider。
          </li>
          <li>
            <strong className="text-ink-200">超时</strong>：
            大图 / 高峰期响应慢。本站对单次调用设了 60~120 秒超时；
            若经常超时，检查 Base URL 是否多了或少了路径（通常以 /v1 结尾），或换更快的模型。
          </li>
          <li>
            <strong className="text-ink-200">识别出来的框偏移</strong>：
            视觉模型数格子不如专用检测模型准，建议配置「文本块检测服务」走两步链路。
          </li>
        </ul>
      </section>
    </div>
  );
}
