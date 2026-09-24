// 回归测试：代码块高亮 + 行号包裹。
// 锁定此前修复的 bug——切换代码行号开关后预览代码块出现多余 []（结构破损 / previously highlighted 警告）。
const test = require('node:test');
const assert = require('node:assert');
const { createPreviewDom, loadHljs, B } = require('./helpers/dom.js');
const { renderMarkdown } = require('../src/unified-renderer.js');
const { processCodeBlocks } = require('../src/modules/code-block.js');

function renderInto(preview, md) {
  preview.innerHTML = renderMarkdown(md, { softBreaks: false });
}

function structureOf(preview) {
  const code = preview.querySelector('pre code');
  const scroll = code && code.querySelector(':scope > .code-scroll');
  if (!scroll) return { ok: false, reason: 'no .code-scroll' };
  // 单行块：直接 <div class="code-scroll">内容</div>（无 .code-line 包裹，符合原实现）
  if (scroll.children.length === 0) return { ok: true };
  if (scroll.children.length === 1 && !scroll.children[0].classList.contains('code-line')) return { ok: true };
  // 多行块：每行应为 .code-line > (.code-line-num + .code-line-text)
  for (const ln of scroll.children) {
    if (!ln.classList.contains('code-line')) return { ok: false, reason: 'child not .code-line: ' + ln.className };
    if (!ln.querySelector(':scope > .code-line-num')) return { ok: false, reason: 'missing .code-line-num' };
    if (!ln.querySelector(':scope > .code-line-text')) return { ok: false, reason: 'missing .code-line-text' };
  }
  return { ok: true };
}

const SAMPLE = 'function binarySearch(arr, target) {\n  let left = 0;\n  console.log(binarySearch([1, 3, 5], 7));\n}\n';
const MD = B + B + B + 'javascript\n' + SAMPLE + B + B + B;

test('代码块基础结构合法（行号关闭）', async () => {
  const { preview } = createPreviewDom();
  const hljs = loadHljs(preview.ownerDocument.defaultView);
  renderInto(preview, MD);
  const cache = new Map();
  processCodeBlocks(preview, { hljs, cache, lineNumbers: false });
  assert.deepStrictEqual(structureOf(preview), { ok: true });
});

test('高亮缓存键含语言：同文本不同语言不得互相命中（审计修复 2026-09-24）', async () => {
  const { preview } = createPreviewDom();
  const hljs = loadHljs(preview.ownerDocument.defaultView);
  // 同一段文本、两个不同语言标记：旧实现只用「文本 + 行号状态」作键 → 第二块直接吃到
  // 第一块的 JS 高亮（缓存是 app 级 Map，跨文档同样会污染）
  preview.innerHTML =
    '<pre><code class="language-javascript">const x = 1</code></pre>' +
    '<pre><code class="language-python">const x = 1</code></pre>';
  const cache = new Map();
  processCodeBlocks(preview, { hljs, cache, lineNumbers: false });
  assert.strictEqual(cache.size, 2, '两种语言应各写一条缓存（键含语言），实际 ' + cache.size);
  const blocks = preview.querySelectorAll('pre code');
  assert.ok(blocks[0].querySelector('.code-scroll'), '第一块结构应正常');
  assert.ok(blocks[1].querySelector('.code-scroll'), '第二块结构应正常');
});

test('行号开关来回切换不出现结构破损 / 无 previously highlighted 警告', async () => {
  const warns = [];
  const origWarn = console.warn;
  console.warn = (...a) => warns.push(a.join(' '));

  const { preview } = createPreviewDom();
  const win = preview.ownerDocument.defaultView;
  const hljs = loadHljs(win);
  const cache = new Map();

  const states = [false, true, false, true, false];
  for (const on of states) {
    preview.classList.toggle('code-line-numbers', on);
    renderInto(preview, MD);
    processCodeBlocks(preview, { hljs, cache, lineNumbers: on });
    const s = structureOf(preview);
    assert.deepStrictEqual(s, { ok: true }, 'state=' + on + ' -> ' + (s.reason || 'ok'));
  }

  console.warn = origWarn;
  const prevHigh = warns.filter((w) => /previously highlighted/i.test(w));
  assert.strictEqual(prevHigh.length, 0, '存在 previously highlighted 警告: ' + prevHigh.join(' | '));
});

test('缓存键区分行号状态：开/关命中的是不同缓存', async () => {
  const { preview } = createPreviewDom();
  const win = preview.ownerDocument.defaultView;
  const hljs = loadHljs(win);
  const cache = new Map();

  preview.classList.toggle('code-line-numbers', false);
  renderInto(preview, MD);
  processCodeBlocks(preview, { hljs, cache, lineNumbers: false });
  const offKey = [...cache.keys()].find((k) => k.includes('function'));
  assert.ok(offKey && offKey.endsWith('|0'), '关行号缓存键应以 |0 结尾: ' + offKey);

  preview.classList.toggle('code-line-numbers', true);
  renderInto(preview, MD);
  processCodeBlocks(preview, { hljs, cache, lineNumbers: true });
  const onKey = [...cache.keys()].find((k) => k.includes('function') && k.endsWith('|1'));
  assert.ok(onKey, '开行号应生成独立缓存键 |1');
});

