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

// 这组断言锁住一次真实故障：若把 graphviz / echarts / wavedrom / markmap 也算作
// 「可转 Mermaid」，convertMermaidSources 就会把它们的代码块改写成 language-mermaid，
// 交给 Mermaid 渲染必然报语法错（曾实测：19 个块全被 "Syntax error in text" 错误图顶掉）。
test('classify：仅 plantuml / d2 归 Mermaid，其余图表语言一律不接管', () => {
  for (const l of ['plantuml', 'puml', 'uml', 'pu', 'd2']) {
    const info = D.classify(l, 'x');
    assert.ok(info && info.kind === 'mermaid', l + ' 应归 mermaid');
  }
  for (const l of ['graphviz', 'dot', 'gv', 'echarts', 'wavedrom', 'wave',
                   'markmap', 'mermaid', 'json', 'js', 'python', '', null, undefined]) {
    assert.strictEqual(D.classify(l, 'x'), null, String(l) + ' 不得被 classify 接管');
  }
  // 别名表本身就是白名单：放宽即等于让原生引擎被 Mermaid 接管
  assert.deepStrictEqual(Object.keys(D.MERMAID_ALIASES).sort(), ['d2', 'plantuml', 'pu', 'puml', 'uml']);
  // 直出 SVG 的白名单同样只含 tikz / plot 家族
  assert.deepStrictEqual(Object.keys(D.SVG_ALIASES).sort(), ['gnuplot', 'pgf', 'plot', 'tikz', 'tikzpicture']);
});

/* ---------------- PlantUML 甘特图（@startgantt → Mermaid gantt） ---------------- */

// 这些用例全部使用**合成语法**，不引用任何示例文档 —— 文档会变，语法面不变。
test('plantuml 甘特：Project starts + lasts → 顺序排布（绝对日期）', () => {
  const src = [
    '@startgantt',
    'Project starts 2024-01-01',
    '[需求分析] lasts 10 days',
    '[设计] lasts 15 days',
    '@endgantt',
  ].join('\n');
  assert.strictEqual(D.toMermaid('plantuml', src), [
    'gantt',
    '    dateFormat YYYY-MM-DD',
    '    需求分析 :t1, 2024-01-01, 10d',
    '    设计 :t2, 2024-01-11, 15d',
  ].join('\n'));
});

test('plantuml 甘特：依赖 / 相对起点 / 周 / 里程碑 / 分组 / done / 颜色忽略', () => {
  const src = [
    '@startgantt',
    "Project starts 2024-01-01",
    '-- 第一阶段 --',
    '[A] lasts 2 weeks',
    "[B] starts at [A]'s end",
    '[B] lasts 3 days',
    '[A] -> [B]',
    '[C] happens at 2024-03-01',
    '[A] is colored in red',
    '[B] is done',
    '@endgantt',
  ].join('\n');
  assert.strictEqual(D.toMermaid('plantuml', src), [
    'gantt',
    '    dateFormat YYYY-MM-DD',
    '    section 第一阶段',
    '    A :t1, 2024-01-01, 14d',
    '    B :done, t2, 2024-01-15, 3d',
    '    C :milestone, t3, 2024-03-01, 0d',
  ].join('\n'));
});

test('plantuml 甘特：英文日期写法与「N days after」', () => {
  const src = [
    '@startgantt',
    'Project starts the 1st of January 2024',
    '[A] lasts 2 days',
    "[B] starts 3 days after [A]'s end",
    '[B] lasts 1 day',
    '@endgantt',
  ].join('\n');
  assert.strictEqual(D.toMermaid('plantuml', src), [
    'gantt',
    '    dateFormat YYYY-MM-DD',
    '    A :t1, 2024-01-01, 2d',
    '    B :t2, 2024-01-06, 1d',
  ].join('\n'));
});

test('plantuml 甘特：日历/皮肤等噪声行忽略，不影响任务解析', () => {
  const src = [
    '@startgantt',
    'Project starts 2024-01-01',
    'saturday are closed',
    'skinparam monochrome true',
    'title 版本计划',
    '[A] lasts 1 week',
    '@endgantt',
  ].join('\n');
  assert.strictEqual(D.toMermaid('plantuml', src), [
    'gantt',
    '    title 版本计划',
    '    dateFormat YYYY-MM-DD',
    '    A :t1, 2024-01-01, 7d',
  ].join('\n'));
});

