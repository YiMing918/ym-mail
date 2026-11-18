// 密码与会话安全（佲的邮箱 · 正式版）
// - 密码：PBKDF2-SHA256 100k 迭代，存储格式 pbkdf2$<迭代>$<盐 b64>$<哈希 b64>
//   （与单用户版 auth.js 同格式，scripts/hash-password.mjs 直接 import 本文件生成）
// - 会话：随机 token + SHA-256 哈希存 D1 sessions 表（不用 KV、不用签名密钥），
//   登出/过期即删行失效，比签名 token 更适合多用户（可强制下线）。

const PBKDF2_ITERATIONS = 100_000;
export const USER_COOKIE = 'ymm_session';
export const ADMIN_COOKIE = 'ymm_admin';

// ---------- base64 工具 ----------
function bytesToB64(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
function b64ToBytes(b64) {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
export function bytesToB64Url(bytes) {
  return bytesToB64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
const enc = new TextEncoder();

// ---------- 密码哈希 ----------
export async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    key,
    256
  );
  return `pbkdf2$${PBKDF2_ITERATIONS}$${bytesToB64(salt)}$${bytesToB64(new Uint8Array(bits))}`;
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export async function verifyPassword(password, stored) {
  try {
    const parts = String(stored || '').split('$');
    if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false;
    const iterations = Number(parts[1]);
    const salt = b64ToBytes(parts[2]);
    const expected = b64ToBytes(parts[3]);
    const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
      key,
      expected.length * 8
    );
    return timingSafeEqual(new Uint8Array(bits), expected);
  } catch {
    return false;
  }
}

// ---------- 哈希 / 随机 ----------
export async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function randomToken() {
  return bytesToB64Url(crypto.getRandomValues(new Uint8Array(32)));
}

export function randomDigits(n) {
  const bytes = crypto.getRandomValues(new Uint8Array(n));
  let s = '';
  for (const b of bytes) s += String(b % 10);
  return s;
}

export function randomCodePrefix() {
  // 邀请码随机部分 8 位（对抗复读 C-37，原 5 位）；校验一律查表不看长度，
  // 以前发出的 5 位旧码照常可用，这里只改新生成的码。
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  let s = 'YM-';
  for (const b of bytes) s += chars[b % chars.length];
  return s;
}

// 假哈希（对抗复读 C-38）：登录时账号不存在也要对它跑一次 verifyPassword，
// 把「用户不存在」的响应耗时拉平到和「密码错」一样，堵计时侧信道枚举。
// 格式与真实哈希一致（PBKDF2 100k、16 字节盐、32 字节哈希，全零填充），
// 任何密码对它校验都必然不通过。
export const DUMMY_PW_HASH = 'pbkdf2$100000$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

const RND_WORDS = ['mail', 'hi', 'go', 'me', 'vip', 'lab', 'box', 'one', 'sky', 'pro'];
const RND_CHARS = 'abcdefghjkmnpqrstuvwxyz23456789';
export function randomAddressPrefix() {
  const bytes = crypto.getRandomValues(new Uint8Array(5));
  let suf = '';
  for (let i = 0; i < 4; i++) suf += RND_CHARS[bytes[i] % RND_CHARS.length];
  return `${RND_WORDS[bytes[4] % RND_WORDS.length]}-${suf}`;
}

// ---------- Cookie ----------
export function readCookie(request, name) {
  const header = request.headers.get('Cookie') || '';
  for (const part of header.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) return rest.join('=');
  }
  return null;
}

export function sessionCookie(name, token, ttlSec) {
  return `${name}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${ttlSec}`;
}

export function clearCookie(name) {
  return `${name}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

// ---------- D1 会话 ----------
// 会话有效期 30 天。登录时写一行，校验时按 token 哈希查一行（D1 读额度充裕），
// 命中且未过期才有效；顺手把过期行删掉（低频写）。
const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;

export async function createDbSession(db, { userId = null, isAdmin = false }) {
  const token = randomToken();
  const tokenHash = await sha256Hex(token);
  const now = Date.now();
  await db
    .prepare('INSERT INTO sessions (token_hash, user_id, is_admin, created_at, expires_at) VALUES (?, ?, ?, ?, ?)')
    .bind(tokenHash, userId, isAdmin ? 1 : 0, now, now + SESSION_TTL_MS)
    .run();
  return { token, ttlSec: Math.floor(SESSION_TTL_MS / 1000) };
}

export async function getDbSession(db, request, cookieName) {
  const token = readCookie(request, cookieName);
  if (!token) return null;
  const tokenHash = await sha256Hex(token);
  const row = await db
    .prepare('SELECT token_hash, user_id, is_admin, expires_at FROM sessions WHERE token_hash = ?')
    .bind(tokenHash)
    .first();
  if (!row) return null;
  if (row.expires_at <= Date.now()) {
    await db.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(tokenHash).run().catch(() => {});
    return null;
  }
  return row;
}

export async function destroyDbSession(db, request, cookieName) {
  const token = readCookie(request, cookieName);
  if (!token) return;
  const tokenHash = await sha256Hex(token);
  await db.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(tokenHash).run().catch(() => {});
}
