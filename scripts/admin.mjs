#!/usr/bin/env node
/**
 * 管理员管理 CLI（直接操作 SQLite，与服务端共用同一 users 表）。
 *
 * 用法（在项目根目录）：
 *   npm run admin -- list             查看全部用户与管理员状态
 *   npm run admin -- set <用户名>     赋予管理员（可发放邀请码）
 *   npm run admin -- unset <用户名>   收回管理员
 *
 * 说明：
 * - 注册用户默认普通权限；只有管理员的「个人资料」页会出现邀请码管理卡片
 * - 数据库路径取环境变量 DATA_DIR（默认 data/），与服务端保持一致
 * - WAL 模式下与运行中的服务端并发安全（本脚本只做单行 UPDATE，瞬时完成）
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import Database from 'better-sqlite3';

const dataDir = process.env.DATA_DIR || 'data';
const dbPath = path.join(dataDir, 'app.db');

if (!fs.existsSync(dbPath)) {
  console.error(`[错误] 未找到数据库文件：${dbPath}`);
  console.error('       请确认在项目根目录运行，且 DATA_DIR 配置正确。');
  process.exit(1);
}

const db = new Database(dbPath);
db.pragma('foreign_keys = ON');

const [command, username] = process.argv.slice(2);

function printUsage() {
  console.log('用法：');
  console.log('  npm run admin -- list             查看全部用户与管理员状态');
  console.log('  npm run admin -- set <用户名>     赋予管理员');
  console.log('  npm run admin -- unset <用户名>   收回管理员');
}

function listUsers() {
  const rows = db
    .prepare('SELECT id, username, is_admin, created_at FROM users ORDER BY id')
    .all();
  if (rows.length === 0) {
    console.log('（数据库中还没有任何用户）');
    return;
  }
  console.table(
    rows.map((r) => ({
      id: r.id,
      用户名: r.username,
      管理员: r.is_admin ? '✔ 是' : '否',
      注册时间: r.created_at,
    })),
  );
  const admins = rows.filter((r) => r.is_admin).map((r) => r.username);
  console.log(`当前管理员（${admins.length} 个）：${admins.join('、') || '（无）'}`);
}

function findByUsername(name) {
  return db
    .prepare('SELECT id, username, is_admin FROM users WHERE username = ?')
    .get(name);
}

function setAdmin(name, value) {
  const row = findByUsername(name);
  if (!row) {
    console.error(`[错误] 用户「${name}」不存在。先用 list 查看全部用户名。`);
    process.exitCode = 1;
    return;
  }
  if (Boolean(row.is_admin) === value) {
    console.log(`[跳过] 「${name}」已经是${value ? '管理员' : '普通用户'}，无需变更。`);
    return;
  }
  db.prepare('UPDATE users SET is_admin = ? WHERE id = ?').run(value ? 1 : 0, row.id);
  console.log(`[完成] 「${name}」已${value ? '获得' : '收回'}管理员权限。`);
}

switch (command) {
  case 'list':
    listUsers();
    break;
  case 'set':
  case 'unset':
    if (!username) {
      console.error(`[错误] 缺少用户名参数。`);
      printUsage();
      process.exitCode = 1;
      break;
    }
    setAdmin(username, command === 'set');
    break;
  default:
    printUsage();
    process.exitCode = command ? 1 : 0;
}

db.close();
