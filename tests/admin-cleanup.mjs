// ym-mail C-M3 补覆盖：后台接口 + 定时清理（node tests/admin-cleanup.mjs，需要 Node ≥ 22.5）
// 背景：全量复审 C-M3 指出 src/admin.js 与 src/index.js 的 scheduled() 清理
// 没有用例——这两处都是「删数据」性质的代码，改坏了不报错、只会删错，
// 必须有测试网兜底。本文件用 node:sqlite 内存库执行真 schema + 真 SQL：
//   A. scheduled() 游客过期 / 用户保留天数（星标豁免、0=不删、站长上限封顶）
//   B. scheduled() 闲置随机地址清理（已认领不删 = 审计 M1 回归、自定义不删）
//   C. scheduled() 过期注册码 / 会话清理
//   D. 后台接口：未登录 401、登录、设置校验（越界回 400）、域名增删、
//      unused/delete 只删「从未用过的未认领地址」
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

const { hashPassword } = await import(join(root, 'src/auth.js'));
const { handleAdminApi } = await import(join(root, 'src/admin.js'));
const worker = (await import(join(root, 'src/index.js'))).default;

const adminHash = await hashPassword('admin-pass-123');
const pwHash = await hashPassword('password-123');
const env = { DB: shim, ADMIN_USER: 'admin', ADMIN_PASSWORD_HASH: adminHash };
globalThis.fetch = async () => { throw new Error('test: unexpected fetch'); };

let pass = 0, failN = 0;
const chk = (name, cond, extra = '') => { if (cond) { pass++; console.log('PASS', name); } else { failN++; console.log('FAIL', name, extra); } };

const DAY = 24 * 3600 * 1000;
const now = Date.now();
const ago = (d) => now - d * DAY;

// ── 播种（必须在第一次 loadConfig 之前） ──
db.prepare("UPDATE settings SET value = '7' WHERE key = 'guest_days'").run();
db.prepare("UPDATE settings SET value = '0' WHERE key = 'user_cap'").run(); // 0 = 不限
db.prepare("UPDATE settings SET value = '7' WHERE key = 'idle_days'").run();

