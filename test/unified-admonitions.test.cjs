// Admonition（MkDocs 风格 !!! / ??? 语法）纯函数单测。
// 被测模块 src/unified-admonitions.js 零外部依赖，可在未 npm install 的环境直接运行。

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const A = require(path.resolve(__dirname, '../src/unified-admonitions.js'));

const MARKER_RE = /^<!--ADMONITION_\d+(?:_END)?-->$/;

// 模拟主管线：convertAdmonitions →（正文交给 Markdown 渲染）→ restoreAdmonitions。
// 这里用「每个正文行包一层 <p>」近似 remark 的输出，同时**保留全部标记**，
// 从而忠实还原真实管线里 restore 所面对的输入形态。
function render(src) {
  const conv = A.convertAdmonitions(src);
  const fakeHtml = conv.content.split('\n').map((l) => {
    const t = l.trim();
    if (!t) return l;
    if (MARKER_RE.test(t)) return l;
    return '<p>' + t + '</p>';
  }).join('\n');
  return { conv: conv, html: A.restoreAdmonitions(fakeHtml, conv.blocks) };
}

/* ---------------- 语法解析 ---------------- */

test('admonition: 头部解析（类型 / 自定义标题 / 折叠标记）', () => {
  assert.deepStrictEqual(A.parseAdmonitionHeader('!!! note'), {
    indent: 0, marker: '!!!', type: 'note', title: null, collapsible: false, open: false,
  });
  const t = A.parseAdmonitionHeader('!!! warning "小心"');
  assert.strictEqual(t.type, 'warning');
  assert.strictEqual(t.title, '小心');
  assert.strictEqual(A.parseAdmonitionHeader('??? tip "展开"').collapsible, true);
  assert.strictEqual(A.parseAdmonitionHeader('???+ tip "展开"').open, true);
});

test('admonition: 类型别名归一', () => {
  assert.strictEqual(A.parseAdmonitionHeader('!!! summary').type, 'abstract');
  assert.strictEqual(A.parseAdmonitionHeader('!!! hint').type, 'tip');
  assert.strictEqual(A.parseAdmonitionHeader('!!! caution').type, 'warning');
  assert.strictEqual(A.parseAdmonitionHeader('!!! error').type, 'danger');
  assert.strictEqual(A.parseAdmonitionHeader('!!! check').type, 'success');
  assert.strictEqual(A.parseAdmonitionHeader('!!! faq').type, 'question');
});

test('admonition: 未知类型与错误写法不识别（保持原文）', () => {
  assert.strictEqual(A.parseAdmonitionHeader('!!! nope'), null);
  assert.strictEqual(A.parseAdmonitionHeader('!!!note'), null, '缺少空格不识别');
  assert.strictEqual(A.parseAdmonitionHeader('!!!'), null);
});

/* ---------------- 正文收集 ---------------- */

test('admonition: 反缩进 4 空格并保留更深缩进', () => {
  const src = ['!!! note', '    第一行', '        #### 子标题', '    末行'].join('\n');
  const { conv, html } = render(src);
  assert.ok(html.indexOf('<p>第一行</p>') !== -1);
  // 顶层正文去掉 4 空格；更深的相对缩进照原样保留
  assert.ok(conv.content.indexOf('\n第一行\n') !== -1, '顶层正文不留缩进');
  assert.ok(conv.content.indexOf('\n    #### 子标题\n') !== -1, '更深一层缩进应保留 4 空格');
});

test('admonition: 无缩进体时不转换', () => {
  const src = ['!!! note', '没有缩进的内容'].join('\n');
  const { conv, html } = render(src);
  assert.strictEqual(conv.blocks.length, 0);
  assert.ok(html.indexOf('admonition') === -1);
});

test('admonition: 正文内的空行保留（分段落）', () => {
  const src = ['!!! note', '    第一段', '', '    第二段'].join('\n');
  const { html } = render(src);
  assert.ok(html.indexOf('<p>第一段</p>\n\n<p>第二段</p>') !== -1);
});

/* ---------------- 行数（data-source-line 映射的前提） ---------------- */

test('admonition: 尾随有空行时转换前后行数完全不变', () => {
  const src = [
    '# 标题',
    '',
    '!!! note "提示"',
    '    正文一',
    '',
    '    正文二',
    '',
    '后续段落',
  ].join('\n');
  const { conv } = render(src);
  assert.strictEqual(conv.content.split('\n').length, src.split('\n').length);
});

test('admonition: 体后无空行时最多 +1 行（已记录为已知偏差）', () => {
  // 惯例上 admonition 后会有空行；无空行时结束标记无处可借用，只可能多 1 行。
  // 该情形下其后内容的 data-source-line 会整体 +1 —— 见变化点记录的「已知偏差」。
  const src = ['!!! note', '    正文'].join('\n');
  const { conv } = render(src);
  const grew = conv.content.split('\n').length - src.split('\n').length;
  assert.ok(grew === 0 || grew === 1, '增长不得超过 1 行，实际：' + grew);
});

test('admonition: 多个块（含尾随空行）行数不变', () => {
  const src = [
    '!!! note',
    '    一',
    '',
    '!!! warning',
    '    二',
    '',
    '结尾',
  ].join('\n');
  const { conv } = render(src);
  assert.strictEqual(conv.content.split('\n').length, src.split('\n').length);
});

