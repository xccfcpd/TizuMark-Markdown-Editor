'use strict';
// 声明功能的端到端矩阵（2026-09-25 第十三轮）：
// 把「基础 Markdown / 代码高亮 / 数学 / mhchem / 物理单位(siunitx) / Mermaid / Graphviz / ECharts /
// WaveDrom / Unicode 符号 / 公式自动编号 / Markmap / PlantUML / TikZ / plot / Admonition」
// 放进**同一篇文档**，走与 preview-controller 相同的管线（renderMarkdown → 同步后处理序列），
// 逐项断言 DOM 特征。任何一项功能在管线里被改坏/断线，CI 立刻红。
//
// 说明：
//   · 图表引擎（ECharts / Graphviz / WaveDrom / Markmap）的**真实渲染**由 test/diagram-engines.test.cjs
//     用桩覆盖；这里断言我们自己的那一层：占位容器的类型 / 源码 / 属性，以及"占位必须被摘掉"。
//   · KaTeX 需要 node_modules（CI 有）。缺时本文档整体加载失败，与本仓其它 jsdom 用例一致。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const { installGlobals, loadHljs } = require('./helpers/dom.js');
const { renderMarkdown } = require('../src/unified-renderer.js');
const PP = require('../src/modules/preview-post.js');
const CodeBlock = require('../src/modules/code-block.js');

const B = '`';

