'use client';

import { useCallback, useEffect, useState } from 'react';
import Modal from '@/components/Modal';
import { thumbUrl } from '@/lib/media';
import type { Asset } from '@/lib/types';

export default function AddImagesModal({
  open,
  spaceId,
  existingAssetIds,
  onClose,
  onAdded,
}: {
  open: boolean;
  spaceId: number;
  existingAssetIds: number[];
  onClose: () => void;
  onAdded: (count: number) => void;
}) {
  const [assets, setAssets] = useState<Asset[]>([]);
  const [loading, setLoading] = useState(false);
  const [keyword, setKeyword] = useState('');
  const [debounced, setDebounced] = useState('');
  const [scope, setScope] = useState<'my' | 'shared'>('my');
  const [picked, setPicked] = useState<Set<number>>(() => new Set());
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(async (query: string, target: 'my' | 'shared') => {
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
    if (!open) return;
    const timer = setTimeout(() => setDebounced(keyword.trim()), 250);
    return () => clearTimeout(timer);
  }, [keyword, open]);

  useEffect(() => {
    if (!open) return;
    void load(debounced, scope);
  }, [debounced, scope, load, open]);

  useEffect(() => {
    if (open) {
      setPicked(new Set());
      setKeyword('');
    }
  }, [open]);

  const existing = new Set(existingAssetIds);

  async function submit() {
    if (picked.size === 0) return;
    setSubmitting(true);
    try {
      const res = await fetch(`/api/spaces/${spaceId}/items`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ assetIds: [...picked] }),
      });
      const data = await res.json();
      if (!res.ok) return;
      onAdded(data.added ?? picked.size);
      onClose();
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal
      open={open}
      title="从图库添加图片"
      width="max-w-4xl"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn-ghost" onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            className="btn-primary"
            disabled={picked.size === 0 || submitting}
            onClick={() => void submit()}
          >
            {submitting ? '添加中…' : `添加所选（${picked.size}）`}
          </button>
        </>
      }
    >
      <div className="mb-3 flex rounded-lg bg-ink-950 p-1">
        {(
          [
            ['my', '我的图库'],
            ['shared', '共享图库'],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            onClick={() => setScope(value)}
            className={`flex-1 rounded-md px-3 py-1.5 text-sm transition-colors ${
              scope === value ? 'bg-ink-800 text-white' : 'text-ink-400 hover:text-ink-200'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      <input
        className="input mb-4"
        placeholder="搜索图片名称…"
        value={keyword}
        onChange={(e) => setKeyword(e.target.value)}
      />

      {loading ? (
        <p className="py-16 text-center text-sm text-ink-500">加载中…</p>
      ) : assets.length === 0 ? (
        <p className="py-16 text-center text-sm text-ink-500">
          {scope === 'shared' ? '共享图库还没有内容' : '图库为空，请先到「图库」上传图片'}
        </p>
      ) : (
        <div className="max-h-[55vh] overflow-y-auto pr-1">
          <div className="grid grid-cols-3 gap-3 sm:grid-cols-4 lg:grid-cols-5">
            {assets.map((asset) => {
              const already = existing.has(asset.id);
              const active = picked.has(asset.id);
              return (
                <button
                  key={asset.id}
                  type="button"
                  disabled={already}
                  onClick={() =>
                    setPicked((prev) => {
                      const next = new Set(prev);
                      if (next.has(asset.id)) next.delete(asset.id);
                      else next.add(asset.id);
                      return next;
                    })
                  }
                  className={`relative overflow-hidden rounded-lg border transition-all ${
                    already
                      ? 'cursor-not-allowed border-ink-800 opacity-35'
                      : active
                        ? 'border-brand-500 ring-1 ring-brand-500'
                        : 'border-ink-800 hover:border-ink-600'
                  }`}
                >
                  <div className="aspect-square w-full overflow-hidden bg-ink-950">
                    <img
                      src={thumbUrl(asset.thumb_filename, asset.filename)}
                      alt=""
                      loading="lazy"
                      className="h-full w-full object-cover"
                    />
                  </div>
                  {already && (
                    <span className="absolute inset-0 flex items-center justify-center bg-ink-950/70 text-[11px] text-ink-300">
                      已在空间
                    </span>
                  )}
                  <p className="truncate px-1.5 py-1 text-[11px] text-ink-400">
                    {asset.title || asset.original_name || '未命名'}
                  </p>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </Modal>
  );
}
