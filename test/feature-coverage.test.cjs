'use strict';
// 17 项声明功能的**本地可跑**覆盖核对（纯函数 + 静态接线，不依赖 jsdom/unified）。
//
// 与 test/feature-matrix.test.cjs 的分工：
//   · feature-matrix：端到端（真渲染管线，需要 jsdom + unified，只在 CI 跑）；
//   · 本文件：**本地与 CI 都能跑**的"能力 + 接线"核对，覆盖全部 17 项，任何一项被改坏都会红。
//     （历史教训：只靠 CI 才能跑的用例一旦断言写错，本地无法预检 —— 所以这一层必须存在。）
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
global.window = global.window || {};
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const DC = require('../src/modules/diagram-converters.js');
const DR = require('../src/modules/diagram-renderers.js');
const UM = require('../src/unified-math.js');
const ADM = require('../src/unified-admonitions.js');

const S = read('src/unified-renderer.js');
const PP = read('src/modules/preview-post.js');
const CB = read('src/modules/code-block.js');
const HTML = read('src/index.html');
const CSS = read('src/styles.css');
const SETTINGS = read('src/modules/settings.js');
const DR_SRC = read('src/modules/diagram-renderers.js');

test('功能覆盖 · 基础 Markdown：渲染步骤与 sanitize 白名单齐全', () => {
  const steps = ['remarkGfm', 'convertDefLists', 'convertHighlights', 'extractAbbreviations',
    'rehypeHeadingIds', 'restoreMathBlocks', 'restoreAdmonitions', 'restoreAlerts'];
  const miss = steps.filter((k) => S.indexOf(k) < 0);
  assert.deepStrictEqual(miss, [], '渲染管线缺少步骤: ' + miss.join(', '));
  // sanitize：在 GitHub 基础白名单上追加，基础白名单本身提供 details/summary/dl/dd/table/input
  const added = ["'mark'", "'u'", "'figure'", '...(base.tagNames'];
  const miss2 = added.filter((k) => S.indexOf(k) < 0);
  assert.deepStrictEqual(miss2, [], 'sanitize 白名单缺少: ' + miss2.join(', '));
});

