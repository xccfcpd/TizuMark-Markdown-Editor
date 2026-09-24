// 图表查看器（lightbox）里图表一片空白 —— 回归测试
//
// 根因（历史）：引擎生成的 <svg> **自身不带 width/height**、尺寸靠
//   `.diagram-container .markmap-svg { width:100%; height:100% }` 这类有作用域的 CSS 撑开；
//   而 lightbox 把 SVG 克隆到 `.diagram-container` 之外，该 CSS 不再匹配 → 视口塌陷。
//   引擎按**原容器尺寸**算好的 `<g transform>`（居中缩放）保持不变，
//   于是整棵树被推到视口之外 → 点开一片空白。
//
// 修复：prepareSvgForLightbox() 把真实渲染尺寸与 viewBox 显式写到克隆上，
//   使用户坐标系与原图一致；仅对「原本靠外部 CSS 撑尺寸」的 SVG 加 .lightbox-svg-adapt。
//
// 现状：五大引擎已全部自带尺寸信息（Markmap 亦于 renderMarkmap 中写死 width/height/viewBox，
//   原因见 test/markmap-svg-geometry.test.cjs），故正常路径都走「早返回」；本文件保留的夹具
//   代表「靠外部 CSS 撑尺寸」这一类，用于守住兜底分支不被误删。
const test = require('node:test');
const assert = require('node:assert');
const { buildEnv, cleanup, waitForEditor } = require('./helpers/app-env.cjs');

const SVG_NS = 'http://www.w3.org/2000/svg';
const RECT = (w, h) => ({ width: w, height: h, top: 0, left: 0, right: w, bottom: h, x: 0, y: 0 });

// 夹具：只用 class 定尺寸、不带 width/height/viewBox 的 SVG（代表「靠外部 CSS 撑尺寸」一类）
function makeMarkmapLikeSvg(w, size) {
  const svg = w.document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'markmap-svg');
  const g = w.document.createElementNS(SVG_NS, 'g');
  g.setAttribute('transform', 'translate(120,80) scale(1)');
  svg.appendChild(g);
  const r = size || { width: 640, height: 420 };
  svg.getBoundingClientRect = () => RECT(r.width, r.height);
  return { svg, g };
}

test('Markmap 类 SVG（自身无尺寸）：补上显式尺寸与 viewBox，内容坐标系不丢', async () => {
  const { w } = await buildEnv();
  const ed = await waitForEditor(w);
  try {
    const { svg, g } = makeMarkmapLikeSvg(w);

    const clone = ed.prepareSvgForLightbox(svg);

    assert.notStrictEqual(clone, svg, '应返回克隆而非原节点');
    assert.strictEqual(clone.getAttribute('width'), '640', '应补显式宽度');
    assert.strictEqual(clone.getAttribute('height'), '420', '应补显式高度');
    assert.strictEqual(clone.getAttribute('viewBox'), '0 0 640 420', '应补与原尺寸一致的 viewBox');
    assert.match(clone.getAttribute('class'), /lightbox-svg-adapt/, '应标记为浮层自适应缩放');
    assert.strictEqual(
      clone.querySelector('g').getAttribute('transform'),
      g.getAttribute('transform'),
      '内部 transform 必须原样保留（内容位置依赖它）',
    );

    assert.strictEqual(svg.getAttribute('viewBox'), null, '原节点的 viewBox 不应被改动');
    assert.strictEqual(svg.getAttribute('width'), null, '原节点的 width 不应被改动');
  } finally { cleanup(w); }
});

