import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_LP_STYLES } from './labelplus';

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
  -- 空间完结状态：active=进行中；finished=已完结
  -- （阶段 15 起废弃：改用七级 progress 列，本列不再读写，仅保留兼容）
  status      TEXT NOT NULL DEFAULT 'active',
  -- 空间序号（YYYYMMDD-NN，服务端自动生成；可空，历史空间无序号）
  space_no    TEXT,
  -- 标签（JSON 字符串数组，如 ["纯爱","鬼畜"]）
  tags        TEXT NOT NULL DEFAULT '[]',
  -- 制作人员：作者、翻译、校对、嵌字
  author      TEXT NOT NULL DEFAULT '',
  translator  TEXT NOT NULL DEFAULT '',
  proofreader TEXT NOT NULL DEFAULT '',
  typesetter  TEXT NOT NULL DEFAULT '',
  -- 七级进度：untranslated/translated_placeholder/translated/proofread_placeholder/
  -- proofread/typeset_placeholder/typeset_done
  progress    TEXT NOT NULL DEFAULT 'untranslated',
  -- 进入当前进度的时间（展示「当前状态已维持 X」）
  progress_at TEXT NOT NULL DEFAULT (datetime('now')),
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

-- 嵌字成品：条目的一版成品图。成品 asset 是独立的 assets 行（不插 space_items，
-- 不进空间图片列表），仅被本表引用；条目删除时本表级联清空，
-- 成品 asset 的行与磁盘文件由 hard-delete 联动逻辑负责回收。
CREATE TABLE IF NOT EXISTS outputs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id    INTEGER NOT NULL REFERENCES space_items(id) ON DELETE CASCADE,
  asset_id   INTEGER NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_outputs_item ON outputs(item_id);

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
  -- 富文本分段（JSON 数组，字段省略=继承标注级样式）；text 列保留为纯文本冗余
  runs            TEXT,
  text_opacity    REAL NOT NULL DEFAULT 1,
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

