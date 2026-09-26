// 能力矩阵（遍历测试）：Word 导出必须对「渲染层能产出的每个标签」有显式处理，
// 不允许存在"没人知道会怎样"的第三态。
//
// 背景（2026-09-26）：P1–P4（嵌套列表吞并后代文字、超链接退化成纯文本、表头/列对齐丢失、
// 下划线丢失）全是靠人工一轮轮审计才发现的 —— 每修一条又冒出新的一条。根因是：渲染层支持的
// 标签集**有限且可枚举**（= rehype-sanitize 净化白名单），但此前没有任何测试守着
// "这个标签导出时到底怎么处理"。本用例把标签宇宙绑到那份白名单，要求每个标签二者其一：
//   FIXTURES     —— 有 fixture：其文本节点必须出现在导出结构里（内容不丢，硬底线）
//   KNOWN_IGNORE —— 显式忽略，且写明原因
// 渲染层以后放开新标签而导出层没跟上 → 两边都命中不了 → 本用例变红，主动提醒补映射。
// 这就是长尾的终点：此后不必再靠人肉审计发现遗漏。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const { defaultSchema } = require('rehype-sanitize');

// 渲染层在 defaultSchema 之外放开的本项目标签（见 unified-renderer.js 的净化配置）。
// 那份列表变了而这里没同步 → 下面的分类校验会失败（这是刻意的）。
const PROJECT_EXTRA_TAGS = ['u', 'center', 'progress', 'mark', 'figure', 'figcaption'];

const IMG = '<img src="data:image/png;base64,iVBORw0KGgo=" width="8" height="8">';
const TABLE = '<table><thead><tr><th>列头</th></tr></thead><tbody><tr><td>单元格</td></tr></tbody>'
  + '<tfoot><tr><td>表脚</td></tr></tfoot></table>';
const DL = '<dl><dt>术语</dt><dd>释义</dd></dl>';
const RUBY = '<p><ruby>汉字<rp>(</rp><rt>han</rt><rp>)</rp></ruby></p>';
const DETAILS = '<details><summary>摘要</summary><p>折叠内容</p></details>';
const PICTURE = '<p>图示<picture><source srcset="a.png">' + IMG + '</picture></p>';

// 每个标签一条 fixture；断言由 fixture 自动提取（不手写标记文字，避免"断言写漏了"）
const FIXTURES = {
  a: '<p>见 <a href="https://example.com/x">链接文字</a> 结束</p>',
  b: '<p><b>粗体</b></p>',
  blockquote: '<blockquote><p>引用文字</p></blockquote>',
  br: '<p>换行前<br>换行后</p>',
  code: '<p>行内<code>代码</code></p>',
  dd: DL,
  del: '<p><del>删除</del></p>',
  details: DETAILS,
  div: '<div><p>裸 div 文字</p></div>',
  dl: DL,
  dt: DL,
  em: '<p><em>斜体</em></p>',
  h1: '<h1>一级标题</h1>',
  h2: '<h2>二级标题</h2>',
  h3: '<h3>三级标题</h3>',
  h4: '<h4>四级标题</h4>',
  h5: '<h5>五级标题</h5>',
  h6: '<h6>六级标题</h6>',
  hr: '<p>分隔线之前</p><hr>',
  i: '<p><i>斜体 i</i></p>',
  img: '<p>图片说明' + IMG + '</p>',
  input: '<ul><li><input type="checkbox" checked>任务项</li></ul>',
  ins: '<p><ins>插入文字</ins></p>',
  kbd: '<p>按 <kbd>Ctrl</kbd> 键</p>',
  li: '<ul><li>列表项</li></ul>',
  ol: '<ol><li>有序项</li></ol>',
  p: '<p>普通段落</p>',
  picture: PICTURE,
  pre: '<pre><code>const a = 1;</code></pre>',
  q: '<p><q>短引用</q></p>',
  rp: RUBY,
  rt: RUBY,
  ruby: RUBY,
  s: '<p><s>删除 s</s></p>',
  samp: '<p><samp>程序输出</samp></p>',
  section: '<section><p>区块文字</p></section>',
  source: PICTURE,
  span: '<p><span>span 文字</span></p>',
  strike: '<p><strike>删除 strike</strike></p>',
  strong: '<p><strong>加重</strong></p>',
  sub: '<p>H<sub>2</sub>O</p>',
  summary: DETAILS,
  sup: '<p>上标<sup>注1</sup></p>',
  table: TABLE,
  tbody: TABLE,
  td: TABLE,
  tfoot: TABLE,
  th: TABLE,
  thead: TABLE,
  tr: TABLE,
  tt: '<p><tt>等宽 tt</tt></p>',
  ul: '<ul><li>列表项</li></ul>',
  var: '<p><var>x</var></p>',
  u: '<p><u>下划线文字</u></p>',
  center: '<center>居中文字</center>',
  mark: '<p><mark>高亮文字</mark></p>',
  figure: '<figure>' + IMG + '<figcaption>图注文字</figcaption></figure>',
  figcaption: '<figure>' + IMG + '<figcaption>图注文字</figcaption></figure>',
};

