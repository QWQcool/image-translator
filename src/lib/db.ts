import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

const DATA_DIR = path.resolve(process.cwd(), process.env.DATA_DIR ?? 'data');
const DB_PATH = path.join(DATA_DIR, 'app.db');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS assets (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  filename       TEXT NOT NULL,
  thumb_filename TEXT,
  original_name  TEXT,
  mime_type      TEXT NOT NULL,
  width          INTEGER,
  height         INTEGER,
  size_bytes     INTEGER NOT NULL DEFAULT 0,
  title          TEXT,
  source_url     TEXT,
  source_author  TEXT,
  source_post_id TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_assets_owner ON assets(owner_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_assets_source
  ON assets(owner_id, source_post_id) WHERE source_post_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS spaces (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  description TEXT,
  -- private: 仅成员可见；public: 所有登录用户可见，非成员一律只读
  visibility  TEXT NOT NULL DEFAULT 'private',
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_spaces_owner ON spaces(owner_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS space_members (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  space_id   INTEGER NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (space_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_members_space ON space_members(space_id);
CREATE INDEX IF NOT EXISTS idx_members_user ON space_members(user_id);

CREATE TABLE IF NOT EXISTS space_items (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  space_id   INTEGER NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  asset_id   INTEGER NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  title      TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (space_id, asset_id)
);
CREATE INDEX IF NOT EXISTS idx_items_space ON space_items(space_id, sort_order);

CREATE TABLE IF NOT EXISTS annotations (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id         INTEGER NOT NULL REFERENCES space_items(id) ON DELETE CASCADE,
  x               REAL NOT NULL,
  y               REAL NOT NULL,
  w               REAL NOT NULL,
  h               REAL NOT NULL,
  text            TEXT NOT NULL DEFAULT '',
  font_size_ratio REAL NOT NULL DEFAULT 0.035,
  color           TEXT NOT NULL DEFAULT '#FFFFFF',
  bg_color        TEXT NOT NULL DEFAULT '#000000B3',
  align           TEXT NOT NULL DEFAULT 'left',
  font_weight     INTEGER NOT NULL DEFAULT 700,
  order_index     INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_annotations_item ON annotations(item_id, order_index);
`;

function createConnection(): Database.Database {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const database = new Database(DB_PATH);
  database.pragma('journal_mode = WAL');
  database.pragma('foreign_keys = ON');
  // 并发写入时排队等待而不是立刻抛 SQLITE_BUSY，多人同时保存标注时必需
  database.pragma('busy_timeout = 5000');
  // WAL 模式下 NORMAL 既安全又比 FULL 快得多
  database.pragma('synchronous = NORMAL');
  database.exec(SCHEMA);
  return database;
}

/**
 * 增量迁移。SQLite 的 ALTER TABLE 不支持 IF NOT EXISTS，
 * 必须先查 pragma 再决定是否加列，否则重复启动会报错。
 */
function migrate(database: Database.Database): void {
  const spaceColumns = database
    .prepare('PRAGMA table_info(spaces)')
    .all() as Array<{ name: string }>;
  if (!spaceColumns.some((column) => column.name === 'visibility')) {
    database.exec(`ALTER TABLE spaces ADD COLUMN visibility TEXT NOT NULL DEFAULT 'private'`);
  }

  // 素材可见性：shared 的图对所有登录用户可见，是协作与全站共享的基础
  const assetColumns = database.prepare('PRAGMA table_info(assets)').all() as Array<{ name: string }>;
  if (!assetColumns.some((column) => column.name === 'visibility')) {
    database.exec(`ALTER TABLE assets ADD COLUMN visibility TEXT NOT NULL DEFAULT 'private'`);
  }
  // 为迁移前已存在的空间补建 owner 成员记录（INSERT OR IGNORE 幂等）
  database.exec(
    `INSERT OR IGNORE INTO space_members (space_id, user_id, role)
     SELECT id, owner_id, 'owner' FROM spaces`,
  );
}

// Next.js 开发模式下模块会被反复重载，用 globalThis 缓存连接避免句柄泄漏。
const globalForDb = globalThis as unknown as { __appDb?: Database.Database };
export const db: Database.Database = globalForDb.__appDb ?? createConnection();
migrate(db);
if (process.env.NODE_ENV !== 'production') {
  globalForDb.__appDb = db;
}

export { DATA_DIR };