-- 条目评论：标注编辑器页的讨论（view 权限即可发言，删除仅限作者本人）
CREATE TABLE IF NOT EXISTS comments (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id    INTEGER NOT NULL REFERENCES space_items(id) ON DELETE CASCADE,
  user_id    INTEGER REFERENCES users(id) ON DELETE CASCADE,
  body       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_comments_item ON comments(item_id);

-- 站内通知：评论等事件触达相关人（read 0/1，仅站内无推送）
CREATE TABLE IF NOT EXISTS notifications (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  actor_id   INTEGER REFERENCES users(id) ON DELETE CASCADE,
  item_id    INTEGER,
  space_id   INTEGER,
  body       TEXT NOT NULL,
  read       INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, read);

-- 站点配置（阶段 16）：key-value 存储，value 为 JSON 序列化字符串。
-- 目前承载 progress_items（进度项管理）与 preset_tags（默认标签管理）。
-- 未配置过的 key 由读取方回落内置默认，无需迁移。
CREATE TABLE IF NOT EXISTS site_settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
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

  // 素材软删除：deleted_at 非空 = 在回收站里；磁盘文件保留，恢复即可用
  if (!assetColumns.some((column) => column.name === 'deleted_at')) {
    database.exec(`ALTER TABLE assets ADD COLUMN deleted_at TEXT`);
  }

  // 全站操作日志：空间/素材/条目的增删改、AI 调用等，日志页只展示最近 500 条
  database.exec(`
    CREATE TABLE IF NOT EXISTS op_logs (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      action      TEXT NOT NULL,
      target_type TEXT NOT NULL,
      target_id   INTEGER,
      target_name TEXT,
      detail      TEXT,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_op_logs_created ON op_logs(id DESC);
  `);

  const annotationColumns = database
    .prepare('PRAGMA table_info(annotations)')
    .all() as Array<{ name: string }>;
  const addAnnotationColumn = (name: string, ddl: string): boolean => {
    if (annotationColumns.some((column) => column.name === name)) return false;
    database.exec(`ALTER TABLE annotations ADD COLUMN ${ddl}`);
    return true;
  };
  addAnnotationColumn('kind', `kind TEXT NOT NULL DEFAULT 'box'`);
  addAnnotationColumn('group_id', `group_id INTEGER NOT NULL DEFAULT 1`);
  addAnnotationColumn('source_text', `source_text TEXT NOT NULL DEFAULT ''`);
  addAnnotationColumn('comment', `comment TEXT NOT NULL DEFAULT ''`);
  addAnnotationColumn('updated_by', `updated_by INTEGER`);
  // Stage 5 富文本：runs 分段 JSON + 标注级文字不透明度
  const runsColumnAdded =   addAnnotationColumn('runs', `runs TEXT`);
  addAnnotationColumn('text_opacity', `text_opacity REAL NOT NULL DEFAULT 1`);
  // 疑点标记：0/1，编辑器 Alt+X 切换
  addAnnotationColumn('doubtful', `doubtful INTEGER NOT NULL DEFAULT 0`);
  // 老数据补 runs：仅在本列刚创建时执行一次（一次性守卫）。
  // 之后的 runs=NULL 是用户「清除段落样式/改纯文本」的正常状态，
  // 不能在每次启动/模块重载时重新回填。
  if (runsColumnAdded) {
    const legacyRuns = database
      .prepare("SELECT id, text FROM annotations WHERE runs IS NULL AND text <> ''")
      .all() as Array<{ id: number; text: string }>;
    const fillRun = database.prepare('UPDATE annotations SET runs = ? WHERE id = ?');
    for (const row of legacyRuns) {
      fillRun.run(JSON.stringify([{ text: row.text }]), row.id);
    }
  }

  const latestSpaceColumns = database
    .prepare('PRAGMA table_info(spaces)')
    .all() as Array<{ name: string }>;
  if (!latestSpaceColumns.some((column) => column.name === 'lp_groups')) {
    database.exec(`ALTER TABLE spaces ADD COLUMN lp_groups TEXT`);
  }
  if (!latestSpaceColumns.some((column) => column.name === 'lp_phrases')) {
    database.exec(`ALTER TABLE spaces ADD COLUMN lp_phrases TEXT`);
  }

  // 嵌字分组样式预设（JSON：{[groupId]: LpStyle}），迁移时给已有空间写入默认值
  if (!latestSpaceColumns.some((column) => column.name === 'lp_styles')) {
    database.exec(`ALTER TABLE spaces ADD COLUMN lp_styles TEXT`);
    database
      .prepare('UPDATE spaces SET lp_styles = ? WHERE lp_styles IS NULL')
      .run(JSON.stringify(DEFAULT_LP_STYLES));
  }

  // 术语表（JSON 数组 [{from,to,note?}]，空间级全员共用），AI 翻译时注入
  if (!latestSpaceColumns.some((column) => column.name === 'lp_glossary')) {
    database.exec(`ALTER TABLE spaces ADD COLUMN lp_glossary TEXT NOT NULL DEFAULT '[]'`);
  }

  // 空间完结状态：'active' | 'finished'（阶段 15 起废弃：改用七级 progress，本列不再读写）
  if (!latestSpaceColumns.some((column) => column.name === 'status')) {
    database.exec(`ALTER TABLE spaces ADD COLUMN status TEXT NOT NULL DEFAULT 'active'`);
  }

  // 七级进度体系：两态 status 一刀切映射（active→untranslated，finished→typeset_done），
  // progress_at 初始化为 updated_at（「已维持」从最后保存时间起算）。
  // 自愈能力：progress 与 progress_at 两列独立检查——兼容历史「半迁移库」
  // （旧版迁移在 ALTER progress 成功后、ALTER progress_at 抛错中断，留下
  //  只有 progress 列且全为默认值的库，守卫若只看 progress 列会永久跳过）。
  // 注意：SQLite 的 ALTER TABLE ADD COLUMN 不允许非常量 DEFAULT（如 datetime('now')），
  // progress_at 必须以可空列添加、靠紧随其后的 UPDATE 回填；每个迁移步骤包事务，
  // 防止中途失败留下「列加了、回填没跑」的半迁移状态。
  const hasProgressColumn = latestSpaceColumns.some((column) => column.name === 'progress');
  const hasProgressAtColumn = latestSpaceColumns.some((column) => column.name === 'progress_at');
  if (!hasProgressColumn) {
    database.transaction(() => {
      database.exec(`ALTER TABLE spaces ADD COLUMN progress TEXT NOT NULL DEFAULT 'untranslated'`);
      database.exec(`
        UPDATE spaces
           SET progress = CASE status WHEN 'finished' THEN 'typeset_done' ELSE 'untranslated' END
       WHERE progress = 'untranslated'
      `);
    })();
  }
  if (!hasProgressAtColumn) {
    database.transaction(() => {
      database.exec(`ALTER TABLE spaces ADD COLUMN progress_at TEXT`);
      // 回填：半迁移库的 progress 曾被重置为默认值，这里按 status 重新映射一次；
      // progress_at 缺失（NULL）的行补 updated_at（「已维持」从最后保存时间起算）
      database.exec(`
        UPDATE spaces
           SET progress = CASE status WHEN 'finished' THEN 'typeset_done' ELSE 'untranslated' END,
               progress_at = COALESCE(progress_at, updated_at)
      `);
    })();
  }

  // 空间序号（YYYYMMDD-NN）：新空间由服务端在事务内自动生成，历史空间留空不回填
  if (!latestSpaceColumns.some((column) => column.name === 'space_no')) {
    database.exec(`ALTER TABLE spaces ADD COLUMN space_no TEXT`);
  }
  // 序号唯一性由部分唯一索引兜底（NULL 不参与唯一约束），生成逻辑之外再挡一层并发
  database.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_spaces_space_no ON spaces(space_no) WHERE space_no IS NOT NULL`,
  );

  // 标签（JSON 字符串数组），历史空间默认空数组
  if (!latestSpaceColumns.some((column) => column.name === 'tags')) {
    database.exec(`ALTER TABLE spaces ADD COLUMN tags TEXT NOT NULL DEFAULT '[]'`);
  }

  // 制作人员字段：作者、翻译、校对、嵌字（历史空间默认空串）
  if (!latestSpaceColumns.some((column) => column.name === 'author')) {
    database.exec(`ALTER TABLE spaces ADD COLUMN author TEXT NOT NULL DEFAULT ''`);
  }
  if (!latestSpaceColumns.some((column) => column.name === 'translator')) {
    database.exec(`ALTER TABLE spaces ADD COLUMN translator TEXT NOT NULL DEFAULT ''`);
  }
  if (!latestSpaceColumns.some((column) => column.name === 'proofreader')) {
    database.exec(`ALTER TABLE spaces ADD COLUMN proofreader TEXT NOT NULL DEFAULT ''`);
  }
  if (!latestSpaceColumns.some((column) => column.name === 'typesetter')) {
    database.exec(`ALTER TABLE spaces ADD COLUMN typesetter TEXT NOT NULL DEFAULT ''`);
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
  // Stage 6 文本块检测服务（每用户独立，可选）：配置后 OCR 走「检测→提取」两步链路
  const aiConfigColumns = database
    .prepare('PRAGMA table_info(ai_configs)')
    .all() as Array<{ name: string }>;
  const addAiConfigColumn = (name: string, ddl: string) => {
    if (!aiConfigColumns.some((column) => column.name === name)) {
      database.exec(`ALTER TABLE ai_configs ADD COLUMN ${ddl}`);
    }
  };
  addAiConfigColumn('detection_base_url', `detection_base_url TEXT NOT NULL DEFAULT ''`);
  addAiConfigColumn('detection_api_key', `detection_api_key TEXT NOT NULL DEFAULT ''`);
  addAiConfigColumn('detection_model', `detection_model TEXT NOT NULL DEFAULT ''`);
  // 检测来源：'ai' = OpenAI 兼容视觉端点；'sidecar' = 本机检测进程（sidecar/detector.mjs）
  addAiConfigColumn('detection_source', `detection_source TEXT NOT NULL DEFAULT 'ai'`);

  // 多 Provider：一个用户可配置多条 AI 服务（OCR/翻译/去字可选用哪条）。
  // user_id 为 NULL 的记录是「官方渠道」占位（server 端 token 字段保留，暂不填、不计费）。
  database.exec(`
    CREATE TABLE IF NOT EXISTS ai_providers (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id    INTEGER REFERENCES users(id) ON DELETE CASCADE,
      name       TEXT NOT NULL DEFAULT '',
      base_url   TEXT NOT NULL DEFAULT '',
      api_key    TEXT NOT NULL DEFAULT '',
      ocr_model  TEXT NOT NULL DEFAULT '',
      chat_model TEXT NOT NULL DEFAULT '',
      image_model TEXT NOT NULL DEFAULT '',
      is_default INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  // 一次性把旧 ai_configs 迁成一条默认 Provider（幂等：只补没迁移过的用户）
  database.exec(`
    INSERT INTO ai_providers (user_id, name, base_url, api_key, ocr_model, chat_model, image_model, is_default)
      SELECT user_id, '默认', base_url, api_key, ocr_model, ocr_model, image_model, 1
        FROM ai_configs
       WHERE base_url <> '' AND api_key <> ''
         AND user_id NOT IN (SELECT user_id FROM ai_providers WHERE user_id IS NOT NULL)
  `);

  // AI 图像解析：OCR 时顺带存一段图片内容描述（人物/场景/剧情提示），AI 翻译时作为上下文。
  // ai_context 挂在 space_items 上（条目即一张图）
  const itemColumns = database
    .prepare('PRAGMA table_info(space_items)')
    .all() as Array<{ name: string }>;
  if (!itemColumns.some((column) => column.name === 'ai_context')) {
    database.exec(`ALTER TABLE space_items ADD COLUMN ai_context TEXT`);
  }

  // 房间垃圾回收：过期锁直接清掉，两周前的操作日志丢弃（防表无限增长）
  database.exec(`DELETE FROM edit_rooms WHERE expires_at < (strftime('%s','now') * 1000 - 60000)`);
  database.exec(
    `DELETE FROM room_ops WHERE created_at < datetime('now', '-14 days')`,
  );

  // 管理员标记（0/1）：站点唯一保留的权限差异——管理员可发放邀请码，与空间无关。
  // 管理员不自动授予（避免公网部署被抢注），由 CLI 命令手动指定：
  //   npm run admin -- list            查看全部用户与管理员状态
  //   npm run admin -- set <用户名>    赋予管理员
  //   npm run admin -- unset <用户名>  收回管理员
  if (!userColumns.some((column) => column.name === 'is_admin')) {
    database.exec(`ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0`);
  }

  // 邀请码表：管理员在页面上生成/作废，注册时消费（env INVITE_CODE 仍是本地便捷通道）。
  // used_by/used_at 在码被注册消耗时写入，明文 code 全库唯一。
  database.exec(`
    CREATE TABLE IF NOT EXISTS invite_codes (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      code       TEXT NOT NULL UNIQUE,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      used_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
      used_at    TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_invite_codes_code ON invite_codes(code);
  `);
}

// Next.js 开发模式下模块会被反复重载，用 globalThis 缓存连接避免句柄泄漏。
const globalForDb = globalThis as unknown as { __appDb?: Database.Database };
export const db: Database.Database = globalForDb.__appDb ?? createConnection();
migrate(db);
if (process.env.NODE_ENV !== 'production') {
  globalForDb.__appDb = db;
}

export { DATA_DIR };
