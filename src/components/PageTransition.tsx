'use client';

import { usePageEnter } from '@/lib/motion';
import type { ReactNode } from 'react';

/**
 * 应用主内容的入场过渡：淡入 + 轻微上浮。
 * 只包一层 div，编辑器内部零动效（工具界面要稳）。
 */
export default function PageTransition({ children }: { children: ReactNode }) {
  const scope = usePageEnter([]);
  return (
    <div ref={scope}>
      {children}
    </div>
  );
}
