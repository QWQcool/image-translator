import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  serverExternalPackages: ['better-sqlite3', 'sharp'],
  // E2E 测试（playwright.config.ts）通过 NEXT_DIST_DIR 把构建/运行产物指到
  // .next-e2e-* 独立目录：同一项目目录下用户的 dev server（.next）与 E2E 生产构建
  // 互不覆盖。不设置该变量时行为与原来完全一致（distDir 默认 .next）。
  ...(process.env.NEXT_DIST_DIR ? { distDir: process.env.NEXT_DIST_DIR } : {}),
  experimental: {
    serverActions: {
      bodySizeLimit: '50mb',
    },
  },
};

export default nextConfig;
