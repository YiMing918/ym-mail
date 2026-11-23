// 验证码提取：本系统的核心卖点，策略是「关键词锚定优先，无锚定时宁缺毋滥」。
// 误报（把年份、金额、日期当验证码）比漏报更烦人，所以无关键词时只认
// 独立出现的 6 位数字（最常见的验证码长度），且要排除金额/日期等场景。

const KEYWORD_RE =
  /(验证码|校验码|动态密码|动态码|安全码|确认码|驗證碼|一次性密码|一次性口令|verification\s*code|security\s*code|pass\s?code|one[-\s]?time|otp|pin\s*code|code)/gi;

// 在一段文本里找所有「独立成串」的 4-8 位纯数字（不属于更长数字串的一部分，
// 因此 11 位手机号、18 位身份证号、订单长号天然被排除）
function digitRuns(text) {
  const runs = [];
  const re = /(?<!\d)(\d{4,8})(?!\d)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    runs.push({ token: m[1], start: m.index, end: m.index + m[1].length });
  }
  return runs;
}

// 在一段文本里找字母+数字混合的 4-8 位令牌（如 A1B2C3），必须同时含字母和数字，
// 且不能是邮箱地址、URL、文件名的一部分
function alnumRuns(text) {
  const runs = [];
  const re = /(?<![A-Za-z0-9@._/-])(?=[A-Za-z0-9]{4,8}\b)(?=[A-Za-z0-9]*\d)(?=[A-Za-z0-9]*[A-Za-z])[A-Za-z0-9]{4,8}(?![A-Za-z0-9])/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    runs.push({ token: m[0], start: m.index, end: m.index + m[0].length });
  }
  return runs;
}

// 判断某个纯数字候选是否其实是年份/金额/日期的一部分
function looksLikeNoise(text, { token, start, end }, { anchored = false } = {}) {
  const before = text.slice(Math.max(0, start - 3), start);
  const after = text.slice(end, end + 3);
  // 后缀判断先去掉空白：「654321 元」这种数字与单位之间带空格的写法，
  // 不去空白会让 ^ 元 / ^ 年 的锚定全部落空、金额被当成验证码误报
  //（2026-11-23 全量审计复现：「退款 654321 元到账通知」误提 654321）。
  const afterT = after.trimStart();
  // 金额：前面带货币符号，或后面跟「元/块」
  if (/[¥￥$€£]$/.test(before.trimEnd()) || /^(元|块|圆)/.test(afterT)) return true;
  if (/(金额|总计|合计|支付|price|amount|total)[:：]?\s*$/i.test(before)) return true;
  // 日期：后面跟 年/月/日，或前面是 年/月
  if (/^[年月日]/.test(afterT) || /[年月]$/.test(before.trimEnd())) return true;
  // 4 位数字落在 1900-2099 多半是年份；有关键词锚定时放行（如 4 位 PIN 紧跟「验证码」）
  if (!anchored && token.length === 4) {
    const n = Number(token);
    if (n >= 1900 && n <= 2099) return true;
  }
  return false;
}

/**
 * 从一段文本中提取验证码，提取不到返回 null。
 */
export function extractOtp(text) {
  if (!text) return null;
  const src = String(text);

  // 第一步：关键词锚定。在每个关键词后面 32 个字符的窗口里找候选，
  // 数字优先，其次字母数字混合令牌。
  KEYWORD_RE.lastIndex = 0;
  let km;
  while ((km = KEYWORD_RE.exec(src)) !== null) {
    const winStart = km.index + km[0].length;
    const win = src.slice(winStart, winStart + 32);
    for (const cand of digitRuns(win)) {
      if (!looksLikeNoise(win, cand, { anchored: true })) return cand.token;
    }
    for (const cand of alnumRuns(win)) {
      return cand.token;
    }
  }

  // 第二步：无锚定兜底。只认独立出现的 6 位数字；
  // 短文本（<120 字，像专门发码的短信式邮件）时放宽到 4-8 位。
  const runs = digitRuns(src).filter((c) => !looksLikeNoise(src, c));
  const six = runs.find((c) => c.token.length === 6);
  if (six) return six.token;
  if (src.trim().length < 120 && runs.length > 0) return runs[0].token;
  return null;
}

/**
 * 从邮件的主题+正文中提取（主题里出现验证码的优先级最高）。
 */
export function extractOtpFromMail(subject, text) {
  return extractOtp(subject) || extractOtp(text);
}
