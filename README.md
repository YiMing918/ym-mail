# 佲的邮箱 · 正式版（ym-mail）

多用户域名邮箱系统，跑在 Cloudflare 全免费额度上：**游客不用注册就能用临时邮箱收验证码，注册用户认领地址后锁定私有**，全部规则（谁能用哪个域名、能建几个、能不能删、保留多少天）由站长在独立后台 `/admin` 里定。

- 收信：Email Routing catch-all → Worker 解析入库 D1，**验证码在收信时就提取好**
- 发信：Resend（免费 100 封/天；注册验证码也走它）
- 会话：存 D1（不用 KV —— KV 写额度是全账号最紧的一档，这套系统一根手指都不碰它）
- 页面：静态资源托管，打开页面不消耗 Worker 请求额度

---

## 部署清单（从零到上线）

> 前提：一个 Cloudflare 账号、要用的域名、一个 Resend 账号。代码本身账号无关，部署到哪个账号都行；域名必须先作为 zone 存在于**同一个**账号里（Email Routing 跟着域名走，跨账号接不到信）。

### 1. 准备代码与依赖
```bash
npm install
cp wrangler.toml.example wrangler.toml
```

### 2. 建 D1 并初始化
```bash
npx wrangler d1 create ym-mail-db     # 把输出的 database_id 填进 wrangler.toml
npm run db:init                        # 远程建表（= wrangler d1 execute --remote --file=./schema.sql）
```

### 3. 设置 Secret（不要写进任何文件）
```bash
npx wrangler secret put ADMIN_USER            # 后台管理员账号，自己定
npm run hash -- '你的管理员密码'               # 生成 PBKDF2 哈希
npx wrangler secret put ADMIN_PASSWORD_HASH   # 把上一步的输出粘进去
npx wrangler secret put RESEND_API_KEY        # 发信要用；暂时不发信可跳过（发码/发信会返回明确报错，不崩）
# 可选（Telegram 推送）：
npx wrangler secret put TG_BOT_TOKEN
# TG_CHAT_ID 是普通变量，写在 wrangler.toml 的 [vars] 里
```

### 4. 部署 Worker
```bash
npx wrangler deploy
```
记下分配的地址（如 `ym-mail.<你的子域>.workers.dev`）。想用自己的域名访问，把它在 Cloudflare 控制台绑定为该 Worker 的自定义域（Workers → ym-mail → 设置 → 域和路由 → 添加自定义域）。

### 5. 每个邮箱域名开 Email Routing（每个域名都要做一遍）
在 Cloudflare 控制台选中该域名 → **Email（电子邮件）→ Email Routing**：
1. 启用 Email Routing（它会自动加好 MX/TXT 记录）；
2. 「目标地址」里添加并**验证**站长自己的常用邮箱（备份转发要用；验证邮件点一下链接即可）；
3. 「路由规则」→ **Catch-all** → 操作选 **发送到 Worker** → 选 `ym-mail` → 保存。

> 域名如果是在别家注册的，需要先把 NS 授权到这个 Cloudflare 账号、成为 zone，才能开 Email Routing。

### 6. 在 Resend 验证发信域名（发码/发信前必做）
Resend 控制台 → Domains → 添加你的邮箱域名 → 按提示给域名加 DKIM/SPF 记录（加在 Cloudflare DNS 里）→ 等状态变成 Verified。不验证的话 Resend 会拒发，接口会把拒绝原因原样提示出来。

### 7. 管理员初始化
1. 打开 `https://<你的地址>/admin`，用第 3 步的管理员账号密码登录；
2. 在「域名政策」里**添加你的域名**（第一个添加的自动成为主域名，不可删除）；
3. 按需要调政策：哪个域名开放给注册用户/游客、各自能建几个、游客保留天数、注册方式（默认邮箱验证）等；
4. 回到前台，用你自己的常用邮箱**注册第一个账号** —— 系统会自动把第一个注册账号标记为站长账号（不受个数/位数政策限制）；认领你自己的主地址后，在 D1 里把它的 `protected` 置 1 可防误删：
   ```sql
   UPDATE addresses SET protected = 1 WHERE address = '你的主地址';
   ```
5. 备份转发还差一步：每个开了备份转发的用户，其**注册邮箱**都要先在 Email Routing 的「目标地址」里验证过，转发才会成功（未验证时只会在日志里失败，不影响收信入库）。

