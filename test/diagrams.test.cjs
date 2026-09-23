// DiagramConverters 纯转换单测（node:test，不依赖 DOM / 不加载 app.js / 不需要 npm 依赖）。
// 覆盖：PlantUML(6 种图) / D2 → Mermaid，TikZ / plot → SVG，表达式解析器安全性，语言路由分类。
// 被测模块 src/modules/diagram-converters.js 零外部依赖，可在未 npm install 的环境直接运行。

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const D = require(path.resolve(__dirname, '../src/modules/diagram-converters.js'));

// 取 SVG 里「段数最多」的 path：<defs> 中的箭头 marker 也是 <path d="M0,0 L10,5 L0,10 z">，
// 直接取第一条匹配会把 marker 当成曲线（历史测试踩过这个坑）。
function longestPathSegs(svg) {
  const ds = [...String(svg).matchAll(/<path d="([^"]+)"/g)].map((m) => m[1]);
  const curve = ds.sort((a, b) => (b.split('L').length - a.split('L').length))[0] || '';
  return curve.split('L').length - 1;
}

/* ---------------- 语言路由：谁归 Mermaid ---------------- */

// 这组断言锁住一次真实故障：若把 graphviz / echarts / wavedrom / abc / markmap 也算作
// 「可转 Mermaid」，convertMermaidSources 就会把它们的代码块改写成 language-mermaid，
// 交给 Mermaid 渲染必然报语法错（曾实测：19 个块全被 "Syntax error in text" 错误图顶掉）。
test('classify：仅 plantuml / d2 归 Mermaid，其余图表语言一律不接管', () => {
  for (const l of ['plantuml', 'puml', 'uml', 'pu', 'd2']) {
    const info = D.classify(l, 'x');
    assert.ok(info && info.kind === 'mermaid', l + ' 应归 mermaid');
  }
  for (const l of ['graphviz', 'dot', 'gv', 'echarts', 'wavedrom', 'wave', 'abc', 'abcjs',
                   'markmap', 'mermaid', 'json', 'js', 'python', '', null, undefined]) {
    assert.strictEqual(D.classify(l, 'x'), null, String(l) + ' 不得被 classify 接管');
  }
  // 别名表本身就是白名单：放宽即等于让原生引擎被 Mermaid 接管
  assert.deepStrictEqual(Object.keys(D.MERMAID_ALIASES).sort(), ['d2', 'plantuml', 'pu', 'puml', 'uml']);
  // 直出 SVG 的白名单同样只含 tikz / plot 家族
  assert.deepStrictEqual(Object.keys(D.SVG_ALIASES).sort(), ['gnuplot', 'pgf', 'plot', 'tikz', 'tikzpicture']);
});

/* ---------------- PlantUML ---------------- */

