#!/usr/bin/env node
// 离线守卫：确认「运行期不联网」这一不变量没有被破坏。
//
//   node scripts/check-offline.cjs
//
// 为什么需要：安装包（exe）的前端资源是**内嵌**的，用户无法自己查看；"完全离线"若只靠人工
// 保证，很容易被一次不经意的改动破坏（例如给 index.html 加一个 CDN 脚本、在模块里 fetch 外链）。
// 本脚本只做一件事：在 src/ 全树里找「**加载远程资源**」的字面量。
//
// 判定为违规（会在运行期联网）：
//   HTML：<script src="http(s)://…">、<link href="http(s)://…">、<img src="http(s)://…">
//   CSS ：url(http(s)://…)、@import "http(s)://…"
//   JS  ：fetch("http(s)://…")、XHR.open(METHOD, "http(s)://…")、importScripts("http(s)://…")、
//         new Worker("http(s)://…")、new WebSocket("ws(s)://…")、new EventSource("http(s)://…")
//
// 刻意不算违规（离线无害）：
//   - XML 命名空间字符串（http://www.w3.org/…）：它不是请求，只是标识符
//   - 注释/文档/许可证里的 URL（本脚本只匹配"加载上下文"，因此天然不误报）
//   - 用**变量**发起的请求（如 fetch(href)、fetch(src)）：那是"用户内容自己指向网络"的路径，
//     属既定行为，见下方 INFO 段
//
// 退出码：0 = 全树无远程加载；1 = 有违规（列出文件:行号）

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'src');

// 已知的「按用户内容联网」路径：不属于本守卫的拦截范围，但在此列出以免读者误解
const INFO = [
  '导出时把文档里的**远程图片**下载并内联（离线时按设计保留原 URL 并弹告警）：src/modules/export.js',
  '预览里的远程图片由 WebView 直接加载（processImages 用 SKIP_PREFIXES 跳过 data:/http(s):/blob:）：src/modules/image-processor.js',
  '打开正文里的**远程 markdown 链接**（用户点击才发生，失败回退 window.open）：src/modules/misc-ui.js',
];

const RULES = [
  // HTML / 类 HTML
  { name: 'html-script', re: /<(?:script|link|iframe)\b[^>]*\b(?:src|href)\s*=\s*["']https?:\/\//gi, ext: ['.html', '.htm'] },
  { name: 'html-img', re: /<img\b[^>]*\bsrc\s*=\s*["']https?:\/\//gi, ext: ['.html', '.htm'] },
  // CSS
  { name: 'css-url', re: /url\(\s*["']?https?:\/\//gi, ext: ['.css'] },
  { name: 'css-import', re: /@import\s+(?:url\()?\s*["']https?:\/\//gi, ext: ['.css'] },
  // JS（含 vendor）：只匹配"字面量远程地址"的加载上下文
  { name: 'js-fetch', re: /\bfetch\s*\(\s*["'`]https?:\/\//g, ext: ['.js', '.mjs', '.cjs'] },
  { name: 'js-xhr', re: /\.open\s*\(\s*["'][A-Z]+["']\s*,\s*["'`]https?:\/\//g, ext: ['.js', '.mjs', '.cjs'] },
  { name: 'js-importscripts', re: /\bimportScripts\s*\(\s*["'`]https?:\/\//g, ext: ['.js', '.mjs', '.cjs'] },
  { name: 'js-worker', re: /\bnew\s+Worker\s*\(\s*["'`]https?:\/\//g, ext: ['.js', '.mjs', '.cjs'] },
  { name: 'js-websocket', re: /\bnew\s+WebSocket\s*\(\s*["'`](?:ws|wss):\/\//g, ext: ['.js', '.mjs', '.cjs'] },
  { name: 'js-eventsource', re: /\bnew\s+EventSource\s*\(\s*["'`]https?:\/\//g, ext: ['.js', '.mjs', '.cjs'] },
  { name: 'js-css-href', re: /\.href\s*=\s*["'`]https?:\/\/[^"'`]*\.css/g, ext: ['.js', '.mjs', '.cjs'] },
];

function walk(dir, out) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return out; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const files = walk(SRC, []);
const violations = [];
let vendorPresent = 0;

for (const file of files) {
  const ext = path.extname(file).toLowerCase();
  const rel = path.relative(ROOT, file).replace(/\\/g, '/');
  if (rel.indexOf('src/lib/') === 0 && /\.(min\.js|js)$/.test(rel) && /(echarts|mermaid|katex|codemirror|highlight|markmap|graphviz|wavedrom|html2canvas|markdown-it|html-docx|docx|mathml2omml)/i.test(rel)) {
    vendorPresent++;
  }
  const rules = RULES.filter((r) => r.ext.indexOf(ext) !== -1);
  if (!rules.length) continue;
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (_) { continue; }
  const lines = text.split('\n');
  for (const rule of rules) {
    rule.re.lastIndex = 0;
    let m;
    while ((m = rule.re.exec(text))) {
      // 排除 XML 命名空间（不是请求）
      if (/https?:\/\/www\.w3\.org\//i.test(m[0])) continue;
      const idx = m.index;
      let line = 1;
      for (let i = 0; i < lines.length && text.indexOf(lines[i]) <= idx; i++) { /* 近似行号 */ }
      line = text.slice(0, idx).split('\n').length;
      violations.push({ file: rel, line, rule: rule.name, snippet: m[0].slice(0, 120) });
    }
  }
}

console.log('=== 离线守卫（运行期不联网）===');
console.log('扫描：' + path.relative(ROOT, SRC).replace(/\\/g, '/') + '/ 共 ' + files.length + ' 个文件' +
  (vendorPresent ? '（其中 vendor 生成物 ' + vendorPresent + ' 个）' : '（vendor 未生成 —— 本机无 npm，属预期）'));

if (violations.length) {
  console.log('\n✗ 发现「加载远程资源」' + violations.length + ' 处：');
  violations.slice(0, 40).forEach((v) => console.log('  ' + v.file + ':' + v.line + ' [' + v.rule + '] ' + v.snippet));
  if (violations.length > 40) console.log('  …另有 ' + (violations.length - 40) + ' 处');
  console.log('\n若确属"用户内容联网"的既定路径，请扩充 scripts/check-offline.cjs 的规则豁免，而不是忽略本守卫。');
  process.exit(1);
}

console.log('✓ 全树无「加载远程资源」的字面量');
console.log('\n--- INFO：仅有的三条「按用户内容联网」路径（既定行为，均不属本守卫范围）---');
INFO.forEach((x) => console.log('  · ' + x));
console.log('  · 构建期需联网一次（npm ci 拉依赖），之后 exe 自包含、运行期不再联网。');
