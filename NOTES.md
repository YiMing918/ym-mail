# NOTES · 正式版交付说明（给部署/维护时看）

## 完成度

交付物齐备，核心链路已在本地（wrangler dev + 本地 D1）实跑验证：

| 模块 | 状态 |
|---|---|
| schema.sql（13 张表） | ✅ 本地执行成功 |
| 前台 SPA（public/index.html + app.js） | ✅ 与预览 C 同视觉/文案/交互，全部改调真实 API |
| 后台（public/admin/ + admin.js） | ✅ 独立登录、政策/开关/清理/防护/邀请码全接真实 API |
| 用户 API（src/api.js） | ✅ 实测：bootstrap 打包、check、列表/详情/星标/多选删、地址创建/认领/删除、游客随机地址、注册（邀请码）、登录锁定、个人设置、发信未配置时 501 |
| 后台 API（src/admin.js） | ✅ 实测：登录（含错误密码拒绝）、加域名（首个自动主域名）、改政策、改设置、生成邀请码、黑名单增删 |
| 收信 email()（src/index.js） | ✅ 实测（注入法，见下）：解析入库、验证码收信时提取、归属快照正确、未知域名拒收、黑名单命中拒收不落库 |
| 认领锁定 | ✅ 实测：认领后游客立刻看不到该地址全部邮件（含历史），认领者可见 |
| 定时清理 scheduled() | ✅ 实测：游客过期删、用户过期删、**星标豁免**、随机地址闲置连地址带信删、自定义地址不删 |
| Origin 同源校验 | ✅ 实测：异源 POST 返回 403 |

## 本地测试方法（复现用）

```bash
npm install
cp wrangler.toml.example wrangler.toml   # 本地 database_id 可留占位
# .dev.vars 写：ADMIN_USER / ADMIN_PASSWORD_HASH（npm run hash -- '密码' 生成）
npm run db:init:local
npm run dev                               # http://localhost:8787
```
注意：这台机器上的 wrangler 3.x 不认 `run_worker_first` 数组写法（那是 wrangler 4 的），本地跑时把它临时改成 `true` 即可（功能等价，只是静态资源也过一遍 Worker）；部署时用 wrangler 4 + example 原样。

本地 `wrangler dev` 的 `/cdn-cgi/handler/email`、`/cdn-cgi/handler/scheduled` 在带 [assets] 配置时会被静态资源吞掉（404），没法直接测收信/清理。本次验证的做法：把代码复制到临时目录，在副本的 fetch 最前面加两个测试路由（`/__inject` 构造假的 ForwardableEmailMessage 调 `worker.email()`、`/__cron` 调 `worker.scheduled()`），对着副本自己的本地 D1 跑——测的是同一份 handler 代码，正式目录未留任何测试代码。上线后建议再用真实邮箱发一封测试信确认 Email Routing 投递。

## 未实测（依赖线上账号，按约束未碰）

- 真实 Email Routing 投递到 Worker（需域名在目标账号开 catch-all → 本 Worker）。
- Resend 真发信（注册验证码、用户发信）：未配 key 时已验证返回明确 501；配 key 后还需在 Resend 验证发信域名。
- 备份转发 `message.forward`：代码带 try/catch 容错已就位；真实成功需要转发目标先在 Email Routing「目标地址」里验证（README 第 7 步写了）。
- TG 推送：逻辑与单用户版已验证的实现一致（配 TG_BOT_TOKEN 才发）；本地未配 bot，未实发。

## 与预览 C 的差异（都是有意为之，部署前请知悉）

1. **邀请码模式也要填真实邮箱**：预览里邀请模式隐藏了邮箱，但正式版备份转发/找回都靠注册邮箱，所以保留邮箱输入（不验码，邀请码就是门槛）。
2. **用户 TG 推送多了 Chat ID 输入**：预览只有开关；正式版要真推送必须知道往哪推，所以「我的」设置里多了一行 Chat ID。站长自己的推送仍走环境变量 TG_BOT_TOKEN + TG_CHAT_ID。
3. **「已发送」入口**：以一颗 chip 放在收件箱筛选行最右（预览是独立视图概念，正式版并入同一列表切换）。
4. **发送验证码按钮加了 60 秒倒计时**（防重复发码，和服务端 60 秒频控对应）。
5. **站长主地址防误删**：靠 addresses.protected 标记（README 给了置 1 的 SQL）；普通用户的地址按政策 del 开关走，没有额外「主地址」概念。
6. **删域名 = 停用**：只删政策行，存量地址/邮件留库，重新添加同名域名即恢复（防误删丢数据）。
7. **Webhook 推送没做**：预览 C 已砍掉，正式版按预览取舍（单用户版里有，需要时可从 ym_mail_build 移植）。
8. **外部直投的陌生地址**：有人直接给一个从没建过的地址发信时，系统自动登记为「未认领的随机类地址」收下（任何人知道地址就能看，符合公开临时邮箱语义；闲置到期会随随机地址清理一起删）。

## 占位项清单（部署时替换/设置）

- `wrangler.toml`：由 example 复制，填 D1 的 `database_id`。
- Secret：`ADMIN_USER`、`ADMIN_PASSWORD_HASH`（必填），`RESEND_API_KEY`（发信用），`TG_BOT_TOKEN`（可选）；`TG_CHAT_ID` 写 wrangler.toml [vars]。
- 后台「系统发件地址」：留空默认 `noreply@<第一个域名>`，可在后台改。
- 域名：代码里没有任何写死域名；全部在后台「域名政策」里添加，第一个自动为主域名。

## 架构落点备忘

- 会话：随机 token → SHA-256 存 sessions 表，Cookie 只带原 token；用户/管理员两套 Cookie 分开（ymm_session / ymm_admin）。
- 配置缓存：settings+policies+blacklist+banned 一次 batch 读入进程内存（60 秒 TTL），管理员写操作立即失效本实例缓存；收信第一步纯内存判断名单，未知域名/封禁/黑名单在解析前就拒。
- 收信写库两段式：先 INSERT 邮件拿 id，再一个 batch 写附件 + 更新地址 last_mail_at（D1 batch 内取 last_row_id 不可靠，故如此）。
- 邮件可见性只看 mails.owner_id 快照；认领公开地址时一条 UPDATE 把其历史邮件快照一并迁移，锁定即时生效。
- 清理：cron 每天一次把 4 类删除（游客过期、用户过期含上限封顶与星标豁免、随机闲置、过期码/会话）拼成一个 batch 执行。
