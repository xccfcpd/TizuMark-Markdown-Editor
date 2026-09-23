// 图表引擎适配器（Mermaid 之外的四种）：ECharts / WaveDrom / abcjs(五线谱) / Graphviz。
//
// 设计要点：
//   1. 与 processMermaid 一致的容器约定：渲染结果放进 div.mermaid-container.diagram-container，
//      并带 data-diagram-type / data-code / data-source-line / data-theme 属性——这样
//      样式（灰底框、居中、横向滚动）、点击放大灯箱、导出（长图 html2canvas、DOCX 转 PNG）
//      全部沿用既有链路，无需为新引擎单独写一遍。
//   2. 纯函数 + 惰性全局读取：模块顶层不触碰 document/window/各引擎全局，
//      因此在 node（jsdom 测试）里 require 也不会抛错；引擎未加载时 render 返回 false。
//   3. 失败可见：解析/渲染失败时写入 .diagram-error 结构（含原始源码），而不是静默空白。
//      与项目「构建产物缺失即可见」的原则一致（ADR-5）。
//
// 代码块语言标记（markdown fence info）：
//   ```echarts   → ECharts（JSON option）
//   ```wavedrom  → WaveDrom（JSON 波形/电路/寄存器图；wave 为别名）
//   ```abc       → abcjs（ABC 记谱；abcjs 为别名）
//   ```dot       → Graphviz（DOT 语言；graphviz / gv 为别名）

// 语言标记 → 引擎类型（未列出的返回 null，由调用方忽略）
const LANGUAGE_MAP = {
  echarts: 'echarts',
  wavedrom: 'wavedrom',
  wave: 'wavedrom',
  abc: 'abcjs',
  abcjs: 'abcjs',
  dot: 'graphviz',
  graphviz: 'graphviz',
  gv: 'graphviz',
  // 2026-09 新增：原生 SVG 引擎，纯函数转换器在 modules/diagram-converters.js
  tikz: 'tikz',
  pgf: 'tikz',
  tikzpicture: 'tikz',
  plot: 'plot',
  gnuplot: 'plot',
  // 2026-09 新增：Markmap 思维导图（懒加载本地 vendor）
  markmap: 'markmap',
};

const ENGINE_LABEL = {
  echarts: 'ECharts',
  wavedrom: 'WaveDrom',
  abcjs: 'abcjs',
  graphviz: 'Graphviz',
  tikz: 'TikZ',
  plot: '函数绘图',
  markmap: 'Markmap',
};

// echarts canvas 默认高度（用户可在 option 里用 tizuHeight 覆盖，见 renderEcharts）
const DEFAULT_ECHARTS_HEIGHT = 360;
// 原生 SVG 引擎的参考宽度（实际显示由容器 CSS max-width 收敛）
const DEFAULT_SVG_WIDTH = 700;
// 函数绘图的默认画布高度（宽高比接近 16:10）
const DEFAULT_PLOT_HEIGHT = 400;
// Markmap 画布高度
const DEFAULT_MARKMAP_HEIGHT = 420;

// 已实例化的 echarts（容器 → 实例），主题切换/重渲染前需 dispose，避免 "There is a chart instance already" 警告
const chartRegistry = new Map();

function diagramTypeFromLanguage(lang) {
  if (!lang) return null;
  const key = String(lang).trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(LANGUAGE_MAP, key) ? LANGUAGE_MAP[key] : null;
}

function engineLabel(type) {
  return ENGINE_LABEL[type] || type;
}

// 解析 JSON，失败抛带原文的错误（供上层展示可读提示）
function parseJSONSource(code) {
  try {
    return JSON.parse(code);
  } catch (e) {
    throw new Error('JSON 解析失败：' + (e && e.message ? e.message : String(e)));
  }
}

