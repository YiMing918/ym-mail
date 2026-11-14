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
  // href/src/xlink:href 里的 javascript: 与 data:text/html
  out = out.replace(
    /((?:href|src|xlink:href)\s*=\s*)("([^"]*)"|'([^']*)')/gi,
    (m, pre, quoted, dq, sq) => {
      const v = (dq ?? sq ?? '').trim().toLowerCase();
      if (v.startsWith('javascript:') || v.startsWith('data:text/html')) return `${pre}"#"`;
      return m;
    }
  );
  return out;
}
