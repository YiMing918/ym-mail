// ym-mail 对抗复读修复定向测试 · API/工具部分（node tests/sweep-fixes-api.mjs，需要 Node ≥ 22.5）
// 覆盖：C-2 附件 SVG 存储型 XSS、C-3 认领竞态、C-7 限流原子计数、
//       C-13 游客建址 IP 上限、C-37 注册限速+枚举合并+邀请码 8 位、
//       C-38 登录计时差、C-39 sanitize 正则漏网。
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// 带「会合屏障」的 D1 替身：可让两个并发请求的同一条查询在同一时刻一起放行，
// 确定性制造竞态窗口（认领竞态测试用）。
let barrier = null;
function armBarrier(n = 2) {
  let arrived = 0;
  let release;
  const p = new Promise((r) => (release = r));
  barrier = {
    arrive: async () => {
      arrived++;
      if (arrived >= n) { release(); barrier = null; }
      await p;
    },
  };
}
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
      async first() {
        if (barrier && sql.includes('FROM addresses WHERE address')) await barrier.arrive();
        return self.db.prepare(sql).get(...this._binds) ?? null;
      },
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
const { handleAdminApi } = await import(join(root, 'src/admin.js'));
const { hashPassword, randomCodePrefix } = await import(join(root, 'src/auth.js'));
const { rateFail, rateBump, ratePeek, rateLocked } = await import(join(root, 'src/util.js'));
const { sanitizeHtml } = await import(join(root, 'src/sanitize.js'));

const pwHash = await hashPassword('password-123');
const adminHash = await hashPassword('admin-pass-123');
const env = { DB: shim, RESEND_API_KEY: 'test-key', ADMIN_USER: 'admin', ADMIN_PASSWORD_HASH: adminHash };
globalThis.fetch = async () => { throw new Error('test: unexpected fetch'); };

let pass = 0, failN = 0;
const chk = (name, cond, extra = '') => { if (cond) { pass++; console.log('PASS', name); } else { failN++; console.log('FAIL', name, extra); } };
const msgOf = (r) => (typeof r.j?.error === 'string' ? r.j.error : JSON.stringify(r.j || {}));

