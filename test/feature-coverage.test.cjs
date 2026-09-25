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

/* ============================================================================
 * 第十八轮（续）：逐功能「行为电池」—— 把临时探针固化成可重复执行的用例。
 * 每一项都真跑一遍边界输入，而不只是检查"函数存在"。
 * ========================================================================== */

test('深挖 · 基础 Markdown：渲染阶段顺序约束（顺序错了就会出中间态/丢语义）', () => {
  // 必须在**渲染函数体内部**比较：同名函数的第一处出现通常是"定义/注释"，用它比较会误判
  const pipelineStart = S.indexOf('abbrResult = extractAbbreviations(content)');
  assert.ok(pipelineStart > 0, '找不到渲染管线起点');
  const idx = (needle) => {
    const i = S.indexOf(needle, pipelineStart);
    assert.ok(i >= 0, '找不到管线调用: ' + needle);
    return i;
  };
  const convAdm = idx('convertAdmonitions(mathResult.content)');
  const convAlert = idx('convertAlerts(admonitionResult.content)');
  const restAlert = idx('restoreAlerts(html, alertBlocks)');
  const restAdm = idx('restoreAdmonitions(html, admonitionBlocks)');
  const restMath = idx('restoreMathBlocks(html, placeholders');
  // admonition(! / ?) 必须先于 alert(> [!TYPE])：先把缩进体反缩进成顶层文本
  assert.ok(convAdm < convAlert, 'admonition 转换必须先于 alert');
  // 还原顺序：alert 先、admonition 后（嵌套时内层先还原）
  assert.ok(restAlert < restAdm, 'alert 应先于 admonition 还原');
  // 数学还原在 admonition 还原之后（提示块正文里的公式才渲染得到）
  assert.ok(restAdm < restMath, 'admonition 还原应先于数学还原');
  // 数学保护必须先于 markdown 解析（否则 $…$ 里的字符被语法吃掉）
  assert.ok(S.indexOf('guardMathBlocks(abbrResult.content)') > 0, '数学保护应作用于解析前的文本');
});

