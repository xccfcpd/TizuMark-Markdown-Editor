// 回归测试：Mermaid 之外的原生图表引擎（ECharts / WaveDrom / Graphviz / TikZ / plot / Markmap）。
//
// 守卫三类失效点（与 mhchem 那次同一套路）：
//   ① 模块清单漂移：新增 src/modules/diagram-renderers.js 却漏加 <script>（entry-scripts 也会查，
//      这里再钉一次「lib 脚本 + 模块脚本」是否齐全）；
//   ② vendor 再生清单漏拷：ensure-vendor 没把各引擎/皮肤纳入，npm install 后 src/lib 缺文件，
//      真机表现为代码块不渲染（且不报错）；
//   ③ 分发逻辑退化：语言标记 → 引擎类型的映射、代码块收集规则被改坏。
//
// 另：五线谱（abcjs）支持已于 2026-09-24 完整移除，本文件同时钉住「移除后不得复活」
// （语言标记回落为 null、vendor 清单无 abcjs、package.json / lock 均无 abcjs 依赖）。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const INDEX = path.join(ROOT, 'src', 'index.html');
const VENDOR = path.join(ROOT, 'scripts', 'ensure-vendor.mjs');
const PKG = path.join(ROOT, 'package.json');
const LOCK = path.join(ROOT, 'package-lock.json');

const DR = require('../src/modules/diagram-renderers.js');
const PP = require('../src/modules/preview-post.js');

// ---- ① 语言标记 → 引擎类型 ----

test('diagramTypeFromLanguage：语言标记映射与别名', () => {
  assert.strictEqual(DR.diagramTypeFromLanguage('echarts'), 'echarts');
  assert.strictEqual(DR.diagramTypeFromLanguage('wavedrom'), 'wavedrom');
  assert.strictEqual(DR.diagramTypeFromLanguage('wave'), 'wavedrom', 'wave 是 wavedrom 的别名');
  assert.strictEqual(DR.diagramTypeFromLanguage('dot'), 'graphviz');
  assert.strictEqual(DR.diagramTypeFromLanguage('graphviz'), 'graphviz');
  assert.strictEqual(DR.diagramTypeFromLanguage('gv'), 'graphviz', 'gv 是 graphviz 的别名');
  // 大小写 / 空白容错
  assert.strictEqual(DR.diagramTypeFromLanguage('  ECharts '), 'echarts');
  // 五线谱已移除：abc / abcjs 必须回落到「非图表语言」（代码块只按普通代码块显示）
  assert.strictEqual(DR.diagramTypeFromLanguage('abc'), null, 'abc 不应再被识别为图表引擎（已移除）');
  assert.strictEqual(DR.diagramTypeFromLanguage('abcjs'), null, 'abcjs 不应再被识别为图表引擎（已移除）');
  // 非图表语言一律返回 null（不能误吞普通代码块）
  for (const lang of ['js', 'python', 'mermaid', 'json', '', null, undefined]) {
    assert.strictEqual(DR.diagramTypeFromLanguage(lang), null, `${lang} 不应被识别为图表引擎`);
  }
});

// ---- ② 入口清单与 vendor 清单 ----

