import fs from 'node:fs/promises';
import path from 'node:path';
import { NextResponse } from 'next/server';
import JSZip from 'jszip';
import { getCurrentUser } from '@/lib/auth';
import { db } from '@/lib/db';
import { accessError, getSpaceAccess } from '@/lib/permissions';
import { IMAGES_DIR } from '@/lib/storage';

type Params = { params: Promise<{ id: string }> };

/** 打包体积上限（成品是嵌字导出的 PNG，通常比原图大，放宽到 1GB 兜底） */
const MAX_ZIP_BYTES = 1024 * 1024 * 1024;
/** 一次打包的成品数上限，与空间成品列表接口对齐 */
const MAX_OUTPUTS = 500;

/** zip 条目文件名里不允许出现的字符（Windows 保留字符 + 控制符） */
const ILLEGAL_CHARS = /[\\/:*?"<>|\u0000-\u001f]/g;

/** 清洗条目标题使其可安全作为文件名，并限制长度 */
function sanitizeName(title: string): string {
  const cleaned = title.replace(ILLEGAL_CHARS, '_').trim();
  return (cleaned || '未命名').slice(0, 80);
}

/** 空间全部成品打包 zip：文件名 {两位序号}-{条目标题}.png，重名追加 -2/-3 后缀 */
export async function GET(_request: Request, { params }: Params) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });

  const spaceId = Number((await params).id);
  if (!Number.isInteger(spaceId) || spaceId <= 0) {
    return NextResponse.json({ error: '参数错误' }, { status: 400 });
  }

  const denied = accessError(getSpaceAccess(spaceId, user.id), 'view');
  if (denied) return denied;

  const space = db.prepare('SELECT name, typesetter FROM spaces WHERE id = ?').get(spaceId) as
    | { name: string; typesetter: string }
    | undefined;

  // 制作人员自动填充：导出成品压缩包时，若空间「嵌字」为空，自动填入当前操作人
  if (space && !space.typesetter) {
    db.prepare('UPDATE spaces SET typesetter = ? WHERE id = ?').run(user.username, spaceId);
  }

  const rows = db
    .prepare(
      `SELECT o.id, o.asset_id, o.created_at, si.title AS item_title,
              a.filename, a.original_name, a.title AS asset_title
         FROM outputs o
         JOIN space_items si ON si.id = o.item_id
         JOIN assets a ON a.id = o.asset_id
        WHERE si.space_id = ?
        ORDER BY si.sort_order, si.id, o.id ASC
        LIMIT ${MAX_OUTPUTS}`,
    )
    .all(spaceId) as Array<{
    id: number;
    asset_id: number;
    created_at: string;
    item_title: string | null;
    filename: string;
    original_name: string | null;
    asset_title: string | null;
  }>;

  if (rows.length === 0) {
    return NextResponse.json({ error: '该空间还没有成品' }, { status: 404 });
  }

  const zip = new JSZip();
  const used = new Map<string, number>();
  let packedBytes = 0;

  // 排序已按条目顺序 + 成品时间，序号即最终命名
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const base = `${String(i + 1).padStart(2, '0')}-${sanitizeName(
      row.item_title || row.asset_title || row.original_name || `成品 ${row.id}`,
    )}`;

    // 重名去重：第一次出现原名，之后 -2、-3 递增
    const seen = used.get(base) ?? 0;
    used.set(base, seen + 1);
    const entryName = seen === 0 ? `${base}.png` : `${base}-${seen + 1}.png`;

    try {
      const file = await fs.readFile(path.join(IMAGES_DIR, row.filename));
      if (packedBytes + file.byteLength > MAX_ZIP_BYTES) {
        continue; // 超上限直接跳过，宁可少一张也不把进程内存打爆
      }
      // PNG 已压缩，STORE 不再 deflate
      zip.file(entryName, file, { compression: 'STORE' });
      packedBytes += file.byteLength;
    } catch {
      // 磁盘文件缺失（孤儿记录）跳过，不中断整体打包
    }
  }

  const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'STORE' });
  const zipName = `${(space?.name ?? `空间${spaceId}`).slice(0, 60)}-成品.zip`;

  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(zipName)}`,
    },
  });
}
