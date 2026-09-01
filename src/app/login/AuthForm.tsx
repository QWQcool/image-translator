'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

export default function AuthForm() {
  const router = useRouter();
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      const res = await fetch(`/api/auth/${mode}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? '操作失败');
        return;
      }
      router.replace('/spaces');
      router.refresh();
    } catch {
      setError('网络错误，请重试');
    } finally {
      setPending(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-xl bg-brand-500/15 text-2xl">
            🖼️
          </div>
          <h1 className="text-2xl font-semibold text-white">图译空间</h1>
          <p className="mt-1.5 text-sm text-ink-400">图片收集 · 空间分组 · 图上文字标注</p>
        </div>

        <div className="card p-6">
          <div className="mb-5 grid grid-cols-2 gap-1 rounded-lg bg-ink-950 p-1">
            {(
              [
                ['login', '登录'],
                ['register', '注册'],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                onClick={() => {
                  setMode(value);
                  setError(null);
                }}
                className={`rounded-md py-1.5 text-sm font-medium transition-colors ${
                  mode === value ? 'bg-ink-800 text-white' : 'text-ink-400 hover:text-ink-200'
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          <form onSubmit={submit} className="space-y-4">
            <div>
              <label className="label" htmlFor="username">
                用户名
              </label>
              <input
                id="username"
                className="input"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoComplete="username"
                required
              />
            </div>
            <div>
              <label className="label" htmlFor="password">
                密码
              </label>
              <input
                id="password"
                type="password"
                className="input"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                required
              />
              {mode === 'register' && (
                <p className="mt-1.5 text-xs text-ink-500">密码至少 8 位</p>
              )}
            </div>

            {error && (
              <p className="rounded-lg border border-red-900/60 bg-red-950/40 px-3 py-2 text-sm text-red-300">
                {error}
              </p>
            )}

            <button type="submit" className="btn-primary w-full" disabled={pending}>
              {pending ? '处理中…' : mode === 'login' ? '登录' : '注册并登录'}
            </button>
          </form>
        </div>
      </div>
    </main>
  );
}