function setup() {
  const dom = new JSDOM('<!DOCTYPE html><html><head></head><body><div class="preview-content"></div></body></html>', {
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  installGlobals(dom.window);
  const preview = dom.window.document.querySelector('.preview-content');
  return { dom, window: dom.window, document: dom.window.document, preview };
}

function loadKatex(window) {
  const katexJs = path.resolve(__dirname, '..', 'node_modules', 'katex', 'dist', 'katex.js');
  const arJs = path.resolve(__dirname, '..', 'node_modules', 'katex', 'dist', 'contrib', 'auto-render.js');
  if (!fs.existsSync(katexJs) || !fs.existsSync(arJs)) return false;
  window.eval(fs.readFileSync(katexJs, 'utf8'));
  window.eval(fs.readFileSync(arJs, 'utf8'));
  global.katex = window.katex;
  global.renderMathInElement = window.renderMathInElement;
  return true;
}

const DOC = [
  '# 一级标题',
  '',
  '## 二级标题',
  '',
  '段落：**加粗**、*斜体*、' + B + '行内代码' + B + '、~~删除线~~、==高亮==、[链接](https://example.com)、脚注[^1]。',
  '',
  '[^1]: 脚注内容。',
  '',
  '- [x] 已完成任务',
  '- [ ] 未完成任务',
  '',
  '| 列 A | 列 B |',
  '| ---- | ---- |',
  '| 1 | 2 |',
  '',
  '术语',
  ': 定义',
  '',
  '::: tip 容器提示',
  '这是 ::: 容器语法的正文',
  ':::',
  '',
  '!!! warning "警告标题"',
  '    这是 !!! 提示块的正文（必须缩进）',
  '',
  '??? note 折叠块',
  '    这是 ??? 折叠块的正文',
  '',
  '> [!NOTE]',
  '> GitHub 风格提示',
  '',
  '行内公式 $E = mc^2$，物理单位 $\\si{kg m}$，化学式 $\\ce{2H2 + O2 -> 2H2O}$。',
  '',
  '$$',
  'E = mc^2 \\label{eq:e}',
  '$$',
  '',
  '见式 $\\eqref{eq:e}$。',
  '',
  'Emoji：:fire: :rocket:',
  '',
  '缩写：HTML 是 Web 基础。',
  '',
  '*[HTML]: HyperText Markup Language',
  '',
  B + B + B + 'javascript',
  'const x = 1;',
  'function f() { return x; }',
  B + B + B,
  '',
  B + B + B + 'plantuml',
  '@startuml',
  'Alice -> Bob : hi',
  '@enduml',
  B + B + B,
  '',
  B + B + B + 'mermaid',
  'flowchart LR',
  '  A --> B',
  B + B + B,
  '',
  B + B + B + 'graphviz',
  'digraph { 来料 -> 检验 }',
  B + B + B,
  '',
  B + B + B + 'echarts',
  '{"series":[{"type":"bar","data":[1,2]}]}',
  B + B + B,
  '',
  B + B + B + 'wavedrom',
  '{ "signal": [ { "name": "clk", "wave": "p..." } ] }',
  B + B + B,
  '',
  B + B + B + 'tikz',
  '\\draw (0,0) -- (1,1);',
  B + B + B,
  '',
  B + B + B + 'plot',
  'plot sin(x)',
  B + B + B,
  '',
  B + B + B + 'markmap',
  '# 根节点',
  '## 子节点',
  B + B + B,
].join('\n');

// 与 preview-controller 相同的**同步**阶段顺序：图表占位 → 代码块定型 → emoji → 数学 → 缩写 → 标题
function renderPipeline(md) {
  const env = setup();
  const katexOK = loadKatex(env.window);
  const hljs = loadHljs(env.window);
  const html = renderMarkdown(md, { softBreaks: false, extendedSyntax: true });
  env.preview.innerHTML = html;
  const opts = {
    isDark: false,
    mermaidCache: new Map(),
    t: (k) => k,
    escapeHtml: (s) => String(s),
    escapeAttr: (s) => String(s),
    headingToId: (s) => String(s).trim().toLowerCase().replace(/\s+/g, '-'),
  };
  const prep = PP.prepareDiagramPlaceholders(env.preview, opts);
  CodeBlock.processCodeBlocks(env.preview, { hljs, cache: new Map(), lineNumbers: true });
  PP.processEmojiShortcodes(env.preview);
  if (katexOK) PP.processMath(env.preview);
  PP.processAbbreviations(env.preview, opts);
  PP.processHeadings(env.preview, opts);
  return { env, html, prep, opts, katexOK };
}

test('功能矩阵 · 基础 Markdown：标题 / 表格 / 任务列表 / 脚注 / 高亮 / 删除线 / 定义列表', () => {
  const { html, env } = renderPipeline(DOC);
  const doc = env.document;
  assert.ok(doc.querySelector('h1'), '应有一级标题');
  assert.ok(doc.querySelector('h2'), '应有二级标题');
  assert.ok(doc.querySelector('table'), '应渲染表格');
  assert.ok(doc.querySelectorAll('input[type="checkbox"]').length >= 2, '任务列表应有复选框');
  assert.ok(/<del>/.test(html), '删除线应渲染为 <del>');
  assert.ok(/<mark/.test(html), '==高亮== 应渲染为 <mark>');
  assert.ok(/footnote/i.test(html), '脚注应有对应结构');
  assert.ok(/<dl|<dd/.test(html), '定义列表应渲染为 dl/dd');
  assert.ok(doc.querySelector('a[href="https://example.com"]'), '链接应保留 href');
});

test('功能矩阵 · 代码高亮：hljs 高亮 + 行号结构 + 语言类', () => {
  const { env } = renderPipeline(DOC);
  const code = env.preview.querySelector('pre code');
  assert.ok(code, '应存在代码块');
  assert.ok(code.classList.contains('hljs'), '代码块应带 hljs 类（说明真被高亮）');
  assert.strictEqual(code.dataset.highlighted, 'yes', '应标记 data-highlighted');
  assert.ok(/language-javascript/.test(code.className), '应保留语言类');
  assert.ok(code.querySelector('.code-scroll'), '应有 .code-scroll 结构');
  assert.ok(code.querySelector('.code-line-num'), '多行块开启行号时应有行号节点');
});

test('功能矩阵 · Unicode 符号：emoji 短码被替换、原文消失', () => {
  const { env } = renderPipeline(DOC);
  const text = env.preview.textContent;
  assert.ok(text.indexOf('🔥') >= 0, ':fire: 应替换为 🔥');
  assert.ok(text.indexOf('🚀') >= 0, ':rocket: 应替换为 🚀');
  assert.ok(text.indexOf(':fire:') < 0, '不应残留 :fire: 原文');
});

test('功能矩阵 · 公式与单位：siunitx 展开 / mhchem 透传 / 自动编号与 \\eqref / KaTeX 渲染', () => {
  const { env, html, katexOK } = renderPipeline(DOC);
  assert.ok(html.indexOf('kg\\,m') >= 0, '\\si{kg m} 应展开为 kg\\,m（细空格），实际未找到');
  assert.ok(html.indexOf('\\si{') < 0, '不应残留 \\si{ 命令');
  assert.ok(html.indexOf('\\ce{') >= 0, '\\ce{...} 应原样透传给 KaTeX（由 mhchem 扩展渲染）');
  assert.ok(/eq-?\d/.test(html), '公式应生成 eq-N 锚点');
  assert.ok(html.indexOf('\\eqref') < 0, '\\eqref 应被展开，不应残留原文');
  if (katexOK) {
    assert.ok(env.preview.querySelector('.katex'), 'KaTeX 应把公式渲染成 .katex');
    assert.ok(env.preview.querySelectorAll('.katex').length >= 3, '行内 + 块级公式都应渲染');
    assert.ok(env.preview.innerHTML.indexOf('MATHBLOCK') < 0, '不应残留 MATHBLOCK 占位符');
  }
});

test('功能矩阵 · Admonition：::: / !!! / ??? / > [!NOTE] 四种写法都产出提示块', () => {
  const { env } = renderPipeline(DOC);
  const alerts = env.preview.querySelectorAll('.alert, .admonition');
  assert.ok(alerts.length >= 4, '四种写法应各产出提示块，实际 ' + alerts.length);
  assert.ok(env.preview.querySelector('.alert-warning'), '!!! warning 应产出 .alert-warning');
  assert.ok(env.preview.querySelector('.alert-note'), '> [!NOTE] 应产出 .alert-note');
  const text = env.preview.textContent;
  assert.ok(text.indexOf('这是 ::: 容器语法的正文') >= 0, '::: 容器正文应保留');
  assert.ok(text.indexOf('这是 !!! 提示块的正文') >= 0, '!!! 提示块正文应保留');
  assert.ok(text.indexOf('这是 ??? 折叠块的正文') >= 0, '??? 折叠块正文应保留');
  assert.ok(env.preview.querySelector('details[data-admonition]'), '??? 应产出可折叠的 details');
});

test('功能矩阵 · 图表占位：Mermaid / PlantUML / 6 个原生引擎都被识别并挂上类型与源码', () => {
  const { env } = renderPipeline(DOC);
  // PlantUML 会被转换成 Mermaid（同一容器类型），因此这里断言容器存在 + 类型正确
  const want = ['mermaid', 'graphviz', 'echarts', 'wavedrom', 'tikz', 'plot', 'markmap'];
  want.forEach((type) => {
    const el = env.preview.querySelector('.diagram-container[data-diagram-type="' + type + '"]');
    assert.ok(el, '缺少 ' + type + ' 的图表容器（说明该引擎在管线里断线）');
    assert.ok((el.getAttribute('data-code') || '').length > 0, type + ' 容器应带 data-code（源码）');
    assert.ok(el.hasAttribute('data-theme'), type + ' 容器应带 data-theme');
  });
  const mermaid = env.preview.querySelectorAll('.mermaid-container[data-diagram-type="mermaid"]');
  assert.ok(mermaid.length >= 2, 'Mermaid 与 PlantUML 都应落到 mermaid 容器，实际 ' + mermaid.length);
  assert.ok(env.preview.querySelector('pre[data-diagram-source="plantuml"]'),
    'PlantUML 代码块应被标记为转换来源（data-diagram-source=plantuml）');
  assert.ok(env.preview.querySelector('pre.diagram-src-pending'), '渲染前的 Mermaid 源码应处于 pending 占位态');
  // 渲染前所有图表容器都该带 pending（防"内容被藏住"的前提是它必须能被摘掉）
  assert.ok(env.preview.querySelector('.diagram-container.diagram-pending'), '渲染前容器应带 diagram-pending 占位');
});

test('功能矩阵 · 渲染阶段结束必须摘掉所有占位（内容不得被永久藏住）', async () => {
  const { env, prep, opts } = renderPipeline(DOC);
  // 测试环境没有图表引擎 → renderInto 全部优雅失败，但**占位清理必须照常执行**
  await PP.renderDiagramPlaceholders(env.preview, prep, opts, () => false);
  assert.strictEqual(env.preview.querySelectorAll('pre.diagram-src-pending').length, 0,
    '不应残留 pre.diagram-src-pending（否则用户只看到空占位、看不到源码/图）');
  assert.strictEqual(env.preview.querySelectorAll('.diagram-container.diagram-pending').length, 0,
    '不应残留 .diagram-pending（CSS 会把内容设成 transparent → 永久看不见）');
});

test('功能矩阵 · 标题锚点：渲染后每个标题都有 id（供大纲/目录跳转）', () => {
  const { env } = renderPipeline(DOC);
  const h1 = env.preview.querySelector('h1');
  const h2 = env.preview.querySelector('h2');
  assert.ok(h1 && h1.id, 'h1 应有 id');
  assert.ok(h2 && h2.id, 'h2 应有 id');
});

test('功能矩阵 · 缩写：*[HTML]: … 定义被隐藏，正文出现带 title 的 abbr', () => {
  const { env } = renderPipeline(DOC);
  const abbr = env.preview.querySelector('abbr');
  assert.ok(abbr, '应生成 <abbr>');
  assert.ok((abbr.getAttribute('title') || '').indexOf('HyperText') >= 0, 'abbr 应带 title');
  assert.strictEqual(env.preview.querySelector('#abbr-data'), null, 'abbr-data 隐藏容器应被移除');
});
