// DiagramConverters 纯转换单测（node:test，不依赖 DOM / 不加载 app.js / 不需要 npm 依赖）。
// 覆盖：PlantUML(6 种图) / D2 → Mermaid，TikZ / plot → SVG，表达式解析器安全性，语言路由分类。
// 被测模块 src/modules/diagram-converters.js 零外部依赖，可在未 npm install 的环境直接运行。

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const D = require(path.resolve(__dirname, '../src/modules/diagram-converters.js'));

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