test('math/mermaid/katex 代码块被跳过，不被行号包裹', async () => {
  const { preview } = createPreviewDom();
  const win = preview.ownerDocument.defaultView;
  const hljs = loadHljs(win);
  const cache = new Map();
  const mdMath = B + B + B + 'mermaid\n' + 'graph TD; A-->B;\n' + B + B + B;
  renderInto(preview, mdMath);
  processCodeBlocks(preview, { hljs, cache, lineNumbers: true });
  const code = preview.querySelector('pre code');
  assert.strictEqual(code.querySelector('.code-scroll'), null, 'mermaid 块不应被包裹');
});

test('无 hljs 时仍能按行包裹（纯转义）', async () => {
  const { preview } = createPreviewDom();
  const cache = new Map();
  renderInto(preview, MD);
  processCodeBlocks(preview, { hljs: undefined, cache, lineNumbers: false });
  const s = structureOf(preview);
  assert.deepStrictEqual(s, { ok: true });
  // 转义校验：含 < 的内容不应产生裸标签（用多行块验证 .code-line-text 转义）
  const mdHtml = B + B + B + 'html\n' + '<div>x</div>\n' + '<span>y</span>\n' + B + B + B;
  renderInto(preview, mdHtml);
  const cache2 = new Map();
  processCodeBlocks(preview, { hljs: undefined, cache: cache2, lineNumbers: false });
  const txt = preview.querySelector('pre code .code-line-text');
  assert.ok(txt, '多行块应存在 .code-line-text');
  assert.ok(txt.innerHTML.includes('&lt;'), '应包含转义后的 &lt;，实际: ' + txt.innerHTML);
});

// 回归：切换行号 / 多次渲染后，代码块整体不得被多余的 [ ] 包裹。
// 用含合法 [ ] 的源码（const a=[1,2]），区分「源码里的方括号」与「结构破损产生的包裹方括号」。
const MD_BRACKET = B + B + B + 'javascript\nconst a=[1,2];\nconst b=JSON.parse("{}");\n' + B + B + B;

function blockText(preview) {
  const code = preview.querySelector('pre code');
  // 取第一层 .code-scroll 内的纯文本（去掉行号数字），用于判断是否有包裹 [ ]
  const scroll = code.querySelector(':scope > .code-scroll');
  if (scroll) return scroll.textContent;
  return code.textContent;
}

function assertNoWrapArtifact(text, label) {
  const trimmed = text.trim();
  assert.strictEqual(trimmed.startsWith('['), false, label + '：开头出现多余 [ -> ' + trimmed.slice(0, 20));
  assert.strictEqual(trimmed.endsWith(']'), false, label + '：结尾出现多余 ] -> ' + trimmed.slice(-20));
  // 整块被 [ ... ] 包裹（开头 [ 且结尾 ]）视为破损
  assert.strictEqual(trimmed.startsWith('[') && trimmed.endsWith(']'), false, label + '：整块被 [ ] 包裹 -> ' + trimmed.slice(0, 20) + '...' + trimmed.slice(-20));
}

test('代码块不被多余 [ ] 包裹（含合法方括号的源码）', async () => {
  const { preview } = createPreviewDom();
  const win = preview.ownerDocument.defaultView;
  const hljs = loadHljs(win);
  const cache = new Map();
  const states = [false, true, false, true, false, true];
  for (const on of states) {
    preview.classList.toggle('code-line-numbers', on);
    renderInto(preview, MD_BRACKET);
    processCodeBlocks(preview, { hljs, cache, lineNumbers: on });
    const t = blockText(preview);
    assertNoWrapArtifact(t, 'state=' + on);
  }
});

test('无 hljs 分支同样不被多余 [ ] 包裹', async () => {
  const { preview } = createPreviewDom();
  const cache = new Map();
  renderInto(preview, MD_BRACKET);
  processCodeBlocks(preview, { hljs: undefined, cache, lineNumbers: true });
  assertNoWrapArtifact(blockText(preview), 'no-hljs');
});

