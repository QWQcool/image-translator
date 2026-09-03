'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ConfirmDialog from '@/components/ConfirmDialog';
import EmptyState from '@/components/EmptyState';
import { originalUrl, previewUrl, thumbUrl } from '@/lib/media';
import { isPin, newKey, parseRuns, type DraftAnnotation } from '@/lib/annotation';
import { groupColor, parseGroups, parsePhrases } from '@/lib/labelplus';
import { useCollabRoom } from '@/lib/use-collab-room';
import type { Asset, LabelPlusGroup, SpaceAccess, SpaceItem } from '@/lib/types';
import AnnotationCanvas, { type EditorMode } from './AnnotationCanvas';
import AnnotationPanel from './AnnotationPanel';
import LabelPlusPanel from './LabelPlusPanel';
import OcrModal from './OcrModal';
import TextRenderPanel from './TextRenderPanel';
import TranslateModal from './TranslateModal';

const MODES: Array<{ id: EditorMode; key: string; label: string }> = [
  { id: 'box', key: '', label: '框选' },
  { id: 'browse', key: 'Q', label: '浏览' },
  { id: 'label', key: 'W', label: '标号' },
  { id: 'input', key: 'E', label: '录入' },
  { id: 'review', key: 'R', label: '审校' },
];

type NeighborItem = {
  id: number;
  title: string | null;
  thumb_filename: string | null;
  filename: string;
  original_name: string | null;
};

function hydrate(row: DraftAnnotation): DraftAnnotation {
  return {
    ...row,
    key: newKey(),
    kind: row.kind === 'pin' || (row.w === 0 && row.h === 0 && row.kind !== 'box') ? 'pin' : 'box',
    group_id: row.group_id || 1,
    source_text: row.source_text ?? '',
    comment: row.comment ?? '',
    runs: parseRuns(row.runs),
    text_opacity: typeof row.text_opacity === 'number' ? row.text_opacity : 1,
    doubtful: Boolean(row.doubtful),
  };
}

/** 历史栈上限，防止长会话内存膨胀 */
const HISTORY_LIMIT = 100;
/** 连续手势（拖拽移动/缩放）在这个毫秒窗口内合并为一条历史记录 */
const HISTORY_COALESCE_MS = 400;