### 8. 上线自检
- [ ] 往任意地址（如 test@你的域名）发一封带验证码的测试信 → 前台能看到、验证码自动提取
- [ ] 游客模式：不登录能生成临时地址、能看公开邮件
- [ ] 注册一遍（邮箱验证码能收到 / 邀请码能用）
- [ ] 认领一个公开地址 → 退出登录后看不到它的信
- [ ] 后台改一条政策 → 前台额度条立刻变
- [ ] 第二天看一眼 cron 有没有按保留天数清理（或等几天抽查）

---

## 额度自查表（免费额度下这套系统怎么花）

| 资源 | 免费额度（每账号每天） | 这套系统的花法 |
|---|---|---|
| Worker 请求 | 100,000 次 | 页面是静态资源不走 Worker；只有 API 算请求。打开站点 = 1 次 bootstrap，之后 30 秒一次 check（一条聚合 SQL），有新信才再拉列表 |
| Worker CPU | 10 ms/次 | 收信解析在 email handler 内完成；验证码提取是纯正则，开销小 |
| D1 读 | 5,000,000 行 | 列表只查摘要列（每页 30 条）；设置/政策/名单进程内缓存 60 秒，收信与 API 都不重复查 |
| D1 写 | 100,000 行 | 收信 = 邮件 1 行 + 附件行 + 地址活跃时间 1 次更新；登录写 1 行会话；失败登录才写计数行 |
| D1 容量 | 5 GB | 正文截断 10 万字；附件单个 ≤512KB 才存；每天 cron 按保留规则清 |
| KV | —— | **完全不用**。会话、设置、名单都在 D1 |
| Email Routing | 免费，无公布的日收信量上限 | catch-all 一条规则/域名；单封上限 25 MB |
| 定时任务 | 免费 | 每天 1 个 cron，一次 batch 做完游客过期/用户过期/随机闲置/过期码会话四类清理 |
| Resend | 100 封/天，3,000 封/月 | 注册验证码 + 用户发信；这是全系统最先见底的一项，人多了先升它 |

自查方法：Cloudflare 控制台 → Workers & Pages → 用量里看请求数；D1 → 选库看 Metrics；想看站内规模看后台顶部的用户/邮箱/今日收信三个数。

---

## 它跟同类有什么不同

- **认领锁定**：临时邮箱地址人人可见，但谁注册认领了就变私有（连历史邮件一起锁定），一个系统同时当公开临时邮箱和私人邮箱用。
- **政策细到域名 × 人群 × 地址种类**：每个域名对注册用户/游客分别定自定义与随机的个数、自定义前缀最少位数、能否删除、删后返不返额度。
- **验证码是一等公民**：收信即提取、独立验证码页、TG 推送里直接带码。
- **为免费额度而写**：不用 KV、设置全缓存、列表只拉摘要、清理一天一次批量 SQL。

## 优点

- 全免费跑（Cloudflare 免费额度 + Resend 免费档），无服务器、无月租。
- 部署物只有一个 Worker + 一个 D1 + 静态文件，迁移 = 换账号重跑部署清单。
- 代码与数据分离：仓库里没有任何域名、账号、用户数据；域名全部在后台动态管理。

## 缺点 / 已知限制（使用层面）

- **发信总量受 Resend 免费档限制**（100 封/天）：注册高峰时验证码可能排队，超了当天发不出。
- **备份转发有个前置条件**：转发目标（用户注册邮箱）必须先在 Cloudflare Email Routing 的目标地址里人工验证，陌生用户注册后不会自动完成，需要站长协助或用户配合点验证链接；没验证的就只有 TG/站内能看。
- **游客额度是全站共用一池**（和预览一致）：游客把某域名的随机地址占满后，其他游客在该域名就建不了新的，要等闲置清理或站长放宽。
- **HTML 邮件是沙箱 iframe 渲染**：个别排版怪异的营销邮件显示可能不完美；正文过长会截断（10 万字）。
- **附件只存 ≤512KB 的**：大附件只保留文件名信息，正文里会注明未保存。
- **改政策有最长 60 秒的跨实例延迟**：后台改完，本实例立刻生效；其他边缘实例最迟 60 秒内跟上（正常使用无感）。
- **删域名是停用不是清除**：存量地址和邮件保留在库里（防误删丢数据），重新添加同名域名即可恢复可见。

## 本地开发

```bash
npm install
cp wrangler.toml.example wrangler.toml        # database_id 本地可保留占位
# .dev.vars 里写本地用的 ADMIN_USER / ADMIN_PASSWORD_HASH（参考 README 第 3 步生成哈希）
npm run db:init:local
npm run dev                                     # http://localhost:8787，前台与 /admin 都可开
```
本地 `wrangler dev` 不会真的投递邮件（Email Routing 是线上功能）；收信链路的验证方式见 NOTES.md。需要 wrangler 4.x（`run_worker_first` 数组写法）。
