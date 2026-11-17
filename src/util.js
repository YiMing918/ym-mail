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
  const row = await db
    .prepare('SELECT count, updated_at FROM rate_limits WHERE key = ?')
    .bind(key)
    .first()
    .catch(() => null);
  // 计数窗口 24 小时，过期自动归零
  let count = row && now - Number(row.updated_at || 0) < DAY_MS ? Number(row.count || 0) : 0;
  count += 1;
  const lockUntil = count >= maxFails ? now + lockMs : 0;
  await db
    .prepare(
      `INSERT INTO rate_limits (key, count, lock_until, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET count = excluded.count, lock_until = excluded.lock_until, updated_at = excluded.updated_at`
    )
    .bind(key, count, lockUntil, now)
    .run();
  return count;
}

export async function rateClear(db, key) {
  await db.prepare('DELETE FROM rate_limits WHERE key = ?').bind(key).run().catch(() => {});
}

// 计数型限额（发信配额用）：看窗口内已用数 / 记一次。用同一张 rate_limits 表、
// 不同键名，与失败锁定互不干扰。读后写、非强原子（与 rateFail 同口径）——
// 发信配额是防滥用闸不是安全边界，并发下个位数溢出可接受。
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
  const cur = await ratePeek(db, key, windowMs);
  await db
    .prepare(
      `INSERT INTO rate_limits (key, count, lock_until, updated_at) VALUES (?, ?, 0, ?)
       ON CONFLICT(key) DO UPDATE SET count = excluded.count, lock_until = 0, updated_at = excluded.updated_at`
    )
    .bind(key, cur + 1, now)
    .run()
    .catch(() => {});
}
