import crypto from 'node:crypto';
import { db } from './db';

const WINDOW_MS = 60 * 60 * 1000;

/**
 * 同一出口 IP 一小时内允许的注册尝试次数。
 * 注意：只有部署在可信反代后面（设置 TRUST_PROXY=1）时 IP 才可信，
 * 否则任何人都能伪造 X-Forwarded-For 换桶，所以另加了一道全局闸门。
 */
const MAX_PER_IP = clampInt(process.env.REGISTER_MAX_PER_IP, 3, 1, 1000);
/** 全站一小时内允许的注册尝试总数，兜住「伪造 IP 轮换」这个绕过手段 */
const MAX_GLOBAL = clampInt(process.env.REGISTER_MAX_GLOBAL, 30, 1, 100000);

function clampInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

export type RateLimitResult = {
  ok: boolean;
  /** 还要等多少秒才可能恢复，ok 为 true 时是 0 */
  retryAfterSec: number;
  /** 本次使用的是哪个桶，便于日志与排查 */
  bucket: string;
};

/**
 * 固定窗口计数。计数落在 SQLite 里而不是进程内存：
 * 多进程 / 多副本部署、以及 Next 开发模式的模块重载都不会让计数归零。
 *
 * better-sqlite3 是同步驱动，整个函数在一个事务里跑完，
 * 不存在「读到的 count 已被别的进程改掉」的竞态。
 */
const consume = db.transaction((key: string, limit: number, windowMs: number): RateLimitResult => {
  const now = Date.now();
  const row = db
    .prepare('SELECT window_start, count FROM rate_limits WHERE bucket = ?')
    .get(key) as { window_start: number; count: number } | undefined;

  if (!row || now - row.window_start >= windowMs) {
    db.prepare(
      `INSERT INTO rate_limits (bucket, window_start, count, updated_at)
            VALUES (?, ?, 1, datetime('now'))
       ON CONFLICT(bucket) DO UPDATE SET
            window_start = excluded.window_start,
            count = 1,
            updated_at = excluded.updated_at`,
    ).run(key, now);
    return { ok: true, retryAfterSec: 0, bucket: key };
  }

  if (row.count >= limit) {
    const retryAfterSec = Math.max(1, Math.ceil((row.window_start + windowMs - now) / 1000));
    return { ok: false, retryAfterSec, bucket: key };
  }

  db.prepare(
    `UPDATE rate_limits SET count = count + 1, updated_at = datetime('now') WHERE bucket = ?`,
  ).run(key);
  return { ok: true, retryAfterSec: 0, bucket: key };
});

/** 定期清掉过期桶，否则这张表会无限增长 */
function pruneStale(): void {
  // 每次调用都删会有额外写放大，按 1% 概率抽一次足够
  if (Math.random() > 0.01) return;
  try {
    db.prepare(`DELETE FROM rate_limits WHERE window_start < ?`).run(Date.now() - 24 * 60 * 60 * 1000);
  } catch {
    // 清理失败不影响主流程
  }
}

export function consumeRateLimit(key: string, limit: number, windowMs = WINDOW_MS): RateLimitResult {
  pruneStale();
  return consume(key, limit, windowMs);
}

/**
 * 取出请求来源 IP。
 *
 * X-Forwarded-For 是客户端可伪造的头：直连部署时照单全收，
 * 等于给攻击者一个「换个头就换一个桶」的绕过开关。
 * 因此只有在显式声明 TRUST_PROXY=1（确实挂在可信反代后面）时才采信，
 * 其余情况一律落到 'unknown'，由全局闸门兜底。
 */
export function clientIp(request: Request): string {
  const trustProxy = process.env.TRUST_PROXY === '1';
  if (trustProxy) {
    const forwarded = request.headers.get('x-forwarded-for');
    if (forwarded) {
      const first = forwarded.split(',')[0]?.trim();
      if (first) return first.slice(0, 64);
    }
    const real = request.headers.get('x-real-ip')?.trim();
    if (real) return real.slice(0, 64);
  }
  return 'unknown';
}

/** 注册总闸门：IP 桶 + 全局桶，两者都要过 */
export function consumeRegisterAttempt(ip: string): RateLimitResult {
  const perIp = consumeRateLimit(`register:ip:${ip}`, MAX_PER_IP);
  if (!perIp.ok) return perIp;
  return consumeRateLimit('register:global', MAX_GLOBAL);
}

export function verifyInviteCode(
  input: string | undefined,
): { ok: true } | { ok: false; error: string } {
  const expected = process.env.INVITE_CODE ?? '';
  if (!expected) {
    return { ok: false, error: '当前未开放注册' };
  }

  const provided = (input ?? '').trim();
  if (!provided) {
    return { ok: false, error: '请填写邀请码' };
  }

  const left = crypto.createHash('sha256').update(provided).digest();
  const right = crypto.createHash('sha256').update(expected).digest();
  if (!crypto.timingSafeEqual(left, right)) {
    return { ok: false, error: '邀请码无效' };
  }
  return { ok: true };
}
