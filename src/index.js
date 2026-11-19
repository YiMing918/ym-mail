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

// ---------- 全站安全头（审计 M10） ----------
// 此前全站没有统一安全头，只有附件响应自带 CSP/nosniff。现在 fetch 出口
// 统一补：nosniff、Referrer-Policy、X-Frame-Options 与一条克制的 CSP。
// CSP 按本站实际用法定的：脚本/样式只许同源外链文件（页面无内联 <script>，
// 但有大量 style 属性，故 style-src 带 'unsafe-inline' 只放行样式属性、
// 不放行脚本）；图片放行 data:/https:（邮件里远程图片与内嵌图要显示）；
// frame-ancestors 'none' 防本站被别站嵌套钓鱼。已有更严 CSP 的响应
// （附件的 default-src 'none'; sandbox）不覆盖。
const SITE_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data: blob: https:; font-src 'self' data:; connect-src 'self'; " +
  "object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'";
function withSecurityHeaders(resp) {
  try {
    const out = new Response(resp.body, resp);
    if (!out.headers.has('X-Content-Type-Options')) out.headers.set('X-Content-Type-Options', 'nosniff');
    if (!out.headers.has('Referrer-Policy')) out.headers.set('Referrer-Policy', 'same-origin');
    if (!out.headers.has('X-Frame-Options')) out.headers.set('X-Frame-Options', 'DENY');
    if (!out.headers.has('Content-Security-Policy')) out.headers.set('Content-Security-Policy', SITE_CSP);
    return out;
  } catch {
    return resp;
  }
}

