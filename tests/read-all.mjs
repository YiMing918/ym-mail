// ym-mail 回归测试：「全部已读」POST /api/mails/read-all（node tests/read-all.mjs，需要 Node ≥ 22.5）
// 2026-11-27 逐按钮实测发现：read-all 的 UPDATE 语句用了带 m. 别名前缀的
// visFrag 片段、语句本身却没有别名，D1 直接报 no such column，自上线起
// 点一次错一次（游客、登录用户都中招）。本测试钉住修复后的行为：
// 游客只标自己的（owner_id IS NULL）、登录用户只标自己的、scope 只标该地址。
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

class D1Shim {
  constructor(db) { this.db = db; }
  prepare(sql) {
    const self = this;
    return {
      _sql: sql, _binds: [],
      bind(...args) { this._binds = args; return this; },
      async run() {
        const info = self.db.prepare(sql).run(...this._binds);
        return { success: true, meta: { changes: info.changes, last_row_id: Number(info.lastInsertRowid) } };
      },
      async first() { return self.db.prepare(sql).get(...this._binds) ?? null; },
      async all() { const rows = self.db.prepare(sql).all(...this._binds); return { results: rows, success: true, meta: {} }; },
    };
  }
  async batch(stmts) {
    const out = [];
    for (const s of stmts) out.push(/^\s*select/i.test(s._sql) ? await s.all() : await s.run());
    return out;
  }
}

const db = new DatabaseSync(':memory:');
db.exec(readFileSync(join(root, 'schema.sql'), 'utf8'));
const shim = new D1Shim(db);

const { handleApi } = await import(join(root, 'src/api.js'));
const { hashPassword } = await import(join(root, 'src/auth.js'));

const pwHash = await hashPassword('password-123');
const env = { DB: shim, RESEND_API_KEY: 'test-key' };
globalThis.fetch = async () => { throw new Error('test: unexpected fetch'); };

let pass = 0, failN = 0;
const chk = (name, cond, extra = '') => { if (cond) { pass++; console.log('PASS', name); } else { failN++; console.log('FAIL', name, extra); } };

async function api(path, { method = 'POST', body, cookie } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (cookie) headers.cookie = cookie;
  const req = new Request('http://local' + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  const resp = await handleApi(req, env, new URL('http://local' + path));
  const j = await resp.clone().json().catch(() => ({}));
  return { status: resp.status, j, headers: resp.headers };
}

// ── 播种（第一次 handleApi 之前，config 有进程内缓存） ──
db.prepare(`INSERT INTO policies (domain, is_main, u_open, u_custom, u_random, u_del, u_refund, u_minlen, g_open, g_custom, g_random, g_del, g_refund, g_minlen, created_at)
            VALUES ('test.dev', 1, 1, 5, 5, 1, 1, 3, 1, -1, -1, 1, 0, 5, ?)`).run(Date.now());
const uid = Number(db.prepare('INSERT INTO users (username, email, pw_hash, is_owner, bonus, created_at) VALUES (?, ?, ?, 0, 0, ?)').run('reader', 'reader@example.com', pwHash, Date.now()).lastInsertRowid);
const mkMail = (to, owner, read = 0) => db.prepare('INSERT INTO mails (to_addr, owner_id, from_addr, subject, is_read, received_at) VALUES (?, ?, ?, ?, ?, ?)').run(to, owner, 'a@b.c', 'hi', read, Date.now());
mkMail('guest1@test.dev', null); mkMail('guest1@test.dev', null);
mkMail('mine@test.dev', uid); mkMail('mine@test.dev', uid); mkMail('other@test.dev', uid);
const unread = (where, ...b) => db.prepare(`SELECT COUNT(*) AS c FROM mails WHERE is_read = 0 AND ${where}`).get(...b).c;

// ── 游客全部已读：只动游客的信 ──
{
  const r = await api('/api/mails/read-all', { body: { scope: 'all' } });
  chk('游客 read-all 返回 200', r.status === 200, `status=${r.status} ${JSON.stringify(r.j)}`);
  chk('游客的信全标已读', unread('owner_id IS NULL') === 0);
  chk('登录用户的信没被动', unread('owner_id = ?', uid) === 3);
}
// ── 登录用户按 scope 全部已读：只动该地址 ──
{
  const login = await api('/api/auth/login', { body: { username: 'reader', password: 'password-123' } });
  const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
  chk('测试账号登录成功', !!cookie && login.status === 200, `status=${login.status}`);
  const r = await api('/api/mails/read-all', { body: { scope: 'mine@test.dev' }, cookie });
  chk('用户 read-all(scope) 返回 200', r.status === 200, `status=${r.status} ${JSON.stringify(r.j)}`);
  chk('scope 内已全标已读', unread("owner_id = ? AND to_addr = 'mine@test.dev'", uid) === 0);
  chk('scope 外仍未读', unread("owner_id = ? AND to_addr = 'other@test.dev'", uid) === 1);
}

console.log(`\nTOTAL pass=${pass} fail=${failN}`);
process.exit(failN ? 1 : 0);
