// 数学增强纯函数单测：siunitx 兼容层 + 公式自动编号/交叉引用。
// 被测模块 src/unified-math.js 零外部依赖，故可在未 npm install 的环境直接运行。

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const M = require(path.resolve(__dirname, '../src/unified-math.js'));

/* ---------------- siunitx ---------------- */

test('siunitx: \\SI 前缀+单位复合展开', () => {
  assert.strictEqual(
    M.expandSiunitx('\\SI{3.0}{\\kilo\\meter\\per\\hour}'),
    '3.0\\,\\mathrm{km/h}'
  );
});

test('siunitx: \\SI 上标单位', () => {
  assert.strictEqual(
    M.expandSiunitx('\\SI{9.81}{\\meter\\per\\second\\squared}'),
    '9.81\\,\\mathrm{m/s^{2}}'
  );
});

test('siunitx: \\qty 与 \\SI 等价', () => {
  assert.strictEqual(M.expandSiunitx('\\qty{5}{\\milli\\meter}'), M.expandSiunitx('\\SI{5}{\\milli\\meter}'));
  assert.strictEqual(M.expandSiunitx('\\qty{5}{\\milli\\meter}'), '5\\,\\mathrm{mm}');
});

test('siunitx: 选项与单位简写', () => {
  assert.strictEqual(M.expandSiunitx('\\SI[per-mode=symbol]{10}{\\km}'), '10\\,\\mathrm{km}');
});

test('siunitx: \\si / \\unit 无数值', () => {
  assert.strictEqual(M.expandSiunitx('\\si{\\joule\\per\\kelvin}'), '\\,\\mathrm{J/K}');
  assert.strictEqual(M.expandSiunitx('\\unit{\\micro\\second}'), '\\,\\mathrm{\\mu s}');
});

test('siunitx: \\num 千分位与科学计数法', () => {
  assert.strictEqual(M.expandSiunitx('\\num{12345.6}'), '12\\,345.6');
  assert.strictEqual(M.expandSiunitx('\\num{999}'), '999');
  assert.strictEqual(M.expandSiunitx('\\num{1.2e5}'), '1.2\\times 10^{5}');
});

test('siunitx: \\ang 度分秒', () => {
  assert.strictEqual(M.expandSiunitx('\\ang{12;30;0}'), '12^{\\circ}30^{\\prime}0^{\\prime\\prime}');
});

test('siunitx: \\SIrange 区间', () => {
  assert.strictEqual(
    M.expandSiunitx('\\SIrange{1}{5}{\\meter}'),
    '1\\text{--}5\\,\\mathrm{m}'
  );
});

test('siunitx: \\celsius 与 \\percent', () => {
  assert.strictEqual(M.expandSiunitx('\\SI{25}{\\celsius}'), '25\\,\\mathrm{^{\\circ}C}');
  assert.strictEqual(M.expandSiunitx('\\SI{50}{\\percent}'), '50\\,\\mathrm{\\%}');
});

test('siunitx: 未知单位宏原样保留（不静默丢弃）', () => {
  assert.ok(M.expandSiunitx('\\si{\\furlong}').indexOf('\\furlong') !== -1);
});

test('siunitx: 无 siunitx 命令时保持原样', () => {
  const tex = 'x^2 + y^2 = r^2';
  assert.strictEqual(M.expandSiunitx(tex), tex);
});

test('siunitx: 普通字符与转义', () => {
  assert.strictEqual(M.expandSiUnit('m/s'), 'm/s');
  assert.strictEqual(M.expandSiUnit('\\meter\\tothe{3}'), 'm^{3}');
  assert.strictEqual(M.formatSiNumber('1000000'), '1\\,000\\,000');
});

/* ---------------- 公式自动编号 ---------------- */

function ph(text, display) {
  return { text: text, display: display !== false };
}

