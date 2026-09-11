// 回归测试：化学式 \ce{...} / \pu{...} 必须可用（KaTeX mhchem 扩展）。
//
// 背景：TizuMark 只用 KaTeX 核心 + auto-render，而 \ce 不在核心内 —— 缺 mhchem
// 扩展时公式不会报错，而是由 throwOnError:false 兜成「红色原文」输出，属于
// 最容易被忽略的静默降级。本测试同时守住三类失效点：
//   ① vendor 再生清单漏拷 mhchem.min.js（npm install 后 src/lib/katex 缺文件）；
//   ② index.html 漏加载 / 加载顺序错误（官方要求 katex → mhchem → auto-render，
//      顺序不对时 auto-render 渲染阶段拿不到 \ce 宏）；
//   ③ 实际渲染产物退化（.katex-error / 残留 \ce 字面量）。
// 前两项是纯静态断言（不依赖 node_modules），第三项缺 katex 依赖时自动跳过。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const INDEX = path.join(ROOT, 'src', 'index.html');
const VENDOR = path.join(ROOT, 'scripts', 'ensure-vendor.mjs');
const KATEX_DIST = path.join(ROOT, 'node_modules', 'katex', 'dist');

function scriptSrcs(html) {
  const out = [];
  const re = /<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/g;
  let m;
  while ((m = re.exec(html)) !== null) out.push(m[1]);
  return out;
}

// ---- ① vendor 清单必须再生 mhchem.min.js ----