// ---- ECharts ----
// 约定：代码块内容为 ECharts 的 option JSON；可用顶层保留键 tizuHeight 指定画布高度（渲染前移除）。
function renderEcharts(container, code, opts) {
  if (typeof echarts === 'undefined') throw new Error('ECharts 未加载（lib/echarts.min.js）');
  const option = parseJSONSource(code);
  if (!option || typeof option !== 'object' || Array.isArray(option)) {
    throw new Error('ECharts 需要 JSON 对象形式的 option');
  }
  let height = DEFAULT_ECHARTS_HEIGHT;
  if (Number(option.tizuHeight) > 0) height = Number(option.tizuHeight);
  delete option.tizuHeight;

  // 同容器重复渲染（主题切换）先销毁旧实例
  const old = chartRegistry.get(container) || (echarts.getInstanceByDom && echarts.getInstanceByDom(container));
  if (old) {
    try { old.dispose(); } catch (_) { /* 已销毁 */ }
    chartRegistry.delete(container);
  }

  container.style.height = height + 'px';
  const chart = echarts.init(container, opts && opts.isDark ? 'dark' : null, { renderer: 'canvas' });
  chart.setOption(option, true);
  chartRegistry.set(container, chart);

  // 容器宽度随窗口变化时同步尺寸（窗口缩放、分屏比例调整）。
  // 必须在 rAF 里执行 resize：在 ResizeObserver 回调内同步改布局会触发浏览器
  // 「ResizeObserver loop completed with undelivered notifications」告警，
  // 而全局错误兜底会把它显示成红色错误条（用户会误以为程序出错）。
  if (!container._tizuResizeObserver && typeof ResizeObserver !== 'undefined') {
    let scheduled = false;
    const applyResize = () => {
      scheduled = false;
      const inst = chartRegistry.get(container);
      if (inst && !inst.isDisposed()) {
        try { inst.resize(); } catch (_) { /* 忽略瞬时错误 */ }
      }
    };
    const ro = new ResizeObserver(() => {
      if (scheduled) return; // 同一帧内多次通知只跑一次
      scheduled = true;
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(applyResize);
      else setTimeout(applyResize, 0);
    });
    ro.observe(container);
    container._tizuResizeObserver = ro;
  }
  return true;
}

// ---- WaveDrom ----
// 约定：代码块内容为 WaveDrom 的 source JSON（signal / assign / reg）；theme 走皮肤（default / dark）。
//
// 两个坑（都由本函数兜住）：
//   1) 皮肤必须存在：浏览器封装 renderWaveForm 把皮肤读死为 window.WaveSkin，缺失会抛
//      "no skins found"。这里【不写全局】（模块只应导出一个命名空间，check-globals 会硬卡），
//      而是读 window.WaveSkin（由 lib/wavedrom/skins/*.js 注入）并合并库内置 wavedrom.waveSkin，
//      再通过 renderWaveElement 的 skins 参数显式传入。
//   2) 深色皮肤未加载时回退 default，避免深色模式下一片空白。
function wavedromSkins() {
  const skins = {};
  const injected = (typeof window !== 'undefined' && window.WaveSkin) ? window.WaveSkin : null;
  if (injected) {
    for (const key of Object.keys(injected)) skins[key] = injected[key];
  }
  if (!skins.default && wavedrom.waveSkin) skins.default = wavedrom.waveSkin;
  return skins;
}

function renderWavedrom(container, code, opts) {
  if (typeof wavedrom === 'undefined') throw new Error('WaveDrom 未加载（lib/wavedrom/wavedrom.min.js）');
  const source = parseJSONSource(code);
  if (!source || typeof source !== 'object') throw new Error('WaveDrom 需要 JSON 对象形式的 source');

  const skins = wavedromSkins();
  const skinName = opts && opts.isDark ? 'dark' : 'default';
  source.config = Object.assign({}, source.config);
  if (skins[skinName]) source.config.skin = skinName;
  else delete source.config.skin;

  container.style.height = '';
  const id = 'tizu-wavedrom-' + Date.now() + '-' + Math.floor(Math.random() * 1e4);
  // renderWaveElement(id, source, element, skins)：直接把 SVG 渲染进给定元素（绕过全局皮肤依赖）
  wavedrom.renderWaveElement(id, source, container, skins);
  if (!container.querySelector('svg')) throw new Error('WaveDrom 渲染失败（检查 source 结构，如 signal/assign/reg）');
  return true;
}

// ---- abcjs（五线谱） ----
// 约定：代码块内容为 ABC 记谱原文；可选 <!-- abc-width: 600 --> 之类的宽度控制暂不支持，
// 统一 responsive: 'resize' 自适应容器宽度。
function renderAbc(container, code, opts) {
  const ABC = (typeof ABCJS !== 'undefined') ? ABCJS : null;
  if (!ABC) throw new Error('abcjs 未加载（lib/abcjs.min.js）');
  container.style.height = '';
  ABC.renderAbc(container, code, { responsive: 'resize', add_classes: true }, {});
  if (!container.querySelector('svg')) throw new Error('abcjs 渲染失败（检查 ABC 记谱语法）');
  return true;
}