test('公式编号: 仅带 \\label 的块级公式编号，按文档顺序', () => {
  const list = [ph('$$a=1\\label{eq:a}$$'), ph('$$b=2$$'), ph('$$c=3\\label{eq:c}$$')];
  const labels = M.assignEquationNumbers(list);
  assert.strictEqual(list[0].eqNumber, 1);
  assert.strictEqual(list[1].eqNumber, undefined, '无 label 的公式不编号');
  assert.strictEqual(list[2].eqNumber, 2, '编号跨全文连续，跳过未标号公式');
  assert.strictEqual(labels.get('eq:a'), 1);
  assert.strictEqual(labels.get('eq:c'), 2);
});

test('公式编号: \\label 被剥离（不能残留在 TeX 里）', () => {
  const list = [ph('$$a=1\\label{eq:a}$$')];
  M.assignEquationNumbers(list);
  assert.strictEqual(list[0].text, '$$a=1$$');
});

test('公式编号: \\notag / \\nonumber 关闭编号', () => {
  const list = [ph('$$a=1\\label{eq:a}\\notag$$')];
  const labels = M.assignEquationNumbers(list);
  assert.strictEqual(list[0].eqNumber, undefined);
  assert.strictEqual(labels.has('eq:a'), false);
  assert.strictEqual(list[0].text.indexOf('\\notag'), -1, '\\notag 应被剥离');
});

test('公式编号: 用户自带 \\tag 时不覆盖', () => {
  const list = [ph('$$a=1\\label{eq:a}\\tag{A}$$')];
  const labels = M.assignEquationNumbers(list);
  assert.strictEqual(list[0].eqNumber, undefined);
  assert.strictEqual(labels.has('eq:a'), false);
});

test('公式编号: 行内公式的 \\label 也剥离但不编号', () => {
  const list = [ph('$x\\label{eq:x}$', false)];
  M.assignEquationNumbers(list);
  assert.strictEqual(list[0].text, '$x$');
  assert.strictEqual(list[0].eqNumber, undefined);
});

test('公式编号: 重复 label 以首次出现为准', () => {
  const list = [ph('$$a=1\\label{eq:d}$$'), ph('$$b=2\\label{eq:d}$$')];
  const labels = M.assignEquationNumbers(list);
  assert.strictEqual(labels.get('eq:d'), 1);
  assert.strictEqual(list[1].eqNumber, 2);
});

/* ---------------- 交叉引用 ---------------- */

test('交叉引用: \\eqref 生成带括号的锚点链接', () => {
  const labels = new Map([['eq:a', 3]]);
  assert.strictEqual(
    M.expandEqref('见\\eqref{eq:a}', labels),
    '见\\href{\\#eq-3}{(\\text{3})}'
  );
});

test('交叉引用: \\ref 不带括号，且不误伤 \\eqref', () => {
  const labels = new Map([['eq:a', 2]]);
  const out = M.expandEqref('\\eqref{eq:a}与\\ref{eq:a}', labels);
  assert.strictEqual(out, '\\href{\\#eq-2}{(\\text{2})}与\\href{\\#eq-2}{\\text{2}}');
});

test('交叉引用: 未定义 label 渲染为 (?) 而不抛错', () => {
  const labels = new Map();
  assert.strictEqual(M.expandEqref('\\eqref{nope}', labels), '\\text{?}');
  assert.strictEqual(M.expandEqref('\\ref{nope}', labels), '\\text{?}');
});

test('交叉引用: 无引用时不改动原文', () => {
  assert.strictEqual(M.expandEqref('$$x=1$$', new Map()), '$$x=1$$');
});

/* ---------------- \\tag 注入 ---------------- */

test('insertEquationTag: 插到闭合 $$ 之前', () => {
  assert.strictEqual(M.insertEquationTag('$$x=1$$', 4), '$$x=1\\tag{4}$$');
});

test('insertEquationTag: 多行块级公式', () => {
  assert.strictEqual(M.insertEquationTag('$$\nx=1\n$$', 7), '$$\nx=1\n\\tag{7}$$');
});

test('insertEquationTag: 已有 \\tag 时不重复注入', () => {
  assert.strictEqual(M.insertEquationTag('$$x=1\\tag{A}$$', 4), '$$x=1\\tag{A}$$');
});

