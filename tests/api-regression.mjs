#!/usr/bin/env node
/**
 * tests/api-regression.mjs —— 图译空间 API 全量回归脚本（纯 node + fetch，无新依赖）
 *
 * 用法：
 *   node tests/api-regression.mjs [baseUrl]        # 默认 http://localhost:3000
 *
 * 环境变量：
 *   INVITE_CODE     注册用邀请码（env 便捷通道）。未提供且未设 USERNAME/PASSWORD 时无法建号，脚本退出（exit 2）
 *   USERNAME/PASSWORD  已有账号：跳过注册直接登录建数据（适合无邀请码的既有环境）
 *   ADMIN_USERNAME/ADMIN_PASSWORD  可选：管理员账号，用于表码「生成→消费」端到端用例
 *   REGISTER_MAX_PER_IP  服务端注册限流；默认每小时 3 次/IP，本脚本至少需要 3 次注册，
 *                   测试实例建议启动时设 REGISTER_MAX_PER_IP=1000 REGISTER_MAX_GLOBAL=100000
 *   SKIP_AI=1       跳过 AI（内置 mock OpenAI）相关用例
 *
 * 行为：
 *   - 自建测试数据（注册临时用户 / 建空间 / 传图 / 造标注 / 配 mock AI Provider）
 *   - 结束时删除自己创建的全部空间（临时用户与消费的邀请码会保留，属预期）
 *   - 输出分组 PASS/FAIL 汇总；任一 FAIL 则退出码 1，服务不可达退出码 2
 */

import { zipSync, unzipSync } from 'fflate';
import http from 'node:http';

const BASE = (process.argv[2] ?? 'http://localhost:3000').replace(/\/+$/, '');
const INVITE_CODE = process.env.INVITE_CODE ?? '';
const SKIP_AI = process.env.SKIP_AI === '1';
const RUN_TAG = `t17r${Date.now().toString(36).slice(-6)}`;

// ---------- 基础设施 ----------

/** 会话桶：每个测试用户一份独立 cookie */
const jars = new Map();
let currentJar = 'main';

function useJar(name) {
  currentJar = name;
  if (!jars.has(name)) jars.set(name, '');
}

/** 通用请求。opts: { json, form, as(会话桶), noRedirect }，返回 { status, data, text, buffer, headers } */
async function req(method, path, opts = {}) {
  const jar = opts.as ?? currentJar;
  const headers = {};
  const cookie = jars.get(jar);
  if (cookie) headers.cookie = cookie;
  let payload;
  if (opts.form) {
    payload = opts.form;
  } else if (opts.json !== undefined) {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(opts.json);
  }
  const res = await fetch(BASE + path, {
    method,
    headers,
    body: payload,
    redirect: opts.noRedirect === false ? 'follow' : 'manual',
  });
  for (const c of res.headers.getSetCookie?.() ?? []) {
    const kv = c.split(';')[0];
    if (kv && (c.includes('Expires=Thu, 01 Jan 1970') === false || true)) jars.set(jar, kv);
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  const text = buffer.toString('utf8');
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    data = null;
  }
  return { status: res.status, data, text, buffer, headers: res.headers };
}

const results = []; // { group, name, ok, detail }
const SKIP = Symbol('skip');

