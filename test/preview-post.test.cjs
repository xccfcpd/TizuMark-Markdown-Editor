// 回归测试：预览后处理聚合模块 src/modules/preview-post.js
// 覆盖 emoji 短码、数学(KaTeX 未加载时安全跳过)、缩写(abbr)、标题锚点、复制按钮、mermaid 跳过。
const test = require('node:test');
const assert = require('node:assert');
const { createPreviewDom, installGlobals, loadHljs } = require('./helpers/dom.js');
const { renderMarkdown } = require('../src/unified-renderer.js');
const PP = require('../src/modules/preview-post.js');
const { processCodeBlocks } = require('../src/modules/code-block.js');
const { B } = require('./helpers/dom.js');

const { preview: _g } = createPreviewDom();
installGlobals(_g.ownerDocument.defaultView);

const noopT = (k) => k;
const escapeAttr = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escapeHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;');
const headingToId = (text) => {
  let id = '';
  for (const ch of text) {
    if (/[\p{L}\p{N}]/u.test(ch)) id += ch.toLowerCase();
    else if (ch === ' ' || ch === '-' || ch === '_') id += '-';
  }
  return id.replace(/-+/g, '-').replace(/^-|-$/g, '');
};
const opts = { t: noopT, isDark: false, escapeHtml, escapeAttr, headingToId };

test('emoji 短码被替换（跳过 code/pre）', async () => {
  const { preview } = createPreviewDom();
  preview.innerHTML = '<p>hello :fire: world</p><pre><code>:fire:</code></pre>';
  PP.processEmojiShortcodes(preview);
  assert.ok(preview.querySelector('p').textContent.includes('🔥'), '段落内应替换');
  assert.ok(preview.querySelector('pre code').textContent.includes(':fire:'), 'code 内不应替换');
});

test('数学未加载时安全跳过不抛错', async () => {
  const { preview } = createPreviewDom();
  preview.innerHTML = '<p>公式 $a+b$</p>';
  // renderMathInElement 未定义（jsdom 全局无）
  assert.doesNotThrow(() => PP.processMath(preview));
});

test('protectUnpairedDollar：块级公式内含 | > ｜ 不应被误判为不成对', async () => {
  // 条件概率：含 |
  const bayes = '$$ P(A|B) = \\frac{P(B|A) \\cdot P(A)}{P(B)} $$';
  assert.strictEqual(PP.protectUnpairedDollar(bayes), bayes, '含 | 的块级公式应保持原样');
  assert.ok(!PP.protectUnpairedDollar(bayes).includes('katex-ignore'), '不应包裹忽略 span');

  // 绝对值/范数：含 ||
  const norm = '$$ \\|x\\| = \\sqrt{x^2} $$';
  assert.strictEqual(PP.protectUnpairedDollar(norm), norm, '含 || 的块级公式应保持原样');

  // 比较符号：含 >
  const gt = '$$ f(x) \\text{ if } x > 0 $$';
  assert.strictEqual(PP.protectUnpairedDollar(gt), gt, '含 > 的块级公式应保持原样');

  // 全角竖线
  const fw = '$$ a ｜ b $$';
  assert.strictEqual(PP.protectUnpairedDollar(fw), fw, '含 ｜ 的块级公式应保持原样');

  // 块级跨行
  const multi = '$$\nfoo\nbar\n$$';
  assert.strictEqual(PP.protectUnpairedDollar(multi), multi, '块级跨行公式应保持原样');
});

test('protectUnpairedDollar：行内 $...$ 内含 | > ｜ 应保留为成对公式', async () => {
  assert.strictEqual(PP.protectUnpairedDollar('see $P(A|B)$ here'), 'see $P(A|B)$ here', '含 | 的行内公式应保留');
  assert.strictEqual(PP.protectUnpairedDollar('$x>0$'), '$x>0$', '含 > 的行内公式应保留');
  assert.strictEqual(PP.protectUnpairedDollar('$x｜y$'), '$x｜y$', '含 ｜ 的行内公式应保留');
});

test('protectUnpairedDollar：行内 $...$ 在表格分隔符环境中仍不被跨单元格配对', async () => {
  const inline = '| $x | y$ |';
  const out = PP.protectUnpairedDollar(inline);
  assert.ok(out.includes('katex-ignore'), '表格行内的 $ 仍应被忽略 span 保护');
});

test('protectUnpairedDollar：真不成对的孤 $ 应被忽略', async () => {
  const stray = 'price is $5 and $6 today';
  const out = PP.protectUnpairedDollar(stray);
  assert.ok(out.includes('katex-ignore'), '孤 $ 应被忽略 span 包住');
});