const mkUser = (username, retention) =>
  Number(db.prepare('INSERT INTO users (username, email, pw_hash, retention_days, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(username, username + '@example.com', pwHash, retention, now).lastInsertRowid);
const uWeek = mkUser('u_week', 7);   // 自选 7 天
const uNever = mkUser('u_never', 0); // 自选永不删
const uMonth = mkUser('u_month', 30);

const mkMail = ({ to = 'someone@test.dev', owner = null, daysAgo = 0, starred = 0, attach = false }) => {
  const id = Number(db.prepare('INSERT INTO mails (to_addr, owner_id, is_starred, received_at) VALUES (?, ?, ?, ?)')
    .run(to, owner, starred, ago(daysAgo)).lastInsertRowid);
  if (attach) db.prepare('INSERT INTO attachments (mail_id, idx, data) VALUES (?, 0, ?)').run(id, 'AAAA');
  return id;
};
const mailExists = (id) => !!db.prepare('SELECT id FROM mails WHERE id = ?').get(id);
const attachExists = (id) => !!db.prepare('SELECT mail_id FROM attachments WHERE mail_id = ?').get(id);

// ═══ A. scheduled() 邮件过期 ═══
const mGuestOld = mkMail({ daysAgo: 8, attach: true });
const mGuestNew = mkMail({ daysAgo: 1 });
const mGuestStar = mkMail({ daysAgo: 8, starred: 1 });       // 游客无星标豁免
const mWeekOld = mkMail({ owner: uWeek, daysAgo: 8 });
const mWeekStar = mkMail({ owner: uWeek, daysAgo: 8, starred: 1 });
const mWeekNew = mkMail({ owner: uWeek, daysAgo: 1 });
const mNeverOld = mkMail({ owner: uNever, daysAgo: 400 });
const mMonthOld = mkMail({ owner: uMonth, daysAgo: 31 });
const mMonthIn = mkMail({ owner: uMonth, daysAgo: 29 });

await worker.scheduled({}, env, {});
chk('A 游客 8 天前邮件被删', !mailExists(mGuestOld));
chk('A 被删游客邮件的附件一起删', !attachExists(mGuestOld));
chk('A 游客 1 天前邮件保留', mailExists(mGuestNew));
chk('A 游客星标邮件照删（无豁免）', !mailExists(mGuestStar));
chk('A 用户自选 7 天：8 天前未星标被删', !mailExists(mWeekOld));
chk('A 用户星标邮件豁免保留', mailExists(mWeekStar));
chk('A 用户 1 天前邮件保留', mailExists(mWeekNew));
chk('A 自选永不删（上限不限）：400 天前保留', mailExists(mNeverOld));
chk('A 自选 30 天：31 天前被删', !mailExists(mMonthOld));
chk('A 自选 30 天：29 天前保留', mailExists(mMonthIn));

// 站长上限封顶：user_cap=30 后，自选 0 的按 30 天算
db.prepare("UPDATE settings SET value = '30' WHERE key = 'user_cap'").run();
const mNever31 = mkMail({ owner: uNever, daysAgo: 31 });
const mNever29 = mkMail({ owner: uNever, daysAgo: 29 });
await worker.scheduled({}, env, {});
chk('A 上限 30 天：自选永不删的用户 31 天前被删', !mailExists(mNever31));
chk('A 上限 30 天：29 天前保留', mailExists(mNever29));
chk('A 上限封顶不误伤星标豁免', mailExists(mWeekStar));
db.prepare("UPDATE settings SET value = '0' WHERE key = 'user_cap'").run();

// ═══ B. scheduled() 闲置随机地址 ═══
const mkAddr = ({ address, kind = 'random', owner = null, lastMailDaysAgo = null, createdDaysAgo = 1 }) =>
  db.prepare('INSERT INTO addresses (address, domain, prefix, kind, owner_id, created_at, last_mail_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(address, 'test.dev', address.split('@')[0], kind, owner, ago(createdDaysAgo), lastMailDaysAgo === null ? 0 : ago(lastMailDaysAgo));
mkAddr({ address: 'idle-old@test.dev', lastMailDaysAgo: 8 });
mkAddr({ address: 'idle-never@test.dev', createdDaysAgo: 8 });            // 从没收到信，按建立时间算
mkAddr({ address: 'idle-fresh@test.dev', lastMailDaysAgo: 1 });
mkAddr({ address: 'idle-claimed@test.dev', owner: uWeek, lastMailDaysAgo: 8 }); // 已认领：M1 回归，绝不能删
mkAddr({ address: 'idle-custom@test.dev', kind: 'custom', lastMailDaysAgo: 8 });
const mIdleMail = mkMail({ to: 'idle-old@test.dev', daysAgo: 8 });
const addrExists = (a) => !!db.prepare('SELECT address FROM addresses WHERE address = ?').get(a);

await worker.scheduled({}, env, {});
chk('B 闲置 8 天随机地址被删', !addrExists('idle-old@test.dev'));
chk('B 闲置地址的信一起删', !mailExists(mIdleMail));
chk('B 从没收到信的闲置随机地址按建立时间删', !addrExists('idle-never@test.dev'));
chk('B 1 天前用过的随机地址保留', addrExists('idle-fresh@test.dev'));
chk('B 已认领随机地址闲置也不删（M1 回归）', addrExists('idle-claimed@test.dev'));
chk('B 自定义地址不被闲置清理', addrExists('idle-custom@test.dev'));

// ═══ C. scheduled() 过期注册码 / 会话 ═══
db.prepare('INSERT INTO reg_codes (email, code_hash, expires_at, created_at) VALUES (?, ?, ?, ?)').run('a@x.com', 'h', ago(1), ago(2));
db.prepare('INSERT INTO reg_codes (email, code_hash, expires_at, created_at) VALUES (?, ?, ?, ?)').run('b@x.com', 'h', now + DAY, now);
db.prepare('INSERT INTO sessions (token_hash, user_id, is_admin, created_at, expires_at) VALUES (?, NULL, 1, ?, ?)').run('tok-old', ago(2), ago(1));
db.prepare('INSERT INTO sessions (token_hash, user_id, is_admin, created_at, expires_at) VALUES (?, NULL, 1, ?, ?)').run('tok-new', now, now + DAY);
await worker.scheduled({}, env, {});
chk('C 过期注册码被删', !db.prepare("SELECT id FROM reg_codes WHERE email = 'a@x.com'").get());
chk('C 未过期注册码保留', !!db.prepare("SELECT id FROM reg_codes WHERE email = 'b@x.com'").get());
chk('C 过期会话被删', !db.prepare("SELECT token_hash FROM sessions WHERE token_hash = 'tok-old'").get());
chk('C 未过期会话保留', !!db.prepare("SELECT token_hash FROM sessions WHERE token_hash = 'tok-new'").get());

// ═══ D. 后台接口 ═══
async function adminApi(path, { method = 'POST', body, cookie } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (cookie) headers.cookie = cookie;
  const req = new Request('http://local' + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  const resp = await handleAdminApi(req, env, new URL('http://local' + path));
  const j = await resp.json().catch(() => ({}));
  return { status: resp.status, j, headers: resp.headers };
}

{
  const noAuth = await adminApi('/api/admin/settings', { body: { guest_days: 3 } });
  chk('D 未登录调后台设置回 401', noAuth.status === 401, `status=${noAuth.status}`);

  const wrong = await adminApi('/api/admin/login', { body: { username: 'admin', password: 'wrong-password' } });
  chk('D 管理员密码错误回 401', wrong.status === 401, `status=${wrong.status}`);

  const okLogin = await adminApi('/api/admin/login', { body: { username: 'admin', password: 'admin-pass-123' } });
  const cookie = (okLogin.headers.get('set-cookie') || '').split(';')[0];
  chk('D 管理员登录成功并下发会话 Cookie', okLogin.status === 200 && !!cookie, `status=${okLogin.status}`);

  const badLow = await adminApi('/api/admin/settings', { body: { guest_days: -1 }, cookie });
  chk('D 设置 guest_days=-1 回 400', badLow.status === 400, `status=${badLow.status}`);
  const badHigh = await adminApi('/api/admin/settings', { body: { guest_days: 4000 }, cookie });
  chk('D 设置 guest_days=4000 回 400', badHigh.status === 400, `status=${badHigh.status}`);
  const badBonus = await adminApi('/api/admin/settings', { body: { ref_bonus_n: 1001 }, cookie });
  chk('D 设置 ref_bonus_n=1001 回 400', badBonus.status === 400, `status=${badBonus.status}`);
  const badFrom = await adminApi('/api/admin/settings', { body: { mail_from: 'not-an-email' }, cookie });
  chk('D 设置 mail_from 格式不对回 400', badFrom.status === 400, `status=${badFrom.status}`);
  const okSet = await adminApi('/api/admin/settings', { body: { guest_days: 30 }, cookie });
  const saved = db.prepare("SELECT value FROM settings WHERE key = 'guest_days'").get();
  chk('D 设置 guest_days=30 保存成功', okSet.status === 200 && saved?.value === '30', `status=${okSet.status} value=${saved?.value}`);
  db.prepare("UPDATE settings SET value = '7' WHERE key = 'guest_days'").run();

  const badDom = await adminApi('/api/admin/domains', { body: { domain: 'not a domain' }, cookie });
  chk('D 添加非法域名回 400', badDom.status === 400, `status=${badDom.status}`);
  const okDom = await adminApi('/api/admin/domains', { body: { domain: 'new.dev' }, cookie });
  chk('D 添加新域名成功', okDom.status === 200, `status=${okDom.status} ${JSON.stringify(okDom.j)}`);
  const dupDom = await adminApi('/api/admin/domains', { body: { domain: 'new.dev' }, cookie });
  chk('D 重复添加域名回 400', dupDom.status === 400, `status=${dupDom.status}`);

  // unused/delete：只删「未认领 + 从未收过信 + 建了超过 30 分钟」的地址
  const HOUR = 3600 * 1000;
  const mkAddr2 = (address, { owner = null, createdAgoMs, withMail = false }) => {
    db.prepare('INSERT INTO addresses (address, domain, prefix, kind, owner_id, created_at, last_mail_at) VALUES (?, ?, ?, ?, ?, ?, 0)')
      .run(address, 'test.dev', address.split('@')[0], 'random', owner, Date.now() - createdAgoMs);
    if (withMail) mkMail({ to: address, daysAgo: 0 });
  };
  mkAddr2('unused-old@test.dev', { createdAgoMs: 2 * HOUR });
  mkAddr2('unused-fresh@test.dev', { createdAgoMs: 10 * 60 * 1000 });
  mkAddr2('unused-claimed@test.dev', { owner: uWeek, createdAgoMs: 2 * HOUR });
  mkAddr2('unused-mailed@test.dev', { createdAgoMs: 2 * HOUR, withMail: true });
  const del = await adminApi('/api/admin/unused/delete', { body: {}, cookie });
  chk('D unused/delete 只删掉 1 个', del.status === 200 && del.j.deleted === 1, `status=${del.status} deleted=${del.j.deleted}`);
  chk('D unused/delete 删的是闲置未用地址', !addrExists('unused-old@test.dev'));
  chk('D unused/delete 保留刚建的地址', addrExists('unused-fresh@test.dev'));
  chk('D unused/delete 保留已认领地址', addrExists('unused-claimed@test.dev'));
  chk('D unused/delete 保留收到过信的地址', addrExists('unused-mailed@test.dev'));
}

console.log(`\nTOTAL pass=${pass} fail=${failN}`);
process.exit(failN ? 1 : 0);
