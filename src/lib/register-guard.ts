import crypto from 'node:crypto';

const WINDOW_MS = 60 * 60 * 1000;
const MAX_ATTEMPTS = 3;

/** Sliding-window timestamps of register attempts, keyed by IP. Process-local. */
const attempts = new Map<string, number[]>();

export function clientIp(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) {
    const first = forwarded.split(',')[0]?.trim();
    if (first) return first;
  }
  return request.headers.get('x-real-ip')?.trim() || 'unknown';
}

/** Record one attempt. Returns false when the IP is already over the hourly cap. */
export function consumeRegisterAttempt(ip: string): boolean {
  const now = Date.now();
  const stamps = (attempts.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);
  if (stamps.length >= MAX_ATTEMPTS) {
    attempts.set(ip, stamps);
    return false;
  }
  stamps.push(now);
  attempts.set(ip, stamps);
  return true;
}

export function verifyInviteCode(input: string | undefined): { ok: true } | { ok: false; error: string } {
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
