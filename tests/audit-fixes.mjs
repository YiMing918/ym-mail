// ym-mail 审计修复测试（node tests/audit-fixes.mjs，需要 Node ≥ 22.5 内置 node:sqlite）
// 验：① 首账号并发注册原子化（两个并发首注只能成一个站长）
//     ② /api/send 按用户限速（普通用户每小时 20 封触顶 429，站长豁免）
// D1 用 node:sqlite 内存库替身（执行 schema.sql 真 SQL），Resend 用 fetch 打桩。
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

const env = { DB: new D1Shim(db), RESEND_API_KEY: 'test-key', ADMIN_USER: 'admin', ADMIN_PASSWORD_HASH: 'unused' };
globalThis.fetch = async (url) => {
  if (String(url).includes('api.resend.com')) return new Response(JSON.stringify({ id: 'stub' }), { status: 200, headers: { 'content-type': 'application/json' } });
  throw new Error('test: unexpected fetch ' + url);
};

const { handleApi } = await import(join(root, 'src/api.js'));
const { hashPassword } = await import(join(root, 'src/auth.js'));

let pass = 0, failN = 0;
const chk = (name, cond, extra = '') => { if (cond) { pass++; console.log('PASS', name); } else { failN++; console.log('FAIL', name, extra); } };

async function api(path, { method = 'POST', body, cookie } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (cookie) headers.cookie = cookie;
  const req = new Request('http://local' + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  const resp = await handleApi(req, env, new URL('http://local' + path));
  return resp;
}
const cookieOf = (resp) => (resp.headers.get('set-cookie') || '').split(';')[0];

// ── 1. 并发首注：两个请求同时注册，只能成一个站长 ──
const mkReg = (u, e) => api('/api/auth/register', { body: { username: u, password: 'password-123', email: e } });
const [ra, rb] = await Promise.all([mkReg('alice', 'alice@example.com'), mkReg('bob', 'bob@example.com')]);
const statuses = [ra.status, rb.status].sort((x, y) => x - y);
chk('并发首注：一个 200 一个 409', statuses[0] === 200 && statuses[1] === 409, `statuses=${statuses}`);
const userCount = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
const ownerCount = db.prepare('SELECT COUNT(*) AS c FROM users WHERE is_owner = 1').get().c;
chk('并发首注：库里恰好 1 个用户、1 个站长', userCount === 1 && ownerCount === 1, `users=${userCount} owners=${ownerCount}`);

// ── 2. 发信限速 ──
// 普通用户直接播种（绕开邮箱验证码注册门，只测发信路径）
const pwHash = await hashPassword('password-123');
const u2 = db.prepare('INSERT INTO users (username, email, pw_hash, is_owner, created_at) VALUES (?, ?, ?, 0, ?)').run('carol', 'carol@example.com', pwHash, Date.now());
const carolId = Number(u2.lastInsertRowid);
db.prepare("INSERT INTO addresses (address, domain, prefix, kind, owner_id, created_at) VALUES ('carol@test.dev', 'test.dev', 'carol', 'custom', ?, ?)").run(carolId, Date.now());
const owner = db.prepare('SELECT id FROM users WHERE is_owner = 1').get();
db.prepare("INSERT INTO addresses (address, domain, prefix, kind, owner_id, created_at) VALUES ('boss@test.dev', 'test.dev', 'boss', 'custom', ?, ?)").run(owner.id, Date.now());

let resp = await api('/api/auth/login', { body: { username: 'carol', password: 'password-123' } });
chk('普通用户登录', resp.status === 200, `status=${resp.status}`);
const carolCookie = cookieOf(resp);
let okCount = 0, lastStatus = 0;
for (let i = 0; i < 21; i++) {
  resp = await api('/api/send', { body: { from: 'carol@test.dev', to: 'someone@example.net', subject: 'hi ' + i, text: 'body' }, cookie: carolCookie });
  lastStatus = resp.status;
  if (resp.status === 200) okCount++;
}
chk('普通用户 20 封放行、第 21 封 429', okCount === 20 && lastStatus === 429, `ok=${okCount} last=${lastStatus}`);

resp = await api('/api/auth/login', { body: { username: db.prepare('SELECT username FROM users WHERE is_owner = 1').get().username, password: 'password-123' } });
const bossCookie = cookieOf(resp);
let bossOk = 0;
for (let i = 0; i < 21; i++) {
  resp = await api('/api/send', { body: { from: 'boss@test.dev', to: 'someone@example.net', subject: 'boss ' + i, text: 'body' }, cookie: bossCookie });
  if (resp.status === 200) bossOk++;
}
chk('站长豁免：连发 21 封全放行', bossOk === 21, `ok=${bossOk}`);

console.log(`\nTOTAL pass=${pass} fail=${failN}`);
process.exit(failN ? 1 : 0);
