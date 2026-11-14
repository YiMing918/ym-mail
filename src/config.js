// 全站配置的进程内缓存（省额度架构的核心一环）：
// settings + policies + blacklist + banned 一次 batch 读进内存，同一 Worker
// 实例内收信/API 反复用都不再查库；60 秒 TTL 兜底跨实例一致性；凡是经本
// Worker 的管理员写操作都会立刻 invalidateConfig()，本实例内立即生效。

let cache = null;
let cacheAt = 0;
const TTL_MS = 60_000;

export function invalidateConfig() {
  cache = null;
  cacheAt = 0;
}

export async function loadConfig(env, force = false) {
  if (!force && cache && Date.now() - cacheAt < TTL_MS) return cache;
  const [sRows, pRows, blRows, banRows] = await env.DB.batch([
    env.DB.prepare('SELECT key, value FROM settings'),
    env.DB.prepare('SELECT * FROM policies ORDER BY created_at ASC'),
    env.DB.prepare('SELECT pattern FROM blacklist'),
    env.DB.prepare('SELECT address FROM banned'),
  ]);
  const settings = {};
  for (const r of sRows.results || []) settings[r.key] = r.value;
  const policies = (pRows.results || []).map(normalizePolicy);
  const byDomain = {};
  for (const p of policies) byDomain[p.domain] = p;
  cache = {
    settings,
    policies,
    byDomain,
    blacklist: (blRows.results || []).map((r) => r.pattern),
    banned: new Set((banRows.results || []).map((r) => r.address)),
    guestMode: settings.guest_mode !== '0',
    regMode: settings.reg_mode || 'email',
    guestDays: Number(settings.guest_days ?? 1) || 0,
    userCap: Number(settings.user_cap ?? 180) || 0, // 0 = 不限
    idleDays: Number(settings.idle_days ?? 7) || 0, // 0 = 不清理
  };
  cacheAt = Date.now();
  return cache;
}

function normalizePolicy(r) {
  const n = (v, d) => {
    const x = Number(v);
    return Number.isFinite(x) ? x : d;
  };
  return {
    domain: r.domain,
    is_main: !!r.is_main,
    u_open: !!r.u_open, u_custom: n(r.u_custom, 3), u_random: n(r.u_random, 5),
    u_del: !!r.u_del, u_refund: !!r.u_refund, u_minlen: n(r.u_minlen, 3),
    g_open: !!r.g_open, g_custom: n(r.g_custom, 1), g_random: n(r.g_random, 1),
    g_del: !!r.g_del, g_refund: !!r.g_refund, g_minlen: n(r.g_minlen, 5),
    created_at: Number(r.created_at || 0),
  };
}

// 前端要用的公开形态（字段名与预览 C 的 POLICIES 对齐，前端渲染逻辑可直接搬）
// limit 编码在 API 边界转换成预览的字符串语义：-1 → 'inf'，0 → 'self'（前端显示「0 个」）
export function policyForClient(p) {
  const lim = (v) => (v === -1 ? 'inf' : v === 0 ? 'self' : String(v));
  return {
    dom: p.domain,
    is_main: p.is_main,
    uopen: p.u_open, ucustom: lim(p.u_custom), urandom: lim(p.u_random),
    udel: p.u_del, urefund: p.u_refund, uminlen: String(p.u_minlen || 1),
    gopen: p.g_open, gcustom: lim(p.g_custom), grandom: lim(p.g_random),
    gdel: p.g_del, grefund: p.g_refund, gminlen: String(p.g_minlen || 1),
  };
}

export async function getSetting(env, key, fallback = '') {
  const row = await env.DB.prepare('SELECT value FROM settings WHERE key = ?').bind(key).first();
  return row ? row.value : fallback;
}

export async function setSetting(env, key, value) {
  await env.DB.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  )
    .bind(key, String(value))
    .run();
  invalidateConfig();
}
