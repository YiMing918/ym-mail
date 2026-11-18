// 邮件 HTML 轻量消毒。
// 注意：正则消毒只能作为第一道防线，前端展示时还会把 HTML 放进
// sandbox=""（不带 allow-scripts）的 iframe 里渲染，双保险防 XSS。

const DANGEROUS_TAGS = ['script', 'iframe', 'object', 'embed', 'form', 'base', 'link', 'meta', 'title', 'noscript'];

export function sanitizeHtml(html) {
  if (!html) return '';
  let out = String(html);
  // 去掉危险标签及其内容（script/style 类），其余危险标签只去标签本体
  out = out.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '');
  out = out.replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, '');
  for (const tag of DANGEROUS_TAGS) {
    out = out.replace(new RegExp(`<${tag}\\b[^>]*>`, 'gi'), '');
    out = out.replace(new RegExp(`</${tag}\\s*>`, 'gi'), '');
  }
  // 去掉所有事件处理器属性（onclick、onerror 等）和 srcdoc
  out = out.replace(/\s+on[a-zA-Z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');
  out = out.replace(/\s+srcdoc\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');
  // href/src/xlink:href 里的 javascript: 与 data:text/html（对抗复读 C-39）：
  // 旧正则只认带引号的属性值，无引号写法（href=javascript:...）直接漏网；
  // 且 scheme 比对前没解实体，&#106;avascript: 这类编码写法也能绕过。
  // 现在带引号/无引号都查，比对前先把实体解码、再去掉空白与控制字符
  // （浏览器解析 URL 时同样会忽略它们），命中危险 scheme 一律换成 #。
  out = out.replace(
    /((?:href|src|xlink:href)\s*=\s*)("[^"]*"|'[^']*'|[^\s>]+)/gi,
    (m, pre, raw) => {
      const v = raw.startsWith('"') || raw.startsWith("'") ? raw.slice(1, -1) : raw;
      const check = decodeEntities(v).replace(/[\u0000-\u0020]+/g, '').toLowerCase();
      if (check.startsWith('javascript:') || check.startsWith('data:text/html')) return `${pre}"#"`;
      return m;
    }
  );
  return out;
}

// 只为 scheme 安全比对服务的实体解码：数字实体（十进制/十六进制）+ 几个
// 浏览器会认的命名实体。不动原文，只生成比对用的副本。
function decodeEntities(v) {
  const cp = (n) => (n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '');
  return String(v)
    .replace(/&#x([0-9a-fA-F]+);?/gi, (_, h) => cp(parseInt(h, 16)))
    .replace(/&#(\d+);?/g, (_, d) => cp(parseInt(d, 10)))
    .replace(/&colon;/gi, ':')
    .replace(/&tab;/gi, '\t')
    .replace(/&newline;/gi, '\n');
}