test('缩写 abbr 被替换且跳过 code/pre', async () => {
  const { preview } = createPreviewDom();
  preview.innerHTML = '<div id="abbr-data" data-abbrs=\'[[ "Tizu", "TizuMark 编辑器" ]]\'></div><p>用 Tizu 写文档，<code>Tizu</code> 不替换</p>';
  PP.processAbbreviations(preview, opts);
  const p = preview.querySelector('p');
  assert.ok(p.querySelector('abbr'), '段落内应生成 abbr');
  assert.strictEqual(p.querySelector('code').textContent, 'Tizu', 'code 内不替换');
  assert.strictEqual(preview.querySelector('#abbr-data'), null, 'abbr-data 应被移除');
});

test('标题锚点按 headingToId 生成且去重', async () => {
  const { preview } = createPreviewDom();
  preview.innerHTML = '<h1>Hello World</h1><h1>Hello World</h1><h2>Hello World</h2>';
  PP.processHeadings(preview, opts);
  const ids = [...preview.querySelectorAll('h1, h2')].map(h => h.id);
  assert.deepStrictEqual(ids, ['hello-world', 'hello-world-2', 'hello-world-3']);
});

test('复制按钮注入且 mermaid 块不加复制按钮', async () => {
  const { preview } = createPreviewDom();
  preview.innerHTML = '<pre><code>const a=1;</code></pre><pre><code class="language-mermaid">graph TD;A-->B;</code></pre>';
  PP.addCopyButtons(preview, opts);
  const pres = preview.querySelectorAll('pre');
  assert.strictEqual(pres[0].querySelector('.copy-btn') !== null, true, '普通代码块应有复制按钮');
  assert.strictEqual(pres[1].querySelector('.copy-btn'), null, 'mermaid 块不应有复制按钮');
});

test('mermaid 未加载时跳过不抛错', async () => {
  const { preview } = createPreviewDom();
  preview.innerHTML = '<pre><code class="language-mermaid">graph TD;A-->B;</code></pre>';
  assert.doesNotThrow(async () => { await PP.processMermaid(preview, opts); });
});

test('mermaid initialize 使用 strict securityLevel（XSS 防护）', async () => {
  const { preview, window } = createPreviewDom();
  let initArgs = null;
  window.mermaid = {
    initialize: (cfg) => { initArgs = cfg; },
    run: async () => {},
  };
  global.mermaid = window.mermaid;
  preview.innerHTML = '<pre><code class="language-mermaid">graph TD;A-->B;</code></pre>';
  await PP.processMermaid(preview, { isDark: false, mermaidCache: null });
  assert.ok(initArgs, '应调用 mermaid.initialize');
  assert.strictEqual(initArgs.securityLevel, 'strict', 'securityLevel 应为 strict（loose 允许图内嵌 HTML 执行）');
  delete global.mermaid;
});

test('集成：完整 markdown 经 unified 渲染 + 后处理后结构正常', async () => {
  const { preview } = createPreviewDom();
  const md = '# 标题 Hello\n\n正文 :star: 测试\n\n' + B + B + B + 'js\nconst a = 1;\n' + B + B + B;
  preview.innerHTML = renderMarkdown(md, { softBreaks: false });
  PP.processEmojiShortcodes(preview);
  PP.processHeadings(preview, opts);
  PP.addCopyButtons(preview, opts);
  assert.strictEqual(preview.querySelector('h1').id, '标题-hello', '标题锚点应与 headingToId 一致');
  assert.ok(preview.querySelector('p').textContent.includes('⭐'), 'emoji 应替换');
  assert.strictEqual(preview.querySelector('pre .copy-btn') !== null, true, '代码块应有复制按钮');
});

// 构造带行号包裹的代码块：渲染 + 行号后处理，得到 .code-line-num + .code-line-text 结构
function buildCodeBlock(md, lineNumbers) {
  const { preview, window } = createPreviewDom();
  const hljs = loadHljs(window);
  const cache = new Map();
  preview.innerHTML = renderMarkdown(md, { softBreaks: false });
  processCodeBlocks(preview, { hljs, cache, lineNumbers });
  return preview;
}

test('复制按钮：多行代码块复制原始代码（无行号、保留缩进与空行）', async () => {
  const md = B + B + B + 'python\n' +
    'def foo():\n' +
    '    if True:\n' +
    '        return 1\n' +
    '\n' +
    '    return 0\n' +
    B + B + B;
  const preview = buildCodeBlock(md, true);
  // 断言结构确实含行号（复现 bug 前提：旧实现会把这些数字拼进 textContent）
  assert.ok(preview.querySelector('.code-line-num'), '渲染结构应含 .code-line-num（bug 前提）');

  const copied = PP.getRawCodeText(preview.querySelector('pre'));
  const expected = 'def foo():\n    if True:\n        return 1\n\n    return 0';
  assert.strictEqual(copied, expected, '复制内容应与编辑器原始代码一致（无行号、保留缩进与空行）');
  // 行号数字不应出现在复制内容中（不能被误拼进代码）
  assert.ok(!/^\d/.test(copied) && !/\n\d/.test(copied), '复制内容不应混入行号数字');
  assert.ok(copied.includes('    if True:'), '缩进空格应被保留');
});