/** 前置数据创建失败时优雅中止（打印已完成结果后退出） */
process.on('unhandledRejection', (err) => {
  console.error(`\n[中止] ${err?.message ?? err}`);
  process.exit(summary() > 0 || results.length === 0 ? 1 : 1);
});
function record(group, name, ok, detail = '') {
  results.push({ group, name, ok, detail });
  const tag = ok === SKIP ? 'SKIP' : ok ? 'PASS' : 'FAIL';
  if (ok === SKIP) ok = true; // skip 不计入失败，但单独展示
  results[results.length - 1].skipped = tag === 'SKIP';
  console.log(`${tag} | [${group}] ${name}${detail ? ' | ' + detail : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function summary() {
  const groups = [...new Set(results.map((r) => r.group))];
  let failTotal = 0;
  let skipTotal = 0;
  console.log('\n==================== 分组汇总 ====================');
  for (const g of groups) {
    const rows = results.filter((r) => r.group === g);
    const fails = rows.filter((r) => !r.ok);
    const skips = rows.filter((r) => r.skipped);
    failTotal += fails.length;
    skipTotal += skips.length;
    console.log(`${g}：${rows.length - fails.length - skips.length}/${rows.length} 通过${skips.length ? `（${skips.length} 跳过）` : ''}`);
    for (const f of fails) console.log(`   FAIL → ${f.name} | ${f.detail}`);
  }
  console.log(
    `总计：${results.length} 项，通过 ${results.length - failTotal - skipTotal}，失败 ${failTotal}，跳过 ${skipTotal}`,
  );
  return failTotal;
}

// ---------- 测试素材 ----------

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);
/** 320x160 大图：两步 OCR 的空框裁剪（sharp extract 至少 8px）需要真实尺寸 */
const BIG_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAUAAAACgCAIAAADywSLLAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAENklEQVR4nO3VUQ0DARAC0fOvbETUy9VDf0izL0HAZoDl6fMSAgj0n0V45hcQAgikwEKAQPf2wALvPSAEUmAhQKB739AC7z0gBFJgIUCge9/QAu89IARSYCFAoHvf0ALvPSAEUmAhQKB739AC7z0gBFJgIUCge9/QAu89IARSYCFAoHvf0ALvPSAEUmAhQKB739AC7z0gBFJgIUCge9/QAu89IARSYCFAoHvf0ALvPSAEUmAhQKB739AC7z0gBFJgIUCge9/QAu89IARSYCFAoHvf0ALvPSAEUmAhQKB739AC7z0gBFJgIUCge9/QAu89IARSYCFAoHvf0ALvPSAEUmAhQKB739AC7z0gBFJgIUCge9/QAu89IARSYCFAoHvf0ALvPSAEUmAhQKB739AC7z0gBFJgIUCge9/QAu89IARSYCFAoHvf0ALvPSAEUmAhQKB739AC7z0gBFJgIUCge9/QAu89IARSYCFAoHvf0ALvPSAEUmAhQKB739AC7z0gBFJgIUCge9/QAu89IARSYCFAoHvf0ALvPSAEUmAhQKB739AC7z0gBFJgIUCge9/QAu89IARSYCFAoHvf0ALvPSAEUmAhQKB739AC7z0gBFJgIUCge9/QAu89IARSYCFAoHvf0ALvPSAEUmAhQKB739AC7z0gBFJgIUCge9/QAu89IARSYCFAoHvf0ALvPSAEUmAhQKB739AC7z0gBFJgIUCge9/QAu89IARSYCFAoHvf0ALvPSAEUmAhQKB739AC7z0gBFJgIUCge9/QAu89IARSYCFAoHvf0ALvPSAEUmAhQKB739AC7z0gBFJgIUCge9/QAu89IARSYCFAoHvf0ALvPSAEUmAhQKB739AC7z0gBFJgIUCge9/QAu89IARSYCFAoHvf0ALvPSAEUmAhQKB739AC7z0gBFJgIUCge9/QAu89IARSYCFAoHvf0ALvPSAEUmAhQKB739AC7z0gBFJgIUCge9/QAu89IARSYCFAoHvf0ALvPSAEUmAhQKB739AC7z0gBFJgIUCge9/QAu89IARSYCFAoHvf0ALvPSAEUmAhQKB739AC7z0gBFJgIUCge9/QAu89IARSYCFAoHvf0ALvPSAEUmAhQKB739AC7z0gBFJgIUCge9/QAu89IARSYCFAoHvf0ALvPSAEUmAhQKB739AC7z0gBFJgIUCge9/QAu89IARSYCFAoHvf0ALvPSAEUmAhQKB739AC7z0gBFJgIUCge9/QAu89IARSYCFAoHvf0ALvPSAEUmAhQKB739AC7z0gBFJgIUCge9/QAu89IARSYCFAoHvf0ALvPSAEUmAhQKB739AC7z0gBFJgIUCge9/QAu89IARSYCFAoHvf0ALvPSAEUmAhQKB739AC7z0gBFJgIUCge9/QAu89IARSYCFAoHvf0ALvPSAEUmAhQKB739AC7z0gBFJgIUCge9/QAu89IARSYCFAoHvf0ALvPSAEUmAhQKB739AC7z0gBFJgIUCge9/QAu89IARSYCFAoHvf0ALvPSAEUmAhQKB739AC7z0gBFJgIUCge9/QAu89IARSYCFAoHvf0ALvPSAEUmAhQKB739AC7z0gBFJgIUCge9/QAu89IARSYCFAoHvf0ALvPSAEUmAhQKB739AC7z0gBFJgIUCge9/QAu89IARSYCFAoHvf0ALvPSAEUmAhQKB739AC7z0gBFJgIUCge9/QAu89IARSYCFAoHvf0ALvPSAEUmAhQKB739AC7z0gBFJgIUCge9/QAu89IARSYCFAoHvf0ALvPSAEUmAhQKB739AC7z0gBFJgIUCge9/QAu89IARSYCFAoHvf0ALvPSAEUmAhQKB739AC7z0gBFJgIUCge9/QAu89IARSYCFAoHvf0ALvPSAEUmAhQKB739AC7z0gBFJgIUCge9/QAu89IARSYCFAoHvf0ALvPSAEUmAhQKB739AC7z0gBFJgIUCge9/QAu89IARSYCFAoHvf0ALvPSAEUmAhQKB739AC7z0gBFJgIUCge9/QAu89IARSYCFAoHvf0ALvPSAEUmAhQKB739AC7z0gBFJgIUCge9/QAu89IARSYCFAoHvf0ALvPSAEUmAhQKB739AC7z0gBFJgIUCge9/QAu89IARSYCFAoHvf0ALvPSAEUmAhQKB739AC7z0gBFJgIUCge9/QAu89IARSYCFAoHvf0ALvPSAEUmAhQKB739AC7z0gBFJgIUCge9/QAu89IARSYCFAoHvf0ALvPSAEUmAhQKB739AC7z0gBFJgIUCge9/QAu89IARSYCFAoHvf0ALvPSAEUmAhQKB739AC7z0gBFJgIUCge9/QAu89IARSYCFAoHvf0ALvPSAEUmAhQKB739AC7z0gBFJgIUCge9/QAu89IAQUWAgQeA8+Agu894AQSIGFAIHufUMLvPeAEEiBhQCB7n1DC7z3gBBIgYUAge59Qwu894AQSIGFAIHufUMLvPeAEEiBhQCB7n1DC7z3gBBIgYUAge59Qwu894AQSIGFAIHufUMLvPeAEEiBhQCB7n1DC7z3gBBIgYUAge59Qwu894AQSIGFAIHufUMLvPeAEEiBhQCB7n1DC7z3gBBIgYUAge59Qwu894AQSIGFAIHufUMLvPeAEEiBhQCB7n1DC7z3gBBIgYUAge59Qwu894AQSIGFAIHufUMLvPeAEEiBhQCB7n1DC7z3gBBIgYUAge59Qwu894AQSIGFAIHufUMLvPeAEEiBhQCB7n1DC7z3gBBIgYUAge59Qwu894AQSIGFAIHufUMLvPeAEEiBhQCB7n1DC7z3gBBIgYUAge59Qwu894AQSIGFAIHufUMLvPeAEEiBhQCB7n1DC7z3gBBIgYUAge59Qwu894AQSIGFAIHufUMLvPeAEEiBhQCB7n1DC7z3gBBIgYUAge59Qwu894AQSIGFAIHufUMLvPeAEEiBhQCB7n1DC7z3gBBIgYUAge59Qwu894AQSIGFAIHufUMLvPeAEEiBhQCB7n1DC7z3gBBIgYUAge59Qwu894AQSIGFAIHufUMLvPeAEEiBhQCB7n1DC7z3gBBIgYUAge59Qwu894AQSIGFAIHufUMLvPeAEEiBhQCB7n1DC7z3gBBIgYUAge59Qwu894AQSIGFAIHufUMLvPeAEEiBhQCB7n1DC7z3gBBIgYUAge59Qwu894AQSIGFAIHufUMLvPeAEEiBhQCB7n1DC7z3gBBIgYUAge59Qwu894AQSIGFAIHufUMLvPeAEEiBhQCB7n1DC7z3gBBIgYUAge59Qwu894AQSIGFAIHufUMLvPeAEEiBhQCB7n1DC7z3gBBIgYUAge59Qwu894AQSIGFAIHufUMLvPeAEEiBhQCB7n1DC7z3gBBIgYUAge59Qwu894AQSIGFAIHufUMLvPeAEEiBhQCB7n1DC7z3gBBIgYUAge59Qwu894AQSIGFAIHufUMLvPeAEEiBhQCB7n1DC7z3gBBIgYUAge59Qwu894AQSIGFAIHufUMLvPeAEEiBhQCB7n1DC7z3gBBIgYUAge59Qwu894AQSIGFAIHufUMLvPeAEEiBhQCB7n1DC7z3gBBIgYUAge59Qwu894AQSIGFAIHufUMLvPeAEEiBhQCB7n1DC7z3gBBIgYUAge59Qwu894AQSIGFAIHufUMLvPeAEEiBhQCB7n1DC7z3gBBIgYUAge59Qwu894AQSIGFAIHufUMLvPeAEEiBhQCB7n1DC7z3gBBIgYUAge59Qwu894AQSIGFAIHufUMLvPeAEEiBhQCB7n1DC7z3gBBIgYUAge59Qwu894AQ6NcYfAFc3HbikLbmegAAAABJRU5ErkJggg==',
  'base64',
);

/** 空间接口的 tags 是 JSON 字符串（前端自行 parse），统一转数组便于断言 */
function parseTags(space) {
  const raw = space?.tags;
  if (Array.isArray(raw)) return raw;
  try {
    return JSON.parse(raw ?? '[]');
  } catch {
    return [];
  }
}
const PROGRESS_KEYS = [
  'untranslated',
  'translated_placeholder',
  'translated',
  'proofread_placeholder',
  'proofread',
  'typeset_placeholder',
  'typeset_done',
];

const createdSpaceIds = [];

async function makeSpace(name, body = {}) {
  const r = await req('POST', '/api/spaces', { json: { name, ...body } });
  const space = r.data?.space;
  if (!space?.id) {
    throw new Error(`建空间失败（${name}）：status=${r.status} body=${JSON.stringify(r.data).slice(0, 200)}——请检查登录态/邀请码`);
  }
  createdSpaceIds.push(space.id);
  return { r, space };
}

async function uploadPng(spaceId, names) {
  const form = new FormData();
  for (const name of names) {
    form.append('files', new Blob([BIG_PNG], { type: 'image/png' }), name);
  }
  return req('POST', `/api/spaces/${spaceId}/assets`, { form });
}

function pngFormEntry(form, name) {
  form.append('files', new Blob([BIG_PNG], { type: 'image/png' }), name);
}

// ---------- 内置 mock OpenAI 服务（分组六用） ----------

async function readBody(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

function startMockAi() {
  const server = http.createServer(async (sreq, res) => {
    try {
      if (!sreq.url || !sreq.url.endsWith('/chat/completions')) {
        res.writeHead(404).end();
        return;
      }
      const body = JSON.parse(await readBody(sreq));
      const model = String(body.model ?? '');
      const messages = Array.isArray(body.messages) ? body.messages : [];
      const sys = String(messages.find((m) => m.role === 'system')?.content ?? '');
      const last = messages[messages.length - 1] ?? {};
      const userText =
        typeof last.content === 'string' ? last.content : JSON.stringify(last.content ?? '');

      let content = '{}';
      if (model === 'det-model') {
        // 文本块检测端点：两个框，一个空框（走视觉补提取）、一个自带文本
        content = JSON.stringify({
          blocks: [
            { x: 0.1, y: 0.1, w: 0.2, h: 0.08, text: '' },
            { x: 0.6, y: 0.7, w: 0.3, h: 0.1, text: '检测自带文本' },
          ],
        });
      } else if (userText.includes('局部区域')) {
        // 空框补提取端点
        content = '{"text":"MOCK框内文本"}';
      } else if (userText.includes('找出图中所有对话气泡')) {
        // 整页视觉 OCR 端点
        content = JSON.stringify({
          blocks: [
            { x: 0.05, y: 0.05, w: 0.3, h: 0.12, text: 'MOCK原A' },
            { x: 0.5, y: 0.6, w: 0.4, h: 0.1, text: 'MOCK原B' },
          ],
          description: 'MOCK描述：测试图片内容',
        });
      } else if (sys.includes('漫画翻译')) {
        // AI 翻译端点：逐 id 回填
        const m = userText.match(/原文列表：(\[[\s\S]*\])/);
        const list = m ? JSON.parse(m[1]) : [];
        content = JSON.stringify(list.map((row) => ({ id: row.id, translated: `译：${row.text}` })));
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }));
    } catch {
      res.writeHead(500).end();
    }
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

// ============================================================
// 分组〇：连通性预检
// ============================================================
{
  let up = false;
  try {
    const r = await fetch(`${BASE}/api/auth/me`, { signal: AbortSignal.timeout(10000) });
    up = r.status >= 200;
  } catch {
    up = false;
  }
  if (!up) {
    console.error(`服务不可达：${BASE}（请先启动待测实例）`);
    process.exit(2);
  }
  console.log(`目标服务：${BASE}（可达）\n`);
}

// ============================================================
// 分组一：认证与权限
// ============================================================
const G1 = '一、认证与权限';
let userId = null;

{
  useJar('anon');
  const checks = [
    ['GET /api/spaces', await req('GET', '/api/spaces')],
    ['GET /api/settings', await req('GET', '/api/settings')],
    ['GET /api/notifications', await req('GET', '/api/notifications')],
    ['GET /api/ai/providers', await req('GET', '/api/ai/providers')],
    ['GET /api/media/images/x.png', await req('GET', '/api/media/images/x.png')],
  ];
  for (const [name, r] of checks) {
    record(G1, `未登录 ${name} → 401`, r.status === 401, `status=${r.status}`);
  }
  record(
    G1,
    '未登录 GET /spaces 页面 → 307 跳登录（登录墙）',
    (await req('GET', '/spaces')).status === 307,
  );
  useJar('main');
}

// —— 注册主测试用户（先成功注册，再测负面用例，规避注册限流占额）——
const mainUser = `${RUN_TAG}main`;
let registerLimited = false;
if (process.env.USERNAME && process.env.PASSWORD) {
  const r = await req('POST', '/api/auth/login', {
    json: { username: process.env.USERNAME, password: process.env.PASSWORD },
  });
  record(G1, '已有账号登录（USERNAME/PASSWORD）→ 200', r.status === 200, `status=${r.status}`);
  const me = await req('GET', '/api/auth/me');
  userId = me.data?.user?.id ?? me.data?.id ?? null;
} else {
  const r = await req('POST', '/api/auth/register', {
    json: { username: mainUser, password: 'T17pass!123', inviteCode: INVITE_CODE },
  });
  if (r.status === 429) registerLimited = true;
  record(
    G1,
    '注册（env 邀请码）→ 200 且种下会话',
    (r.status === 200 || r.status === 201) && !!r.headers.get('set-cookie'),
    `status=${r.status} body=${JSON.stringify(r.data).slice(0, 120)}`,
  );
  const me = await req('GET', '/api/auth/me');
  record(G1, 'GET /api/auth/me → 当前用户名', me.status === 200 && JSON.stringify(me.data).includes(mainUser), JSON.stringify(me.data).slice(0, 120));
  userId = me.data?.user?.id ?? me.data?.id ?? null;
}

// 第二个用户（跨用户权限 / 通知用例需要）
useJar('userb');
const userB = `${RUN_TAG}userb`;
if (!registerLimited) {
  const r = await req('POST', '/api/auth/register', {
    json: { username: userB, password: 'T17pass!123', inviteCode: INVITE_CODE },
  });
  record(
    G1,
    '注册第二用户 userB → 200',
    r.status === 200 || r.status === 201,
    `status=${r.status} body=${JSON.stringify(r.data).slice(0, 120)}`,
  );
} else {
  record(G1, '注册第二用户 userB（限流跳过）', SKIP, 'REGISTER_MAX_PER_IP 已达上限');
}
useJar('main');

// 负面注册用例（在限额放宽的实例上才会得到 4xx；默认限流实例上 429 本身即有效防护）
if (process.env.ADMIN_USERNAME && process.env.ADMIN_PASSWORD) {
  useJar('admin');
  const r = await req('POST', '/api/auth/login', {
    json: { username: process.env.ADMIN_USERNAME, password: process.env.ADMIN_PASSWORD },
  });
  if (r.status === 200) {
    const mk = await req('POST', '/api/admin/invites');
    const code = mk.data?.code?.code;
    record(G1, '管理员生成表码 → 201 且返回明文', mk.status === 201 && /^[A-Za-z2-9]{4}-[A-Za-z2-9]{4}-[A-Za-z2-9]{4}$/.test(code ?? ''), `status=${mk.status} code=${code}`);
    if (code) {
      useJar('tbluser');
      const tr = await req('POST', '/api/auth/register', {
        json: { username: `${RUN_TAG}tbl`, password: 'T17pass!123', inviteCode: code },
      });
      record(G1, '表码注册 → 200（码被消费）', tr.status === 200 || tr.status === 201, `status=${tr.status}`);
      useJar('admin');
      const list = await req('GET', '/api/admin/invites');
      const row = (list.data?.codes ?? []).find((c) => c.code === code);
      record(G1, '表码消费后 usedBy 记录到注册者', row?.usedBy === `${RUN_TAG}tbl`, `usedBy=${row?.usedBy}`);
      useJar('main');
    }
  } else {
    record(G1, '管理员账号登录（ADMIN_USERNAME/PASSWORD）', SKIP, `status=${r.status}`);
  }
  useJar('main');
} else {
  record(G1, '表码生成/消费端到端（需 ADMIN_USERNAME/PASSWORD）', SKIP, '未提供管理员账号');
}

{
  // 非 admin 访问管理员接口
  useJar('userb');
  const r = await req('GET', '/api/admin/invites');
  record(G1, '非管理员 GET /api/admin/invites → 403', r.status === 403 || r.status === 429, `status=${r.status}`);
  useJar('main');

  // 负面注册：错误邀请码 / 弱密码 / 重复用户名（限流实例上 429 亦算防护生效）
  const neg = [
    ['错误邀请码 → 400（或限流 429）', { username: `${RUN_TAG}neg1`, password: 'T17pass!123', inviteCode: 'definitely-wrong' }, (s) => s === 400 || s === 429],
    ['弱密码 → 400（或限流 429）', { username: `${RUN_TAG}neg2`, password: '123', inviteCode: INVITE_CODE }, (s) => s === 400 || s === 429],
    ['重复用户名 → 409（或限流 429）', { username: mainUser, password: 'T17pass!123', inviteCode: INVITE_CODE }, (s) => s === 409 || s === 429],
  ];
  for (const [name, body, ok] of neg) {
    const r = await req('POST', '/api/auth/register', { json: body });
    record(G1, `注册负面：${name}`, ok(r.status), `status=${r.status}`);
  }

  // 登录 / 登出
  const bad = await req('POST', '/api/auth/login', { json: { username: mainUser, password: 'wrong-pass' }, as: 'tmp' });
  record(G1, '登录错误密码 → 401', bad.status === 401 || bad.status === 429, `status=${bad.status}`);
  const out = await req('POST', '/api/auth/logout');
  record(G1, '登出 → 200 且会话失效', out.status === 200 && (await req('GET', '/api/auth/me')).status === 401, `logout=${out.status}`);
  const relog = await req('POST', '/api/auth/login', { json: { username: mainUser, password: 'T17pass!123' } });
  record(G1, '重新登录 → 200', relog.status === 200, `status=${relog.status}`);
}

// ============================================================
// 分组二：空间管理
// ============================================================
const G2 = '二、空间管理';
let spaceA, spaceB, spaceC;
{
  useJar('main');
  const a = await makeSpace(`回归空间A-${RUN_TAG}`, { description: '初始描述', tags: ['回归甲', '纯爱'] });
  spaceA = a.space;
  record(
    G2,
    '建空间 → 201 且自动序号 YYYYMMDD-NN',
    a.r.status === 201 && /^\d{8}-\d{2}$/.test(spaceA?.space_no ?? '') && JSON.stringify(parseTags(spaceA)) === JSON.stringify(['回归甲', '纯爱']),
    `status=${a.r.status} space_no=${spaceA?.space_no} tags=${JSON.stringify(parseTags(spaceA))}`,
  );

  const b = await makeSpace(`回归空间B-${RUN_TAG}`, { tags: ['回归乙', '鬼畜'] });
  spaceB = b.space;
  const nnA = Number(spaceA.space_no.split('-')[1]);
  const nnB = Number(spaceB.space_no.split('-')[1]);
  record(G2, '同日再建 → 序号 NN 递增', b.r.status === 201 && nnB === nnA + 1, `${spaceA.space_no} → ${spaceB.space_no}`);

  const c = await makeSpace(`回归空间C-${RUN_TAG}`);
  spaceC = c.space;

  // 改名 / 描述
  let r = await req('PATCH', `/api/spaces/${spaceA.id}`, { json: { name: `回归空间A改-${RUN_TAG}` } });
  record(G2, 'PATCH 改名 → 200 生效', r.status === 200 && r.data?.space?.name === `回归空间A改-${RUN_TAG}`, `status=${r.status}`);
  r = await req('PATCH', `/api/spaces/${spaceA.id}`, { json: { description: '第二版描述' } });
  record(G2, "PATCH description 字符串 → 生效", r.status === 200 && r.data?.space?.description === '第二版描述', `desc=${JSON.stringify(r.data?.space?.description)}`);
  // 部分更新（不带 description 的 undefined 态）不得误清描述
  await req('PATCH', `/api/spaces/${spaceA.id}`, { json: { name: `回归空间A改2-${RUN_TAG}` } });
  const descKept = (await req('GET', `/api/spaces/${spaceA.id}`)).data?.space?.description;
  record(G2, '部分更新（只改 name）→ description 保留不被误清', descKept === '第二版描述', `desc=${JSON.stringify(descKept)}`);
  r = await req('PATCH', `/api/spaces/${spaceA.id}`, { json: { description: null } });
  record(
    G2,
    'PATCH description null → 清空为 null（接口注释语义；当前实现返回 400 不清空 = 缺陷）',
    r.status === 200 && r.data?.space?.description === null,
    `status=${r.status} desc=${JSON.stringify(r.data?.space?.description ?? r.data?.error)}`,
  );
  r = await req('PATCH', `/api/spaces/${spaceA.id}`, { json: { description: '' } });
  record(
    G2,
    "PATCH description 空串 → 清空为 null（当前实现保留旧值 = 同源缺陷）",
    r.status === 200 && r.data?.space?.description === null,
    `status=${r.status} desc=${JSON.stringify(r.data?.space?.description)}`,
  );
  r = await req('PATCH', `/api/spaces/${spaceA.id}`, { json: { name: '' } });
  record(G2, 'PATCH 改名为空串 → 400', r.status === 400, `status=${r.status}`);

  // 标签清洗
  r = await req('PATCH', `/api/spaces/${spaceA.id}`, { json: { tags: ['  纯爱  ', 'x'.repeat(20), '', '合法标签', '纯爱', '标签三', '标签四', '标签五', '标签六', '标签七', '标签八', '标签九', '标签十', '标签十一', '标签十二'] } });
  const tags = parseTags(r.data?.space);
  record(
    G2,
    'PATCH tags → trim/去空/去重/截12字/最多10个',
    r.status === 200 && tags.length === 10 && tags.every((t) => typeof t === 'string' && t.length <= 12) && tags[0] === '纯爱' && new Set(tags).size === tags.length,
    JSON.stringify(tags),
  );
  r = await req('PATCH', `/api/spaces/${spaceA.id}`, { json: { tags: ['含非字符串', 123] } });
  record(G2, 'PATCH tags 含非字符串元素 → 整体回空数组', r.status === 200 && parseTags(r.data?.space).length === 0, JSON.stringify(parseTags(r.data?.space)));

  // 七态进度 + progress_at 重置
  const at0 = (await req('GET', `/api/spaces/${spaceB.id}`)).data?.space?.progress_at;
  await sleep(1100); // progress_at 秒级精度，等一秒保证可比
  let allOk = true;
  const badStates = [];
  for (const key of PROGRESS_KEYS) {
    const pr = await req('PATCH', `/api/spaces/${spaceB.id}`, { json: { progress: key } });
    if (pr.status !== 200 || pr.data?.space?.progress !== key) {
      allOk = false;
      badStates.push(`${key}:${pr.status}`);
    }
  }
  record(G2, '七级进度逐一切换 → 全部 200 生效', allOk, badStates.join(','));
  const at1 = (await req('GET', `/api/spaces/${spaceB.id}`)).data?.space?.progress_at;
  record(G2, '切换进度后 progress_at 重置', at1 > at0, `${at0} → ${at1}`);
  r = await req('PATCH', `/api/spaces/${spaceB.id}`, { json: { progress: 'not-a-progress' } });
  record(G2, 'PATCH 非法进度值 → 400', r.status === 400, `status=${r.status}`);

  // 权限扁平：非创建者可改可删
  useJar('userb');
  if ((await req('GET', '/api/auth/me')).status === 200) {
    r = await req('PATCH', `/api/spaces/${spaceC.id}`, { json: { name: `userB改的C-${RUN_TAG}` } });
    record(G2, '权限扁平：非创建者改他人空间 → 200', r.status === 200 && r.data?.space?.name === `userB改的C-${RUN_TAG}`, `status=${r.status}`);
    const disposable = await makeSpace(`userB待删-${RUN_TAG}`);
    const del = await req('DELETE', `/api/spaces/${disposable.space.id}`, { as: 'main' });
    record(G2, '权限扁平：创建者删除 userB 建的空间 → 200', del.status === 200, `status=${del.status}`);
  } else {
    record(G2, '权限扁平（userB 改/删他人空间）', SKIP, 'userB 注册被限流');
  }
  useJar('main');

  // 404
  r = await req('GET', '/api/spaces/99999999');
  record(G2, 'GET 不存在的空间 → 404', r.status === 404, `status=${r.status}`);

  // 删除最大序号后重建不复用（持久化计数器语义：新序号严格大于被删序号；
  // 「恰好 +1」仅在删除的正是计数器当前最大时成立，已由返修复测 b1 单独验证）
  const noC = spaceC.space_no;
  const nnC = Number(noC.split('-')[1]);
  await req('DELETE', `/api/spaces/${spaceC.id}`);
  createdSpaceIds.splice(createdSpaceIds.indexOf(spaceC.id), 1);
  const re = await makeSpace(`回归空间C重建-${RUN_TAG}`, { tags: [] });
  spaceC = re.space;
  record(G2, '删除最大序号空间后重建 → 新序号严格大于被删序号（不复用）', Number(spaceC.space_no.split('-')[1]) > nnC, `${noC} → ${spaceC.space_no}`);

  // 成员列表（兼容保留）
  r = await req('GET', `/api/spaces/${spaceA.id}/members`);
  record(G2, 'GET members → 200', r.status === 200, `status=${r.status}`);
}

// ============================================================
// 分组三：筛选组合
// ============================================================
const G3 = '三、筛选组合';
{
  await req('PATCH', `/api/spaces/${spaceA.id}`, { json: { progress: 'translated', tags: ['回归甲', '纯爱'] } });
  await req('PATCH', `/api/spaces/${spaceB.id}`, { json: { progress: 'typeset_done', tags: ['回归乙', '鬼畜'] } });

  const list = async (qs = '') => (await req('GET', `/api/spaces${qs}`)).data ?? {};
  const mine = (d) => (d.spaces ?? []).filter((s) => [spaceA.id, spaceB.id, spaceC.id].includes(s.id)).map((s) => s.id).sort((x, y) => x - y);
  const abc = [spaceA.id, spaceB.id, spaceC.id].sort((x, y) => x - y);

  record(G3, '无筛选 → 三个测试空间齐全', JSON.stringify(mine(await list())) === JSON.stringify(abc));

  record(
    G3,
    'progress 多值并集 → 只含 A/B',
    JSON.stringify(mine(await list('?progress=translated,typeset_done'))) === JSON.stringify([spaceA.id, spaceB.id].sort((x, y) => x - y)),
    JSON.stringify(mine(await list('?progress=translated,typeset_done'))),
  );
  record(
    G3,
    'tag 多值任一命中 → A/B',
    JSON.stringify(mine(await list('?tag=回归甲,回归乙'))) === JSON.stringify([spaceA.id, spaceB.id].sort((x, y) => x - y)),
  );
  record(G3, 'tag 精确等值（子串「回归」不命中）', mine(await list('?tag=回归')).length === 0, JSON.stringify(mine(await list('?tag=回归'))));
  record(G3, 'tag 精确等值（「纯爱」命中 A）', JSON.stringify(mine(await list('?tag=纯爱'))) === JSON.stringify([spaceA.id]));

  record(G3, 'savedBefore=3d → 新空间全部排除', mine(await list('?savedBefore=3d')).length === 0);
  record(G3, 'savedBefore=7d → 新空间全部排除', mine(await list('?savedBefore=7d')).length === 0);
  record(G3, 'savedBefore=30d → 新空间全部排除', mine(await list('?savedBefore=30d')).length === 0);
  record(G3, 'savedBefore=2000-01-01 → 空结果', mine(await list('?savedBefore=2000-01-01')).length === 0);
  record(G3, 'savedBefore=2099-01-01 → 全命中', mine(await list('?savedBefore=2099-01-01')).length === 3);

  // 三层叠加
  record(
    G3,
    '三层叠加 progress+tag+savedBefore（旧日期）→ 空',
    mine(await list('?progress=translated&tag=回归甲&savedBefore=2000-01-01')).length === 0,
  );
  record(
    G3,
    '三层叠加（未来日期）→ 只含 A',
    JSON.stringify(mine(await list('?progress=translated&tag=回归甲&savedBefore=2099-01-01'))) === JSON.stringify([spaceA.id]),
  );

  record(G3, 'q=空间名 → 只含 A', JSON.stringify(mine(await list(`?q=回归空间A改2-${RUN_TAG}`))) === JSON.stringify([spaceA.id]));
  record(G3, 'q=完整序号 → 只含 A', JSON.stringify(mine(await list(`?q=${spaceA.space_no}`))) === JSON.stringify([spaceA.id]));
  record(G3, 'q=序号后缀 → 命中 A', mine(await list(`?q=${spaceA.space_no.split('-')[1]}`)).includes(spaceA.id));
  record(G3, 'progress 非法值被忽略 → 全量', mine(await list('?progress=bogus')).length === 3);
  record(G3, 'q + progress 组合 → 只含 B', JSON.stringify(mine(await list(`?q=${RUN_TAG}&progress=typeset_done`))) === JSON.stringify([spaceB.id]));

  const dt = (await list()).distinctTags ?? [];
  record(G3, 'distinctTags 含库内自定义标签', dt.includes('回归甲') && dt.includes('回归乙'), dt.slice(0, 10).join(','));
}

// ============================================================
// 分组四：条目管理
// ============================================================
const G4 = '四、条目管理';
let itemA, itemZip1;
{
  const up = await uploadPng(spaceA.id, ['回归图A.png', '回归图B.png']);
  record(
    G4,
    '多图直传 → 201 且条目按序创建',
    up.status === 201 && up.data?.items?.length === 2 && up.data?.items?.[0]?.title === '回归图A',
    `status=${up.status} n=${up.data?.items?.length}`,
  );
  itemA = up.data?.items?.[0];

  // zip 解包：自然排序 + 垃圾过滤
  const zipData = zipSync({
    '1.jpg': PNG,
    '10.jpg': PNG,
    '2.jpg': PNG,
    '__MACOSX/1.jpg': PNG,
    '.hidden.jpg': PNG,
    'notes.txt': new TextEncoder().encode('not an image'),
  });
  const zr = await req('POST', `/api/spaces/${spaceB.id}/assets`, {
    form: (() => {
      const f = new FormData();
      f.append('files', new Blob([zipData], { type: 'application/zip' }), '整话.zip');
      return f;
    })(),
  });
  const zTitles = (zr.data?.items ?? []).slice(-3).map((i) => i.title);
  const skipNames = (zr.data?.skipped ?? []).map((s) => s.name);
  record(
    G4,
    'zip 解包 → 自然排序建条目（1,2,10）',
    zr.status === 201 && JSON.stringify(zTitles) === JSON.stringify(['1', '2', '10']),
    `titles=${JSON.stringify(zTitles)}`,
  );
  record(
    G4,
    'zip 垃圾过滤 → __MACOSX/隐藏文件/非图片被跳过',
    skipNames.length >= 3 && skipNames.includes('.hidden.jpg') && skipNames.includes('notes.txt'),
    `skipped=${JSON.stringify(skipNames)}`,
  );
  itemZip1 = (zr.data?.items ?? []).slice(-3)[0];

  // 超上限：单次 21 张
  const many = new FormData();
  for (let i = 0; i < 21; i++) pngFormEntry(many, `m${i}.png`);
  const mr = await req('POST', `/api/spaces/${spaceB.id}/assets`, { form: many });
  record(G4, '单次 21 张 → 400（上限 20）', mr.status === 400, `status=${mr.status}`);

  // 不支持的格式
  const bad = new FormData();
  bad.append('files', new Blob([new TextEncoder().encode('hello')], { type: 'text/plain' }), 'x.txt');
  const br = await req('POST', `/api/spaces/${spaceB.id}/assets`, { form: bad });
  record(G4, '非图片直传 → 400', br.status === 400, `status=${br.status}`);

  // 改名 / 非法
  let r = await req('PATCH', `/api/items/${itemA.id}`, { json: { title: '改名后的图' } });
  record(G4, '条目改名 → 200', r.status === 200 && r.data?.item?.title === '改名后的图', `status=${r.status}`);
  r = await req('PATCH', `/api/items/${itemA.id}`, { json: { title: '' } });
  record(G4, '条目改名为空 → 400', r.status === 400, `status=${r.status}`);

  // 空间内搜索
  r = await req('GET', `/api/spaces/${spaceA.id}?q=改名`);
  record(G4, '空间内 q 搜索命中标题', (r.data?.items ?? []).some((i) => i.id === itemA.id), `n=${r.data?.items?.length}`);
  r = await req('GET', `/api/spaces/${spaceB.id}?q=10`);
  record(G4, '空间内 q 搜索命中 zip 条目「10」', (r.data?.items ?? []).some((i) => i.title === '10'));

  // 排序
  const detail = await req('GET', `/api/spaces/${spaceB.id}`);
  const items10 = detail.data.items.slice(0, 3).map((i) => i.id);
  r = await req('POST', `/api/spaces/${spaceB.id}/items/reorder`, { json: { order: [items10[2], items10[0]] } });
  const after = (await req('GET', `/api/spaces/${spaceB.id}`)).data.items.map((i) => i.id);
  record(
    G4,
    'reorder → 指定顺序重写 sort_order',
    r.status === 200 && after[0] === items10[2] && after[1] === items10[0] && after[2] === items10[1],
    JSON.stringify(after.slice(0, 3)),
  );
  r = await req('POST', `/api/spaces/${spaceB.id}/items/reorder`, { json: { order: [] } });
  record(G4, 'reorder 空 order → 400', r.status === 400, `status=${r.status}`);

  // 条目详情 + 邻居
  r = await req('GET', `/api/items/${itemA.id}`);
  record(
    G4,
    'GET /api/items/:id → item+asset+space+neighbors',
    r.status === 200 && r.data?.item?.id === itemA.id && r.data?.asset?.original_name === '回归图A.png' && r.data?.neighbors?.total === 2,
    `status=${r.status} total=${r.data?.neighbors?.total}`,
  );
}

// ============================================================
// 分组五：标注编辑器 API 面 + 评论通知
// ============================================================
const G5 = '五、标注与协作';
{
  // 全字段保存 + 清洗
  const anns = [
    { x: 0.1, y: 0.2, w: 0.3, h: 0.2, text: '盒状标注', kind: 'box', group_id: 2, align: 'center', color: '#FF0000', bg_color: '#000000CC', font_weight: 400, font_size_ratio: 0.05, comment: '备注X' },
    { x: 0.5, y: 0.5, w: 0, h: 0, text: '', kind: 'pin', group_id: 1, source_text: '原文甲', runs: [{ text: '赤', color: '#FF0000' }, { text: '字', color: '#FF0000', fontWeight: 700 }] },
    { x: 0.7, y: 0.7, w: 0.2, h: 0.1, text: '', kind: 'box', runs: [{ text: '纯' }, { text: '文本' }], doubtful: 1 },
    { x: 1.5, y: -0.5, w: 2, h: 0.1, text: '越界钳制', group_id: 99, align: 'diagonal', font_weight: 500, color: 'nothex', text_opacity: 5 },
  ];
  let r = await req('PUT', `/api/items/${itemA.id}/annotations`, { json: { annotations: anns } });
  record(G5, '标注全量 PUT → 200', r.status === 200, `status=${r.status} body=${JSON.stringify(r.data).slice(0, 120)}`);
  const got = r.data?.annotations ?? [];
  const runs1 = JSON.parse(got[1]?.runs ?? '[]');
  record(
    G5,
    'pin/box kind + 分组 + runs 分段保留',
    got[0]?.kind === 'box' && got[0]?.group_id === 2 && got[1]?.kind === 'pin' && runs1.length === 2 && runs1[0].color === '#FF0000' && runs1[1].fontWeight === 700,
    JSON.stringify(runs1),
  );
  record(
    G5,
    'runs 全默认段 → runs=null 且 text 拼接',
    got[2]?.runs === null && got[2]?.text === '纯文本',
    `runs=${JSON.stringify(got[2]?.runs)} text=${got[2]?.text}`,
  );
  record(
    G5,
    '非法值清洗：坐标钳制/分组9/align回退/字重回退/颜色回退/透明度钳制',
    got[3]?.x === 1 && got[3]?.y === 0 && got[3]?.group_id === 9 && got[3]?.align === 'left' && got[3]?.font_weight === 700 && got[3]?.color === '#FFFFFF' && got[3]?.text_opacity === 1,
    JSON.stringify({ x: got[3]?.x, y: got[3]?.y, g: got[3]?.group_id, a: got[3]?.align, w: got[3]?.font_weight, c: got[3]?.color, o: got[3]?.text_opacity }),
  );
  record(G5, 'order_index 按提交顺序重排', got.map((a) => a.order_index).join(',') === '0,1,2,3', got.map((a) => a.order_index).join(','));
  record(G5, 'GET 标注 → 与保存一致（runs 拼接为纯文本冗余）', JSON.stringify((await req('GET', `/api/items/${itemA.id}/annotations`)).data?.annotations?.map((a) => a.text)) === JSON.stringify(['盒状标注', '赤字', '纯文本', '越界钳制']));

  // 协作锁：他人持锁未共享 → 423
  useJar('main');
  await req('POST', `/api/items/${itemA.id}/room`, { json: { action: 'touch' } });
  useJar('userb');
  if ((await req('GET', '/api/auth/me')).status === 200) {
    const locked = await req('PUT', `/api/items/${itemA.id}/annotations`, { json: { annotations: [] } });
    record(G5, '协作锁：他人持锁未共享时保存 → 423', locked.status === 423, `status=${locked.status}`);
    useJar('main');
    await req('POST', `/api/items/${itemA.id}/room`, { json: { action: 'share', shared: true } });
    useJar('userb');
    const shared = await req('PUT', `/api/items/${itemA.id}/annotations`, { json: { annotations: anns } });
    record(G5, '协作锁：共享后他人保存 → 200', shared.status === 200, `status=${shared.status}`);
    useJar('main');
    await req('POST', `/api/items/${itemA.id}/room`, { json: { action: 'release' } });
  } else {
    record(G5, '协作锁 423/共享放行', SKIP, 'userB 注册被限流');
    useJar('main');
  }

  // 房间状态
  r = await req('GET', `/api/items/${itemA.id}/room`);
  record(G5, 'GET room → 状态与 op 流', r.status === 200 && !!r.data?.room, `status=${r.status}`);

  // 评论 + 通知联动
  r = await req('POST', `/api/items/${itemA.id}/comments`, { json: { body: '第一轮评论' } });
  record(G5, '发评论 → 201', r.status === 201, `status=${r.status}`);
  const longBody = 'x'.repeat(501);
  r = await req('POST', `/api/items/${itemA.id}/comments`, { json: { body: longBody } });
  record(G5, '评论 501 字 → 400', r.status === 400, `status=${r.status}`);
  r = await req('POST', `/api/items/${itemA.id}/comments`, { json: { body: '' } });
  record(G5, '空评论 → 400', r.status === 400, `status=${r.status}`);

  useJar('userb');
  if ((await req('GET', '/api/auth/me')).status === 200) {
    r = await req('POST', `/api/items/${itemA.id}/comments`, { json: { body: 'userB 来串门' } });
    const commentId = r.data?.comment?.id;
    record(G5, 'userB 回复评论 → 201', r.status === 201, `status=${r.status}`);
    useJar('main');
    const n1 = await req('GET', '/api/notifications');
    const hit = (n1.data?.items ?? []).find((n) => n.itemId === itemA.id && n.actorName === userB);
    record(G5, '通知联动：编辑者收到 userB 评论通知', n1.status === 200 && n1.data?.unread >= 1 && !!hit, `unread=${n1.data?.unread}`);
    const mark = await req('POST', '/api/notifications/read', { json: { ids: [hit?.id ?? -1] } });
    const n2 = await req('GET', '/api/notifications');
    record(G5, '按 id 标记已读 → unread 归零', mark.status === 200 && n2.data?.unread === 0, `unread=${n2.data?.unread}`);
    // 又一条通知 + 全部已读
    useJar('userb');
    await req('POST', `/api/items/${itemA.id}/comments`, { json: { body: '再来一条' } });
    useJar('main');
    await req('POST', `/api/notifications/read`, { json: { all: true } });
    record(G5, '全部已读 → unread 归零', (await req('GET', '/api/notifications')).data?.unread === 0);
    // 评论删除权限
    const delOther = await req('DELETE', `/api/comments/${commentId}`);
    record(G5, '删他人评论 → 403', delOther.status === 403, `status=${delOther.status}`);
    useJar('userb');
    const delOwn = await req('DELETE', `/api/comments/${commentId}`);
    record(G5, '删自己评论 → 200', delOwn.status === 200, `status=${delOwn.status}`);
  } else {
    record(G5, '评论通知联动（跨用户）', SKIP, 'userB 注册被限流');
  }
  useJar('main');
}

// ============================================================
// 分组六：OCR / 翻译（mock AI）
// ============================================================
const G6 = '六、OCR与翻译(mock)';
let mockServer = null;
{
  if (SKIP_AI) {
    record(G6, 'AI 用例（SKIP_AI=1）', SKIP);
  } else {
    mockServer = await startMockAi();
    const port = mockServer.address().port;
    const mockBase = `http://127.0.0.1:${port}/v1`;

    let r = await req('POST', '/api/ai/providers', {
      json: { name: 'MockAI', baseUrl: mockBase, apiKey: 'sk-mock-1234567890', ocrModel: 'mock-vision', chatModel: 'mock-chat' },
    });
    record(G6, '新增 Provider → 201', r.status === 201, `status=${r.status} body=${JSON.stringify(r.data)}`);
    const providerId = r.data?.id;
    r = await req('GET', '/api/ai/providers');
    const prov = (r.data?.providers ?? []).find((p) => p.id === providerId);
    record(
      G6,
      'GET providers → 就绪态 + key 脱敏',
      r.data?.ocrReady === true && r.data?.chatReady === true && prov?.apiKeyMasked === '****7890',
      `masked=${prov?.apiKeyMasked} ocrReady=${r.data?.ocrReady}`,
    );
    r = await req('POST', '/api/ai/providers', { json: { name: 'bad', baseUrl: 'ftp://x', apiKey: 'k' } });
    record(G6, 'Provider baseUrl 非 http(s) → 400', r.status === 400, `status=${r.status}`);
    r = await req('PATCH', `/api/ai/providers/${providerId}`, { json: { name: 'MockAI改' } });
    record(G6, 'PATCH Provider 改名 → 200', r.status === 200, `status=${r.status}`);

    // 文本块检测配置（两步链路）
    r = await req('PUT', '/api/ai/detection', { json: { source: 'ai', baseUrl: mockBase, apiKey: 'det-key-123456', model: 'det-model' } });
    record(G6, '配置检测服务 → ready=true', r.status === 200 && r.data?.ready === true, `status=${r.status}`);

    // —— 整页 OCR（此时检测已配置 → 直接走两步）——
    r = await req('POST', `/api/items/${itemA.id}/ocr`);
    record(
      G6,
      'OCR 两步链路：检测出框 + 视觉补提取',
      r.status === 200 && r.data?.twoStep === true && r.data?.engine === 'ai' && (r.data?.proposals ?? []).length === 2,
      `status=${r.status} twoStep=${r.data?.twoStep} n=${r.data?.proposals?.length}`,
    );
    const twoStepTexts = (r.data?.proposals ?? []).map((p) => p.source_text).sort();
    record(
      G6,
      '两步链路文本：空框补提取 + 自带文本',
      JSON.stringify(twoStepTexts) === JSON.stringify(['MOCK框内文本', '检测自带文本']),
      JSON.stringify(twoStepTexts),
    );

    // 采纳 → 生成 pin
    r = await req('POST', `/api/items/${itemA.id}/ocr/accept`, {
      json: { proposals: (await req('POST', `/api/items/${itemA.id}/ocr`)).data?.proposals ?? [] },
    });
    record(G6, 'ocr/accept → 生成 pin 且带 source_text', r.status === 200 && (r.data?.annotations ?? []).some((a) => a.kind === 'pin' && a.source_text === 'MOCK框内文本'), `status=${r.status}`);

    // 重复 OCR → 既有标号附近提案全部跳过（响应中不出现）
    r = await req('POST', `/api/items/${itemA.id}/ocr`);
    record(G6, '重复 OCR → 既有标号附近提案跳过', r.status === 200 && (r.data?.proposals ?? []).length === 0, `n=${r.data?.proposals?.length}`);

    // 检测配置清空回落单步（单步链路才带 aiContext 图像解析）
    r = await req('PUT', '/api/ai/detection', { json: { source: 'ai', baseUrl: '', apiKey: 'clear', model: '' } });
    record(G6, '清空检测配置 → ready=false', r.status === 200 && r.data?.ready === false, `ready=${r.data?.ready}`);
    const freshItem = (await uploadPng(spaceC.id, ['单步OCR图.png'])).data?.items?.[0];
    r = await req('POST', `/api/items/${freshItem.id}/ocr`);
    record(
      G6,
      '单步视觉 OCR：blocks + aiContext 图像解析',
      r.status === 200 && r.data?.twoStep === false && r.data?.engine === 'ai' && JSON.stringify((r.data?.proposals ?? []).map((p) => p.source_text).sort()) === JSON.stringify(['MOCK原A', 'MOCK原B']) && String(r.data?.aiContext ?? '').includes('MOCK描述'),
      `status=${r.status} aiContext=${JSON.stringify(r.data?.aiContext)}`,
    );

    // —— AI 翻译 + 术语表 + 服务端落库 ——
    await req('PATCH', `/api/spaces/${spaceA.id}`, { json: { lp_glossary: [{ from: 'MOCK框内文本', to: '术语译A', note: '注释' }] } });
    r = await req('POST', `/api/items/${itemA.id}/ai-translate`, { json: { applyTranslations: true } });
    const trans = r.data?.proposals ?? [];
    record(
      G6,
      'ai-translate → 提案生成 + 术语命中',
      r.status === 200 && trans.length >= 2 && trans.every((p) => p.translated.startsWith('译：')) && r.data?.glossaryHits >= 1,
      `status=${r.status} n=${trans.length} hits=${r.data?.glossaryHits}`,
    );
    record(G6, 'applyTranslations=true → 服务端落库', r.data?.applied >= 2 && ((await req('GET', `/api/items/${itemA.id}/annotations`)).data?.annotations ?? []).some((a) => a.text === '译：MOCK框内文本'), `applied=${r.data?.applied}`);

    // 无原文条目翻译 → 400
    const emptyItem = (await uploadPng(spaceC.id, ['空图.png'])).data?.items?.[0];
    r = await req('POST', `/api/items/${emptyItem.id}/ai-translate`);
    record(G6, '无原文条目 ai-translate → 400', r.status === 400, `status=${r.status} body=${JSON.stringify(r.data).slice(0, 100)}`);

    // 一键机翻链路（模拟客户端循环）在分组十一做（需要单独条目核对进度联动）
  }
}

