import { db } from '@/lib/db';
import { formatDate } from '@/lib/media';

/** 动作 → 中文标签 */
const ACTION_LABELS: Record<string, string> = {
  create: '新增',
  update: '修改',
  delete: '删除',
  upload: '上传',
  space_create: '创建空间',
  space_delete: '删除空间',
  member: '成员',
  restore: '恢复',
  purge: '彻底删除',
  ai_ocr: 'AI 识别',
  ai_inpaint: 'AI 去字',
  ai_translate: 'AI 翻译',
};

const ACTION_COLORS: Record<string, string> = {
  delete: 'bg-blush/15 text-blush',
  space_delete: 'bg-blush/15 text-blush',
  purge: 'bg-blush/15 text-blush',
  restore: 'bg-emerald-500/15 text-emerald-700',
  upload: 'bg-sky/15 text-sky-deep',
  space_create: 'bg-sky/15 text-sky-deep',
};

type LogRow = {
  id: number;
  username: string | null;
  action: string;
  target_type: string;
  target_id: number | null;
  target_name: string | null;
  detail: string | null;
  created_at: string;
};

export const dynamic = 'force-dynamic';

export default function LogsPage() {
  // 只展示最近 500 条，按时间倒序（id 单调递增，直接按 id 排）
  const logs = db
    .prepare(
      `SELECT l.id, l.action, l.target_type, l.target_id, l.target_name, l.detail, l.created_at,
              u.username
         FROM op_logs l
         LEFT JOIN users u ON u.id = l.user_id
        ORDER BY l.id DESC
        LIMIT 500`,
    )
    .all() as LogRow[];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-medium text-ink-100">操作日志</h1>
        <span className="text-xs text-ink-500">最近 {logs.length} 条 · 共展示上限 500 条</span>
      </div>

      {logs.length === 0 ? (
        <div className="card py-16 text-center text-sm text-ink-500">还没有任何操作记录</div>
      ) : (
        <div className="card overflow-hidden p-0">
          <table className="w-full text-left text-xs">
            <thead className="bg-paper text-ink-500">
              <tr>
                <th className="whitespace-nowrap px-3 py-2 font-medium">时间</th>
                <th className="whitespace-nowrap px-3 py-2 font-medium">用户</th>
                <th className="whitespace-nowrap px-3 py-2 font-medium">动作</th>
                <th className="px-3 py-2 font-medium">对象</th>
                <th className="px-3 py-2 font-medium">详情</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-700/60">
              {logs.map((log) => (
                <tr key={log.id} className="text-ink-200">
                  <td className="whitespace-nowrap px-3 py-2 text-ink-400">{formatDate(log.created_at)}</td>
                  <td className="whitespace-nowrap px-3 py-2">{log.username ?? '（已注销）'}</td>
                  <td className="whitespace-nowrap px-3 py-2">
                    <span
                      className={`rounded px-1.5 py-0.5 ${
                        ACTION_COLORS[log.action] ?? 'bg-paper text-ink-300'
                      }`}
                    >
                      {ACTION_LABELS[log.action] ?? log.action}
                    </span>
                  </td>
                  <td className="max-w-[220px] truncate px-3 py-2" title={log.target_name ?? ''}>
                    {log.target_name ?? '—'}
                  </td>
                  <td className="max-w-[420px] truncate px-3 py-2 text-ink-400" title={log.detail ?? ''}>
                    {log.detail ?? '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
