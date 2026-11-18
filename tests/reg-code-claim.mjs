// ym-mail 注册验证码原子 claim 定向测试（node tests/reg-code-claim.mjs，需要 Node ≥ 22.5）
// 覆盖 Chief 审计 #5：验证码 5 次尝试上限必须在并发下也封顶——
// 20 个并发错码请求里恰好 5 个得到「验证码不对」、其余得到「验证码已失效」，
// attempts 落库恰好 5；满 5 次后连正确码也拒；未满时正确码照常注册成功。
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
globalThis.fetch = async () => { throw new Error('test: unexpected fetch'); };

const { handleApi } = await import(join(root, 'src/api.js'));
const { hashPassword, sha256Hex } = await import(join(root, 'src/auth.js'));

let pass = 0, failN = 0;
const chk = (name, cond, extra = '') => { if (cond) { pass++; console.log('PASS', name); } else { failN++; console.log('FAIL', name, extra); } };

async function api(path, body) {
  const req = new Request('http://local' + path, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const resp = await handleApi(req, env, new URL('http://local' + path));
  const j = await resp.json().catch(() => ({}));
  return { status: resp.status, j };
}
const msgOf = (r) => (r.j && (r.j.error?.message || r.j.message)) || JSON.stringify(r.j);

// 先播种一个站长（让后续注册走非首注的验证码门）
const pwHash = await hashPassword('password-123');
db.prepare('INSERT INTO users (username, email, pw_hash, is_owner, created_at) VALUES (?, ?, ?, 1, ?)')
  .run('owner', 'owner@example.com', pwHash, Date.now());

async function seedCode(email, code) {
  db.prepare('DELETE FROM reg_codes WHERE email = ?').run(email);
  db.prepare('INSERT INTO reg_codes (email, code_hash, ip, attempts, expires_at, created_at) VALUES (?, ?, ?, 0, ?, ?)')
    .run(email, await sha256Hex(code), '1.2.3.4', Date.now() + 600_000, Date.now());
}
const attemptsOf = (email) => db.prepare('SELECT attempts FROM reg_codes WHERE email = ?').get(email)?.attempts;

// ── 并发错码：20 个同时猜，只许 5 个过门 ──
await seedCode('victim@example.com', '123456');
const N = 20;
const results = await Promise.all(
  Array.from({ length: N }, (_, i) =>
    api('/api/auth/register', { username: 'guess' + i, password: 'password-123', email: 'victim@example.com', code: '000000' }))
);
const wrong = results.filter(r => msgOf(r).includes('验证码不对')).length;
const dead = results.filter(r => msgOf(r).includes('验证码已失效')).length;
chk(`并发 ${N} 个错码：恰好 5 个「验证码不对」`, wrong === 5, `wrong=${wrong} dead=${dead}`);
chk(`并发 ${N} 个错码：其余 ${N - 5} 个「验证码已失效」`, dead === N - 5, `wrong=${wrong} dead=${dead}`);
chk('并发后 attempts 落库恰好 5', attemptsOf('victim@example.com') === 5, `attempts=${attemptsOf('victim@example.com')}`);

// ── 满 5 次后正确码也拒 ──
const rCorrect = await api('/api/auth/register', { username: 'lateone', password: 'password-123', email: 'victim@example.com', code: '123456' });
chk('满 5 次后正确码也被拒（已失效）', msgOf(rCorrect).includes('验证码已失效'), msgOf(rCorrect));

// ── 未满时：错 2 次 + 正确码 → 注册成功 ──
await seedCode('newbie@example.com', '654321');
await api('/api/auth/register', { username: 'nb1', password: 'password-123', email: 'newbie@example.com', code: '111111' });
await api('/api/auth/register', { username: 'nb2', password: 'password-123', email: 'newbie@example.com', code: '222222' });
const rOk = await api('/api/auth/register', { username: 'newbie', password: 'password-123', email: 'newbie@example.com', code: '654321' });
chk('错 2 次后正确码注册成功（200）', rOk.status === 200, `status=${rOk.status} ${msgOf(rOk)}`);
const u = db.prepare('SELECT id FROM users WHERE username = ?').get('newbie');
chk('新用户已落库', !!u);

console.log(`\nTOTAL pass=${pass} fail=${failN}`);
process.exit(failN ? 1 : 0);
