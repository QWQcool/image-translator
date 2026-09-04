import crypto from 'node:crypto';
import { db } from './db';
import type { User } from './types';

/**
 * 试用模式（TRIAL_MODE=1）——仅限本机体验，严禁用于公网部署。
 *
 * 语义：启用后所有请求自动视为内置体验用户（username='trial'）：
 * - 无需登录/注册，登录页不可达（middleware 放行 + /login 重定向回 /spaces）
 * - 体验用户不可登出（登出后被弹回 /spaces，属预期行为）
 * - 体验用户非管理员（is_admin=0），邀请码管理卡片自然不渲染
 *
 * 安全护栏：
 * - 数据全部落在本机 DATA_DIR（便携包内为 data/），请勿把该实例暴露到公网
 * - 便携包构建（.github/workflows/release.yml）在 build 前设置 TRIAL_MODE=1：
 *   middleware 运行于 Edge runtime，其环境变量在构建期内联，运行时设置只对
 *   server 侧（本文件 / auth.ts / 页面组件）生效——构建期+运行期双保险
 * - 正常部署（不设置 TRIAL_MODE）时本模块行为完全休眠，零影响
 */

/** 试用模式下启动日志的醒目警告（每进程打印一次） */
if (process.env.TRIAL_MODE === '1' && process.env.NEXT_PHASE !== 'phase-production-build') {
  // eslint-disable-next-line no-console
  console.warn(
    [
      '',
      '==========================================================',
      '  ⚠️  TRIAL_MODE 试用模式已启用（仅限本机体验）',
      '  - 所有请求将以内置体验用户 trial 身份访问，无登录墙',
      '  - 数据仅保存在本机 DATA_DIR 目录，请勿暴露到公网',
      '  - 正式部署必须移除 TRIAL_MODE 环境变量',
      '==========================================================',
      '',
    ].join('\n'),
  );
}

/** 是否启用试用模式（server 侧读取；middleware 的 Edge 构建期内联见注释） */
export function isTrialMode(): boolean {
  return process.env.TRIAL_MODE === '1';
}

/**
 * 幂等地向 users 表 seed 内置体验用户并返回。
 * - username='trial'，password_hash 为无方案前缀的随机串（verifyPassword 永不通过，
 *   即该账号物理上不可登录），不落任何可预测凭据
 * - is_admin 取默认 0：非管理员，profile 页邀请码卡片自然隐藏
 * - 已存在即复用（INSERT OR IGNORE + 重查），并发/重复调用安全
 */
export function ensureTrialUser(): User {
  const select = () =>
    db
      .prepare(
        'SELECT id, username, display_name, avatar_filename, is_admin, created_at FROM users WHERE username = ?',
      )
      .get('trial') as User | undefined;

  const existing = select();
  if (existing) return existing;

  // 随机串无 'scrypt$' 前缀 → verifyPassword 判定方案不符直接返回 false，永不可登录
  const unusableHash = `trial-${crypto.randomBytes(32).toString('hex')}`;
  db.prepare(
    'INSERT OR IGNORE INTO users (username, password_hash, display_name) VALUES (?, ?, ?)',
  ).run('trial', unusableHash, '体验用户');

  const seeded = select();
  if (!seeded) throw new Error('试用用户 seed 失败：插入后查询不到 trial 用户');
  return seeded;
}
