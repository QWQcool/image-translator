/**
 * 七级进度体系常量（阶段 15）：前端展示与服务端白名单共用。
 * 替代阶段 8 的两态 status（active/finished，已废弃仅保留列兼容）。
 */

export const SPACE_PROGRESS_VALUES = [
  'untranslated',
  'translated_placeholder',
  'translated',
  'proofread_placeholder',
  'proofread',
  'typeset_placeholder',
  'typeset_done',
] as const;

export type SpaceProgress = (typeof SPACE_PROGRESS_VALUES)[number];

/** 七态中文标签 */
export const PROGRESS_LABEL: Record<SpaceProgress, string> = {
  untranslated: '未翻译',
  translated_placeholder: '翻译已占位',
  translated: '已翻译',
  proofread_placeholder: '校对已占位',
  proofread: '已校对',
  typeset_placeholder: '嵌字已占位',
  typeset_done: '已嵌字',
};

/** 服务端白名单判断（PATCH 校验、GET 筛选参数清洗共用） */
export function isSpaceProgress(value: unknown): value is SpaceProgress {
  return (
    typeof value === 'string' &&
    (SPACE_PROGRESS_VALUES as readonly string[]).includes(value)
  );
}

/**
 * 徽标配色梯度：ink 灰（未翻译）→ sky（翻译/校对）→ emerald（嵌字）渐进；
 * placeholder 态用描边空心样式；typeset_done 用 emerald 实心收尾。
 */
export const PROGRESS_BADGE_CLASS: Record<SpaceProgress, string> = {
  untranslated: 'bg-ink-800 text-ink-400',
  translated_placeholder: 'border border-sky/40 text-sky-deep',
  translated: 'bg-sky/15 text-sky-deep',
  proofread_placeholder: 'border border-sky/60 text-sky-deep',
  proofread: 'bg-emerald-500/15 text-emerald-700',
  typeset_placeholder: 'border border-emerald-500/60 text-emerald-700',
  typeset_done: 'bg-emerald-500 text-white',
};

/**
 * 「当前状态已维持 X」相对时长：SQLite UTC 字符串（YYYY-MM-DD HH:MM:SS）解析；
 * <1h 显示分钟、<24h 显示小时、其余显示天数。
 */
export function formatProgressAge(progressAt: string): string {
  const date = new Date(
    progressAt.includes('T') ? progressAt : `${progressAt.replace(' ', 'T')}Z`,
  );
  if (Number.isNaN(date.getTime())) return '';
  const ms = Date.now() - date.getTime();
  if (ms <= 0) return '刚刚';
  if (ms < 3_600_000) return `${Math.max(1, Math.floor(ms / 60_000))} 分钟`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)} 小时`;
  return `${Math.floor(ms / 86_400_000)} 天`;
}
