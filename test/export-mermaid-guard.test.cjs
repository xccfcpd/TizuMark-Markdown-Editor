// 图表容器与 Mermaid 的隔离 —— 回归测试
//
// 背景（真实故障，两次都由此类「类名复用」引发）：
//   我们的图表容器**刻意复用 `.mermaid-container` 类**（为复用灰底框样式 / 灯箱 / 导出链路），
//   于是任何 `querySelectorAll('.mermaid-container')` 都会把它们一起选中。
//
//   ① 导出侧：export.js 的 Word / PDF 两条路径正是这样选容器，然后把容器的 `data-code`
//      （DOT / ECharts option / WaveDrom JSON / ABC 谱面 / Markmap / TikZ / plot 源码）
//      当成 Mermaid 语法喂给 mermaid.render()：
//        - mermaid 抛异常 → 调用处 try/catch 保住原图（侥幸）；
//        - mermaid 以「错误图」返回（v11 的 run() 就是这种行为；实测过一次导出里出现
//          20 个 "Syntax error in text / mermaid version …" 炸弹，把原图整个顶掉）→ 直接丢图。
//      故守卫必须按 `data-diagram-type` 判定，只重渲染真正的 mermaid 容器。
//   ② 预览侧：`convertMermaidSources` 会把「可转 Mermaid」的代码块改写成 `language-mermaid`，
//      随后由 processMermaid 接手。若路由表被放宽（把 graphviz / echarts / wavedrom / abc /
//      markmap 也算进去），这几种原生引擎就会整体被 Mermaid 接管并全部报语法错。
//
// 本文件同时锁住 ①②，避免再次回归。
const test = require('node:test');
const assert = require('node:assert');
const { buildEnv, cleanup, waitForEditor } = require('./helpers/app-env.cjs');

const SVG_NS = 'http://www.w3.org/2000/svg';
// 这些类型在预览里由 diagram-renderers.js 的原生引擎渲染，绝不能进 Mermaid
const NATIVE_TYPES = ['graphviz', 'echarts', 'wavedrom', 'abcjs', 'markmap', 'tikz', 'plot'];

function makeContainer(w, type, legacy) {
  const el = w.document.createElement('div');
  // 与生产一致：图表容器双类名；历史 mermaid 容器只有单类名（无 data-diagram-type）
  el.className = legacy ? 'mermaid-container' : 'mermaid-container diagram-container';
  if (!legacy) el.setAttribute('data-diagram-type', type);
  el.setAttribute('data-code', 'source-of-' + type);
  const svg = w.document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 10 10');
  el.appendChild(svg);
  return el;
}

test('导出守卫：只挑真正的 mermaid 容器，原生引擎容器绝不进 mermaid 重渲染', async () => {
  const { w } = await buildEnv();
  const ed = await waitForEditor(w);
  try {
    const root = w.document.createElement('div');
    const engines = NATIVE_TYPES.map((t) => makeContainer(w, t, false));
    const realMermaid = makeContainer(w, 'mermaid', false);
    const legacyMermaid = makeContainer(w, 'mermaid', true); // 上游历史形态：无 data-diagram-type
    engines.concat([realMermaid, legacyMermaid]).forEach((el) => root.appendChild(el));

    const picked = ed._mermaidContainersForRerender(root);

    assert.strictEqual(picked.length, 2, '只应返回 2 个真 mermaid 容器，实际 ' + picked.length +
      '：' + picked.map((e) => e.getAttribute('data-diagram-type')).join(','));
    assert.ok(picked[0] === realMermaid, '第 1 个应为 data-diagram-type="mermaid" 的容器');
    assert.ok(picked[1] === legacyMermaid, '第 2 个应为历史无属性形态的 mermaid 容器');
    for (const t of NATIVE_TYPES) {
      assert.ok(!picked.some((el) => el.getAttribute('data-diagram-type') === t),
        t + ' 容器不得进入 mermaid 重渲染（否则其 data-code 会被当 Mermaid 语法而丢图）');
    }
  } finally { cleanup(w); }
});

test('路由守卫：graphviz / echarts / wavedrom / abc / markmap 不得被改写成 mermaid', async () => {
  const { w } = await buildEnv();
  await waitForEditor(w);
  try {
    const PP = w.PreviewPost;
    const preview = w.document.createElement('div');
    const nativeLangs = ['graphviz', 'dot', 'echarts', 'wavedrom', 'abc', 'abcjs', 'markmap'];
    nativeLangs.forEach((lang) => {
      const pre = w.document.createElement('pre');
      const code = w.document.createElement('code');
      code.className = 'language-' + lang;
      code.textContent = lang + '-source';
      pre.appendChild(code);
      preview.appendChild(pre);
    });
    // 对照组：真正该被转换的 plantuml
    const pPre = w.document.createElement('pre');
    const pCode = w.document.createElement('code');
    pCode.className = 'language-plantuml';
    pCode.textContent = '@startuml\nAlice -> Bob: hi\n@enduml';
    pPre.appendChild(pCode);
    preview.appendChild(pPre);

    const converted = PP.convertMermaidSources(preview);

    for (const lang of nativeLangs) {
      const code = preview.querySelector('code.language-' + lang);
      assert.ok(code, '应原样保留 ' + lang + ' 代码块');
      assert.strictEqual(code.className.indexOf('language-mermaid'), -1,
        lang + ' 不得被改写为 language-mermaid');
      assert.strictEqual(code.textContent, lang + '-source', lang + ' 源码不得被改动');
    }
    assert.strictEqual(converted, 1, '只有 plantuml 那一块应被转换');
    assert.strictEqual(preview.querySelector('code.language-plantuml').className, 'language-mermaid',
      'plantuml 仍应被改写为 mermaid（能力不能被守卫误伤）');
  } finally { cleanup(w); }
});

test('收集守卫：这些语言仍由各自原生引擎接管（collectDiagramBlocks 类型映射）', async () => {
  const { w } = await buildEnv();
  await waitForEditor(w);
  try {
    const PP = w.PreviewPost;
    const typeOf = w.DiagramRenderers.diagramTypeFromLanguage;
    const expect = {
      graphviz: 'graphviz', dot: 'graphviz', echarts: 'echarts', wavedrom: 'wavedrom',
      abc: 'abcjs', markmap: 'markmap', tikz: 'tikz', plot: 'plot',
    };
    const preview = w.document.createElement('div');
    Object.keys(expect).forEach((lang) => {
      const pre = w.document.createElement('pre');
      const code = w.document.createElement('code');
      code.className = 'language-' + lang;
      code.textContent = 'src-' + lang;
      pre.appendChild(code);
      preview.appendChild(pre);
    });

    const blocks = PP.collectDiagramBlocks(preview, typeOf);
    const got = blocks.map((b) => b.type).sort();
    const want = Object.keys(expect).map((k) => expect[k]).sort();
    assert.deepStrictEqual(got, want, '八种语言应全部被收集且类型映射正确');
    assert.ok(got.indexOf('mermaid') === -1, '这些块不得被归为 mermaid');
  } finally { cleanup(w); }
});
