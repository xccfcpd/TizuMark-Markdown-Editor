'use strict';
// 工程卫生护栏（纯 fs，不需要 jsdom/unified → 本地与 CI 都能跑）
// 这几条都是 2026-09-25（第十一轮体检）里**真实出现过**的缺陷类别，钉住以防复发：
//   ① index.html 重复 id（会让 getElementById 静默取到另一个元素）
//   ② data-action 写了但没有任何 JS 处理（点了没反应的死按钮）
//   ③ 测试文件没有失败机制（失败只打印、永远绿 —— "假绿"）
//   ④ 对话框标题含中文却没有任何 i18n 接线（英文界面残留中文）
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
// 注释里可能出现 id="…" / data-action="…"（用于说明），扫描前先剥掉注释，避免把注释当标记
const stripComments = (s) => s.replace(/<!--[\s\S]*?-->/g, '');
const HTML = stripComments(read('src/index.html'));
const I18N = read('src/modules/i18n.js');
const CJK = /[\u4e00-\u9fff]/;

function allSrcJs() {
  const out = [];
  (function walk(d) {
    for (const f of fs.readdirSync(path.join(ROOT, d))) {
      const rel = d + '/' + f;
      if (fs.statSync(path.join(ROOT, rel)).isDirectory()) { if (f !== 'lib' && f !== 'node_modules') walk(rel); }
      else if (f.endsWith('.js')) out.push(rel);
    }
  })('src');
  return out;
}

test('index.html 不得有重复 id', () => {
  const ids = (HTML.match(/\bid="([^"]+)"/g) || []).map((s) => s.slice(4, -1));
  const dup = Object.entries(ids.reduce((m, id) => ((m[id] = (m[id] || 0) + 1), m), {}))
    .filter(([, n]) => n > 1)
    .map(([id, n]) => id + '×' + n);
  assert.deepStrictEqual(dup, [], '重复 id 会让 getElementById 静默指向另一个元素：' + dup.join(', '));
});

test('index.html 里每个 data-action 都必须有 JS 处理', () => {
  const js = allSrcJs().map(read).join('\n');
  const actions = [...new Set((HTML.match(/data-action="([^"]+)"/g) || []).map((s) => s.slice(13, -1)))];
  assert.ok(actions.length > 20, 'data-action 数量异常，选择器可能失效：' + actions.length);
  const unhandled = actions.filter((a) => js.indexOf("'" + a + "'") < 0 && js.indexOf('"' + a + '"') < 0);
  assert.deepStrictEqual(unhandled, [], '这些按钮点了不会有任何反应：' + unhandled.join(', '));
});

test('每个 test/*.test.cjs 都必须有失败机制（断言 / node:test / 非零退出）', () => {
  const files = fs.readdirSync(path.join(ROOT, 'test')).filter((f) => f.endsWith('.test.cjs'));
  assert.ok(files.length > 50, '测试文件数量异常：' + files.length);
  const bad = [];
  for (const f of files) {
    const t = read('test/' + f);
    const hasNodeTest = /require\(['"]node:test['"]\)/.test(t);
    const hasAssert = /\bassert\./.test(t);
    const hasFailExit = /process\.exit\([^)]*fail[^)]*\?[^)]*1/.test(t) ||
      /process\.exit\(1\)/.test(t) || /process\.exitCode\s*=\s*1/.test(t);
    if (!hasNodeTest && !hasAssert && !hasFailExit) bad.push(f);
  }
  assert.deepStrictEqual(bad, [], '这些测试失败时不会报错（假绿）：' + bad.join(', '));
});

test('预览热路径的两个缓存都必须有上限（防长会话内存增长）', () => {
  // 缓存键含整段代码/图表文本 → 连续输入会产生大量新键（值为整块 HTML / 整张 SVG）。
  // 两个缓存都必须保留淘汰逻辑：code-block.js 的 capCache、preview-post.js 的 capCache/CACHE_MAX_ENTRIES。
  const cb = read('src/modules/code-block.js');
  const pp = read('src/modules/preview-post.js');
  assert.match(cb, /capCache\(cache\)/, 'code-block.js 必须在写入后调用 capCache（高亮缓存上限）');
  assert.match(cb, /CODE_CACHE_MAX_ENTRIES\s*=\s*\d+/, 'code-block.js 必须声明缓存上限常量');
  assert.match(pp, /cache\.set\(key,\s*container\.innerHTML\);\s*\n\s*capCache\(cache\)/, 'preview-post.js 的原生图表缓存必须调用 capCache');
  assert.match(pp, /mermaidCache\.set\(cacheKey,\s*container\.innerHTML\);\s*\n\s*capCache\(mermaidCache\)/, 'mermaid 缓存必须调用 capCache');
  assert.match(pp, /CACHE_MAX_ENTRIES\s*=\s*\d+/, 'preview-post.js 必须声明缓存上限常量');
});

test('含中文标题的对话框必须有 i18n 接线（否则英文界面残留中文）', () => {
  const lines = HTML.split('\n');
  const dialogs = [];
  lines.forEach((l, i) => {
    const m = /<div id="([a-z0-9-]+)" class="dialog-overlay/.exec(l);
    if (m) dialogs.push({ id: m[1], line: i });
  });
  assert.ok(dialogs.length > 8, '对话框数量异常：' + dialogs.length);
  const missing = [];
  dialogs.forEach(({ id, line }) => {
    const head = lines.slice(line, line + 3).join(' ');
    const h2 = /<h2[^>]*id="([^"]+)"[^>]*>([^<]*)<\/h2>/.exec(head);
    if (!h2 || !CJK.test(h2[2])) return;                    // 标题无中文（纯英文/动态）→ 不要求
    const wired = I18N.indexOf('#' + id + ' .dialog-header h2') >= 0 ||
      I18N.indexOf('#' + id) >= 0 ||
      I18N.indexOf("'" + h2[1] + "'") >= 0 ||               // 形如 setText('xxx-title', …)
      I18N.indexOf('"' + h2[1] + '"') >= 0;
    if (!wired) missing.push(id + '（' + h2[2].slice(0, 12) + '）');
  });
  assert.deepStrictEqual(missing, [], '这些对话框标题切英文后仍是中文：' + missing.join(', '));
});
