#!/usr/bin/env node
// 生成密码的 PBKDF2 哈希（与 Worker 里 src/auth.js 同一套实现、同一种格式）。
// 用途：
//   1) 管理员密码哈希 → wrangler secret put ADMIN_PASSWORD_HASH
//   2) 排查/重置某个用户的密码哈希（直接更新 users.pw_hash）
// 用法：node scripts/hash-password.mjs '你的密码'
import { hashPassword } from '../src/auth.js';

const pw = process.argv[2];
if (!pw) {
  console.error("用法：node scripts/hash-password.mjs '你的密码'");
  process.exit(1);
}
console.log(await hashPassword(pw));
