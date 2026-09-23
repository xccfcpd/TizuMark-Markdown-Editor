#!/usr/bin/env node
// 导出 HTML 自动验收工具（零依赖，node 直接跑）
//
//   node scripts/check-export-html.cjs <导出的.html>
//
// 判据来源：docs/local-features-changes.md §2.12（一次真实故障：图表整块被 Mermaid 接管，
// 变成 "Syntax error in text" 错误图）。本脚本把它固化成可执行判据，避免再靠肉眼翻 1.7MB 的 HTML。
//
// 检查项：
//   ① 每个 data-diagram-type 容器是否真的含图形（<svg> / <canvas> / <img>）
//   ② "Syntax error in text" 计数必须为 0（≠0 说明有源码被当成 Mermaid 语法）
//   ③ 旧构建指纹：只带 .mermaid-container、不是 .diagram-container、且无 data-diagram-type
//      的容器 —— 当前代码不会产出这种容器，出现即说明 exe 不是当前代码构建的（详见 §2.12）
//   ④ 未内联的图片（src 非 data:）—— 远程图离线不可见，属既定行为，仅提示
//
// 退出码：0 = 全部通过；1 = 有致命项（①②）失败。

const fs = require('fs');

const file = process.argv[2];
if (!file) {
  console.error('用法: node scripts/check-export-html.cjs <导出的.html>');
  process.exit(2);
}
let html;
try {
  html = fs.readFileSync(file, 'utf8');
} catch (e) {
  console.error('无法读取文件：' + file + '（' + e.code + '）');
  process.exit(2);
}

const count = (re) => (html.match(re) || []).length;
const strip = (s) => String(s).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
const failures = [];
const warns = [];

console.log('检查文件：' + file + '（' + (Buffer.byteLength(html) / 1048576).toFixed(2) + ' MB）\n');

/* ---------- ① 各引擎容器 ---------- */
const types = [];
const reT = /data-diagram-type="([^"]+)"/g;
let m;
while ((m = reT.exec(html))) types.push({ type: m[1], at: m.index });

console.log('=== ① 图表容器（按文档顺序）===');
if (!types.length) {
  console.log('  （无 data-diagram-type 容器）');
} else {
  types.forEach((t, i) => {
    const end = i + 1 < types.length ? types[i + 1].at : html.length;
    const seg = html.slice(t.at, end);
    const svg = /<svg[\s>]/i.test(seg);
    const canvas = /<canvas[\s>]/i.test(seg);
    // 注意排除 SVG 的 <image>，否则会把「没渲染」误判成「已渲染」
    const img = /<img[\s/>]/i.test(seg);
    // 错误框（.diagram-error-msg + 原始源码）是既定行为：语法超出本地子集时保留可读原因
    const errBox = /diagram-error/.test(seg);
    const ok = svg || canvas || img;
    console.log(
      '  ' + String(i + 1).padStart(3) + '. ' + t.type.padEnd(10) +
      ' svg=' + (svg ? 'Y' : '-') + ' canvas=' + (canvas ? 'Y' : '-') + ' img=' + (img ? 'Y' : '-') +
      (ok ? '' : (errBox ? '   ⚠ 错误框（有可读原因，属既定行为）' : '   ✗ 该容器没有任何图形'))
    );
    if (!ok && !errBox) failures.push('容器 ' + t.type + ' 内没有图形（渲染结果为空）');
  });
  const byType = {};
  types.forEach((t) => { byType[t.type] = (byType[t.type] || 0) + 1; });
  console.log('  合计：' + JSON.stringify(byType));
}

/* ---------- ② mermaid 语法错误图 ---------- */
const bombs = count(/Syntax error in text/g);
console.log('\n=== ② Mermaid 语法错误图 ===');
console.log('  "Syntax error in text" 出现 ' + bombs + ' 次' + (bombs === 0 ? '  ✓' : '  ✗ 有源码被当成 Mermaid 语法'));
if (bombs > 0) failures.push('存在 ' + bombs + ' 个 mermaid 语法错误图（说明有非 mermaid 内容被送进 mermaid 管线）');

/* ---------- ③ 旧构建指纹 ---------- */
console.log('\n=== ③ 旧构建指纹 ===');
const allMc = count(/class="mermaid-container"/g);
const dual = count(/class="mermaid-container diagram-container"/g);
const tMermaid = count(/data-diagram-type="mermaid"/g);
console.log('  仅单类名 .mermaid-container : ' + allMc + '（其中双类名 ' + dual + ' → 单类名 ' + (allMc - dual) + '）');
console.log('  data-diagram-type="mermaid" : ' + tMermaid);
if (allMc - dual > 0 && tMermaid === 0) {
  warns.push('存在 ' + (allMc - dual) + ' 个「单类名且无 data-diagram-type」的 mermaid 容器，而真 mermaid 容器计数为 0 —— ' +
    '当前代码的 processMermaid 必设 data-diagram-type="mermaid"，故该 HTML 极可能由**旧实现构建的 exe** 导出（§2.12）');
  console.log('  ⚠ 疑似旧实现构建（详见 docs/local-features-changes.md §2.12）');
} else {
  console.log('  ✓ 无旧构建指纹');
}

/* ---------- ④ 未内联图片 ---------- */
console.log('\n=== ④ 未内联图片 ===');
const imgs = [];
const reI = /<img\b[^>]*>/gi;
while ((m = reI.exec(html))) {
  const s = /\bsrc\s*=\s*["']([^"']*)["']/i.exec(m[0]);
  imgs.push(s ? s[1] : '(无 src)');
}
const notInlined = imgs.filter((s) => !/^data:/i.test(s));
console.log('  <img> 共 ' + imgs.length + '，未内联（非 data:）' + notInlined.length + ' 个');
notInlined.slice(0, 10).forEach((s) => console.log('    - ' + String(s).slice(0, 120)));
if (notInlined.length) warns.push(notInlined.length + ' 张图片未内联（远程图离线不可见，属既定行为；可在导出时看告警 toast）');

/* ---------- 摘要 ---------- */
console.log('\n=== 摘要 ===');
if (failures.length) failures.forEach((f) => console.log('  ✗ ' + f));
warns.forEach((w) => console.log('  ⚠ ' + w));
if (!failures.length) console.log('  ✓ 致命项全部通过' + (warns.length ? '（有 ' + warns.length + ' 条提示）' : ''));
process.exit(failures.length ? 1 : 0);
