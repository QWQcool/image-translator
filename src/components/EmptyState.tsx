import type { ReactNode } from 'react';

export default function EmptyState({
  kaomoji = '(´∀｀)♡',
  title,
  hint,
  showMascot = false,
  padded = true,
}: {
  kaomoji?: string;
  title: string;
  hint?: ReactNode;
  showMascot?: boolean;
  padded?: boolean;
}) {
  return (
    <div className={padded ? 'card px-6 py-16 text-center' : 'px-6 py-16 text-center'}>
      {showMascot && (
        <img
          src="/mascot/mascot-bust.png"
          alt=""
          className="mx-auto mb-4 h-[4.5rem] w-[4.5rem] rounded-full object-cover object-top ring-2 ring-halo/70"
        />
      )}
      <p className="font-display text-[1.7rem] leading-none text-sky-deep">{kaomoji}</p>
      <p className="mt-3 text-sm text-ink-200">{title}</p>
      {hint ? <div className="mt-1.5 text-xs leading-relaxed text-ink-500">{hint}</div> : null}
    </div>
  );
}