export default function AnnotationEditor({ itemId }: { itemId: number }) {
  const router = useRouter();

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [item, setItem] = useState<SpaceItem | null>(null);
  const [asset, setAsset] = useState<Asset | null>(null);
  const [spaceName, setSpaceName] = useState('');
  const [annotations, setAnnotations] = useState<DraftAnnotation[]>([]);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  // 多选集合：空 = 单选模式（selectedKey 生效）；Ctrl+橡皮筋 / Ctrl+Shift+加选时填充
  const [selectedKeys, setSelectedKeys] = useState<string[]>([]);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [syncNote, setSyncNote] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [editingTitle, setEditingTitle] = useState(false);
  const [access, setAccess] = useState<SpaceAccess | null>(null);
  const [mode, setMode] = useState<EditorMode>('box');
  const [hidePins, setHidePins] = useState(false);
  const [showGroupNames, setShowGroupNames] = useState(false);
  const [defaultGroupId, setDefaultGroupId] = useState(1);
  const [groups, setGroups] = useState<LabelPlusGroup[]>([]);
  const [phrases, setPhrases] = useState<string[]>([]);
  const [phraseMenuOpen, setPhraseMenuOpen] = useState(false);
  const phraseCursor = useRef(0);
  const [ocrOpen, setOcrOpen] = useState(false);
  const [translateOpen, setTranslateOpen] = useState(false);
  /** 待确认删除的标注 key 集合（单删 / 批删统一走二次确认） */
  const [confirmKeys, setConfirmKeys] = useState<string[] | null>(null);
  const [neighbors, setNeighbors] = useState<{
    prevId: number | null;
    nextId: number | null;
    items: NeighborItem[];
  }>({ prevId: null, nextId: null, items: [] });

  const annotationsRef = useRef(annotations);
  annotationsRef.current = annotations;
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const canEditRef = useRef(false);

  // ---- 撤销 / 重做历史栈（ref 存数据，histVersion 只用于触发重渲染更新按钮禁用态）----
  const pastRef = useRef<DraftAnnotation[][]>([]);
  const futureRef = useRef<DraftAnnotation[][]>([]);
  const lastPushAtRef = useRef(0);
  const [histVersion, setHistVersion] = useState(0);

  /** 把当前状态压入 past：连续手势合并，栈满淘汰最旧，同时清空 future */
  const pushHistory = useCallback((snapshot: DraftAnnotation[]) => {
    const past = pastRef.current;
    const now = Date.now();
    const last = past[past.length - 1];
    // 与上一条内容完全一致时跳过（无意义变更）
    const sameAsLast =
      last &&
      last.length === snapshot.length &&
      last.every((row, index) => row.key === snapshot[index].key) &&
      JSON.stringify(last) === JSON.stringify(snapshot);
    if (sameAsLast) return;
    if (last && now - lastPushAtRef.current < HISTORY_COALESCE_MS) {
      // 连续手势窗口内：保留手势起点快照，后续中间态不入栈
      lastPushAtRef.current = now;
      futureRef.current = [];
      setHistVersion((v) => v + 1);
      return;
    }
    past.push(snapshot);
    if (past.length > HISTORY_LIMIT) past.shift();
    lastPushAtRef.current = now;
    futureRef.current = [];
    setHistVersion((v) => v + 1);
  }, []);

  /** 清空历史（加载 / 收到协作者快照后调用，避免撤销跳到过期状态） */
  const resetHistory = useCallback(() => {
    pastRef.current = [];
    futureRef.current = [];
    lastPushAtRef.current = 0;
    setHistVersion((v) => v + 1);
  }, []);

  /** 绕过历史栈的状态写入：服务端规范快照 / 协作者覆盖时使用，不能被撤销 */
  const setAnnotationsRaw = useCallback((next: DraftAnnotation[]) => {
    setAnnotations(next);
  }, []);

  const undo = useCallback(() => {
    if (!canEditRef.current || pastRef.current.length === 0) return;
    const prev = pastRef.current.pop()!;
    futureRef.current.push(annotationsRef.current);
    // 重置合并窗口：撤销后的新编辑必须重新入栈，不能被并入上一手势
    lastPushAtRef.current = 0;
    setAnnotations(prev);
    setDirty(true);
    setHistVersion((v) => v + 1);
  }, []);

  const redo = useCallback(() => {
    if (!canEditRef.current || futureRef.current.length === 0) return;
    const next = futureRef.current.pop()!;
    pastRef.current.push(annotationsRef.current);
    lastPushAtRef.current = 0;
    setAnnotations(next);
    setDirty(true);
    setHistVersion((v) => v + 1);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [detailRes, annotationRes] = await Promise.all([
        fetch(`/api/items/${itemId}`),
        fetch(`/api/items/${itemId}/annotations`),
      ]);
      if (detailRes.status === 404) {
        router.replace('/spaces');
        return;
      }
      const detail = await detailRes.json();
      const annotationData = await annotationRes.json();

      setItem(detail.item ?? null);
      setAsset(detail.asset ?? null);
      setSpaceName(detail.space?.name ?? '');
      setTitle(detail.item?.title ?? '');
      setAccess(detail.access ?? null);
      setAnnotationsRaw((annotationData.annotations ?? []).map((row: DraftAnnotation) => hydrate(row)));
      resetHistory();
      setDirty(false);
      setSelectedKey(null);
      setSelectedKeys([]);
      setGroups(parseGroups(detail.labelplus?.groups));
      setPhrases(parsePhrases(detail.labelplus?.phrases));
      setNeighbors({
        prevId: detail.neighbors?.prevId ?? null,
        nextId: detail.neighbors?.nextId ?? null,
        items: detail.neighbors?.items ?? [],
      });
    } catch {
      setError('加载失败，请刷新重试');
    } finally {
      setLoading(false);
    }
  }, [itemId, router, setAnnotationsRaw, resetHistory]);

  useEffect(() => {
    if (!Number.isInteger(itemId) || itemId <= 0) {
      router.replace('/spaces');
      return;
    }
    void load();
  }, [itemId, load, router]);

  const applyChange = useCallback(
    (next: DraftAnnotation[]) => {
      pushHistory(annotationsRef.current);
      setAnnotations(next);
      setDirty(true);
    },
    [pushHistory],
  );

  const collab = useCollabRoom(Number.isInteger(itemId) ? itemId : 0);

  // 权限 = 空间权限 ∧ 房间状态（别人持锁未共享时整页转只读）
  const canEdit = (access?.canEdit ?? false) && (collab.room ? collab.room.canEdit : true);
  canEditRef.current = canEdit;

  // 收到别人的标注快照 → 直接覆盖本地（保持多人看到的画面一致）
  collab.onRemoteOp((op) => {
    if (op.kind === 'annotations') {
      const rows = (op.payload as { annotations?: unknown[] } | null)?.annotations;
      if (!Array.isArray(rows)) return;
      // 协作者快照绕过历史栈并清空：本地撤销不能跳回同步前的旧状态
      setAnnotationsRaw((rows as DraftAnnotation[]).map((row) => hydrate(row)));
      resetHistory();
      setDirty(false);
      setSyncNote('已同步协作者的标注更新');
      window.setTimeout(() => setSyncNote(null), 4000);
    }
  });

  const save = useCallback(async (rows?: DraftAnnotation[]) => {
    if (!item || !canEditRef.current) return;
    setSaving(true);
    setError(null);
    try {
      const source = rows ?? annotationsRef.current;
      const payload = source.map(({ key: _key, ...rest }) => rest);
      const res = await fetch(`/api/items/${itemId}/annotations`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ annotations: payload }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? '保存失败');
        return;
      }
      // 服务端规范快照绕过历史栈写入（key 沿用本地，历史栈保持可用）
      setAnnotationsRaw(
        (data.annotations ?? []).map((row: DraftAnnotation, index: number) => ({
          ...hydrate(row),
          key: annotationsRef.current[index]?.key ?? newKey(),
        })),
      );
      setDirty(false);
      setSavedAt(new Date().toLocaleTimeString('zh-CN'));
      // 广播给同房间的人：以服务端返回的规范状态为准
      void collab.sendOp('annotations', { annotations: data.annotations });
    } catch {
      setError('保存过程中发生网络错误');
    } finally {
      setSaving(false);
    }
  }, [item, itemId, collab]);

  useEffect(() => {
    if (!dirty || !canEdit || mode === 'box') return;
    const timer = window.setTimeout(() => void save(), 900);
    return () => window.clearTimeout(timer);
  }, [dirty, annotations, canEdit, mode, save]);

  async function saveTitle() {
    setEditingTitle(false);
    const next = title.trim();
    if (!next || next === item?.title) return;
    const res = await fetch(`/api/items/${itemId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: next }),
    });
    if (!res.ok) setError('重命名失败');
  }

  const goItem = useCallback(
    async (targetId: number | null) => {
      if (!targetId) return;
      if (dirtyRef.current && canEditRef.current) await save();
      router.push(`/annotate/${targetId}`);
    },
    [router, save],
  );

  const pins = useMemo(() => annotations.filter(isPin), [annotations]);

  // histVersion 只作为重渲染信号：栈内容在 ref 里，禁用态在渲染时读取
  const canUndo = useMemo(() => pastRef.current.length > 0, [histVersion]);
  const canRedo = useMemo(() => futureRef.current.length > 0, [histVersion]);

  /** 生效中的选中集：多选集合优先，否则退化为 selectedKey 单选 */
  const effectiveSelectedKeys = useMemo(
    () => (selectedKeys.length > 0 ? selectedKeys : selectedKey ? [selectedKey] : []),
    [selectedKeys, selectedKey],
  );

  /** 单选（面板点击 / 画布单击）：清空多选集合 */
  const selectOne = useCallback((key: string | null) => {
    setSelectedKeys([]);
    setSelectedKey(key);
  }, []);

  /** Ctrl+橡皮筋松开时回调：additive = Ctrl+Shift 加选 */
  const handleMultiSelect = useCallback(
    (keys: string[], additive: boolean) => {
      if (!canEditRef.current) return;
      const base = additive
        ? Array.from(new Set([...effectiveSelectedKeys, ...keys]))
        : keys;
      setSelectedKeys(base);
      setSelectedKey(base[0] ?? null);
    },
    [effectiveSelectedKeys],
  );

  /** 批量归组：把选中集里所有标注的 group_id 一次性改掉 */
  const batchSetGroup = useCallback(
    (id: number) => {
      if (!canEditRef.current || effectiveSelectedKeys.length === 0) return;
      const keySet = new Set(effectiveSelectedKeys);
      applyChange(
        annotationsRef.current.map((row) =>
          keySet.has(row.key) ? { ...row, group_id: id } : row,
        ),
      );
    },
    [effectiveSelectedKeys, applyChange],
  );

  /** 存疑切换（Alt+X / 面板按钮）：多选时批量统一为第一个选中项的反值 */
  const toggleDoubtful = useCallback(
    (keys: string[]) => {
      if (!canEditRef.current || keys.length === 0) return;
      const keySet = new Set(keys);
      const first = annotationsRef.current.find((row) => keySet.has(row.key));
      const target = !(first?.doubtful ?? false);
      applyChange(
        annotationsRef.current.map((row) =>
          keySet.has(row.key) ? { ...row, doubtful: target } : row,
        ),
      );
    },
    [applyChange],
  );

  /** 删除入口统一收口：先弹确认（支持批量），再由 ConfirmDialog 执行真正的删除 */
  const requestRemove = useCallback((key: string | null) => {
    if (!key || !canEditRef.current) return;
    setConfirmKeys([key]);
  }, []);

  /** 标号列表拖动排序：只重排 pin 的相对顺序，框选标注位置不动 */
  const reorderPins = useCallback(
    (fromKey: string, toKey: string) => {
      if (!canEditRef.current || fromKey === toKey) return;
      const current = annotationsRef.current;
      const pinRows = current.filter(isPin);
      const keys = pinRows.map((p) => p.key);
      const from = keys.indexOf(fromKey);
      const to = keys.indexOf(toKey);
      if (from < 0 || to < 0) return;
      keys.splice(to, 0, ...keys.splice(from, 1));
      const byKey = new Map(pinRows.map((p) => [p.key, p]));
      let slot = 0;
      applyChange(
        current.map((row) => (isPin(row) ? byKey.get(keys[slot++])! : row)),
      );
    },
    [applyChange],
  );

  /** 把短语追加到当前选中的标号译文末尾（按钮、快捷键共用） */
  const insertPhraseAtSelected = useCallback(
    (phrase: string) => {
      if (!selectedKey || !canEdit) return;
      applyChange(
        annotationsRef.current.map((row) =>
          row.key === selectedKey && isPin(row) ? { ...row, text: `${row.text}${phrase}` } : row,
        ),
      );
    },
    [selectedKey, canEdit, applyChange],
  );

  /** 保存分组名到空间（开放空间模型下人人可改） */
  const saveGroups = useCallback(
    async (next: LabelPlusGroup[]) => {
      setGroups(next);
      try {
        await fetch(`/api/spaces/${item?.space_id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ lp_groups: next }),
        });
      } catch {
        // 分组名保存失败不打断标注流程，刷新后会回到服务器上的值
      }
    },
    [item?.space_id],
  );

  /** 6b AI 翻译采纳：把译文写进对应标号并立即保存（走与 Ctrl+S 相同的保存路径） */
  const applyTranslations = useCallback(
    (updates: Array<{ id: number; text: string }>) => {
      if (!canEditRef.current || updates.length === 0) return;
      const byId = new Map(updates.map((u) => [u.id, u.text]));
      const next = annotationsRef.current.map((row) =>
        row.id !== undefined && byId.has(row.id) ? { ...row, text: byId.get(row.id)! } : row,
      );
      // AI 采纳是用户主动修改，走 applyChange 入历史栈，可撤销
      applyChange(next);
      setTranslateOpen(false);
      void save(next);
    },
    [applyChange, save],
  );

  const selectPinByOffset = useCallback(
    (delta: number) => {
      if (pins.length === 0) return;
      const index = pins.findIndex((p) => p.key === selectedKey);
      const next = pins[(index < 0 ? 0 : index + delta + pins.length) % pins.length];
      setSelectedKeys([]);
      setSelectedKey(next.key);
    },
    [pins, selectedKey],
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing = target ? ['INPUT', 'TEXTAREA'].includes(target.tagName) : false;

      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        if (canEdit) void save();
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
        event.preventDefault();
        selectPinByOffset(1);
        return;
      }
      // Alt+A 打开短语菜单：官方设计里录入译文时也要能呼出，所以在 typing 判断之前拦截
      if (event.altKey && (event.key === 'a' || event.key === 'A')) {
        event.preventDefault();
        setPhraseMenuOpen((v) => !v);
        return;
      }
      if (event.key === 'Escape') {
        setPhraseMenuOpen(false);
        // Escape 清空多选（单选保留）
        setSelectedKeys([]);
        return;
      }

      if (typing) return;

      // 撤销 / 重做：Ctrl+Z 撤销，Ctrl+Y 或 Ctrl+Shift+Z 重做
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        if (event.shiftKey) redo();
        else undo();
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'y') {
        event.preventDefault();
        redo();
        return;
      }
      // Alt+X 切换存疑（多选时批量切换全部）
      if (event.altKey && (event.key === 'x' || event.key === 'X')) {
        event.preventDefault();
        toggleDoubtful(effectiveSelectedKeys);
        return;
      }

      // A 快速插入预置短语（连按循环切换短语），对应官方"快速插入预置文本"
      if ((event.key === 'a' || event.key === 'A') && canEdit && phrases.length > 0) {
        event.preventDefault();
        const phrase = phrases[phraseCursor.current % phrases.length];
        phraseCursor.current = (phraseCursor.current + 1) % phrases.length;
        insertPhraseAtSelected(phrase);
        return;
      }
      // Tab 向后翻页（官方快捷键）
      if (event.key === 'Tab') {
        event.preventDefault();
        void goItem(neighbors.nextId);
        return;
      }

      if (event.key === 'q' || event.key === 'Q') setMode('browse');
      if (event.key === 'w' || event.key === 'W') setMode('label');
      if (event.key === 'e' || event.key === 'E') setMode('input');
      if (event.key === 'r' || event.key === 'R') setMode('review');
      if (event.key === 'v' || event.key === 'V') setHidePins((v) => !v);
      if (event.key === 'c' || event.key === 'C') setShowGroupNames((v) => !v);
      if (/^[1-9]$/.test(event.key)) {
        const id = Number(event.key);
        setDefaultGroupId(id);
        // 单选 = 原有行为（仅 pin 归组）；多选 = 批量归组（含框选标注）
        if (canEdit && effectiveSelectedKeys.length > 0) {
          if (effectiveSelectedKeys.length === 1) {
            applyChange(
              annotationsRef.current.map((row) =>
                row.key === selectedKey && isPin(row) ? { ...row, group_id: id } : row,
              ),
            );
          } else {
            batchSetGroup(id);
          }
        }
      }
      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        void goItem(neighbors.prevId);
      }
      if (event.key === 'ArrowRight') {
        event.preventDefault();
        void goItem(neighbors.nextId);
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        selectPinByOffset(-1);
      }
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        selectPinByOffset(1);
      }

      if (!canEdit) return;
      if ((event.key === 'Delete' || event.key === 'Backspace') && effectiveSelectedKeys.length > 0) {
        event.preventDefault();
        setConfirmKeys(effectiveSelectedKeys);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [
    annotations,
    selectedKey,
    effectiveSelectedKeys,
    save,
    applyChange,
    canEdit,
    neighbors,
    goItem,
    selectPinByOffset,
    phrases,
    insertPhraseAtSelected,
    undo,
    redo,
    toggleDoubtful,
    batchSetGroup,
  ]);

  useEffect(() => {
    if (!dirty) return;
    const handler = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty]);

  if (loading) {
    return <p className="py-20 text-center text-sm text-ink-500">加载中…</p>;
  }
  if (!item || !asset) {
    return (
      <div className="card py-20 text-center">
        <EmptyState padded={false} kaomoji="(・・?)" title={error ?? '图片不存在或已被移除'} />
        <Link href="/spaces" className="btn-ghost mt-2">
          返回空间列表
        </Link>
      </div>
    );
  }

  const imageWidth = asset.width ?? 1200;
  const imageHeight = asset.height ?? 800;
  const pinMode = mode !== 'box';

  return (
    <div className="flex h-[calc(100vh-7rem)] flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <Link href={`/spaces/${item.space_id}`} className="text-sm text-ink-400 hover:text-sky-deep">
          ← {spaceName || '返回空间'}
        </Link>
        <span className="text-ink-700">/</span>
        {editingTitle ? (
          <input
            autoFocus
            className="input max-w-xs py-1"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            onBlur={() => void saveTitle()}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void saveTitle();
              if (event.key === 'Escape') {
                setTitle(item.title ?? '');
                setEditingTitle(false);
              }
            }}
          />
        ) : (
          <button
            type="button"
            disabled={!canEdit}
            onClick={() => canEdit && setEditingTitle(true)}
            className={`text-sm font-medium ${
              canEdit ? 'text-ink-100 hover:text-sky-deep' : 'cursor-default text-ink-400'
            }`}
            title={canEdit ? '点击重命名' : undefined}
          >
            {item.title || '未命名'}
          </button>
        )}

        <div className="seg ml-2 flex flex-wrap gap-1">
          {MODES.map((entry) => (
            <button
              key={entry.id}
              type="button"
              className={`seg-btn ${mode === entry.id ? 'seg-btn-on' : ''}`}
              onClick={() => setMode(entry.id)}
              title={entry.key ? `${entry.label}（${entry.key}）` : entry.label}
            >
              {entry.label}
              {entry.key && <span className="ml-1 text-[10px] opacity-60">{entry.key}</span>}
            </button>
          ))}
          <button type="button" className="seg-btn" onClick={() => router.push(`/typeset/${itemId}`)}>
            嵌字
          </button>
        </div>

        {/* 撤销 / 重做：栈空或只读时禁用 */}
        <div className="flex items-center gap-1">
          <button
            type="button"
            className="btn-ghost px-2 py-1 text-xs"
            disabled={!canUndo}
            onClick={undo}
            title="撤销（Ctrl+Z）"
          >
            撤销
          </button>
          <button
            type="button"
            className="btn-ghost px-2 py-1 text-xs"
            disabled={!canRedo}
            onClick={redo}
            title="重做（Ctrl+Y / Ctrl+Shift+Z）"
          >
            重做
          </button>
        </div>

        <span className="ml-auto flex items-center gap-2">
          {collab.room?.holderName && !collab.room.isHolder && !collab.room.shared && (
            <span className="rounded bg-amber-500/20 px-2 py-1 text-xs text-amber-700">
              🔒 {collab.room.holderName} 正在编辑
            </span>
          )}
          {collab.room?.shared && (
            <span className="rounded bg-emerald-500/15 px-2 py-1 text-xs text-emerald-700">
              🟢 实时协作中
            </span>
          )}
          {collab.room?.isHolder && (
            <button
              type="button"
              className="btn-ghost px-2 py-1 text-xs"
              onClick={() => void collab.setShared(!collab.room?.shared)}
            >
              {collab.room?.shared ? '结束共享' : '共享编辑'}
            </button>
          )}
          {syncNote && <span className="text-xs text-sky-deep">{syncNote}</span>}
          {canEdit ? (
            <>
              <span className="text-xs text-ink-500">
                {dirty ? '有未保存的更改' : savedAt ? `已保存 ${savedAt}` : ''}
              </span>
              <button
                type="button"
                className="btn-primary"
                disabled={saving || !dirty}
                onClick={() => void save()}
              >
                {saving ? '保存中…' : '保存'}
              </button>
            </>
          ) : (
            <span className="rounded bg-ink-800 px-2 py-1 text-xs text-ink-400">只读</span>
          )}
        </span>
      </div>

      {error && <p className="notice-error">{error}</p>}

      <div className="flex min-h-0 flex-1 gap-5">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="relative flex min-h-0 flex-1 flex-col">
            <AnnotationCanvas
              imageSrc={originalUrl(asset.filename)}
              previewSrc={previewUrl(asset.filename)}
              imageWidth={imageWidth}
              imageHeight={imageHeight}
              annotations={annotations}
              selectedKey={selectedKey}
              selectedKeys={effectiveSelectedKeys}
              onSelect={selectOne}
              onMultiSelect={handleMultiSelect}
              onChange={applyChange}
              fileName={asset.original_name ?? asset.filename}
              readOnly={!canEdit}
              mode={mode}
              hidePins={hidePins}
              showGroupNames={showGroupNames || mode === 'review'}
              defaultGroupId={defaultGroupId}
              followSelection={mode === 'input'}
            />
            {/* 多选浮动工具条：批量删除 / 批量归组 */}
            {effectiveSelectedKeys.length > 1 && canEdit && (
              <div className="absolute left-1/2 top-3 z-20 flex -translate-x-1/2 items-center gap-3 rounded-lg border border-ink-700 bg-cloud px-3 py-2 shadow-card">
                <span className="text-xs text-ink-400">已选 {effectiveSelectedKeys.length} 项</span>
                <button
                  type="button"
                  className="btn-danger px-2 py-1 text-xs"
                  onClick={() => setConfirmKeys(effectiveSelectedKeys)}
                >
                  删除 ({effectiveSelectedKeys.length})
                </button>
                <div className="flex items-center gap-1">
                  {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((id) => (
                    <button
                      key={id}
                      type="button"
                      className="h-5 w-5 rounded-full text-[10px] text-white"
                      style={{ background: groupColor(id) }}
                      title={`批量归到分组 ${id}`}
                      onClick={() => batchSetGroup(id)}
                    >
                      {id}
                    </button>
                  ))}
                </div>
                <button
                  type="button"
                  className="btn-ghost px-2 py-1 text-xs"
                  onClick={() => setSelectedKeys([])}
                >
                  取消
                </button>
              </div>
            )}
            {mode === 'box' &&
              (() => {
                const selectedBox = annotations.find(
                  (a) => a.key === selectedKey && !isPin(a),
                );
                if (!selectedBox) return null;
                return (
                  <div className="absolute bottom-3 left-3 z-10">
                    <TextRenderPanel
                      annotation={selectedBox}
                      readOnly={!canEdit}
                      onChange={(patch) =>
                        applyChange(
                          annotations.map((a) =>
                            a.key === selectedBox.key ? { ...a, ...patch } : a,
                          ),
                        )
                      }
                    />
                  </div>
                );
              })()}
          </div>
          {neighbors.items.length > 1 && (
            <div className="mt-2 flex gap-2 overflow-x-auto pb-1">
              {neighbors.items.map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  onClick={() => void goItem(entry.id)}
                  className={`h-16 w-16 shrink-0 overflow-hidden rounded-md border ${
                    entry.id === itemId ? 'border-sky ring-1 ring-sky' : 'border-ink-700'
                  }`}
                  title={entry.title ?? entry.original_name ?? ''}
                >
                  <img
                    src={thumbUrl(entry.thumb_filename, entry.filename)}
                    alt=""
                    className="h-full w-full object-cover"
                  />
                </button>
              ))}
            </div>
          )}
        </div>

        <aside className="flex w-[350px] shrink-0 flex-col rounded-xl border border-ink-700 bg-cloud/80 p-3">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-medium text-ink-100">
              {pinMode ? '标号' : '标注'}{' '}
              <span className="text-ink-500">({pinMode ? pins.length : annotations.filter((a) => !isPin(a)).length})</span>
            </h2>
            <div className="flex items-center gap-2">
              {pinMode && canEdit && (
                <>
                  <button type="button" className="btn-ghost px-2 py-1 text-[11px]" onClick={() => setOcrOpen(true)}>
                    OCR 自动标号
                  </button>
                  <button type="button" className="btn-ghost px-2 py-1 text-[11px]" onClick={() => setTranslateOpen(true)}>
                    AI 翻译
                  </button>
                </>
              )}
              <span className="text-[11px] text-ink-400">
                {canEdit ? 'Ctrl+S · ←→ 翻图 · ↑↓ 切号' : '只读模式'}
              </span>
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto pr-1">
            {pinMode ? (
              <LabelPlusPanel
                annotations={annotations}
                selectedKey={selectedKey}
                selectedKeys={effectiveSelectedKeys}
                onToggleDoubtful={(key) => toggleDoubtful([key])}
                groups={groups}
                phrases={phrases}
                defaultGroupId={defaultGroupId}
                reviewMode={mode === 'review'}
                phraseMenuOpen={phraseMenuOpen}
                onClosePhraseMenu={() => setPhraseMenuOpen(false)}
                onSelect={selectOne}
                onChange={applyChange}
                readOnly={!canEdit}
                canManageGroups={canEdit}
                onDefaultGroup={setDefaultGroupId}
                onSaveGroups={(next) => void saveGroups(next)}
                onInsertPhrase={(phrase) => {
                  if (!selectedKey || !canEdit) return;
                  applyChange(
                    annotations.map((row) =>
                      row.key === selectedKey ? { ...row, text: `${row.text}${phrase}` } : row,
                    ),
                  );
                }}
                onRemove={requestRemove}
                onReorder={reorderPins}
              />
            ) : (
              <AnnotationPanel
                annotations={annotations.filter((a) => !isPin(a))}
                selectedKey={selectedKey}
                selectedKeys={effectiveSelectedKeys}
                onToggleDoubtful={(key) => toggleDoubtful([key])}
                imageHeight={imageHeight}
                onSelect={selectOne}
                onChange={(nextBoxes) => {
                  applyChange([...nextBoxes, ...annotations.filter(isPin)]);
                }}
                readOnly={!canEdit}
                onRemove={requestRemove}
              />
            )}
          </div>
        </aside>
      </div>
      {ocrOpen && (
        <OcrModal
          itemId={itemId}
          onClose={() => setOcrOpen(false)}
          onApplied={() => void load()}
        />
      )}
      {translateOpen && (
        <TranslateModal
          itemId={itemId}
          onClose={() => setTranslateOpen(false)}
          onApply={applyTranslations}
        />
      )}
      <ConfirmDialog
        open={confirmKeys !== null}
        title="删除标注"
        message={
          confirmKeys && confirmKeys.length > 1
            ? `确认删除选中的 ${confirmKeys.length} 个标注？删除后会随下次保存写入服务器，无法恢复。`
            : '确认删除选中的标注？删除后会随下次保存写入服务器，无法恢复。'
        }
        onConfirm={() => {
          const keys = confirmKeys;
          setConfirmKeys(null);
          if (!keys || keys.length === 0) return;
          const keySet = new Set(keys);
          applyChange(annotationsRef.current.filter((annotation) => !keySet.has(annotation.key)));
          setSelectedKeys([]);
          if (selectedKey && keySet.has(selectedKey)) setSelectedKey(null);
        }}
        onCancel={() => setConfirmKeys(null)}
      />
    </div>
  );
}
