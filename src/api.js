// 用户端 API：注册/登录（D1 会话）、bootstrap 打包、邮件、地址、发信、个人设置。
// 省额度要点：
// * 首屏只打 /api/bootstrap 一次；轮询只打 /api/check（一条聚合 SQL）。
// * 列表只查摘要列，正文/附件点开才拉。
// * 可见性一律按 mails.owner_id 快照判断（收信时写入，认领时一次性迁移），查询简单稳定。
import {
  hashPassword, verifyPassword, sha256Hex, randomDigits, DUMMY_PW_HASH,
  createDbSession, getDbSession, destroyDbSession,
  USER_COOKIE, sessionCookie, clearCookie, randomAddressPrefix,
} from './auth.js';
import { loadConfig, policyForClient } from './config.js';
import { sendViaResend, systemFrom, SendError } from './send.js';
import {
  json, err, readJson, clientIp, domOf, prefixOf,
  EMAIL_RE, PREFIX_RE, rateLocked, rateFail, rateClear, ratePeek, rateBump,
} from './util.js';

const PAGE_SIZE = 30;

// ---------- 当前访问者 ----------
export async function resolveViewer(env, request) {
  const session = await getDbSession(env.DB, request, USER_COOKIE);
  if (session && session.user_id) {
    const user = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(session.user_id).first();
    if (user) return { type: 'user', user, session };
  }
  return { type: 'guest', user: null, session: null };
}

// 可见性片段：返回 {sql, binds}，sql 针对别名 m 的 mails 表
function visFrag(viewer) {
  if (viewer.type === 'user') return { sql: 'm.owner_id = ?', binds: [viewer.user.id] };
  return { sql: 'm.owner_id IS NULL', binds: [] };
}
function mailVisible(viewer, mail) {
  if (!mail) return false;
  return viewer.type === 'user' ? mail.owner_id === viewer.user.id : mail.owner_id === null;
}
function ownerKey(viewer) {
  return viewer.type === 'user' ? `u:${viewer.user.id}` : 'guest';
}

// ---------- 额度用量：{域名: {c, r}}（含 tombstone 占额） ----------
async function quotaMap(env, viewer) {
  const isUser = viewer.type === 'user';
  const addrRows = await env.DB.prepare(
    `SELECT domain, kind, COUNT(*) AS n FROM addresses
     WHERE ${isUser ? 'owner_id = ?' : 'owner_id IS NULL'} GROUP BY domain, kind`
  )
    .bind(...(isUser ? [viewer.user.id] : []))
    .all();
  const tombRows = await env.DB.prepare('SELECT domain, kind, count FROM tombstones WHERE owner_key = ?')
    .bind(ownerKey(viewer))
    .all();
  const map = {};
  const add = (dom, kind, n) => {
    if (!map[dom]) map[dom] = { c: 0, r: 0 };
    if (kind === 'custom') map[dom].c += n;
    else map[dom].r += n;
  };
  for (const r of addrRows.results || []) add(r.domain, r.kind, Number(r.n));
  for (const r of tombRows.results || []) add(r.domain, r.kind, Number(r.count));
  return map;
}

// ---------- 邮件摘要 ----------
function mailSummary(r) {
  let attN = 0;
  try {
    attN = JSON.parse(r.attachments || '[]').length;
  } catch { /* 元信息损坏时按无附件 */ }
  return {
    id: r.id,
    from: r.from_name || r.from_addr,
    fromAddr: r.from_addr,
    to: r.to_addr,
    subj: r.subject,
    snip: String(r.snip || '').replace(/\s*\n\s*/g, ' ').slice(0, 90),
    otp: r.otp,
    read: !!r.is_read,
    star: !!r.is_starred,
    att: attN,
    t: r.received_at,
  };
}
const SUMMARY_COLS =
  'm.id, m.to_addr, m.from_addr, m.from_name, m.subject, m.otp, m.is_read, m.is_starred, m.attachments, m.received_at, substr(m.text_body, 1, 120) AS snip';

async function listMails(env, viewer, { scope = 'all', filter = 'all', q = '', view = 'inbox', limit = PAGE_SIZE, offset = 0 }) {
  const vis = visFrag(viewer);
  const where = [vis.sql];
  const binds = [...vis.binds];
  if (view === 'sent') where.push("m.folder = 'sent'");
  else where.push("m.folder = 'inbox'");
  if (scope && scope !== 'all') {
    where.push('m.to_addr = ?');
    binds.push(scope);
  }
  if (filter === 'unread') where.push('m.is_read = 0');
  if (filter === 'star') where.push('m.is_starred = 1');
  if (filter === 'att') where.push("m.attachments <> '[]'");
  if (q) {
    where.push('(m.subject LIKE ? OR m.from_addr LIKE ? OR m.from_name LIKE ? OR m.text_body LIKE ? OR m.otp LIKE ?)');
    const like = `%${q}%`;
    binds.push(like, like, like, like, like);
  }
  const whereSql = where.join(' AND ');
  const totalRow = await env.DB.prepare(`SELECT COUNT(*) AS c FROM mails m WHERE ${whereSql}`).bind(...binds).first();
  const { results } = await env.DB.prepare(
    `SELECT ${SUMMARY_COLS} FROM mails m WHERE ${whereSql} ORDER BY m.received_at DESC, m.id DESC LIMIT ? OFFSET ?`
  )
    .bind(...binds, limit, offset)
    .all();
  return { total: totalRow?.c ?? 0, mails: (results || []).map(mailSummary) };
}

async function visibleUnread(env, viewer, scope = 'all') {
  const vis = visFrag(viewer);
  const binds = [...vis.binds];
  let sql = `SELECT COUNT(*) AS c, MAX(m.id) AS latest FROM mails m WHERE ${vis.sql} AND m.folder = 'inbox'`;
  if (scope && scope !== 'all') {
    sql += ' AND m.to_addr = ?';
    binds.push(scope);
  }
  const row = await env.DB.prepare(sql).bind(...binds).first();
  const unreadRow = await env.DB.prepare(
    `SELECT COUNT(*) AS c FROM mails m WHERE ${vis.sql} AND m.folder = 'inbox' AND m.is_read = 0${scope && scope !== 'all' ? ' AND m.to_addr = ?' : ''}`
  )
    .bind(...(scope && scope !== 'all' ? [...vis.binds, scope] : vis.binds))
    .first();
  return { unread: unreadRow?.c ?? 0, latest: row?.latest ?? 0 };
}