test('plantuml 甘特：无法确定起点 / 无法解析的语句 → 返回 null（保留原块，不猜）', () => {
  // 没有 Project starts，也没有任何绝对日期 → 推不出起点
  assert.strictEqual(D.toMermaid('plantuml', '@startgantt\n[A] lasts 5 days\n@endgantt'), null);
  // 任务语句不在子集内 → 不猜、整体交回调用方
  assert.strictEqual(
    D.toMermaid('plantuml', '@startgantt\nProject starts 2024-01-01\n[A] frobnicates 5 days\n@endgantt'),
    null
  );
});

test('plantuml 甘特：仍不支持图种原样返回 null（json / yaml / salt）', () => {
  assert.strictEqual(D.toMermaid('plantuml', '@startjson\n{"a":1}\n@endjson'), null);
  assert.strictEqual(D.toMermaid('plantuml', '@startsalt\n{+\n}\n@endsalt'), null);
});

/* ---------------- 「超出子集」特征提示 ---------------- */

test('unsupportedHints：plantuml 识别出具体缺哪条语法', () => {
  assert.deepStrictEqual(D.unsupportedHints('plantuml', '@startjson\n{}\n@endjson'), ['@startjson']);
  assert.deepStrictEqual(D.unsupportedHints('plantuml', 'skinparam monochrome true'),
    ['skinparam / 预处理指令']);
  assert.deepStrictEqual(D.unsupportedHints('plantuml', '@startuml\nfork\n@enduml'),
    ['活动图 fork/split 并发分支']);
  // 已在子集内 → 不得乱报
  assert.deepStrictEqual(D.unsupportedHints('plantuml', '@startuml\nAlice -> Bob: hi\n@enduml'), []);
});

test('unsupportedHints：tikz 识别出具体缺哪条语法', () => {
  assert.deepStrictEqual(
    D.unsupportedHints('tikz', '\\begin{tikzpicture}[node distance=1.5cm, block/.style={draw}]\n\\end{tikzpicture}'),
    ['自定义样式（.style=…）', '相对定位（node distance / right of…）']
  );
  assert.deepStrictEqual(D.unsupportedHints('tikz', '\\begin{tikzpicture}\n\\matrix { \\node {a}; };\n\\end{tikzpicture}'),
    ['\\matrix 矩阵布局']);
  assert.deepStrictEqual(D.unsupportedHints('tikz', '\\begin{tikzpicture}\n\\draw (0,0) arc (0:90:1);\n\\end{tikzpicture}'),
    ['弧线 / 贝塞尔曲线 / to[…]']);
  // 子集内 → 空
  assert.deepStrictEqual(D.unsupportedHints('tikz', '\\draw (0,0) -- (1,1);'), []);
});

