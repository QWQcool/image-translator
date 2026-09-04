'use client';

import {
  PROGRESS_BADGE_CLASS,
  PROGRESS_LABEL,
  formatProgressAge,
  type SpaceProgress,
} from '@/lib/progress';

type Props = {
  progress: SpaceProgress;
  /** 进入当前进度的时间（SQLite UTC），用于「已维持 X」时长 */
  progressAt: string;
  /** 站点配置的展示名（缺省回落内置 PROGRESS_LABEL） */
  label?: string;
  /** 徽标右侧直接显示「· 已维持 X」小字（列表卡片与详情页） */
  showAge?: boolean;
  /** 可点击纹理圈：详情页徽标点击弹进度菜单的可视提示（ring + 虚线 outline） */
  clickable?: boolean;
  className?: string;
};

/** 七级进度徽标：配色梯度；维持时长以右侧小字直接外显（不再只靠 hover） */
export default function ProgressBadge({
  progress,
  progressAt,
  label,
  showAge = false,
  clickable = false,
  className = '',
}: Props) {
  const age = formatProgressAge(progressAt);
  const clickableClass = clickable
    ? 'cursor-pointer ring-1 ring-sky/40 outline-dotted outline-1 outline-offset-1 outline-sky/40 transition hover:brightness-110'
    : '';
  return (
    <span className={`inline-flex items-center gap-1 ${className}`}>
      <span
        title={clickable ? '点击切换进度' : age ? `当前状态已维持 ${age}` : undefined}
        className={`rounded px-1.5 py-0.5 text-[11px] ${PROGRESS_BADGE_CLASS[progress]} ${clickableClass}`}
      >
        {label ?? PROGRESS_LABEL[progress]}
      </span>
      {showAge && age && <span className="text-[10px] text-ink-400">· 已维持 {age}</span>}
    </span>
  );
}
