-- 佲的邮箱 · 正式版 D1 数据库结构（多用户公开服务）
-- 初始化：wrangler d1 execute ym-mail-db --remote --file=./schema.sql
--
-- 设计要点（省额度架构）：
-- * 会话存 sessions 表（token 只存 SHA-256 哈希），不用 KV。
-- * mails.owner_id 是收信时的归属快照：NULL = 游客/公开，数字 = 认领它的用户 id。
--   邮件可见性只看这一列，与 addresses 的增删解耦（删地址不删邮件，与预览行为一致）。
-- * policies.limit 编码：-1 = 不限量，0 = 一个都不能建（预览里的「0 个」），正数 = 上限个数。
-- * tombstones 记录「删了不返还」的占额：owner_key = 'guest'（全站游客共用一池）
--   或 'u:<user_id>'（每个注册用户各一份）。

-- ── 用户 ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  username       TEXT NOT NULL UNIQUE,
  email          TEXT NOT NULL UNIQUE,          -- 注册时验证过的真实邮箱（备份转发也发到这里）
  pw_hash        TEXT NOT NULL,                 -- PBKDF2-SHA256，见 src/auth.js
  retention_days INTEGER NOT NULL DEFAULT 90,   -- 自选保留天数：0 = 永不删；实际生效受站长上限约束
  tg_push        INTEGER NOT NULL DEFAULT 0,    -- Telegram 推送开关
  tg_chat_id     TEXT NOT NULL DEFAULT '',      -- 自己的 Telegram chat id（与站长 bot 配合用）
  forward_backup INTEGER NOT NULL DEFAULT 0,    -- 备份转发开关：新信抄送一份到 email
  is_owner       INTEGER NOT NULL DEFAULT 0,    -- 站长账号：不受个数/位数政策限制；首个注册账号自动置 1
  email_verified INTEGER NOT NULL DEFAULT 0,    -- 注册邮箱验过没：邮箱验证码/首账号 = 1，邀请码注册 = 0（未验不开备份转发，审计 M5）；注册代码永远显式写此列，默认值只兜底。老库迁移：ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 1（存量账号按已验证 grandfather，避免误伤已在用转发的人）
  bonus          INTEGER NOT NULL DEFAULT 0,    -- 专属额度（邀请奖励：邀请一人 +3，在域名政策上限之外叠加，建地址超额时抵用）
  invite_code    TEXT NOT NULL DEFAULT '',      -- 个人邀请码（别人注册时填它，奖励发给本人）
  created_at     INTEGER NOT NULL
);

-- ── 邀请奖励记录（一人被邀请只记一次，防重复发奖） ──
CREATE TABLE IF NOT EXISTS referrals (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  inviter_id INTEGER NOT NULL,                  -- 邀请人 users.id
  invitee_id INTEGER NOT NULL UNIQUE,           -- 被邀请的新用户 users.id
  created_at INTEGER NOT NULL
);

-- ── 邮箱地址 ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS addresses (
  address      TEXT PRIMARY KEY,                -- 完整地址（小写）
  domain       TEXT NOT NULL,
  prefix       TEXT NOT NULL,
  kind         TEXT NOT NULL DEFAULT 'custom',  -- custom = 自定义前缀 / random = 随机生成
  owner_id     INTEGER,                         -- NULL = 未认领（公开临时邮箱）；数字 = 认领者 users.id
  protected    INTEGER NOT NULL DEFAULT 0,      -- 1 = 不可删除（站长给自己的主地址用）
  bonus_used   INTEGER NOT NULL DEFAULT 0,      -- 1 = 这个地址是用专属额度抵的（删除/系统清理时按政策退回专属额度）
  created_at   INTEGER NOT NULL,
  last_mail_at INTEGER NOT NULL DEFAULT 0       -- 最近一封信的时间，随机地址闲置清理按它算
);
CREATE INDEX IF NOT EXISTS idx_addr_owner ON addresses (owner_id, domain, kind);
CREATE INDEX IF NOT EXISTS idx_addr_idle ON addresses (kind, last_mail_at);

-- ── 删了不返还的占额 ──────────────────────────────────
CREATE TABLE IF NOT EXISTS tombstones (
  owner_key TEXT NOT NULL,                      -- 'guest' 或 'u:<user_id>'
  domain    TEXT NOT NULL,
  kind      TEXT NOT NULL,                      -- custom / random
  count     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (owner_key, domain, kind)
);

