'use client';

import EmptyState from '@/components/EmptyState';
import { isPin, type DraftAnnotation } from '@/lib/annotation';
import { groupColor } from '@/lib/labelplus';
import type { LabelPlusGroup } from '@/lib/types';

export default function LabelPlusPanel({
  annotations,
  selectedKey,
  groups,
  phrases,
  defaultGroupId,
  reviewMode,
  onSelect,
  onChange,
  onRemove,
  onDefaultGroup,
  onInsertPhrase,
  readOnly,
}: {
  annotations: DraftAnnotation[];
  selectedKey: string | null;
  groups: LabelPlusGroup[];
  phrases: string[];
  defaultGroupId: number;
  reviewMode: boolean;
  onSelect: (key: string) => void;
  onChange: (next: DraftAnnotation[]) => void;
  onRemove: (key: string) => void;
  onDefaultGroup: (id: number) => void;
  onInsertPhrase: (phrase: string) => void;
  readOnly: boolean;
}) {
  const pins = annotations.filter(isPin);

  function patch(key: string, updates: Partial<DraftAnnotation>) {
    onChange(annotations.map((item) => (item.key === key ? { ...item, ...updates } : item)));
  }

  if (pins.length === 0) {
    return (
      <div className="flex h-full items-center justify-center">
        <EmptyState
          padded={false}
          kaomoji="(๑•̀ㅂ•́)و✧"
          title="还没有标号"
          hint={readOnly ? '只读权限，无法添加标号。' : '切换到「标号」模式，在图上单击放置编号。'}
        />
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-1">
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
      </div>

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
        </div>
      )}

      {pins.map((pin, index) => {
        const active = pin.key === selectedKey;
        const group = groups.find((g) => g.id === pin.group_id);
        return (
          <div
            key={pin.key}
            onMouseDown={() => onSelect(pin.key)}
            className={`rounded-lg border p-3 ${active ? 'border-sky bg-sky/5' : 'border-ink-700 bg-cloud'}`}
          >
            <div className="mb-2 flex items-center justify-between">
              <span className="flex items-center gap-2 text-xs font-medium text-ink-200">
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
    </div>
  );
}
