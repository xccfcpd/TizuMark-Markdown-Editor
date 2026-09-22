// 图表查看器（lightbox）里 Markmap 一片空白 —— 回归测试
//
// 根因：Markmap 生成的 <svg> **自身不带 width/height**，尺寸靠
//   `.diagram-container .markmap-svg { width:100%; height:100% }` 撑开；
//   而 lightbox 把 SVG 克隆到 `.diagram-container` 之外，该 CSS 不再匹配 → 视口塌陷。
//   Markmap 内部那个按**原容器尺寸**算好的 `<g transform>`（居中缩放）保持不变，
//   于是整棵树被推到视口之外 → 点开一片空白。
//
// 修复：prepareSvgForLightbox() 把真实渲染尺寸与 viewBox 显式写到克隆上，
//   使用户坐标系与原图一致；仅对「原本靠外部 CSS 撑尺寸」的 SVG 加 .lightbox-svg-adapt。
const test = require('node:test');
const assert = require('node:assert');
const { buildEnv, cleanup, waitForEditor } = require('./helpers/app-env.cjs');

const SVG_NS = 'http://www.w3.org/2000/svg';
const RECT = (w, h) => ({ width: w, height: h, top: 0, left: 0, right: w, bottom: h, x: 0, y: 0 });

// 与 renderMarkmap 产出同构：只有 class，没有 width/height/viewBox
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

test('自带尺寸/viewBox 的 SVG（Mermaid 类）：完全不动，且不强加自适应类', async () => {
  const { w } = await buildEnv();
  const ed = await waitForEditor(w);
  try {
    const svg = w.document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'mermaid-svg');
    svg.setAttribute('width', '100%');
    svg.setAttribute('viewBox', '0 0 800 600');
    svg.getBoundingClientRect = () => RECT(800, 600);

    const clone = ed.prepareSvgForLightbox(svg);

    assert.strictEqual(clone.getAttribute('width'), '100%', '不应覆盖引擎自带的宽度');
    assert.strictEqual(clone.getAttribute('viewBox'), '0 0 800 600', '不应覆盖自带 viewBox');
    assert.ok(!/lightbox-svg-adapt/.test(clone.getAttribute('class') || ''), '不应强加自适应类');
    assert.strictEqual(clone.getAttribute('height'), null, '不应凭空补 height 属性');
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
