'use client';

import {
  PROGRESS_BADGE_CLASS,
  PROGRESS_LABEL,
  formatProgressAge,
  type SpaceProgress,
} from '@/lib/progress';

type Props = {
  progress: SpaceProgress;
  /** 进入当前进度的时间（SQLite UTC），用于 hover 提示「已维持 X」 */
  progressAt: string;
  className?: string;
};

/** 七级进度徽标：配色梯度 + hover 显示维持时长（列表卡片与详情页共用） */
export default function ProgressBadge({ progress, progressAt, className = '' }: Props) {
  const age = formatProgressAge(progressAt);
  return (
    <span
      title={age ? `当前状态已维持 ${age}` : undefined}
      className={`rounded px-1.5 py-0.5 text-[11px] ${PROGRESS_BADGE_CLASS[progress]} ${className}`}
    >
      {PROGRESS_LABEL[progress]}
    </span>
  );
}
