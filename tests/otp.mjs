// ym-mail 验证码提取回归测试（node tests/otp.mjs）
// 固化 v1.0.16 的修复（此前只在本地探针验过、没进仓库）：数字与单位之间带
// 空格时（「654321 元」），后缀判断要先去空白，否则金额会被误提成验证码。
// 口径与 src/otp.js 文件头一致：关键词锚定优先；无锚定时宁缺毋滥——
// 金额、日期、年份、长号码一律不提，正常验证码照常提取。
import { extractOtp, extractOtpFromMail} from '../src/otp.js';

let pass = 0, fail = 0;
function eq(name, got, want) {
if (got === want) { pass++; console.log(` ✓ ${name}`);}
else { fail++; console.log(` ✗ ${name}：期望 ${JSON.stringify(want)}，实际 ${JSON.stringify(got)}`);}
}

console.log('— 误报防护（应返回 null）—');
eq('带空格金额「退款 654321 元」不误提（v1.0.16 审计复现）', extractOtp('退款 654321 元到账通知，请注意查收'), null);
eq('紧贴金额「654321元」不误提', extractOtp('退款654321元已到账'), null);
eq('货币符号金额「¥123456」不误提', extractOtp('支付 ¥123456 成功，感谢使用'), null);
eq('金额词前缀「金额：123456 元」不误提', extractOtp('本次消费金额：123456 元，余额充足'), null);
eq('带空格日期「2026 年」不误提', extractOtp('您的会员有效期至 2026 年 12 月，请及时续费使用'), null);
eq('年份不误提', extractOtp('公司成立于 2008 年，是行业内的老牌企业'), null);
eq('11 位手机号不误提', extractOtp('如有疑问请拨打客服电话 13800138000 咨询'), null);
eq('空文本返回 null', extractOtp(''), null);
eq('无数字文本返回 null', extractOtp('这是一封普通的通知邮件，没有任何验证码'), null);

console.log('— 正常提取（应返回验证码）—');
eq('中文关键词锚定', extractOtp('您的验证码是 123456，请勿泄露给他人'), '123456');
eq('英文关键词锚定', extractOtp('Your verification code is 987654. It expires in 10 minutes.'), '987654');
eq('字母数字混合令牌', extractOtp('验证码：A1B2C3，五分钟内有效'), 'A1B2C3');
eq('无锚定独立 6 位数字兜底', extractOtp('包裹跟踪码 246810 将在包裹发出后激活，请留意物流更新通知'), '246810');
eq('主题优先于正文', extractOtpFromMail('验证码 111222', '正文里另有退款 654321 元的通知'), '111222');

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
if (fail) process.exit(1);
console.log('全部通过 ✓');
