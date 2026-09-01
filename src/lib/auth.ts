import crypto from 'node:crypto';
import { cookies } from 'next/headers';
import { SignJWT, jwtVerify } from 'jose';
import { db } from './db';
import type { User } from './types';

const SESSION_COOKIE = 'tximg_session';
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30;
const DEV_SECRET = 'dev-only-insecure-secret-please-set-SESSION_SECRET';

function getSecret(): Uint8Array {
  const raw = process.env.SESSION_SECRET;
  if (!raw || raw.length < 16) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('生产环境必须设置足够长度的 SESSION_SECRET 环境变量');
    }
    return new TextEncoder().encode(DEV_SECRET);
  }
  return new TextEncoder().encode(raw);
}

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const derived = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${derived.toString('hex')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, saltHex, hashHex] = stored.split('$');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(expected, actual);
}

export async function createSession(userId: number): Promise<void> {
  const token = await new SignJWT({ uid: userId })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(`${SESSION_TTL_SECONDS}s`)
    .sign(getSecret());

  const store = await cookies();
  store.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: SESSION_TTL_SECONDS,
  });
}

export async function destroySession(): Promise<void> {
  const store = await cookies();
  store.delete(SESSION_COOKIE);
}

export async function getCurrentUser(): Promise<User | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;

  let uid: number;
  try {
    const { payload } = await jwtVerify(token, getSecret());
    uid = Number(payload.uid);
  } catch {
    return null;
  }
  if (!Number.isInteger(uid) || uid <= 0) return null;

  const user = db
    .prepare('SELECT id, username, created_at FROM users WHERE id = ?')
    .get(uid) as User | undefined;
  return user ?? null;
}

export function validateUsername(username: string): string | null {
  const trimmed = username.trim();
  if (trimmed.length < 3 || trimmed.length > 32) return '用户名长度需为 3 ~ 32 个字符';
  if (!/^[\w.\-一-龥]+$/.test(trimmed)) return '用户名只能包含字母、数字、下划线、点、连字符或中文';
  return null;
}

export function validatePassword(password: string): string | null {
  if (password.length < 8 || password.length > 128) return '密码长度需为 8 ~ 128 个字符';
  return null;
}