/* ---------------- 端到端组合 ---------------- */

test('端到端: 编号 + siunitx + eqref 组合', () => {
  const list = [
    ph('$$\\SI{3}{\\kilo\\meter}\\label{eq:dist}$$'),
    ph('$$t=\\frac{s}{v}\\label{eq:time}$$'),
  ];
  const labels = M.assignEquationNumbers(list);
  assert.strictEqual(list[0].eqNumber, 1);
  assert.strictEqual(list[1].eqNumber, 2);

  // 模拟 restoreMathBlocks 的变换顺序：siunitx → eqref → tag
  const apply = (p, tex) => {
    let t = M.expandSiunitx(tex);
    t = M.expandEqref(t, labels);
    if (p.eqNumber) t = M.insertEquationTag(t, p.eqNumber);
    return t;
  };
  const first = apply(list[0], list[0].text);
  assert.ok(first.indexOf('\\mathrm{km}') !== -1, 'siunitx 应展开');
  assert.ok(first.indexOf('\\tag{1}$$') !== -1, '应注入编号 1');

  const second = apply(list[1], '由\\eqref{eq:dist}得');
  assert.ok(second.indexOf('\\href{\\#eq-1}{(\\text{1})}') !== -1, 'eqref 应指向第 1 式');
});

/* ---------------- 2026-09-22 新增：\SIlist 与正文 \eqref ---------------- */

test('siunitx: \\SIlist 数值列表（分号 / 逗号分隔）', () => {
  assert.strictEqual(
    M.expandSiunitx('\\SIlist{1;2;3}{\\metre}'),
    '1,\\;2,\\;3\\,\\mathrm{m}'
  );
  assert.strictEqual(
    M.expandSiunitx('\\SIlist{1,2}{\\kilo\\gram}'),
    '1,\\;2\\,\\mathrm{kg}'
  );
});

test('siunitx: \\SIlist 内的大数同样做千分位分组', () => {
  assert.strictEqual(
    M.expandSiunitx('\\SIlist{1000;2000}{\\metre}'),
    '1\\,000,\\;2\\,000\\,\\mathrm{m}'
  );
});

test('prose eqref: 正文中的 \\eqref / \\ref 展开为可点击链接', () => {
  const labels = new Map([['eq:a', 1], ['eq:b', 2]]);
  const out = M.expandProseEqref('由式 \\eqref{eq:a} 与 \\ref{eq:b} 可知', labels);
  assert.ok(out.indexOf('<a class="eq-ref" href="#eq-1">(1)</a>') !== -1, out);
  assert.ok(out.indexOf('<a class="eq-ref" href="#eq-2">2</a>') !== -1, out);
  assert.strictEqual(out.indexOf('\\eqref'), -1, '不应残留命令');
});

test('prose eqref: 未知标签 → (?)；代码块与行内 code 内不受影响', () => {
  const labels = new Map([['eq:a', 1]]);
  assert.ok(M.expandProseEqref('见 \\eqref{nope}', labels).indexOf('(?)') !== -1);

  const block = '<pre><code>\\eqref{eq:a}</code></pre>';
  assert.strictEqual(M.expandProseEqref(block, labels), block, '代码块内原样保留');

  const inline = '<p>写法 <code>\\eqref{eq:a}</code> 与 \\eqref{eq:a}</p>';
  const out = M.expandProseEqref(inline, labels);
  assert.ok(out.indexOf('<code>\\eqref{eq:a}</code>') !== -1, '行内 code 内原样保留');
  assert.strictEqual((out.match(/#eq-1/g) || []).length, 1, 'code 外的应被替换，且只替换一次');
});

test('prose eqref: 无命令时原样返回（早退不改变任何字符）', () => {
  const html = '<p>普通正文，无命令。</p>';
  assert.strictEqual(M.expandProseEqref(html, new Map()), html);
  assert.strictEqual(M.expandProseEqref('', new Map()), '');
  assert.strictEqual(M.expandProseEqref(null, new Map()), null);
});