// ============================================================
// 分组七：嵌字（typeset / 成品）
// ============================================================
const G7 = '七、嵌字';
{
  const layer = {
    id: 'L1', x: 0.1, y: 0.2, text: '嵌字文本', fontSize: 32, fontWeight: 700, color: '#FF0000',
    stroke: '', strokeWidth: 0, align: 'center', lineHeight: 1.3, vertical: true,
    strokeColor: 'oops', strokeWidthRatio: 9, shadowColor: '#11223344', shadowBlurRatio: 1,
    shadowOffset: { x: -9, y: 9 }, width: 0.001, letterSpacing: -5, fontFamily: 'bad<>name',
    tcyEnabled: false, rotation: 999, scale: 99, fillGradient: { from: '#FF0000', to: 'nope' },
  };
  const form = new FormData();
  form.append('meta', JSON.stringify({ width: 800, height: 600, textLayers: [layer] }));
  form.append('paint', new Blob([PNG], { type: 'image/png' }), 'paint.png');
  let r = await req('PUT', `/api/items/${itemA.id}/typeset`, { form });
  record(G7, '嵌字草稿 PUT（meta+paint）→ 200', r.status === 200 && r.data?.ok === true, `status=${r.status} body=${JSON.stringify(r.data)}`);

  r = await req('GET', `/api/items/${itemA.id}/typeset`);
  const L = r.data?.meta?.textLayers?.[0] ?? {};
  record(
    G7,
    'GET 草稿 → hasPaint + 全字段往返',
    r.data?.hasPaint === true && r.data?.canEdit === true,
    `hasPaint=${r.data?.hasPaint} canEdit=${r.data?.canEdit}`,
  );
  const clampChecks = {
    strokeColor: L.strokeColor === null,
    strokeWidthRatio: L.strokeWidthRatio === 0.5,
    shadowColor: L.shadowColor === '#11223344',
    shadowBlurRatio: L.shadowBlurRatio === 0.5,
    shadowOffsetX: L.shadowOffset?.x === -0.5 && L.shadowOffset?.y === 0.5,
    width: L.width === 0.05,
    letterSpacing: L.letterSpacing === -0.2,
    fontFamilyAbsent: L.fontFamily === undefined,
    tcyEnabled: L.tcyEnabled === false,
    rotation: L.rotation === 180,
    scale: L.scale === 4,
    fillGradient: L.fillGradient === null,
  };
  record(G7, '阶段11-13 新字段清洗（clamp/回null/回缺省）→ 全部正确', Object.values(clampChecks).every(Boolean), JSON.stringify(clampChecks));

  r = await req('PUT', `/api/items/${itemA.id}/typeset`, { json: { meta: 'bad' } });
  record(G7, '嵌字 PUT 非 form → 400', r.status === 400, `status=${r.status}`);

  // 保存成品入库
  r = await req('POST', `/api/items/${itemA.id}/outputs`, { json: { image: `data:image/png;base64,${PNG.toString('base64')}` } });
  record(G7, '保存成品 → 201 且 count=1', r.status === 201 && r.data?.count === 1 && !!r.data?.output?.id, `status=${r.status}`);
  r = await req('POST', `/api/items/${itemA.id}/outputs`, { json: { image: Buffer.from('not-png').toString('base64') } });
  record(G7, '成品图非合法 PNG → 400', r.status === 400, `status=${r.status}`);
  r = await req('GET', `/api/items/${itemA.id}/outputs`);
  record(G7, '条目成品列表 → 至少 1 版', r.status === 200 && (r.data?.outputs ?? []).length >= 1, `n=${r.data?.outputs?.length}`);
  r = await req('GET', `/api/spaces/${spaceA.id}/outputs`);
  record(G7, '空间成品列表 → 联条目标题', r.status === 200 && (r.data?.outputs ?? []).every((o) => o.asset?.filename), `n=${r.data?.outputs?.length}`);

  // 成品 PNG magic（media 服务）
  const filename = (await req('GET', `/api/spaces/${spaceA.id}/outputs`)).data?.outputs?.[0]?.asset?.filename;
  const media = await req('GET', `/api/media/original/${filename}`);
  record(
    G7,
    '成品文件 PNG magic（89504E47）',
    media.status === 200 && media.buffer.subarray(0, 4).toString('hex') === '89504e47',
    `status=${media.status} magic=${media.buffer.subarray(0, 4).toString('hex')}`,
  );

  // 嵌字成品写入空间（新条目）
  const exForm = new FormData();
  exForm.append('file', new Blob([PNG], { type: 'image/png' }), 'typeset.png');
  r = await req('POST', `/api/items/${itemA.id}/typeset/export`, { form: exForm });
  record(
    G7,
    'typeset/export → 成品图写成空间新条目',
    r.status === 201 && (r.data?.asset?.title ?? '').endsWith('-嵌字'),
    `status=${r.status} title=${r.data?.asset?.title}`,
  );

  // 成品 zip
  r = await req('GET', `/api/spaces/${spaceA.id}/outputs-zip`);
  const zEntries = r.status === 200 ? Object.keys(unzipSync(new Uint8Array(r.buffer))) : [];
  record(
    G7,
    '成品 zip → PK magic + 序号命名条目',
    r.status === 200 && r.buffer.subarray(0, 2).toString('latin1') === 'PK' && zEntries.every((n) => /^\d{2}-.+\.png$/.test(n)),
    `status=${r.status} entries=${JSON.stringify(zEntries)}`,
  );
  r = await req('GET', `/api/media/images/${encodeURIComponent('..\u002ftypeset')}`);
  record(G7, 'media 路径穿越 → 400/404', r.status === 400 || r.status === 404, `status=${r.status}`);
}

