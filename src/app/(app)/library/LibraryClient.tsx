'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import EmptyState from '@/components/EmptyState';
import Modal from '@/components/Modal';
import { formatBytes, formatDate, thumbUrl } from '@/lib/media';
import type { Asset } from '@/lib/types';

export default function LibraryClient() {
  const [assets, setAssets] = useState<Asset[]>([]);
  const [loading, setLoading] = useState(true);
  const [keyword, setKeyword] = useState('');
  const [debounced, setDebounced] = useState('');
  const [scope, setScope] = useState<'all' | 'my' | 'trash'>('all');
  const [selected, setSelected] = useState<Set<number>>(() => new Set());
  const [uploading, setUploading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [notice, setNotice] = useState<{ type: 'error' | 'ok'; text: string } | null>(null);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editingTitle, setEditingTitle] = useState('');
  const [pendingDelete, setPendingDelete] = useState<number[] | null>(null);
  /** 回收站里等待彻底删除的素材（二次确认） */
  const [pendingPurge, setPendingPurge] = useState<number[] | null>(null);
  const [urlModalOpen, setUrlModalOpen] = useState(false);
  const [urlText, setUrlText] = useState('');
  const [importing, setImporting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async (query: string, target: 'all' | 'my' | 'trash') => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ scope: target });
      if (query) params.set('q', query);
      const res = await fetch(`/api/assets?${params.toString()}`);
      const data = await res.json();
      setAssets(Array.isArray(data.assets) ? data.assets : []);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(keyword.trim()), 250);
    return () => clearTimeout(timer);
  }, [keyword]);

  useEffect(() => {
    void load(debounced, scope);
  }, [debounced, scope, load]);

  const upload = useCallback(
    async (files: File[]) => {
      if (files.length === 0) return;
      setUploading(true);
      setNotice(null);
      try {
        const form = new FormData();
        for (const file of files) form.append('files', file);
        const res = await fetch('/api/assets', { method: 'POST', body: form });
        const data = await res.json();
        if (!res.ok) {
          setNotice({ type: 'error', text: data.error ?? '上传失败' });
          return;
        }
        setNotice(
          data.errors?.length
            ? {
                type: 'error',
                text: `${data.assets.length} 张成功；失败：${data.errors.join('；')}`,
              }
            : { type: 'ok', text: `已上传 ${data.assets.length} 张图片` },
        );
        await load(debounced, scope);
      } catch {
        setNotice({ type: 'error', text: '上传过程中发生网络错误' });
      } finally {
        setUploading(false);
      }
    },
    [debounced, scope, load],
  );

  // Ctrl+V 直接粘贴剪贴板里的图片，省掉「先保存文件再选文件」这一步
  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && ['INPUT', 'TEXTAREA'].includes(target.tagName)) return;
      const files = Array.from(event.clipboardData?.files ?? []);
      if (files.length > 0) {
        event.preventDefault();
        void upload(files);
      }
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [upload]);

  async function importByUrls() {
    const urls = urlText
      .split(/[\n\r,，\s]+/)
      .map((item) => item.trim())
      .filter(Boolean);
    if (urls.length === 0) {
      setNotice({ type: 'error', text: '请至少填写一个图片链接' });
      return;
    }
    setImporting(true);
    setNotice(null);
    try {
      const res = await fetch('/api/assets/from-url', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ urls, shared: true }),
      });
      const data = await res.json();
      if (!res.ok) {
        setNotice({ type: 'error', text: data.error ?? '导入失败' });
        return;
      }
      setNotice(
        data.errors?.length
          ? {
              type: 'error',
              text: `${data.assets.length} 张成功；失败：${data.errors.join('；')}`,
            }
          : { type: 'ok', text: `已导入 ${data.assets.length} 张图片` },
      );
      setUrlText('');
      setUrlModalOpen(false);
      await load(debounced, scope);
    } catch {
      setNotice({ type: 'error', text: '导入过程中发生网络错误' });
    } finally {
      setImporting(false);
    }
  }

  async function confirmDelete() {
    if (!pendingDelete) return;
    const ids = pendingDelete;
    setPendingDelete(null);
    try {
      const res = await fetch('/api/assets', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids }),
      });
      const data = await res.json();
      if (!res.ok) {
        setNotice({ type: 'error', text: data.error ?? '删除失败' });
        return;
      }
      setSelected((prev) => {
        const next = new Set(prev);
        for (const id of ids) next.delete(id);
        return next;
      });
      setNotice({
        type: 'ok',
        text:
          data.detachedFromSpaces > 0
            ? `已删除 ${data.deleted} 张图片，并从 ${data.detachedFromSpaces} 处空间引用中移除`
            : `已删除 ${data.deleted} 张图片`,
      });
      await load(debounced, scope);
    } catch {
      setNotice({ type: 'error', text: '删除过程中发生网络错误' });
    }
  }

  /** 回收站操作：恢复 / 彻底删除 */
  async function trashAction(ids: number[], action: 'restore' | 'purge') {
    try {
      const res = await fetch('/api/assets/trash', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids, action }),
      });
      const data = await res.json();
      if (!res.ok) {
        setNotice({ type: 'error', text: data.error ?? '操作失败' });
        return;
      }
      setNotice({
        type: 'ok',
        text:
          action === 'restore'
            ? `已恢复 ${data.affected} 张图片（空间引用需重新添加）`
            : `已彻底删除 ${data.affected} 张图片，磁盘文件已清理`,
      });
      setSelected(new Set());
      await load(debounced, scope);
    } catch {
      setNotice({ type: 'error', text: '操作过程中发生网络错误' });
    }
  }

  async function saveTitle(id: number) {
    const title = editingTitle.trim();
    setEditingId(null);
    if (!title) return;
    const before = assets.find((a) => a.id === id)?.title ?? '';
    if (title === before) return;
    setAssets((prev) => prev.map((a) => (a.id === id ? { ...a, title } : a)));
    const res = await fetch(`/api/assets/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title }),
    });
    if (!res.ok) {
      setNotice({ type: 'error', text: '重命名失败' });
      await load(debounced, scope);
    }
  }

  function toggleSelect(id: number) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const isMine = scope === 'my';
  const inTrash = scope === 'trash';
  const allSelected = assets.length > 0 && assets.every((a) => selected.has(a.id));

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-3">
        <div className="seg">
          {(
            [
              ['all', '公共图库'],
              ['my', '我上传的'],
              ['trash', '回收站'],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              onClick={() => {
                setScope(value);
                setSelected(new Set());
              }}
              className={`seg-btn ${scope === value ? 'seg-btn-on' : ''}`}
            >
              {label}
            </button>
          ))}
        </div>

        <input
          className="input max-w-xs"
          placeholder="搜索图片名称…"
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
        />
        {!inTrash && (
          <>
            <button
              type="button"
              className="btn-primary"
              disabled={uploading}
              onClick={() => fileInputRef.current?.click()}
            >
              {uploading ? '上传中…' : '上传图片'}
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              multiple
              className="hidden"
              onChange={(e) => {
                void upload(Array.from(e.target.files ?? []));
                e.target.value = '';
              }}
            />
            <button type="button" className="btn-ghost" onClick={() => setUrlModalOpen(true)}>
              链接导入
            </button>

            <label className="flex items-center gap-1.5 text-sm text-ink-400" title="开放图库：上传即进入公共池，所有人可见可用">
              <input type="checkbox" checked disabled className="h-4 w-4 rounded border-ink-700 bg-white accent-sky" />
              上传即共享
            </label>
          </>
        )}

        {selected.size > 0 && (
          <>
            <span className="text-sm text-ink-400">已选 {selected.size} 张</span>
            {isMine && (
              <button
                type="button"
                className="btn-danger"
                onClick={() => setPendingDelete([...selected])}
              >
                删除所选
              </button>
            )}
            {inTrash && (
              <>
                <button
                  type="button"
                  className="btn-ghost"
                  onClick={() => void trashAction([...selected], 'restore')}
                >
                  恢复所选
                </button>
                <button
                  type="button"
                  className="btn-danger"
                  onClick={() => setPendingPurge([...selected])}
                >
                  彻底删除所选
                </button>
              </>
            )}
            <button type="button" className="btn-ghost" onClick={() => setSelected(new Set())}>
              取消选择
            </button>
          </>
        )}

        {assets.length > 0 && (
          <label className="ml-auto flex items-center gap-2 text-sm text-ink-400">
            <input
              type="checkbox"
              checked={allSelected}
              onChange={(e) =>
                setSelected(e.target.checked ? new Set(assets.map((a) => a.id)) : new Set())
              }
              className="h-4 w-4 rounded border-ink-700 bg-white accent-sky"
            />
            全选
          </label>
        )}
      </div>

      {notice && (
        <div className={notice.type === 'error' ? 'notice-error' : 'notice-ok'}>
          {notice.text}
        </div>
      )}

      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          if (inTrash) return;
          void upload(Array.from(e.dataTransfer.files));
        }}
        className={`rounded-xl border-2 border-dashed transition-colors ${
          dragging ? 'border-sky bg-sky/5' : 'border-ink-700'
        }`}
      >
        {loading ? (
          <p className="py-20 text-center text-sm text-ink-500">加载中…</p>
        ) : assets.length === 0 ? (
          <EmptyState
            padded={false}
            showMascot={!debounced}
            kaomoji={debounced ? '(・・?)' : '(´∀｀)♡'}
            title={
              debounced
                ? '没有匹配的图片'
                : inTrash
                  ? '回收站是空的'
                  : isMine
                    ? '你还没有上传过图片'
                    : '公共图库还是空的'
            }
            hint={
              <>
                点击「上传图片」，把文件拖到这里，或直接
                <kbd className="mx-1 rounded bg-paper px-1 py-0.5 text-ink-300">Ctrl</kbd>+
                <kbd className="mx-1 rounded bg-paper px-1 py-0.5 text-ink-300">V</kbd>
                粘贴
              </>
            }
          />
        ) : (
          <div className="grid grid-cols-2 gap-3 p-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6">
            {assets.map((asset) => {
              const active = selected.has(asset.id);
              return (
                <div
                  key={asset.id}
                  className={`group relative overflow-hidden rounded-lg border bg-cloud transition-all ${
                    active ? 'border-sky ring-1 ring-sky' : 'border-ink-700'
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => toggleSelect(asset.id)}
                    className="block w-full"
                    title={asset.original_name ?? undefined}
                  >
                    <div className="aspect-square w-full overflow-hidden bg-paper">
                      <img
                        src={thumbUrl(asset.thumb_filename, asset.filename)}
                        alt={asset.title ?? asset.original_name ?? ''}
                        loading="lazy"
                        className="h-full w-full object-cover transition-transform group-hover:scale-[1.03]"
                      />
                    </div>
                  </button>

                  <label className="absolute left-2 top-2 flex h-5 w-5 cursor-pointer items-center justify-center">
                    <input
                      type="checkbox"
                      checked={active}
                      onChange={() => toggleSelect(asset.id)}
                      className="h-4 w-4 rounded border-ink-700 bg-white/80 accent-sky"
                    />
                  </label>

                  {isMine && (
                    <button
                      type="button"
                      onClick={() => setPendingDelete([asset.id])}
                      className="absolute right-2 top-2 hidden rounded-md bg-cloud/90 px-1.5 py-0.5 text-xs text-blush hover:bg-blush/15 group-hover:block"
                    >
                      删除
                    </button>
                  )}

                  {inTrash && (
                    <div className="absolute right-2 top-2 flex gap-1">
                      <button
                        type="button"
                        onClick={() => void trashAction([asset.id], 'restore')}
                        className="rounded-md bg-cloud/90 px-1.5 py-0.5 text-xs text-emerald-700 hover:bg-emerald-500/15"
                        title="恢复到图库"
                      >
                        恢复
                      </button>
                      <button
                        type="button"
                        onClick={() => setPendingPurge([asset.id])}
                        className="rounded-md bg-cloud/90 px-1.5 py-0.5 text-xs text-blush hover:bg-blush/15"
                        title="彻底删除（不可恢复）"
                      >
                        彻底删除
                      </button>
                    </div>
                  )}

                  <div className="p-2">
                    {editingId === asset.id && isMine ? (
                      <input
                        autoFocus
                        className="input px-2 py-1 text-xs"
                        value={editingTitle}
                        onChange={(e) => setEditingTitle(e.target.value)}
                        onBlur={() => void saveTitle(asset.id)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') void saveTitle(asset.id);
                          if (e.key === 'Escape') setEditingId(null);
                        }}
                      />
                    ) : (
                      <button
                        type="button"
                        disabled={!isMine}
                        onClick={() => {
                          if (!isMine) return;
                          setEditingId(asset.id);
                          setEditingTitle(asset.title ?? '');
                        }}
                        className={`block w-full truncate text-left text-xs ${
                          isMine ? 'text-ink-200 hover:text-sky-deep' : 'cursor-default text-ink-400'
                        }`}
                        title={isMine ? '点击重命名' : '只有上传者可以重命名'}
                      >
                        {asset.title || asset.original_name || '未命名'}
                      </button>
                    )}
                    <p className="mt-1 truncate text-[11px] text-ink-500">
                      {asset.width && asset.height ? `${asset.width}×${asset.height} · ` : ''}
                      {formatBytes(asset.size_bytes)}
                      {!isMine && asset.owner_username ? ` · ${asset.owner_username}` : ''}
                    </p>
                    <p className="truncate text-[11px] text-ink-400">{formatDate(asset.created_at)}</p>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <Modal
        open={pendingDelete !== null}
        title="删除图片"
        onClose={() => setPendingDelete(null)}
        footer={
          <>
            <button type="button" className="btn-ghost" onClick={() => setPendingDelete(null)}>
              取消
            </button>
            <button type="button" className="btn-danger" onClick={() => void confirmDelete()}>
              确认删除
            </button>
          </>
        }
      >
        <p className="text-sm text-ink-200">
          将把 {pendingDelete?.length ?? 0} 张图片移入回收站。若这些图片已加入空间，会从空间中移除
          （标注一并删除）；图片本身可在回收站恢复，此操作可撤销。
        </p>
      </Modal>

      <Modal
        open={pendingPurge !== null}
        title="彻底删除"
        onClose={() => setPendingPurge(null)}
        footer={
          <>
            <button type="button" className="btn-ghost" onClick={() => setPendingPurge(null)}>
              取消
            </button>
            <button
              type="button"
              className="btn-danger"
              onClick={() => {
                const ids = pendingPurge;
                setPendingPurge(null);
                if (ids) void trashAction(ids, 'purge');
              }}
            >
              彻底删除
            </button>
          </>
        }
      >
        <p className="text-sm text-ink-200">
          将彻底删除 {pendingPurge?.length ?? 0} 张图片，磁盘文件一并清理，此操作不可恢复。
        </p>
      </Modal>

      <Modal
        open={urlModalOpen}
        title="用图片链接导入"
        width="max-w-xl"
        onClose={() => setUrlModalOpen(false)}
        footer={
          <>
            <button type="button" className="btn-ghost" onClick={() => setUrlModalOpen(false)}>
              取消
            </button>
            <button
              type="button"
              className="btn-primary"
              disabled={importing}
              onClick={() => void importByUrls()}
            >
              {importing ? '导入中…' : '开始导入'}
            </button>
          </>
        }
      >
        <p className="mb-3 text-xs leading-relaxed text-ink-400">
          在推特上右键图片选择「复制图片地址」，把 <code className="text-ink-200">pbs.twimg.com</code>{' '}
          链接粘贴到下面，一行一个或空格分隔，最多 20 个。
          服务器会直接下载图片，不经过 X API，不产生任何接口费用。
        </p>
        <textarea
          className="input min-h-[160px] resize-y font-mono text-xs"
          placeholder={'https://pbs.twimg.com/media/xxxxx?format=jpg\nhttps://pbs.twimg.com/media/yyyyy?format=jpg'}
          value={urlText}
          onChange={(e) => setUrlText(e.target.value)}
          autoFocus
        />
        <p className="mt-2 text-[11px] text-ink-400">
          仅支持 http/https 直链，单张不超过 20MB，单次最多 20 个链接。
        </p>
      </Modal>
    </div>
  );
}
