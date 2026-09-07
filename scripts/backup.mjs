#!/usr/bin/env node
/**
 * 数据库定时备份脚本（better-sqlite3 在线备份 API，WAL 模式下服务运行中也可安全执行）。
 *
 * 用法：
 *   node scripts/backup.mjs                  # 只备数据库（默认，图片建议文件系统级备份）
 *   node scripts/backup.mjs --with-images    # 同时复制 images/ thumbs/ previews/
 *
 * 可调环境变量：
 *   DATA_DIR                数据目录（默认 data/，与站点一致）
 *   BACKUP_DIR              备份输出目录（默认 <DATA_DIR>/backups）
 *   BACKUP_RETENTION_DAYS   保留天数，超期备份自动删除（默认 7）
 *
 * 定时示例：
 *   Linux crontab：  0 3 * * * cd /srv/tximg && node scripts/backup.mjs >> data/backup.log 2>&1
 *   Windows 计划任务：schtasks /create /tn "tximg-backup" /tr "node C:\app\scripts\backup.mjs" /sc daily /st 03:00
 *   Docker：         docker run --rm -v tuanyi-data:/app/data --volumes-from <容器> tuanyi-space node scripts/backup.mjs
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import Database from 'better-sqlite3';

const dataDir = path.resolve(process.env.DATA_DIR ?? 'data');
const backupDir = path.resolve(process.env.BACKUP_DIR ?? path.join(dataDir, 'backups'));
const retentionDays = Number(process.env.BACKUP_RETENTION_DAYS ?? 7);
const withImages = process.argv.includes('--with-images');
const IMAGE_SUBDIRS = ['images', 'thumbs', 'previews'];

const dbPath = path.join(dataDir, 'app.db');
if (!fs.existsSync(dbPath)) {
  console.error(`[错误] 未找到数据库文件：${dbPath}`);
  process.exit(1);
}

const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
const destDir = path.join(backupDir, `backup-${stamp}-${crypto.randomBytes(2).toString('hex')}`);
fs.mkdirSync(destDir, { recursive: true });

// 1. 数据库：在线备份 API 产出一致性快照（含 WAL 内容，无需停服/手动 checkpoint）
const destDb = path.join(destDir, 'app.db');
const db = new Database(dbPath, { readonly: false, fileMustExist: true });
try {
  await db.backup(destDb);
} finally {
  db.close();
}
const dbSize = fs.statSync(destDb).size;
console.log(`[完成] 数据库 → ${destDb}（${(dbSize / 1024 / 1024).toFixed(1)} MB）`);

// 2. 可选：图片目录
if (withImages) {
  for (const sub of IMAGE_SUBDIRS) {
    const src = path.join(dataDir, sub);
    if (!fs.existsSync(src)) continue;
    const dest = path.join(destDir, sub);
    fs.cpSync(src, dest, { recursive: true });
    let count = 0;
    for (const entry of fs.readdirSync(dest)) count += 1;
    console.log(`[完成] ${sub}/ → ${dest}（${count} 项）`);
  }
}

// 3. 过期清理：删除超过保留天数的 backup-* 目录
if (Number.isFinite(retentionDays) && retentionDays > 0) {
  const cutoff = Date.now() - retentionDays * 86_400_000;
  let removed = 0;
  for (const entry of fs.readdirSync(backupDir)) {
    const full = path.join(backupDir, entry);
    if (!entry.startsWith('backup-') || !fs.statSync(full).isDirectory()) continue;
    if (fs.statSync(full).mtimeMs < cutoff) {
      fs.rmSync(full, { recursive: true, force: true });
      removed += 1;
    }
  }
  if (removed > 0) console.log(`[清理] 删除 ${removed} 个超过 ${retentionDays} 天的旧备份`);
}

console.log(`[信息] 本次备份目录：${destDir}`);
