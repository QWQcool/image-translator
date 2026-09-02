'use client';

import { useGSAP } from '@gsap/react';
import gsap from 'gsap';
import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';

gsap.registerPlugin(useGSAP);

export default function AuthForm({ nextPath }: { nextPath: string }) {
  const router = useRouter();
  const rootRef = useRef<HTMLElement>(null);
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [inviteCode, setInviteCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useGSAP(
    () => {
      const mm = gsap.matchMedia();
      mm.add(
        {
          reduceMotion: '(prefers-reduced-motion: reduce)',
          motionOK: '(prefers-reduced-motion: no-preference)',
        },
        (context) => {
          const reduceMotion = Boolean(context.conditions?.reduceMotion);
          gsap.from('.auth-enter', {
            autoAlpha: 0,
            y: reduceMotion ? 0 : 28,
            duration: reduceMotion ? 0 : 0.7,
            stagger: reduceMotion ? 0 : 0.2,
            ease: 'power2.out',
          });
        },
        rootRef,
      );
      return () => mm.revert();
    },
    { scope: rootRef },
  );

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      const res = await fetch(`/api/auth/${mode}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          mode === 'register' ? { username, password, inviteCode } : { username, password },
        ),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? '操作失败');
        return;
      }
      router.replace(nextPath);
      router.refresh();
    } catch {
      setError('网络错误，请重试');
    } finally {
      setPending(false);
    }
  }

  return (
    <main
      ref={rootRef}
      className="relative z-[1] mx-auto flex min-h-screen w-full max-w-6xl flex-col lg:flex-row lg:items-center"
    >
      <section className="auth-enter flex flex-1 flex-col items-center justify-center px-6 pb-2 pt-10 text-center lg:items-start lg:px-12 lg:py-16 lg:text-left">
        <img
          src="/mascot/mascot-stand.png"
          alt="图译空间吉祥物：短发学院翻译员"
          className="h-44 w-auto object-contain drop-shadow-sm sm:h-56 lg:h-[26rem]"
        />
        <h1 className="font-display mt-4 text-3xl tracking-wide text-ink-100 sm:text-4xl">图译空间</h1>
        <p className="mt-2 max-w-sm text-sm leading-relaxed text-ink-400">
          圈出原文，写下译文。把图上的话，译成看得懂的一句。
        </p>
      </section>

      <section className="auth-enter flex flex-1 items-start justify-center px-4 pb-16 pt-4 lg:items-center lg:px-12 lg:py-16">
        <div className="card w-full max-w-sm p-6">
          <div className="seg mb-5 grid grid-cols-2 gap-1">
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
                className={`seg-btn ${mode === value ? 'seg-btn-on' : ''}`}
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
                className="input"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                required
              />
              {mode === 'register' && <p className="mt-1.5 text-xs text-ink-500">密码至少 8 位</p>}
            </div>

            {mode === 'register' && (
              <div>
                <label className="label" htmlFor="invite-code">
                  邀请码
                </label>
                <input
                  id="invite-code"
                  className="input"
                  value={inviteCode}
                  onChange={(e) => setInviteCode(e.target.value)}
                  placeholder="向管理员索取"
                  autoComplete="off"
                  required
                />
                <p className="mt-1.5 text-xs text-ink-500">没有有效邀请码无法注册。</p>
              </div>
            )}

            {error && <p className="notice-error">{error}</p>}

            <button type="submit" className="btn-primary w-full" disabled={pending}>
              {pending ? '处理中…' : mode === 'login' ? '登录' : '注册并登录'}
            </button>
          </form>
        </div>
      </section>
    </main>
  );
}