// ---------- Worker 入口 ----------
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/admin' || url.pathname === '/admin/') {
      // 后台页在 public/admin/index.html；经 ASSETS 取带斜杠的路径，避免 .html 跳转来回绕
      return withSecurityHeaders(await env.ASSETS.fetch(new Request(new URL('/admin/', url.origin), request)));
    }
    if (url.pathname.startsWith('/api/admin/')) {
      return withSecurityHeaders(await guardWrites(request, url, () => handleAdminApi(request, env, url)));
    }
    if (url.pathname.startsWith('/api/')) {
      return withSecurityHeaders(await guardWrites(request, url, () => handleApi(request, env, url)));
    }
    // 非 API 路径全部交给静态资源（wrangler [assets]，不消耗 Worker 请求额度的方式托管）
    return withSecurityHeaders(await env.ASSETS.fetch(request));
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

    // 地址行：存在则用它的归属；不存在（外部直投）要自动建一行未认领的随机类
    // 地址——但建址必须排在全部软闸之后（审计高危 B2 修复）：旧写法先建址再
    // 过单地址闸，攻击者换着新地址直投，每封信都新建一行地址、单地址计数恒
    // 为 0，D1 被无限建址耗尽。现在顺序是：先过单地址闸 → 再过全站闸 → 才建址。
    let addrRow = await env.DB.prepare('SELECT * FROM addresses WHERE address = ?').bind(toAddr).first();
    let ownerId = addrRow ? (addrRow.owner_id ?? null) : null;

    // 收信软闸（对抗复读 C-14 + 审计 B2）：此前收信侧完全不限量，一个地址被刷信能把 D1 写
    // 额度/存储打满，连带全站收不了信。用一条聚合查询顺带数清（不额外加写）：
    // 同一地址一小时内落库达上限（默认 100）、或未认领单地址存信达上限（默认 500）
    // 就静默丢弃——不 setReject，不打扰正常发信方；阈值在 settings 里可调、0 = 关。
    // 单地址闸只看 mails 表（按 to_addr 数），地址行还没建时同样生效。
    const recvHourly = cfg.recvAddrHourly ?? 100;
    const recvUnclaimedMax = cfg.recvUnclaimedMax ?? 500;
    if (recvHourly > 0 || (ownerId === null && recvUnclaimedMax > 0)) {
      const cnt = await env.DB.prepare(
        `SELECT COUNT(*) AS total_n, COALESCE(SUM(CASE WHEN received_at > ? THEN 1 ELSE 0 END), 0) AS hour_n
         FROM mails WHERE to_addr = ? AND folder = 'inbox'`
      )
        .bind(receivedAt - 3600_000, toAddr)
        .first()
        .catch(() => null);
      if (cnt) {
        if (recvHourly > 0 && Number(cnt.hour_n) >= recvHourly) return;
        if (ownerId === null && recvUnclaimedMax > 0 && Number(cnt.total_n) >= recvUnclaimedMax) return;
      }
    }

    if (!addrRow) {
      // 全站未认领总量闸（审计 B2）：全站未认领地址总数达到上限（默认 500，
      // 与单地址存信上限共用 recv_unclaimed_max 设置）时，对「新地址」静默
      // 丢弃、不再建新行；老地址（已建行）照常收信，不受这道闸影响。这道闸
      // 同时兜住审计 M9：入站直投自动建的地址不再无限占游客共用池。
      if (recvUnclaimedMax > 0) {
        const g = await env.DB.prepare('SELECT COUNT(*) AS c FROM addresses WHERE owner_id IS NULL')
          .first()
          .catch(() => null);
        if (g && Number(g.c) >= recvUnclaimedMax) return;
      }
      await env.DB.prepare(
        'INSERT OR IGNORE INTO addresses (address, domain, prefix, kind, owner_id, protected, created_at, last_mail_at) VALUES (?, ?, ?, ?, NULL, 0, ?, ?)'
      )
        .bind(toAddr, domain, toAddr.slice(0, toAddr.lastIndexOf('@')), 'random', receivedAt, receivedAt)
        .run();
      addrRow = { owner_id: null, kind: 'random' };
      ownerId = null;
    }

    // 写库两段式：先插入邮件拿到 id，再把附件内容 + 地址活跃时间用一个 batch 写完
    const insRes = await env.DB.prepare(
      `INSERT INTO mails (to_addr, owner_id, from_addr, from_name, subject, text_body, html_body, otp, attachments, is_read, is_starred, folder, received_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 'inbox', ?)`
    )
      .bind(toAddr, ownerId, fromAddr, fromName, subject, textBody, safeHtml, otp, JSON.stringify(attMeta), receivedAt)
      .run();
    const mailId = insRes?.meta?.last_row_id;
    // 归属对账（对抗复读 C-8）：地址归属是上面读到的快照，若在快照读完到这封信
    // 落库之间地址刚被用户认领，这封信会带着 owner_id=NULL 掉进公开池（认领的
    // 迁移只迁当时已有的信）。落库后补查一次地址行现值，不一致就把刚插的这封
    // 补正给认领者；只对快照为未认领的信多花一读一写（认领是低频事件，且只有
    // 真被认领走的那一封才触发写），已认领地址的日常收信零额外开销。
    if (mailId && ownerId === null) {
      const fresh = await env.DB.prepare('SELECT owner_id FROM addresses WHERE address = ?')
        .bind(toAddr)
        .first()
        .catch(() => null);
      if (fresh && fresh.owner_id !== null && fresh.owner_id !== undefined) {
        const fix = await env.DB.prepare('UPDATE mails SET owner_id = ? WHERE id = ? AND owner_id IS NULL')
          .bind(fresh.owner_id, mailId)
          .run()
          .catch(() => null);
        if (fix && fix.meta && fix.meta.changes > 0) ownerId = fresh.owner_id;
      }
    }
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
    // 审计 M5 低风险收口：注册邮箱没验过的账号（邀请码注册、email_verified=0）
    // 不抄送——防冒用他人邮箱注册后把信往那个邮箱灌。字段不存在（老库未迁
    // 移）时值为 undefined、照常转发（存量账号不受影响）；迁移办法见 README。
    if (owner && owner.forward_backup && owner.email && owner.email_verified !== 0) {
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
    //    审计 M1 修复：谓词加 owner_id IS NULL——只清未认领的随机地址。旧谓词
    //    不看认领状态，已被注册用户认领的随机地址闲置满期会连星标信一起删，
    //    与「已认领/自定义地址永不被闲置清理删」的产品口径打架。加上这条后，
    //    下方专属额度退还语句对闲置清理自然变成空转（已认领地址不再进清理集），
    //    保留语句不删，避免改动批次结构。
    if (cfg.idleDays > 0) {
      const cutoff = now - cfg.idleDays * dayMs;
      const idlePred = "kind = 'random' AND owner_id IS NULL AND ((last_mail_at > 0 AND last_mail_at < ?) OR (last_mail_at = 0 AND created_at < ?))";
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
    // 内部异常原文（D1 表名/约束名等实现细节）只进日志，对外只回笼统文案（与 ym-dash 同口径）
    console.error('guardWrites handler error:', e && e.message ? e.message : e);
    return err(500, '服务器错误，请稍后再试');
  }
}