/* ---------------- 还原为 HTML ---------------- */

test('admonition: 生成 alert 兼容结构（样式与导出复用）', () => {
  const src = ['!!! note "我的标题"', '    内容'].join('\n');
  const { html } = render(src);
  assert.ok(html.indexOf('class="alert alert-note admonition admonition-note"') !== -1);
  assert.ok(html.indexOf('我的标题') !== -1);
  assert.ok(html.indexOf('admonition-content') !== -1);
  assert.ok(html.indexOf('<p>内容</p>') !== -1);
  assert.ok(html.indexOf('<!--ADMONITION_0-->') === -1, '起始标记应被消费');
  assert.ok(html.indexOf('_END-->') === -1, '结束标记应被消费');
});

test('admonition: 默认标题与类型样式', () => {
  const { html } = render('!!! danger\n    危险');
  assert.ok(html.indexOf('Danger') !== -1);
  assert.ok(html.indexOf('alert-danger') !== -1);
});

test('admonition: 折叠形式生成 details，???+ 默认展开', () => {
  const a = render('??? note "折叠"\n    内容').html;
  assert.ok(a.indexOf('<details') !== -1);
  assert.ok(/<details[^>]*\sopen/.test(a) === false, '??? 默认收起');
  const b = render('???+ note "展开"\n    内容').html;
  assert.ok(/<details[^>]*\sopen/.test(b), '???+ 默认展开');
});

test('admonition: details 使用 summary 且不产生嵌套 alert-title div', () => {
  const a = render('??? note "折叠"\n    内容').html;
  assert.ok(a.indexOf('<summary class="alert-title admonition-summary">') !== -1);
  assert.ok(a.indexOf('<div class="alert-title">') === -1, 'summary 内不应再嵌 div');
});

test('admonition: 自定义标题做 HTML 转义（防注入）', () => {
  const { html } = render('!!! note "a<b>c"\n    内容');
  assert.ok(html.indexOf('<b>') === -1, '标题中的 < 必须转义');
  assert.ok(html.indexOf('&lt;b&gt;') !== -1);
});

/* ---------------- 嵌套 ---------------- */

test('admonition: 嵌套识别为两层，外层 idx 更小', () => {
  const src = [
    '!!! note "外"',
    '    外层正文',
    '',
    '    !!! warning "内"',
    '        内层正文',
  ].join('\n');
  const { conv } = render(src);
  assert.strictEqual(conv.blocks.length, 2, '应识别出内外两层');
  assert.strictEqual(conv.blocks[0].title, '外');
  assert.strictEqual(conv.blocks[1].title, '内');
  const outerIdx = conv.content.indexOf('<!--ADMONITION_0-->');
  const innerIdx = conv.content.indexOf('<!--ADMONITION_1-->');
  assert.ok(outerIdx !== -1 && innerIdx !== -1 && outerIdx < innerIdx, '外层标记应在前');
});

test('admonition: 嵌套还原后两层都成形且无残留标记', () => {
  // 内层正文必须相对内层表头再缩进 4 空格（原始 8 空格），这是 MkDocs 嵌套的书写要求
  const src = ['!!! note "外"', '    外层', '', '    !!! warning "内"', '        内层'].join('\n');
  const { html } = render(src);
  assert.ok(html.indexOf('admonition-note') !== -1, '外层应成形');
  assert.ok(html.indexOf('admonition-warning') !== -1, '内层应成形');
  assert.ok(html.indexOf('<!--ADMONITION') === -1, '不应残留任何标记');
  // 外层应完整包住内层
  const outerStart = html.indexOf('admonition-note');
  const innerStart = html.indexOf('admonition-warning');
  assert.ok(outerStart < innerStart);
});

/* ---------------- 边界 ---------------- */

test('admonition: 围栏代码块内不转换', () => {
  const src = ['```markdown', '!!! note', '    正文', '```'].join('\n');
  const { conv, html } = render(src);
  assert.strictEqual(conv.blocks.length, 0);
  assert.ok(html.indexOf('admonition') === -1);
  assert.ok(html.indexOf('!!! note') !== -1, '原文应保留在代码块内');
});

test('admonition: 空内容块不转换', () => {
  const { conv } = render('!!! note\n\n下一段');
  assert.strictEqual(conv.blocks.length, 0);
});

test('admonition: 没有 admonition 的文档逐字节不变', () => {
  const src = '# 标题\n\n普通段落\n\n> [!NOTE]\n> 引用提示';
  const conv = A.convertAdmonitions(src);
  assert.strictEqual(conv.content, src);
  assert.strictEqual(conv.blocks.length, 0);
});

test('indentWidth / dedentLine：Tab 记 4 列', () => {
  assert.strictEqual(A.indentWidth('\t\tx'), 8);
  assert.strictEqual(A.indentWidth('    x'), 4);
  assert.strictEqual(A.dedentLine('\tfoo', 4), 'foo');
  assert.strictEqual(A.dedentLine('        foo', 4), '    foo');
  assert.strictEqual(A.dedentLine('  foo', 4), 'foo', '缩进不足时全部去掉');
});