test('plantuml: 类图（继承 / 组合 / 成员）', () => {
  const src = [
    '@startuml',
    'class Animal {',
    '  +String name',
    '  +move(): void',
    '}',
    'class Dog',
    'Animal <|-- Dog',
    'Animal *-- Tail',
    '@enduml',
  ].join('\n');
  const out = D.plantumlToMermaid(src);
  assert.ok(out.startsWith('classDiagram'));
  assert.match(out, /class Animal \{/);
  assert.match(out, /\+String name/);
  assert.match(out, /\+void move\(\)/);
  assert.match(out, /Animal <\|-- Dog/);
  assert.match(out, /Animal \*-- Tail/);
});

test('plantuml: 接口/枚举构造型', () => {
  const src = '@startuml\ninterface Shape {\n  +area(): double\n}\nenum Color {\n  RED\n  GREEN\n}\n@enduml';
  const out = D.plantumlToMermaid(src);
  assert.match(out, /<<interface>>/);
  assert.match(out, /<<enumeration>>/);
  assert.match(out, /RED/);
});

test('plantuml: 时序图（消息 / 激活 / alt）', () => {
  const src = [
    '@startuml',
    'participant Alice',
    'actor Bob',
    'Alice -> Bob: 你好',
    'Bob --> Alice: 收到',
    'activate Bob',
    'alt 成功',
    '  Bob -> Alice: ok',
    'else 失败',
    '  Bob -> Alice: err',
    'end',
    '@enduml',
  ].join('\n');
  const out = D.plantumlToMermaid(src);
  assert.ok(out.startsWith('sequenceDiagram'));
  assert.match(out, /Alice->>Bob: 你好/);
  assert.match(out, /Bob-->>Alice: 收到/);
  assert.match(out, /activate Bob/);
  assert.match(out, /alt 成功/);
  assert.match(out, /else 失败/);
});

test('plantuml: 状态图（[*] 起止）', () => {
  const src = '@startuml\n[*] --> Idle\nIdle --> Running : start\nRunning --> [*]\n@enduml';
  const out = D.plantumlToMermaid(src);
  assert.ok(out.startsWith('stateDiagram-v2'));
  assert.match(out, /\[\*\] --> Idle/);
  assert.match(out, /Idle --> Running : start/);
  assert.match(out, /Running --> \[\*\]/);
});

test('plantuml: 活动图（start/stop/if）', () => {
  const src = [
    '@startuml',
    'start',
    ':读取数据;',
    'if (有效?) then (yes)',
    '  :处理;',
    'else (no)',
    '  :报错;',
    'endif',
    'stop',
    '@enduml',
  ].join('\n');
  const out = D.plantumlToMermaid(src);
  assert.ok(out.startsWith('flowchart TD'));
  assert.match(out, /\(\(开始\)\)/);
  assert.match(out, /\(\(("|)结束("|)\)\)/);
  assert.match(out, /\|yes\|/);
  assert.match(out, /\|no\|/);
});

test('plantuml: 思维导图（* 层级）', () => {
  const src = '@startmindmap\n* 根\n** 子A\n*** 孙A1\n** 子B\n@endmindmap';
  const out = D.plantumlToMermaid(src);
  assert.ok(out.startsWith('mindmap'));
  assert.match(out, /root\(\(根\)\)/);
  assert.match(out, /^ {4}子A$/m);
  assert.match(out, /^ {6}孙A1$/m);
});

test('plantuml: 组件图', () => {
  const src = '@startuml\n[Web] --> [API]\ncomponent DB as "数据库"\n[API] --> DB\n@enduml';
  const out = D.plantumlToMermaid(src);
  assert.ok(out.startsWith('flowchart LR'));
  assert.match(out, /Web --> API/);
});

test('plantuml: 甘特图不支持 → null（调用方保留原代码块）', () => {
  assert.strictEqual(D.plantumlToMermaid('@startgantt\nProject starts 2024-01-01\n@endgantt'), null);
});

test('plantuml: 类图关联（双短横线）不被误判为时序图', () => {
  const out = D.plantumlToMermaid('@startuml\nA --> B\nB --> C\n@enduml');
  assert.ok(out.startsWith('classDiagram'), '双短横线关联应判为类图，实际: ' + String(out).split('\n')[0]);
});

test('plantuml: 单短横线箭头（无消息文本）判为时序图', () => {
  const out = D.plantumlToMermaid('@startuml\nAlice -> Bob\n@enduml');
  assert.ok(out.startsWith('sequenceDiagram'), '单短横线应判为时序图，实际: ' + String(out).split('\n')[0]);
});

/* ---------------- D2 ---------------- */

test('d2: 基本关系与标签', () => {
  const out = D.d2ToMermaid('a -> b: 调用\nb -> c');
  assert.ok(out.startsWith('flowchart LR'));
  assert.match(out, /a -->\|调用\| b/);
  assert.match(out, /b --> c/);
});

test('d2: shape 与 direction', () => {
  const out = D.d2ToMermaid('direction: down\na.shape: circle\na -> b');
  assert.ok(out.startsWith('flowchart TB'), 'down 应映射为 TB');
  assert.match(out, /a\(\(/);
});

test('d2: 嵌套块 → subgraph', () => {
  const out = D.d2ToMermaid('group: {\n  a -> b\n}\na -> c');
  assert.match(out, /subgraph/);
  assert.match(out, /^\s*end$/m);
});

/* ---------------- 表达式解析器（安全） ---------------- */

test('expr: 基本求值与常量', () => {
  assert.strictEqual(D.compileExpr('2 + 3 * 4')(0), 14);
  assert.ok(Math.abs(D.compileExpr('sin(pi/2)')(0) - 1) < 1e-9);
});

test('expr: 幂运算与隐式乘法', () => {
  assert.strictEqual(D.compileExpr('2^10')(0), 1024);
  assert.strictEqual(D.compileExpr('2x')(5), 10);
  assert.strictEqual(D.compileExpr('3(x+1)')(1), 6);
});

test('expr: 拒绝代码注入（不使用 eval）', () => {
  assert.strictEqual(D.compileExpr('process.exit(1)'), null);
  assert.strictEqual(D.compileExpr('require("fs")'), null);
  assert.strictEqual(D.compileExpr('x; alert(1)'), null);
});

/* ---------------- TikZ ---------------- */

test('tikz: 折线 / 圆 / 矩形 / 节点 → SVG', () => {
  const src = [
    '\\begin{tikzpicture}',
    '\\draw[thick, red, ->] (0,0) -- (2,1);',
    '\\draw (0,0) circle (0.5);',
    '\\draw (0,0) rectangle (2,1);',
    '\\node at (1,1) {中点};',
    '\\end{tikzpicture}',
  ].join('\n');
  const svg = D.tikzToSvg(src, { width: 700 });
  assert.ok(svg && svg.startsWith('<svg'));
  assert.match(svg, /<path /);
  assert.match(svg, /<circle /);
  assert.match(svg, /<rect /);
  assert.match(svg, /中点/);
  assert.match(svg, /#e11d48/, 'red 应映射为具体色值');
});

test('tikz: 非 TikZ 内容返回 null', () => {
  assert.strictEqual(D.tikzToSvg('普通文本', {}), null);
});

test('tikz: SVG 中不出现未转义脚本', () => {
  const svg = D.tikzToSvg('\\node at (0,0) {<script>alert(1)</script>};', {});
  assert.ok(svg.indexOf('<script') === -1, '文本节点必须转义');
});

/* ---------------- plot ---------------- */

test('plot: set/plot 基本渲染', () => {
  const src = [
    'set title "正弦"',
    'set xrange [-6.28:6.28]',
    'set yrange [-1.5:1.5]',
    'set grid on',
    'plot sin(x) title "sin", cos(x) title "cos" with lines',
  ].join('\n');
  const svg = D.plotToSvg(src, { width: 680, height: 400 });
  assert.ok(svg && svg.startsWith('<svg'));
  assert.match(svg, /正弦/);
  assert.ok((svg.match(/<path /g) || []).length >= 2, '应有两条曲线');
  assert.match(svg, /stroke="currentColor"/, '坐标轴应使用 currentColor 以适配主题');
});

test('plot: 无法解析的表达式返回 null', () => {
  assert.strictEqual(D.plotToSvg('plot foo(bar(baz)) + unknownfn(x)', {}), null);
});

/* ---------------- 语言路由 ---------------- */

test('classify: 别名与条件语言', () => {
  assert.deepStrictEqual(D.classify('puml', ''), { kind: 'mermaid', type: 'plantuml' });
  assert.deepStrictEqual(D.classify('d2', ''), { kind: 'mermaid', type: 'd2' });
  assert.deepStrictEqual(D.classify('gnuplot', ''), { kind: 'svg', type: 'plot' });
  assert.strictEqual(D.classify('latex', '\\documentclass{article}'), null, '普通 LaTeX 文档不应交给 TikZ');
  assert.deepStrictEqual(D.classify('latex', '\\begin{tikzpicture}\\end{tikzpicture}'), { kind: 'svg', type: 'tikz' });
  assert.strictEqual(D.classify('python', ''), null);
  assert.strictEqual(D.classify('', ''), null);
  // dot 由 diagram-renderers 的 @hpcc-js/wasm 引擎负责，本模块不应认领
  assert.strictEqual(D.classify('dot', ''), null);
});

test('toMermaid / toSvg 分发', () => {
  assert.ok(D.toMermaid('plantuml', '@startuml\nA -> B\n@enduml').startsWith('sequenceDiagram'));
  assert.strictEqual(D.toMermaid('d2', ''), null, '空源码应返回 null');
  assert.ok(D.toSvg('tikz', '\\draw (0,0) -- (1,1);').startsWith('<svg'));
  assert.strictEqual(D.toSvg('plot', ''), null);
});

/* ---------------- 2026-09-22 新增：plot 数据文件（gnuplot 风格） ---------------- */

test("plot: 数据文件（plot '-' using 1:2 + 数据行 + e 结束）", () => {
  const src = [
    'set style data points',
    "plot '-' using 1:2 title 'data'",
    '1 2',
    '2 3',
    '3 5',
    '4 7',
    '5 11',
    'e',
  ].join('\n');
  const svg = D.plotToSvg(src, { width: 600, height: 400 });
  assert.ok(svg && svg.startsWith('<svg'), '应产出 SVG');
  const dots = (svg.match(/l0\.01 0/g) || []).length;
  assert.strictEqual(dots, 5, '应绘制 5 个数据点，实际 ' + dots);
});

test('plot: 负号开头的表达式不被误判为数据文件', () => {
  const svg = D.plotToSvg("plot -x**2 + 10 title '-x^2+10'", { width: 600, height: 400 });
  assert.ok(svg && svg.startsWith('<svg'), '应产出 SVG');
  assert.strictEqual((svg.match(/l0\.01 0/g) || []).length, 0, '应走曲线路径而非数据点');
  assert.ok((svg.match(/<path /g) || []).length >= 1, '应有一条曲线');
});

/* ---------------- 2026-09-22 新增：TikZ \foreach / plot (\x,{…})、plot set parametric ---------------- */

test('tikz: \\foreach 展开为多条命令（单条命令体）', () => {
  const src = [
    '\\begin{tikzpicture}',
    '  \\foreach \\x in {0,1,...,3}',
    '    \\draw (\\x,0) -- (\\x,1);',
    '\\end{tikzpicture}',
  ].join('\n');
  const svg = D.tikzToSvg(src, {});
  assert.ok(svg && svg.startsWith('<svg'), '应产出 SVG');
  // 4 个刻度 → 4 条独立线段（减 1：<defs> 里箭头 marker 也是一个 <path>）
  assert.strictEqual((svg.match(/<path /g) || []).length - 1, 4, '应画出 4 条线段');
  assert.strictEqual(D.tikzToSvg('\\begin{tikzpicture}\\foreach \\x in {1,...,5} \\draw (\\x,0) -- (\\x,1);\\end{tikzpicture}', {}) !== null, true);
});

test('tikz: \\foreach 展开为花括号命令体', () => {
  const src = '\\begin{tikzpicture}\\foreach \\x in {0,2,...,8} { \\draw (\\x,0) -- (\\x,1); }\\end{tikzpicture}';
  const svg = D.tikzToSvg(src, {});
  assert.ok(svg && svg.startsWith('<svg'));
  assert.strictEqual((svg.match(/<path /g) || []).length - 1, 5, '步长 2 应得 0,2,4,6,8 共 5 条');
});

test('tikz: \\draw plot (\\x, {expr}) 按 domain/samples 采样', () => {
  const src = [
    '\\begin{tikzpicture}',
    '  \\draw[thick, blue, domain=0:4, samples=20] plot (\\x, {0.2*\\x*\\x});',
    '\\end{tikzpicture}',
  ].join('\n');
  const svg = D.tikzToSvg(src, {});
  assert.ok(svg && svg.startsWith('<svg'), '应产出 SVG');
  // 21 个采样点 → 折线路径含 20 段
  const poly = (svg.match(/<path d="M[^"]*L/g) || []).length;
  assert.ok(poly >= 1, '应有折线路径');
  // 取 L 最多的那条 path —— <defs> 里的箭头 marker 也是 <path d="M0,0 L10,5 …">，
  // 不能直接取第一条匹配
  const segs = longestPathSegs(svg);
  assert.strictEqual(segs, 20, '21 个采样点应得 20 段，实际 ' + segs);
});

test('tikz: 图片级 domain/samples 生效（写在 \\begin{tikzpicture}[...]）', () => {
  const src = [
    '\\begin{tikzpicture}[domain=-3:3, samples=10]',
    '  \\draw plot (\\x, {sin(\\x r)});',
    '\\end{tikzpicture}',
  ].join('\n');
  const svg = D.tikzToSvg(src, {});
  assert.ok(svg && svg.startsWith('<svg'), '应产出 SVG');
  const segs = longestPathSegs(svg);
  assert.strictEqual(segs, 10, '10 个采样点应得 10 段，实际 ' + segs);
});

test('plot: set parametric 按 x(t),y(t) 采样出真实轨迹（而非两条错误函数曲线）', () => {
  const src = [
    'set parametric',
    'set trange [0:2*pi]',
    "plot sin(3*t), cos(2*t) title 'Lissajous'",
  ].join('\n');
  const svg = D.plotToSvg(src, { width: 600, height: 400 });
  assert.ok(svg && svg.startsWith('<svg'), '应产出 SVG');
  // 参数曲线应为一条闭合轨迹：y 既取到接近 1 也取到接近 -1（cos(2t) 在 [0,2π] 上跑满）
  assert.ok(/Lissajous/.test(svg), '图例应显示标题');
  // 若被误当成两条函数曲线按 x 采样，x 值域只会来自 sin(3t) 的均匀采样，画不出这个特征；
  // 这里检查曲线点数量与 t 采样一致（默认 samples=400 → 401 点）
  const segs = ((svg.match(/<path d="M[^"]*"/) || [])[0] || '').length > 0;
  assert.ok(segs, '应有曲线路径');
});

test('plot: set parametric 缺少第二个表达式时不猜（返回 null）', () => {
  assert.strictEqual(D.plotToSvg('set parametric\nplot sin(t)', {}), null);
});