// 不作为导出契约的标签（必须写明原因，而不是默默漏掉）
const KNOWN_IGNORE = {
  progress: '装饰性进度控件：Word 无对应结构（其文字仍会被兜底逻辑保留，但产品上不承诺）',
};

function loadDomModule(w) {
  w.eval(fs.readFileSync(path.join(__dirname, '..', 'src', 'modules', 'export-docx.js'), 'utf8'));
  return w.domToDocxStructure;
}

// 提取 fixture 里"有实义的"文本节点（纯空白/纯标点不算）
function marks(html) {
  const dom = new JSDOM('<div id="m">' + html + '</div>');
  const out = [];
  const walk = (n) => {
    for (const c of n.childNodes) {
      if (c.nodeType === 3) {
        const t = (c.textContent || '').trim();
        if (t && /[0-9A-Za-z\u4e00-\u9fa5]/.test(t)) out.push(t);
      } else if (c.nodeType === 1) walk(c);
    }
  };
  walk(dom.window.document.getElementById('m'));
  return out;
}

function structureOf(html) {
  const dom = new JSDOM('<div id="root">' + html + '</div>', { runScripts: 'dangerously' });
  const w = dom.window;
  return loadDomModule(w)(w.document.getElementById('root'));
}

test('能力矩阵：渲染层标签宇宙 100% 被分类（fixture 或显式忽略）', () => {
  const universe = new Set([...(defaultSchema.tagNames || []), ...PROJECT_EXTRA_TAGS]);
  const unclassified = [...universe].filter((t) => !(t in FIXTURES) && !(t in KNOWN_IGNORE));
  assert.deepStrictEqual(unclassified, [],
    '以下渲染层标签既无 fixture 也无 KNOWN_IGNORE 说明：' + unclassified.join(', ')
    + '。渲染层放开了新标签、导出层没跟上时就会这样 —— 请在 export-docx.js 补映射并加 fixture。');
  const stale = Object.keys(FIXTURES).filter((t) => !universe.has(t));
  assert.deepStrictEqual(stale, [],
    '以下 fixture 的标签已不在渲染层白名单（白名单缩了？）：' + stale.join(', '));
  const both = Object.keys(FIXTURES).filter((t) => t in KNOWN_IGNORE);
  assert.deepStrictEqual(both, [], '同一标签不能既是 fixture 又被忽略：' + both.join(', '));
});

test('能力矩阵：每个标签的文字在导出结构里都不丢', () => {
  const broken = [];
  for (const [tag, html] of Object.entries(FIXTURES)) {
    const json = JSON.stringify(structureOf(html));
    for (const m of marks(html)) {
      if (!json.includes(m)) broken.push('<' + tag + '>: ' + m);
    }
  }
  assert.deepStrictEqual(broken, [],
    '这些标签的文字在 Word 导出结构里丢失了：' + broken.join(' | '));
});

// 除了"文字不丢"，还要钉住"语义映射"：字还在、格式没了同样是 bug（P2/P4 就是这个形态）
const RUN_FLAGS = [
  ['b', 'bold'], ['strong', 'bold'], ['em', 'italics'], ['i', 'italics'],
  ['del', 'strike'], ['s', 'strike'], ['strike', 'strike'],
  ['mark', 'highlight'], ['code', 'codeStyle'], ['u', 'underline'],
  ['sup', 'superScript'], ['sub', 'subScript'],
];

test('能力矩阵：行内标签的语义映射逐条成立（不只保住文字）', () => {
  for (const [tag, flag] of RUN_FLAGS) {
    const runs = (structureOf('<p><' + tag + '>目标文字</' + tag + '></p>')[0] || {}).runs || [];
    const hit = runs.find((r) => r.text === '目标文字');
    assert.ok(hit, '<' + tag + '> 的文字必须保留');
    assert.strictEqual(hit[flag], true, '<' + tag + '> 应映射到 run.' + flag + '（字在、格式没了）');
  }
});

const NODE_MAP = [
  ['<h3>标题文字</h3>', 'heading', (n) => n.level === 3],
  ['<hr>', 'hr', () => true],
  ['<blockquote><p>引用文字</p></blockquote>', 'paragraph', (n) => n.quote === true],
  ['<pre><code>const a = 1;</code></pre>', 'code', () => true],
  ['<ul><li>列表项</li></ul>', 'bullet', () => true],
  ['<ol><li>有序项</li></ol>', 'bullet', (n) => n.ordered === true],
  ['<table><thead><tr><th>列头</th></tr></thead></table>', 'table', (n) => n.rows[0].cells[0].header === true],
  ['<div>' + IMG + '</div>', 'image', () => true],
];

test('能力矩阵：块级/特殊节点的类型映射逐条成立', () => {
  for (const [html, type, ok] of NODE_MAP) {
    const structure = structureOf(html);
    const hit = structure.find((n) => n.type === type && ok(n));
    assert.ok(hit, html + ' 应产出 ' + type + ' 节点（实际节点类型：'
      + JSON.stringify(structure.map((n) => n.type)) + '）');
  }
});
