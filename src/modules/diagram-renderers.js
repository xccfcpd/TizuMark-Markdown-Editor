// 图表引擎适配器（Mermaid 之外的三种）：ECharts / WaveDrom / abcjs(五线谱)。
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

// 语言标记 → 引擎类型（未列出的返回 null，由调用方忽略）
const LANGUAGE_MAP = {
  echarts: 'echarts',
  wavedrom: 'wavedrom',
  wave: 'wavedrom',
  abc: 'abcjs',
  abcjs: 'abcjs',
};

const ENGINE_LABEL = {
  echarts: 'ECharts',
  wavedrom: 'WaveDrom',
  abcjs: 'abcjs',
};

// echarts canvas 默认高度（用户可在 option 里用 tizuHeight 覆盖，见 renderEcharts）
const DEFAULT_ECHARTS_HEIGHT = 360;

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

  // 容器宽度随窗口变化时同步尺寸（窗口缩放、分屏比例调整）
  if (!container._tizuResizeObserver && typeof ResizeObserver !== 'undefined') {
    const ro = new ResizeObserver(() => {
      const inst = chartRegistry.get(container);
      if (inst && !inst.isDisposed()) {
        try { inst.resize(); } catch (_) { /* 忽略瞬时错误 */ }
      }
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

const RENDERERS = {
  echarts: renderEcharts,
  wavedrom: renderWavedrom,
  abcjs: renderAbc,
};

// 渲染失败提示：保留原始源码便于复制修改（与代码块观感一致）
function renderError(container, type, code, err) {
  container.classList.add('diagram-error');
  container.innerHTML = '';
  const msg = document.createElement('div');
  msg.className = 'diagram-error-msg';
  msg.textContent = engineLabel(type) + ' 渲染失败：' + (err && err.message ? err.message : String(err));
  const pre = document.createElement('pre');
  const codeEl = document.createElement('code');
  codeEl.textContent = code;
  pre.appendChild(codeEl);
  container.appendChild(msg);
  container.appendChild(pre);
}

// 对外：渲染单个容器。返回 true=成功，false=引擎缺失（不产生错误框，交由调用方决定）
function renderInto(container, type, code, opts) {
  const renderer = RENDERERS[type];
  if (!renderer) return false;
  container.classList.remove('diagram-error');
  try {
    return renderer(container, code, opts) !== false;
  } catch (e) {
    if (typeof console !== 'undefined') console.warn('[diagram] ' + type + ' render failed:', e);
    renderError(container, type, code, e);
    return false;
  }
}

if (typeof window !== 'undefined' && typeof module === 'undefined') {
  window.DiagramRenderers = {
    diagramTypeFromLanguage, engineLabel, renderInto,
    renderEcharts, renderWavedrom, renderAbc,
    LANGUAGE_MAP, DEFAULT_ECHARTS_HEIGHT,
  };
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    diagramTypeFromLanguage, engineLabel, renderInto,
    renderEcharts, renderWavedrom, renderAbc,
    LANGUAGE_MAP, DEFAULT_ECHARTS_HEIGHT,
  };
}
