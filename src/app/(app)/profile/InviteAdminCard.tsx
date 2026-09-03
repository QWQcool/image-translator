'use client';

import { useEffect, useState } from 'react';

type InviteCode = {
  id: number;
  code: string;
  createdBy: string | null;
  usedBy: string | null;
  usedAt: string | null;
  createdAt: string;
};

/**
 * 邀请码管理卡片（仅管理员渲染；接口层另有 403 兜底）。
 * 生成后明文只显示一次，用弹层展示并提供复制按钮。
 */
export default function InviteAdminCard() {
  const [codes, setCodes] = useState<InviteCode[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 新生成的邀请码明文（只此一次可见）
  const [freshCode, setFreshCode] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function load() {
    try {
      const res = await fetch('/api/admin/invites');
      if (!res.ok) {
        setError(res.status === 403 ? '仅管理员可管理邀请码' : '邀请码加载失败');
        return;
      }
      const data = await res.json();
      setCodes(data.codes ?? []);
      setError(null);
    } catch {
      setError('邀请码加载失败');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function generate() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/admin/invites', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? '生成失败');
        return;
      }
      setCopied(false);
      setFreshCode(data.code?.code ?? null);
      await load();
    } catch {
      setError('生成过程中发生网络错误');
    } finally {
      setBusy(false);
    }
  }

  async function revoke(id: number) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/invites/${id}`, { method: 'DELETE' });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error ?? '作废失败');
        return;
      }
      await load();
    } catch {
      setError('作废过程中发生网络错误');
    } finally {
      setBusy(false);
    }
  }

  async function copyFresh() {
    if (!freshCode) return;
    try {
      await navigator.clipboard.writeText(freshCode);
      setCopied(true);
    } catch {
      // 剪贴板不可用时静默失败，明文仍在弹层里可手动复制
    }
  }

  function statusOf(code: InviteCode): { label: string; className: string } {
    if (code.usedBy) return { label: '已用', className: 'bg-ink-800 text-ink-300' };
    return { label: '未用', className: 'bg-emerald-100 text-emerald-700' };
  }

  return (
    <div className="card max-w-xl space-y-4 p-6">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-ink-100">邀请码管理</h2>
          <p className="mt-0.5 text-xs text-ink-400">
            生成的新邀请码明文只显示一次，请及时复制发给对方。
          </p>
        </div>
        <button type="button" className="btn-primary px-3 py-1.5 text-xs" disabled={busy} onClick={() => void generate()}>
          {busy ? '处理中…' : '生成新邀请码'}
        </button>
      </div>

      {error && <p className="text-sm text-blush">{error}</p>}

      {loading ? (
        <p className="text-sm text-ink-400">加载中…</p>
      ) : codes.length === 0 ? (
        <p className="text-sm text-ink-400">还没有生成过邀请码。</p>
      ) : (
        <ul className="divide-y divide-ink-800/60">
          {codes.map((code) => {
            const status = statusOf(code);
            return (
              <li key={code.id} className="flex items-center justify-between gap-3 py-2.5">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <code className="truncate font-mono text-sm text-ink-100">{code.code}</code>
                    <span className={`rounded-full px-2 py-0.5 text-[10px] ${status.className}`}>
                      {status.label}
                    </span>
                  </div>
                  <p className="mt-0.5 text-[11px] text-ink-400">
                    由 {code.createdBy ?? '未知'} 创建于 {code.createdAt.slice(0, 10)}
                    {code.usedBy && ` · ${code.usedAt?.slice(0, 10)} 被 ${code.usedBy} 使用`}
                  </p>
                </div>
                {!code.usedBy && (
                  <button
                    type="button"
                    className="btn-ghost shrink-0 px-2.5 py-1 text-xs text-blush"
                    disabled={busy}
                    onClick={() => void revoke(code.id)}
                  >
                    作废
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {freshCode && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink-950/60 p-4">
          <div className="card w-full max-w-sm space-y-4 p-6">
            <h3 className="text-sm font-semibold text-ink-100">新邀请码（只显示这一次）</h3>
            <div className="flex items-center gap-2">
              <code className="input flex-1 bg-paper font-mono text-base">{freshCode}</code>
              <button type="button" className="btn-ghost px-3 py-1.5 text-xs" onClick={() => void copyFresh()}>
                {copied ? '已复制' : '复制'}
              </button>
            </div>
            <button
              type="button"
              className="btn-primary w-full"
              onClick={() => {
                setFreshCode(null);
                setCopied(false);
              }}
            >
              我已保存，关闭
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