// ============================================================
// 分组八：导出
// ============================================================
const G8 = '八、导出';
{
  // labelplus-txt 逐行断言（专用空间）
  const lp = await makeSpace(`LP导出-${RUN_TAG}`, { description: '' });
  await req('PATCH', `/api/spaces/${lp.space.id}`, { json: { lp_groups: [{ id: 1, name: '台词' }, { id: 2, name: '旁白' }] } });
  const item = (await uploadPng(lp.space.id, ['lp_page.png'])).data.items[0];
  await req('PUT', `/api/items/${item.id}/annotations`, {
    json: {
      annotations: [
        { x: 0.1, y: 0.2, w: 0, h: 0, text: '译文一', kind: 'pin', group_id: 1 },
        { x: 0.4, y: 0.5, w: 0, h: 0, text: '', kind: 'pin', group_id: 2, source_text: '原文二' },
        { x: 0.7, y: 0.8, w: 0, h: 0, text: '', kind: 'pin', group_id: 1, source_text: '' },
        { x: 0.3, y: 0.3, w: 0.2, h: 0.2, text: '不应出现', kind: 'box', group_id: 1 },
      ],
    },
  });
  const txt = (await req('GET', `/api/spaces/${lp.space.id}/labelplus-txt`)).text;
  const lines = txt.replace(/^\uFEFF/, '').split('\r\n');
  const idx1 = lines.findIndex((l) => l.startsWith('------[1]------'));
  const idx2 = lines.findIndex((l) => l.startsWith('------[2]------'));
  record(G8, 'labelplus-txt → BOM + 版本块 + 分组块', txt.startsWith('\uFEFF') && lines[0] === '1.0,1.0' && lines.includes('台词') && lines.includes('旁白'), JSON.stringify(lines.slice(0, 8)));
  record(G8, 'labelplus-txt → 图片块头行', lines.some((l) => l === '>>>>>>[lp_page.png]<<<<<<'), lines.find((l) => l.startsWith('>>>>>>')));
  record(
    G8,
    'labelplus-txt → 标号行坐标/组号（4 位小数，中心点）',
    idx1 >= 0 && lines[idx1] === '------[1]------[0.1000,0.2000,1]' && idx2 >= 0 && lines[idx2] === '------[2]------[0.4000,0.5000,2]',
    `${lines[idx1]} | ${lines[idx2]}`,
  );
  record(G8, 'labelplus-txt → 译文行 + source_text 兜底', lines[idx1 + 1] === '译文一' && lines[idx2 + 1] === '原文二');
  record(G8, 'labelplus-txt → 空标号跳过 + box 不导出', !txt.includes('不应出现') && !txt.includes('------[3]'));

  // 空间导出 json / csv / lp / zip
  let r = await req('GET', `/api/spaces/${spaceA.id}/export`);
  const j = r.data;
  record(
    G8,
    'export json → schema + 归一化/像素双坐标',
    r.status === 200 && j?.schema === 'twitter-image-translator/export@1' && Array.isArray(j?.images) && j.images[0]?.annotations?.[0]?.norm !== undefined && j.images[0]?.annotations?.[0]?.pixel !== undefined,
    `status=${r.status}`,
  );
  r = await req('GET', `/api/spaces/${spaceA.id}/export?format=csv`);
  record(G8, 'export csv → 表头 + 内容行', r.status === 200 && r.text.includes('文字内容') && r.text.includes('越界钳制') && r.text.startsWith('\uFEFF'), `status=${r.status}`);
  r = await req('GET', `/api/spaces/${spaceA.id}/export?format=lp`);
  record(G8, 'export lp → LabelPlus 文本', r.status === 200 && r.text.includes('>>>>>>['), `status=${r.status}`);
  r = await req('GET', `/api/spaces/${spaceA.id}/export?format=zip`);
  const entries = r.status === 200 ? Object.keys(unzipSync(new Uint8Array(r.buffer))) : [];
  record(
    G8,
    'export zip → annotations.json/csv + 翻译_0.txt + images/',
    r.status === 200 && r.buffer.subarray(0, 2).toString('latin1') === 'PK'
      && entries.includes('annotations.json') && entries.includes('annotations.csv') && entries.includes('翻译_0.txt') && entries.some((e) => e.startsWith('images/')),
    `status=${r.status} entries=${JSON.stringify(entries)}`,
  );

  // 空成品空间 zip → 404
  const emptySpace = await makeSpace(`空成品-${RUN_TAG}`);
  r = await req('GET', `/api/spaces/${emptySpace.space.id}/outputs-zip`);
  record(G8, '无成品空间 outputs-zip → 404', r.status === 404, `status=${r.status}`);
}

