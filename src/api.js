// 用户端 API：注册/登录（D1 会话）、bootstrap 打包、邮件、地址、发信、个人设置。
// 省额度要点：
// * 首屏只打 /api/bootstrap 一次；轮询只打 /api/check（一条聚合 SQL）。
// * 列表只查摘要列，正文/附件点开才拉。
// * 可见性一律按 mails.owner_id 快照判断（收信时写入，认领时一次性迁移），查询简单稳定。
import {
  hashPassword, verifyPassword, sha256Hex, randomDigits,
  createDbSession, getDbSession, destroyDbSession,
  USER_COOKIE, sessionCookie, clearCookie, randomAddressPrefix,
} from './auth.js';
import { loadConfig, policyForClient } from './config.js';
import { sendViaResend, systemFrom, SendError } from './send.js';
import {
  json, err, readJson, clientIp, domOf, prefixOf,
  EMAIL_RE, PREFIX_RE, rateLocked, rateFail, rateClear,
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
     ORDER BY a.created_at ASC LIMIT 200`
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
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const buf = new Uint32Array(5);
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
  if (useBonus) {
    const dec = await env.DB.prepare('UPDATE users SET bonus = bonus - 1 WHERE id = ? AND bonus > 0').bind(user.id).run();
    if (!dec.meta || dec.meta.changes === 0) useBonus = 0;
    if (!useBonus) return { error: [403, '专属额度刚刚用完了'] };
  }
  try {
    if (existing) {
      // 认领公开地址：连同历史邮件一起锁定给认领者（一次性迁移归属快照）
      await env.DB.batch([
        env.DB.prepare('UPDATE addresses SET owner_id = ?, kind = ?, bonus_used = ? WHERE address = ?').bind(user.id, kind, useBonus, addr),
        env.DB.prepare('UPDATE mails SET owner_id = ? WHERE to_addr = ? AND owner_id IS NULL').bind(user.id, addr),
      ]);
    } else {
      await env.DB.prepare(
        'INSERT INTO addresses (address, domain, prefix, kind, owner_id, protected, bonus_used, created_at, last_mail_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?, 0)'
      )
        .bind(addr, domain, prefix, kind, user.id, useBonus, now)
        .run();
    }
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
    const gb = guestBlocked();
    if (gb) {
      // 游客模式关闭时也返回公开设置，让前端能正确提示并引导登录/注册
      return json({
        ok: true, mode: 'guest', user: null, guestBlocked: true,
        settings: { guest_mode: false, reg_mode: cfg.regMode, guest_days: cfg.guestDays, user_cap: cfg.userCap, idle_days: cfg.idleDays },
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
    const inline = url.searchParams.get('inline') === '1' && /^image\//i.test(row.mime || '');
    return new Response(bytes, {
      headers: {
        'Content-Type': row.mime || 'application/octet-stream',
        'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(row.filename || 'attachment')}`,
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
    const stmts = [db.prepare('DELETE FROM addresses WHERE address = ?').bind(addr)];
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
      return err(e instanceof SendError && e.code === 'SEND_NOT_CONFIGURED' ? 501 : 502, e.message);
    }
    return json({ ok: true });
  }

  // ── 注册 ──
  if (path === '/api/auth/register' && method === 'POST') {
    if (cfg.regMode === 'off') return err(403, '站长已关闭注册，暂时注册不了');
    const body = (await readJson(request)) || {};
    const username = String(body.username || '').trim();
    const password = String(body.password || '');
    const email = String(body.email || '').trim().toLowerCase();
    if (!/^[\w一-龥-]{2,20}$/.test(username)) return err(400, '账号名用 2-20 个字符（中英文、数字、下划线）');
    if (password.length < 8) return err(400, '密码至少 8 位');
    if (!EMAIL_RE.test(email)) return err(400, '注册要填真实邮箱（备份转发和找回都靠它）');
    const dupU = await db.prepare('SELECT id FROM users WHERE username = ?').bind(username).first();
    if (dupU) return err(400, '这个账号名已被注册');
    const dupE = await db.prepare('SELECT id FROM users WHERE email = ?').bind(email).first();
    if (dupE) return err(400, '这个邮箱已经注册过账号了，一个邮箱只能注册一个');

    if (cfg.regMode === 'email') {
      const code = String(body.code || '').trim();
      if (!code) return err(400, '填一下邮箱里收到的验证码');
      const row = await db
        .prepare('SELECT * FROM reg_codes WHERE email = ? AND expires_at > ? ORDER BY created_at DESC LIMIT 1')
        .bind(email, Date.now())
        .first();
      if (!row || row.attempts >= 5) return err(400, '验证码已失效，重新发一个吧');
      if ((await sha256Hex(code)) !== row.code_hash) {
        await db.prepare('UPDATE reg_codes SET attempts = attempts + 1 WHERE id = ?').bind(row.id).run();
        return err(400, '验证码不对');
      }
      await db.prepare('DELETE FROM reg_codes WHERE email = ?').bind(email).run();
    } else if (cfg.regMode === 'invite') {
      const codeIn = String(body.invite || '').trim().toUpperCase();
      if (!codeIn) return err(400, '填一下站长给你的邀请码');
      const inv = await db.prepare('SELECT * FROM invites WHERE code = ?').bind(codeIn).first();
      if (!inv || Number(inv.left_uses) === 0) return err(400, '邀请码不对，或已被用完');
      if (Number(inv.left_uses) > 0) {
        const upd = await db
          .prepare('UPDATE invites SET left_uses = left_uses - 1 WHERE code = ? AND left_uses > 0')
          .bind(codeIn)
          .run();
        if (!upd.meta || upd.meta.changes === 0) return err(400, '邀请码刚被用完，找站长再要一个');
      }
    }

    const countRow = await db.prepare('SELECT COUNT(*) AS c FROM users').first();
    const isOwner = (countRow?.c ?? 0) === 0 ? 1 : 0;
    const pwHash = await hashPassword(password);
    const ins = await db
      .prepare('INSERT INTO users (username, email, pw_hash, is_owner, created_at) VALUES (?, ?, ?, ?, ?)')
      .bind(username, email, pwHash, isOwner, Date.now())
      .run();
    const newId = Number(ins.meta.last_row_id);
    // 个人邀请码 + 邀请奖励：注册时填了邀请人的码，邀请人 +3 专属额度（一人只奖一次，referrals 唯一约束兜底）
    await ensureInviteCode(db, { id: newId, invite_code: '' }).catch(() => '');
    if (cfg.refBonus && cfg.refBonusN > 0) {
      const ref = String(body.referrer || '').trim().toUpperCase();
      if (ref) {
        try {
          const inviter = await db.prepare('SELECT id FROM users WHERE invite_code = ?').bind(ref).first();
          if (inviter && Number(inviter.id) !== newId) {
            await db.prepare('INSERT INTO referrals (inviter_id, invitee_id, created_at) VALUES (?, ?, ?)').bind(Number(inviter.id), newId, Date.now()).run();
            await db.prepare('UPDATE users SET bonus = bonus + ? WHERE id = ?').bind(cfg.refBonusN, Number(inviter.id)).run();
          }
        } catch { /* 邀请奖励出问题不挡注册 */ }
      }
    }
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
    const okPw = user && (await verifyPassword(password, user.pw_hash));
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
    try {
      await sendViaResend(env, { from: `佲 <${from}>`, to, subject, text });
    } catch (e) {
      return err(e instanceof SendError && e.code === 'SEND_NOT_CONFIGURED' ? 501 : 502, e.message);
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