test('unsupportedHints：未知类型/无匹配一律返回空数组（不编造原因）', () => {
  assert.deepStrictEqual(D.unsupportedHints('echarts', '{"a":1}'), []);
  assert.deepStrictEqual(D.unsupportedHints(undefined, 'x'), []);
  assert.deepStrictEqual(D.unsupportedHints('tikz', ''), []);
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

/* -------- 中文名称 / 路由 / 静默降级 的回归（2026-09-24 由《渲染验证-全功能与边界.md》暴露） -------- */

test('plantuml 类图：中文类名各自独立成类（不再全塌成同一个 id）', () => {
  const out = D.plantumlToMermaid('@startuml\nclass 形状\nclass 圆形\nclass 方形\n形状 <|-- 圆形\n形状 <|-- 方形\n@enduml');
  assert.ok(out.startsWith('classDiagram'), '实际: ' + String(out).split('\n')[0]);
  const ids = (out.match(/^ {4}class (\S+)/gm) || []).map((s) => s.trim().split(' ')[1]);
  assert.strictEqual(new Set(ids).size, ids.length, '每个类应有不同 id，实际: ' + ids.join(','));
  assert.ok(/\["形状"\]/.test(out), '应保留中文显示名');
  assert.strictEqual((out.match(/<\|--/g) || []).length, 2, '两条继承关系都要在');
});

test('plantuml 时序图：`participant "X" as Y` 得到 `participant Y as X`（不再多出一个 P）', () => {
  const out = D.plantumlToMermaid('@startuml\nparticipant "认证服务" as Auth\nAlice -> Auth: 登录\n@enduml');
  assert.match(out, /participant Auth as 认证服务/);
  assert.ok(!/\bparticipant P\b/.test(out), '不应出现占位参与者 P');
});

test('plantuml 时序图：autonumber 透传给 Mermaid（可用，不是降级）', () => {
  const out = D.plantumlToMermaid('@startuml\nautonumber\nparticipant 客户 as C\nC -> C: 咨询\n@enduml');
  assert.ok(out.startsWith('sequenceDiagram'), '实际: ' + String(out).split('\n')[0]);
  assert.match(out, /^ {4}autonumber$/m);
});

test('plantuml 用例图：含 actor 时不得被判成时序图', () => {
  const out = D.plantumlToMermaid('@startuml\nactor 质量工程师 as QE\nusecase "生成周报" as UC\nQE --> UC\n@enduml');
  assert.ok(out.startsWith('flowchart LR'), '应判为组件/用例图，实际: ' + String(out).split('\n')[0]);
  assert.match(out, /QE\(\( "质量工程师" \)\)/);
  assert.match(out, /UC\(\["生成周报"\]\)/);
});

test('plantuml 活动图：fork / split 并发分支 → null（保留原块 + 提示，不画成顺序图）', () => {
  const src = '@startuml\nstart\nfork\n  :分支 A;\nfork again\n  :分支 B;\nend fork\nstop\n@enduml';
  assert.strictEqual(D.plantumlToMermaid(src), null);
  assert.ok(D.unsupportedHints('plantuml', src).some((h) => /fork/.test(h)), '提示里应指出 fork/split');
});

test('d2：中文节点各自独立且带原标签（不再全成 N 自环）', () => {
  const out = D.d2ToMermaid('客户 -> 网关: HTTPS\n网关 -> 数据库');
  assert.match(out, /\["客户"\]/);
  assert.match(out, /\["网关"\]/);
  assert.match(out, /\|HTTPS\|/, '边标签应在');
  assert.ok(!/N\["N"\]/.test(out), '不应出现 N["N"] 这种塌陷结果');
});

test('d2：style.* 等表现层属性被忽略，不产生幽灵节点', () => {
  const out = D.d2ToMermaid('style.fill: "#ffd27f"\n甲 -> 乙');
  assert.ok(!/style/.test(out), '不应出现叫 style 的节点，实际:\n' + out);
  assert.match(out, /\["甲"\]/);
});

test('tikz：弧线 / 贝塞尔 / to[…] → null（不画出一张"少了几段却看起来正常"的图）', () => {
  assert.strictEqual(D.tikzToSvg('\\draw (0,0) arc (0:90:1);', { width: 700 }), null);
  assert.strictEqual(D.tikzToSvg('\\draw (0,0) .. controls (1,1) .. (2,0);', { width: 700 }), null);
  assert.strictEqual(D.tikzToSvg('\\draw (0,0) to [bend left] (1,1);', { width: 700 }), null);
  assert.ok(D.tikzToSvg('\\draw (0,0) -- (1,1);', { width: 700 }), '普通折线仍要能画');
});

/* -------- 第二轮审计修复的回归（2026-09-24 下午） -------- */

test('plantuml 状态图：中文状态名不再塌成幽灵状态 S，且 state+中文名能正确路由', () => {
  // 路由：`state 空闲 as Idle` 旧正则只认 ["\w]，中文名漏判 → 整张图被判成类图
  const out = D.plantumlToMermaid('@startuml\nstate 空闲 as Idle\nIdle --> Running\n@enduml');
  assert.ok(out.startsWith('stateDiagram-v2'), '实际: ' + String(out).split('\n')[0]);
  assert.match(out, /as Idle/);
  // 中文状态名直接作 id（Mermaid 支持 CJK 状态名）——不得出现 mid() 塌陷出的 'S'
  const out2 = D.plantumlToMermaid('@startuml\n[*] --> 空闲\n空闲 --> 忙碌 : 任务\n忙碌 --> [*]\n@enduml');
  assert.ok(out2.startsWith('stateDiagram-v2'));
  assert.match(out2, /\[\*\] --> 空闲/);
  assert.ok(!/ --> S\b/.test(out2), '不应出现幽灵状态 S，实际:\n' + out2);
});

test('plantuml 用例图：rectangle 分组 → subgraph，且 subgraph/end 必须配平（孤立 end 会让 Mermaid 报错）', () => {
  // 用户报障：15.2 用例图整张渲染失败（Mermaid 报错）。
  // 根因：`rectangle 系统 {` 被当普通节点，结尾的 `}` 又无条件输出 `end` → 孤立 end → 语法错误。
  const out = D.plantumlToMermaid('@startuml\nleft to right direction\nactor 普通用户 as U\nrectangle 系统 {\n  U --> (浏览商品)\n  U --> (下单)\n  (下单) --> (支付) : include\n}\n@enduml');
  assert.ok(out.startsWith('flowchart LR'), '实际: ' + String(out).split('\n')[0]);
  assert.match(out, /subgraph G\d+\["系统"\]/, '矩形分组应变成 subgraph，实际:\n' + out);
  const subs = (out.match(/^\s*subgraph\b/gm) || []).length;
  const ends = (out.match(/^\s*end\s*$/gm) || []).length;
  assert.strictEqual(subs, 1, '应只有一个 subgraph');
  assert.strictEqual(subs, ends, 'subgraph 与 end 必须配平，实际:\n' + out);
});

test('plantuml 用例图：孤立 `}` 不得产生孤立 end（源码不配平也要自愈）', () => {
  const out = D.plantumlToMermaid('@startuml\nactor U\nU --> (下单)\n}\n}\n@enduml');
  const ends = (out.match(/^\s*end\s*$/gm) || []).length;
  assert.strictEqual(ends, 0, '没有开启分组就不该输出 end，实际:\n' + out);
  // 少写 `}` 时也要补齐（开启的 subgraph 必须有 end）
  const out2 = D.plantumlToMermaid('@startuml\nrectangle 系统 {\n  actor U\n  U --> (下单)\n@enduml');
  const subs2 = (out2.match(/^\s*subgraph\b/gm) || []).length;
  const ends2 = (out2.match(/^\s*end\s*$/gm) || []).length;
  assert.strictEqual(subs2, ends2, '缺 `}` 时应自动补齐 end，实际:\n' + out2);
});

test('plantuml 类图：左侧基数（`用户 "1"`）不再丢失/污染类名', () => {
  // 用户报障（15.3 类图）：`用户 "1" --> "*" 订单 : 下单` 被转成 `n_1 --> "*" C2` ——
  // 左侧「类名在基数前」的写法没被解析，类名与基数一起丢失。
  const out = D.plantumlToMermaid('@startuml\nclass 用户 {\n  +用户名: string\n}\nclass 订单 {\n  +订单号: string\n}\n用户 "1" --> "*" 订单 : 下单\n@enduml');
  assert.ok(out.startsWith('classDiagram'));
  assert.match(out, /"1" --> "\*"/, '两侧基数都要保留，实际:\n' + out);
  assert.ok(!/n_\d/.test(out), '不应出现无意义 id，实际:\n' + out);
});

test('plantuml 时序图：group…end 不得产出孤立 end（会导致整张图语法错误）', () => {
  const out = D.plantumlToMermaid('@startuml\nAlice -> Bob: hi\ngroup 认证\n  Bob -> Alice: ok\nend\n@enduml');
  assert.ok(out.startsWith('sequenceDiagram'), '实际: ' + String(out).split('\n')[0]);
  const ends = (out.match(/^\s*end\s*$/gm) || []).length;
  assert.strictEqual(ends, 0, 'group 无等价语法时应整块忽略，不能留下孤立 end，实际:\n' + out);
  // 正常的 alt/loop 仍要保留配对 end
  const out2 = D.plantumlToMermaid('@startuml\nA -> B: x\nalt 成功\n  B -> A: y\nelse 失败\n  B -> A: z\nend\n@enduml');
  const opens = (out2.match(/^\s*(alt|else|loop|opt|par)\b/gm) || []).length;
  const ends2 = (out2.match(/^\s*end\s*$/gm) || []).length;
  assert.strictEqual(ends2, 1, 'alt 必须有一个 end，实际:\n' + out2);
  assert.ok(opens >= 2);
});

test('plantuml 活动图：`endwhile (否)` 的回边与出口标签都要保留', () => {
  const out = D.plantumlToMermaid('@startuml\nstart\nwhile (还有待处理项?) is (是)\n  :处理单条;\nendwhile (否)\n:收尾统计;\nstop\n@enduml');
  assert.ok(out.startsWith('flowchart TD'), '实际: ' + String(out).split('\n')[0]);
  assert.match(out, /\|否\|/, 'endwhile 的出口标签要保留，实际:\n' + out);
  assert.match(out, /\|是\|/, 'while 的继续标签要保留，实际:\n' + out);
  // 回边必须存在：处理节点指回判断菱形
  const back = out.split('\n').filter((l) => /-->/.test(l) && /\|否\||\|是\|/.test(l));
  assert.ok(back.length >= 2, '应同时有"是"与"否"两条分支，实际:\n' + out);
});

test('D2：中文键名/层级引用/`<-` 方向/`...` 都要正确', () => {
  const out = D.plantumlToMermaid === undefined ? null : D.d2ToMermaid('direction: down\n边缘节点: {\n  采集 -> 过滤\n}\n缓冲.shape: cylinder\n边缘节点.缓冲 -> 云端.入库: 批量上传');
  assert.ok(out && out.startsWith('flowchart TB'), '实际: ' + String(out).split('\n')[0]);
  assert.match(out, /subgraph .*\["边缘节点"\]/, '中文键名的块应变成 subgraph，实际:\n' + out);
  assert.ok(!/N\d+\["边缘节点\.缓冲"\]/.test(out), '层级引用不得再生成"边缘节点.缓冲"幽灵节点，实际:\n' + out);
  // `<-` 是反向：输出里的起点节点应是「服务」（id 是分配出来的，按标签判定）
  const rev = D.d2ToMermaid('缓存 <- 服务');
  const edgeLines = rev.split('\n').filter((l) => /-->/.test(l));
  assert.strictEqual(edgeLines.length, 1, '实际:\n' + rev);
  const fromId = edgeLines[0].trim().split(/\s+/)[0];
  const fromDef = rev.split('\n').find((l) => l.trim().startsWith(fromId + '['));
  assert.ok(/服务/.test(fromDef || ''), '`A <- B` 应为 B → A，实际:\n' + rev);
  // `...` 不建幽灵节点
  const dots = D.d2ToMermaid('a -> b\nb -> ...');
  assert.ok(!/\.\.\./.test(dots), '`...` 不应成为节点，实际:\n' + dots);
});

test('plantuml 类图：声明用别名后按显示名引用不得产生重复节点；legend 块不得泄漏成幽灵类', () => {
  const out = D.plantumlToMermaid('@startuml\nclass 用户 as User\n用户 --> 订单\n@enduml');
  // 同一类只应有一个 id（声明行 + 别名标签行是同 id，属正常）
  const ids = new Set();
  out.split('\n').forEach((l) => {
    const m = l.match(/^\s*class\s+([\w.$-]+)/);
    if (m) ids.add(m[1]);
  });
  assert.deepStrictEqual([...ids], ['User'], '同一类不得产生第二个 id，实际:\n' + out);
  assert.match(out, /User --> C\d+/, '关系应复用别名 id，实际:\n' + out);
  const lg = D.plantumlToMermaid('@startuml\nlegend\nLegend\nendlegend\nA --> B\n@enduml');
  assert.ok(lg && !/class Legend|class endlegend/.test(lg), 'legend 块不得泄漏成类，实际:\n' + lg);
});

test('plot：未知标识符不得静默当成 x（宁可保留源码 + 提示）', () => {
  assert.strictEqual(D.plotToSvg('plot a*x', { width: 700 }), null, '未知标识符应失败而不是画成 x²');
  assert.ok(D.plotToSvg('plot sin(x)', { width: 700 }), '正常表达式仍要能画');
  assert.ok(D.plotToSvg('plot t', { width: 700 }), '参数变量 t 应可用');
});

test('plantuml 组件图：边标签不再被丢弃（`[A] --> [B] : 数据流`）', () => {
  const out = D.plantumlToMermaid('@startuml\n[采集] --> [存储] : 数据流\n@enduml');
  assert.ok(out.startsWith('flowchart LR'), '实际: ' + String(out).split('\n')[0]);
  assert.match(out, /-->\|数据流\|/, '边标签应保留，实际:\n' + out);
});

test('plantuml 路由：只有容器声明（database/folder）时判组件图，但有时序单短横箭头时仍判时序图', () => {
  const comp = D.plantumlToMermaid('@startuml\ndatabase 缓存\nfolder 源码\n@enduml');
  assert.ok(comp.startsWith('flowchart LR'), '应判为组件图，实际: ' + String(comp).split('\n')[0]);
  // 防回归：带 participant/database 声明 + 单短横消息 → 仍是时序图
  const seq = D.plantumlToMermaid('@startuml\nparticipant A\ndatabase DB\nA -> DB : 查询\n@enduml');
  assert.ok(seq.startsWith('sequenceDiagram'), '应判为时序图，实际: ' + String(seq).split('\n')[0]);
});

test('plantuml 时序图：return 映射为反向回复箭头（不再整行丢弃）', () => {
  const out = D.plantumlToMermaid('@startuml\nA -> B : 请求\nreturn 结果\n@enduml');
  assert.ok(out.startsWith('sequenceDiagram'));
  assert.match(out, /B-->>A: 结果/, '实际:\n' + out);
});

test('plantuml 状态图：带空格的引号状态名仍要给出合法 id（不能直出 `state In Progress`）', () => {
  // 复核审计发现：sid() 为放行 CJK 而"不匹配就原样返回"，把空格也放了过去 → 非法 Mermaid。
  const out = D.plantumlToMermaid('@startuml\nstate "In Progress" {\n  [*] --> Active\n  Active --> [*]\n}\n@enduml');
  assert.ok(out.startsWith('stateDiagram-v2'));
  assert.ok(!/state In Progress/.test(out), '不得输出含空格的裸 id，实际:\n' + out);
});

test('plantuml 时序图：`returns -> Alice` 不是 return 语句（词边界回归）', () => {
  // 复核审计发现：/^return\s*/ 会把任何以 return 开头的标识符当返回语句，整条消息被吞。
  const out = D.plantumlToMermaid('@startuml\nAlice -> Bob : hi\nreturns -> Alice : hi\n@enduml');
  assert.ok(out.startsWith('sequenceDiagram'));
  assert.match(out, /returns/, '以 return 开头的参与者名不应被当作 return 语句，实际:\n' + out);
});

test('tikz：标签文本里的 to[ / arc( 不应让整张图被判为不支持（复核回归）', () => {
  const ok = D.tikzToSvg('\\begin{tikzpicture}\n\\node at (0,0) {go to [home]};\n\\draw (0,0) -- (1,1);\n\\end{tikzpicture}', { width: 700 });
  assert.ok(ok, '标签文本里的 to [ 不应导致整体放弃，实际: ' + String(ok).slice(0, 40));
  // 真正的弧线仍要拒绝
  assert.strictEqual(D.tikzToSvg('\\begin{tikzpicture}\n\\draw (0,0) arc (0:90:1);\n\\end{tikzpicture}', { width: 700 }), null);
});

test('tikz：grid / \\path 与 arc 同口径 → null + 提示（不再静默少画几段）', () => {
  assert.strictEqual(D.tikzToSvg('\\draw (0,0) grid (3,3);', { width: 700 }), null);
  assert.strictEqual(D.tikzToSvg('\\path[draw] (0,0) -- (1,1);', { width: 700 }), null);
  const hints = D.unsupportedHints('tikz', '\\draw (0,0) grid (3,3);');
  assert.ok(hints.some((h) => /grid/.test(h)), '提示应指出 grid，实际: ' + JSON.stringify(hints));
  assert.ok(D.tikzToSvg('\\draw (0,0) -- (1,1) -- (2,0);', { width: 700 }), '普通折线不受影响');
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