test('index.html 加载各引擎脚本与皮肤，且不含远程 CDN', () => {
  const html = fs.readFileSync(INDEX, 'utf8');
  for (const src of [
    'lib/echarts.min.js',
    'lib/wavedrom/wavedrom.min.js',
    'lib/wavedrom/skins/default.js',
    'lib/wavedrom/skins/dark.js',
    'lib/graphviz.min.js',
    'modules/diagram-renderers.js',
  ]) {
    assert.ok(html.includes(`src="${src}"`), `index.html 缺少 <script src="${src}">`);
  }
  // 完全离线：这些脚本必须是本地路径，不能出现外链
  assert.ok(!/<script[^>]+src="https?:\/\//.test(html), 'index.html 不应引入远程脚本（离线要求）');
  // 五线谱已移除：入口不得再加载 abcjs（否则会白拷一个用不到的 vendor 文件）
  assert.ok(!html.includes('abcjs'), 'index.html 不应再引用 abcjs（支持已移除）');
});

test('vendor 清单含各引擎与 wavedrom 皮肤（含 wavedrom 无 dist 的特殊路径）', () => {
  const src = fs.readFileSync(VENDOR, 'utf8');
  const expected = [
    /echarts\/dist\/echarts\.min\.js['"]\s*,\s*['"]echarts\.min\.js/,
    /wavedrom\/wavedrom\.unpkg\.min\.js['"]\s*,\s*['"]wavedrom\/wavedrom\.min\.js/,
    /wavedrom\/skins\/default\.js/,
    /wavedrom\/skins\/dark\.js/,
    /@hpcc-js\/wasm\/dist\/graphviz\.umd\.js['"]\s*,\s*['"]graphviz\.min\.js/,
  ];
  for (const re of expected) {
    assert.ok(re.test(src), `ensure-vendor.mjs 缺少映射：${re}`);
  }
  assert.ok(!/abcjs/i.test(src), 'ensure-vendor.mjs 不应再打包 abcjs（支持已移除）');
});

test('package.json / lock 声明各引擎依赖且已无 abcjs（npm ci 需要 lock 同步）', () => {
  const pkg = JSON.parse(fs.readFileSync(PKG, 'utf8'));
  for (const name of ['echarts', 'wavedrom', '@hpcc-js/wasm']) {
    assert.ok(pkg.dependencies && pkg.dependencies[name], `package.json dependencies 缺少 ${name}`);
  }
  // 五线谱已移除：两处声明都必须清掉 —— package.json 与 lock 不同步会让 `npm ci` 直接失败
  assert.ok(!(pkg.dependencies && pkg.dependencies.abcjs), 'package.json 不应再声明 abcjs');
  const lock = JSON.parse(fs.readFileSync(LOCK, 'utf8'));
  assert.ok(!(lock.packages && lock.packages['node_modules/abcjs']),
    'package-lock.json 仍残留 node_modules/abcjs（npm ci 会报锁文件与 package.json 不同步）');
  assert.ok(!(lock.packages && lock.packages[''] && lock.packages[''].dependencies &&
    lock.packages[''].dependencies.abcjs), 'package-lock.json 根依赖仍声明 abcjs');
});

test('ResizeObserver 良性告警已处理（rAF 内 resize + 全局兜底过滤）', () => {
  // 症状：ECharts 容器上的 ResizeObserver 在回调里同步 resize 会触发
  // "ResizeObserver loop completed with undelivered notifications"，
  // 被全局错误兜底显示成红色错误条。两道防线都要在：
  const dr = fs.readFileSync(path.join(ROOT, 'src', 'modules', 'diagram-renderers.js'), 'utf8');
  assert.ok(/requestAnimationFrame\(applyResize\)/.test(dr), 'ECharts resize 必须用 rAF 调度');
  const html = fs.readFileSync(INDEX, 'utf8');
  assert.ok(/isBenignBrowserNotice/.test(html), 'index.html 全局兜底应包含 isBenignBrowserNotice');
  assert.ok(/ResizeObserver loop/.test(html), 'index.html 应过滤 ResizeObserver loop 提示');
  assert.strictEqual((html.match(/isBenignBrowserNotice\(msg\)/g) || []).length, 2, 'error 与 unhandledrejection 两个入口都要过滤');
});

// ---- ③ 代码块收集（jsdom） ----

function makePreviewDom() {
  // 未安装依赖（无 jsdom）的环境返回 null，相关用例静默跳过，不阻断该文件的静态断言
  let JSDOM, installGlobals;
  try {
    ({ JSDOM } = require('jsdom'));
    ({ installGlobals } = require('./helpers/dom.js'));
  } catch (_) { return null; }
  const dom = new JSDOM('<!DOCTYPE html><html><body><div class="preview-content"></div></body></html>', {
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  // 装全局（document/window 等）：被测模块内部会读全局 document 构造 DOM
  installGlobals(dom.window);
  return { window: dom.window, document: dom.window.document, preview: dom.window.document.querySelector('.preview-content') };
}

test('collectDiagramBlocks：只收图表语言，忽略普通代码块与行内 code', () => {
  const env = makePreviewDom();
  if (!env) return; // 缺 jsdom 依赖则跳过
  const { window, preview } = env;
  assert.ok(window.document, 'jsdom 环境应可用');
  preview.innerHTML = [
    '<pre><code class="language-echarts">{"series":[]}</code></pre>',
    // 五线谱已移除：abc 代码块必须**不被**收集（走普通代码块路径，不触发任何引擎）
    '<pre><code class="language-abc">X:1\nK:C\nCDEF</code></pre>',
    '<pre><code class="language-wavedrom">{"signal":[]}</code></pre>',
    '<pre><code class="language-javascript">const a = 1;</code></pre>',
    '<p>行内 <code class="language-echarts">{"x":1}</code> 不算代码块</p>',
  ].join('\n');

  const blocks = PP.collectDiagramBlocks(preview, (lang) => DR.diagramTypeFromLanguage(lang));
  assert.strictEqual(blocks.length, 2, '应只收 2 个图表代码块（abc 已不再算图表）');
  assert.deepStrictEqual(blocks.map((b) => b.type), ['echarts', 'wavedrom']);
  assert.ok(blocks[0].code.includes('series'), '代码内容应原样带出');
  assert.ok(blocks[0].pre && blocks[0].pre.tagName === 'PRE', '应带上 <pre> 以便原位替换');
});

test('renderInto：引擎缺失时报可读错误（不静默空白）', async () => {
  const env = makePreviewDom();
  if (!env) return; // 缺 jsdom 依赖则跳过
  const { window, document } = env;
  const container = document.createElement('div');
  // 该 jsdom 进程未加载 echarts 全局 → 渲染器应抛「未加载」并写入 .diagram-error
  const ok = await DR.renderInto(container, 'echarts', '{"series":[]}', { isDark: false });
  assert.strictEqual(ok, false, '引擎缺失时返回 false');
  assert.ok(container.classList.contains('diagram-error'), '应标记为 diagram-error');
  assert.ok(container.querySelector('.diagram-error-msg'), '应显示失败原因');
  assert.ok(container.querySelector('pre code').textContent.includes('series'), '应保留原始源码便于修改');
  assert.ok(window, 'jsdom window 保持可用');
});

test('renderInto：Graphviz 异步路径在引擎缺失时同样给出可读错误', async () => {
  const env = makePreviewDom();
  if (!env) return;
  const { document } = env;
  const container = document.createElement('div');
  const ok = await DR.renderInto(container, 'graphviz', 'digraph G { a -> b }', { isDark: false });
  assert.strictEqual(ok, false, 'Graphviz 未加载时返回 false');
  assert.ok(container.querySelector('.diagram-error-msg').textContent.includes('Graphviz'), '错误信息应含引擎名');
});

test('extractDotEngine：首行 // engine: 指令选择布局引擎', () => {
  assert.deepStrictEqual(DR.extractDotEngine('digraph G { a -> b }'), { source: 'digraph G { a -> b }', engine: 'dot' });
  const withNeato = DR.extractDotEngine('// engine: neato\ngraph G { a -- b }');
  assert.strictEqual(withNeato.engine, 'neato', '应识别 neato');
  assert.ok(!withNeato.source.includes('engine:'), '指令行应从源码中移除');
  assert.strictEqual(withNeato.source.trim(), 'graph G { a -- b }', '其余源码保持不变');
  // 非法引擎名回退 dot，且不破坏源码（DOT 里 // 本就是注释）
  const bogus = DR.extractDotEngine('// engine: nosuch\n digraph G {}');
  assert.strictEqual(bogus.engine, 'dot');
  assert.ok(bogus.source.includes('nosuch'), '非白名单引擎应原样保留（回退为注释）');
});
