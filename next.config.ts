import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  serverExternalPackages: ['better-sqlite3', 'sharp'],
  // Docker 镜像构建时启用 standalone 产物（见 Dockerfile，构建期设 NEXT_OUTPUT=standalone）。
  // 默认不开：体验版便携包（scripts/package-portable.ps1）走标准 next start 链路，
  // standalone 对 better-sqlite3 / sharp 原生模块的 trace 在 Windows 上风险不可控（见 release.yml 注释）。
  ...(process.env.NEXT_OUTPUT === 'standalone' ? { output: 'standalone' as const } : {}),
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