test('ensure-vendor 清单包含 katex mhchem 扩展', () => {
  const src = fs.readFileSync(VENDOR, 'utf8');
  assert.ok(
    /katex\/dist\/contrib\/mhchem\.min\.js['"]\s*,\s*['"]katex\/mhchem\.min\.js/.test(src),
    'ensure-vendor.mjs 缺少 katex/dist/contrib/mhchem.min.js -> katex/mhchem.min.js 映射'
  );
});

// ---- ② index.html 必须加载 mhchem，且顺序为 katex → mhchem → auto-render ----

test('index.html 加载 mhchem 且位于 katex.min.js 与 auto-render.min.js 之间', () => {
  const srcs = scriptSrcs(fs.readFileSync(INDEX, 'utf8'));
  const iKatex = srcs.indexOf('lib/katex/katex.min.js');
  const iMhchem = srcs.indexOf('lib/katex/mhchem.min.js');
  const iAuto = srcs.indexOf('lib/katex/auto-render.min.js');

  assert.ok(iKatex !== -1, 'index.html 缺少 lib/katex/katex.min.js');
  assert.ok(iMhchem !== -1, 'index.html 缺少 lib/katex/mhchem.min.js —— \\ce 化学式不可用');
  assert.ok(iAuto !== -1, 'index.html 缺少 lib/katex/auto-render.min.js');
  assert.ok(iKatex < iMhchem, 'mhchem 必须在 katex.min.js 之后加载（依赖全局 katex）');
  assert.ok(iMhchem < iAuto, 'mhchem 必须在 auto-render.min.js 之前加载（否则渲染阶段无 \\ce 宏）');
});

// ---- ③ 真实渲染：\ce / \pu 必须产出 .katex 而非 .katex-error ----

function loadKatexWithMhchem(window) {
  // 主路径：走 CommonJS 入口（与 preview-post.test.cjs 同范式）。
  // 该文件历史注释指出：UMD 版 katex.js 在 window 上下文里可能因 module/exports 检测
  // 或内部引用而挂不上全局，require 更可靠。
  let katex = null;
  let renderMathInElement = null;
  try {
    katex = require('katex');
    require('katex/contrib/mhchem');            // 注册 \ce / \pu 宏（与 index.html 加载 mhchem.min.js 等效）
    renderMathInElement = require('katex/contrib/auto-render');
  } catch (_) {
    // 回退：按 index.html 的脚本顺序把 dist 文件 eval 进 window
    const files = [
      path.join(KATEX_DIST, 'katex.js'),
      path.join(KATEX_DIST, 'contrib', 'mhchem.js'),
      path.join(KATEX_DIST, 'contrib', 'auto-render.js'),
    ];
    if (files.some((f) => !fs.existsSync(f))) return false;
    for (const f of files) window.eval(fs.readFileSync(f, 'utf8'));
    katex = window.katex;
    renderMathInElement = window.renderMathInElement;
  }
  if (!katex || !renderMathInElement) return false;
  global.katex = katex;
  global.renderMathInElement = renderMathInElement;
  if (window) {
    window.katex = katex;
    window.renderMathInElement = renderMathInElement;
  }
  return true;
}

function setupAndRender(md) {
  // 依赖懒加载 + 兜底：未 npm install 的环境（只有本文件的两条静态断言）也不报红。
  let JSDOM, installGlobals, renderMarkdown, PP;
  try {
    ({ JSDOM } = require('jsdom'));
    ({ installGlobals } = require('./helpers/dom.js'));
    ({ renderMarkdown } = require('../src/unified-renderer.js'));
    PP = require('../src/modules/preview-post.js');
  } catch (_) {
    return { ok: false };
  }

  const dom = new JSDOM(
    '<!DOCTYPE html><html><head></head><body><div class="preview-content"></div></body></html>',
    { runScripts: 'outside-only', pretendToBeVisual: true }
  );
  installGlobals(dom.window);
  if (!loadKatexWithMhchem(dom.window)) return { ok: false };
  const preview = dom.window.document.querySelector('.preview-content');
  preview.innerHTML = renderMarkdown(md, { softBreaks: false, extendedSyntax: true });
  PP.processMath(preview);
  return { ok: true, preview };
}

test('行内化学式 $\\ce{2H2 + O2 -> 2H2O}$ 渲染为 KaTeX（非红色报错）', () => {
  const { ok, preview } = setupAndRender('燃烧反应：$\\ce{2H2 + O2 -> 2H2O}$。');
  if (!ok) return; // 缺 katex 依赖则跳过，不阻断套件

  assert.ok(preview.querySelector('.katex'), '化学式应渲染出 .katex 元素');
  assert.strictEqual(preview.querySelectorAll('.katex-error').length, 0, '不应出现 .katex-error（\\ce 未定义）');
  // 注意：KaTeX 的隐藏 MathML 里带 <annotation encoding="application/x-tex">，按设计保留 LaTeX 原文，
  // 因此 preview.textContent 一定包含 \ce —— 只能校验【可见层】.katex-html 不残留源码。
  const visible = preview.querySelector('.katex-html');
  assert.ok(visible, '应产出 KaTeX 可见层 .katex-html');
  assert.ok(!visible.textContent.includes('\\ce'), '可见层不应残留 \\ce 字面量');
  assert.ok(preview.querySelector('.katex-mathml'), '应产出 KaTeX 隐藏 MathML（供 docx 转 OMML）');
});

test('$\\pu{123 kJ//mol}$ 单位渲染为 KaTeX（非红色报错）', () => {
  const { ok, preview } = setupAndRender('单位：$\\pu{123 kJ//mol}$。');
  if (!ok) return;

  assert.ok(preview.querySelector('.katex'), '\\pu 应渲染出 .katex 元素');
  assert.strictEqual(preview.querySelectorAll('.katex-error').length, 0, '不应出现 .katex-error（\\pu 未定义）');
});

test('块级化学方程式 $$\\ce{...}$$ 文本完整保留且不产生渲染错误', () => {
  const { ok, preview } = setupAndRender('$$\\ce{CO2 + C -> 2CO}$$');
  if (!ok) return;

  // 块级公式走「占位符 → math-display 容器」两步，最终渲染还依赖 app 层；
  // 这里只守两件在渲染器层面必须成立的事：源码不被破坏、不出现 KaTeX 错误标记。
  assert.strictEqual(preview.querySelectorAll('.katex-error').length, 0, '不应出现 .katex-error');
  const rendered = preview.querySelector('.katex, .math-display');
  assert.ok(rendered, '块级化学方程式应产出公式容器（math-display）或已渲染的 .katex');
  assert.ok((preview.textContent || '').includes('2CO'), '块级化学方程式的文本（含 2CO）应保留');
});
