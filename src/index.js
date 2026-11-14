// 佲的邮箱 · 正式版 Worker 主入口（多用户公开服务）
// - fetch：/api/* 走 JSON 接口；/admin 返回后台页；其余交给静态资源（public/，免费不限量）
// - email：Email Routing catch-all → 内存黑名单判断 → postal-mime 解析 → 写库（邮件一插 + 附件 batch）
// - scheduled：每天一次，一批批量 SQL 做完全部清理
import PostalMime from 'postal-mime';
import { extractOtpFromMail } from './otp.js';
import { sanitizeHtml } from './sanitize.js';
import { handleApi } from './api.js';
import { handleAdminApi } from './admin.js';
import { loadConfig } from './config.js';
import { err, truncateBody, htmlToText, domOf, matchesBlacklist } from './util.js';

const ATT_ONE_MAX = 512 * 1024; // 单附件存库上限 512KB
const ATT_ALL_MAX = 1536 * 1024; // 单封附件存库总量上限

// ---------- Telegram 推送（可选：设置齐了才发，失败静默） ----------
async function pushTelegram(env, cfg, mail, owner) {
  try {
    const token = env.TG_BOT_TOKEN;
    if (!token) return;
    let chatId = '';
    if (owner && owner.tg_push && owner.tg_chat_id) chatId = owner.tg_chat_id;
    else if (env.TG_CHAT_ID && cfg.settings.admin_tg_push !== '0' && (!owner || owner.is_owner)) chatId = env.TG_CHAT_ID;
    if (!chatId) return;
    const lines = [
      '📬 佲的邮箱 · 新邮件',
      `收件：${mail.to_addr}`,
      `发件：${mail.from_name ? `${mail.from_name} <${mail.from_addr}>` : mail.from_addr}`,
      `主题：${mail.subject || '（无主题）'}`,
    ];
    if (mail.otp) lines.push(`🔑 验证码：${mail.otp}`);
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: lines.join('\n') }),
    });
  } catch {
    // 推送失败绝不影响收信入库
  }
}

