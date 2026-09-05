'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import EmptyState from '@/components/EmptyState';
import Modal from '@/components/Modal';
import ProgressBadge from '@/components/ProgressBadge';
import TagPicker from '@/components/TagPicker';
import { formatBytes, formatDate, originalUrl, thumbUrl } from '@/lib/media';
import { type SpaceProgress } from '@/lib/progress';
import { parseSpaceTags } from '@/lib/tags';
import { enabledProgressItems, progressLabelOf } from '@/lib/site-config';
import { useSiteConfig } from '@/lib/use-site-config';
import type { Output, Space, SpaceAccess, SpaceItem, SpaceVisibility } from '@/lib/types';
import AiBatchModal from './AiBatchModal';
import ExportMenu from './ExportMenu';
import { ROLE_LABEL } from './MembersPanel';

export default function SpaceDetailClient({ spaceId }: { spaceId: number }) {
  const router = useRouter();
  const [space, setSpace] = useState<Space | null>(null);
  const [access, setAccess] = useState<SpaceAccess | null>(null);
  const [items, setItems] = useState<SpaceItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [batchOpen, setBatchOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editingTitle, setEditingTitle] = useState('');
  const [renamingSpace, setRenamingSpace] = useState(false);
  const [spaceDraft, setSpaceDraft] = useState<{
    name: string;
    description: string;
    tags: string[];
    visibility: SpaceVisibility;
    author: string;
    translator: string;
    proofreader: string;
    typesetter: string;
  }>({
    name: '',
    description: '',
    tags: [],
    visibility: 'private',
    author: '',
    translator: '',
    proofreader: '',
    typesetter: '',
  });
  const [pendingDeleteItem, setPendingDeleteItem] = useState<SpaceItem | null>(null);
  const [pendingDeleteItems, setPendingDeleteItems] = useState<SpaceItem[] | null>(null);
  const [pendingDeleteSpace, setPendingDeleteSpace] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 图库并入空间：直接上传（多选 + 粘贴 + zip 整话包）
  // 上传分两个阶段：uploading=字节传输中（XHR 可拿进度）；processing=服务端处理（zip 解包导入）
  const [uploadPhase, setUploadPhase] = useState<'uploading' | 'processing' | null>(null);
  // 本轮上传里含 zip 时，处理阶段按钮提示「解包上传中」
  const [uploadHasZip, setUploadHasZip] = useState(false);
  // 上传进度（XHR upload.onprogress 的累计字节）
  const [uploadProgress, setUploadProgress] = useState<{ loaded: number; total: number } | null>(null);
  // 本轮上传的文件数与各文件大小（用于按字节边界推算「第几个文件」）
  const [uploadMeta, setUploadMeta] = useState<{ count: number; sizes: number[] } | null>(null);
  // 七级进度：点击徽标弹出状态选择菜单
  const [progressMenuOpen, setProgressMenuOpen] = useState(false);
  // 非致命提示（如 zip 内被跳过的文件）
  const [notice, setNotice] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // 空间内搜索（走 API q 参数）
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  // 多选删除
  const [selection, setSelection] = useState<Set<number>>(() => new Set());
  // 成品视图：图片（默认）| 成品 两种网格视图切换
  const [view, setView] = useState<'items' | 'outputs'>('items');
  const [outputs, setOutputs] = useState<Output[]>([]);
  const [outputsLoading, setOutputsLoading] = useState(false);
  // 成品列表是否已拉取过（首次切到成品视图才请求）
  const outputsLoaded = useRef(false);
  const [pendingDeleteOutput, setPendingDeleteOutput] = useState<Output | null>(null);
  // 一键机翻：AI 是否就绪（OCR 可用且翻译模型已配置）；null=预检中
  const [aiReady, setAiReady] = useState<boolean | null>(null);
  // 一键机翻：确认/进度 Modal 状态（mt = machine translate，避免与 AI 批量处理弹窗的 batchOpen 撞名）
  const [mtOpen, setMtOpen] = useState(false);
  const [mtScope, setMtScope] = useState<'untranslated' | 'all'>('untranslated');
  const [mtRunning, setMtRunning] = useState(false);
  const mtCancelled = useRef(false);
  const [mtProgress, setMtProgress] = useState<{
    done: number;
    total: number;
    current: string;
    success: number;
    failed: number;
  } | null>(null);
  const [mtFailures, setMtFailures] = useState<Array<{ title: string; reason: string }>>([]);
  // 非空 = 流水线已结束（成功/失败汇总展示中）
  const [mtDone, setMtDone] = useState<{ success: number; failed: number } | null>(null);
  const [mtShowFailures, setMtShowFailures] = useState(false);
  // 图源查重提示（上传命中其他空间的图片时弹窗展示）
  const [dupWarning, setDupWarning] = useState<
    Array<{ fileName: string; spaceName: string; itemTitle: string; spaceId: number }> | null
  >(null);
  // 跨空间移动条目
  const [moveModalOpen, setMoveModalOpen] = useState(false);
  const [targetSpaces, setTargetSpaces] = useState<Array<{ id: number; name: string }>>([]);
  const [targetSpaceId, setTargetSpaceId] = useState<number | null>(null);
  const [movingItems, setMovingItems] = useState(false);

  const canEdit = access?.canEdit ?? false;
  const searching = debouncedQuery.length > 0;
  // 站点配置：进度项 label 与 enabled（切换菜单只列启用项，徽标 label 用配置名）
  const { progressItems } = useSiteConfig();

  const load = useCallback(
    async (q: string = '') => {
      setLoading(true);
      try {
        const suffix = q ? `?q=${encodeURIComponent(q)}` : '';
        const res = await fetch(`/api/spaces/${spaceId}${suffix}`);
        if (res.status === 404 || res.status === 403) {
          router.replace('/spaces');
          return;
        }
        const data = await res.json();
        setSpace(data.space ?? null);
        setAccess(data.access ?? null);
        setItems(Array.isArray(data.items) ? data.items : []);
      } finally {
        setLoading(false);
      }
    },
    [spaceId, router],
  );

  useEffect(() => {
    if (!Number.isInteger(spaceId) || spaceId <= 0) {
      router.replace('/spaces');
    }
  }, [spaceId, router]);

  // 搜索防抖：输入停顿后按 q 参数重新拉取
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(query.trim()), 250);
    return () => clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    void load(debouncedQuery);
  }, [debouncedQuery, load]);

  // 清空选择当列表变化（搜索切换后选中项可能不可见）
  useEffect(() => {
    setSelection((prev) => {
      if (prev.size === 0) return prev;
      const visible = new Set(items.map((i) => i.id));
      const next = new Set([...prev].filter((id) => visible.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [items]);

  // 一键机翻预检：OCR（含检测服务/本机 sidecar）与对话模型都可用才亮按钮
  useEffect(() => {
    if (!canEdit) return;
    let cancelled = false;
    void (async () => {
      try {
        const [configRes, detectionRes] = await Promise.all([
          fetch('/api/ai/config'),
          fetch('/api/ai/detection'),
        ]);
        const config = configRes.ok ? await configRes.json() : null;
        const detection = detectionRes.ok ? await detectionRes.json() : null;
        const ocrUsable =
          Boolean(config?.ocrReady) ||
          Boolean(detection?.ready) ||
          Boolean(detection?.sidecar?.reachable);
        if (!cancelled) setAiReady(ocrUsable && Boolean(config?.chatReady));
      } catch {
        // 预检失败不阻塞页面，仅保持按钮禁用
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [canEdit]);

  const uploadFiles = useCallback(
    async (fileList: File[]) => {
      // 图片直传 + zip 压缩包（整话上传）
      const files = fileList.filter(
        (f) => f.size > 0 && (f.type.startsWith('image/') || f.name.toLowerCase().endsWith('.zip')),
      );
      if (files.length === 0) return;
      const hasZip = files.some((f) => f.name.toLowerCase().endsWith('.zip'));
      setUploadPhase('uploading');
      setUploadHasZip(hasZip);
      setUploadMeta({ count: files.length, sizes: files.map((f) => f.size) });
      setUploadProgress({ loaded: 0, total: files.reduce((sum, f) => sum + f.size, 0) });
      setError(null);
      setNotice(null);
      try {
        const form = new FormData();
        for (const file of files) form.append('files', file);
        // fetch 不支持上传进度，改用 XHR：同源请求自动携带 Cookie 鉴权，FormData 构造不变
        const data = await new Promise<Record<string, unknown>>((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          xhr.open('POST', `/api/spaces/${spaceId}/assets`);
          xhr.upload.onprogress = (event) => {
            if (event.lengthComputable) {
              setUploadProgress({ loaded: event.loaded, total: event.total });
            }
          };
          xhr.onload = () => {
            let parsed: Record<string, unknown> = {};
            try {
              parsed = JSON.parse(xhr.responseText) as Record<string, unknown>;
            } catch {
              parsed = {};
            }
            if (xhr.status >= 200 && xhr.status < 300) {
              resolve(parsed);
            } else {
              reject(new Error((parsed.error as string) ?? '上传失败'));
            }
          };
          xhr.onerror = () => reject(new Error('上传失败：网络错误'));
          xhr.send(form);
        });
        // 字节传输完成，进入服务端处理阶段（zip 解包导入较慢，需要独立提示）
        setUploadProgress(null);
        setUploadPhase('processing');
        // zip 里被跳过的文件：展示前几条
        const skipped = data.skipped as Array<{ name: string; reason: string }> | undefined;
        if (Array.isArray(skipped) && skipped.length > 0) {
          const samples = skipped
            .slice(0, 3)
            .map((s) => `${s.name}（${s.reason}）`)
            .join('、');
          setNotice(
            `已跳过 ${skipped.length} 个文件：${samples}${skipped.length > 3 ? ' 等' : ''}`,
          );
        }
        const errors = data.errors as string[] | undefined;
        if (Array.isArray(errors) && errors.length > 0) {
          setError(errors.join('；'));
        }
        // 图源查重检测
        const duplicates = data.duplicates as
          | Array<{ fileName: string; spaceName: string; itemTitle: string; spaceId: number }>
          | undefined;
        if (Array.isArray(duplicates) && duplicates.length > 0) {
          setDupWarning(duplicates);
        }
        await load(debouncedQuery);
      } catch (err) {
        setError(err instanceof Error ? err.message : '上传失败');
      } finally {
        setUploadPhase(null);
        setUploadHasZip(false);
        setUploadProgress(null);
        setUploadMeta(null);
      }
    },
    [spaceId, load, debouncedQuery],
  );

  /** 切换七级进度（轻操作，登录即可改）；服务端返回更新后的空间（含新 progress_at） */
  async function changeProgress(next: SpaceProgress) {
    if (!space || next === space.progress) return;
    try {
      const res = await fetch(`/api/spaces/${spaceId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ progress: next }),
      });
      if (!res.ok) {
        const data = await res.json();
        setError(data.error ?? '操作失败');
        return;
      }
      setError(null);
      const data = await res.json();
      if (data.space) setSpace(data.space);
    } catch {
      setError('网络异常，切换进度失败');
    }
  }

  /** 拉取空间全部成品（首次切到成品视图时触发） */
  const loadOutputs = useCallback(async () => {
    setOutputsLoading(true);
    try {
      const res = await fetch(`/api/spaces/${spaceId}/outputs`);
      const data = await res.json();
      setOutputs(Array.isArray(data.outputs) ? data.outputs : []);
      outputsLoaded.current = true;
    } finally {
      setOutputsLoading(false);
    }
  }, [spaceId]);

  /** 切换 图片|成品 视图；首次进入成品视图时拉取列表 */
  function switchView(next: 'items' | 'outputs') {
    setView(next);
    if (next === 'outputs' && !outputsLoaded.current) {
      void loadOutputs();
    }
  }

  /** 删除单张成品：outputs 行 + 无引用的 asset 与磁盘文件（服务端处理） */
  async function removeOutput(outputId: number) {
    setPendingDeleteOutput(null);
    const res = await fetch(`/api/outputs/${outputId}`, { method: 'DELETE' });
    if (!res.ok) {
      setError('删除成品失败');
      return;
    }
    setOutputs((prev) => prev.filter((o) => o.id !== outputId));
  }

  /** 打开一键机翻确认弹窗（重置上一轮的状态） */
  function openMtModal() {
    setMtScope('untranslated');
    setMtProgress(null);
    setMtFailures([]);
    setMtDone(null);
    setMtShowFailures(false);
    mtCancelled.current = false;
    setMtOpen(true);
  }

  /**
   * 一键整页机翻流水线（前端驱动逐页执行，天然有进度、可中断）：
   * 每页依次 OCR → 采纳标号（复刻 OcrModal 的请求体）→ AI 翻译（服务端直接落库）。
   * 页间隔 500ms 防 AI 服务限流；单页失败记录原因继续下一页。
   */
  async function runBatch() {
    // 按范围取目标：①仅无标注的图片（annotation_count===0，安全默认）②全部图片
    const targets = items.filter((item) =>
      mtScope === 'untranslated' ? (item.annotation_count ?? 0) === 0 : true,
    );
    if (targets.length === 0) {
      setError('该范围内没有可处理的图片');
      return;
    }
    setMtRunning(true);
    mtCancelled.current = false;
    setMtFailures([]);
    setMtDone(null);
    setMtProgress({ done: 0, total: targets.length, current: '', success: 0, failed: 0 });

    let success = 0;
    const failures: Array<{ title: string; reason: string }> = [];

    for (let index = 0; index < targets.length; index++) {
      if (mtCancelled.current) break;
      const item = targets[index];
      const title = item.title || '未命名';
      setMtProgress({
        done: index,
        total: targets.length,
        current: title,
        success,
        failed: failures.length,
      });
      try {
        // 1. OCR：检出文字块与原文
        const ocrRes = await fetch(`/api/items/${item.id}/ocr`, { method: 'POST' });
        const ocrData = await ocrRes.json();
        if (!ocrRes.ok) {
          throw new Error(ocrData.error ?? 'OCR 识别失败');
        }
        const usable = ((ocrData.proposals ?? []) as Array<{
          x: number;
          y: number;
          source_text: string;
        }>).filter((p) => typeof p.source_text === 'string' && p.source_text.trim() !== '');
        if (usable.length === 0) {
          throw new Error('OCR 未检出文本');
        }
        // 2. 采纳标号：与 OcrModal 的 accept 请求体完全一致（x/y/source_text/group_id，默认框内组 1）
        const acceptRes = await fetch(`/api/items/${item.id}/ocr/accept`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            proposals: usable.map((p) => ({
              x: p.x,
              y: p.y,
              source_text: p.source_text,
              group_id: 1,
            })),
          }),
        });
        const acceptData = await acceptRes.json();
        if (!acceptRes.ok) {
          throw new Error(acceptData.error ?? '采纳标号失败');
        }
        // 3. AI 翻译：applyTranslations=true 让服务端直接把译文写进标号
        const translateRes = await fetch(`/api/items/${item.id}/ai-translate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ applyTranslations: true }),
        });
        const translateData = await translateRes.json();
        if (!translateRes.ok) {
          throw new Error(translateData.error ?? 'AI 翻译失败');
        }
        success += 1;
      } catch (err) {
        failures.push({
          title,
          reason: err instanceof Error ? err.message : '处理失败',
        });
      }
      setMtProgress({
        done: index + 1,
        total: targets.length,
        current: title,
        success,
        failed: failures.length,
      });
      // 页间隔防限流（取消或最后一页时不等）
      if (index < targets.length - 1 && !mtCancelled.current) {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }

    setMtFailures(failures);
    setMtDone({ success, failed: failures.length });
    setMtRunning(false);
    // 标注数已变化，刷新列表（同时让「仅无标注」范围的下一次运行拿到新数据）
    await load(debouncedQuery);
  }

  // 粘贴图片直接上传到当前空间
  useEffect(() => {
    if (!canEdit) return;
    const onPaste = (event: ClipboardEvent) => {
      const files = Array.from(event.clipboardData?.files ?? []);
      if (files.length > 0) {
        event.preventDefault();
        void uploadFiles(files);
      }
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [canEdit, uploadFiles]);

  async function saveSpace() {
    if (!space) return;
    const name = spaceDraft.name.trim();
    if (!name) {
      setError('空间名称不能为空');
      return;
    }
    const res = await fetch(`/api/spaces/${spaceId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name,
        description: spaceDraft.description.trim() || null,
        visibility: spaceDraft.visibility,
        tags: spaceDraft.tags,
        author: spaceDraft.author.trim(),
        translator: spaceDraft.translator.trim(),
        proofreader: spaceDraft.proofreader.trim(),
        typesetter: spaceDraft.typesetter.trim(),
      }),
    });
    if (!res.ok) {
      const data = await res.json();
      setError(data.error ?? '保存失败');
      return;
    }
    setRenamingSpace(false);
    setError(null);
    await load(debouncedQuery);
  }

  async function saveItemTitle(itemId: number) {
    const title = editingTitle.trim();
    setEditingId(null);
    if (!title) return;
    const before = items.find((i) => i.id === itemId)?.title ?? '';
    if (title === before) return;
    setItems((prev) => prev.map((i) => (i.id === itemId ? { ...i, title } : i)));
    const res = await fetch(`/api/items/${itemId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title }),
    });
    if (!res.ok) {
      setError('重命名失败');
      await load(debouncedQuery);
    }
  }

  /** 上移 / 下移：与相邻条目交换位置后把完整顺序发给服务端 */
  async function moveItem(itemId: number, dir: -1 | 1) {
    const index = items.findIndex((i) => i.id === itemId);
    const target = index + dir;
    if (index < 0 || target < 0 || target >= items.length) return;
    const next = [...items];
    [next[index], next[target]] = [next[target], next[index]];
    setItems(next);
    const res = await fetch(`/api/spaces/${spaceId}/items/reorder`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ order: next.map((i) => i.id) }),
    });
    if (!res.ok) {
      setError('排序失败');
      await load(debouncedQuery);
    }
  }

  /** 彻底删除（单个或批量）：条目 + 标注 + 不再被引用的素材文件 */
  async function removeItems(itemIds: number[]) {
    if (itemIds.length === 0) return;
    const res = await fetch(`/api/spaces/${spaceId}/items`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ itemIds }),
    });
    if (!res.ok) {
      setError('删除失败');
      return;
    }
    setSelection(new Set());
    await load(debouncedQuery);
  }

  function toggleSelect(id: number) {
    setSelection((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function openMoveModal() {
    setMoveModalOpen(true);
    setTargetSpaceId(null);
    try {
      const res = await fetch('/api/spaces');
      if (res.ok) {
        const data = await res.json();
        const otherSpaces = (data.spaces ?? []).filter((s: { id: number }) => s.id !== spaceId);
        setTargetSpaces(otherSpaces);
        if (otherSpaces.length > 0) {
          setTargetSpaceId(otherSpaces[0].id);
        }
      }
    } catch {}
  }

  async function handleMoveItems() {
    if (!targetSpaceId || selection.size === 0) return;
    setMovingItems(true);
    try {
      const res = await fetch(`/api/spaces/${spaceId}/items/move`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          targetSpaceId,
          itemIds: Array.from(selection),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? '移动失败');
        return;
      }
      setNotice(
        `成功移动 ${data.movedCount} 个条目${data.skippedCount > 0 ? `，跳过 ${data.skippedCount} 个已存在的目标空间条目` : ''}`,
      );
      setSelection(new Set());
      setMoveModalOpen(false);
      await load(debouncedQuery);
    } catch {
      setError('网络异常，移动条目失败');
    } finally {
      setMovingItems(false);
    }
  }

  async function deleteSpace() {
    setPendingDeleteSpace(false);
    const res = await fetch(`/api/spaces/${spaceId}`, { method: 'DELETE' });
    if (!res.ok) {
      setError('删除空间失败');
      return;
    }
    router.replace('/spaces');
    router.refresh();
  }

  if (loading && !space) {
    return <p className="py-20 text-center text-sm text-ink-500">加载中…</p>;
  }
  if (!space || !access) return null;

  const canManage = access.canManage;
  const totalAnnotations = items.reduce((sum, item) => sum + (item.annotation_count ?? 0), 0);
  const selectedItems = items.filter((item) => selection.has(item.id));

  // 上传进度：百分比按累计字节算；「第几个文件」按各文件字节边界推算
  const uploadPct =
    uploadProgress && uploadProgress.total > 0
      ? Math.min(100, Math.round((uploadProgress.loaded / uploadProgress.total) * 100))
      : 0;
  let uploadIndex = 0;
  if (uploadProgress && uploadMeta) {
    let acc = 0;
    for (const size of uploadMeta.sizes) {
      acc += size;
      if (uploadProgress.loaded < acc) break;
      uploadIndex += 1;
    }
    uploadIndex = Math.min(uploadIndex + 1, uploadMeta.count);
  }

  return (
    <div className="space-y-6">
      <Link href="/spaces" className="inline-block text-sm text-ink-400 hover:text-sky-deep">
        ← 返回空间列表
      </Link>

      <div className="flex flex-wrap items-start justify-between gap-4">
        {renamingSpace ? (
          <div className="w-full max-w-xl space-y-3">
            <div>
              <label className="label">空间名称</label>
              <input
                className="input"
                value={spaceDraft.name}
                autoFocus
                onChange={(e) => setSpaceDraft((d) => ({ ...d, name: e.target.value }))}
              />
            </div>
            <div>
              <label className="label">标签</label>
              <TagPicker
                selected={spaceDraft.tags}
                onChange={(tags) => setSpaceDraft((d) => ({ ...d, tags }))}
              />
            </div>
            <div>
              <label className="label">描述</label>
              <textarea
                className="input min-h-[70px] resize-y"
                value={spaceDraft.description}
                onChange={(e) => setSpaceDraft((d) => ({ ...d, description: e.target.value }))}
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="label">作者</label>
                <input
                  className="input text-xs"
                  placeholder="原作者名"
                  value={spaceDraft.author}
                  onChange={(e) => setSpaceDraft((d) => ({ ...d, author: e.target.value }))}
                />
              </div>
              <div>
                <label className="label">翻译</label>
                <input
                  className="input text-xs"
                  placeholder="翻译担当"
                  value={spaceDraft.translator}
                  onChange={(e) => setSpaceDraft((d) => ({ ...d, translator: e.target.value }))}
                />
              </div>
              <div>
                <label className="label">校对</label>
                <input
                  className="input text-xs"
                  placeholder="校对担当"
                  value={spaceDraft.proofreader}
                  onChange={(e) => setSpaceDraft((d) => ({ ...d, proofreader: e.target.value }))}
                />
              </div>
              <div>
                <label className="label">嵌字</label>
                <input
                  className="input text-xs"
                  placeholder="嵌字担当"
                  value={spaceDraft.typesetter}
                  onChange={(e) => setSpaceDraft((d) => ({ ...d, typesetter: e.target.value }))}
                />
              </div>
            </div>
            <p className="rounded-lg bg-sky/10 px-3 py-2 text-[11px] leading-relaxed text-ink-500">
              📁 文件夹对所有登录用户开放：人人可看、可编辑、可删除
            </p>
            <div className="flex gap-2">
              <button type="button" className="btn-primary" onClick={() => void saveSpace()}>
                保存
              </button>
              <button type="button" className="btn-ghost" onClick={() => setRenamingSpace(false)}>
                取消
              </button>
            </div>
          </div>
        ) : (
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-3">
              <h1 className="font-display truncate text-2xl tracking-wide text-ink-100">{space.name}</h1>
              {/* 空间序号：等宽小徽标（服务端自动生成，历史空间无序号不显示） */}
              {space.space_no && (
                <span className="shrink-0 rounded bg-ink-800 px-1.5 py-0.5 font-mono text-[11px] text-ink-300">
                  {space.space_no}
                </span>
              )}
              <span className="rounded bg-ink-800 px-1.5 py-0.5 text-[11px] text-ink-400">
                {ROLE_LABEL[access.role]}
              </span>
              {/* 七级进度：点击徽标（ring + 虚线纹理圈提示可点）弹出状态选择，切换即 PATCH */}
              <div className="relative">
                <button
                  type="button"
                  title="点击切换进度"
                  onClick={() => setProgressMenuOpen((v) => !v)}
                >
                  <ProgressBadge
                    progress={space.progress}
                    progressAt={space.progress_at}
                    clickable
                    showAge
                    label={progressLabelOf(progressItems, space.progress)}
                  />
                </button>
                {progressMenuOpen && (
                  <>
                    {/* 全屏透明遮罩：点空白处收起菜单 */}
                    <div
                      className="fixed inset-0 z-30"
                      onClick={() => setProgressMenuOpen(false)}
                    />
                    <div className="absolute left-0 top-full z-40 mt-1 w-44 rounded-xl bg-cloud p-1 shadow-lg ring-1 ring-ink-700">
                      <p className="px-2 py-1 text-[10px] text-ink-400">切换进度</p>
                      {/* 当前层处于站点配置禁用态时：顶部单独展示当前项（不可选回已禁用项） */}
                      {(progressItems.find((item) => item.key === space.progress)?.enabled ??
                        true) === false && (
                        <p className="mx-1 mb-1 rounded-lg bg-paper px-2 py-1.5 text-[11px] leading-relaxed text-ink-400">
                          当前：{progressLabelOf(progressItems, space.progress)}
                          （该项已被停用，请在下方选择新进度）
                        </p>
                      )}
                      {enabledProgressItems(progressItems).map((item) => (
                        <button
                          key={item.key}
                          type="button"
                          className={`flex w-full items-center justify-between rounded-lg px-2 py-1.5 text-xs transition-colors ${
                            item.key === space.progress
                              ? 'bg-sky/10 text-sky-deep'
                              : 'text-ink-200 hover:bg-paper'
                          }`}
                          onClick={() => {
                            setProgressMenuOpen(false);
                            void changeProgress(item.key);
                          }}
                        >
                          {item.label}
                          {item.key === space.progress && <span>✓</span>}
                        </button>
                      ))}
                    </div>
                  </>
                )}
              </div>
              {canManage && (
                <button
                  type="button"
                  className="btn-ghost px-2 py-1 text-xs"
                  onClick={() => {
                    setSpaceDraft({
                      name: space.name,
                      description: space.description ?? '',
                      tags: parseSpaceTags(space.tags),
                      visibility: space.visibility,
                      author: space.author ?? '',
                      translator: space.translator ?? '',
                      proofreader: space.proofreader ?? '',
                      typesetter: space.typesetter ?? '',
                    });
                    setRenamingSpace(true);
                  }}
                >
                  编辑
                </button>
              )}
            </div>
            {/* 标签 chips：sky 系小徽标，编辑弹窗里可增删 */}
            {parseSpaceTags(space.tags).length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {parseSpaceTags(space.tags).map((tag) => (
                  <span
                    key={tag}
                    className="rounded-full bg-sky/10 px-2 py-0.5 text-[11px] text-sky-deep"
                  >
                    {tag}
                  </span>
                ))}
              </div>
            )}
            {(space.author || space.translator || space.proofreader || space.typesetter) && (
              <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-ink-400">
                {space.author && (
                  <span>
                    作者：<span className="text-ink-200">{space.author}</span>
                  </span>
                )}
                {space.translator && (
                  <span>
                    翻译：<span className="text-ink-200">{space.translator}</span>
                  </span>
                )}
                {space.proofreader && (
                  <span>
                    校对：<span className="text-ink-200">{space.proofreader}</span>
                  </span>
                )}
                {space.typesetter && (
                  <span>
                    嵌字：<span className="text-ink-200">{space.typesetter}</span>
                  </span>
                )}
              </div>
            )}
            <p className="mt-1 text-sm text-ink-400">{space.description || '还没写简介'}</p>
            <p className="mt-1.5 text-xs text-ink-400">
              {items.length} 张图片 · {totalAnnotations} 条标注 · 🌐 公共文件夹（人人可编辑）
            </p>
          </div>
        )}

        {!renamingSpace && (
          <div className="flex flex-wrap items-center gap-2">
            <input
              className="input w-48 py-1.5 text-xs"
              placeholder="搜索图片名称…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            {canEdit && (
              <>
                <button
                  type="button"
                  className="btn-primary"
                  disabled={uploadPhase !== null || mtRunning}
                  onClick={() => fileInputRef.current?.click()}
                >
                  {uploadPhase === null
                    ? '上传图片'
                    : uploadPhase === 'processing'
                      ? uploadHasZip
                        ? '解包上传中…'
                        : '处理中…'
                      : '上传中…'}
                </button>
                {selectedItems.length > 0 ? (
                  <>
                    <button
                      type="button"
                      className="btn-ghost text-sky"
                      disabled={mtRunning}
                      onClick={() => setBatchOpen(true)}
                      title="对所选图片进行批量 AI 翻译"
                    >
                      🤖 批量 AI 处理（{selectedItems.length}）
                    </button>
                    <button
                      type="button"
                      className="btn-ghost text-ink-200"
                      disabled={mtRunning}
                      onClick={() => void openMoveModal()}
                      title="将所选图片转移至其他空间"
                    >
                      📦 移动到...（{selectedItems.length}）
                    </button>
                    <button
                      type="button"
                      className="btn-danger"
                      disabled={mtRunning}
                      onClick={() => setPendingDeleteItems(selectedItems)}
                    >
                      删除所选（{selectedItems.length}）
                    </button>
                    <button
                      type="button"
                      className="btn-ghost"
                      onClick={() => setSelection(new Set())}
                    >
                      取消选择
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    className="btn-ghost"
                    onClick={() => setSelection(new Set(items.map((i) => i.id)))}
                    disabled={items.length === 0 || mtRunning}
                  >
                    全选
                  </button>
                )}
              </>
            )}
            {canEdit && items.length > 0 && (
              <button
                type="button"
                className="btn-ghost"
                disabled={mtRunning}
                onClick={() => setBatchOpen(true)}
              >
                AI 批量处理
              </button>
            )}
            {canEdit && items.length > 0 && (
              <button
                type="button"
                className="btn-ghost"
                disabled={aiReady === false || mtRunning}
                title={
                  aiReady === false
                    ? '请先到「AI 设置」配置视觉模型（OCR）与对话模型（翻译）'
                    : '逐页调用 OCR + AI 翻译，把整本漫画机翻一遍'
                }
                onClick={openMtModal}
              >
                一键机翻
              </button>
            )}
            {items.length > 0 && (
              <Link href={`/spaces/${spaceId}/reader`} className="btn-ghost">
                阅读
              </Link>
            )}
            <ExportMenu spaceId={spaceId} disabled={items.length === 0} />
            {canManage && (
              <button
                type="button"
                className="btn-danger"
                disabled={mtRunning}
                onClick={() => setPendingDeleteSpace(true)}
              >
                删除空间
              </button>
            )}
          </div>
        )}
      </div>

      {!canEdit && (
        <p className="rounded-lg border border-sky/20 bg-sky/5 px-3 py-2 text-xs text-ink-400">
          你在该空间是<strong className="text-ink-100">只读</strong>权限，可以查看和导出标注，
          但不能添加、修改或删除内容。
        </p>
      )}

      {/* 上传进度条：传输阶段显示字节进度，zip 处理阶段显示解包提示（本地极快属正常） */}
      {uploadPhase && (
        <div className="card px-4 py-3 text-xs">
          {uploadPhase === 'uploading' ? (
            <>
              <div className="flex items-center justify-between">
                <span className="text-ink-200">
                  上传中 {uploadIndex}/{uploadMeta?.count ?? 0} · {uploadPct}%
                </span>
                <span className="text-ink-400">
                  {uploadProgress ? `${Math.round(uploadProgress.loaded / 1024)} KB` : ''}
                </span>
              </div>
              <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-ink-800">
                <div className="h-full bg-sky" style={{ width: `${uploadPct}%` }} />
              </div>
            </>
          ) : (
            <span className="text-ink-200">
              {uploadHasZip ? '解包导入中…' : '服务端处理中…'}
            </span>
          )}
        </div>
      )}

      {error && (
        <p className="notice-error">{error}</p>
      )}

      {notice && <p className="notice-ok">{notice}</p>}

      {/* 图片 | 成品 视图切换；成品视图提供整包 zip 下载 */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="seg">
          <button
            type="button"
            className={`seg-btn ${view === 'items' ? 'seg-btn-on' : ''}`}
            onClick={() => switchView('items')}
          >
            图片
          </button>
          <button
            type="button"
            className={`seg-btn ${view === 'outputs' ? 'seg-btn-on' : ''}`}
            onClick={() => switchView('outputs')}
          >
            成品
          </button>
        </div>
        {view === 'outputs' && outputs.length > 0 && (
          <>
            <span className="text-xs text-ink-400">共 {outputs.length} 个成品</span>
            <a href={`/api/spaces/${spaceId}/outputs-zip`} className="btn-ghost ml-auto py-1 text-xs">
              下载全部成品 (zip)
            </a>
          </>
        )}
      </div>

      {view === 'outputs' ? (
        outputsLoading ? (
          <p className="py-20 text-center text-sm text-ink-500">加载中…</p>
        ) : outputs.length === 0 ? (
          <EmptyState
            showMascot
            kaomoji='(๑•̀ㅂ•́)و✧'
            title="这个空间还没有成品"
            hint="在嵌字编辑页点「保存成品」，把完成的图归档到这里"
          />
        ) : (
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 2xl:grid-cols-5">
            {outputs.map((output) => (
              <div key={output.id} className="card overflow-hidden">
                <div className="aspect-[4/3] w-full overflow-hidden bg-paper">
                  <img
                    src={thumbUrl(
                      output.asset?.thumb_filename ?? null,
                      output.asset?.filename ?? '',
                    )}
                    alt={output.item_title ?? ''}
                    loading="lazy"
                    className="h-full w-full object-cover"
                  />
                </div>
                <div className="p-3">
                  <p className="truncate text-xs text-ink-200" title={output.item_title ?? ''}>
                    {output.item_title || '未命名'}
                  </p>
                  <p className="mt-1 truncate text-[11px] text-ink-400">
                    {formatDate(output.created_at)} · {formatBytes(output.asset?.size_bytes ?? 0)}
                  </p>
                  <div className="mt-2 flex gap-2">
                    <a
                      href={originalUrl(output.asset?.filename ?? '')}
                      download={output.asset?.original_name ?? undefined}
                      className="btn-primary flex-1 py-1 text-xs"
                    >
                      下载
                    </a>
                    <button
                      type="button"
                      className="btn-danger flex-1 py-1 text-xs"
                      onClick={() => setPendingDeleteOutput(output)}
                    >
                      删除
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )
      ) : items.length === 0 ? (
        <EmptyState
          showMascot
          kaomoji={searching ? '(・・?)' : '(๑•̀ㅂ•́)و✧'}
          title={searching ? '没有匹配的图片' : '这个空间还没有图片'}
          hint={
            searching
              ? '换个关键词试试'
              : canEdit
                ? '点击「上传图片」或直接 Ctrl+V 粘贴图片'
                : '等待有编辑权限的成员添加'
          }
        />
      ) : (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 2xl:grid-cols-5">
          {items.map((item, index) => {
            const selected = selection.has(item.id);
            return (
              <div key={item.id} className="card group relative overflow-hidden">
                <Link
                  href={`/annotate/${item.id}`}
                  className="block"
                  onClick={(event) => {
                    if (!canEdit) event.preventDefault();
                  }}
                >
                  <div className="relative aspect-[4/3] w-full overflow-hidden bg-paper">
                    <img
                      src={thumbUrl(item.asset?.thumb_filename ?? null, item.asset?.filename ?? '')}
                      alt={item.title ?? ''}
                      loading="lazy"
                      className={`h-full w-full object-cover transition-transform ${
                        canEdit ? 'group-hover:scale-[1.03]' : ''
                      }`}
                    />
                    {(item.annotation_count ?? 0) > 0 && (
                      <span className="absolute right-2 top-2 rounded-md bg-sky/90 px-1.5 py-0.5 text-[11px] font-medium text-white">
                        {item.annotation_count} 标注
                      </span>
                    )}
                  </div>
                </Link>

                {canEdit && (
                  <button
                    type="button"
                    onClick={() => toggleSelect(item.id)}
                    className={`absolute left-2 top-2 z-10 flex h-5 w-5 items-center justify-center rounded border text-[11px] font-bold transition-colors ${
                      selected
                        ? 'border-sky bg-sky text-white'
                        : 'border-white/60 bg-cloud/70 text-transparent hover:border-sky'
                    }`}
                    title={selected ? '取消选择' : '选择'}
                  >
                    ✓
                  </button>
                )}

                <div className="p-3">
                  {editingId === item.id && canEdit ? (
                    <input
                      autoFocus
                      className="input px-2 py-1 text-xs"
                      value={editingTitle}
                      onChange={(e) => setEditingTitle(e.target.value)}
                      onBlur={() => void saveItemTitle(item.id)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') void saveItemTitle(item.id);
                        if (e.key === 'Escape') setEditingId(null);
                      }}
                    />
                  ) : (
                    <button
                      type="button"
                      disabled={!canEdit}
                      onClick={() => {
                        setEditingId(item.id);
                        setEditingTitle(item.title ?? '');
                      }}
                      className={`block w-full truncate text-left text-xs ${
                        canEdit ? 'text-ink-200 hover:text-sky-deep' : 'cursor-default text-ink-400'
                      }`}
                      title={canEdit ? '点击重命名' : undefined}
                    >
                      {item.title || '未命名'}
                    </button>
                  )}

                  <p className="mt-1 truncate text-[11px] text-ink-400">
                    {item.asset?.width && item.asset?.height
                      ? `${item.asset.width}×${item.asset.height}`
                      : ''}
                  </p>

                  <div className="mt-2.5 flex gap-2">
                    <Link
                      href={`/annotate/${item.id}`}
                      className="btn-primary flex-1 py-1 text-xs"
                    >
                      {canEdit ? '标注' : '查看'}
                    </Link>
                    <Link href={`/typeset/${item.id}`} className="btn-ghost flex-1 py-1 text-xs">
                      嵌字
                    </Link>
                  </div>

                  {canEdit && (
                    <div className="mt-2 flex gap-2">
                      {!searching && (
                        <>
                          <button
                            type="button"
                            className="btn-ghost px-2.5 py-1 text-xs"
                            disabled={index === 0}
                            title="上移"
                            onClick={() => void moveItem(item.id, -1)}
                          >
                            ↑
                          </button>
                          <button
                            type="button"
                            className="btn-ghost px-2.5 py-1 text-xs"
                            disabled={index === items.length - 1}
                            title="下移"
                            onClick={() => void moveItem(item.id, 1)}
                          >
                            ↓
                          </button>
                        </>
                      )}
                      <button
                        type="button"
                        className="btn-danger ml-auto px-2.5 py-1 text-xs"
                        onClick={() => setPendingDeleteItem(item)}
                      >
                        删除
                      </button>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {batchOpen && canEdit && (
        <AiBatchModal
          items={
            selection.size > 0
              ? items.filter((i) => selection.has(i.id)).map((i) => ({ id: i.id, title: i.title }))
              : items.map((i) => ({ id: i.id, title: i.title }))
          }
          onClose={() => setBatchOpen(false)}
          onDone={() => void load(debouncedQuery)}
        />
      )}

      <input
        ref={fileInputRef}
        type="file"
        accept="image/*,.zip"
        multiple
        className="hidden"
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = '';
          void uploadFiles(files);
        }}
      />

      <Modal
        open={pendingDeleteItem !== null}
        title="删除图片"
        onClose={() => setPendingDeleteItem(null)}
        footer={
          <>
            <button type="button" className="btn-ghost" onClick={() => setPendingDeleteItem(null)}>
              取消
            </button>
            <button
              type="button"
              className="btn-danger"
              onClick={() => {
                const item = pendingDeleteItem;
                setPendingDeleteItem(null);
                if (item) void removeItems([item.id]);
              }}
            >
              确认删除
            </button>
          </>
        }
      >
        <p className="text-sm text-ink-200">
          将彻底删除「{pendingDeleteItem?.title || '未命名'}」及其
          {pendingDeleteItem?.annotation_count ?? 0} 条标注与磁盘文件，
          <strong className="text-blush">此操作不可撤销</strong>。
        </p>
      </Modal>

      <Modal
        open={pendingDeleteItems !== null}
        title="批量删除图片"
        onClose={() => setPendingDeleteItems(null)}
        footer={
          <>
            <button type="button" className="btn-ghost" onClick={() => setPendingDeleteItems(null)}>
              取消
            </button>
            <button
              type="button"
              className="btn-danger"
              onClick={() => {
                const targets = pendingDeleteItems;
                setPendingDeleteItems(null);
                if (targets) void removeItems(targets.map((i) => i.id));
              }}
            >
              确认删除
            </button>
          </>
        }
      >
        <p className="text-sm text-ink-200">
          将彻底删除所选 {pendingDeleteItems?.length ?? 0} 张图片及其全部标注与磁盘文件，
          <strong className="text-blush">此操作不可撤销</strong>。
        </p>
      </Modal>

      <Modal
        open={pendingDeleteSpace}
        title="删除空间"
        onClose={() => setPendingDeleteSpace(false)}
        footer={
          <>
            <button
              type="button"
              className="btn-ghost"
              onClick={() => setPendingDeleteSpace(false)}
            >
              取消
            </button>
            <button type="button" className="btn-danger" onClick={() => void deleteSpace()}>
              确认删除
            </button>
          </>
        }
      >
        <p className="text-sm text-ink-200">
          将删除空间「{space.name}」及其中全部 {items.length} 张图片与 {totalAnnotations} 条标注，
          所有协作者都会失去访问权，<strong className="text-blush">此操作不可撤销</strong>。
        </p>
      </Modal>

      <Modal
        open={pendingDeleteOutput !== null}
        title="删除成品"
        onClose={() => setPendingDeleteOutput(null)}
        footer={
          <>
            <button type="button" className="btn-ghost" onClick={() => setPendingDeleteOutput(null)}>
              取消
            </button>
            <button
              type="button"
              className="btn-danger"
              onClick={() => {
                const output = pendingDeleteOutput;
                setPendingDeleteOutput(null);
                if (output) void removeOutput(output.id);
              }}
            >
              确认删除
            </button>
          </>
        }
      >
        <p className="text-sm text-ink-200">
          将删除「{pendingDeleteOutput?.item_title || '未命名'}」的这一版成品及其磁盘文件，
          <strong className="text-blush">此操作不可撤销</strong>。空间图片列表不受影响。
        </p>
      </Modal>

      <Modal
        open={mtOpen}
        title="一键机翻"
        onClose={() => {
          // 流水线执行中不允许误关（点遮罩/Esc 无效），先点「停止」
          if (!mtRunning) setMtOpen(false);
        }}
        footer={
          mtRunning ? (
            <button
              type="button"
              className="btn-danger"
              onClick={() => {
                mtCancelled.current = true;
              }}
            >
              停止
            </button>
          ) : mtDone ? (
            <button type="button" className="btn-primary" onClick={() => setMtOpen(false)}>
              关闭
            </button>
          ) : (
            <>
              <button type="button" className="btn-ghost" onClick={() => setMtOpen(false)}>
                取消
              </button>
              <button type="button" className="btn-primary" onClick={() => void runBatch()}>
                开始机翻
              </button>
            </>
          )
        }
      >
        {mtRunning || mtDone ? (
          mtRunning ? (
            // 进度：无动效宽度百分比 + 当前条目 + 成功/失败计数
            mtProgress && (
              <div className="space-y-2">
                <div className="flex items-center justify-between text-xs text-ink-200">
                  <span>
                    {mtProgress.done} / {mtProgress.total}
                  </span>
                  <span className="text-ink-400">
                    成功 {mtProgress.success} · 失败 {mtProgress.failed}
                  </span>
                </div>
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-ink-800">
                  <div
                    className="h-full bg-sky"
                    style={{
                      width: `${
                        mtProgress.total > 0
                          ? Math.round((mtProgress.done / mtProgress.total) * 100)
                          : 0
                      }%`,
                    }}
                  />
                </div>
                <p className="truncate text-[11px] text-ink-400">
                  正在处理：{mtProgress.current}
                </p>
              </div>
            )
          ) : (
            // 结束汇总：成功/跳过失败计数，失败列表可展开
            mtDone && (
              <div className="space-y-3">
                <p className="notice-ok">
                  完成：成功 {mtDone.success} 页 · 跳过/失败 {mtDone.failed} 页
                </p>
                {mtFailures.length > 0 && (
                  <div>
                    <button
                      type="button"
                      className="text-xs text-ink-400 underline"
                      onClick={() => setMtShowFailures((v) => !v)}
                    >
                      {mtShowFailures ? '收起失败列表' : `展开失败列表（${mtFailures.length}）`}
                    </button>
                    {mtShowFailures && (
                      <ul className="mt-2 max-h-48 space-y-1 overflow-y-auto">
                        {mtFailures.map((failure, index) => (
                          <li key={`${failure.title}-${index}`} className="notice-error text-[11px]">
                            {failure.title}：{failure.reason}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
              </div>
            )
          )
        ) : (
          // 确认设置：范围单选 + 额度提示
          <div className="space-y-3">
            <label className="flex items-start gap-2 text-sm text-ink-200">
              <input
                type="radio"
                className="mt-1"
                checked={mtScope === 'untranslated'}
                onChange={() => setMtScope('untranslated')}
              />
              <span>
                仅无标注的图片
                <span className="block text-[11px] text-ink-400">
                  只处理还没有任何标号的图片（安全默认）
                </span>
              </span>
            </label>
            <label className="flex items-start gap-2 text-sm text-ink-200">
              <input
                type="radio"
                className="mt-1"
                checked={mtScope === 'all'}
                onChange={() => setMtScope('all')}
              />
              <span>
                全部图片
                <span className="block text-[11px] text-ink-400">
                  OCR 会跳过与现有标号过近的框；翻译会覆盖已有译文
                </span>
              </span>
            </label>
            <p className="rounded-lg bg-sky/10 px-3 py-2 text-[11px] leading-relaxed text-ink-500">
              逐页调用 OCR + AI 翻译，可在中途取消；请确保 AI 额度充足。
            </p>
            {error && <p className="notice-error">{error}</p>}
          </div>
        )}
      </Modal>

      {/* 跨空间移动条目弹窗 */}
      <Modal
        open={moveModalOpen}
        title="移动条目到其他空间"
        onClose={() => setMoveModalOpen(false)}
        footer={
          <div className="flex justify-end gap-2">
            <button
              type="button"
              className="btn-ghost"
              disabled={movingItems}
              onClick={() => setMoveModalOpen(false)}
            >
              取消
            </button>
            <button
              type="button"
              className="btn-primary"
              disabled={!targetSpaceId || movingItems || targetSpaces.length === 0}
              onClick={() => void handleMoveItems()}
            >
              {movingItems ? '移动中…' : '确认移动'}
            </button>
          </div>
        }
      >
        <div className="space-y-3 text-sm">
          <p className="text-ink-300">
            已选择 <strong className="text-sky">{selection.size}</strong> 个条目，请选择要移动到的目标空间：
          </p>
          {targetSpaces.length === 0 ? (
            <p className="rounded-lg bg-ink-800/40 p-3 text-xs text-ink-400">
              当前暂无可移动的其他空间（请先创建其他空间）。
            </p>
          ) : (
            <div>
              <label className="label">目标空间</label>
              <select
                className="input"
                value={targetSpaceId ?? ''}
                onChange={(e) => setTargetSpaceId(Number(e.target.value))}
              >
                {targetSpaces.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </div>
          )}
          <p className="text-[11px] text-ink-500">
            提示：移动后条目及关联的所有标号将完整转移至目标空间。
          </p>
        </div>
      </Modal>

      {/* 图源查重告警弹窗 */}
      <Modal
        open={dupWarning !== null}
        title="⚠️ 图源查重提醒"
        onClose={() => setDupWarning(null)}
        footer={
          <button
            type="button"
            className="btn-primary"
            onClick={() => setDupWarning(null)}
          >
            我知道了
          </button>
        }
      >
        <div className="space-y-3 text-sm">
          <p className="text-ink-300">
            本次上传的图片中，检测到以下图片已在其他空间中存在，请核实是否属于重复开坑：
          </p>
          <ul className="max-h-60 space-y-2 overflow-y-auto rounded-lg border border-amber-500/20 bg-amber-500/5 p-3">
            {dupWarning?.map((dup, i) => (
              <li key={i} className="text-xs text-ink-200">
                <span className="font-semibold text-amber-500">[{dup.fileName}]</span> 与空间
                <strong className="text-sky">【{dup.spaceName}】</strong>中的
                <strong className="text-ink-100">《{dup.itemTitle}》</strong>内容完全一致（SHA-256 相同）。
              </li>
            ))}
          </ul>
        </div>
      </Modal>
    </div>
  );
}
