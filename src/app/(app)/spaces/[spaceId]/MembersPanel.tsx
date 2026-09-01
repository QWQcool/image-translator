'use client';

import { useCallback, useEffect, useState } from 'react';
import Modal from '@/components/Modal';
import type { SpaceMember, SpaceRole } from '@/lib/types';

export const ROLE_LABEL: Record<SpaceRole, string> = {
  owner: '所有者',
  editor: '可编辑',
  viewer: '只读',
};

export const ROLE_HINT: Record<SpaceRole, string> = {
  owner: '可增删改、管理成员、删除空间',
  editor: '可增删改图片与标注',
  viewer: '只能查看和导出',
};

const ROLE_STYLE: Record<SpaceRole, string> = {
  owner: 'bg-sky/15 text-sky-deep',
  editor: 'bg-emerald-500/15 text-emerald-700',
  viewer: 'bg-ink-800 text-ink-400',
};

export default function MembersPanel({
  spaceId,
  canManage,
  onChanged,
}: {
  spaceId: number;
  canManage: boolean;
  onChanged: () => void;
}) {
  const [currentUserId, setCurrentUserId] = useState(0);

  useEffect(() => {
    void fetch('/api/auth/me')
      .then((res) => res.json())
      .then((data) => setCurrentUserId(data.user?.id ?? 0))
      .catch(() => setCurrentUserId(0));
  }, []);
  const [open, setOpen] = useState(false);
  const [members, setMembers] = useState<SpaceMember[]>([]);
  const [loading, setLoading] = useState(false);
  const [keyword, setKeyword] = useState('');
  const [results, setResults] = useState<Array<{ id: number; username: string }>>([]);
  const [role, setRole] = useState<SpaceRole>('editor');
  const [error, setError] = useState<string | null>(null);

  const loadMembers = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/spaces/${spaceId}/members`);
      const data = await res.json();
      setMembers(Array.isArray(data.members) ? data.members : []);
    } finally {
      setLoading(false);
    }
  }, [spaceId]);

  useEffect(() => {
    if (open) void loadMembers();
  }, [open, loadMembers]);

  useEffect(() => {
    if (!open || keyword.trim().length === 0) {
      setResults([]);
      return;
    }
    const timer = setTimeout(async () => {
      const res = await fetch(`/api/users/search?q=${encodeURIComponent(keyword.trim())}`);
      const data = await res.json();
      setResults(Array.isArray(data.users) ? data.users : []);
    }, 250);
    return () => clearTimeout(timer);
  }, [keyword, open]);

  async function addMember(userId: number) {
    setError(null);
    const res = await fetch(`/api/spaces/${spaceId}/members`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, role }),
    });
    if (!res.ok) {
      const data = await res.json();
      setError(data.error ?? '添加失败');
      return;
    }
    setKeyword('');
    setResults([]);
    await loadMembers();
    onChanged();
  }

  async function changeRole(userId: number, nextRole: SpaceRole) {
    setError(null);
    const res = await fetch(`/api/spaces/${spaceId}/members/${userId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: nextRole }),
    });
    if (!res.ok) {
      const data = await res.json();
      setError(data.error ?? '修改失败');
      return;
    }
    await loadMembers();
    onChanged();
  }

  async function removeMember(userId: number) {
    setError(null);
    const res = await fetch(`/api/spaces/${spaceId}/members/${userId}`, { method: 'DELETE' });
    if (!res.ok) {
      const data = await res.json();
      setError(data.error ?? '移除失败');
      return;
    }
    await loadMembers();
    onChanged();
  }

  const memberIds = new Set(members.map((m) => m.user_id));

  return (
    <>
      <button type="button" className="btn-ghost" onClick={() => setOpen(true)}>
        成员 <span className="text-ink-500">({members.length || '·'})</span>
      </button>

      <Modal
        open={open}
        title="空间成员与权限"
        width="max-w-2xl"
        onClose={() => setOpen(false)}
        footer={
          <button type="button" className="btn-ghost" onClick={() => setOpen(false)}>
            关闭
          </button>
        }
      >
        <div className="space-y-4">
          {error && (
            <p className="notice-error">{error}</p>
          )}

          <div>
            <h3 className="label">权限说明</h3>
            <div className="grid gap-2 sm:grid-cols-3">
              {(['owner', 'editor', 'viewer'] as SpaceRole[]).map((item) => (
                <div key={item} className="rounded-lg border border-ink-700 bg-paper p-2.5">
                  <span className={`rounded px-1.5 py-0.5 text-[11px] ${ROLE_STYLE[item]}`}>
                    {ROLE_LABEL[item]}
                  </span>
                  <p className="mt-1.5 text-[11px] leading-relaxed text-ink-500">
                    {ROLE_HINT[item]}
                  </p>
                </div>
              ))}
            </div>
          </div>

          {canManage && (
            <div>
              <h3 className="label">添加成员</h3>
              <div className="flex gap-2">
                <input
                  className="input flex-1"
                  placeholder="搜索用户名…"
                  value={keyword}
                  onChange={(e) => setKeyword(e.target.value)}
                />
                <select
                  className="input w-28"
                  value={role}
                  onChange={(e) => setRole(e.target.value as SpaceRole)}
                >
                  <option value="editor">可编辑</option>
                  <option value="viewer">只读</option>
                  <option value="owner">所有者</option>
                </select>
              </div>

              {results.length > 0 && (
                <div className="mt-2 overflow-hidden rounded-lg border border-ink-700">
                  {results.map((item) => (
                    <div
                      key={item.id}
                      className="flex items-center justify-between border-b border-ink-700 px-3 py-2 last:border-b-0"
                    >
                      <span className="text-sm text-ink-200">{item.username}</span>
                      {memberIds.has(item.id) ? (
                        <span className="text-[11px] text-ink-500">已在空间内</span>
                      ) : (
                        <button
                          type="button"
                          className="btn-primary px-2.5 py-1 text-xs"
                          onClick={() => void addMember(item.id)}
                        >
                          添加
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          <div>
            <h3 className="label">当前成员</h3>
            {loading ? (
              <p className="py-6 text-center text-sm text-ink-500">加载中…</p>
            ) : (
              <div className="max-h-64 overflow-y-auto rounded-lg border border-ink-700">
                {members.map((member) => (
                  <div
                    key={member.id}
                    className="flex items-center gap-3 border-b border-ink-700 px-3 py-2.5 last:border-b-0"
                  >
                    <span className="flex-1 truncate text-sm text-ink-200">
                      {member.username ?? `用户 #${member.user_id}`}
                      {member.user_id === currentUserId && (
                        <span className="ml-1.5 text-[11px] text-ink-500">（我）</span>
                      )}
                    </span>

                    {canManage ? (
                      <>
                        <select
                          className="input w-24 py-1 text-xs"
                          value={member.role}
                          onChange={(e) => void changeRole(member.user_id, e.target.value as SpaceRole)}
                        >
                          <option value="owner">所有者</option>
                          <option value="editor">可编辑</option>
                          <option value="viewer">只读</option>
                        </select>
                        <button
                          type="button"
                          className="rounded px-1.5 py-0.5 text-xs text-blush hover:bg-blush/15"
                          onClick={() => void removeMember(member.user_id)}
                        >
                          移除
                        </button>
                      </>
                    ) : (
                      <span className={`rounded px-1.5 py-0.5 text-[11px] ${ROLE_STYLE[member.role]}`}>
                        {ROLE_LABEL[member.role]}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </Modal>
    </>
  );
}