// ---------- Worker 入口 ----------
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/admin' || url.pathname === '/admin/') {
      // 后台页在 public/admin/index.html；经 ASSETS 取带斜杠的路径，避免 .html 跳转来回绕
      return env.ASSETS.fetch(new Request(new URL('/admin/', url.origin), request));
    }
    if (url.pathname.startsWith('/api/admin/')) {
      return guardWrites(request, url, () => handleAdminApi(request, env, url));
    }
    if (url.pathname.startsWith('/api/')) {
      return guardWrites(request, url, () => handleApi(request, env, url));
    }
    // 非 API 路径全部交给静态资源（wrangler [assets]，不消耗 Worker 请求额度的方式托管）
    return env.ASSETS.fetch(request);
  },

  // Email Routing catch-all 把邮件转发到这里
  async email(message, env, ctx) {
    const cfg = await loadConfig(env);
    const toAddr = String(message.to || '').toLowerCase();
    const domain = domOf(toAddr);

    // 第一步：内存判断（不查库、不落库）——未知域名 / 封禁地址 / 发件黑名单直接拒收
    if (!cfg.byDomain[domain]) {
      message.setReject('Unknown domain');
      return;
    }
    if (cfg.banned.has(toAddr)) {
      message.setReject('Address banned by admin');
      return;
    }
    if (matchesBlacklist(message.from || '', cfg.blacklist)) {
      message.setReject('Blocked by recipient policy');
      return;
    }

    let parsed = {};
    try {
      parsed = PostalMime.parse
        ? await PostalMime.parse(message.raw)
        : await new PostalMime().parse(message.raw);
    } catch {
      parsed = {};
    }
    const fromAddr = parsed.from?.address || message.from || '';
    const fromName = parsed.from?.name || '';
    const subject = parsed.subject || '';
    // 解析后的真实发件人再过一次黑名单（信封发件人可能与头部不一致）
    if (matchesBlacklist(fromAddr, cfg.blacklist)) {
      message.setReject('Blocked by recipient policy');
      return;
    }

    let textBody = parsed.text || '';
    const htmlBody = sanitizeHtml(parsed.html || '');
    if (!textBody && htmlBody) textBody = htmlToText(htmlBody);
    const otp = extractOtpFromMail(subject, textBody); // 验证码收信时提取，存字段

    // 附件：单个 ≤512KB 才存内容；超限丢弃附件、只在正文末尾注明
    let attBudget = ATT_ALL_MAX;
    const attMeta = [];
    const attStore = [];
    const droppedNotes = [];
    (parsed.attachments || []).forEach((a, i) => {
      const size = a.content?.length ?? 0;
      let stored = false;
      if (a.content && size > 0 && size <= ATT_ONE_MAX && size <= attBudget) {
        let bin = '';
        const chunk = 0x8000;
        for (let s = 0; s < a.content.length; s += chunk) {
          bin += String.fromCharCode.apply(null, a.content.subarray(s, s + chunk));
        }
        attStore.push({
          idx: i,
          filename: a.filename || '未命名附件',
          mime: a.mimeType || 'application/octet-stream',
          data: btoa(bin),
        });
        attBudget -= size;
        stored = true;
      } else if (size > 0) {
        droppedNotes.push(`附件「${a.filename || '未命名附件'}」超过保存上限，未保存`);
      }
      attMeta.push({
        filename: a.filename || '未命名附件',
        mimeType: a.mimeType || 'application/octet-stream',
        size,
        stored,
      });
    });
    if (droppedNotes.length) textBody = `${textBody}\n\n［${droppedNotes.join('；')}］`;
    textBody = truncateBody(textBody);
    const safeHtml = truncateBody(htmlBody, true);
    const receivedAt = Date.now();

    // 地址行：存在则用它的归属；不存在（外部直投）自动建一行未认领的随机类地址
    let addrRow = await env.DB.prepare('SELECT * FROM addresses WHERE address = ?').bind(toAddr).first();
    if (!addrRow) {
      await env.DB.prepare(
        'INSERT OR IGNORE INTO addresses (address, domain, prefix, kind, owner_id, protected, created_at, last_mail_at) VALUES (?, ?, ?, ?, NULL, 0, ?, ?)'
      )
        .bind(toAddr, domain, toAddr.slice(0, toAddr.lastIndexOf('@')), 'random', receivedAt, receivedAt)
        .run();
      addrRow = { owner_id: null, kind: 'random' };
    }
    const ownerId = addrRow.owner_id ?? null;

    // 写库两段式：先插入邮件拿到 id，再把附件内容 + 地址活跃时间用一个 batch 写完
    const insRes = await env.DB.prepare(
      `INSERT INTO mails (to_addr, owner_id, from_addr, from_name, subject, text_body, html_body, otp, attachments, is_read, is_starred, folder, received_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 'inbox', ?)`
    )
      .bind(toAddr, ownerId, fromAddr, fromName, subject, textBody, safeHtml, otp, JSON.stringify(attMeta), receivedAt)
      .run();
    const mailId = insRes?.meta?.last_row_id;
    const tail = [];
    if (mailId) {
      for (const a of attStore) {
        tail.push(
          env.DB.prepare('INSERT INTO attachments (mail_id, idx, filename, mime, data) VALUES (?, ?, ?, ?, ?)')
            .bind(mailId, a.idx, a.filename, a.mime, a.data)
        );
      }
    }
    tail.push(env.DB.prepare('UPDATE addresses SET last_mail_at = ? WHERE address = ?').bind(receivedAt, toAddr));
    if (tail.length) await env.DB.batch(tail);

    // 归属者信息（推送/备份转发用）；未认领地址无后续动作
    let owner = null;
    if (ownerId !== null) {
      owner = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(ownerId).first();
    }
    const mail = { to_addr: toAddr, from_addr: fromAddr, from_name: fromName, subject, otp, received_at: receivedAt };
    ctx.waitUntil(pushTelegram(env, cfg, mail, owner));
    // 备份转发：抄送一份到归属者注册邮箱（该地址需先在 Email Routing 里验证为目标地址；
    // 失败只记日志，绝不影响入库）
    if (owner && owner.forward_backup && owner.email) {
      try {
        await message.forward(owner.email);
      } catch (e) {
        console.log('backup forward failed:', e?.message || e);
      }
    }
  },

  // 每天一次：一批批量 SQL 做完全部清理
  async scheduled(event, env, ctx) {
    const cfg = await loadConfig(env, true);
    const now = Date.now();
    const dayMs = 24 * 3600 * 1000;
    const db = env.DB;
    const stmts = [];

    // 1) 游客邮件过期（游客无星标豁免，与预览一致）
    if (cfg.guestDays > 0) {
      const cutoff = now - cfg.guestDays * dayMs;
      stmts.push(db.prepare('DELETE FROM attachments WHERE mail_id IN (SELECT id FROM mails WHERE owner_id IS NULL AND received_at < ?)').bind(cutoff));
      stmts.push(db.prepare('DELETE FROM mails WHERE owner_id IS NULL AND received_at < ?').bind(cutoff));
    }
    // 2) 注册用户邮件过期：按各自保留天数（0 = 永不删），站长上限封顶，星标豁免
    //    有效天数 = 用户自选；若站长上限 >0：自选为 0 或超过上限的一律按上限算
    stmts.push(
      db.prepare(
        `DELETE FROM attachments WHERE mail_id IN (
           SELECT m.id FROM mails m JOIN users u ON u.id = m.owner_id
           WHERE m.owner_id IS NOT NULL AND m.is_starred = 0
             AND (CASE WHEN ? > 0 THEN MIN(CASE WHEN u.retention_days = 0 THEN ? ELSE u.retention_days END, ?)
                       ELSE u.retention_days END) > 0
             AND m.received_at < ? - (CASE WHEN ? > 0 THEN MIN(CASE WHEN u.retention_days = 0 THEN ? ELSE u.retention_days END, ?)
                       ELSE u.retention_days END) * ?)`
      ).bind(cfg.userCap, cfg.userCap, cfg.userCap, now, cfg.userCap, cfg.userCap, cfg.userCap, dayMs)
    );
    stmts.push(
      db.prepare(
        `DELETE FROM mails WHERE id IN (
           SELECT m.id FROM mails m JOIN users u ON u.id = m.owner_id
           WHERE m.owner_id IS NOT NULL AND m.is_starred = 0
             AND (CASE WHEN ? > 0 THEN MIN(CASE WHEN u.retention_days = 0 THEN ? ELSE u.retention_days END, ?)
                       ELSE u.retention_days END) > 0
             AND m.received_at < ? - (CASE WHEN ? > 0 THEN MIN(CASE WHEN u.retention_days = 0 THEN ? ELSE u.retention_days END, ?)
                       ELSE u.retention_days END) * ?)`
      ).bind(cfg.userCap, cfg.userCap, cfg.userCap, now, cfg.userCap, cfg.userCap, cfg.userCap, dayMs)
    );
    // 3) 随机地址闲置清理：连地址带信一起删，额度自然返还（不写 tombstone）；自定义地址不删
    //    「闲置」两种都算：收到过信的按最后一封信的时间算；从没收到过信的按建立时间算
    //    ——否则领了不用的随机地址永远删不掉，只攒不减白占地方。
    if (cfg.idleDays > 0) {
      const cutoff = now - cfg.idleDays * dayMs;
      const idlePred = "kind = 'random' AND ((last_mail_at > 0 AND last_mail_at < ?) OR (last_mail_at = 0 AND created_at < ?))";
      const idleSel = `SELECT address FROM addresses WHERE ${idlePred}`;
      // 用专属额度建的随机地址被系统清理：专属额度退回主人（系统清理返还，与用户自删的政策开关无关）
      stmts.push(
        db.prepare(
          `UPDATE users SET bonus = bonus + (SELECT COUNT(*) FROM addresses a WHERE a.owner_id = users.id AND a.bonus_used = 1 AND a.address IN (${idleSel}))
           WHERE id IN (SELECT owner_id FROM addresses WHERE bonus_used = 1 AND owner_id IS NOT NULL AND address IN (${idleSel}))`
        ).bind(cutoff, cutoff, cutoff, cutoff)
      );
      stmts.push(
        db.prepare(`DELETE FROM attachments WHERE mail_id IN (SELECT id FROM mails WHERE to_addr IN (${idleSel}))`).bind(cutoff, cutoff)
      );
      stmts.push(
        db.prepare(`DELETE FROM mails WHERE to_addr IN (${idleSel})`).bind(cutoff, cutoff)
      );
      stmts.push(db.prepare(`DELETE FROM addresses WHERE ${idlePred}`).bind(cutoff, cutoff));
    }
    // 4) 过期注册码 / 过期会话 / 陈旧速率记录
    stmts.push(db.prepare('DELETE FROM reg_codes WHERE expires_at < ?').bind(now));
    stmts.push(db.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(now));
    stmts.push(db.prepare('DELETE FROM rate_limits WHERE updated_at < ? AND lock_until < ?').bind(now - 7 * dayMs, now));

    if (stmts.length) await db.batch(stmts);
  },
};

// Cookie 鉴权的写操作做 Origin 同源校验（与 ym-cf-panel 同款防护）；
// /api/admin/login 也在内（它本身就是写操作）。
async function guardWrites(request, url, handler) {
  if (request.method === 'POST' || request.method === 'DELETE' || request.method === 'PUT') {
    const origin = request.headers.get('Origin');
    if (origin) {
      let originHost = '';
      try {
        originHost = new URL(origin).host;
      } catch {
        /* 坏 Origin 直接拒 */
      }
      if (originHost !== url.host) return err(403, '请求来源不合法');
    }
  }
  try {
    return await handler();
  } catch (e) {
    return err(500, `服务器错误：${e.message}`);
  }
}