test('复制按钮：单行代码块复制原始内容（无行号包裹）', async () => {
  const md = B + B + B + 'js\nconst a = 1;\n' + B + B + B;
  const preview = buildCodeBlock(md, true);
  const copied = PP.getRawCodeText(preview.querySelector('pre'));
  assert.strictEqual(copied, 'const a = 1;', '单行块应原样复制');
});

test('复制按钮：行号关闭时仍复制原始代码（无行号、保留缩进）', async () => {
  const md = B + B + B + 'python\n' +
    'def bar():\n' +
    '    pass\n' +
    B + B + B;
  const preview = buildCodeBlock(md, false);
  const copied = PP.getRawCodeText(preview.querySelector('pre'));
  assert.strictEqual(copied, 'def bar():\n    pass', '行号关闭时复制内容应与原始代码一致');
});

// ===== 集成：KaTeX 实际渲染带空格行内公式（用户复现）=====

test('集成：原始 HTML 表格中带空格的行内公式被 KaTeX 渲染', async () => {
  // 用 Node 的 CommonJS 构建加载 KaTeX（比 jsdom window.eval 可靠：katex.min.js 是 UMD，
  // 在 window 上下文下可能因 module/exports 检测或内部引用而挂不上 katex/renderMathInElement，
  // 导致 processMath 走"未加载"分支跳过渲染）。processMath 在 Node 模块作用域运行，
  // renderMathInElement / document / Node 等都走 global，故挂到 Node global 并补齐
  // auto-render 内部引用的 Node/Element 等全局。
  const katex = require('katex');
  const renderMathInElement = require('katex/contrib/auto-render');
  const w = _g.ownerDocument.defaultView;
  const savedRenderMath = global.renderMathInElement;
  const savedKatex = global.katex;
  global.katex = katex;
  global.renderMathInElement = renderMathInElement;
  global.Node = w.Node;
  global.Element = w.Element;
  global.HTMLElement = w.HTMLElement;
  global.Text = w.Text;
  global.DocumentFragment = w.DocumentFragment;

  try {
    const md = `<table border=1><tr><td>$ \\varphi_{k}(°) $</td><td>$ M_{b} $</td><td>$ M_{d} $</td><td>$ M_{c} $</td></tr><tr><td>0</td><td>0</td><td>1.00</td><td>3.14</td></tr></table>`;
    _g.innerHTML = renderMarkdown(md, { softBreaks: false });
    PP.processMath(_g);
    const katexCount = _g.querySelectorAll('.katex').length;
    const cellCount = _g.querySelectorAll('td').length;
    assert.ok(katexCount >= 4, `表格内 4 个公式应被 KaTeX 渲染，实际 ${katexCount}`);
    assert.strictEqual(cellCount, 8, '表格结构应保持 8 个单元格');
  } finally {
    global.renderMathInElement = savedRenderMath;
    global.katex = savedKatex;
    delete global.Node; delete global.Element; delete global.HTMLElement; delete global.Text; delete global.DocumentFragment;
  }
});

// ===== 图表两阶段：源码占位（修「预览里一会儿代码、一会儿图」的闪动）=====
// 背景：预览流程是「innerHTML 写入 → 后处理」，其中 processImages 等步骤含 await；
// 只要图表块在这段时间里还是**源码**形态留在 DOM 里，浏览器就会把它画出来，
// 等渲染完成再被图替换 —— 肉眼看到的就是交替闪动（用户 2026-09-23 / 09-24 两次报障）。
// 修法：占位必须**同步**打好（prepareDiagramPlaceholders），渲染放到后面异步做。

// mermaid 桩：prepare 阶段只判断「mermaid 是否加载」，render 阶段才真正调用
function stubMermaid(behavior) {
  const prev = global.mermaid;
  global.mermaid = {
    initialize() {},
    run: async ({ nodes }) => {
      if (behavior === 'fail') throw new Error('stub: mermaid 渲染失败');
      nodes.forEach((n) => { n.innerHTML = '<svg></svg>'; });
    },
  };
  return () => { global.mermaid = prev; };
}

