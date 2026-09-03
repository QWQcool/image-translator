'use client';

/**
 * 危险操作（删除）二次确认弹窗。
 * 编辑器内遵循项目规范零动效；点击遮罩或 Esc 关闭，Enter 确认。
 */
export default function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = '确认删除',
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4"
      role="presentation"
      onClick={onCancel}
      onKeyDown={(event) => {
        if (event.key === 'Escape') onCancel();
        if (event.key === 'Enter') {
          event.preventDefault();
          onConfirm();
        }
      }}
    >
      <div
        className="card w-full max-w-sm p-4"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(event) => event.stopPropagation()}
      >
        <h3 className="text-sm font-medium text-ink-100">{title}</h3>
        <p className="mt-2 text-xs leading-relaxed text-ink-400">{message}</p>
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" className="btn-ghost px-3 py-1 text-xs" onClick={onCancel}>
            取消
          </button>
          <button type="button" className="btn-danger px-3 py-1 text-xs" autoFocus onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