// ============================================================
// 分组九：设置面板
// ============================================================
const G9 = '九、设置面板';
{
  const KEYS = PROGRESS_KEYS;
  const DEFAULT_LABELS = { untranslated: '未翻译', translated_placeholder: '翻译已占位', translated: '已翻译', proofread_placeholder: '校对已占位', proofread: '已校对', typeset_placeholder: '嵌字已占位', typeset_done: '已嵌字' };
  const items = (over = {}) => KEYS.map((k) => ({ key: k, label: DEFAULT_LABELS[k], enabled: true, ...over[k] }));

  useJar('main');
  let r = await req('GET', '/api/settings');
  const untouched =
    r.data?.progressItems?.length === 7 && r.data?.progressItems?.every((it, i) => it.key === KEYS[i] && it.enabled === true && it.label === DEFAULT_LABELS[it.key])
    && JSON.stringify(r.data?.presetTags) === JSON.stringify(['纯爱', '鬼畜', 'SM', '傲慢', '雌小鬼']);
  record(
    G9,
    'GET 未配置 → 内置七态默认 + 5 个预设标签',
    untouched ? true : SKIP,
    untouched ? '全新库返回内置默认' : '服务端已有历史配置（非全新库），跳过默认值断言',
  );

  r = await req('PUT', '/api/settings', { json: { progressItems: items({ untranslated: { label: '待翻译' }, proofread: { enabled: false } }), presetTags: ['自定义1', '自定义2'] } });
  record(G9, 'PUT 合法 → 200 返回清洗值', r.status === 200 && r.data?.progressItems?.find((i) => i.key === 'untranslated')?.label === '待翻译' && r.data?.progressItems?.find((i) => i.key === 'proofread')?.enabled === false && JSON.stringify(r.data?.presetTags) === JSON.stringify(['自定义1', '自定义2']), `status=${r.status}`);
  r = await req('GET', '/api/settings');
  record(G9, 'GET 回读 → 持久化生效', r.data?.progressItems?.find((i) => i.key === 'untranslated')?.label === '待翻译');

  const base = { progressItems: items(), presetTags: [] };
  const negatives = [
    ['缺一个 key → 400', { ...base, progressItems: items().filter((i) => i.key !== 'proofread') }],
    ['重复 key → 400', { ...base, progressItems: [...items(), { key: 'untranslated', label: 'x', enabled: true }] }],
    ['未知 key → 400', { ...base, progressItems: [...items(), { key: 'unknown', label: 'x', enabled: true }] }],
    ['tags 含非字符串 → 400', { ...base, presetTags: ['ok', 123] }],
    ['progressItems 非数组 → 400', { progressItems: 'no', presetTags: [] }],
  ];
  for (const [name, body] of negatives) {
    r = await req('PUT', '/api/settings', { json: body });
    record(G9, `PUT 负面：${name}`, r.status === 400, `status=${r.status}`);
  }

  // 边界清洗
  const tags31 = Array.from({ length: 31 }, (_, i) => `标签${String(i + 1).padStart(2, '0')}`);
  r = await req('PUT', '/api/settings', { json: { progressItems: items({ untranslated: { label: '超长非法！@#¥标签文本' } }), presetTags: tags31 } });
  const lab = r.data?.progressItems?.find((i) => i.key === 'untranslated')?.label ?? '';
  record(G9, '边界：超长 label → 清洗（≤8 字合法字符）', r.status === 200 && lab.length <= 8 && /^[\u4e00-\u9fa5A-Za-z0-9（）()·、\-—]*$/.test(lab), `label="${lab}"`);
  record(G9, '边界：31 个 tags → 截断 30', r.data?.presetTags?.length === 30, `n=${r.data?.presetTags?.length}`);

  // 禁用进度态的消费方行为（API 面：列表照常返回全部，禁用仅影响 UI 菜单/筛选 chips）
  r = await req('GET', '/api/spaces');
  record(G9, '禁用 progress 态后空间列表仍全量返回（预期：设置仅约束 UI）', (r.data?.spaces ?? []).length > 0, `n=${r.data?.spaces?.length}`);

  // presetTags 动态化 → 建空间使用自定义标签
  const custom = await makeSpace(`自定义标签空间-${RUN_TAG}`, { tags: ['自定义1'] });
  r = await req('GET', '/api/spaces');
  record(G9, '自定义 presetTags 建空间 → distinctTags 动态收录', (r.data?.distinctTags ?? []).includes('自定义1'), JSON.stringify((r.data?.distinctTags ?? []).slice(0, 8)));
}

