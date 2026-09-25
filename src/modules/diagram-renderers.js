// 图表引擎适配器（Mermaid 之外的原生引擎）：ECharts / WaveDrom / Graphviz / TikZ / plot / Markmap。
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
//   ```dot       → Graphviz（DOT 语言；graphviz / gv 为别名）
// 注：五线谱（abcjs / ```abc）支持已于 2026-09-24 **完整移除**（含 vendor 文件与依赖声明），
//     该语言标记现在不再是图表引擎 —— 代码块按普通代码块显示，不再有引擎被误触发。

// 语言标记 → 引擎类型（未列出的返回 null，由调用方忽略）
const LANGUAGE_MAP = {
  echarts: 'echarts',
  wavedrom: 'wavedrom',
  wave: 'wavedrom',
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

// 所有渲染过图表的容器（含非 ECharts 引擎）：预览重渲染后据此回收已脱离 DOM 的那些。
// 为什么必须登记全部引擎：markmap / wavedrom 等引擎内部也会持有容器（ResizeObserver、
// 事件监听等），只 dispose ECharts 并不够。
const diagramContainers = new Set();
// Markmap 交互实例（含 d3-zoom 监听器）登记，供重渲染 / 脱离 DOM 时显式 destroy 释放（疑似泄漏）。
const markmapRegistry = new Map();

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
  // tizuHeight 夹取到合理区间：超大值会创建巨型 canvas（超出浏览器上限后表现为空白/异常），
  // 而 0/负值以前会静默回落（审计发现，2026-09-24）
  if (option.tizuHeight !== undefined && option.tizuHeight !== null && option.tizuHeight !== '') {
    const h = Number(option.tizuHeight);
    if (!isFinite(h) || h <= 0) throw new Error('ECharts 的 tizuHeight 必须是正数（单位 px），当前：' + option.tizuHeight);
    height = Math.max(120, Math.min(2000, Math.round(h)));
  }
  // 声明"仅 2D"（未打包 echarts-gl）：3D/GL 系列在缺插件时只会画出一片空白 → 提前给可读错误
  if (Array.isArray(option.series)) {
    // 判定放宽到所有 echarts-gl 专属类型（`geo3D` / `globe` / `map3D` / `surface` …）：
    // 只看 `3D$` 会漏掉它们，落到下面的"没有可绘制内容"分支，提示词还是误导的
    const bad3d = option.series.find((s) => s && typeof s.type === 'string' && /3D$|^surface$|^globe$|^map3D$/i.test(s.type));
    if (bad3d) {
      throw new Error('ECharts 仅支持 2D 图表（未打包 echarts-gl），不支持 series.type = "' + bad3d.type + '"');
    }
  }
  // 「成功但什么都没有」必须在 **init 之前**判定：否则会先创建一块空 canvas（还进了注册表），
  // 再抛错把 innerHTML 清掉 —— 短时悬挂实例（复核审计发现，2026-09-24）。
  // 白名单也要收全：timeline 多 option（顶层没有 series）、极坐标/日历/单轴都能独立成图。
  const hasContent = (Array.isArray(option.series) && option.series.length > 0) ||
    (Array.isArray(option.options) && option.options.length > 0) ||
    !!option.dataset || !!option.graphic || !!option.geo || !!option.radar ||
    !!option.parallel || !!option.tree || !!option.sankey || !!option.polar ||
    !!option.calendar || !!option.singleAxis;
  if (!hasContent) {
    throw new Error('ECharts 的 option 里没有可绘制内容（缺少 series / dataset / graphic），检查示例块是否为空');
  }
  delete option.tizuHeight;

  // 同容器重复渲染（主题切换）先销毁旧实例
  const old = chartRegistry.get(container) || (echarts.getInstanceByDom && echarts.getInstanceByDom(container));
  if (old) {
    try { old.dispose(); } catch (_) { /* 已销毁 */ }
    chartRegistry.delete(container);
  }

  container.style.height = height + 'px';
  const chart = echarts.init(container, opts && opts.isDark ? 'dark' : null, { renderer: 'canvas' });
  // 先登记再 setOption：setOption 抛错（option 结构不合法等）时实例与 canvas 已挂在 DOM 上，
  // 若尚未登记，disposeDetachedDiagrams 就回收不到它 → 反复重渲染会持续泄漏（审计发现，2026-09-24）。
  chartRegistry.set(container, chart);
  chart.setOption(option, true);

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

  // assign 的每一项**不能是裸字符串**：WaveDrom 内部会对它做下标赋值，字符串不可写，
  // 于是抛出 "Cannot assign to read only property '1' of string '写指针'" —— 用户完全看不懂。
  // 这里提前拦下，给出可操作的中文提示（JSON 本身合法，问题在结构）。
  if (Array.isArray(source.assign)) {
    const bad = source.assign.find((a) => typeof a === 'string');
    if (bad) {
      throw new Error('WaveDrom 的 assign 每一项需要数组结构（如 [["写指针", "表达式"]]），不能写裸字符串："' + bad + '"');
    }
  }

  // 「成功但空白」提前拦下：`{}` / 只有 config 的 source 渲染出来是一片空白，用户却看不到任何提示
  const hasContent = (Array.isArray(source.signal) && source.signal.length > 0) ||
    source.assign || source.reg || source.head || source.foot;
  if (!hasContent) {
    throw new Error('WaveDrom 的 source 里没有 signal / assign / reg 等内容，渲染结果会是空白');
  }

  const skins = wavedromSkins();
  const skinName = opts && opts.isDark ? 'dark' : 'default';
  source.config = Object.assign({}, source.config);
  if (skins[skinName]) source.config.skin = skinName;
  else {
    delete source.config.skin;
    // 暗色主题缺皮肤时会静默回退浅色皮肤（波形浅色线画在暗底上几乎看不见）—— 至少留个痕迹
    if (skinName === 'dark' && typeof console !== 'undefined') {
      console.warn('[diagram] WaveDrom 缺少 dark 皮肤（lib/wavedrom/skins/dark.js），已回退默认皮肤');
    }
  }

  container.style.height = '';
  const id = 'tizu-wavedrom-' + Date.now() + '-' + Math.floor(Math.random() * 1e4);
  // renderWaveElement(id, source, element, skins)：直接把 SVG 渲染进给定元素（绕过全局皮肤依赖）
  wavedrom.renderWaveElement(id, source, container, skins);
  if (!container.querySelector('svg')) throw new Error('WaveDrom 渲染失败（检查 source 结构，如 signal/assign/reg）');
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

// 给「非 ASCII 的裸节点名」自动补引号。
// 为什么必须做：DOT 词法只允许 ASCII 字母/数字/下划线（以及 latin-1）作为裸 ID，
// 于是**中文文档里最常见的写法** `来料 --> 检验` 会被 Graphviz 判为语法错误
// （实测报 "syntax error in line N near '--'"），用户完全看不懂 —— 他们并不知道
// "DOT 要求引号" 这回事。这里在交给引擎前自动补上：`"来料" --> "检验"`。
// 只在**引号外**、且 token 含非 ASCII 字符时补；已引号内容、HTML 标签 <...>、数字、
// 边操作符（-- / ->）与属性（shape=box、width=0.5）都不受影响。
function quoteDotIds(src) {
  const TOKEN = /[A-Za-z0-9_.\u00A0-\uFFFF]/;
  let htmlDepth = 0;   // DOT 的 HTML 串 `<< … >>` / `< … >` 可跨行，用尖括号配平深度跟踪
  let blockComment = false;   // 跨行 `/* … */` 注释
  let quoted = false;         // DOT 字符串可以跨行，引号状态也必须跨行（审计复核发现）
  return String(src == null ? '' : src).split('\n').map((line) => {
    // 注释原样保留：① 注释里的中文不该被"补引号"（对 Graphviz 无意义，还会让人以为图里多了引号）；
    // ② 注释里配不平的 `<` 绝不能让后续行进入 HTML 串模式。
    // 行首注释走快路径；块注释与行尾 `//` 在主循环里按字符处理 —— 旧实现在"块注释于本行闭合"
    // 时会把 `*/` 之后的**真代码**整段跳过（`/* x */ 来料 -> 检验` 的中文不再补引号；
    // 审计发现，2026-09-24）。
    if (htmlDepth === 0 && !quoted && /^\s*(\/\/|#)/.test(line)) return line;
    let out = '';
    let i = 0;
    while (i < line.length) {
      const c = line[i];
      // 跨行块注释：逐字符透传，遇到 `*/` 立即恢复（继续处理本行剩余内容）
      if (blockComment) {
        if (c === '*' && line[i + 1] === '/') { blockComment = false; out += '*/'; i += 2; continue; }
        out += c;
        i++;
        continue;
      }
      // 行尾注释：`//` 之后整段原样透传（引号内不会走到这里，上面 quoted 分支先拦下）
      if (c === '/' && line[i + 1] === '/') { out += line.slice(i); break; }
      // 仍处在跨行的 HTML 串里：整段原样透传，直到尖括号配平归零
      if (htmlDepth > 0) {
        if (c === '<') htmlDepth++;
        else if (c === '>') htmlDepth--;
        out += c;
        i++;
        continue;
      }
      if (quoted) { out += c; if (c === '\\') { out += line[i + 1] || ''; i += 2; continue; } if (c === '"') quoted = false; i++; continue; }
      if (c === '"') { quoted = true; out += c; i++; continue; }
      // 块注释起点要在**引号外**判定：`label="a /* b"` 里的 `/*` 属于字符串内容，
      // 早先用行级 indexOf 预判会把后续行整段当注释透传（审计复核发现）。
      if (c === '/' && line[i + 1] === '*') {
        const close = line.indexOf('*/', i + 2);
        if (close < 0) { blockComment = true; out += line.slice(i); break; }
        out += line.slice(i, close + 2);
        i = close + 2;
        continue;
      }
      // DOT 的 HTML 串：`<< … >>` / `< … >`，内部可含成对标签（`<B>…</B>`、`<br/>`）。
      // 不能"一遇到 > 就结束"：那样 `label=<<B>标题</B>>` 里的大写中文会被当普通 token 加引号。
      // 但**也不能见到 `<` 就进串**：注释里的孤立 `<`（`// 温度 < 阈值`）会把整篇后续行
      // 都吞成"HTML 串"，中文节点名从此不再补引号（审计复核发现）。故只在**属性值位置**
      // （`label=` / `xlabel=` 等 `=` 之后）才进串。
      if (c === '<' && /=\s*$/.test(out)) {
        let depth = 1;
        let j = i + 1;
        while (j < line.length && depth > 0) {
          if (line[j] === '<') depth++;
          else if (line[j] === '>') depth--;
          j++;
        }
        out += line.slice(i, j);
        htmlDepth = depth;    // > 0 表示该串还没结束（跨行）
        i = j;
        continue;
      }
      if (!TOKEN.test(c)) { out += c; i++; continue; }
      let j = i;
      while (j < line.length && TOKEN.test(line[j])) j++;
      const token = line.slice(i, j);
      // 含非 ASCII → 必须加引号；纯 ASCII/数字保持原样（不改变既有写法）
      out += /[^\x00-\x7F]/.test(token) ? '"' + token.replace(/"/g, '\\"') + '"' : token;
      i = j;
    }
    return out;
  }).join('\n');
}

async function renderGraphviz(container, code, opts) {
  const mod = hpccGraphvizModule();
  if (!mod || typeof mod.Graphviz !== 'function') throw new Error('Graphviz 未加载（lib/graphviz.min.js）');
  const { source, engine } = extractDotEngine(code);
  // 规模守卫：`gv.layout` 是**同步阻塞**的 wasm 调用（无超时/取消），超大 DOT 会把整篇预览卡死。
  // 这里给一个保守上限，超出即给可读错误而不是让界面假死（审计发现，2026-09-24）。
  // ⚠ 计数前先**剥掉注释**：DOT 里 `// ----------` 分隔线极常见，不剥会让边数虚高、
  // 把正常规模的图误判为"过大"（复核审计发现，2026-09-24）。
  const noComment = String(source)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^\s*(?:\/\/|#).*$/gm, ' ');
  const edgeCount = (noComment.match(/->|--/g) || []).length;
  const nodeLines = (noComment.match(/^\s*[^\s{}]+[^;{}]*;/gm) || []).length;
  if (edgeCount + nodeLines > 4000) {
    throw new Error('DOT 规模过大（约 ' + (edgeCount + nodeLines) + ' 条语句），可能长时间卡住界面；请拆分后再渲染');
  }
  const gv = await mod.Graphviz.load();
  let svg = null;
  try {
    svg = gv.layout(quoteDotIds(source), 'svg', engine);
  } catch (e) {
    // 原样保留引擎信息，并补一句可操作提示（中文名已自动加引号，仍报错多为语法问题）
    throw new Error('DOT 解析失败：' + (e && e.message ? e.message : String(e)) +
      '（提示：节点/边名含中文或空格时请写成 "名字" 形式；本例已自动为中文名补引号）');
  }
  if (!svg) throw new Error('Graphviz 未产出 SVG（检查 DOT 语法，如 digraph { a -> b }）');
  // 空图（只有 `digraph { }` 或只有属性）同样报错，而不是留一个塌陷的空白框。
  // 含 `image` / `use`：`shape=none` + `image=` 的"图片节点"只有 <image>，不能被判为空
  //（复核审计发现，2026-09-24）。
  if (!/<(path|polygon|polyline|ellipse|text|image|use)\b/.test(svg)) {
    throw new Error('Graphviz 的 DOT 里没有节点或边（图是空的），检查是否只写了 digraph { }');
  }
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
    // 超时兜底：只靠 onload / onerror 时，若两者都不触发（请求被挂起、被策略拦截、
    // 或宿主环境（如 jsdom）根本不执行外链脚本），Promise 会**永远 pending** ——
    // renderMarkmap 的 await 不返回 → 容器永远停在「图表渲染中…」，而且整段渲染阶段
    // 也永不结束（审计发现，2026-09-25）。超时后按失败处理，并允许下次重试。
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!ok) markmapVendorPromise = null;   // 失败：允许后续重试
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), 6000);
    el.onload = () => finish(true);
    el.onerror = () => finish(false);
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
  // 重渲染前释放旧 markmap 实例（d3-zoom 等内部监听器），避免交互实例只增不减（疑似泄漏，2026-09-24 审计）。
  const oldMm = markmapRegistry.get(container);
  if (oldMm) {
    try { if (typeof oldMm.destroy === 'function') oldMm.destroy(); } catch (_e) { /* 库无 destroy 时忽略 */ }
    markmapRegistry.delete(container);
  }
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
  markmapRegistry.set(container, mm);
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

// 回收「已脱离预览 DOM」的图表资源。
// 为什么需要：预览重渲染是**整块替换 innerHTML** —— 旧容器连同 canvas / 实例一起被丢弃，
// 但 chartRegistry、ResizeObserver 以及引擎内部（markmap 的
// d3-zoom 等）仍持有它们 → 长会话内存只增不减，表现为「用久了莫名卡顿、要重启才恢复」。
// 调用时机：**新内容写入 DOM 之后**（那时旧容器才真正脱离文档）。只清脱离的那些，
// 仍在 DOM 中的实例保持不动（否则每次重渲染都要重建，白卡一下）。
function disposeDetachedDiagrams(liveRoot) {
  const alive = new Set();
  if (liveRoot && typeof liveRoot.querySelectorAll === 'function') {
    const nodes = liveRoot.querySelectorAll('.diagram-container');
    for (let i = 0; i < nodes.length; i++) alive.add(nodes[i]);
  }
  const doomed = [];
  diagramContainers.forEach((container) => {
    if (!alive.has(container)) doomed.push(container);
  });
  for (let i = 0; i < doomed.length; i++) {
    const container = doomed[i];
    diagramContainers.delete(container);
    // ① ECharts 实例：dispose 释放 canvas 与内部缓存
    const chart = chartRegistry.get(container);
    if (chart) {
      try {
        if (!(typeof chart.isDisposed === 'function' && chart.isDisposed())) chart.dispose();
      } catch (_e) { /* 已销毁 */ }
      chartRegistry.delete(container);
    }
    // ②' Markmap 实例：销毁内部 d3-zoom 等交互状态，避免只增不减（疑似泄漏）
    const mmInst = markmapRegistry.get(container);
    if (mmInst) {
      try { if (typeof mmInst.destroy === 'function') mmInst.destroy(); } catch (_e) { /* 库无 destroy 时忽略 */ }
      markmapRegistry.delete(container);
    }
    // ② ResizeObserver：必须显式 disconnect，否则它会一直持有这个（已脱离的）容器
    const ro = container && container._tizuResizeObserver;
    if (ro && typeof ro.disconnect === 'function') {
      try { ro.disconnect(); } catch (_e) { /* 忽略 */ }
    }
    if (container) container._tizuResizeObserver = null;
    // ③ 清空内容：断开引擎侧对旧容器的引用链（markmap / wavedrom 的内部状态），
    //    此后旧容器不再被任何存活对象引用，可被 GC 回收。
    if (container && typeof container.innerHTML !== 'undefined') {
      try { container.innerHTML = ''; } catch (_e) { /* 忽略 */ }
    }
  }
  return doomed.length;
}

// 对外：渲染单个容器。返回 true=成功，false=引擎缺失/渲染失败。
// **两种失败都会写入错误框（说明 + 源码）** —— 用户永远不会只看到一个空框。
// 异步：Graphviz 需要 await 实例化 wasm；其余引擎同步返回，await 同样适用。
async function renderInto(container, type, code, opts) {
  const renderer = RENDERERS[type];
  if (!renderer) return false;
  container.classList.remove('diagram-error');
  try {
    // **先登记再渲染**：引擎可能在 init 之后才抛错（典型：ECharts setOption 失败），此时实例与
    // canvas 已经挂在 DOM 上，只有登记过才能被 disposeDetachedDiagrams 回收到（审计发现，2026-09-24）。
    diagramContainers.add(container);
    const ok = (await renderer(container, code, opts)) !== false;
    if (!ok) {
      diagramContainers.delete(container);   // 引擎缺失等完全失败：不必保留登记
      // 引擎"礼貌地失败"（vendor 未加载 / window.echarts 缺失 / markmap 懒包加载失败 …）原本
      // **什么都不显示**：抛异常路径有错误框，这条路径却没有 → 容器里既无图也无源码，用户只看到
      // 一个空框，还不知道发生了什么（审计发现，2026-09-25）。与抛异常路径统一成同一套 UI：
      // 错误说明 + **原始源码**，用户可以就地复制排查（"宁可看见源码，也不能把内容藏起来"）。
      // 注：这里的失败发生在创建实例之前，所以删除登记是安全的；创建实例之后才失败的引擎（如
      // ECharts setOption）会走 catch 分支，登记保留、由 disposeDetachedDiagrams 正常回收。
      if (!container.querySelector('.diagram-error-msg')) {
        renderError(container, type, code, new Error('引擎未就绪或资源未加载'));
      }
    }
    return ok;
  } catch (e) {
    if (typeof console !== 'undefined') console.warn('[diagram] ' + type + ' render failed:', e);
    renderError(container, type, code, e);
    return false;
  }
}

if (typeof window !== 'undefined' && typeof module === 'undefined') {
  window.DiagramRenderers = {
    diagramTypeFromLanguage, engineLabel, renderInto, disposeDetachedDiagrams,
    renderEcharts, renderWavedrom, renderGraphviz,
    renderTikz, renderPlot, renderMarkmap,
    extractDotEngine, quoteDotIds, LANGUAGE_MAP, GRAPHVIZ_ENGINES, DEFAULT_ECHARTS_HEIGHT,
    DEFAULT_SVG_WIDTH, DEFAULT_PLOT_HEIGHT, DEFAULT_MARKMAP_HEIGHT,
  };
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    diagramTypeFromLanguage, engineLabel, renderInto, disposeDetachedDiagrams,
    renderEcharts, renderWavedrom, renderGraphviz,
    renderTikz, renderPlot, renderMarkmap,
    extractDotEngine, quoteDotIds, LANGUAGE_MAP, GRAPHVIZ_ENGINES, DEFAULT_ECHARTS_HEIGHT,
    DEFAULT_SVG_WIDTH, DEFAULT_PLOT_HEIGHT, DEFAULT_MARKMAP_HEIGHT,
  };
}