async function listCodes(env, viewer, scope = 'all', limit = 50) {
  const vis = visFrag(viewer);
  const binds = [...vis.binds];
  let sql = `SELECT ${SUMMARY_COLS} FROM mails m WHERE ${vis.sql} AND m.folder = 'inbox' AND m.otp IS NOT NULL`;
  if (scope && scope !== 'all') {
    sql += ' AND m.to_addr = ?';
    binds.push(scope);
  }
  sql += ' ORDER BY m.received_at DESC LIMIT ?';
  binds.push(limit);
  const { results } = await env.DB.prepare(sql).bind(...binds).all();
  return (results || []).map(mailSummary);
}

// ---------- 地址列表（带每地址计数） ----------
async function listAddresses(env, viewer) {
  const isUser = viewer.type === 'user';
  const ownerBind = isUser ? viewer.user.id : null;
  const visCount = isUser ? 'mm.owner_id = ?' : 'mm.owner_id IS NULL';
  const { results } = await env.DB.prepare(
    `SELECT a.address, a.kind, a.protected, a.created_at, a.last_mail_at,
       (SELECT COUNT(*) FROM mails mm WHERE mm.to_addr = a.address AND ${visCount} AND mm.folder = 'inbox') AS total,
       (SELECT COUNT(*) FROM mails mm WHERE mm.to_addr = a.address AND ${visCount} AND mm.folder = 'inbox' AND mm.is_read = 0) AS unread
     FROM addresses a
     WHERE ${isUser ? 'a.owner_id = ?' : 'a.owner_id IS NULL'}
     ORDER BY a.protected DESC, a.created_at DESC LIMIT 200`
  )
    .bind(...(isUser ? [viewer.user.id, viewer.user.id, viewer.user.id] : []))
    .all();
  return (results || []).map((r) => ({
    address: r.address,
    kind: r.kind,
    main: !!r.protected,
    total: r.total ?? 0,
    unread: r.unread ?? 0,
    lastMailAt: r.last_mail_at || 0,
  }));
}

// ---------- 邀请奖励：专属额度（邀请一人给几个由站长在后台自填 ref_bonus_n，在域名政策上限之外叠加） ----------
function randomInviteCode() {
  // 个人邀请码随机部分 8 位（C-37，原 5 位）；旧 5 位码查表校验、不依赖长度，照常可用
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const buf = new Uint32Array(8);
  crypto.getRandomValues(buf);
  return 'YM-' + [...buf].map((n) => chars[n % chars.length]).join('');
}
async function ensureInviteCode(db, user) {
  if (user.invite_code) return user.invite_code;
  for (let i = 0; i < 5; i++) {
    const code = randomInviteCode();
    const dup = await db.prepare('SELECT id FROM users WHERE invite_code = ?').bind(code).first();
    if (dup) continue;
    await db.prepare('UPDATE users SET invite_code = ? WHERE id = ?').bind(code, user.id).run();
    user.invite_code = code;
    return code;
  }
  return '';
}

// ---------- 创建 / 认领地址（登录用户） ----------
async function createOrClaim(env, cfg, user, addrRaw, kind) {
  const addr = String(addrRaw || '').trim().toLowerCase();
  const prefix = prefixOf(addr);
  const domain = domOf(addr);
  if (!EMAIL_RE.test(addr) || !PREFIX_RE.test(prefix)) {
    return { error: [400, '前缀只能用小写字母、数字、点和横线'] };
  }
  const pol = cfg.byDomain[domain];
  if (!pol) return { error: [400, '这个域名还没有在后台添加'] };
  if (!pol.u_open) return { error: [403, '这个域名没开放给注册用户（后台政策）'] };
  if (cfg.banned.has(addr)) return { error: [403, '这个地址已被站长封禁，不能用'] };
  const existing = await env.DB.prepare('SELECT * FROM addresses WHERE address = ?').bind(addr).first();
  if (existing && existing.owner_id === user.id) return { error: [400, '这个邮箱已经有了'] };
  if (existing && existing.owner_id !== null) return { error: [403, '这个地址已被别人认领了'] };
  let useBonus = 0;
  if (!user.is_owner) {
    // 个数上限（按目标 kind 的池算，含 tombstone）
    const quota = await quotaMap(env, { type: 'user', user });
    const used = (quota[domain] || { c: 0, r: 0 })[kind === 'custom' ? 'c' : 'r'];
    const limit = kind === 'custom' ? pol.u_custom : pol.u_random;
    if (limit === 0) return { error: [403, `站长把这个域名的${kind === 'custom' ? '自定义前缀' : '随机地址'}设为 0 个，建不了`] };
    if (limit > 0 && used >= limit) {
      // 政策额度用满：有专属额度（邀请奖励）就抵 1 个继续建；0 个上限不适用（那是站长关死）
      const brow = await env.DB.prepare('SELECT bonus FROM users WHERE id = ?').bind(user.id).first();
      if (brow && Number(brow.bonus) > 0) useBonus = 1;
      else return { error: [403, `你在 ${domain} 的${kind === 'custom' ? '自定义前缀' : '随机地址'}已达上限 ${limit} 个（后台政策）；邀请好友注册成功可得专属额度，超出上限也能建`] };
    }
    if (kind === 'custom' && prefix.length < (pol.u_minlen || 1)) {
      return { error: [400, `前缀太短：${domain} 要求至少 ${pol.u_minlen} 位（站长设置）`] };
    }
  }
  const now = Date.now();
  if (existing) {
    // 认领公开地址（对抗复读 C-3 竞态修复）：旧写法先读 existing 再无条件 UPDATE，
    // 两个并发认领能同时读到「未认领」、双双成功（后写的盖掉先写的、邮件被迁走、
    // 两边专属额度都被扣）。改成单条条件 UPDATE 抢占：只有 owner_id 仍为 NULL 才
    // 抢得到，按 meta.changes 判成败。顺序也调了：先抢占 → 再扣专属额度 → 最后才
    // 迁移历史邮件；抢败零副作用（不扣额度、不迁邮件），扣额度失败则把地址放回。
    const claim = await env.DB.prepare(
      'UPDATE addresses SET owner_id = ?, kind = ?, bonus_used = ? WHERE address = ? AND owner_id IS NULL'
    )
      .bind(user.id, kind, useBonus, addr)
      .run();
    if (!claim.meta || claim.meta.changes === 0) return { error: [403, '这个地址已被别人认领了'] };
    const releaseClaim = () =>
      env.DB.prepare('UPDATE addresses SET owner_id = NULL, bonus_used = 0 WHERE address = ? AND owner_id = ?')
        .bind(addr, user.id)
        .run()
        .catch(() => {});
    if (useBonus) {
      const dec = await env.DB.prepare('UPDATE users SET bonus = bonus - 1 WHERE id = ? AND bonus > 0').bind(user.id).run();
      if (!dec.meta || dec.meta.changes === 0) {
        await releaseClaim();
        return { error: [403, '专属额度刚刚用完了'] };
      }
    }
    try {
      // 抢占成功后才把历史邮件的归属快照一次性迁移给认领者
      await env.DB.prepare('UPDATE mails SET owner_id = ? WHERE to_addr = ? AND owner_id IS NULL').bind(user.id, addr).run();
    } catch (e) {
      if (useBonus) await env.DB.prepare('UPDATE users SET bonus = bonus + 1 WHERE id = ?').bind(user.id).run().catch(() => {});
      await releaseClaim();
      throw e;
    }
    return { address: addr };
  }
  // 新建地址：地址主键唯一约束兜底并发同名新建；保持原顺序（先原子扣额度、失败退回）
  if (useBonus) {
    const dec = await env.DB.prepare('UPDATE users SET bonus = bonus - 1 WHERE id = ? AND bonus > 0').bind(user.id).run();
    if (!dec.meta || dec.meta.changes === 0) return { error: [403, '专属额度刚刚用完了'] };
  }
  try {
    await env.DB.prepare(
      'INSERT INTO addresses (address, domain, prefix, kind, owner_id, protected, bonus_used, created_at, last_mail_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?, 0)'
    )
      .bind(addr, domain, prefix, kind, user.id, useBonus, now)
      .run();
  } catch (e) {
    if (useBonus) await env.DB.prepare('UPDATE users SET bonus = bonus + 1 WHERE id = ?').bind(user.id).run().catch(() => {});
    throw e;
  }
  return { address: addr };
}

