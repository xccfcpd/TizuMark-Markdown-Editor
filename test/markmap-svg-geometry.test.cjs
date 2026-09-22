// Markmap 的 <svg> 必须自带 width/height/viewBox —— 回归测试
//
// 症状：点一下思维导图（滚轮/左键按下拖动/双击任一缩放手势）就弹全局错误条：
//   Uncaught NotSupportedError: Failed to read the 'value' property from 'SVGLength':
//   Could not resolve relative length   （lib/markmap/markmap.min.js）
//
// 根因（已核对上游源码，非猜测）：
//   markmap-view@0.18.12 构造函数里 `this.zoom = (<d3-zoom>)().filter(...)`，把 zoom 绑到该
//   <svg>；d3-zoom@3.0.0 的 defaultExtent 在**没有 viewBox** 时执行
//     return [[0, 0], [e.width.baseVal.value, e.height.baseVal.value]]
//   而「尺寸完全由 CSS（`.diagram-container .markmap-svg { width/height:100% }`）撑开」的
//   <svg>，其 width.baseVal 是**相对长度**，读 .value 即抛（could not resolve relative length）。
//   该异常在 d3 的手势处理里抛出，属**异步 Uncaught**，renderInto 的同步 try/catch 拦不住。
//   Mermaid / TikZ / plot / Graphviz 生成时即写 width + viewBox，故只有 Markmap 中招。
//
// 修法：renderMarkmap 里写死 width/height/viewBox（量不到容器尺寸时退到默认参考尺寸）。
const test = require('node:test');
const assert = require('node:assert');
const { buildEnv, cleanup, waitForEditor } = require('./helpers/app-env.cjs');

const RECT = (width, height) => ({ width, height, top: 0, left: 0, right: width, bottom: height, x: 0, y: 0 });

// 极简 vendor 桩：只需满足 markmapReady()（Transformer / Markmap 皆为函数）即可。
// 几何断言与 markmap 内部实现无关，故不引入真实 vendor（本机无 npm，也无法生成）。
function stubVendor(w) {
  function Transformer() {
    this.transform = () => ({ root: { content: 'root', children: [] } });
  }
  function Markmap() {}
  Markmap.create = () => ({});
  w.markmap = { Transformer, Markmap };
}

async function render(opts) {
  const o = opts || {};
  const { w } = await buildEnv();
  await waitForEditor(w);
  assert.ok(w.DiagramRenderers, 'DiagramRenderers 应已由 harness 加载（src/modules/diagram-renderers.js）');
  stubVendor(w);
  const container = w.document.createElement('div');
  container.className = 'mermaid-container diagram-container';
  container.setAttribute('data-diagram-type', 'markmap');
  if (o.rect) container.getBoundingClientRect = () => RECT(o.rect[0], o.rect[1]);
  w.document.body.appendChild(container);
  const ok = await w.DiagramRenderers.renderMarkmap(container, o.code || '# 根节点\n## 子节点');
  return { w, container, ok };
}

test('markmap svg 自带绝对尺寸与 viewBox（d3-zoom 不会再读相对长度）', async () => {
  const { w, container, ok } = await render({ rect: [900, 420] });
  try {
    assert.strictEqual(ok, true, '渲染应返回成功');
    const svg = container.querySelector('svg.markmap-svg');
    assert.ok(svg, '应生成 svg.markmap-svg');
    assert.strictEqual(svg.getAttribute('width'), '900', 'width 应为容器实测宽度');
    assert.strictEqual(svg.getAttribute('height'), '420', 'height 应为容器实测高度');
    assert.strictEqual(svg.getAttribute('viewBox'), '0 0 900 420', 'viewBox 应与实测尺寸一致（坐标系 1:1）');
    // 核心断言：相对长度正是 d3-zoom defaultExtent 抛 NotSupportedError 的前提
    assert.ok(!/%/.test(svg.getAttribute('width') || ''), 'width 绝不能是百分比');
    assert.ok(!/%/.test(svg.getAttribute('height') || ''), 'height 绝不能是百分比');
    // 有 viewBox，d3 才会走 viewBox.baseVal 分支（绝对值），彻底绕开相对长度
    assert.ok(svg.hasAttribute('viewBox'), '必须有 viewBox');
  } finally { cleanup(w); }
});

test('markmap svg 量不到尺寸（隐藏/未布局）时退到默认参考尺寸，仍为绝对长度', async () => {
  const { w, container } = await render();
  try {
    const svg = container.querySelector('svg.markmap-svg');
    assert.ok(svg, '应生成 svg.markmap-svg');
    assert.strictEqual(svg.getAttribute('width'), '700', '应退到 DEFAULT_SVG_WIDTH');
    assert.strictEqual(svg.getAttribute('height'), '420', '应退到 DEFAULT_MARKMAP_HEIGHT');
    assert.strictEqual(svg.getAttribute('viewBox'), '0 0 700 420', 'viewBox 应与兜底尺寸一致');
    assert.ok(!/%/.test(svg.getAttribute('width') || ''), '兜底值同样必须是绝对长度');
  } finally { cleanup(w); }
});
