// 邮件 HTML 轻量消毒。
// 注意：正则消毒只能作为第一道防线，前端展示时还会把 HTML 放进
// sandbox=""（不带 allow-scripts）的 iframe 里渲染，双保险防 XSS。

const DANGEROUS_TAGS = [
  'script', 'iframe', 'object', 'embed', 'form', 'base', 'link', 'meta', 'title', 'noscript',
  // 审计 M7 补漏：svg/math 可内嵌脚本与外链、template 内容可被页面脚本激活、
  // 音视频/表单控件标签可带危险属性或钓鱼内容，一并剥除
  'svg', 'math', 'template', 'audio', 'video', 'source', 'track',
  'input', 'button', 'textarea', 'select', 'option', 'applet', 'frame', 'frameset',
];

export function sanitizeHtml(html) {
  if (!html) return '';
  let out = String(html);
  // 去掉危险标签及其内容（script/style/svg/math/template 类），其余危险标签只去标签本体
  out = out.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '');
  out = out.replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, '');
  out = out.replace(/<svg\b[^>]*>[\s\S]*?<\/svg\s*>/gi, '');
  out = out.replace(/<math\b[^>]*>[\s\S]*?<\/math\s*>/gi, '');
  out = out.replace(/<template\b[^>]*>[\s\S]*?<\/template\s*>/gi, '');
  // 自闭合/未闭合的 svg/math/template 本体也剥掉（内容已由上面处理或本就无闭合）
  out = out.replace(/<svg\b[^>]*\/?>/gi, '');
  out = out.replace(/<math\b[^>]*\/?>/gi, '');
  out = out.replace(/<template\b[^>]*\/?>/gi, '');
  for (const tag of DANGEROUS_TAGS) {
    if (tag === 'svg' || tag === 'math' || tag === 'template' || tag === 'script') continue;
    out = out.replace(new RegExp(`<${tag}\\b[^>]*>`, 'gi'), '');
    out = out.replace(new RegExp(`</${tag}\\s*>`, 'gi'), '');
  }
  // 去掉所有事件处理器属性（onclick、onerror 等）和 srcdoc。
  // 审计 M7 补漏：属性前的分隔符不只是空白，'/' 分隔（如 <svg/onload=…>、
  // <img/src=x/onerror=…>）浏览器同样认，分隔符放宽到空白或 '/'。
  out = out.replace(/[\s/]+on[a-zA-Z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');
  out = out.replace(/[\s/]+srcdoc\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');
  // style 属性里的危险内容（javascript:/vbscript:/expression()）：整条 style 去掉
  out = out.replace(/\s+style\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, (m, raw) => {
    const v = raw.startsWith('"') || raw.startsWith("'") ? raw.slice(1, -1) : raw;
    const check = decodeEntities(v).replace(/[\u0000-\u0020]+/g, '').toLowerCase();
    if (check.includes('javascript:') || check.includes('vbscript:') || check.includes('expression(')) return '';
    return m;
  });
  // href/src/xlink:href/formaction 里的危险协议（对抗复读 C-39 + 审计 M7）：
  // 旧正则只认带引号的属性值，无引号写法（href=javascript:...）直接漏网；
  // 且 scheme 比对前没解实体，&#106;avascript: 这类编码写法也能绕过。
  // 现在带引号/无引号都查，比对前先把实体解码、再去掉空白与控制字符
  // （浏览器解析 URL 时同样会忽略它们），命中危险 scheme 一律换成 #。
  // M7 补：vbscript: 与 data: 一并管——data: 只放行位图图片（png/jpeg/gif/webp，
  // 邮件内嵌图片的正常用法），data:text/html、data:image/svg+xml 等全拦。
  out = out.replace(
    /((?:href|src|xlink:href|formaction)\s*=\s*)("[^"]*"|'[^']*'|[^\s>]+)/gi,
    (m, pre, raw) => {
      const v = raw.startsWith('"') || raw.startsWith("'") ? raw.slice(1, -1) : raw;
      const check = decodeEntities(v).replace(/[\u0000-\u0020]+/g, '').toLowerCase();
      if (check.startsWith('javascript:') || check.startsWith('vbscript:')) return `${pre}"#"`;
      if (
        check.startsWith('data:') &&
        !/^data:image\/(png|jpeg|gif|webp)[;,]/.test(check)
      ) return `${pre}"#"`;
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