// ============================================================
// 路由
// ============================================================
export async function handleApi(request, env, url) {
  const path = url.pathname;
  const method = request.method;
  const cfg = await loadConfig(env);
  const viewer = await resolveViewer(env, request);
  const db = env.DB;

  const needUser = () => (viewer.type === 'user' ? null : err(401, '请先登录'));
  const guestBlocked = () => (viewer.type === 'guest' && !cfg.guestMode ? err(403, '游客模式已关闭，请先登录') : null);

  // ── 首屏打包 ──
  if (path === '/api/bootstrap' && method === 'GET') {
    const ucRow = await db.prepare('SELECT COUNT(*) AS c FROM users').first().catch(() => null);
    const ownerExists = (ucRow?.c ?? 1) > 0;
    const gb = guestBlocked();
    if (gb) {
      // 游客模式关闭时也返回公开设置，让前端能正确提示并引导登录/注册
      return json({
        ok: true, mode: 'guest', user: null, guestBlocked: true,
        settings: { guest_mode: false, reg_mode: cfg.regMode, guest_days: cfg.guestDays, user_cap: cfg.userCap, idle_days: cfg.idleDays, owner_exists: ownerExists },
        policies: cfg.policies.map(policyForClient),
        addresses: [], quota: {}, mails: [], codes: [], unread: 0, latest: 0, total: 0,
      });
    }
    const [addresses, quota, page, codes, agg] = await Promise.all([
      listAddresses(env, viewer),
      quotaMap(env, viewer),
      listMails(env, viewer, {}),
      listCodes(env, viewer),
      visibleUnread(env, viewer),
    ]);
    let invitedCount = 0;
    if (viewer.user) {
      await ensureInviteCode(db, viewer.user).catch(() => '');
      const rc = await db.prepare('SELECT COUNT(*) AS c FROM referrals WHERE inviter_id = ?').bind(viewer.user.id).first();
      invitedCount = Number(rc?.c || 0);
      const brow = await db.prepare('SELECT bonus FROM users WHERE id = ?').bind(viewer.user.id).first();
      if (brow) viewer.user.bonus = Number(brow.bonus);
    }
    return json({
      ok: true,
      mode: viewer.type,
      user: viewer.user
        ? {
            username: viewer.user.username,
            email: viewer.user.email,
            retention_days: Number(viewer.user.retention_days),
            tg_push: !!viewer.user.tg_push,
            tg_chat_id: viewer.user.tg_chat_id || '',
            forward_backup: !!viewer.user.forward_backup,
            is_owner: !!viewer.user.is_owner,
            bonus: Number(viewer.user.bonus || 0),
            invite_code: viewer.user.invite_code || '',
            invited: invitedCount,
          }
        : null,
      guestBlocked: false,
      settings: {
        guest_mode: cfg.guestMode,
        reg_mode: cfg.regMode,
        guest_days: cfg.guestDays,
        user_cap: cfg.userCap,
        idle_days: cfg.idleDays,
        ref_bonus: cfg.refBonus,
        ref_bonus_n: cfg.refBonusN,
        owner_exists: ownerExists,
      },
      policies: cfg.policies.map(policyForClient),
      addresses,
      quota,
      mails: page.mails,
      total: page.total,
      codes,
      unread: agg.unread,
      latest: agg.latest,
    });
  }

  // ── 轻量新信检查（轮询专用，一条聚合 SQL） ──
  if (path === '/api/check' && method === 'GET') {
    const gb = guestBlocked();
    if (gb) return gb;
    const agg = await visibleUnread(env, viewer, url.searchParams.get('scope') || 'all');
    return json({ ok: true, latest: agg.latest, unread: agg.unread });
  }

  // ── 邮件列表 / 验证码 ──
  if (path === '/api/mails' && method === 'GET') {
    const gb = guestBlocked();
    if (gb) return gb;
    const limit = Math.min(50, Math.max(1, Number(url.searchParams.get('limit') || PAGE_SIZE)));
    const offset = Math.max(0, Number(url.searchParams.get('offset') || 0));
    const page = await listMails(env, viewer, {
      scope: url.searchParams.get('scope') || 'all',
      filter: url.searchParams.get('filter') || 'all',
      q: (url.searchParams.get('q') || '').slice(0, 100),
      view: url.searchParams.get('view') || 'inbox',
      limit,
      offset,
    });
    return json({ ok: true, total: page.total, mails: page.mails });
  }
  if (path === '/api/codes' && method === 'GET') {
    const gb = guestBlocked();
    if (gb) return gb;
    return json({ ok: true, codes: await listCodes(env, viewer, url.searchParams.get('scope') || 'all') });
  }

  // ── 全部已读 / 批量删除 ──
  if (path === '/api/mails/read-all' && method === 'POST') {
    const gb = guestBlocked();
    if (gb) return gb;
    const body = (await readJson(request)) || {};
    const vis = visFrag(viewer);
    const binds = [...vis.binds];
    let sql = `UPDATE mails SET is_read = 1 WHERE ${vis.sql} AND folder = 'inbox' AND is_read = 0`;
    if (body.scope && body.scope !== 'all') {
      sql += ' AND to_addr = ?';
      binds.push(String(body.scope));
    }
    await db.prepare(sql).bind(...binds).run();
    return json({ ok: true });
  }
  if (path === '/api/mails/batch-delete' && method === 'POST') {
    const gb = guestBlocked();
    if (gb) return gb;
    const body = (await readJson(request)) || {};
    const ids = (Array.isArray(body.ids) ? body.ids : []).map(Number).filter((n) => n > 0).slice(0, 200);
    if (!ids.length) return err(400, '先勾选要删的邮件');
    const vis = visFrag(viewer);
    const ph = ids.map(() => '?').join(',');
    const sel = `SELECT id FROM mails m WHERE ${vis.sql} AND m.id IN (${ph})`;
    await db.batch([
      db.prepare(`DELETE FROM attachments WHERE mail_id IN (${sel})`).bind(...vis.binds, ...ids),
      db.prepare(`DELETE FROM mails WHERE id IN (${sel})`).bind(...vis.binds, ...ids),
    ]);
    return json({ ok: true, deleted: ids.length });
  }

  // ── 邮件详情 / 星标 / 删除 / 附件 ──
  const attMatch = path.match(/^\/api\/mails\/(\d+)\/att\/(\d+)$/);
  if (attMatch && method === 'GET') {
    const gb = guestBlocked();
    if (gb) return gb;
    const mail = await db.prepare('SELECT owner_id FROM mails WHERE id = ?').bind(Number(attMatch[1])).first();
    if (!mailVisible(viewer, mail)) return err(404, '附件不存在');
    const row = await db
      .prepare('SELECT filename, mime, data FROM attachments WHERE mail_id = ? AND idx = ?')
      .bind(Number(attMatch[1]), Number(attMatch[2]))
      .first();
    if (!row) return err(404, '附件不存在或过大未保存');
    const bin = atob(row.data);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    // 附件存储型 XSS 防护（对抗复读 C-2）：附件 mime 由发件人控制，旧写法凡 image/*
    // 都放行 inline，image/svg+xml 内嵌脚本会在本站源下执行。现在 inline 只白名单
    // 位图（png/jpeg/gif/webp，前端邮件详情的图片预览照常）；SVG 等一律强制下载。
    // 同时所有附件响应一律加 CSP sandbox + nosniff，纵深兜底。
    const INLINE_BITMAP = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
    const mimeNorm = String(row.mime || '').split(';')[0].trim().toLowerCase();
    const inline = url.searchParams.get('inline') === '1' && INLINE_BITMAP.has(mimeNorm);
    return new Response(bytes, {
      headers: {
        'Content-Type': row.mime || 'application/octet-stream',
        'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(row.filename || 'attachment')}`,
        'Content-Security-Policy': "default-src 'none'; sandbox",
        'X-Content-Type-Options': 'nosniff',
      },
    });
  }
  const starMatch = path.match(/^\/api\/mails\/(\d+)\/star$/);
  if (starMatch && method === 'POST') {
    const gb = guestBlocked();
    if (gb) return gb;
    const mail = await db.prepare('SELECT owner_id FROM mails WHERE id = ?').bind(Number(starMatch[1])).first();
    if (!mailVisible(viewer, mail)) return err(404, '邮件不存在');
    const body = (await readJson(request)) || {};
    await db.prepare('UPDATE mails SET is_starred = ? WHERE id = ?').bind(body.starred ? 1 : 0, Number(starMatch[1])).run();
    return json({ ok: true, starred: !!body.starred });
  }
  const detailMatch = path.match(/^\/api\/mails\/(\d+)$/);
  if (detailMatch && method === 'GET') {
    const gb = guestBlocked();
    if (gb) return gb;
    const row = await db.prepare('SELECT * FROM mails WHERE id = ?').bind(Number(detailMatch[1])).first();
    if (!mailVisible(viewer, row)) return err(404, '邮件不存在');
    if (!row.is_read) {
      await db.prepare('UPDATE mails SET is_read = 1 WHERE id = ?').bind(row.id).run();
      row.is_read = 1;
    }
    let atts = [];
    try {
      atts = JSON.parse(row.attachments || '[]');
    } catch { /* 忽略 */ }
    return json({
      ok: true,
      mail: {
        id: row.id, from: row.from_name || row.from_addr, fromAddr: row.from_addr, to: row.to_addr,
        subj: row.subject, text: row.text_body, html: row.html_body, otp: row.otp,
        read: !!row.is_read, star: !!row.is_starred, atts, t: row.received_at,
      },
    });
  }
  if (detailMatch && method === 'DELETE') {
    const gb = guestBlocked();
    if (gb) return gb;
    const mail = await db.prepare('SELECT owner_id FROM mails WHERE id = ?').bind(Number(detailMatch[1])).first();
    if (!mailVisible(viewer, mail)) return err(404, '邮件不存在');
    await db.batch([
      db.prepare('DELETE FROM attachments WHERE mail_id = ?').bind(Number(detailMatch[1])),
      db.prepare('DELETE FROM mails WHERE id = ?').bind(Number(detailMatch[1])),
    ]);
    return json({ ok: true });
  }

  // ── 地址：创建/认领（登录）、游客随机、删除（登录） ──
  if (path === '/api/addresses' && method === 'POST') {
    const nu = needUser();
    if (nu) return nu;
    const body = (await readJson(request)) || {};
    const addr = body.address
      ? String(body.address)
      : `${String(body.prefix || '').trim().toLowerCase()}@${String(body.domain || '').trim().toLowerCase()}`;
    const kind = body.kind === 'random' ? 'random' : 'custom';
    const r = await createOrClaim(env, cfg, viewer.user, addr, kind);
    if (r.error) return err(r.error[0], r.error[1]);
    return json({ ok: true, address: r.address });
  }
  if (path === '/api/guest/address' && method === 'POST') {
    if (viewer.type === 'user') return err(400, '已登录账号请用「存为邮箱」');
    if (!cfg.guestMode) return err(403, '游客模式已关闭，请先登录');
    const gbody = (await readJson(request)) || {};
    // 游客建址 IP 上限（对抗复读 C-13）：游客池按域名个数限额是全站共用一池，
    // 单个 IP 换着前缀/随机领能把池子刷空、还能批量占名。复用 rate_limits 给
    // 「真正新建」加每 IP 每小时上限（默认 20，站长可在 settings 的
    // guest_addr_ip_hour 改、0 = 关）；池里已有同名直接复用的不计数、不拦。
    const gIp = clientIp(request);
    const gLimit = cfg.guestAddrPerIpHour ?? 20;
    const gOver = async () => gLimit > 0 && (await ratePeek(db, `guest-addr:${gIp}`, 3600_000)) >= gLimit;
    const gBump = () => rateBump(db, `guest-addr:${gIp}`, 3600_000);
    const gLimitErr = () => err(429, `这个网络建地址太频繁了，每小时最多建 ${gLimit} 个，请过一会儿再试`);
    const wantPrefix = String(gbody.prefix || '').trim().toLowerCase();
    if (wantPrefix) {
      // 游客自定义前缀：按政策 g_custom（个数）/ g_minlen（最少位数）执行，与随机共用游客池计数
      const domain = String(gbody.domain || '').trim().toLowerCase();
      const pol = cfg.byDomain[domain];
      if (!pol || !pol.g_open) return err(400, '这个域名没有开放给游客');
      if (!PREFIX_RE.test(wantPrefix)) return err(400, '前缀只能用小写字母、数字、点和横线（1–31 位）');
      if (pol.g_custom === 0) return err(403, '站长把这个域名的游客自定义前缀设为 0 个，建不了');
      if (wantPrefix.length < (pol.g_minlen || 1)) return err(400, `前缀太短：${domain} 要求至少 ${pol.g_minlen} 位（站长设置）`);
      const addr = `${wantPrefix}@${domain}`;
      if (cfg.banned.has(addr)) return err(403, '这个地址已被站长封禁，不能用');
      const existing = await db.prepare('SELECT owner_id FROM addresses WHERE address = ?').bind(addr).first();
      if (existing) {
        if (existing.owner_id !== null) return err(403, '这个地址已被注册用户认领了，换个前缀吧');
        return json({ ok: true, address: addr, existed: true }); // 池里已有同名：直接用，不重复占额
      }
      const quota0 = await quotaMap(env, viewer);
      const usedC = (quota0[domain] || { c: 0, r: 0 }).c;
      if (pol.g_custom > 0 && usedC >= pol.g_custom) return err(403, `游客在 ${domain} 的自定义前缀已达上限 ${pol.g_custom} 个`);
      if (await gOver()) return gLimitErr();
      try {
        await db
          .prepare('INSERT INTO addresses (address, domain, prefix, kind, owner_id, protected, created_at, last_mail_at) VALUES (?, ?, ?, ?, NULL, 0, ?, 0)')
          .bind(addr, domain, wantPrefix, 'custom', Date.now())
          .run();
      } catch {
        return err(400, '这个地址刚刚被人抢先建了，换个前缀吧');
      }
      await gBump();
      return json({ ok: true, address: addr });
    }
    if (await gOver()) return gLimitErr();
    const quota = await quotaMap(env, viewer);
    for (const pol of cfg.policies) {
      if (!pol.g_open) continue;
      const used = (quota[pol.domain] || { c: 0, r: 0 }).r;
      if (pol.g_random === 0) continue;
      if (pol.g_random > 0 && used >= pol.g_random) continue;
      for (let attempt = 0; attempt < 5; attempt++) {
        const prefix = randomAddressPrefix();
        const addr = `${prefix}@${pol.domain}`;
        if (cfg.banned.has(addr)) continue;
        try {
          await db
            .prepare('INSERT INTO addresses (address, domain, prefix, kind, owner_id, protected, created_at, last_mail_at) VALUES (?, ?, ?, ?, NULL, 0, ?, 0)')
            .bind(addr, pol.domain, prefix, 'random', Date.now())
            .run();
          await gBump();
          return json({ ok: true, address: addr });
        } catch {
          /* 撞名重试 */
        }
      }
    }
    return err(403, '游客在每个域名的随机地址都到上限了，注册后能建更多');
  }
  const addrDelMatch = path.match(/^\/api\/addresses\/(.+)$/);
  if (addrDelMatch && method === 'DELETE') {
    const nu = needUser();
    if (nu) return nu;
    const addr = decodeURIComponent(addrDelMatch[1]).toLowerCase();
    const row = await db.prepare('SELECT * FROM addresses WHERE address = ?').bind(addr).first();
    if (!row || row.owner_id !== viewer.user.id) return err(404, '邮箱不存在');
    if (row.protected) return err(400, '主地址不可删');
    const pol = cfg.byDomain[row.domain];
    if (pol && !pol.u_del) return err(403, '站长设置这个域名不能删掉重建');
    // 删邮箱连同它的邮件和附件一起真删（同一批落库）：不让「站上删了、库里还留着」白占 D1 空间
    const stmts = [
      db.prepare('DELETE FROM attachments WHERE mail_id IN (SELECT id FROM mails WHERE to_addr = ? AND owner_id = ?)').bind(addr, viewer.user.id),
      db.prepare('DELETE FROM mails WHERE to_addr = ? AND owner_id = ?').bind(addr, viewer.user.id),
      db.prepare('DELETE FROM addresses WHERE address = ?').bind(addr),
    ];
    if (row.bonus_used) {
      // 专属额度建的地址不占政策池（不写 tombstone）；返还开着就把专属额度退回本人
      if (pol && pol.u_refund) {
        stmts.push(db.prepare('UPDATE users SET bonus = bonus + 1 WHERE id = ?').bind(viewer.user.id));
      }
    } else if (pol && !pol.u_refund) {
      stmts.push(
        db
          .prepare(
            `INSERT INTO tombstones (owner_key, domain, kind, count) VALUES (?, ?, ?, 1)
             ON CONFLICT(owner_key, domain, kind) DO UPDATE SET count = count + 1`
          )
          .bind(`u:${viewer.user.id}`, row.domain, row.kind)
      );
    }
    await db.batch(stmts);
    return json({ ok: true, refund: pol ? !!pol.u_refund : true });
  }

  // ── 注册验证码 ──
  if (path === '/api/auth/send-code' && method === 'POST') {
    const ucRow0 = await db.prepare('SELECT COUNT(*) AS c FROM users').first().catch(() => null);
    if ((ucRow0?.c ?? 1) === 0) return err(400, '你是第一个注册的人，不需要验证码，直接点注册就行');
    if (cfg.regMode === 'off') return err(403, '站长已关闭注册');
    if (cfg.regMode === 'invite') return err(400, '当前是邀请码注册，不需要邮箱验证码');
    const body = (await readJson(request)) || {};
    const email = String(body.email || '').trim().toLowerCase();
    if (!EMAIL_RE.test(email)) return err(400, '先填一个正确的邮箱地址');
    const ip = clientIp(request);
    const now = Date.now();
    const last = await db
      .prepare('SELECT created_at FROM reg_codes WHERE email = ? ORDER BY created_at DESC LIMIT 1')
      .bind(email)
      .first();
    if (last && now - Number(last.created_at) < 60_000) return err(429, '验证码发得太勤了，稍等 1 分钟再发');
    const ipRow = await db
      .prepare('SELECT COUNT(*) AS c FROM reg_codes WHERE ip = ? AND created_at > ?')
      .bind(ip, now - 3600_000)
      .first();
    if ((ipRow?.c ?? 0) >= 10) return err(429, '这个网络发码太频繁，请过一小时再试');
    const from = systemFrom(cfg);
    if (!from) return err(500, '站长还没有添加邮箱域名，暂时无法注册');
    const code = randomDigits(6);
    const ins = await db
      .prepare('INSERT INTO reg_codes (email, code_hash, ip, attempts, expires_at, created_at) VALUES (?, ?, ?, 0, ?, ?)')
      .bind(email, await sha256Hex(code), ip, now + 10 * 60_000, now)
      .run();
    try {
      await sendViaResend(env, {
        from: `佲的邮箱 <${from}>`,
        to: email,
        subject: '佲的邮箱 · 注册验证码',
        text: `你的注册验证码是：${code}\n\n10 分钟内有效。如果不是你本人操作，请忽略这封邮件。`,
      });
    } catch (e) {
      await db.prepare('DELETE FROM reg_codes WHERE id = ?').bind(ins.meta.last_row_id).run().catch(() => {});
      // SendError 的文案是发信层专门写给用户看的，可直接回；非 SendError 的异常原文只进日志
      if (e instanceof SendError) return err(e.code === 'SEND_NOT_CONFIGURED' ? 501 : 502, e.message);
      console.error('reg code send error:', e && e.message ? e.message : e);
      return err(502, '验证码发送失败，请稍后再试');
    }
    return json({ ok: true });
  }

  // ── 注册 ──
  if (path === '/api/auth/register' && method === 'POST') {
    const body = (await readJson(request)) || {};
    // 第一个账号 = 站长：任何注册门（关注册/邀请码/邮箱验证码）都不挡它，
    // 保证谁刚部署完都能先给自己建站长号，不会被自己的门锁在外面。
    const cntRow = await db.prepare('SELECT COUNT(*) AS c FROM users').first();
    const isFirst = (cntRow?.c ?? 0) === 0;
    if (cfg.regMode === 'off' && !isFirst) return err(403, '站长已关闭注册，暂时注册不了');
    // 注册失败限速（对抗复读 C-37）：此前注册接口没有任何失败计数，按 IP 猜邀请码、
    // 枚举账号名都畅通无阻。现在按 IP 记失败（复用 rateFail），错 10 次锁 10 分钟；
    // 首账号（站长冷启动）不计不锁。计数范围：查重命中、邀请码不对/被用完、并发抢注
    // 冲突。两类不计：格式类校验错误（纯填错）；邮箱验证码不对——验证码本身已有
    // 「每码 5 次原子上限 + 10 分钟过期 + 发码频控」的更强单点防护，IP 层再叠加只会
    // 误伤同 IP（公司/校园 NAT）下错码后换新码的正常用户。注册成功后清掉计数。
    const regLockKey = `reg:${clientIp(request)}`;
    const regLockedMs = isFirst ? 0 : await rateLocked(db, regLockKey);
    if (regLockedMs > 0) {
      return err(429, `注册失败次数过多，请 ${Math.ceil(regLockedMs / 60000)} 分钟后再试`);
    }
    const regFail = async (status, message) => {
      if (!isFirst) await rateFail(db, regLockKey, 10, 10 * 60_000).catch(() => {});
      return err(status, message);
    };
    const username = String(body.username || '').trim();
    const password = String(body.password || '');
    const email = String(body.email || '').trim().toLowerCase();
    if (!/^[\w一-龥-]{2,20}$/.test(username)) return err(400, '账号名用 2-20 个字符（中英文、数字、下划线）');
    if (password.length < 8) return err(400, '密码至少 8 位');
    if (!EMAIL_RE.test(email)) return err(400, '注册要填真实邮箱（备份转发和找回都靠它）');
    // 查重文案合并（C-37 枚举防护）：账号名撞了还是邮箱撞了回同一句，不给枚举留口子
    const dupU = await db.prepare('SELECT id FROM users WHERE username = ?').bind(username).first();
    const dupE = dupU ? null : await db.prepare('SELECT id FROM users WHERE email = ?').bind(email).first();
    if (dupU || dupE) return regFail(400, '账号名或邮箱已被注册');

    // 邀请码只留一个输入框：站长发的注册码、或已注册用户的个人邀请码，填哪个都行。
    // 用站长码 = 直接注册，只享后台政策额度；用个人码 = 邀请人记名，注册成功后邀请人加专属额度。
    const codeIn = String(body.invite || body.referrer || '').trim().toUpperCase();
    let referrerId = 0;
    if (!isFirst) {
      if (cfg.regMode === 'email') {
        const code = String(body.code || '').trim();
        if (!code) return err(400, '填一下邮箱里收到的验证码');
        const row = await db
          .prepare('SELECT * FROM reg_codes WHERE email = ? AND expires_at > ? ORDER BY created_at DESC LIMIT 1')
          .bind(email, Date.now())
          .first();
        if (!row) return err(400, '验证码已失效，重新发一个吧');
        // 原子 claim（2026-11-18 审计核验 #5）：先占一次尝试名额再比对。
        // 旧写法先 SELECT 判 attempts>=5、错了才 +1，并发请求会同时读到
        // 同一个 attempts 一起过门，5 次上限被放大成 5×并发数。改成单条
        // 条件 UPDATE 占位（与下方邀请码分支同一范式）：占不到 = 名额已满。
        const claim = await db
          .prepare('UPDATE reg_codes SET attempts = attempts + 1 WHERE id = ? AND attempts < 5')
          .bind(row.id)
          .run();
        if (!claim.meta || claim.meta.changes === 0) return err(400, '验证码已失效，重新发一个吧');
        if ((await sha256Hex(code)) !== row.code_hash) {
          return err(400, '验证码不对');
        }
        await db.prepare('DELETE FROM reg_codes WHERE email = ?').bind(email).run();
        if (codeIn) {
          const inviter = await db.prepare('SELECT id FROM users WHERE invite_code = ?').bind(codeIn).first();
          if (inviter) referrerId = Number(inviter.id);
        }
      } else if (cfg.regMode === 'invite') {
        if (!codeIn) return err(400, '填一下邀请码（站长发的注册码，或已注册朋友的邀请码都行）');
        const inv = await db.prepare('SELECT * FROM invites WHERE code = ?').bind(codeIn).first();
        if (inv && Number(inv.left_uses) !== 0) {
          if (Number(inv.left_uses) > 0) {
            const upd = await db
              .prepare('UPDATE invites SET left_uses = left_uses - 1 WHERE code = ? AND left_uses > 0')
              .bind(codeIn)
              .run();
            if (!upd.meta || upd.meta.changes === 0) return regFail(400, '邀请码刚被用完，找站长再要一个');
          }
        } else {
          const inviter = await db.prepare('SELECT id FROM users WHERE invite_code = ?').bind(codeIn).first();
          if (!inviter) return regFail(400, '邀请码不对：填站长发的注册码，或已注册朋友的邀请码');
          referrerId = Number(inviter.id);
        }
      }
    }

    const isOwner = isFirst ? 1 : 0;
    const pwHash = await hashPassword(password);
    // 首账号原子化（2026-11-17 审计核验 #2）：isFirst 是「先查 COUNT 再 INSERT」，
    // 两个并发请求能同时读到 0、都写成站长。站长路径改单条条件 INSERT
    // （WHERE NOT EXISTS）——单条语句在 D1/SQLite 里原子执行，后到者 changes=0，
    // 回 409 让它刷新后走正常注册流程。产品行为不变：第一个账号仍是站长、仍免门槛，
    // 单人注册路径零变化。普通路径保留原 INSERT，唯一约束冲突转成友好报错。
    let ins;
    try {
      ins = isFirst
        ? await db
            .prepare('INSERT INTO users (username, email, pw_hash, is_owner, created_at) SELECT ?, ?, ?, 1, ? WHERE NOT EXISTS (SELECT 1 FROM users)')
            .bind(username, email, pwHash, Date.now())
            .run()
        : await db
            .prepare('INSERT INTO users (username, email, pw_hash, is_owner, created_at) VALUES (?, ?, ?, 0, ?)')
            .bind(username, email, pwHash, Date.now())
            .run();
    } catch {
      return regFail(400, '这个账号名或邮箱刚被别人抢先注册了，换一个吧');
    }
    if (isFirst && (!ins.meta || ins.meta.changes === 0)) {
      return err(409, '站长账号刚刚已被创建，请刷新后重新注册（将按正常注册流程）');
    }
    const newId = Number(ins.meta.last_row_id);
    // 个人邀请码 + 邀请奖励：注册时填了某位用户的个人码，邀请人加专属额度
    // （个数站长后台自填；一人只奖一次，referrals 唯一约束兜底）
    await ensureInviteCode(db, { id: newId, invite_code: '' }).catch(() => '');
    if (cfg.refBonus && cfg.refBonusN > 0 && referrerId && referrerId !== newId) {
      try {
        await db.prepare('INSERT INTO referrals (inviter_id, invitee_id, created_at) VALUES (?, ?, ?)').bind(referrerId, newId, Date.now()).run();
        await db.prepare('UPDATE users SET bonus = bonus + ? WHERE id = ?').bind(cfg.refBonusN, referrerId).run();
      } catch { /* 邀请奖励出问题不挡注册 */ }
    }
    if (!isFirst) await rateClear(db, regLockKey).catch(() => {});
    const { token, ttlSec } = await createDbSession(db, { userId: newId });
    return json({ ok: true, username, isOwner: !!isOwner }, 200, { 'Set-Cookie': sessionCookie(USER_COOKIE, token, ttlSec) });
  }

  // ── 登录 / 退出 ──
  if (path === '/api/auth/login' && method === 'POST') {
    const body = (await readJson(request)) || {};
    const username = String(body.username || '').trim();
    const password = String(body.password || '');
    const ip = clientIp(request);
    const lockKey = `login:${ip}:${username.toLowerCase()}`;
    const locked = await rateLocked(db, lockKey);
    if (locked > 0) return err(429, `登录失败次数过多，请 ${Math.ceil(locked / 60000)} 分钟后再试`);
    const user = await db.prepare('SELECT * FROM users WHERE username = ?').bind(username).first();
    // 计时拉平（对抗复读 C-38）：账号不存在时也对假哈希跑一次 verifyPassword，
    // 否则「不存在」瞬间返回、「密码错」要算完 PBKDF2 才返回，耗时差能枚举账号名。
    let okPw = false;
    if (user) okPw = await verifyPassword(password, user.pw_hash);
    else await verifyPassword(password, DUMMY_PW_HASH);
    if (!okPw) {
      await rateFail(db, lockKey, 5, 10 * 60_000);
      return err(401, '账号或密码不正确');
    }
    await rateClear(db, lockKey);
    const { token, ttlSec } = await createDbSession(db, { userId: user.id });
    return json({ ok: true, username: user.username }, 200, { 'Set-Cookie': sessionCookie(USER_COOKIE, token, ttlSec) });
  }
  if (path === '/api/auth/logout' && method === 'POST') {
    await destroyDbSession(db, request, USER_COOKIE);
    return json({ ok: true }, 200, { 'Set-Cookie': clearCookie(USER_COOKIE) });
  }

  // ── 个人设置 ──
  if (path === '/api/me/settings' && method === 'POST') {
    const nu = needUser();
    if (nu) return nu;
    const body = (await readJson(request)) || {};
    const u = viewer.user;
    const sets = [];
    const vals = [];
    if (typeof body.retention_days === 'number') {
      const d = Math.floor(body.retention_days);
      if (d < 0 || d > 3650) return err(400, '保留天数不对');
      if (cfg.userCap > 0 && (d === 0 || d > cfg.userCap)) {
        return err(400, `站长把最长保留设为 ${cfg.userCap} 天，你的选择要在这个范围内`);
      }
      sets.push('retention_days = ?');
      vals.push(d);
    }
    if (typeof body.tg_push === 'boolean') {
      sets.push('tg_push = ?');
      vals.push(body.tg_push ? 1 : 0);
    }
    if (typeof body.tg_chat_id === 'string') {
      sets.push('tg_chat_id = ?');
      vals.push(body.tg_chat_id.trim().slice(0, 32));
    }
    if (typeof body.forward_backup === 'boolean') {
      sets.push('forward_backup = ?');
      vals.push(body.forward_backup ? 1 : 0);
    }
    if (sets.length) {
      await db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).bind(...vals, u.id).run();
    }
    return json({ ok: true });
  }

  // ── 发信（登录用户，经 Resend） ──
  if (path === '/api/send' && method === 'POST') {
    const nu = needUser();
    if (nu) return nu;
    const body = (await readJson(request)) || {};
    const from = String(body.from || '').trim().toLowerCase();
    const to = String(body.to || '').trim();
    const subject = String(body.subject || '').trim();
    const text = String(body.text || '');
    if (!EMAIL_RE.test(to)) return err(400, '收件人格式不对');
    if (!subject) return err(400, '请填写主题');
    if (subject.length > 200 || text.length > 20000) return err(400, '内容太长了');
    const mine = await db.prepare('SELECT address FROM addresses WHERE address = ? AND owner_id = ?').bind(from, viewer.user.id).first();
    if (!mine) return err(403, '发件地址不是你的邮箱');
    // 按用户限速（2026-11-17 审计核验 #14）：Resend 免费额度全站共享（100 封/天），
    // 此前发信没有任何限速，任一注册用户就能把全站当天额度刷光、连带站长发不出信。
    // 双窗口计数（D1 rate_limits 表，与登录/发码限速同表不同键）：每小时 20 封、
    // 每天 50 封——个人邮箱的正常用量远低于此，够用且刷不满全站日额度的一半。
    // 站长豁免（与站内政策对站长豁免的既有惯例一致）。计数在发信前记，失败也计，
    // 防用失败重试绕过。
    if (!viewer.user.is_owner) {
      const uid = viewer.user.id;
      if ((await ratePeek(db, `send-h:${uid}`, 3600_000)) >= 20) return err(429, '发信太频繁：每小时最多 20 封，请稍后再发');
      if ((await ratePeek(db, `send-d:${uid}`, 24 * 3600_000)) >= 50) return err(429, '今天发信已达上限（每天 50 封），明天再发吧');
      await rateBump(db, `send-h:${uid}`, 3600_000);
      await rateBump(db, `send-d:${uid}`, 24 * 3600_000);
    }
    try {
      await sendViaResend(env, { from: `佲 <${from}>`, to, subject, text });
    } catch (e) {
      // 同上：SendError 文案可直接回，非 SendError 异常原文只进日志
      if (e instanceof SendError) return err(e.code === 'SEND_NOT_CONFIGURED' ? 501 : 502, e.message);
      console.error('send error:', e && e.message ? e.message : e);
      return err(502, '发信失败，请稍后再试');
    }
    await db
      .prepare(
        `INSERT INTO mails (to_addr, owner_id, from_addr, from_name, subject, text_body, html_body, otp, attachments, is_read, is_starred, folder, received_at)
         VALUES (?, ?, ?, '', ?, ?, '', NULL, '[]', 1, 0, 'sent', ?)`
      )
      .bind(to, viewer.user.id, from, subject, text, Date.now())
      .run();
    return json({ ok: true });
  }

  return err(404, '接口不存在');
}
