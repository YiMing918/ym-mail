// ym-mail 对抗复读修复定向测试 · 收信部分（node tests/sweep-fixes-recv.mjs，需要 Node ≥ 22.5）
// 覆盖：C-8 认领瞬间新邮件掉公开池（收信后对账补正）、
//       C-14 收信侧软闸（同地址每小时上限 / 未认领地址总存量上限，超限静默丢弃）。
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// 替身钩子：邮件 INSERT 真正执行前先触发回调，用来模拟「快照读完、邮件落库前地址刚被认领」。
let onMailInsert = null;
class D1Shim {
  constructor(db) { this.db = db; }
  prepare(sql) {
    const self = this;
    return {
      _sql: sql, _binds: [],
      bind(...args) { this._binds = args; return this; },
      async run() {
        if (onMailInsert && /INSERT INTO mails/i.test(sql)) { const h = onMailInsert; onMailInsert = null; h(self.db); }
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
const env = { DB: shim };
const worker = (await import(join(root, 'src/index.js'))).default;

let pass = 0, failN = 0;
const chk = (name, cond, extra = '') => { if (cond) { pass++; console.log('PASS', name); } else { failN++; console.log('FAIL', name, extra); } };

// 播种（第一次收信前：config 有进程内缓存）
db.prepare("INSERT INTO policies (domain, created_at) VALUES ('test.dev', ?)").run(Date.now());
const userId = Number(db.prepare("INSERT INTO users (username, email, pw_hash, created_at) VALUES ('racer', 'racer@example.com', 'x', ?)").run(Date.now()).lastInsertRowid);

function makeMessage(to) {
  const rawText = `From: Sender <s@example.com>\r\nTo: ${to}\r\nSubject: hello\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nbody text 123456\r\n`;
  const msg = {
    to, from: 's@example.com', rejected: null,
    raw: new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(rawText)); c.close(); } }),
    setReject(r) { this.rejected = r; },
    async forward() {},
  };
  return msg;
}
const ctx = { waitUntil() {} };
const mailCount = (addr) => db.prepare('SELECT COUNT(*) AS c FROM mails WHERE to_addr = ?').get(addr).c;
const seedMails = (addr, n, at) => {
  const stmt = db.prepare("INSERT INTO mails (to_addr, owner_id, from_addr, subject, text_body, html_body, attachments, received_at) VALUES (?, NULL, 'f@x.com', 's', '', '', '[]', ?)");
  for (let i = 0; i < n; i++) stmt.run(addr, at);
};

// ═══ C-8：快照为未认领、落库前刚被认领 → 这封信要补正归属 ═══
{
  db.prepare("INSERT INTO addresses (address, domain, prefix, kind, owner_id, created_at) VALUES ('race@test.dev', 'test.dev', 'race', 'random', NULL, ?)").run(Date.now());
  onMailInsert = (rawDb) => { rawDb.prepare("UPDATE addresses SET owner_id = ? WHERE address = 'race@test.dev'").run(userId); };
  const msg = makeMessage('race@test.dev');
  await worker.email(msg, env, ctx);
  const row = db.prepare("SELECT owner_id FROM mails WHERE to_addr = 'race@test.dev'").get();
  chk('C-8 竞态新邮件归属补正给认领者（不掉公开池）', row?.owner_id === userId, `owner=${row?.owner_id}`);
}

// ═══ C-14：收信软闸 ═══
{
  // 同地址每小时上限（默认 100）：已存 100 封近一小时的，再来一封静默丢弃
  seedMails('flood@test.dev', 100, Date.now());
  const m1 = makeMessage('flood@test.dev');
  await worker.email(m1, env, ctx);
  chk('C-14 同地址一小时满 100 封后新信被丢弃', mailCount('flood@test.dev') === 100, `count=${mailCount('flood@test.dev')}`);
  chk('C-14 超限丢弃不打扰发信方（不 setReject）', m1.rejected === null, `rejected=${m1.rejected}`);

  // 未认领地址总存量上限（默认 500）：存量是两天前的（不触发小时闸，只触发总量闸）
  seedMails('stuffed@test.dev', 500, Date.now() - 2 * 24 * 3600_000);
  const m2 = makeMessage('stuffed@test.dev');
  await worker.email(m2, env, ctx);
  chk('C-14 未认领地址总存量满 500 后新信被丢弃', mailCount('stuffed@test.dev') === 500, `count=${mailCount('stuffed@test.dev')}`);
  chk('C-14 总量超限同样不 setReject', m2.rejected === null, `rejected=${m2.rejected}`);

  // 正常地址照常收
  const m3 = makeMessage('ok@test.dev');
  await worker.email(m3, env, ctx);
  chk('C-14 正常地址照常收信', mailCount('ok@test.dev') === 1 && m3.rejected === null, `count=${mailCount('ok@test.dev')}`);
}

console.log(`\nTOTAL pass=${pass} fail=${failN}`);
process.exit(failN ? 1 : 0);
