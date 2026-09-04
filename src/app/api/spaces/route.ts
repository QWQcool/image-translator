import { NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { db } from '@/lib/db';
import { DEFAULT_LP_STYLES } from '@/lib/labelplus';
import { logOp } from '@/lib/oplog';
import { addMember } from '@/lib/permissions';
import { isSpaceProgress } from '@/lib/progress';
import { cleanTagsInput } from '@/lib/tags';
import type { Space, SpaceVisibility, SpaceWithCounts } from '@/lib/types';

/**
 * 可见范围：所有公开空间 + 我参与的 + 我创建的。
 * 权限扁平化后所有登录用户对所有空间都有完整权限，role 仅用于展示
 * （owner 标记「我创建的」分组），不再有 viewer 只读态。
 */
const LIST_SQL = `
  SELECT s.*,
         (SELECT u.username FROM users u WHERE u.id = s.owner_id) AS owner_name,
         (SELECT COUNT(*) FROM space_items si WHERE si.space_id = s.id) AS item_count,
         (SELECT COUNT(*) FROM annotations an
            JOIN space_items si ON an.item_id = si.id
           WHERE si.space_id = s.id) AS annotation_count,
         (SELECT COUNT(*) FROM space_members sm WHERE sm.space_id = s.id) AS member_count,
         (SELECT si.id FROM space_items si
           WHERE si.space_id = s.id
           ORDER BY si.sort_order, si.id LIMIT 1) AS cover_item_id,
         (SELECT a.thumb_filename FROM space_items si
            JOIN assets a ON a.id = si.asset_id
           WHERE si.space_id = s.id
           ORDER BY si.sort_order, si.id LIMIT 1) AS cover_thumb,
         (SELECT a.filename FROM space_items si
            JOIN assets a ON a.id = si.asset_id
           WHERE si.space_id = s.id
           ORDER BY si.sort_order, si.id LIMIT 1) AS cover_filename,
         CASE
           WHEN s.owner_id = ? THEN 'owner'
           ELSE 'editor'
         END AS role
    FROM spaces s
    LEFT JOIN space_members m ON m.space_id = s.id AND m.user_id = ?
   WHERE (m.user_id IS NOT NULL OR s.owner_id = ? OR s.visibility = 'public') __SEARCH__ __FILTER__
   -- 已嵌字的空间只做视觉区分不锁编辑，列表里排到同组末尾（实心 emerald 徽标足够辨识）
   ORDER BY (m.user_id IS NULL), (s.progress = 'typeset_done'), s.updated_at DESC, s.id DESC
`;

export async function GET(request: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });

  // 全局查找：LIKE 匹配空间名 / 描述 / 空间序号（序号部分匹配天然支持：20260904、0904-01、09 等）
  const keyword = (new URL(request.url).searchParams.get('q') ?? '').trim();
  const searchClause = keyword
    ? `AND (s.name LIKE ? OR IFNULL(s.description, '') LIKE ? OR IFNULL(s.space_no, '') LIKE ?)`
    : '';
  const searchArgs = keyword ? [`%${keyword}%`, `%${keyword}%`, `%${keyword}%`] : [];

  // 完结状态筛选（遗留参数，阶段 15 后 UI 不再发送；status 列废弃仅保留兼容）
  const filterRaw = new URL(request.url).searchParams.get('filter');
  const filter = filterRaw === 'active' || filterRaw === 'finished' ? filterRaw : 'all';
  const filterClause = filter === 'all' ? '' : 'AND s.status = ?';
  const filterArgs = filter === 'all' ? [] : [filter];

  // 进度筛选：逗号多值并集（s.progress IN (...)）；非法值直接忽略
  const progressRaw = new URL(request.url).searchParams.get('progress') ?? '';
  const progressValues = progressRaw
    .split(',')
    .map((item) => item.trim())
    .filter(isSpaceProgress);
  const progressClause = progressValues.length
    ? `AND s.progress IN (${progressValues.map(() => '?').join(',')})`
    : '';

  // 标签筛选：逗号多值，任一命中即命中（json_each 展开 JSON 数组做精确等值匹配）
  const tagRaw = new URL(request.url).searchParams.get('tag') ?? '';
  const tagValues = tagRaw
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 20);
  const tagClause = tagValues.length
    ? `AND EXISTS (SELECT 1 FROM json_each(s.tags) je WHERE je.value IN (${tagValues
        .map(() => '?')
        .join(',')}))`
    : '';

  // 保存时间筛选：3d/7d/30d 相对窗口，或 ISO 日期（该日 00:00 之前保存的语义）
  const savedRaw = (new URL(request.url).searchParams.get('savedBefore') ?? '').trim();
  let savedClause = '';
  let savedArgs: string[] = [];
  if (savedRaw === '3d' || savedRaw === '7d' || savedRaw === '30d') {
    savedClause = `AND s.updated_at < datetime('now', '-${parseInt(savedRaw, 10)} days')`;
  } else if (/^\d{4}-\d{2}-\d{2}$/.test(savedRaw)) {
    savedClause = 'AND s.updated_at < ?';
    savedArgs = [`${savedRaw} 00:00:00`];
  }

  const rows = db
    .prepare(
      LIST_SQL.replace(
        '__SEARCH__',
        searchClause + progressClause + tagClause + savedClause,
      ).replace('__FILTER__', filterClause),
    )
    .all(user.id, user.id, user.id, ...searchArgs, ...progressValues, ...tagValues, ...savedArgs, ...filterArgs) as Array<
    Omit<SpaceWithCounts, 'can_edit' | 'is_owner'>
  >;

  const spaces: SpaceWithCounts[] = rows.map((row) => ({
    ...row,
    // 权限扁平化：登录用户对所有空间都可编辑
    can_edit: true,
    is_owner: row.role === 'owner',
  }));

  // 全库出现过的标签（预设之外的动态候选），供列表页筛选 chips 使用
  const distinctTags = (
    db
      .prepare(`SELECT DISTINCT je.value AS tag FROM spaces s, json_each(s.tags) je ORDER BY tag`)
      .all() as Array<{ tag: string }>
  ).map((row) => row.tag);

  return NextResponse.json({ spaces, distinctTags });
}

