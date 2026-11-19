#!/usr/bin/env node
// 生成密码的 PBKDF2 哈希（与 Worker 里 src/auth.js 同一套实现、同一种格式）。
// 用途：
//   1) 管理员密码哈希 → wrangler secret put ADMIN_PASSWORD_HASH
//   2) 排查/重置某个用户的密码哈希（直接更新 users.pw_hash）
// 审计 L15：密码别走命令行参数——参数会进 shell 历史和进程列表，谁都能看见。
// 推荐两种安全用法：
//   HASH_PASSWORD='你的密码' node scripts/hash-password.mjs        （环境变量）
//   node scripts/hash-password.mjs                                  （交互输入，不回显）
// 还兼容旧的参数用法，但会先打一行警告提醒你它不安全。
import { hashPassword } from '../src/auth.js';

async function readHidden(promptText) {
  process.stderr.write(promptText);
  const stdin = process.stdin;
  const wasRaw = stdin.isRaw;
  if (stdin.isTTY) stdin.setRawMode(true);
  let pw = '';
  try {
    for await (const chunk of stdin) {
      const s = String(chunk);
      for (const ch of s) {
        if (ch === '\n' || ch === '\r' || ch === '\u0004') {
          process.stderr.write('\n');
          return pw;
        }
        if (ch === '\u0003') throw new Error('已取消');
        if (ch === '\u007f') pw = pw.slice(0, -1);
        else pw += ch;
      }
    }
  } finally {
    if (stdin.isTTY) stdin.setRawMode(!!wasRaw);
  }
  return pw;
}

let pw = process.env.HASH_PASSWORD || '';
if (!pw && process.argv[2]) {
  console.error('⚠️ 警告：密码写在命令行参数里会进 shell 历史、也能被进程列表看到，不安全。下次请用 HASH_PASSWORD 环境变量或直接运行本脚本交互输入。');
  pw = process.argv[2];
}
if (!pw) {
  pw = await readHidden('请输入密码（输入时不显示）：');
}
if (!pw) {
  console.error("用法：HASH_PASSWORD='你的密码' node scripts/hash-password.mjs   或直接运行后按提示输入");
  process.exit(1);
}
console.log(await hashPassword(pw));
