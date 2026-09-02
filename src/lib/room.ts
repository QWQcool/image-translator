import { db } from './db';

/** 锁心跳续期窗口：持有人每 15s 心跳一次，断线 40s 后锁自动失效 */
export const LOCK_TTL_MS = 40_000;

export type RoomState = {
  itemId: number;
  /** 锁持有人；null = 没人持有（自由编辑） */
  holderId: number | null;
  holderName: string | null;
  /** 是否已开启共享（开启后所有人可画） */
  shared: boolean;
  /** 当前用户是不是锁持有人 */
  isHolder: boolean;
  /** 当前用户能否修改（持有人，或已共享时任何人） */
  canEdit: boolean;
  /** 最新操作序号，客户端拿它做增量拉取游标 */
  seq: number;
};

type RoomRow = {
  item_id: number;
  holder_id: number;
  shared: number;
  expires_at: number;
};

function loadRoom(itemId: number): RoomRow | undefined {
  return db.prepare('SELECT * FROM edit_rooms WHERE item_id = ?').get(itemId) as
    | RoomRow
    | undefined;
}

function isFresh(row: RoomRow): boolean {
  return row.expires_at > Date.now();
}

function nextSeq(itemId: number): number {
  const row = db
    .prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM room_ops WHERE item_id = ?')
    .get(itemId) as { m: number };
  return row.m + 1;
}

export function appendOp(itemId: number, authorId: number, kind: string, payload: unknown): number {
  const seq = nextSeq(itemId);
  db.prepare(
    `INSERT INTO room_ops (item_id, seq, author_id, kind, payload) VALUES (?, ?, ?, ?, ?)`,
  ).run(itemId, seq, authorId, kind, JSON.stringify(payload ?? null));
  return seq;
}

export function readOps(itemId: number, sinceSeq: number) {
  return db
    .prepare(
      `SELECT seq, author_id, kind, payload, created_at
         FROM room_ops
        WHERE item_id = ? AND seq > ?
        ORDER BY seq`,
    )
    .all(itemId, sinceSeq) as Array<{
    seq: number;
    author_id: number;
    kind: string;
    payload: string;
    created_at: string;
  }>;
}

/** 读取房间状态。force=true 时先清掉已过期的锁（避免僵尸锁挡住所有人） */
export function getRoomState(itemId: number, userId: number): RoomState {
  let row = loadRoom(itemId);
  if (row && !isFresh(row)) {
    // 过期锁：清掉，让下一个人能接管
    db.prepare('DELETE FROM edit_rooms WHERE item_id = ?').run(itemId);
    appendOp(itemId, userId, 'meta', { type: 'lock-expired' });
    row = undefined;
  }

  const holder = row
    ? (db.prepare('SELECT username FROM users WHERE id = ?').get(row.holder_id) as
        | { username: string }
        | undefined)
    : undefined;

  const isHolder = !!row && row.holder_id === userId;
  const shared = !!row && row.shared === 1;
  const seqRow = db
    .prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM room_ops WHERE item_id = ?')
    .get(itemId) as { m: number };

  return {
    itemId,
    holderId: row ? row.holder_id : null,
    holderName: row ? holder?.username ?? `用户${row.holder_id}` : null,
    shared,
    isHolder,
    canEdit: isHolder || shared,
    seq: seqRow.m,
  };
}

/**
 * 进入编辑页时调用：
 * - 没有锁 / 锁已过期 → 当前用户接管
 * - 已是持有人 → 心跳续期
 * - 别人持有 → 只心跳不动锁（保持只读）
 */
export function touchRoom(itemId: number, userId: number): RoomState {
  const row = loadRoom(itemId);
  const fresh = row && isFresh(row);
  const expiresAt = Date.now() + LOCK_TTL_MS;

  if (!row || !fresh) {
    if (row) {
      // 过期锁被接管前先广播一下，让别人知道为什么突然变只读
      appendOp(itemId, userId, 'meta', { type: 'lock-takeover', from: row.holder_id });
    }
    db.prepare(
      `INSERT INTO edit_rooms (item_id, holder_id, shared, expires_at, updated_at)
             VALUES (?, ?, 0, ?, datetime('now'))
       ON CONFLICT(item_id) DO UPDATE SET
             holder_id = excluded.holder_id,
             shared = 0,
             expires_at = excluded.expires_at,
             updated_at = excluded.updated_at`,
    ).run(itemId, userId, expiresAt);
    appendOp(itemId, userId, 'meta', { type: 'lock-acquired' });
  } else if (row.holder_id === userId) {
    db.prepare(`UPDATE edit_rooms SET expires_at = ?, updated_at = datetime('now') WHERE item_id = ?`).run(
      expiresAt,
      itemId,
    );
  }

  return getRoomState(itemId, userId);
}

export function setShared(itemId: number, userId: number, shared: boolean): RoomState | null {
  const row = loadRoom(itemId);
  if (!row || !isFresh(row) || row.holder_id !== userId) return null;
  db.prepare(`UPDATE edit_rooms SET shared = ?, expires_at = ?, updated_at = datetime('now') WHERE item_id = ?`).run(
    shared ? 1 : 0,
    Date.now() + LOCK_TTL_MS,
    itemId,
  );
  appendOp(itemId, userId, 'meta', { type: shared ? 'share-on' : 'share-off' });
  return getRoomState(itemId, userId);
}

export function releaseRoom(itemId: number, userId: number): boolean {
  const row = loadRoom(itemId);
  if (!row || row.holder_id !== userId) return false;
  db.prepare('DELETE FROM edit_rooms WHERE item_id = ?').run(itemId);
  appendOp(itemId, userId, 'meta', { type: 'lock-released' });
  return true;
}

/**
 * 保存接口的守卫：
 * - 没有房间（没人进入过编辑页）→ 放行
 * - 自己持锁 → 放行
 * - 已共享 → 放行（协作模式）
 * - 别人持锁且未共享 → 423 Locked
 */
export function saveGuard(itemId: number, userId: number): { ok: true } | { ok: false; error: string; holder?: string } {
  const row = loadRoom(itemId);
  if (!row) return { ok: true };
  if (!isFresh(row)) return { ok: true };
  if (row.holder_id === userId) return { ok: true };
  if (row.shared === 1) return { ok: true };
  const holder = db.prepare('SELECT username FROM users WHERE id = ?').get(row.holder_id) as
    | { username: string }
    | undefined;
  return {
    ok: false,
    error: `${holder?.username ?? '他人'} 正在编辑这张图，锁定中`,
    holder: holder?.username,
  };
}