export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });

  let body: {
    name?: string;
    description?: string;
    visibility?: string;
    tags?: unknown;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: '请求体格式错误' }, { status: 400 });
  }

  const name = (body.name ?? '').trim();
  const description = (body.description ?? '').trim() || null;
  const tags = cleanTagsInput(body.tags);
  // 开放空间：没有私人文件夹，请求里的 visibility 一律忽略
  const visibility: SpaceVisibility = 'public';

  if (!name) return NextResponse.json({ error: '空间名称不能为空' }, { status: 400 });
  if (name.length > 100) return NextResponse.json({ error: '空间名称过长' }, { status: 400 });

  /**
   * 空间序号生成：YYYYMMDD-NN（日期取服务器本地创建当天，NN=当日已有序号数+1，两位补零）。
   * 必须在事务内执行：better-sqlite3 事务是同步排他的，COUNT + INSERT 原子化；
   * 生成后再用唯一索引校验兜底，撞号（历史脏数据等）就递增重试。
   */
  const nextSpaceNo = (): string => {
    const now = new Date();
    const prefix =
      String(now.getFullYear()).padStart(4, '0') +
      String(now.getMonth() + 1).padStart(2, '0') +
      String(now.getDate()).padStart(2, '0');
    const used = db
      .prepare(`SELECT space_no FROM spaces WHERE space_no LIKE ?`)
      .all(`${prefix}-%`) as Array<{ space_no: string }>;
    const taken = new Set(used.map((row) => row.space_no));
    // 取现存最大 NN + 1（而非 COUNT+1）：删除最大序号空间后不回收复用，序号单调递增
    let nn = 0;
    for (const row of used) {
      const suffix = Number(row.space_no.slice(prefix.length + 1));
      if (Number.isInteger(suffix) && suffix > nn) nn = suffix;
    }
    nn += 1;
    let candidate = `${prefix}-${String(nn).padStart(2, '0')}`;
    // 冲突重试递增（正常并发下事务已保证不会走到这里，防御历史数据手工填号）
    while (taken.has(candidate)) {
      nn += 1;
      candidate = `${prefix}-${String(nn).padStart(2, '0')}`;
    }
    return candidate;
  };

  // 建空间与写入 owner 成员必须在同一事务，否则中途失败会留下无主空间。
  // 新空间同时预置默认分组样式（与迁移回填对齐：组1 竖排深蓝，组2 横排蓝）。
  const createSpace = db.transaction(() => {
    const result = db
      .prepare(
        'INSERT INTO spaces (owner_id, name, description, visibility, space_no, tags, lp_styles, progress, progress_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        user.id,
        name,
        description,
        visibility,
        nextSpaceNo(),
        JSON.stringify(tags),
        JSON.stringify(DEFAULT_LP_STYLES),
        'untranslated',
        // 迁移库上 progress_at 为可空列且无默认值，建空间必须显式写入
        // datetime('now') 与服务端时区/格式保持一致
        new Date().toISOString().slice(0, 19).replace('T', ' '),
      );
    const spaceId = Number(result.lastInsertRowid);
    addMember(spaceId, user.id, 'owner');
    return spaceId;
  });

  const spaceId = createSpace();
  const space = db.prepare('SELECT * FROM spaces WHERE id = ?').get(spaceId) as Space;

  logOp(user.id, 'space_create', 'space', spaceId, space.name);
  return NextResponse.json({ space }, { status: 201 });
}