test('两阶段①：prepare 同步把源码换成/标记为占位（此时尚未渲染）', () => {
  const { preview } = createPreviewDom();
  preview.innerHTML =
    '<pre><code class="language-plantuml">@startuml\nAlice -> Bob: hi\n@enduml</code></pre>' +
    '<pre><code class="language-echarts">{"series":[]}</code></pre>';
  const restore = stubMermaid('ok');
  try {
    const jobs = PP.prepareDiagramPlaceholders(preview, { isDark: false, mermaidCache: new Map() });
    // ① PlantUML / D2：就地改写为 mermaid 并打占位标记。源码**留在 <pre> 内**（mermaid 要读它），
    //    由 CSS 隐藏 —— 各后处理器都按 PRE/CODE 跳过，不会被误改。
    const mPre = preview.querySelector('pre.diagram-src-pending');
    assert.ok(mPre, 'PlantUML 代码块应被标记 .diagram-src-pending');
    const mCode = mPre.querySelector('code');
    assert.ok(/language-mermaid/.test(mCode.className), 'PlantUML 应已就地改写为 mermaid');
    assert.ok((mCode.textContent || '').trim().length > 0, '源码应保留在 <pre><code> 内');
    // ② 原生引擎：源码块直接换成占位容器（容器里没有源码）
    const native = preview.querySelector('.diagram-container[data-diagram-type="echarts"]');
    assert.ok(native, 'ECharts 代码块应换成图表容器');
    assert.ok(native.classList.contains('diagram-pending'), '替换后应为占位态');
    assert.strictEqual(preview.querySelectorAll('pre code.language-echarts').length, 0, '源码块不应残留');
    assert.strictEqual(jobs.mermaid.length, 1, '作业表应记录 1 个 mermaid 块');
    assert.strictEqual(jobs.native.length, 1, '作业表应记录 1 个原生引擎块');
  } finally { restore(); }
});

test('两阶段②：渲染后摘掉占位并写缓存；命中缓存时不再出现占位态', async () => {
  const { preview } = createPreviewDom();
  const cache = new Map();
  const src = '<pre><code class="language-mermaid">graph TD; A-->B;</code></pre>';
  preview.innerHTML = src;
  const restore = stubMermaid('ok');
  try {
    const jobs = PP.prepareDiagramPlaceholders(preview, { isDark: false, mermaidCache: cache });
    assert.strictEqual(preview.querySelectorAll('pre.diagram-src-pending').length, 1, '渲染前应是占位态');
    await PP.renderDiagramPlaceholders(preview, jobs, { isDark: false, mermaidCache: cache });
    const c = preview.querySelector('.diagram-container[data-diagram-type="mermaid"]');
    assert.ok(c, '应换成 mermaid 容器');
    assert.ok(!c.classList.contains('diagram-pending'), '渲染后必须摘掉占位');
    assert.ok(c.querySelector('svg'), '容器里应是渲染结果');
    assert.strictEqual(preview.querySelectorAll('pre.diagram-src-pending').length, 0, '不得残留占位标记');
    assert.strictEqual(cache.size, 1, '成功结果应写入缓存（下次同步复用 → 不再闪）');

    // 同样的源码再来一次：命中缓存 → 直接就是图，不经过占位态
    preview.innerHTML = src;
    const jobs2 = PP.prepareDiagramPlaceholders(preview, { isDark: false, mermaidCache: cache });
    await PP.renderDiagramPlaceholders(preview, jobs2, { isDark: false, mermaidCache: cache });
    const c2 = preview.querySelector('.diagram-container[data-diagram-type="mermaid"]');
    assert.ok(c2 && c2.querySelector('svg'), '缓存命中应直接复用 SVG');
    assert.ok(!c2.classList.contains('diagram-pending'), '缓存命中不应出现占位态');
  } finally { restore(); }
});

test('两阶段③：mermaid 渲染失败也必须摘掉占位（不再压着「图表渲染中…」）', async () => {
  const { preview } = createPreviewDom();
  preview.innerHTML = '<pre><code class="language-mermaid">graph TD; A-->B;</code></pre>';
  const restore = stubMermaid('fail');
  try {
    const jobs = PP.prepareDiagramPlaceholders(preview, { isDark: false, mermaidCache: new Map() });
    await PP.renderDiagramPlaceholders(preview, jobs, { isDark: false, mermaidCache: new Map() });
    const c = preview.querySelector('.diagram-container[data-diagram-type="mermaid"]');
    assert.ok(c, '失败时容器仍在（用户要能看到源码/错误，而不是永久占位）');
    assert.ok(!c.classList.contains('diagram-pending'), '失败也必须摘掉占位');
    assert.strictEqual(preview.querySelectorAll('pre.diagram-src-pending').length, 0, '不得残留占位标记');
  } finally { restore(); }
});
