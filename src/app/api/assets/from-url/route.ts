import dns from 'node:dns/promises';
import net from 'node:net';
import { NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { db } from '@/lib/db';
import { imageLimiter, storeImage, SUPPORTED_MIME_TYPES } from '@/lib/storage';
import type { Asset } from '@/lib/types';

const MAX_BYTES = 20 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const MAX_URLS = 20;
const FETCH_TIMEOUT_MS = 15_000;

/**
 * SSRF 防护：服务端会按用户给的 URL 主动发起请求，
 * 必须挡掉内网地址，否则攻击者可以借道探测内网服务。
 */
function isPrivateAddress(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const parts = ip.split('.').map(Number);
    if (parts[0] === 0 || parts[0] === 10 || parts[0] === 127) return true;
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
    if (parts[0] === 192 && parts[1] === 168) return true;
    if (parts[0] === 169 && parts[1] === 254) return true;
    if (parts[0] >= 224) return true;
    return false;
  }
  const value = ip.toLowerCase();
  if (value === '::' || value === '::1') return true;
  if (value.startsWith('fe80') || value.startsWith('fc') || value.startsWith('fd')) return true;
  const mapped = value.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateAddress(mapped[1]);
  return false;
}

async function assertPublicHost(hostname: string): Promise<void> {
  // 直接用字面量 IP 的情况也要检查
  if (net.isIP(hostname)) {
    if (isPrivateAddress(hostname)) throw new Error('不允许访问内网地址');
    return;
  }
  const records = await dns.lookup(hostname, { all: true });
  if (records.length === 0) throw new Error('域名无法解析');
  for (const record of records) {
    if (isPrivateAddress(record.address)) throw new Error('不允许访问内网地址');
  }
}

async function downloadImage(
  rawUrl: string,
): Promise<{ buffer: Buffer; contentType: string }> {
  let current = rawUrl;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const url = new URL(current);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error('只支持 http/https 链接');
    }
    await assertPublicHost(url.hostname);

    const response = await fetch(url.toString(), {
      redirect: 'manual',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ImageTranslator/1.0)' },
    });

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) throw new Error('重定向缺少目标地址');
      current = new URL(location, current).toString();
      continue;
    }

    if (!response.ok) throw new Error(`下载失败（HTTP ${response.status}）`);

    const contentType = (response.headers.get('content-type') ?? '').split(';')[0].trim();
    if (!SUPPORTED_MIME_TYPES.includes(contentType)) {
      throw new Error(`链接内容不是支持的图片格式（${contentType || '未知'}）`);
    }

    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > MAX_BYTES) {
      throw new Error('图片超过 20MB 限制');
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength > MAX_BYTES) throw new Error('图片超过 20MB 限制');

    return { buffer, contentType };
  }

  throw new Error('重定向次数过多');
}

/** 用图片直链导入（例如复制推特图片的 pbs.twimg.com 地址），不走 X API，零成本 */
export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });

  let body: { urls?: string[]; shared?: boolean };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: '请求体格式错误' }, { status: 400 });
  }

  const visibility = body.shared ? 'shared' : 'private';

  const urls = [...new Set((body.urls ?? []).map((item) => String(item).trim()).filter(Boolean))];
  if (urls.length === 0) {
    return NextResponse.json({ error: '请至少填写一个图片链接' }, { status: 400 });
  }
  if (urls.length > MAX_URLS) {
    return NextResponse.json({ error: `一次最多导入 ${MAX_URLS} 个链接` }, { status: 400 });
  }

  const created: Asset[] = [];
  const errors: string[] = [];

  for (const url of urls) {
    try {
      const { buffer, contentType } = await downloadImage(url);
      const stored = await imageLimiter.run(() => storeImage(buffer, contentType));

      const pathname = new URL(url).pathname;
      const nameFromUrl = decodeURIComponent(pathname.split('/').pop() || '').slice(0, 100);

      const result = db
        .prepare(
          `INSERT INTO assets
             (owner_id, filename, thumb_filename, original_name, mime_type,
              width, height, size_bytes, title, source_url, visibility)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          user.id,
          stored.filename,
          stored.thumbFilename,
          nameFromUrl || null,
          stored.storedMimeType,
          stored.width,
          stored.height,
          stored.sizeBytes,
          nameFromUrl.replace(/\.[^.]+$/, '') || '网络图片',
          url,
          visibility,
        );

      created.push(
        db.prepare('SELECT * FROM assets WHERE id = ?').get(result.lastInsertRowid) as Asset,
      );
    } catch (error) {
      errors.push(`${url.slice(0, 80)}：${error instanceof Error ? error.message : '导入失败'}`);
    }
  }

  if (created.length === 0) {
    return NextResponse.json({ error: errors.join('；') || '全部链接导入失败' }, { status: 400 });
  }
  return NextResponse.json({ assets: created, errors }, { status: 201 });
}