// ---- Graphviz（DOT 语言） ----
// 依赖 @hpcc-js/wasm（Emscripten 版 Graphviz）：wasm 以 base64 内联在 UMD 文件里，
// 无独立 .wasm 资源；浏览器全局名带 @ 与 /：window["@hpcc-js/wasm/graphviz"]。
// 渲染是异步的（首次要实例化 wasm），且出错时库内部会 unload()，所以每次都走
// Graphviz.load()（内部缓清单例，出错后自动重建）。
const GRAPHVIZ_ENGINES = ['dot', 'neato', 'fdp', 'sfdp', 'circo', 'twopi', 'osage', 'patchwork'];

function hpccGraphvizModule() {
  if (typeof window === 'undefined') return null;
  return window['@hpcc-js/wasm/graphviz'] || null;
}

// 可选首行指令选择布局引擎（DOT 里 // 本就是注释，不写也不影响语法）：
//   // engine: neato
function extractDotEngine(code) {
  const lines = String(code).split('\n');
  const m = /^\s*(?:\/\/|#)\s*engine\s*[:=]\s*([A-Za-z0-9_]+)\s*$/.exec(lines[0] || '');
  if (!m) return { source: code, engine: 'dot' };
  const engine = m[1].toLowerCase();
  if (!GRAPHVIZ_ENGINES.includes(engine)) return { source: code, engine: 'dot' };
  return { source: lines.slice(1).join('\n'), engine };
}

async function renderGraphviz(container, code, opts) {
  const mod = hpccGraphvizModule();
  if (!mod || typeof mod.Graphviz !== 'function') throw new Error('Graphviz 未加载（lib/graphviz.min.js）');
  const { source, engine } = extractDotEngine(code);
  const gv = await mod.Graphviz.load();
  const svg = gv.layout(source, 'svg', engine);
  if (!svg) throw new Error('Graphviz 未产出 SVG（检查 DOT 语法，如 digraph { a -> b }）');
  container.style.height = '';
  container.innerHTML = svg; // 含 <?xml?> 声明与 DOCTYPE：HTML 解析器会忽略，<svg> 正常入树
  if (!container.querySelector('svg')) throw new Error('Graphviz 渲染结果异常（未生成 <svg>）');
  return true;
}

// ---- TikZ（原生 SVG，纯函数转换器位于 diagram-converters.js）----
// 子集支持：\draw / \fill / \filldraw / \node、-- 折线、-- cycle、circle (r)、
// rectangle (x,y)、路径内联 node[midway]{t}、常用颜色与线型、-> / <- / <->。
// 坐标裸数字按 cm 解析（与 TikZ 一致），支持 pt/mm/cm/in 后缀。
function getDiagramConverters() {
  if (typeof DiagramConverters !== 'undefined') return DiagramConverters;
  if (typeof require === 'function') {
    try { return require('./diagram-converters.js'); } catch (_) { return null; }
  }
  return null;
}

function renderTikz(container, code, opts) {
  const DC = getDiagramConverters();
  if (!DC || typeof DC.tikzToSvg !== 'function') {
    throw new Error('TikZ 转换器未加载（modules/diagram-converters.js）');
  }
  const svg = DC.tikzToSvg(code, { width: DEFAULT_SVG_WIDTH });
  if (!svg) {
    // 错误信息尽量指出**哪条语法**超出子集（特征由 diagram-converters 统一维护，避免两处口径漂移）；
    // 识别不到时才退回"支持清单"式的笼统说法。
    const hints = typeof DC.unsupportedHints === 'function' ? DC.unsupportedHints('tikz', code) : [];
    throw new Error('TikZ 解析失败' + (hints.length
      ? '：检测到未支持语法 ' + hints.join('、')
      : '（超出本地支持子集：\\draw / \\fill / \\node / circle / rectangle / --）'));
  }
  container.style.height = '';
  container.innerHTML = svg;
  if (!container.querySelector('svg')) throw new Error('TikZ 渲染结果异常（未生成 <svg>）');
  return true;
}

// ---- plot（gnuplot 风格函数绘图，原生 SVG）----
// 支持：set title/xlabel/ylabel/xrange/yrange/grid/samples、plot <expr>[, <expr>…]
// （可带 title "…" / with lines|points|linespoints / lc 色值）、'plot -' 后的数据行。
// 表达式解析器为自研递归下降，不使用 eval / new Function。
function renderPlot(container, code, opts) {
  const DC = getDiagramConverters();
  if (!DC || typeof DC.plotToSvg !== 'function') {
    throw new Error('函数绘图转换器未加载（modules/diagram-converters.js）');
  }
  const svg = DC.plotToSvg(code, { width: DEFAULT_SVG_WIDTH, height: DEFAULT_PLOT_HEIGHT, isDark: !!(opts && opts.isDark) });
  if (!svg) throw new Error('绘图解析失败（检查 set 指令与表达式，如 plot sin(x)）');
  container.style.height = '';
  container.innerHTML = svg;
  if (!container.querySelector('svg')) throw new Error('函数绘图渲染结果异常（未生成 <svg>）');
  return true;
}

// ---- Markmap（markdown → 交互式思维导图）----
// vendor 由 scripts/ensure-vendor.mjs 的 buildMarkmap() 打包成单文件 lib/markmap/markmap.min.js，
// 合并挂载 window.markmap（Transformer 来自 markmap-lib，Markmap 来自 markmap-view）。
// 只从应用自身目录加载（CSP script-src 'self' 本就禁止外链脚本），缺文件时抛错 → 走错误框。
const MARKMAP_VENDOR = 'lib/markmap/markmap.min.js';
let markmapVendorPromise = null;

function markmapReady() {
  return typeof window !== 'undefined' && !!window.markmap &&
    typeof window.markmap.Transformer === 'function' &&
    typeof window.markmap.Markmap === 'function';
}

function loadMarkmapVendor() {
  if (markmapReady()) return Promise.resolve(true);
  if (typeof document === 'undefined' || typeof window === 'undefined') return Promise.resolve(false);
  if (markmapVendorPromise) return markmapVendorPromise;
  markmapVendorPromise = new Promise((resolve) => {
    const el = document.createElement('script');
    el.src = MARKMAP_VENDOR;
    el.async = false;
    el.onload = () => resolve(true);
    el.onerror = () => { markmapVendorPromise = null; resolve(false); }; // 允许后续重试
    document.head.appendChild(el);
  });
  return markmapVendorPromise;
}

async function renderMarkmap(container, code, opts) {
  const source = String(code == null ? '' : code);
  if (!source.trim()) throw new Error('Markmap 内容为空（用 # / ## / 列表书写层级）');
  const loaded = await loadMarkmapVendor();
  if (!loaded || !markmapReady()) {
    throw new Error('Markmap 未加载（缺少 ' + MARKMAP_VENDOR + '，需 npm install 生成 vendor）');
  }
  container.style.height = DEFAULT_MARKMAP_HEIGHT + 'px';
  container.innerHTML = '';
  // 量取容器尺寸，作为该 SVG 的显式坐标系；量不到（隐藏 / 未布局）时退到默认参考尺寸。
  // 只用于写属性，不影响布局：容器宽高仍由 CSS（width:100% / 固定高度）决定。
  const rect = typeof container.getBoundingClientRect === 'function' ? container.getBoundingClientRect() : null;
  const boxW = Math.round((rect && rect.width) || 0) || DEFAULT_SVG_WIDTH;
  const boxH = Math.round((rect && rect.height) || 0) || DEFAULT_MARKMAP_HEIGHT;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'markmap-svg');
  // 显式写下 width/height/viewBox —— 这不是锦上添花，而是**必需**：
  // markmap-view 构造时会 `this.zoom = d3zoom()...` 并把 zoom 绑到这个 <svg> 上，
  // 而 d3-zoom 的 defaultExtent 在**没有 viewBox** 时执行
  //   return [[0, 0], [e.width.baseVal.value, e.height.baseVal.value]]
  // 只由 CSS（`.diagram-container .markmap-svg { width/height:100% }`）撑尺寸的 <svg>，
  // 其 width.baseVal 是**相对长度**，一读即抛
  //   NotSupportedError: Failed to read the 'value' property from 'SVGLength':
  //   Could not resolve relative length
  // 触发时机是**任何缩放手势**（滚轮 / 左键按下拖动 / 双击）——也就是「点一下思维导图」
  // 就会抛全局错误；且它是**异步 Uncaught**（发生在 d3 的手势处理里），
  // renderInto 的同步 try/catch 拦不住。
  // 补上 viewBox 后 d3 会走 `viewBox.baseVal` 分支（绝对值，不再碰相对长度）；
  // 再补 width/height 使该 SVG 自带确定尺寸、不再依赖作用域 CSS
  // ——与 Mermaid / TikZ / plot / Graphviz 的产出对齐（这几个本来就自带三者，故从未中招）。
  // viewBox 与渲染时的 CSS 尺寸一致 → 用户坐标系 1:1，markmap 内部按 px 算的 transform 不受影响。
  svg.setAttribute('width', String(boxW));
  svg.setAttribute('height', String(boxH));
  svg.setAttribute('viewBox', '0 0 ' + boxW + ' ' + boxH);
  container.appendChild(svg);
  const transformer = new window.markmap.Transformer();
  const result = transformer.transform(source);
  const mm = window.markmap.Markmap.create(svg, null, result.root);
  // 第二道防线（与上面的 viewBox 双保险）：**显式设定 d3-zoom 的 extent**。
  // d3-zoom 的 defaultExtent 只在「没有 viewBox」时才去读 `svg.width.baseVal.value`，
  // 而只由 CSS 撑尺寸的 SVG 其 baseVal 是相对长度 → 一读即抛 NotSupportedError。
  // extent 一旦显式给出，d3 就**完全不再走 defaultExtent** —— 即使 viewBox 因任何原因
  // 缺失（旧构建 / 第三方改写属性 / DOM 克隆）也不会再抛这个错。
  // 值取与 viewBox 一致的用户单位（1:1），故不影响 markmap 自身的缩放/平移行为。
  if (mm && mm.zoom && typeof mm.zoom.extent === 'function') {
    try { mm.zoom.extent([[0, 0], [boxW, boxH]]); } catch (_e) { /* 尽力而为，失败不影响渲染 */ }
  }
  if (!container.querySelector('svg')) throw new Error('Markmap 渲染结果异常（未生成 <svg>）');
  return true;
}