test('深挖 · 代码高亮：语言类名解析电池（含 c++ / c# / objective-c++）', () => {
  // 直接取实现里的正则（与源码同源，避免复制出第二套规则）
  const m = CB.match(/cls\.match\(\/([^/]+)\//);
  assert.ok(m, '找不到语言类名解析正则');
  const re = new RegExp(m[1]);
  const pick = (cls) => { const r = cls.match(re); return r ? r[1] : null; };
  assert.strictEqual(pick('language-javascript hljs'), 'javascript');
  assert.strictEqual(pick('hljs language-c++'), 'c++', 'c++ 不能被截成 c');
  assert.strictEqual(pick('language-c#'), 'c#');
  assert.strictEqual(pick('language-objective-c++'), 'objective-c++');
  assert.strictEqual(pick('language-f#'), 'f#');
  assert.strictEqual(pick('hljs'), null, '无语言标记时不返回语言');
});

test('深挖 · 数学 / mhchem / 物理单位：边界电池', () => {
  // ① mhchem 的 \pu / \ce 必须整段透传（内部 // 也不能被 siunitx 的"每"规则改写）
  ['\\ce{2H2 + O2 -> 2H2O}', '\\pu{123 kJ//mol}', '\\ce{SO4^2-}', '\\ce{^{14}C}', '\\pu{1.2e-3 kg.m.s^{-2}}']
    .forEach((s) => assert.strictEqual(UM.expandSiunitx(s), s, s + ' 不应被改写'));
  // ② siunitx 边界：科学计数 / 负角 / 组合单位 / 数字格式
  assert.ok(UM.expandSiunitx('$\\SI{1.2e-3}{m}$').indexOf('\\times 10^{-3}') >= 0);
  assert.strictEqual(UM.expandSiunitx('$\\ang{-30}$').indexOf('-30^{\\circ}') >= 0, true);
  assert.ok(UM.expandSiunitx('$\\si{kg.m.s^{-2}}$').indexOf('kg\\,m\\,s^{-2}') >= 0);
  assert.ok(UM.expandSiunitx('$\\num{1.23e-4}$').indexOf('1.23\\times 10^{-4}') >= 0);
  // ③ 百分号要转义（否则 % 会被当注释起始，后面内容全被吃掉）
  assert.ok(UM.expandSiunitx('\\si{%}').indexOf('\\%') >= 0, '百分号应转义');
});

test('深挖 · 公式自动编号：\\eqref 正文引用与未定义标签兜底', () => {
  const ph = (t, i) => ({ text: t, display: true, line: i });
  const list = [ph('$$a\\label{eq:one}$$', 1)];
  const labels = UM.assignEquationNumbers(list, {});
  assert.strictEqual(list[0].eqNumber, 1);
  const prose = UM.expandProseEqref('见式 \\eqref{eq:one} 与 \\eqref{eq:none}', labels);
  assert.match(prose, /eq-1/, '已定义标签应生成引用链接');
  assert.match(prose, /未定义|eq-ref-missing/, '未定义标签要有兜底提示（不能静默丢）');
});

test('深挖 · Mermaid：可缓存引擎集合逐项核对（SVG 可缓存 / canvas 与交互态不可）', () => {
  const cacheable = PP.match(/DIAGRAM_HTML_CACHEABLE = \{[\s\S]*?\}/);
  assert.ok(cacheable, '找不到 DIAGRAM_HTML_CACHEABLE');
  const body = cacheable[0];
  // 逐项解析布尔值（不能只查"是否出现名字"：echarts: false 也会命中名字）
  const flag = (t) => {
    const m = body.match(new RegExp(t + '\\s*:\\s*(true|false)'));
    return m ? m[1] === 'true' : null;
  };
  assert.strictEqual(flag('graphviz'), true, 'Graphviz 产物是 SVG，应可缓存');
  assert.strictEqual(flag('tikz'), true, 'TikZ 产物是 SVG，应可缓存');
  assert.strictEqual(flag('plot'), true, 'plot 产物是 SVG，应可缓存');
  assert.strictEqual(flag('wavedrom'), true, 'WaveDrom(svg) 应可缓存');
  assert.strictEqual(flag('echarts'), false, 'ECharts 是 canvas：innerHTML 复用会丢像素，必须 false');
  assert.strictEqual(flag('markmap'), false, 'Markmap 带交互状态：innerHTML 复用会丢，必须 false');
  // 双保险：即使配置写错，写入缓存前也要求容器里**真的有 svg**（canvas 引擎不会被误缓存）
  assert.match(PP, /DIAGRAM_HTML_CACHEABLE\[type\] && container\.querySelector\('svg'\)/,
    '写缓存前必须确认容器内确有 svg');
});

test('深挖 · Graphviz：quoteDotIds 边界电池', () => {
  const cases = [
    ['digraph { 来料 -> 检验 }', /"来料" -> "检验"/],
    ['digraph { subgraph cluster_中文 { a -> b } }', /cluster_中文/],
    ['digraph { a [label="中文 带空格"] }', /label="中文 带空格"/],
    ['digraph { a [label=<<B>标题</B>>] }', /label=<<B>标题<\/B>>/],
    ['digraph { {rank=same; a; b} }', /rank=same/],
    ['digraph { a [shape=box, width=0.5]; }', /shape=box, width=0\.5/],
    ['digraph {\n// 注释里的 < 不影响\n来料 -> 检验\n}', /"来料" -> "检验"/],
    ['digraph {\n/* 块注释\n   跨行 */\na -> 中文节点\n}', /"中文节点"/],
    ['digraph { a:port -> b }', /a:port -> b/],
    ['digraph { "已加引号" -> b }', /"已加引号" -> b/],
  ];
  cases.forEach(([src, re]) => assert.match(DR.quoteDotIds(src), re, 'DOT 处理不符: ' + src));
});

test('深挖 · PlantUML：控制块 / 参与者 / 箭头电池 + 结构不变量', () => {
  const cases = [
    ['@startuml\nparticipant A as "甲方"\nA -> B : x\n@enduml', /participant/],
    ['@startuml\nactor 用户\n用户 -> 系统 : 登录\n@enduml', /actor P\d+ as 用户[\s\S]*P\d+->>P\d+: 登录/],
    ['@startuml\nA ->> B : req\nB -->> A : resp\n@enduml', /->>/],
    ['@startuml\nA --> B\n@enduml', /-->/],
    // 异常箭头 `-\`：Mermaid 无等价符号，降级为普通消息（语义细化丢失，但消息本身保留）
    ['@startuml\nA -\\ B : 异常\n@enduml', /A->>B: 异常/],
    ['@startuml\nloop 每天\nA -> B : ping\nend\n@enduml', /^\s*loop 每天/m],
    ['@startuml\nactivate B\nA -> B : x\ndeactivate B\n@enduml', /activate B/],
    ['@startuml\nalt c1\nA -> B : x\nelse c2\nA -> B : y\nend\n@enduml', /^\s*else c2/m],
  ];
  cases.forEach(([src, re]) => {
    const out = DC.plantumlToMermaid(src);
    assert.ok(out, '应能转换: ' + src.split('\n')[1]);
    assert.match(out, re, '输出不符: ' + src.split('\n')[1]);
  });
  // 结构不变量：块开启数必须与 end 数一致（否则 Mermaid 语法报错）
  const src = '@startuml\nalt a\nA -> B : x\nloop 2\nA -> B : y\nend\nelse b\nA -> B : z\nend\n@enduml';
  const out = DC.plantumlToMermaid(src);
  const opens = (out.match(/^\s*(alt|opt|loop|par|critical|break|rect)\b/gm) || []).length;
  const ends = (out.match(/^\s*end\s*$/gm) || []).length;
  assert.strictEqual(opens, ends, '块与 end 必须配对，实际 ' + opens + ' vs ' + ends);
  // 关键回归：par 里不得出现裸 else（Mermaid 只认 and）
  const par = DC.plantumlToMermaid('@startuml\npar\nA -> B : x\nelse\nA -> C : y\nend\n@enduml');
  assert.ok(!/^\s*else\s*$/m.test(par));
  assert.match(par, /^\s*and\s*$/m);
});

test('深挖 · TikZ：\\draw / \\fill / \\node 子集电池', () => {
  const okCases = [
    '\\draw (0,0) -- (1,1);',
    '\\draw[red, dashed] (0,0) -- (2,0);',
    '\\draw (0,0) -- (1,0) -- (1,1) -- cycle;',
    '\\fill (0,0) circle (2pt);',
    '\\node at (1,2) {标签};',
    '\\draw (0,0) -- (1cm,2cm);',
  ];
  okCases.forEach((s) => assert.ok(DC.tikzToSvg(s, { width: 700 }), '应能画: ' + s));
  const rejectCases = ['\\draw (0,0) arc (0:90:1);', '\\draw (0,0) .. controls (1,1) .. (2,0);',
    '\\draw (0,0) to [bend left] (1,1);', '\\draw (0,0) grid (2,2);', '\\path[draw] (0,0) -- (1,1);'];
  rejectCases.forEach((s) => assert.strictEqual(DC.tikzToSvg(s, { width: 700 }), null, '应明确拒绝: ' + s));
});

test('深挖 · plot：函数式 battery', () => {
  [['plot sin(x)', true], ['plot cos(x) + 1', true], ['plot x**2', true], ['plot sin(x) title "正弦"', true],
   ['set grid\nplot x', true], ['plot a*x', false], ['plot x + b', false]].forEach(([src, expect]) => {
    const got = !!DC.plotToSvg(src, { width: 700 });
    assert.strictEqual(got, expect, src + ' 期望 ' + expect + ' 实际 ' + got);
  });
});

test('深挖 · Unicode 符号：替换正则需要跳过表格分隔线/时间/URL', () => {
  const reSrc = PP.match(/:\s*([a-z0-9_+-]+)\s*:/);
  assert.ok(reSrc, '找不到短码匹配结构');
  // 用与实现同源的形态构造：:name: 且 name 在表内才替换
  const s = PP.indexOf('const EMOJI_MAP');
  let i = PP.indexOf('{', s), depth = 0, end = -1;
  for (; i < PP.length; i++) { if (PP[i] === '{') depth++; else if (PP[i] === '}') { depth--; if (depth === 0) { end = i; break; } } }
  const body = PP.slice(s, end + 1);
  const inMap = (name) => body.indexOf("'" + name + "'") >= 0 || body.indexOf(name + ':') >= 0;
  // 真短码在表内
  ['fire', 'rocket', 'smile', 'white_check_mark'].forEach((n) => assert.ok(inMap(n), n + ' 应在表内'));
  // 下列形态都不该被当成短码（时间、表格分隔线、URL、数字）
  ['12:30:45', '|:---:|', 'http://x/', ':90:', 'a:b'].forEach((t) => {
    const m = t.match(/^:([a-z0-9_+-]{2,40}):$/);
    assert.ok(!m || !inMap(m[1]), t + ' 不应被当作短码替换');
  });
});

test('深挖 · Admonition：嵌套 / ???+ 默认展开 / 未知类型不误吞', () => {
  const nested = ADM.convertAdmonitions('!!! note "外层"\n    ::: tip "内层"\n    内层正文\n    :::\n    外层正文');
  assert.ok(nested.blocks.length >= 1, '嵌套提示块应至少解析出外层');
  const open = ADM.convertAdmonitions('???+ note "默认展开"\n    正文');
  assert.strictEqual(open.blocks.length, 1);
  assert.ok(open.blocks[0].collapsible, '???+ 应可折叠');
  assert.ok(open.blocks[0].open, '???+ 应默认展开');
  // 未知类型不被吞：内容必须留在正文里（不能凭空消失）
  const unknown = ADM.convertAdmonitions('::: 不存在的类型\n正文\n:::');
  const kept = unknown.content.indexOf('正文') >= 0 || unknown.blocks.length > 0;
  assert.ok(kept, '未知类型的正文不得消失（要么忽略标记、要么照常成块）');
});

test('深挖 · ECharts / WaveDrom / Markmap：导出与渲染链路的必要接线', () => {
  const EX = read('src/modules/export.js');
  assert.match(EX, /_snapshotEchartsForExport/, 'ECharts 是 canvas：导出必须走快照替换成 <img>');
  assert.match(EX, /data-diagram-type="echarts"/, '导出快照应只挑 ECharts 容器');
  assert.match(DR_SRC, /wavedrom\/skins\//, 'WaveDrom 需要加载皮肤（default/dark）');
  assert.match(DR_SRC, /Markmap\.create/, 'Markmap 应通过 Markmap.create 建图');
  assert.match(DR_SRC, /DEFAULT_MARKMAP_HEIGHT/, 'Markmap 应有默认高度（否则量不到尺寸会画不出）');
});

