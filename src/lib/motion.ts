'use client';

import gsap from 'gsap';
import { useGSAP } from '@gsap/react';
import { useRef } from 'react';

gsap.registerPlugin(useGSAP);

/**
 * 全站动效基线：
 * - 编辑器（标注/嵌字/阅读器）保持零动效，只有展示页用这里的助手
 * - 一律走 gsap.matchMedia，prefers-reduced-motion 时自动归零
 */

/** 页面主内容入场：淡入 + 轻微上浮 */
export function usePageEnter(deps: unknown[] = []) {
  const scope = useRef<HTMLDivElement>(null);
  useGSAP(
    () => {
      const mm = gsap.matchMedia();
      mm.add(
        {
          reduceMotion: '(prefers-reduced-motion: reduce)',
          motionOK: '(prefers-reduced-motion: no-preference)',
        },
        (context) => {
          const reduceMotion = Boolean(context.conditions?.reduceMotion);
          gsap.from(scope.current?.children ?? [], {
            autoAlpha: 0,
            y: reduceMotion ? 0 : 14,
            duration: reduceMotion ? 0 : 0.5,
            stagger: reduceMotion ? 0 : 0.06,
            ease: 'power2.out',
            clearProps: 'transform,visibility',
          });
        },
        scope,
      );
      return () => mm.revert();
    },
    { scope, dependencies: deps },
  );
  return scope;
}

/** 卡片网格入场：逐张上浮错开 */
export function useStaggerReveal(itemSelector: string, deps: unknown[] = []) {
  const scope = useRef<HTMLDivElement>(null);
  useGSAP(
    () => {
      const mm = gsap.matchMedia();
      mm.add(
        {
          reduceMotion: '(prefers-reduced-motion: reduce)',
          motionOK: '(prefers-reduced-motion: no-preference)',
        },
        (context) => {
          const reduceMotion = Boolean(context.conditions?.reduceMotion);
          gsap.from(scope.current?.querySelectorAll(itemSelector) ?? [], {
            autoAlpha: 0,
            y: reduceMotion ? 0 : 22,
            duration: reduceMotion ? 0 : 0.55,
            stagger: reduceMotion ? 0 : 0.07,
            ease: 'power2.out',
            clearProps: 'transform,visibility',
          });
        },
        scope,
      );
      return () => mm.revert();
    },
    { scope, dependencies: deps },
  );
  return scope;
}

/** 顶栏下滑入场 */
export function useSlideDown(deps: unknown[] = []) {
  const scope = useRef<HTMLElement>(null);
  useGSAP(
    () => {
      const mm = gsap.matchMedia();
      mm.add(
        {
          reduceMotion: '(prefers-reduced-motion: reduce)',
          motionOK: '(prefers-reduced-motion: no-preference)',
        },
        (context) => {
          const reduceMotion = Boolean(context.conditions?.reduceMotion);
          gsap.from(scope.current, {
            autoAlpha: 0,
            yPercent: reduceMotion ? 0 : -100,
            duration: reduceMotion ? 0 : 0.45,
            ease: 'power3.out',
          });
        },
        scope,
      );
      return () => mm.revert();
    },
    { scope, dependencies: deps },
  );
  return scope;
}