async function api(path, { method = 'POST', body, cookie, ip } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (cookie) headers.cookie = cookie;
  if (ip) headers['CF-Connecting-IP'] = ip;
  const req = new Request('http://local' + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  const resp = await handleApi(req, env, new URL('http://local' + path));
  const j = await resp.clone().json().catch(() => ({}));
  return { status: resp.status, j, headers: resp.headers, resp };
}
async function adminApi(path, { body, ip } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (ip) headers['CF-Connecting-IP'] = ip;
  const req = new Request('http://local' + path, { method: 'POST', headers, body: JSON.stringify(body) });
  const resp = await handleAdminApi(req, env, new URL('http://local' + path));
  const j = await resp.json().catch(() => ({}));
  return { status: resp.status, j };
}
const cookieOf = (r) => (r.headers.get('set-cookie') || '').split(';')[0];

// ── 播种（必须在第一次 handleApi 之前：config 有 60 秒进程内缓存） ──
db.prepare("UPDATE settings SET value = 'invite' WHERE key = 'reg_mode'").run();
db.prepare(`INSERT INTO policies (domain, is_main, u_open, u_custom, u_random, u_del, u_refund, u_minlen, g_open, g_custom, g_random, g_del, g_refund, g_minlen, created_at)
            VALUES ('test.dev', 1, 1, 5, 5, 1, 1, 3, 1, -1, -1, 1, 0, 5, ?)`).run(Date.now());
const mkUser = (username, email, { owner = 0, bonus = 0 } = {}) =>
  Number(db.prepare('INSERT INTO users (username, email, pw_hash, is_owner, bonus, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(username, email, pwHash, owner, bonus, Date.now()).lastInsertRowid);
const bossId = mkUser('bossman', 'boss@example.com', { owner: 1 });
mkUser('timer', 'timer@example.com');
const login = async (u) => cookieOf(await api('/api/auth/login', { body: { username: u, password: 'password-123' } }));

// ═══ C-7：限流计数原子性 ═══
{
  const counts = await Promise.all(Array.from({ length: 20 }, () => rateFail(shim, 't:fail', 1000, 60_000)));
  const row = db.prepare("SELECT count FROM rate_limits WHERE key = 't:fail'").get();
  chk('C-7 并发 20 次 rateFail 落库 count=20', row?.count === 20, `count=${row?.count}`);
  chk('C-7 并发 rateFail 返回值恰好 1..20 各一', [...counts].sort((a, b) => a - b).every((v, i) => v === i + 1), `counts=${counts}`);
  await Promise.all(Array.from({ length: 20 }, () => rateBump(shim, 't:bump', 3600_000)));
  chk('C-7 并发 20 次 rateBump 后 ratePeek=20', (await ratePeek(shim, 't:bump', 3600_000)) === 20, `peek=${await ratePeek(shim, 't:bump', 3600_000)}`);
  // 锁定语义不变：满 5 次上锁；窗口过期归零
  for (let i = 0; i < 5; i++) await rateFail(shim, 't:lock', 5, 10 * 60_000);
  chk('C-7 满 5 次失败后被锁', (await rateLocked(shim, 't:lock')) > 0);
  db.prepare("INSERT INTO rate_limits (key, count, lock_until, updated_at) VALUES ('t:old', 99, 0, ?)").run(Date.now() - 25 * 3600_000);
  const c = await rateFail(shim, 't:old', 5, 60_000);
  chk('C-7 24 小时窗口过期后计数归零重记为 1', c === 1, `count=${c}`);
}

// ═══ C-39：sanitize 漏网 ═══
{
  const unquoted = sanitizeHtml('<a href=javascript:alert(1)>x</a>');
  chk('C-39 无引号 javascript: 被中和', !/javascript:/i.test(unquoted), unquoted);
  const entity = sanitizeHtml('<a href="&#106;avascript:alert(1)">x</a>');
  chk('C-39 实体编码 javascript: 被中和', !/javascript:/i.test(entity) && !/&#106;/.test(entity), entity);
  const entityHex = sanitizeHtml("<a href='&#x6a;avascript:alert(1)'>x</a>");
  chk('C-39 十六进制实体 javascript: 被中和', !/javascript:/i.test(entityHex) && !/&#x6a;/i.test(entityHex), entityHex);
  const unquotedData = sanitizeHtml('<a href=data:text/html;base64,PHNjcmlwdD4=>x</a>');
  chk('C-39 无引号 data:text/html 被中和', !/data:text\/html/i.test(unquotedData), unquotedData);
  const legit = sanitizeHtml('<a href="https://example.com/x">ok</a>');
  chk('C-39 正常链接不误伤', legit.includes('https://example.com/x'), legit);
  const legitUq = sanitizeHtml('<a href=https://example.com/x>ok</a>');
  chk('C-39 无引号正常链接不误伤', legitUq.includes('https://example.com/x'), legitUq);
}

// ═══ C-2：附件 SVG 存储型 XSS ═══
{
  const ins = db.prepare(`INSERT INTO mails (to_addr, owner_id, from_addr, subject, text_body, html_body, attachments, received_at)
                          VALUES ('victim@test.dev', NULL, 'evil@example.com', 'x', '', '', '[]', ?)`).run(Date.now());
  const mailId = Number(ins.lastInsertRowid);
  const svgData = btoa('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>');
  const pngData = btoa('\x89PNG\r\n\x1a\nfakepng');
  db.prepare('INSERT INTO attachments (mail_id, idx, filename, mime, data) VALUES (?, 0, ?, ?, ?)').run(mailId, 'evil.svg', 'image/svg+xml', svgData);
  db.prepare('INSERT INTO attachments (mail_id, idx, filename, mime, data) VALUES (?, 1, ?, ?, ?)').run(mailId, 'pic.png', 'image/png', pngData);
  const svg = await api(`/api/mails/${mailId}/att/0?inline=1`, { method: 'GET' });
  chk('C-2 SVG 带 inline=1 也不内联（强制 attachment）', (svg.headers.get('content-disposition') || '').startsWith('attachment'), svg.headers.get('content-disposition'));
  chk('C-2 SVG 响应带 CSP sandbox', /sandbox/.test(svg.headers.get('content-security-policy') || ''), svg.headers.get('content-security-policy'));
  chk('C-2 SVG 响应带 nosniff', svg.headers.get('x-content-type-options') === 'nosniff');
  const png = await api(`/api/mails/${mailId}/att/1?inline=1`, { method: 'GET' });
  chk('C-2 位图 PNG 照常 inline 预览', (png.headers.get('content-disposition') || '').startsWith('inline') && (png.headers.get('content-type') || '').includes('image/png'),
    `${png.headers.get('content-disposition')} / ${png.headers.get('content-type')}`);
  chk('C-2 位图响应同样带 nosniff', png.headers.get('x-content-type-options') === 'nosniff');
}

// ═══ C-3：认领竞态 ═══
{
  // 场景 A：普通认领竞态（无专属额度）
  const a1 = mkUser('claima1', 'claima1@example.com');
  const a2 = mkUser('claima2', 'claima2@example.com');
  db.prepare("INSERT INTO addresses (address, domain, prefix, kind, owner_id, created_at) VALUES ('shared@test.dev', 'test.dev', 'shared', 'custom', NULL, ?)").run(Date.now());
  const mA = db.prepare("INSERT INTO mails (to_addr, owner_id, from_addr, subject, text_body, html_body, attachments, received_at) VALUES ('shared@test.dev', NULL, 's@x.com', 'hi', '', '', '[]', ?)").run(Date.now());
  const ckA1 = await login('claima1'); const ckA2 = await login('claima2');
  armBarrier(2);
  const [rA1, rA2] = await Promise.all([
    api('/api/addresses', { body: { address: 'shared@test.dev', kind: 'custom' }, cookie: ckA1 }),
    api('/api/addresses', { body: { address: 'shared@test.dev', kind: 'custom' }, cookie: ckA2 }),
  ]);
  const winsA = [rA1, rA2].filter((r) => r.status === 200);
  const losesA = [rA1, rA2].filter((r) => r.status !== 200);
  chk('C-3 竞态认领恰好一人成功', winsA.length === 1 && losesA.length === 1, `statuses=${rA1.status},${rA2.status}`);
  chk('C-3 败者收到「已被认领」类错误', losesA.length === 1 && /已被.*认领|已被别人/.test(msgOf(losesA[0])), msgOf(losesA[0] || {}));
  const winnerA = rA1.status === 200 ? a1 : a2;
  const addrA = db.prepare("SELECT owner_id FROM addresses WHERE address = 'shared@test.dev'").get();
  const mailA = db.prepare('SELECT owner_id FROM mails WHERE id = ?').get(Number(mA.lastInsertRowid));
  chk('C-3 地址与历史邮件只归胜者', addrA?.owner_id === winnerA && mailA?.owner_id === winnerA, `addr=${addrA?.owner_id} mail=${mailA?.owner_id} winner=${winnerA}`);

  // 场景 B：政策额度已满、靠专属额度认领——败者不得扣额度、不得迁移邮件
  const b1 = mkUser('claimb1', 'claimb1@example.com', { bonus: 1 });
  const b2 = mkUser('claimb2', 'claimb2@example.com', { bonus: 1 });
  for (const [uid, tag] of [[b1, 'b1'], [b2, 'b2']]) {
    for (let i = 0; i < 5; i++) {
      db.prepare("INSERT INTO addresses (address, domain, prefix, kind, owner_id, created_at) VALUES (?, 'test.dev', ?, 'custom', ?, ?)").run(`${tag}x${i}@test.dev`, `${tag}x${i}`, uid, Date.now());
    }
  }
  db.prepare("INSERT INTO addresses (address, domain, prefix, kind, owner_id, created_at) VALUES ('sharedb@test.dev', 'test.dev', 'sharedb', 'custom', NULL, ?)").run(Date.now());
  const mB = db.prepare("INSERT INTO mails (to_addr, owner_id, from_addr, subject, text_body, html_body, attachments, received_at) VALUES ('sharedb@test.dev', NULL, 's@x.com', 'hi', '', '', '[]', ?)").run(Date.now());
  const ckB1 = await login('claimb1'); const ckB2 = await login('claimb2');
  armBarrier(2);
  const [rB1, rB2] = await Promise.all([
    api('/api/addresses', { body: { address: 'sharedb@test.dev', kind: 'custom' }, cookie: ckB1 }),
    api('/api/addresses', { body: { address: 'sharedb@test.dev', kind: 'custom' }, cookie: ckB2 }),
  ]);
  const winsB = [rB1, rB2].filter((r) => r.status === 200);
  chk('C-3 专属额度竞态认领恰好一人成功', winsB.length === 1, `statuses=${rB1.status},${rB2.status} ${msgOf(rB1)} ${msgOf(rB2)}`);
  const winnerB = rB1.status === 200 ? b1 : b2;
  const loserB = rB1.status === 200 ? b2 : b1;
  const bonusW = db.prepare('SELECT bonus FROM users WHERE id = ?').get(winnerB)?.bonus;
  const bonusL = db.prepare('SELECT bonus FROM users WHERE id = ?').get(loserB)?.bonus;
  chk('C-3 胜者扣 1 专属额度、败者不扣', bonusW === 0 && bonusL === 1, `winnerBonus=${bonusW} loserBonus=${bonusL}`);
  const mailB = db.prepare('SELECT owner_id FROM mails WHERE id = ?').get(Number(mB.lastInsertRowid));
  chk('C-3 邮件只迁移给胜者', mailB?.owner_id === winnerB, `mail=${mailB?.owner_id} winner=${winnerB}`);
}

// ═══ C-13：游客建址 IP 上限（每小时 20） ═══
{
  const ip = '5.5.5.5';
  let okN = 0;
  for (let i = 0; i < 20; i++) {
    const r = await api('/api/guest/address', { body: {}, ip });
    if (r.status === 200) okN++;
  }
  chk('C-13 同 IP 一小时建 20 个放行', okN === 20, `ok=${okN}`);
  const over = await api('/api/guest/address', { body: {}, ip });
  chk('C-13 第 21 个被限（429+明确文案）', over.status === 429 && /频繁|上限|太多/.test(msgOf(over)), `status=${over.status} ${msgOf(over)}`);
  const otherIp = await api('/api/guest/address', { body: {}, ip: '6.6.6.6' });
  chk('C-13 换 IP 不受牵连', otherIp.status === 200, `status=${otherIp.status}`);
}

// ═══ C-37：注册限速 + 枚举合并 + 邀请码 8 位 ═══
{
  const dupU = await api('/api/auth/register', { body: { username: 'bossman', password: 'password-123', email: 'someone@example.com', invite: 'YM-XXXXXXX1' } });
  const dupE = await api('/api/auth/register', { body: { username: 'brandnew1', password: 'password-123', email: 'boss@example.com', invite: 'YM-XXXXXXX1' } });
  chk('C-37 账号名重复与邮箱重复回同一句文案', msgOf(dupU) === '账号名或邮箱已被注册' && msgOf(dupE) === '账号名或邮箱已被注册', `U=${msgOf(dupU)} E=${msgOf(dupE)}`);

  // 旧 5 位系统码照常可用（查表校验不依赖长度）
  db.prepare('INSERT INTO invites (code, left_uses, created_at) VALUES (?, 1, ?)').run('YM-OLD55', Date.now());
  const okReg = await api('/api/auth/register', { body: { username: 'oldcodeuser', password: 'password-123', email: 'oldcode@example.com', invite: 'YM-OLD55' } });
  chk('C-37 旧 5 位邀请码仍可注册', okReg.status === 200, `status=${okReg.status} ${msgOf(okReg)}`);
  const boot = await api('/api/bootstrap', { method: 'GET', cookie: cookieOf(okReg) });
  chk('C-37 新生成的个人邀请码是 YM-+8 位', /^YM-[A-Z2-9]{8}$/.test(boot.j?.user?.invite_code || ''), `code=${boot.j?.user?.invite_code}`);
  chk('C-37 系统批量码生成函数也是 8 位', /^YM-[A-Z2-9]{8}$/.test(randomCodePrefix()), randomCodePrefix());

  // 错邀请码多次 → 按 IP 锁定
  const ip = '9.9.9.9';
  let last = null;
  for (let i = 0; i < 10; i++) {
    last = await api('/api/auth/register', { body: { username: 'guessr' + i, password: 'password-123', email: `guessr${i}@example.com`, invite: 'YM-WRONGXXX' }, ip });
  }
  chk('C-37 前 10 次错邀请码回 400', last.status === 400, `status=${last.status} ${msgOf(last)}`);
  const locked = await api('/api/auth/register', { body: { username: 'guessrX', password: 'password-123', email: 'guessrx@example.com', invite: 'YM-WRONGXXX' }, ip });
  chk('C-37 第 11 次注册尝试被限速 429', locked.status === 429, `status=${locked.status} ${msgOf(locked)}`);
}

// ═══ C-38：登录计时差 ═══
{
  const t = async (fn) => { const s = performance.now(); const r = await fn(); return { r, ms: performance.now() - s }; };
  const wrong = await t(() => api('/api/auth/login', { body: { username: 'timer', password: 'wrong-password' } }));
  const ghost = await t(() => api('/api/auth/login', { body: { username: 'no_such_user_zzz', password: 'wrong-password' } }));
  chk('C-38 不存在用户与错密码同为 401 同文案', wrong.r.status === 401 && ghost.r.status === 401 && msgOf(wrong.r) === msgOf(ghost.r));
  chk('C-38 不存在用户也跑密码校验（耗时拉平）', ghost.ms >= wrong.ms * 0.5, `ghost=${ghost.ms.toFixed(1)}ms wrong=${wrong.ms.toFixed(1)}ms`);
  const aWrong = await t(() => adminApi('/api/admin/login', { body: { username: 'admin', password: 'wrong-password' }, ip: '7.7.7.1' }));
  const aGhost = await t(() => adminApi('/api/admin/login', { body: { username: 'no_such_admin', password: 'wrong-password' }, ip: '7.7.7.2' }));
  chk('C-38 管理员登录不存在账号也跑密码校验', aGhost.ms >= aWrong.ms * 0.5, `ghost=${aGhost.ms.toFixed(1)}ms wrong=${aWrong.ms.toFixed(1)}ms`);
}

console.log(`\nTOTAL pass=${pass} fail=${failN}`);
process.exit(failN ? 1 : 0);