const RENDERERS = {
  echarts: renderEcharts,
  wavedrom: renderWavedrom,
  abcjs: renderAbc,
  graphviz: renderGraphviz,
  tikz: renderTikz,
  plot: renderPlot,
  markmap: renderMarkmap,
};

// 渲染失败提示：保留原始源码便于复制修改（与代码块观感一致）。
// 用 container.ownerDocument 而不是全局 document：单测（jsdom 未装全局）与多文档场景下同样可用。
function renderError(container, type, code, err) {
  if (container) container.classList.add('diagram-error');
  const doc = (container && container.ownerDocument) || (typeof document !== 'undefined' ? document : null);
  if (!doc) return; // 无文档环境（纯 node）时只做标记，不构造 UI，也不抛错
  container.innerHTML = '';
  const msg = doc.createElement('div');
  msg.className = 'diagram-error-msg';
  msg.textContent = engineLabel(type) + ' 渲染失败：' + (err && err.message ? err.message : String(err));
  const pre = doc.createElement('pre');
  const codeEl = doc.createElement('code');
  codeEl.textContent = code;
  pre.appendChild(codeEl);
  container.appendChild(msg);
  container.appendChild(pre);
}

// 对外：渲染单个容器。返回 true=成功，false=引擎缺失/渲染失败（后者会写入错误框）。
// 异步：Graphviz 需要 await 实例化 wasm；其余引擎同步返回，await 同样适用。
async function renderInto(container, type, code, opts) {
  const renderer = RENDERERS[type];
  if (!renderer) return false;
  container.classList.remove('diagram-error');
  try {
    return (await renderer(container, code, opts)) !== false;
  } catch (e) {
    if (typeof console !== 'undefined') console.warn('[diagram] ' + type + ' render failed:', e);
    renderError(container, type, code, e);
    return false;
  }
}

if (typeof window !== 'undefined' && typeof module === 'undefined') {
  window.DiagramRenderers = {
    diagramTypeFromLanguage, engineLabel, renderInto,
    renderEcharts, renderWavedrom, renderAbc, renderGraphviz,
    renderTikz, renderPlot, renderMarkmap,
    extractDotEngine, LANGUAGE_MAP, GRAPHVIZ_ENGINES, DEFAULT_ECHARTS_HEIGHT,
    DEFAULT_SVG_WIDTH, DEFAULT_PLOT_HEIGHT, DEFAULT_MARKMAP_HEIGHT,
  };
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    diagramTypeFromLanguage, engineLabel, renderInto,
    renderEcharts, renderWavedrom, renderAbc, renderGraphviz,
    renderTikz, renderPlot, renderMarkmap,
    extractDotEngine, LANGUAGE_MAP, GRAPHVIZ_ENGINES, DEFAULT_ECHARTS_HEIGHT,
    DEFAULT_SVG_WIDTH, DEFAULT_PLOT_HEIGHT, DEFAULT_MARKMAP_HEIGHT,
  };
}
