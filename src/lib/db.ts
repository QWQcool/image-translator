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
  lp_groups   TEXT,
  lp_phrases  TEXT,
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
  kind            TEXT NOT NULL DEFAULT 'box',
  group_id        INTEGER NOT NULL DEFAULT 1,
  source_text     TEXT NOT NULL DEFAULT '',
  comment         TEXT NOT NULL DEFAULT '',
  updated_by      INTEGER,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_annotations_item ON annotations(item_id, order_index);

-- 注册等敏感接口的限流计数。放库里而不是进程内存，
-- 多副本部署 / dev 模式模块重载都不会让计数被清零。
CREATE TABLE IF NOT EXISTS rate_limits (
  bucket       TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  count        INTEGER NOT NULL,
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 协作房间：一张图一个房间。默认上锁，持有人点「共享编辑」后才开广播。
-- expires_at 是持有人心跳续期时间，超时任何人都能接管锁。
CREATE TABLE IF NOT EXISTS edit_rooms (
  item_id    INTEGER PRIMARY KEY REFERENCES space_items(id) ON DELETE CASCADE,
  holder_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  shared     INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 房间操作日志：实时协作的事件源。
-- kind = paint(矢量笔画) / text(文字层快照) / annotations(标注快照) / meta(锁与共享状态)
-- 客户端按 seq 回放；草稿保存会推进 paint_epoch，旧 epoch 的笔画日志可清理。
CREATE TABLE IF NOT EXISTS room_ops (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id    INTEGER NOT NULL REFERENCES space_items(id) ON DELETE CASCADE,
  seq        INTEGER NOT NULL,
  author_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,
  payload    TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_room_ops_item ON room_ops(item_id, seq);
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

  const annotationColumns = database
    .prepare('PRAGMA table_info(annotations)')
    .all() as Array<{ name: string }>;
  const addAnnotationColumn = (name: string, ddl: string) => {
    if (!annotationColumns.some((column) => column.name === name)) {
      database.exec(`ALTER TABLE annotations ADD COLUMN ${ddl}`);
    }
  };
  addAnnotationColumn('kind', `kind TEXT NOT NULL DEFAULT 'box'`);
  addAnnotationColumn('group_id', `group_id INTEGER NOT NULL DEFAULT 1`);
  addAnnotationColumn('source_text', `source_text TEXT NOT NULL DEFAULT ''`);
  addAnnotationColumn('comment', `comment TEXT NOT NULL DEFAULT ''`);
  addAnnotationColumn('updated_by', `updated_by INTEGER`);

  const latestSpaceColumns = database
    .prepare('PRAGMA table_info(spaces)')
    .all() as Array<{ name: string }>;
  if (!latestSpaceColumns.some((column) => column.name === 'lp_groups')) {
    database.exec(`ALTER TABLE spaces ADD COLUMN lp_groups TEXT`);
  }
  if (!latestSpaceColumns.some((column) => column.name === 'lp_phrases')) {
    database.exec(`ALTER TABLE spaces ADD COLUMN lp_phrases TEXT`);
  }

  // 开放空间改造：历史遗留的私人空间/私人素材一次性转成公共，
  // 之后 API 层也不再接受 private（幂等，重复执行无副作用）。
  database.exec(`UPDATE spaces SET visibility = 'public' WHERE visibility <> 'public'`);
  database.exec(`UPDATE assets SET visibility = 'shared' WHERE visibility <> 'shared'`);

  // 个人空间：昵称与头像（username 永远是注册账号名，日志与记录都用它）
  const userColumns = database.prepare('PRAGMA table_info(users)').all() as Array<{ name: string }>;
  if (!userColumns.some((column) => column.name === 'display_name')) {
    database.exec(`ALTER TABLE users ADD COLUMN display_name TEXT`);
  }
  if (!userColumns.some((column) => column.name === 'avatar_filename')) {
    database.exec(`ALTER TABLE users ADD COLUMN avatar_filename TEXT`);
  }

  // 每个用户自己的 AI 服务配置（OpenAI 兼容）。谁填了 token 谁能用 AI 能力。
  database.exec(`
    CREATE TABLE IF NOT EXISTS ai_configs (
      user_id     INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      base_url    TEXT NOT NULL DEFAULT '',
      api_key     TEXT NOT NULL DEFAULT '',
      ocr_model   TEXT NOT NULL DEFAULT '',
      image_model TEXT NOT NULL DEFAULT '',
      updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // 房间垃圾回收：过期锁直接清掉，两周前的操作日志丢弃（防表无限增长）
  database.exec(`DELETE FROM edit_rooms WHERE expires_at < (strftime('%s','now') * 1000 - 60000)`);
  database.exec(
    `DELETE FROM room_ops WHERE created_at < datetime('now', '-14 days')`,
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