// 回归：bundle 输出的 <code> 不带 hljs class（bundle 不调 hljs），cache hit 路径只设 innerHTML 不调
// hljs.highlightElement。若 <code> 漏掉 hljs class，hljs github.min.css / styles.css 的
// `pre code.hljs { display:block }` 不应用 → <code> 默认 display:inline → 内嵌 <div class="code-scroll">
// 不合法 → 浏览器把 inline <code> 打断成两段，预览出现两个浅色矩形装饰。
test('重渲染 cache hit 后 <code> 必须带 hljs class（避免 inline 打断成两段）', async () => {
  const { preview } = createPreviewDom();
  const win = preview.ownerDocument.defaultView;
  const hljs = loadHljs(win);
  const cache = new Map();

  // 1) 首次渲染：cache miss → hljs.highlightElement 自动加 hljs class
  renderInto(preview, MD);
  processCodeBlocks(preview, { hljs, cache, lineNumbers: false });
  let code = preview.querySelector('pre code');
  assert.ok(code.classList.contains('hljs'), '首次渲染后 <code> 应带 hljs class');

  // 2) 重渲染（模拟编辑触发，bundle 重新输出干净的 <code class="language-x">）：
  //    preview.innerHTML 替换后 <code> 失去 hljs class；cache hit 时应补回。
  renderInto(preview, MD);
  code = preview.querySelector('pre code');
  assert.strictEqual(code.classList.contains('hljs'), false, 'bundle 输出的 <code> 不应带 hljs class');

  processCodeBlocks(preview, { hljs, cache, lineNumbers: false });
  code = preview.querySelector('pre code');
  assert.ok(code.classList.contains('hljs'), 'cache hit 后 <code> 必须补回 hljs class');
});

// 回归：纯文本代码块（无语言标识）cache hit 后也应正常显示，不应有结构破损
test('无语言标识的代码块重渲染后结构合法', async () => {
  const { preview } = createPreviewDom();
  const win = preview.ownerDocument.defaultView;
  const hljs = loadHljs(win);
  const cache = new Map();
  const mdPlain = B + B + B + '\nplain text line 1\nplain text line 2\n' + B + B + B;

  renderInto(preview, mdPlain);
  processCodeBlocks(preview, { hljs, cache, lineNumbers: false });
  // 第一次后应能命中缓存
  renderInto(preview, mdPlain);
  processCodeBlocks(preview, { hljs, cache, lineNumbers: false });
  const s = structureOf(preview);
  assert.deepStrictEqual(s, { ok: true }, '无语言标识块重渲染后结构破损: ' + (s.reason || 'ok'));
});

// 回归：含 = 的 ASCII 图表代码块被 highlight.js（如 gherkin）识别时，
// 跨行 <span> 不得被 innerHTML.split('\n') 切断，导致结构破损 / 换行错乱。
const MD_ASCII_DIAGRAM = B + B + B + '\n' +
  '雷达点云 → 雷达特征编码器 → 雷达特征 f_r [D]\n' +
  '|\n' +
  '相机图像 → CNN(ResNet) → 相机特征 f_c [D] —|\n' +
  '|\n' +
  '特征融合\n' +
  '| f = w_r·f_r ⊕ w_c·f_c |\n' +
  '| （拼接 / 加权 / 注意力）|\n' +
  '|\n' +
  '检测头 → 检测结果\n' +
  B + B + B;

function hasBalancedTags(html) {
  const stack = [];
  const re = /<\/?([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const tag = m[1].toLowerCase();
    if (m[0].startsWith('</')) {
      if (stack.length === 0 || stack[stack.length - 1] !== tag) return false;
      stack.pop();
    } else if (!m[0].endsWith('/>')) {
      stack.push(tag);
    }
  }
  return stack.length === 0;
}

test('含 = 的 ASCII 图表代码块高亮后结构合法', async () => {
  const { preview } = createPreviewDom();
  const win = preview.ownerDocument.defaultView;
  const hljs = loadHljs(win);
  const cache = new Map();

  renderInto(preview, MD_ASCII_DIAGRAM);
  processCodeBlocks(preview, { hljs, cache, lineNumbers: true });
  const s = structureOf(preview);
  assert.deepStrictEqual(s, { ok: true }, '含 = 代码块高亮后结构破损: ' + (s.reason || 'ok'));

  // 额外校验：每一行的 .code-line-text 内部 HTML 标签必须自平衡，
  // 防止 highlight.js 的跨行 span 被切断后产生未闭合标签碎片。
  for (const lineText of preview.querySelectorAll('pre code .code-line-text')) {
    assert.ok(hasBalancedTags(lineText.innerHTML), `code-line-text 标签不平衡: ${lineText.innerHTML.slice(0, 80)}`);
  }

  // 内容应完整保留
  const text = preview.querySelector('pre code .code-scroll').textContent;
  assert.ok(text.includes('f = w_r·f_r ⊕ w_c·f_c'), '代码块文本内容应保留等号表达式');
  assert.ok(text.includes('相机图像 → CNN(ResNet)'), '代码块文本内容应保留第二行');
});