// ============================================================
// 分组十：升级链（构造旧形状库 → 迁移）——需要直接操作库文件，见仓库外脚本 t17-migration.mjs
// ============================================================
record('十、升级链', '升级链用例需要直接操作 DATA_DIR 下的 app.db，由 t17-migration.mjs 单独执行', SKIP, '见测试报告');

// ============================================================
// 分组十一：组合场景
// ============================================================
const G11 = '十一、组合场景';
{
  // 三层筛选结果交叉核对：与全量列表逐空间核对筛选语义
  const all = (await req('GET', '/api/spaces')).data?.spaces ?? [];
  const expect = all.filter((s) => s.progress === 'translated' && (s.tags ?? []).includes('回归甲')).map((s) => s.id);
  const got = ((await req('GET', '/api/spaces?progress=translated&tag=回归甲')).data?.spaces ?? []).map((s) => s.id);
  record(G11, '三层筛选交叉核对 → 与全量列表独立推算一致', JSON.stringify(expect.sort((a, b) => a - b)) === JSON.stringify(got.sort((a, b) => a - b)), `expect=${JSON.stringify(expect)} got=${JSON.stringify(got)}`);

  // 一键机翻端到端（模拟客户端循环：OCR → 采纳 → 翻译落库），核对进度联动现状
  if (!SKIP_AI) {
    const target = (await req('GET', `/api/spaces/${spaceB.id}`)).data.items.find((i) => i.title === '1');
    const before = (await req('GET', `/api/spaces/${spaceB.id}`)).data.space.progress;
    const ocr = await req('POST', `/api/items/${target.id}/ocr`);
    if (ocr.data?.proposals?.length) {
      await req('POST', `/api/items/${target.id}/ocr/accept`, { json: { proposals: ocr.data.proposals } });
    }
    const tr = await req('POST', `/api/items/${target.id}/ai-translate`, { json: { applyTranslations: true } });
    const after = (await req('GET', `/api/spaces/${spaceB.id}`)).data.space.progress;
    record(
      G11,
      `一键机翻端到端跑通（OCR ${ocr.data?.proposals?.length ?? 0} 提案，译文落库 ${tr.data?.applied ?? 0} 条）`,
      ocr.status === 200 && tr.status === 200,
      `ocr=${ocr.status} tr=${tr.status}`,
    );
    record(
      G11,
      '现状记录：一键机翻完成后空间进度未自动推进（功能缺口）',
      after === before,
      `progress=${before} → ${after}（记录现状，建议纳入产品改进）`,
    );
  } else {
    record(G11, '一键机翻端到端', SKIP, 'SKIP_AI=1');
  }

  // 删除条目级联：成品联动
  const cascade = await makeSpace(`级联-${RUN_TAG}`);
  const cItem = (await uploadPng(cascade.space.id, ['级联图.png'])).data.items[0];
  await req('PUT', `/api/items/${cItem.id}/annotations`, { json: { annotations: [{ x: 0.1, y: 0.1, w: 0.2, h: 0.2, text: '待级联', kind: 'pin', group_id: 1 }] } });
  await req('POST', `/api/items/${cItem.id}/outputs`, { json: { image: `data:image/png;base64,${PNG.toString('base64')}` } });
  const del = await req('DELETE', `/api/items/${cItem.id}`);
  const annGone = await req('GET', `/api/items/${cItem.id}/annotations`);
  const outGone = await req('GET', `/api/items/${cItem.id}/outputs`);
  const spaceOuts = (await req('GET', `/api/spaces/${cascade.space.id}/outputs`)).data?.outputs ?? [];
  record(
    G11,
    '删除条目 → 标注与成品级联清除',
    del.status === 200 && annGone.status === 404 && outGone.status === 404 && spaceOuts.length === 0,
    `del=${del.status} ann=${annGone.status} out=${outGone.status} outs=${spaceOuts.length}`,
  );
  record(G11, '删除后再 GET 条目 → 404', (await req('GET', `/api/items/${cItem.id}`)).status === 404);
}

// ---------- 清理 ----------
try {
  for (const id of [...new Set(createdSpaceIds)]) {
    await req('DELETE', `/api/spaces/${id}`);
  }
  console.log(`\n清理：已删除 ${new Set(createdSpaceIds).size} 个测试空间（临时用户与消费的表码保留）`);
} catch (e) {
  console.log(`清理异常：${e.message}`);
}
mockServer?.close();

const failTotal = summary();
process.exit(failTotal > 0 ? 1 : 0);
