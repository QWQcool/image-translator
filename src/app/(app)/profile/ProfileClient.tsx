'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import InviteAdminCard from './InviteAdminCard';

type Profile = {
  id: number;
  username: string;
  display_name: string | null;
  avatar_url: string | null;
  is_admin: boolean;
  created_at: string;
};

export default function ProfileClient() {
  const router = useRouter();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [displayName, setDisplayName] = useState('');
  const [notice, setNotice] = useState<{ type: 'ok' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch('/api/profile');
        const data = await res.json();
        setProfile(data.profile);
        setDisplayName(data.profile.display_name ?? '');
      } catch {
        setNotice({ type: 'error', text: '资料加载失败' });
      }
    })();
  }, []);

  async function saveName() {
    setBusy(true);
    setNotice(null);
    try {
      const res = await fetch('/api/profile', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ display_name: displayName }),
      });
      const data = await res.json();
      if (!res.ok) {
        setNotice({ type: 'error', text: data.error ?? '保存失败' });
        return;
      }
      setProfile(data.profile);
      setNotice({ type: 'ok', text: '昵称已保存' });
      // 顶栏由服务端布局渲染，昵称/头像变更后要刷新一次
      router.refresh();
    } catch {
      setNotice({ type: 'error', text: '保存过程中发生网络错误' });
    } finally {
      setBusy(false);
    }
  }

  async function uploadAvatar(file: File) {
    setBusy(true);
    setNotice(null);
    try {
      const form = new FormData();
      form.append('file', file);
      const res = await fetch('/api/profile', { method: 'POST', body: form });
      const data = await res.json();
      if (!res.ok) {
        setNotice({ type: 'error', text: data.error ?? '头像上传失败' });
        return;
      }
      setProfile(data.profile);
      setPreviewUrl(null);
      setNotice({ type: 'ok', text: '头像已更新' });
      router.refresh();
    } catch {
      setNotice({ type: 'error', text: '上传过程中发生网络错误' });
    } finally {
      setBusy(false);
    }
  }

  const avatarSrc = previewUrl ?? profile?.avatar_url ?? '/mascot/mascot-bust.png';

  return (
    <div className="space-y-5">
      <div>
        <h1 className="font-display text-xl text-ink-100">个人空间</h1>
        <p className="mt-1 text-sm text-ink-400">
          昵称与头像只用于展示。系统日志与标注记录里仍然记你的注册账号名「{profile?.username ?? '…'}」。
        </p>
      </div>

      <div className="card max-w-xl space-y-5 p-6">
        <div className="flex items-center gap-4">
          <img
            src={avatarSrc}
            alt="头像"
            className="h-20 w-20 rounded-full object-cover object-top ring-2 ring-halo/70"
          />
          <div className="space-y-2">
            <div className="flex gap-2">
              <button
                type="button"
                className="btn-ghost px-3 py-1.5 text-xs"
                disabled={busy}
                onClick={() => fileRef.current?.click()}
              >
                更换头像
              </button>
              {profile?.avatar_url && (
                <button
                  type="button"
                  className="btn-ghost px-3 py-1.5 text-xs"
                  disabled={busy}
                  onClick={() => {
                    void (async () => {
                      const res = await fetch('/api/profile', {
                        method: 'PATCH',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ remove_avatar: true }),
                      });
                      const data = await res.json();
                      if (res.ok) {
                        setProfile(data.profile);
                        setNotice({ type: 'ok', text: '头像已移除' });
                        router.refresh();
                      }
                    })();
                  }}
                >
                  移除头像
                </button>
              )}
            </div>
            <p className="text-[11px] text-ink-500">支持 jpg / png / webp，最大 5MB，自动裁成方形。</p>
          </div>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void uploadAvatar(file);
              e.target.value = '';
            }}
          />
        </div>

        <label className="block text-sm">
          <span className="label">昵称（展示用，可随时改）</span>
          <input
            className="input mt-1"
            maxLength={24}
            placeholder={profile?.username ?? ''}
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
          />
        </label>

        <label className="block text-sm">
          <span className="label">注册账号名（不可改，日志与记录用）</span>
          <input className="input mt-1 bg-paper" value={profile?.username ?? ''} disabled />
        </label>

        <div className="flex items-center gap-3">
          <button type="button" className="btn-primary" disabled={busy} onClick={() => void saveName()}>
            {busy ? '保存中…' : '保存昵称'}
          </button>
          {profile && (
            <span className="text-xs text-ink-400">注册于 {profile.created_at.slice(0, 10)}</span>
          )}
        </div>

        {notice && (
          <p className={notice.type === 'ok' ? 'text-sm text-emerald-700' : 'text-sm text-blush'}>
            {notice.text}
          </p>
        )}
      </div>

      {/* 权限扁平化后唯一保留的特权：管理员发放注册邀请码 */}
      {profile?.is_admin && <InviteAdminCard />}
    </div>
  );
}