test('只有 width="100%"（Mermaid 类，无 height）：补实测尺寸 + 自适应类', async () => {
  // 现行规则（见 misc-ui.js prepareSvgForLightbox 的注释）：**width 与 height 都具备**才算
  // "自带尺寸"，从这里早返回；只写了 width="100%" 的一类，实际尺寸仍由外部 CSS 决定，
  // 克隆到浮层后那套作用域 CSS 不再匹配 → 与 markmap 曾经的"点开一片空白"同类问题。
  // 故补上**实测**宽高、保留 viewBox（坐标系不变）、对齐归中，并加 .lightbox-svg-adapt
  // 让浮层里等比放大到视口内。
  const { w } = await buildEnv();
  const ed = await waitForEditor(w);
  try {
    const svg = w.document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'mermaid-svg');
    svg.setAttribute('width', '100%');
    svg.setAttribute('viewBox', '0 0 800 600');
    svg.getBoundingClientRect = () => RECT(800, 600);

    const clone = ed.prepareSvgForLightbox(svg);

    assert.strictEqual(clone.getAttribute('width'), '800', 'width="100%" 不是自带尺寸，应换成实测宽度');
    assert.strictEqual(clone.getAttribute('height'), '600', '应补上实测高度');
    assert.strictEqual(clone.getAttribute('viewBox'), '0 0 800 600', 'viewBox 必须原样保留（用户坐标系不变）');
    assert.strictEqual(clone.getAttribute('preserveAspectRatio'), 'xMidYMid meet', '应对齐归中，避免内容贴左上角');
    assert.match(clone.getAttribute('class'), /lightbox-svg-adapt/, '应加自适应类，浮层里等比放大');
    // 原节点不得被改动（浮层用的是克隆）
    assert.strictEqual(svg.getAttribute('width'), '100%', '原节点 width 不应被改动');
    assert.strictEqual(svg.getAttribute('height'), null, '原节点不应凭空补 height');
  } finally { cleanup(w); }
});

test('拿不到真实尺寸（元素隐藏）：不猜测，保持原样', async () => {
  const { w } = await buildEnv();
  const ed = await waitForEditor(w);
  try {
    const { svg } = makeMarkmapLikeSvg(w, { width: 0, height: 0 });

    const clone = ed.prepareSvgForLightbox(svg);

    assert.strictEqual(clone.getAttribute('viewBox'), null, '无尺寸时不应补 viewBox');
    assert.strictEqual(clone.getAttribute('width'), null, '无尺寸时不应补 width');
    assert.ok(!/lightbox-svg-adapt/.test(clone.getAttribute('class') || ''), '无尺寸时不应加自适应类');
  } finally { cleanup(w); }
});

test('showLightbox 接线：查看器里的 SVG 已带 viewBox 与自适应类', async () => {
  const { w } = await buildEnv();
  const ed = await waitForEditor(w);
  try {
    // jsdom 无布局：stub rAF，避免 initFit 因取不到尺寸而逐帧重试
    w.requestAnimationFrame = () => 0;
    const { svg } = makeMarkmapLikeSvg(w);

    ed.showLightbox(svg, 'svg');

    const wrapper = w.document.querySelector('.image-lightbox .lightbox-svg-wrapper');
    assert.ok(wrapper, '应创建 .lightbox-svg-wrapper 容器');
    const inLightbox = wrapper.querySelector('svg');
    assert.ok(inLightbox, '查看器内应包含 svg');
    assert.strictEqual(inLightbox.getAttribute('viewBox'), '0 0 640 420', '查看器内 svg 应带上 viewBox');
    assert.match(inLightbox.getAttribute('class'), /lightbox-svg-adapt/);
  } finally { cleanup(w); }
});

test('Markmap 当前的产出（自带 width/height/viewBox）：早返回，由 .markmap-svg 规则缩放', async () => {
  const { w } = await buildEnv();
  const ed = await waitForEditor(w);
  try {
    // 与 renderMarkmap 现在的产出一致（见 test/markmap-svg-geometry.test.cjs）
    const svg = w.document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'markmap-svg');
    svg.setAttribute('width', '900');
    svg.setAttribute('height', '420');
    svg.setAttribute('viewBox', '0 0 900 420');
    svg.getBoundingClientRect = () => RECT(900, 420);

    const clone = ed.prepareSvgForLightbox(svg);

    assert.strictEqual(clone.getAttribute('width'), '900', '不应改写引擎自带的尺寸');
    assert.strictEqual(clone.getAttribute('viewBox'), '0 0 900 420', '不应改写自带 viewBox');
    assert.ok(!/lightbox-svg-adapt/.test(clone.getAttribute('class') || ''), '自带尺寸者不加自适应类');
    assert.match(clone.getAttribute('class'), /markmap-svg/, '类名必须保留：查看器靠它匹配 .markmap-svg 规则');
  } finally { cleanup(w); }
});
