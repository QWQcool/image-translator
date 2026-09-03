'use client';

import { useState } from 'react';
import EmptyState from '@/components/EmptyState';
import Modal from '@/components/Modal';
import { isPin, type DraftAnnotation } from '@/lib/annotation';
import { groupColor } from '@/lib/labelplus';
import { checkText, fixText, type TextIssue } from '@/lib/text-check';
import type { LabelPlusGroup } from '@/lib/types';

export default function LabelPlusPanel({
  annotations,
  selectedKey,
  selectedKeys,
  onToggleDoubtful,
  groups,
  phrases,
  defaultGroupId,
  reviewMode,
  phraseMenuOpen,
  onClosePhraseMenu,
  onSelect,
  onChange,
  onRemove,
  onReorder,
  onDefaultGroup,
  onSaveGroups,
  onInsertPhrase,
  readOnly,
  canManageGroups,
}: {
  annotations: DraftAnnotation[];
  selectedKey: string | null;
  /** 多选集合（含 selectedKey），在集合内的卡片都高亮 */
  selectedKeys?: string[];
  /** 存疑切换（单张） */
  onToggleDoubtful?: (key: string) => void;
  groups: LabelPlusGroup[];
  phrases: string[];
  defaultGroupId: number;
  reviewMode: boolean;
  phraseMenuOpen: boolean;
  onClosePhraseMenu: () => void;
  onSelect: (key: string) => void;
  onChange: (next: DraftAnnotation[]) => void;
  onRemove: (key: string) => void;
  onReorder: (fromKey: string, toKey: string) => void;
  onDefaultGroup: (id: number) => void;
  onSaveGroups: (next: LabelPlusGroup[]) => void;
  onInsertPhrase: (phrase: string) => void;
  readOnly: boolean;
  canManageGroups: boolean;
}) {
  const pins = annotations.filter(isPin);
  const [editingGroups, setEditingGroups] = useState(false);
  // 9 个槽位的本地草稿，点保存才落库
  const [groupDraft, setGroupDraft] = useState<LabelPlusGroup[]>([]);
  // 拖动排序：dragKey = 正在被拖动的标号，overKey = 悬停目标（高亮用）
  const [dragKey, setDragKey] = useState<string | null>(null);
  const [overKey, setOverKey] = useState<string | null>(null);
  // 标点检查：结果按标号分组；null = 未检查
  const [checkResults, setCheckResults] = useState<
    Array<{ key: string; index: number; issues: TextIssue[] }> | null
  >(null);
  const [allOk, setAllOk] = useState(false);

  /** 检查当前图所有 pin 译文（纯前端，不阻塞导出/翻译） */
  function runCheck() {
    const found: Array<{ key: string; index: number; issues: TextIssue[] }> = [];
    pins.forEach((pin, index) => {
      const issues = checkText(pin.text);
      if (issues.length > 0) found.push({ key: pin.key, index, issues });
    });
    setCheckResults(found.length > 0 ? found : []);
    setAllOk(found.length === 0);
    if (found.length === 0) {
      window.setTimeout(() => setAllOk(false), 3000);
    }
  }

  /** 一键修复：只修 fixable 项（走 applyChange 保存链路，可撤销） */
  function applyFixes() {
    onChange(
      annotations.map((row) =>
        isPin(row) && row.text ? { ...row, text: fixText(row.text) } : row,
      ),
    );
    setCheckResults(null);
  }

  /** 点检查结果：选中对应标号卡片并滚动过去 */
  function focusPin(key: string) {
    onSelect(key);
    requestAnimationFrame(() => {
      document
        .querySelector(`[data-annotation-key="${key}"]`)
        ?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    });
  }

  function patch(key: string, updates: Partial<DraftAnnotation>) {
    onChange(annotations.map((item) => (item.key === key ? { ...item, ...updates } : item)));
  }

  function startGroupEdit() {
    setGroupDraft(Array.from({ length: 9 }, (_, i) => {
      const found = groups.find((g) => g.id === i + 1);
      return { id: i + 1, name: found?.name ?? '' };
    }));
    setEditingGroups(true);
  }

  function commitGroups() {
    const next = groupDraft.filter((g) => g.name.trim());
    onSaveGroups(next.map((g) => ({ id: g.id, name: g.name.trim().slice(0, 20) })));
    setEditingGroups(false);
  }

  if (pins.length === 0 && !editingGroups) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2">
        <EmptyState
          padded={false}
          kaomoji="(๑•̀ㅂ•́)و✧"
          title="还没有标号"
          hint={readOnly ? '只读权限，无法添加标号。' : '切换到「标号」模式，在图上单击放置编号。'}
        />
        {canManageGroups && (
          <button type="button" className="btn-ghost px-2 py-1 text-xs" onClick={startGroupEdit}>
            编辑分组
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="relative space-y-3">
      {editingGroups ? (
        <div className="rounded-lg border border-sky/40 bg-cloud p-3">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-xs font-medium text-ink-200">分组设置（最多 9 组）</span>
            <button
              type="button"
              className="rounded px-1 text-[11px] text-ink-400 hover:text-ink-100"
              onClick={() => setEditingGroups(false)}
            >
              取消
            </button>
          </div>
          <div className="space-y-1.5">
            {groupDraft.map((group) => (
              <div key={group.id} className="flex items-center gap-2">
                <span
                  className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] text-white"
                  style={{ background: groupColor(group.id) }}
                >
                  {group.id}
                </span>
                <input
                  className="input h-7 flex-1 py-0 text-xs"
                  value={group.name}
                  maxLength={20}
                  placeholder={`分组 ${group.id} 名称（留空 = 不启用）`}
                  onChange={(e) =>
                    setGroupDraft((prev) =>
                      prev.map((g) => (g.id === group.id ? { ...g, name: e.target.value } : g)),
                    )
                  }
                />
              </div>
            ))}
          </div>
          <div className="mt-2 flex items-center justify-between">
            <span className="text-[11px] text-ink-500">
              已启用 {groupDraft.filter((g) => g.name.trim()).length} 组，保存后全站共用这份分组表
            </span>
            <button type="button" className="btn-primary px-2 py-1 text-xs" onClick={commitGroups}>
              保存分组
            </button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-1">
          {groups.map((group) => (
            <button
              key={group.id}
              type="button"
              onClick={() => onDefaultGroup(group.id)}
              className={`rounded-md px-2 py-0.5 text-[11px] ${
                defaultGroupId === group.id ? 'text-white' : 'text-ink-200'
              }`}
              style={{
                background: defaultGroupId === group.id ? groupColor(group.id) : 'transparent',
                border: `1px solid ${groupColor(group.id)}`,
              }}
              title={`快捷键 ${group.id}`}
            >
              {group.id} {group.name}
            </button>
          ))}
          {canManageGroups && (
            <button
              type="button"
              onClick={startGroupEdit}
              className="rounded-md border border-dashed border-ink-700 px-1.5 py-0.5 text-[11px] text-ink-400 hover:border-sky hover:text-ink-100"
              title="增减分组 / 修改分组名"
            >
              分组
            </button>
          )}
          {/* 标点规范检查（纯前端提示，不阻塞导出/翻译） */}
          <button
            type="button"
            onClick={runCheck}
            className="btn-ghost ml-auto px-2 py-0.5 text-[11px]"
            title="检查本图所有标号译文的标点规范"
          >
            检查
          </button>
          {allOk && <span className="text-[11px] text-emerald-600">全部规范</span>}
        </div>
      )}

      {!readOnly && phrases.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {phrases.map((phrase) => (
            <button
              key={phrase}
              type="button"
              className="rounded-md border border-ink-700 bg-paper px-1.5 py-0.5 text-[11px] text-ink-300 hover:border-sky"
              onClick={() => onInsertPhrase(phrase)}
            >
              {phrase}
            </button>
          ))}
          <span className="self-center text-[10px] text-ink-500" title="官方快捷键：A 插入预置文本，Alt+A 呼出菜单">
            A / Alt+A
          </span>
        </div>
      )}

      {phraseMenuOpen && phrases.length > 0 && (
        <div className="absolute right-2 top-2 z-20 w-48 rounded-lg border border-sky/40 bg-cloud p-2 shadow-lg">
          <div className="mb-1 flex items-center justify-between">
            <span className="text-[11px] font-medium text-ink-200">插入短语 (Alt+A)</span>
            <button
              type="button"
              className="rounded px-1 text-[11px] text-ink-400 hover:text-ink-100"
              onClick={onClosePhraseMenu}
            >
              ✕
            </button>
          </div>
          <div className="max-h-56 space-y-1 overflow-y-auto">
            {phrases.map((phrase) => (
              <button
                key={phrase}
                type="button"
                className="block w-full rounded px-2 py-1 text-left text-xs text-ink-200 hover:bg-sky/15"
                onClick={() => {
                  onInsertPhrase(phrase);
                  onClosePhraseMenu();
                }}
              >
                {phrase}
              </button>
            ))}
          </div>
        </div>
      )}

      {pins.map((pin, index) => {
        const active = pin.key === selectedKey || (selectedKeys?.includes(pin.key) ?? false);
        const group = groups.find((g) => g.id === pin.group_id);
        return (
          <div
            key={pin.key}
            data-annotation-key={pin.key}
            onMouseDown={() => onSelect(pin.key)}
            onDragOver={(event) => {
              if (dragKey && dragKey !== pin.key) {
                event.preventDefault();
                setOverKey(pin.key);
              }
            }}
            onDrop={(event) => {
              event.preventDefault();
              if (dragKey && dragKey !== pin.key) onReorder(dragKey, pin.key);
              setDragKey(null);
              setOverKey(null);
            }}
            className={`rounded-lg border p-3 ${active ? 'border-sky bg-sky/5' : 'border-ink-700 bg-cloud'} ${
              dragKey && overKey === pin.key ? 'ring-1 ring-sky' : ''
            }`}
          >
            <div className="mb-2 flex items-center justify-between">
              <span className="flex items-center gap-2 text-xs font-medium text-ink-200">
                {!readOnly && pins.length > 1 && (
                  <span
                    draggable
                    onDragStart={(event) => {
                      setDragKey(pin.key);
                      event.dataTransfer.effectAllowed = 'move';
                      event.dataTransfer.setData('text/plain', pin.key);
                    }}
                    onDragEnd={() => {
                      setDragKey(null);
                      setOverKey(null);
                    }}
                    className="cursor-grab select-none px-0.5 text-ink-600 hover:text-ink-200"
                    title="拖动调整标号顺序（影响编号、Tab 跳转与 AI 翻译顺序）"
                  >
                    ⠿
                  </span>
                )}
                <span
                  className="inline-flex h-5 w-5 items-center justify-center rounded-full text-[11px] text-white"
                  style={{ background: groupColor(pin.group_id) }}
                >
                  {index + 1}
                </span>
                {group?.name ?? `组${pin.group_id}`}
              </span>
              <div className="flex items-center gap-2 text-[11px] text-ink-500">
                {pin.updated_by_username && <span>{pin.updated_by_username}</span>}
                {/* 存疑徽标 + 切换按钮（样式随状态变化） */}
                {!readOnly && onToggleDoubtful && (
                  <button
                    type="button"
                    onClick={() => onToggleDoubtful(pin.key)}
                    title="标记 / 取消存疑（Alt+X）"
                    className={`rounded px-1.5 py-0.5 text-[10px] ${
                      pin.doubtful
                        ? 'bg-amber-500/20 font-medium text-amber-600'
                        : 'text-ink-500 hover:bg-ink-700/40 hover:text-ink-200'
                    }`}
                  >
                    存疑
                  </button>
                )}
                {/* 只读时无切换按钮，用静态徽标展示状态（可编辑态由上方按钮承担） */}
                {readOnly && pin.doubtful && (
                  <span className="rounded bg-amber-500/20 px-1.5 py-0.5 text-[10px] font-medium text-amber-600">
                    存疑
                  </span>
                )}
                {!readOnly && (
                  <button
                    type="button"
                    onClick={() => onRemove(pin.key)}
                    className="rounded px-1 text-blush hover:bg-blush/15"
                  >
                    删除
                  </button>
                )}
              </div>
            </div>

            <label className="mb-1 block text-[11px] text-ink-500">原文</label>
            <textarea
              className="input min-h-[52px] resize-y text-xs disabled:opacity-60"
              placeholder="OCR / 原文"
              value={pin.source_text}
              disabled={readOnly}
              onChange={(event) => patch(pin.key, { source_text: event.target.value })}
              onFocus={() => onSelect(pin.key)}
            />
            <label className="mb-1 mt-2 block text-[11px] text-ink-500">译文</label>
            <textarea
              className="input min-h-[68px] resize-y text-xs disabled:opacity-60"
              placeholder={readOnly ? '（只读）' : 'Ctrl+Enter 下一项'}
              value={pin.text}
              disabled={readOnly}
              onChange={(event) => patch(pin.key, { text: event.target.value })}
              onFocus={() => onSelect(pin.key)}
            />

            {reviewMode && (
              <>
                <label className="mb-1 mt-2 block text-[11px] text-ink-500">审校批注</label>
                <textarea
                  className="input min-h-[48px] resize-y text-xs disabled:opacity-60"
                  placeholder="给嵌字员的备注"
                  value={pin.comment}
                  disabled={readOnly}
                  onChange={(event) => patch(pin.key, { comment: event.target.value })}
                  onFocus={() => onSelect(pin.key)}
                />
              </>
            )}

            {!readOnly && (
              <div className="mt-2 flex flex-wrap gap-1">
                {groups.map((groupOption) => (
                  <button
                    key={groupOption.id}
                    type="button"
                    onClick={() => patch(pin.key, { group_id: groupOption.id })}
                    className={`rounded px-1.5 py-0.5 text-[10px] ${
                      pin.group_id === groupOption.id ? 'text-white' : 'text-ink-400'
                    }`}
                    style={{
                      background: pin.group_id === groupOption.id ? groupColor(groupOption.id) : 'transparent',
                      border: `1px solid ${groupColor(groupOption.id)}`,
                    }}
                  >
                    {groupOption.id}
                  </button>
                ))}
              </div>
            )}
          </div>
        );
      })}

      {/* 标点检查结果弹层：点击问题定位到对应卡片 */}
      <Modal
        open={checkResults !== null}
        title="标点规范检查"
        onClose={() => setCheckResults(null)}
        footer={
          <>
            <button type="button" className="btn-ghost" onClick={() => setCheckResults(null)}>
              关闭
            </button>
            {!readOnly && checkResults && checkResults.length > 0 && (
              <button type="button" className="btn-primary" onClick={applyFixes}>
                一键修复
              </button>
            )}
          </>
        }
      >
        {checkResults && checkResults.length === 0 ? (
          <p className="text-sm text-emerald-600">全部规范，没有发现问题。</p>
        ) : (
          <div className="max-h-80 space-y-3 overflow-y-auto">
            {checkResults?.map((group) => (
              <div key={group.key} className="rounded-lg border border-ink-700 p-2">
                <button
                  type="button"
                  className="text-xs font-medium text-sky-deep hover:underline"
                  onClick={() => focusPin(group.key)}
                >
                  标号 {group.index + 1}（{group.issues.length} 个问题）
                </button>
                <ul className="mt-1 space-y-1">
                  {group.issues.map((issue, i) => (
                    <li key={i} className="text-[11px] text-ink-300">
                      <span
                        className={`mr-1 rounded px-1 py-0.5 text-[10px] ${
                          issue.fixable
                            ? 'bg-sky/15 text-sky-deep'
                            : 'bg-amber-500/15 text-amber-600'
                        }`}
                      >
                        {issue.rule}
                      </span>
                      {issue.message}
                      <span className="ml-1 text-ink-500">{issue.snippet}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
            <p className="text-[11px] text-ink-500">
              蓝色规则可自动修复（省略号 / 多余空行 / 首尾空白），amber 规则仅提示。
            </p>
          </div>
        )}
      </Modal>
    </div>
  );
}