test('功能覆盖 · 代码高亮：语言类名 / 缓存上限 / 无库分支 / 行号开关', () => {
  assert.match(CB, /A-Za-z0-9_\+#\.\\-/, '语言名解析要支持 c++ / c# / objective-c++ 这类字符');
  assert.match(CB, /CODE_CACHE_MAX_ENTRIES/, '高亮缓存必须有上限');
  assert.match(CB, /capCache\(cache\)/, '写入缓存后必须调用 capCache');
  assert.match(CB, /buildCodeScrollNoHljs/, '必须有"无 hljs"分支（不能因缺库就报错）');
  assert.match(PP, /skipTags = \['CODE', 'PRE'\]/, '受保护块跳过清单必须存在');
  assert.match(SETTINGS, /code-line-numbers/, '行号开关应接到 preview 类名上');
});

test('功能覆盖 · 数学 / 物理 / 化学公式：保护·渲染·缺库降级', () => {
  assert.match(S, /function guardMathBlocks/, '必须有 $…$ / $$…$$ 保护');
  assert.match(S, /restoreMathBlocks/, '必须有占位符还原');
  assert.match(PP, /function processMath/, '必须有 KaTeX 渲染阶段');
  assert.match(PP, /typeof renderMathInElement === 'undefined'/, '缺 KaTeX 时须安全早退');
});

test('功能覆盖 · mhchem：\\ce / \\pu 原样透传 + 扩展已引入', () => {
  assert.strictEqual(UM.expandSiunitx('\\ce{2H2 + O2 -> 2H2O}'), '\\ce{2H2 + O2 -> 2H2O}', '\\ce 不得被改写');
  assert.strictEqual(UM.expandSiunitx('\\pu{123 kJ//mol}'), '\\pu{123 kJ//mol}', '\\pu 不得被改写');
  assert.ok(HTML.indexOf('mhchem') >= 0, 'index.html 应引入 mhchem 扩展');
});

test('功能覆盖 · 物理单位 / siunitx：v2 与 v3 命令名全覆盖', () => {
  const cases = [
    ['\\si{kg m}', 'kg\\,m'],
    ['\\SI{1.2}{m}', '1.2\\,\\mathrm{m}'],
    ['\\unit{m}', '\\mathrm{m}'],
    ['\\qty{1.2}{m}', '1.2\\,\\mathrm{m}'],
    ['\\num{1e3}', '1\\times 10^{3}'],
    ['\\ang{30}', '30^{\\circ}'],
    ['\\SIrange{1}{5}{m}', '1\\text{--}5\\,\\mathrm{m}'],
    ['\\qtyrange{1}{5}{m}', '1\\text{--}5\\,\\mathrm{m}'],
  ];
  cases.forEach(([src, expect]) => {
    assert.ok(UM.expandSiunitx('$' + src + '$').indexOf(expect) >= 0, src + ' 应展开为含 ' + expect);
  });
  // 分隔符语义
  assert.strictEqual(UM.expandSiUnit('kg m'), 'kg\\,m');
  assert.strictEqual(UM.expandSiUnit('N.m'), 'N\\,m');
  assert.strictEqual(UM.expandSiUnit('kJ//mol'), 'kJ/mol');
  assert.strictEqual(UM.expandSiUnit('m/s'), 'm/s');
  // preamble 命令丢弃（否则 KaTeX 报错）
  assert.strictEqual(UM.expandSiunitx('$\\sisetup{detect-all}$').replace(/\$/g, '').trim(), '');
});

test('功能覆盖 · 公式自动编号：连续编号 / 前向 \\eqref / 重复 label / aligned', () => {
  const ph = (t, i) => ({ text: t, display: true, line: i });
  const list = [ph('$$\\eqref{eq:z}$$', 1), ph('$$y\\label{eq:y}$$', 2), ph('$$z\\label{eq:z}$$', 3)];
  const labels = UM.assignEquationNumbers(list, {});
  assert.strictEqual(list[1].eqNumber, 1);
  assert.strictEqual(list[2].eqNumber, 2);
  const ref = UM.expandEqref(list[0].text, labels);
  assert.ok(/eq-2/.test(ref) && !/\\eqref/.test(ref), '\\eqref 应解析成 eq-N 引用，实际 ' + ref);

  const dup = [ph('$$a\\label{eq:x}$$', 1), ph('$$b\\label{eq:x}$$', 2)];
  const l2 = UM.assignEquationNumbers(dup, {});
  assert.strictEqual(l2.get('eq:x'), 1, '重复 label 应首个胜出');

  const aligned = [ph('$$\\begin{aligned}a&=b\\end{aligned}\\label{eq:al}$$', 1)];
  UM.assignEquationNumbers(aligned, {});
  assert.ok(aligned[0].eqNumber, 'aligned 内的 label 也应编号');

  assert.match(SETTINGS, /equationSectionNumbering/, '章节编号设置应存在');
  assert.match(read('src/controllers/preview-controller.js'), /equationNumbering/, '设置应接到渲染选项');
});

test('功能覆盖 · Mermaid：路由 / 容器属性 / 缓存上限 / 缺库降级', () => {
  const a = DC.classify('plantuml', '@startuml\nA -> B : x\n@enduml');
  const b = DC.classify('d2', 'a -> b');
  assert.strictEqual(a && a.kind, 'mermaid', 'PlantUML 应转成 Mermaid');
  assert.strictEqual(b && b.kind, 'mermaid', 'D2 应转成 Mermaid');
  assert.ok(PP.indexOf("'mermaid-container diagram-container'") >= 0, '容器应带双类名');
  assert.ok(PP.indexOf('data-diagram-type') >= 0 && PP.indexOf('data-theme') >= 0, '容器应带类型与主题属性');
  assert.match(PP, /CACHE_MAX_ENTRIES/, '图表缓存必须有上限');
  assert.match(PP, /typeof mermaid === 'undefined'/, '缺 mermaid 时必须安全早退（保持源码可见）');
});

test('功能覆盖 · PlantUML：路由 / 控制块 / create / note / 不支持提示', () => {
  const routes = [
    ['@startuml\nA -> B : x\n@enduml', 'sequenceDiagram'],
    ['@startuml\n[*] --> A\n@enduml', 'stateDiagram-v2'],
    ['@startuml\nclass A\nA --> B\n@enduml', 'classDiagram'],
    ['@startuml\nstart\n:x;\nstop\n@enduml', 'flowchart TD'],
  ];
  routes.forEach(([src, expect]) => {
    assert.strictEqual(String(DC.plantumlToMermaid(src)).split('\n')[0], expect, src.split('\n')[1] + ' 路由不符');
  });
  // par 的分支分隔符必须是 and（否则 Mermaid 语法报错）
  const par = DC.plantumlToMermaid('@startuml\npar\nA -> B : x\nelse\nA -> C : y\nend\n@enduml');
  assert.match(par, /^\s*and\s*$/m, 'par 的分支应写成 and');
  assert.ok(!/^\s*else\s*$/m.test(par), 'par 块里不得出现裸 else');
  const alt = DC.plantumlToMermaid('@startuml\nalt a\nA -> B : x\nelse b\nA -> B : y\nend\n@enduml');
  assert.match(alt, /else b/, 'alt 仍应使用 else');
  // create / destroy
  assert.match(DC.plantumlToMermaid('@startuml\ncreate C\nA -> C : x\n@enduml'), /create participant C/);
  // note 四种写法
  const notes = DC.plantumlToMermaid('@startuml\nA -> B : hi\nnote over A,B : 说明\nnote left of A : 左\nnote right of B : 右\n@enduml');
  assert.match(notes, /Note over A,B: 说明/);
  assert.match(notes, /Note left of A: 左/);
  assert.match(notes, /Note right of B: 右/);
  // 不支持语法必须给提示（而不是静默画错）
  assert.ok(DC.unsupportedHints('plantuml', '@startuml\nfork\nA -> B : x\n@enduml').length > 0, 'fork 应给出提示');
});

test('功能覆盖 · Graphviz：中文自动补引号 + 注释/HTML 串安全 + 别名', () => {
  const withComment = DR.quoteDotIds('digraph {\n// 温度 < 阈值\n来料 -> 检验\n}');
  assert.match(withComment, /"来料" -> "检验"/, '中文节点名应补引号');
  const html = DR.quoteDotIds('digraph { a [label=<<B>标题</B>>] }');
  assert.match(html, /label=<<B>标题<\/B>>/, 'DOT 的 HTML 串不得被加引号');
  ['dot', 'graphviz', 'gv'].forEach((l) => assert.strictEqual(DR.diagramTypeFromLanguage(l), 'graphviz', l + ' 应映射到 graphviz'));
});

test('功能覆盖 · ECharts 2D：映射 / tizuHeight / JSON 校验', () => {
  assert.strictEqual(DR.diagramTypeFromLanguage('echarts'), 'echarts');
  assert.match(DR_SRC, /tizuHeight/, '应支持 tizuHeight 指定高度');
  assert.match(DR_SRC, /parseJSONSource/, '应做 JSON 校验（错误要给可读原因）');
});

test('功能覆盖 · WaveDrom：映射 / 皮肤 / 缺库报错', () => {
  assert.strictEqual(DR.diagramTypeFromLanguage('wavedrom'), 'wavedrom');
  assert.strictEqual(DR.diagramTypeFromLanguage('wave'), 'wavedrom', 'wave 是别名');
  assert.match(DR_SRC, /WaveDrom 未加载/, '缺库要给明确原因');
  assert.match(DR_SRC, /skin/i, '应加载皮肤');
});

test('功能覆盖 · TikZ：子集可画 + 不支持语法明确拒绝', () => {
  assert.ok(DC.tikzToSvg('\\draw (0,0) -- (1,1);', { width: 700 }), '普通折线应能画');
  assert.strictEqual(DC.tikzToSvg('\\draw (0,0) arc (0:90:1);', { width: 700 }), null, 'arc 应拒绝');
  assert.strictEqual(DC.tikzToSvg('\\draw (0,0) grid (2,2);', { width: 700 }), null, 'grid 应拒绝');
  assert.strictEqual(DC.tikzToSvg('\\path[draw] (0,0) -- (1,1);', { width: 700 }), null, '\\path 应拒绝');
});

test('功能覆盖 · plot：函数绘图 + 非函数式拒绝 + set 配置', () => {
  assert.ok(DC.plotToSvg('plot sin(x)', { width: 700 }), 'plot sin(x) 应能画');
  assert.strictEqual(DC.plotToSvg('plot a*x', { width: 700 }), null, '含未定义参数应拒绝');
  assert.ok(DC.plotToSvg('set xlabel "x"\nplot x**2', { width: 700 }), 'set 配置 + 幂运算应能画');
});

test('功能覆盖 · Markmap：映射 / 懒加载 / 加载超时兜底', () => {
  assert.strictEqual(DR.diagramTypeFromLanguage('markmap'), 'markmap');
  assert.match(DR_SRC, /MARKMAP_VENDOR/, '应懒加载本地 vendor');
  assert.match(DR_SRC, /setTimeout\(\(\) => finish\(false\), 6000\)/, 'vendor 加载必须有超时兜底（否则永远"渲染中…"）');
});

test('功能覆盖 · Unicode 符号：短码表规模 / 无空值 / demo 全覆盖 / 跳过代码块', () => {
  const s = PP.indexOf('const EMOJI_MAP');
  let i = PP.indexOf('{', s), depth = 0, end = -1;
  for (; i < PP.length; i++) { if (PP[i] === '{') depth++; else if (PP[i] === '}') { depth--; if (depth === 0) { end = i; break; } } }
  const body = PP.slice(s, end + 1);
  const pairs = body.match(/['"]?[A-Za-z0-9_+-]{2,40}['"]?\s*:\s*'[^']*'/g) || [];
  assert.ok(pairs.length > 80, '短码表规模异常: ' + pairs.length);
  assert.strictEqual((body.match(/:\s*''/g) || []).length, 0, '不应有空值');
  const demo = read('demo.md');
  const used = [...new Set(demo.match(/:[a-z0-9_+-]{2,40}:/g) || [])].filter((x) => !/^:-+:$/.test(x));
  const miss = used.filter((u) => body.indexOf(u) < 0);
  assert.deepStrictEqual(miss, [], 'demo 用到但表里没有: ' + miss.join(' '));
  assert.match(PP, /skipTags = \['CODE', 'PRE'\]/, '替换必须跳过 code/pre');
});

test('功能覆盖 · Admonition：四种写法解析 + 13 类样式 + 可折叠', () => {
  const container = ADM.convertAdmonitions('::: tip 提示\n正文\n:::');
  const bang = ADM.convertAdmonitions('!!! warning "警告"\n    正文');
  const foldable = ADM.convertAdmonitions('??? note "折叠"\n    正文');
  assert.strictEqual(container.blocks.length, 1, '::: 应产出提示块');
  assert.strictEqual(bang.blocks.length, 1, '!!! 应产出提示块（正文需缩进）');
  assert.strictEqual(foldable.blocks.length, 1, '??? 应产出折叠块（标题需引号）');
  assert.ok(foldable.blocks[0].collapsible, '??? 应为可折叠');
  assert.match(S, /convertAlerts/, 'GitHub 风格 > [!TYPE] 应另有接线');
  const types = ['note', 'tip', 'warning', 'danger', 'info', 'important', 'success', 'question', 'failure', 'bug', 'example', 'quote', 'abstract'];
  const miss = types.filter((t) => CSS.indexOf('.alert-' + t) < 0);
  assert.deepStrictEqual(miss, [], '缺样式的类型: ' + miss.join(', '));
  assert.match(read('src/unified-admonitions.js'), /data-admonition/, '折叠块应带 data-admonition');
});
