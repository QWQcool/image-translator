'use client';

import { useEffect, useState } from 'react';
import { DEFAULT_PRESET_TAGS, DEFAULT_PROGRESS_ITEMS, type ProgressItem } from './site-config';

export type SiteConfig = {
  progressItems: ProgressItem[];
  presetTags: string[];
};

/**
 * 站点配置（/api/settings）的客户端读取：挂载时拉取一次。
 * 失败/未配置静默回落内置默认（PRESET_TAGS / 七态全启用），不打扰用户。
 */
export function useSiteConfig(): SiteConfig {
  const [progressItems, setProgressItems] = useState<ProgressItem[]>(DEFAULT_PROGRESS_ITEMS);
  const [presetTags, setPresetTags] = useState<string[]>([...DEFAULT_PRESET_TAGS]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch('/api/settings');
        if (!res.ok) return;
        const data = await res.json();
        if (cancelled) return;
        if (Array.isArray(data.progressItems) && data.progressItems.length > 0) {
          setProgressItems(data.progressItems as ProgressItem[]);
        }
        if (Array.isArray(data.presetTags)) setPresetTags(data.presetTags as string[]);
      } catch {
        // 网络失败保持内置默认
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return { progressItems, presetTags };
}
