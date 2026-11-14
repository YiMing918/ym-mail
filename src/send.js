// 发信：统一走 Resend（注册验证码与用户发信共用）。
// RESEND_API_KEY 缺失时抛带 code 的明确错误，由 API 层转成给用户看的提示，绝不崩溃。
// 注意：发件域名必须先在 Resend 控制台验证通过，否则 Resend 会拒绝（部署清单里有这一步）。

export class SendError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

export async function sendViaResend(env, { from, to, subject, text }) {
  if (!env.RESEND_API_KEY) {
    throw new SendError('站长尚未配置发信通道（RESEND_API_KEY），暂时发不了信', 'SEND_NOT_CONFIGURED');
  }
  let res;
  try {
    res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from, to, subject, text }),
    });
  } catch {
    throw new SendError('发信通道连接失败，请稍后再试', 'SEND_NETWORK');
  }
  if (!res.ok) {
    let detail = '';
    try {
      const j = await res.json();
      detail = j?.message || '';
    } catch { /* 忽略 */ }
    throw new SendError(`发信被 Resend 拒绝（HTTP ${res.status}）${detail ? '：' + detail : ''}`, 'SEND_REJECTED');
  }
  return true;
}

// 系统发件地址：优先 settings.mail_from，其次 noreply@<最早添加的域名>
export function systemFrom(cfg) {
  const f = cfg.settings.mail_from;
  if (f) return f;
  if (cfg.policies.length) return `noreply@${cfg.policies[0].domain}`;
  return '';
}