-- ── 邮件 ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS mails (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  to_addr     TEXT NOT NULL,
  owner_id    INTEGER,                          -- 归属快照（见文件头说明）；已发送邮件存发信人 id
  from_addr   TEXT NOT NULL DEFAULT '',
  from_name   TEXT NOT NULL DEFAULT '',
  subject     TEXT NOT NULL DEFAULT '',
  text_body   TEXT NOT NULL DEFAULT '',
  html_body   TEXT NOT NULL DEFAULT '',
  otp         TEXT,                             -- 收信时提取好存这里，列表/验证码页直接用
  attachments TEXT NOT NULL DEFAULT '[]',       -- 元信息 JSON：[{filename, mimeType, size, stored}]
  is_read     INTEGER NOT NULL DEFAULT 0,
  is_starred  INTEGER NOT NULL DEFAULT 0,
  folder      TEXT NOT NULL DEFAULT 'inbox',    -- inbox / sent
  received_at INTEGER NOT NULL                  -- Unix 毫秒
);
CREATE INDEX IF NOT EXISTS idx_mails_owner_time ON mails (owner_id, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_mails_to ON mails (to_addr, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_mails_otp ON mails (owner_id, otp);

-- 附件内容（base64）：单附件 ≤512KB 才存，超限只留元信息、正文里注明
CREATE TABLE IF NOT EXISTS attachments (
  mail_id  INTEGER NOT NULL,
  idx      INTEGER NOT NULL,
  filename TEXT NOT NULL DEFAULT '',
  mime     TEXT NOT NULL DEFAULT 'application/octet-stream',
  data     TEXT NOT NULL,
  PRIMARY KEY (mail_id, idx)
);

-- ── 会话（D1，不用 KV） ───────────────────────────────
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,                  -- 只存 token 的 SHA-256
  user_id    INTEGER,                           -- 管理员会话为 NULL，靠 is_admin 区分
  is_admin   INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_exp ON sessions (expires_at);

-- ── 全站设置（键值） ──────────────────────────────────
-- guest_mode: 1 开 / 0 关（关 = 必须登录）
-- reg_mode:   'email' 邮箱验证 / 'invite' 邀请码 / 'off' 关闭注册
-- guest_days: 游客邮件保留天数（默认 1）
-- user_cap:   注册用户保留天数上限（默认 180；0 = 不限）
-- idle_days:  随机地址闲置清理天数（默认 7；0 = 不清理）
-- admin_tg_push: 站长自己的 TG 推送总开关（bot token/chat id 走环境变量）
-- mail_from:  系统发件地址（注册验证码用），部署后按主域名改，如 noreply@你的域名
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT ''
);
INSERT OR IGNORE INTO settings (key, value) VALUES
  ('guest_mode', '1'),
  ('reg_mode', 'email'),
  ('guest_days', '1'),
  ('user_cap', '180'),
  ('idle_days', '7'),
  ('admin_tg_push', '1'),
  ('ref_bonus', '1'),
  ('ref_bonus_n', '3'),
  ('mail_from', '');

-- ── 域名政策（一行 = 一个域名，两组：u = 注册用户 / g = 游客） ──
CREATE TABLE IF NOT EXISTS policies (
  domain    TEXT PRIMARY KEY,
  is_main   INTEGER NOT NULL DEFAULT 0,         -- 主域名不可删；第一个添加的域名自动为主域名
  u_open    INTEGER NOT NULL DEFAULT 1,
  u_custom  INTEGER NOT NULL DEFAULT 3,         -- -1 不限 / 0 不能建 / N 上限（下同）
  u_random  INTEGER NOT NULL DEFAULT 5,
  u_del     INTEGER NOT NULL DEFAULT 1,         -- 能否删掉重建
  u_refund  INTEGER NOT NULL DEFAULT 1,         -- 删后是否返还额度
  u_minlen  INTEGER NOT NULL DEFAULT 3,         -- 自定义前缀最少位数
  g_open    INTEGER NOT NULL DEFAULT 0,
  g_custom  INTEGER NOT NULL DEFAULT 1,
  g_random  INTEGER NOT NULL DEFAULT 1,
  g_del     INTEGER NOT NULL DEFAULT 1,
  g_refund  INTEGER NOT NULL DEFAULT 0,         -- 游客默认不返还（防刷名字，与预览一致）
  g_minlen  INTEGER NOT NULL DEFAULT 5,
  created_at INTEGER NOT NULL DEFAULT 0
);

-- ── 邀请码 ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS invites (
  code      TEXT PRIMARY KEY,                   -- 形如 YM-XXXXX（存大写）
  left_uses INTEGER NOT NULL DEFAULT 1,         -- -1 = 不限次，0 = 已用完
  created_at INTEGER NOT NULL
);

-- ── 注册验证码 ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS reg_codes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  email      TEXT NOT NULL,
  code_hash  TEXT NOT NULL,                     -- 6 位码的 SHA-256（配合次数上限与过期，库泄漏也不能直用）
  ip         TEXT NOT NULL DEFAULT '',
  attempts   INTEGER NOT NULL DEFAULT 0,        -- 猜错次数，≥5 作废
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reg_email ON reg_codes (email, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_reg_ip ON reg_codes (ip, created_at DESC);

-- ── 防护名单 ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS blacklist (
  pattern    TEXT PRIMARY KEY,                  -- 发件黑名单：完整邮箱 或 @域名（小写）
  created_at INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS banned (
  address    TEXT PRIMARY KEY,                  -- 封禁的收件地址（完整地址，小写）：不再收信
  created_at INTEGER NOT NULL DEFAULT 0
);

-- ── 速率限制（登录失败锁定、发码频控共用） ────────────
CREATE TABLE IF NOT EXISTS rate_limits (
  key        TEXT PRIMARY KEY,                  -- 如 login:<ip>:<账号> / code:<ip>
  count      INTEGER NOT NULL DEFAULT 0,
  lock_until INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0
);
