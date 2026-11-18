// 通用小工具：JSON 响应、正文读取、文本处理、域名拆分、速率限制。
export function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...extraHeaders },
  });
}
export const err = (status, message) => json({ ok: false, error: message }, status);

export async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

export function clientIp(request) {
  return request.headers.get('CF-Connecting-IP') || 'unknown';
}

const MAX_BODY_CHARS = 100_000; // 正文存储上限，超出截断
export function truncateBody(s, isHtml = false) {
  if (!s || s.length <= MAX_BODY_CHARS) return s || '';
  const cut = s.slice(0, MAX_BODY_CHARS);
  return isHtml ? `${cut}\n<!-- 正文过长，已截断 -->` : `${cut}\n\n［正文过长，已截断］`;
}

export function htmlToText(html) {
  return String(html || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .trim();
}

export function domOf(addr) {
  const i = String(addr || '').lastIndexOf('@');
  return i < 0 ? '' : String(addr).slice(i + 1).toLowerCase();
}
export function prefixOf(addr) {
  const i = String(addr || '').lastIndexOf('@');
  return i < 0 ? '' : String(addr).slice(0, i).toLowerCase();
}

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const PREFIX_RE = /^[a-z0-9][a-z0-9._-]{0,30}$/;
export const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

// 发件黑名单匹配：条目是完整邮箱 → 等值；以 @ 开头 → 发件域名后缀匹配
export function matchesBlacklist(fromAddr, patterns) {
  const from = String(fromAddr || '').toLowerCase();
  if (!from) return false;
  const dom = domOf(from);
  for (const p of patterns || []) {
    if (p.startsWith('@')) {
      if (dom && (dom === p.slice(1) || dom.endsWith(p))) return true;
    } else if (from === p) {
      return true;
    }
  }
  return false;
}

// ---------- 速率限制（D1 rate_limits 表；只在失败/发码时写，平时零写） ----------
const DAY_MS = 24 * 3600 * 1000;

export async function rateLocked(db, key) {
  try {
    const row = await db.prepare('SELECT lock_until FROM rate_limits WHERE key = ?').bind(key).first();
    return row ? Math.max(0, Number(row.lock_until || 0) - Date.now()) : 0;
  } catch {
    return 0;
  }
}

export async function rateFail(db, key, maxFails, lockMs) {
  const now = Date.now();
  // 单条原子 SQL（对抗复读 C-7）：窗口判断（24 小时过期归零）、+1、按新 count 定锁
  // 全部在一条 INSERT ... ON CONFLICT ... DO UPDATE 里由数据库完成——旧写法先 SELECT
  // 再算再写，并发请求会同时读到同一个旧 count 一起过门、落库互相覆盖，计数被放大/丢失。
  const stmt = db
    .prepare(
      `INSERT INTO rate_limits (key, count, lock_until, updated_at)
       VALUES (?, 1, CASE WHEN 1 >= ? THEN ? ELSE 0 END, ?)
       ON CONFLICT(key) DO UPDATE SET
         count = (CASE WHEN excluded.updated_at - rate_limits.updated_at < ? THEN rate_limits.count ELSE 0 END) + 1,
         lock_until = CASE WHEN ((CASE WHEN excluded.updated_at - rate_limits.updated_at < ? THEN rate_limits.count ELSE 0 END) + 1) >= ?
                               THEN excluded.updated_at + ? ELSE 0 END,
         updated_at = excluded.updated_at
       RETURNING count`
    )
    .bind(key, maxFails, now + lockMs, now, DAY_MS, DAY_MS, maxFails, lockMs);
  // RETURNING 取本条自增后的 count（D1 对 RETURNING 语句用 first()/all() 取行）；
  // 万一某环境 first() 取不到行，只回退到读一次现值——绝不重跑写语句防双记。
  let row = null;
  try {
    row = await stmt.first();
  } catch {
    await stmt.run().catch(() => {});
  }
  if (row && row.count !== undefined) return Number(row.count);
  const after = await db.prepare('SELECT count FROM rate_limits WHERE key = ?').bind(key).first().catch(() => null);
  return Number(after?.count || 0);
}

export async function rateClear(db, key) {
  await db.prepare('DELETE FROM rate_limits WHERE key = ?').bind(key).run().catch(() => {});
}

// 计数型限额（发信配额用）：看窗口内已用数 / 记一次。用同一张 rate_limits 表、
// 不同键名，与失败锁定互不干扰。ratePeek 是只读查看；rateBump 与 rateFail 一样是
// 单条原子自增（C-7），并发下不丢计数。发信侧仍是「先 peek 判上限、再 bump」的
// 防滥用闸，极端并发下个位数溢出可接受（不是安全边界）。
export async function ratePeek(db, key, windowMs) {
  try {
    const row = await db.prepare('SELECT count, updated_at FROM rate_limits WHERE key = ?').bind(key).first();
    if (!row) return 0;
    return Date.now() - Number(row.updated_at || 0) < windowMs ? Number(row.count || 0) : 0;
  } catch {
    return 0;
  }
}

export async function rateBump(db, key, windowMs) {
  const now = Date.now();
  await db
    .prepare(
      `INSERT INTO rate_limits (key, count, lock_until, updated_at) VALUES (?, 1, 0, ?)
       ON CONFLICT(key) DO UPDATE SET
         count = (CASE WHEN excluded.updated_at - rate_limits.updated_at < ? THEN rate_limits.count ELSE 0 END) + 1,
         lock_until = 0, updated_at = excluded.updated_at`
    )
    .bind(key, now, windowMs)
    .run()
    .catch(() => {});
}
