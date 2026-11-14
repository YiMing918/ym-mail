// 管理后台 API（/api/admin/*）：与前台完全独立的账号密码（环境变量/Secret）
// + 独立 Cookie + D1 会话（is_admin=1）。管理员登录同样带失败锁定。
import {
  verifyPassword, randomCodePrefix,
  createDbSession, getDbSession, destroyDbSession,
  ADMIN_COOKIE, sessionCookie, clearCookie,
} from './auth.js';
import { loadConfig, setSetting, invalidateConfig, policyForClient } from './config.js';
import { json, err, readJson, clientIp, DOMAIN_RE, rateLocked, rateFail, rateClear } from './util.js';

async function requireAdmin(env, request) {
  const session = await getDbSession(env.DB, request, ADMIN_COOKIE);
  return session && session.is_admin ? session : null;
}

export async function handleAdminApi(request, env, url) {
  const path = url.pathname;
  const method = request.method;
  const db = env.DB;

  // ── 管理员登录（唯一免鉴权接口） ──
  if (path === '/api/admin/login' && method === 'POST') {
    if (!env.ADMIN_USER || !env.ADMIN_PASSWORD_HASH) {
      return err(500, '服务端未配置 ADMIN_USER / ADMIN_PASSWORD_HASH，请先按 README 设置 Secret');
    }
    const body = (await readJson(request)) || {};
    const username = String(body.username || '').trim();
    const password = String(body.password || '');
    const ip = clientIp(request);
    const lockKey = `admin:${ip}`;
    const locked = await rateLocked(db, lockKey);
    if (locked > 0) return err(429, `登录失败次数过多，请 ${Math.ceil(locked / 60000)} 分钟后再试`);
    const ok = username === env.ADMIN_USER && (await verifyPassword(password, env.ADMIN_PASSWORD_HASH));
    if (!ok) {
      await rateFail(db, lockKey, 5, 10 * 60_000);
      return err(401, '管理员账号或密码不正确');
    }
    await rateClear(db, lockKey);
    const { token, ttlSec } = await createDbSession(db, { userId: null, isAdmin: true });
    return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie(ADMIN_COOKIE, token, ttlSec) });
  }

  const admin = await requireAdmin(env, request);
  if (!admin) return err(401, '未登录后台或会话已失效');

  if (path === '/api/admin/logout' && method === 'POST') {
    await destroyDbSession(db, request, ADMIN_COOKIE);
    return json({ ok: true }, 200, { 'Set-Cookie': clearCookie(ADMIN_COOKIE) });
  }

  const cfg = await loadConfig(env);

  // ── 后台首屏打包 ──
  if (path === '/api/admin/bootstrap' && method === 'GET') {
    const dayStart = new Date();
    dayStart.setHours(0, 0, 0, 0);
    const [users, addrs, today, invites, bl, ban] = await db.batch([
      db.prepare('SELECT COUNT(*) AS c FROM users'),
      db.prepare('SELECT COUNT(*) AS c FROM addresses'),
      db.prepare("SELECT COUNT(*) AS c FROM mails WHERE folder = 'inbox' AND received_at >= ?").bind(dayStart.getTime()),
      db.prepare('SELECT code, left_uses, created_at FROM invites ORDER BY created_at DESC LIMIT 100'),
      db.prepare('SELECT pattern FROM blacklist ORDER BY pattern'),
      db.prepare('SELECT address FROM banned ORDER BY address'),
    ]);
    return json({
      ok: true,
      stats: {
        users: users.results?.[0]?.c ?? 0,
        addresses: addrs.results?.[0]?.c ?? 0,
        todayMails: today.results?.[0]?.c ?? 0,
      },
      settings: {
        guest_mode: cfg.guestMode,
        reg_mode: cfg.regMode,
        guest_days: cfg.guestDays,
        user_cap: cfg.userCap,
        idle_days: cfg.idleDays,
        admin_tg_push: cfg.settings.admin_tg_push !== '0',
        ref_bonus: cfg.refBonus,
        ref_bonus_n: cfg.refBonusN,
        mail_from: cfg.settings.mail_from || '',
      },
      policies: cfg.policies.map(policyForClient),
      invites: (invites.results || []).map((r) => ({ code: r.code, left: Number(r.left_uses) })),
      blacklist: (bl.results || []).map((r) => r.pattern),
      banned: (ban.results || []).map((r) => r.address),
    });
  }

  // ── 全站设置 ──
  if (path === '/api/admin/settings' && method === 'POST') {
    const body = (await readJson(request)) || {};
    if (typeof body.guest_mode === 'boolean') await setSetting(env, 'guest_mode', body.guest_mode ? '1' : '0');
    if (typeof body.ref_bonus === 'boolean') await setSetting(env, 'ref_bonus', body.ref_bonus ? '1' : '0');
    if (typeof body.ref_bonus_n === 'number') {
      const v = Math.floor(body.ref_bonus_n);
      if (v < 0 || v > 1000) return err(400, '邀请奖励个数填 0 到 1000');
      await setSetting(env, 'ref_bonus_n', String(v));
    }
    if (typeof body.admin_tg_push === 'boolean') await setSetting(env, 'admin_tg_push', body.admin_tg_push ? '1' : '0');
    if (typeof body.reg_mode === 'string' && ['email', 'invite', 'off'].includes(body.reg_mode)) {
      await setSetting(env, 'reg_mode', body.reg_mode);
    }
    if (typeof body.mail_from === 'string') {
      const mf = body.mail_from.trim().toLowerCase();
      if (mf && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mf)) return err(400, '发件地址格式不对');
      await setSetting(env, 'mail_from', mf);
    }
    const dayKeys = [
      ['guest_days', 0, 3650],
      ['user_cap', 0, 3650],
      ['idle_days', 0, 3650],
    ];
    for (const [k, min, max] of dayKeys) {
      if (typeof body[k] === 'number') {
        const v = Math.floor(body[k]);
        if (v < min || v > max) return err(400, `${k} 取值不对`);
        await setSetting(env, k, String(v));
      }
    }
    return json({ ok: true });
  }

  // ── 域名：添加 / 改政策 / 删除 ──
  if (path === '/api/admin/domains' && method === 'POST') {
    const body = (await readJson(request)) || {};
    const domain = String(body.domain || '').trim().toLowerCase();
    if (!DOMAIN_RE.test(domain)) return err(400, '域名格式不对，如 mail.example.com');
    if (cfg.byDomain[domain]) return err(400, '这个域名已经有了');
    const hasAny = cfg.policies.length > 0;
    await db
      .prepare(
        `INSERT INTO policies (domain, is_main, u_open, u_custom, u_random, u_del, u_refund, u_minlen,
                               g_open, g_custom, g_random, g_del, g_refund, g_minlen, created_at)
         VALUES (?, ?, 1, 3, 5, 1, 1, 3, 0, 1, 1, 1, 0, 5, ?)`
      )
      .bind(domain, hasAny ? 0 : 1, Date.now())
      .run();
    invalidateConfig();
    return json({ ok: true, domain, is_main: !hasAny });
  }
  const polMatch = path.match(/^\/api\/admin\/policies\/(.+)$/);
  if (polMatch && method === 'POST') {
    const domain = decodeURIComponent(polMatch[1]).toLowerCase();
    const pol = cfg.byDomain[domain];
    if (!pol) return err(404, '域名不存在');
    const body = (await readJson(request)) || {};
    const cur = {
      u_open: pol.u_open ? 1 : 0, u_custom: pol.u_custom, u_random: pol.u_random,
      u_del: pol.u_del ? 1 : 0, u_refund: pol.u_refund ? 1 : 0, u_minlen: pol.u_minlen,
      g_open: pol.g_open ? 1 : 0, g_custom: pol.g_custom, g_random: pol.g_random,
      g_del: pol.g_del ? 1 : 0, g_refund: pol.g_refund ? 1 : 0, g_minlen: pol.g_minlen,
    };
    const boolKeys = ['u_open', 'u_del', 'u_refund', 'g_open', 'g_del', 'g_refund'];
    const limKeys = ['u_custom', 'u_random', 'g_custom', 'g_random'];
    const lenKeys = ['u_minlen', 'g_minlen'];
    for (const k of boolKeys) if (typeof body[k] === 'boolean') cur[k] = body[k] ? 1 : 0;
    for (const k of limKeys) {
      if (typeof body[k] === 'number') {
        const v = Math.floor(body[k]);
        if (v < -1 || v > 1000) return err(400, '个数设置不对（-1 不限 / 0 不能建 / 正数上限）');
        cur[k] = v;
      }
    }
    for (const k of lenKeys) {
      if (typeof body[k] === 'number') {
        const v = Math.floor(body[k]);
        if (v < 1 || v > 32) return err(400, '前缀位数不对');
        cur[k] = v;
      }
    }
    await db
      .prepare(
        `UPDATE policies SET u_open=?, u_custom=?, u_random=?, u_del=?, u_refund=?, u_minlen=?,
                             g_open=?, g_custom=?, g_random=?, g_del=?, g_refund=?, g_minlen=? WHERE domain=?`
      )
      .bind(cur.u_open, cur.u_custom, cur.u_random, cur.u_del, cur.u_refund, cur.u_minlen,
            cur.g_open, cur.g_custom, cur.g_random, cur.g_del, cur.g_refund, cur.g_minlen, domain)
      .run();
    invalidateConfig();
    return json({ ok: true });
  }
  const domMainMatch = path.match(/^\/api\/admin\/domains\/(.+)\/main$/);
  if (domMainMatch && method === 'POST') {
    const domain = decodeURIComponent(domMainMatch[1]).toLowerCase();
    if (!cfg.byDomain[domain]) return err(404, '域名不存在');
    await db.prepare('UPDATE policies SET is_main = CASE WHEN domain = ? THEN 1 ELSE 0 END').bind(domain).run();
    invalidateConfig();
    return json({ ok: true, domain });
  }
  const domDelMatch = path.match(/^\/api\/admin\/domains\/(.+)$/);
  if (domDelMatch && method === 'DELETE') {
    const domain = decodeURIComponent(domDelMatch[1]).toLowerCase();
    const pol = cfg.byDomain[domain];
    if (!pol) return err(404, '域名不存在');
    if (pol.is_main) return err(400, '主域名不能删除');
    // 只删政策行：该域名立即停止收信/新建；存量地址与邮件保留在库里（数据不丢，需要时可重新加回域名）
    await db.prepare('DELETE FROM policies WHERE domain = ?').bind(domain).run();
    invalidateConfig();
    return json({ ok: true });
  }

  // ── 邀请码：批量生成 / 作废 ──
  // 每次生成的码都是密码学随机、互不相同（撞码自动重掷），支持一次生成一批、每人发一个。
  if (path === '/api/admin/invites' && method === 'POST') {
    const body = (await readJson(request)) || {};
    const uses = Number(body.uses);
    if (!(uses === -1 || (Number.isInteger(uses) && uses >= 1 && uses <= 1000))) return err(400, '次数填 1 到 1000，或选不限次');
    const count = body.count === undefined ? 1 : Number(body.count);
    if (!Number.isInteger(count) || count < 1 || count > 50) return err(400, '一次生成 1 到 50 个');
    const codes = [];
    for (let n = 0; n < count; n++) {
      let done = false;
      for (let attempt = 0; attempt < 8 && !done; attempt++) {
        const code = randomCodePrefix();
        try {
          await db.prepare('INSERT INTO invites (code, left_uses, created_at) VALUES (?, ?, ?)').bind(code, uses, Date.now()).run();
          codes.push(code);
          done = true;
        } catch { /* 撞码重掷 */ }
      }
      if (!done) return err(500, '生成邀请码失败，请重试');
    }
    return json({ ok: true, codes, code: codes[0], left: uses });
  }
  const invDelMatch = path.match(/^\/api\/admin\/invites\/(.+)$/);
  if (invDelMatch && method === 'DELETE') {
    const code = decodeURIComponent(invDelMatch[1]).toUpperCase();
    await db.prepare('DELETE FROM invites WHERE code = ?').bind(code).run();
    return json({ ok: true });
  }

  // ── 防护：黑名单 / 封禁 ──
  if (path === '/api/admin/blacklist' && method === 'POST') {
    const body = (await readJson(request)) || {};
    const v = String(body.pattern || '').trim().toLowerCase();
    if (!v || !v.includes('@')) return err(400, '填发件人邮箱，或 @域名 表示整个域名');
    if (cfg.blacklist.includes(v)) return err(400, '已经在黑名单里了');
    await db.prepare('INSERT INTO blacklist (pattern, created_at) VALUES (?, ?)').bind(v, Date.now()).run();
    invalidateConfig();
    return json({ ok: true });
  }
  const blDelMatch = path.match(/^\/api\/admin\/blacklist\/(.+)$/);
  if (blDelMatch && method === 'DELETE') {
    await db.prepare('DELETE FROM blacklist WHERE pattern = ?').bind(decodeURIComponent(blDelMatch[1]).toLowerCase()).run();
    invalidateConfig();
    return json({ ok: true });
  }
  if (path === '/api/admin/banned' && method === 'POST') {
    const body = (await readJson(request)) || {};
    const v = String(body.address || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) return err(400, '填完整的邮箱地址');
    if (cfg.banned.has(v)) return err(400, '这个地址已经封禁了');
    await db.prepare('INSERT INTO banned (address, created_at) VALUES (?, ?)').bind(v, Date.now()).run();
    invalidateConfig();
    return json({ ok: true });
  }
  const banDelMatch = path.match(/^\/api\/admin\/banned\/(.+)$/);
  if (banDelMatch && method === 'DELETE') {
    await db.prepare('DELETE FROM banned WHERE address = ?').bind(decodeURIComponent(banDelMatch[1]).toLowerCase()).run();
    invalidateConfig();
    return json({ ok: true });
  }

  return err(404, '接口不存在');
}
