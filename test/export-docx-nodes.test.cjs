// 纯函数测试：把预览 DOM 的 clone 转成 docx 用的中间结构（可 postMessage 的纯 JSON）。
const test = require('node:test');
const assert = require('node:assert');
const { JSDOM } = require('jsdom');

function loadDomModule(w) {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'modules', 'export-docx.js'), 'utf8');
  w.eval(src);
  return w.domToDocxStructure;
}

test('domToDocxStructure: 标题/段落/加粗映射', () => {
  const dom = new JSDOM('<div id="root"><h1>一级标题</h1><p>正文 <strong>加粗</strong></p></div>', { runScripts: 'dangerously' });
  const w = dom.window;
  const fn = loadDomModule(w);
  const structure = fn(w.document.getElementById('root'));
  assert.ok(Array.isArray(structure), '应返回数组');
  assert.strictEqual(structure[0].type, 'heading');
  assert.strictEqual(structure[0].level, 1);
  assert.strictEqual(structure[0].runs[0].text, '一级标题');
  assert.strictEqual(structure[1].type, 'paragraph');
  assert.ok(structure[1].runs.some(r => r.bold && r.text === '加粗'), '加粗 run 应有 bold 标记');
});

// 回归：KaTeX 把 \tag 编号渲染在 .katex-html 侧的 <span class="tag">，而 Word 主路径只取
// .katex-mathml 的 <math> → 编号进不了 MathML，导出的 Word 里公式编号会整块消失。
// 修法：按 data-eq-number / data-eq-tag 显式补一个文本 run。
test('domToDocxStructure: 公式编号补成文本 run（Word 里不再丢编号）', () => {
  const dom = new JSDOM(
    '<div id="root">' +
    '<span class="math-display" data-eq-number="1">' +
    '<span class="katex"><span class="katex-mathml"><math><mi>a</mi></math></span>' +
    '<span class="katex-html"><span class="tag">(1)</span></span></span></span>' +
    '<span class="math-display" data-eq-tag="3\u2032">' +
    '<span class="katex"><span class="katex-mathml"><math><mi>b</mi></math></span></span></span>' +
    '<span class="math-display"><span class="katex">' +
    '<span class="katex-mathml"><math><mi>c</mi></math></span></span></span>' +
    '</div>', { runScripts: 'dangerously' });
  const w = dom.window;
  const fn = loadDomModule(w);
  const structure = fn(w.document.getElementById('root'));
  const texts = structure.map((n) => (n.runs || []).map((r) => r.text || '').join(''));
  assert.strictEqual(texts[0], ' (1)', '自动编号应补 (1)');
  assert.strictEqual(texts[1], ' (3\u2032)', '自定义 \\tag 应补 (3\u2032)');
  assert.strictEqual(texts[2], '', '没有编号的公式不得凭空多出编号');
  assert.ok(JSON.stringify(structure).includes('mathml'), '公式本体仍走 MathML（Word 可编辑）');
});

test('domToDocxStructure: 表格单元格里的公式编号同样补 run', () => {
  const dom = new JSDOM(
    '<div id="root"><table><tr><td>' +
    '<span class="math-display" data-eq-number="7">' +
    '<span class="katex"><span class="katex-mathml"><math><mi>x</mi></math></span></span></span>' +
    '</td></tr></table></div>', { runScripts: 'dangerously' });
  const w = dom.window;
  const fn = loadDomModule(w);
  const structure = fn(w.document.getElementById('root'));
  const cellRuns = structure[0].rows[0].cells[0].paragraphs[0].runs || [];
  const joined = cellRuns.map((r) => r.text || '').join('');
  assert.strictEqual(joined, ' (7)', '单元格内的编号不得丢');
  assert.ok(cellRuns.some((r) => r.mathml), '公式本体仍为 mathml run');
});

test('domToDocxStructure: 任务列表 checkbox 转成可读 run（不产出 input 节点）', () => {
  const dom = new JSDOM('<div id="root"><ul><li><input type="checkbox" checked> 已完成</li></ul></div>', { runScripts: 'dangerously' });
  const w = dom.window;
  const fn = loadDomModule(w);
  const structure = fn(w.document.getElementById('root'));
  assert.strictEqual(structure[0].type, 'bullet');
  assert.ok(structure[0].runs && structure[0].runs.some(r => r.text.includes('☑')), '已勾选应转成 ☑ 文本');
  assert.ok(!JSON.stringify(structure).includes('checkbox'), '不应包含 input 节点');
});

test('domToDocxStructure: 表格映射为 table 节点', () => {
  const dom = new JSDOM('<div id="root"><table><tr><th>列A</th><th>列B</th></tr><tr><td>1</td><td>2</td></tr></table></div>', { runScripts: 'dangerously' });
  const w = dom.window;
  const fn = loadDomModule(w);
  const structure = fn(w.document.getElementById('root'));
  assert.strictEqual(structure[0].type, 'table');
  assert.strictEqual(structure[0].rows.length, 2);
  assert.strictEqual(structure[0].rows[0].cells[0].paragraphs[0].text, '列A');
});

test('domToDocxStructure: code 块映射为 code 节点（多行 lines）', () => {
  const dom = new JSDOM('<div id="root"><pre><code>const a = 1;\nconst b = 2;</code></pre></div>', { runScripts: 'dangerously' });
  const w = dom.window;
  const fn = loadDomModule(w);
  const structure = fn(w.document.getElementById('root'));
  assert.strictEqual(structure[0].type, 'code');
  // 中间结构是可 postMessage 的纯 JSON；经 w.eval 产出的数组属于 jsdom realm，
  // 与 node realm 的数组原型不同，deepStrictEqual 会因原型不等而拒绝，故先 JSON 规约再严格比较。
  assert.deepStrictEqual(JSON.parse(JSON.stringify(structure[0].lines)), ['const a = 1;', 'const b = 2;']);
});

// 回归：_prepareWordDOM 会把 <pre> 换成 div.tizu-code-block（内部 <pre> 用 <br> 换行）。
// 若不下探取回代码文本，代码块在 docx 主路径里会整块丢失。
test('domToDocxStructure: tizu-code-block 容器下探取回代码（不丢代码块）', () => {
  const dom = new JSDOM(
    '<div id="root"><div class="tizu-code-block" style="background:#f6f5f4">' +
    '<pre style="white-space:pre">const a = 1;<br>console.log(a);<br></pre></div></div>',
    { runScripts: 'dangerously' });
  const w = dom.window;
  const fn = loadDomModule(w);
  const structure = fn(w.document.getElementById('root'));
  assert.strictEqual(structure.length, 1, '应产出且仅产出 code 节点');
  assert.strictEqual(structure[0].type, 'code');
  assert.deepStrictEqual(
    JSON.parse(JSON.stringify(structure[0].lines)),
    ['const a = 1;', 'console.log(a);'],
    '<br> 应还原为换行，尾部空行应去掉',
  );
});

// 回归：公式图片数据以 Uint8Array 传输（structuredClone 整块拷贝，避免大图逐元素克隆拖慢导出），
// 并带上 docx 9.x ImageRun 需要的 imageType。
test('domToDocxStructure: 图片 data 为 Uint8Array 且带 imageType', () => {
  const dom = new JSDOM('<div id="root"><img src="data:image/jpeg;base64,/9j/4AAQ" width="80" height="40"></div>', { runScripts: 'dangerously' });
  const w = dom.window;
  const fn = loadDomModule(w);
  const structure = fn(w.document.getElementById('root'));
  const img = structure.find(n => n.type === 'image');
  assert.ok(img, '含 image 节点');
  assert.ok(img.data instanceof w.Uint8Array, 'data 应为 Uint8Array（postMessage 整块拷贝）');
  assert.strictEqual(img.imageType, 'jpg', 'mime 应映射为 docx 的 imageType');
});

// 回归（2026-09-26）：docx 的 ImageRun 只认 png/jpg/gif/bmp。此前 mimeToImageType() 对
// svg+xml / webp / avif / ico 一律返回默认值 'png' —— 字节与声明不符，Word 按 PNG 解码失败
//（坏图，最坏弹"文档需要修复"）；类型如实直传又会让 [Content_Types].xml 缺该扩展名声明。
// 现在结构层如实标成空串 + 用 srcMime 保留源格式，交给导出侧栅格化成 PNG。
test('domToDocxStructure: 不支持的图片格式不再冒充 png（imageType 空串 + srcMime 如实）', () => {
  const dom = new JSDOM('<div id="root">' +
    '<img src="data:image/svg+xml;base64,PHN2Zy8+" width="60" height="30">' +
    '<img src="data:image/webp;base64,UklGRg==" width="60" height="30">' +
    '<img src="data:image/gif;base64,R0lGOD" width="60" height="30">' +
    '</div>', { runScripts: 'dangerously' });
  const w = dom.window;
  const fn = loadDomModule(w);
  const imgs = fn(w.document.getElementById('root')).filter(n => n.type === 'image');
  assert.strictEqual(imgs.length, 3, '三张图都应有节点（不支持的格式由后续栅格化兜底，不是在这里丢）');
  assert.strictEqual(imgs[0].imageType, '', 'svg 不得再被标成 png');
  assert.strictEqual(imgs[0].srcMime, 'image/svg+xml', 'srcMime 应如实保留源格式');
  assert.strictEqual(imgs[1].imageType, '', 'webp 不得再被标成 png');
  assert.strictEqual(imgs[1].srcMime, 'image/webp');
  assert.strictEqual(imgs[2].imageType, 'gif', '原生支持的格式不受影响');
  assert.strictEqual(imgs[2].srcMime, 'image/gif');
});

test('domToDocxStructure: 图片映射为 image 节点（带 data 与宽高）', () => {
  const dom = new JSDOM('<div id="root"><p><img src="data:image/png;base64,iVBORw0KGgo=" data-natW="100" data-natH="50" data-dispW="100" data-dispH="50"></p></div>', { runScripts: 'dangerously' });
  const w = dom.window;
  const fn = loadDomModule(w);
  const structure = fn(w.document.getElementById('root'));
  const img = structure.find(n => n.type === 'image');
  assert.ok(img, '含 image 节点');
  assert.strictEqual(img.width, 100);
  assert.strictEqual(img.height, 50);
  assert.ok(img.data && img.data.length > 0, 'data 应有字节');
});

test('domToDocxStructure: 行内 KaTeX 公式提取 mathml run（不收集 katex-html 可见文本）', () => {
  const dom = new JSDOM(
    '<div id="root"><p>行内 <span class="katex"><span class="katex-mathml"><math xmlns="http://www.w3.org/1998/Math/MathML"><semantics><mrow><mi>E</mi><mo>=</mo><mi>m</mi><msup><mi>c</mi><mn>2</mn></msup></mrow><annotation encoding="application/x-tex">E=mc^2</annotation></semantics></math></span><span class="katex-html">E=mc2</span></span> 公式</p></div>',
    { runScripts: 'dangerously' }
  );
  const w = dom.window;
  const fn = loadDomModule(w);
  const structure = fn(w.document.getElementById('root'));
  const para = structure.find(n => n.type === 'paragraph');
  assert.ok(para, '应有段落节点');
  const mathRun = para.runs.find(r => r.mathml);
  assert.ok(mathRun, '应提取 mathml run');
  assert.ok(mathRun.mathml.includes('<math'), 'mathml 应含 <math> 元素');
  assert.ok(!para.runs.some(r => r.text === 'E=mc2'), '不应收集 katex-html 的重复可见文本');
  assert.ok(para.runs.some(r => r.text && r.text.includes('行内')), '段落前后文本保留');
});

test('domToDocxStructure: 独立公式块（math-display）提取 mathml 为居中段落', () => {
  const dom = new JSDOM(
    '<div id="root"><span class="math-display"><span class="katex"><span class="katex-mathml"><math xmlns="http://www.w3.org/1998/Math/MathML"><semantics><mrow><msubsup><mo>&#x2211;</mo><mrow><mi>i</mi><mo>=</mo><mn>1</mn></mrow><mi>n</mi></msubsup><msup><mi>i</mi><mn>2</mn></msup></mrow></semantics></math></span><span class="katex-html">&#x2211;i=1ni2</span></span></span></div>',
    { runScripts: 'dangerously' }
  );
  const w = dom.window;
  const fn = loadDomModule(w);
  const structure = fn(w.document.getElementById('root'));
  const para = structure.find(n => n.type === 'paragraph' && n.align === 'center');
  assert.ok(para, '独立公式应作为居中段落');
  assert.ok(para.runs.some(r => r.mathml && r.mathml.includes('<math')), '应提取 mathml');
});

// ===== 2026-09-14 用户导出验证：以下位置此前要么整块丢失、要么公式退化成 "α\alphaα" =====

const KATEX_ALPHA = '<span class="katex">'
  + '<span class="katex-mathml"><math xmlns="http://www.w3.org/1998/Math/MathML"><semantics><mrow><mi>α</mi></mrow>'
  + '<annotation encoding="application/x-tex">\\alpha</annotation></semantics></math></span>'
  + '<span class="katex-html" aria-hidden="true"><span class="mord">α</span></span></span>';

test('domToDocxStructure: 表格单元格内的公式走 mathml run（不再三重化成 α\\alphaα）', () => {
  // 单元格此前直接取 td.textContent：MathML 文本 + LaTeX annotation + katex-html 可见文本
  // 会被拼成 "α\alphaα"，Word 里显示成乱码。
  const dom = new JSDOM('<div id="root"><table><tr><th>类型</th></tr><tr><td>' + KATEX_ALPHA + '</td></tr></table></div>', { runScripts: 'dangerously' });
  const w = dom.window;
  const fn = loadDomModule(w);
  const structure = fn(w.document.getElementById('root'));
  const para = structure[0].rows[1].cells[0].paragraphs[0];
  assert.ok(para.runs && para.runs.some(r => r.mathml && r.mathml.includes('<math')), '单元格应有 mathml run');
  assert.ok(!para.runs.some(r => typeof r.text === 'string' && r.text.includes('α')), '不应把 KaTeX 可见文本收成纯文本 run');
  assert.ok(!String(para.text).includes('\\alpha'), 'text 兜底字段不应含 LaTeX 源码');
});

test('domToDocxStructure: dl 定义列表映射为 dt 加粗段 + dd 缩进段（此前整块丢失）', () => {
  const dom = new JSDOM('<div id="root"><dl><dt>黏聚力</dt><dd>符号 ' + KATEX_ALPHA + ' 的取值</dd></dl></div>', { runScripts: 'dangerously' });
  const w = dom.window;
  const fn = loadDomModule(w);
  const structure = fn(w.document.getElementById('root'));
  assert.strictEqual(structure.length, 2, 'dt / dd 应各成一段（此前 dl 整块被丢弃）');
  assert.ok(structure[0].runs.some(r => r.bold && r.text === '黏聚力'), 'dt 应加粗');
  assert.deepStrictEqual(JSON.parse(JSON.stringify(structure[1].indent)), { left: 360 }, 'dd 应缩进');
  assert.ok(structure[1].runs.some(r => r.mathml), 'dd 内公式应保留为 mathml run');
});

test('domToDocxStructure: 脚注区 section.footnotes 不再整块丢弃，且脚注引用带上标', () => {
  const md = '<div id="root"><p>正文有脚注<sup class="footnote-ref"><a href="#fn-1">[1]</a></sup></p>'
    + '<hr class="footnotes-sep"><section class="footnotes"><ol>'
    + '<li id="fn-1" class="footnote-definition"><p>质能方程 ' + KATEX_ALPHA + ' ↩</p></li>'
    + '</ol></section></div>';
  const dom = new JSDOM(md, { runScripts: 'dangerously' });
  const w = dom.window;
  const fn = loadDomModule(w);
  const structure = fn(w.document.getElementById('root'));
  assert.ok(structure.some(n => n.type === 'hr'), '脚注分隔线保留');
  const bullet = structure.find(n => n.type === 'bullet');
  assert.ok(bullet, '脚注定义应产出列表项（此前 section 整块丢失）');
  assert.ok(bullet.runs.some(r => r.mathml), '脚注定义内公式应保留为 mathml run');
  assert.ok(bullet.runs.some(r => typeof r.text === 'string' && r.text.includes('质能方程')), '脚注正文文字保留');
  assert.ok(bullet.runs.some(r => typeof r.text === 'string' && r.text.includes('↩')), '返回箭头保留');
  const refPara = structure.find(n => n.type === 'paragraph');
  assert.ok(refPara.runs.some(r => r.superScript && r.text === '[1]'), '脚注引用应为上标 run');
});

test('domToDocxStructure: 提示块标题内的公式走 mathml run', () => {
  const md = '<div id="root"><div class="alert alert-note" style="background-color:#EEF4FF">'
    + '<div class="alert-title">公式 ' + KATEX_ALPHA + ' 的取值</div>'
    + '<div class="alert-content"><p>正文说明</p></div></div></div>';
  const dom = new JSDOM(md, { runScripts: 'dangerously' });
  const w = dom.window;
  const fn = loadDomModule(w);
  const structure = fn(w.document.getElementById('root'));
  const alert = structure.find(n => n.type === 'paragraph' && n.quote);
  assert.ok(alert, '提示块应产出段落');
  assert.ok(alert.runs.some(r => r.mathml), '标题内公式应为 mathml run');
  assert.ok(!alert.runs.some(r => typeof r.text === 'string' && r.text.includes('α')), '标题不应三重化');
  assert.ok(alert.runs.some(r => r.bold && typeof r.text === 'string' && r.text.includes('公式')), '标题文字应加粗');
  assert.strictEqual(alert.quoteBg, 'EEF4FF', '提示块底纹色保留');
});

test('domToDocxStructure: 未识别容器下探取回内容，但 style/script 不入正文', () => {
  const md = '<div id="root"><style>.dbg-only{color:red}</style>'
    + '<div id="abbr-data" style="display:none" data-abbrs="[]"></div>'
    + '<div class="card"><p>卡片文字</p></div></div>';
  const dom = new JSDOM(md, { runScripts: 'dangerously' });
  const w = dom.window;
  const fn = loadDomModule(w);
  const structure = fn(w.document.getElementById('root'));
  const flat = JSON.stringify(structure);
  assert.ok(structure.some(n => n.type === 'paragraph' && (n.runs || []).some(r => r.text === '卡片文字')), '裸 div 包裹层应下探取回文本');
  assert.ok(!flat.includes('color:red'), '<style> 里的 CSS 不得当成正文');
  assert.ok(!flat.includes('abbrs'), 'abbr-data 隐藏容器不得入正文');
});

// 回归（2026-09-26，用户报障「导出 Word 失败 + 生成公式导出诊断文件」）：
// docx 的颜色字段只接受恰好 6 位 HEX（校验器：长度必须等于 6 且 +('0x'+值) 不是 NaN），
// 而这里此前只识别 rgb()，其余内联颜色一律「去掉 # 转大写」原样下传 —— 命名色 red 变成
// "RED"、rgba(…) / var(--x) / currentColor 也照传，构造 TextRun 时直接抛
// "Invalid hex value 'RED'. Expected 6 digit hex value"，**整篇**导出中止（回退成降级 HTML 版
// docx）。现在行内颜色统一归一成 6 位 HEX，归一不出就丢弃颜色（丢一次颜色远好过整篇导不出）。
test('domToDocxStructure: 行内颜色统一归一成 6 位 HEX（命名色 / rgba / var 不再拖垮导出）', () => {
  const md = '<div id="root"><p>'
    + '<span style="color:red">命名色</span>'
    + '<span style="color:#abc">三位缩写</span>'
    + '<span style="color:rgba(1, 2, 3, 0.5)">半透明</span>'
    + '<span style="color:hsl(120, 100%, 25%)">hsl</span>'
    + '<span style="color:var(--x)">自定义属性</span>'
    + '<span style="color:currentColor">上下文色</span>'
    + '</p></div>';
  const dom = new JSDOM(md, { runScripts: 'dangerously' });
  const w = dom.window;
  const fn = loadDomModule(w);
  const runs = fn(w.document.getElementById('root'))[0].runs;
  const colorOf = (text) => {
    const run = runs.find(r => r.text === text);
    assert.ok(run, '应收集到 run: ' + text);
    return run.color;
  };
  assert.strictEqual(colorOf('命名色'), 'FF0000', 'red 应转成 6 位 HEX（此前是 "RED" → docx 抛错中止整篇）');
  assert.strictEqual(colorOf('三位缩写'), 'AABBCC', '3 位 HEX 应展开成 6 位');
  assert.strictEqual(colorOf('半透明'), '010203', 'rgba() 应取 RGB 分量转 HEX（此前原样下传 → 抛错）');
  assert.strictEqual(colorOf('hsl'), '008000', 'hsl() 应解析成 HEX（此前原样下传 → 抛错）');
  assert.strictEqual(colorOf('自定义属性'), undefined, 'var() 解析不出颜色应丢弃，而不是原样交给 docx');
  assert.strictEqual(colorOf('上下文色'), undefined, 'currentColor 依赖上下文，应丢弃');
  for (const r of runs) {
    if (r.color !== undefined) {
      assert.match(r.color, /^[0-9A-F]{6}$/, '【关键断言】下传给 docx 的颜色必须恰好 6 位 HEX，实际: ' + r.color);
    }
  }
});

// 回归（2026-09-26）：<table> 里一条 <tr> 都没有（原始 HTML 很常见，例如只有 <caption>）时，
// 此前会产出 {type:'table', rows:[]}，而 docx 的 Table 构造器算
// Array(Math.max(...rows.map(r => r.CellCount)))，空 rows 让 Math.max() 得 -Infinity →
// 抛 RangeError: Invalid array length，**整篇导出失败**（与颜色那条同族：单点坏输入拖垮全篇）。
// 现在结构层不再产出空表格，并退化成文本段落把表内文字留住。
test('domToDocxStructure: 无 <tr> 的表格不产出空表格（否则 docx 构造期抛错中止整篇）', () => {
  const md = '<div id="root"><table><caption>只有标题没有行</caption></table><p>后续正文</p></div>';
  const dom = new JSDOM(md, { runScripts: 'dangerously' });
  const w = dom.window;
  const fn = loadDomModule(w);
  const structure = fn(w.document.getElementById('root'));
  assert.ok(!structure.some(n => n.type === 'table'), '【关键断言】不得产出空表格节点');
  assert.ok(structure.some(n => n.type === 'paragraph' && (n.runs || []).some(r => r.text === '只有标题没有行')),
    '表内文字应退化成段落保留（而不是整块丢失）');
  assert.ok(structure.some(n => (n.runs || []).some(r => r.text === '后续正文')), '后续正文不受影响');
});

test('domToDocxStructure: 有 <tr> 的表格仍正常产出（不误伤）', () => {
  const md = '<div id="root"><table><thead><tr><th>列一</th></tr></thead>'
    + '<tbody><tr><td>值</td></tr></tbody></table></div>';
  const dom = new JSDOM(md, { runScripts: 'dangerously' });
  const w = dom.window;
  const fn = loadDomModule(w);
  const structure = fn(w.document.getElementById('root'));
  const table = structure.find(n => n.type === 'table');
  assert.ok(table, '正常表格必须仍产出 table 节点');
  assert.strictEqual(table.rows.length, 2, '两行都要保留');
  assert.strictEqual(table.rows[0].cells[0].paragraphs[0].text, '列一');
});

// 回归（2026-09-26，P1）：3 层列表此前只导出前两层（level 写死 0/1），第 3 层及以后的条目
// 整项丢失；而 collectRuns 对未白名单标签一律递归，会把子项/孙项文字折进父项 runs ——
// 实测 3 层列表产出 [{level:0,runs:[父项,子项A,孙项X,子项B]}, ...]，Word 里子项在父项行内重复。
// 修法：liRuns 先摘掉本项自己的嵌套列表再收集文字 + walkList 递归下探。
test('domToDocxStructure: 嵌套列表逐层独立成项，父项不吞子项、第 3 层不丢（P1）', () => {
  const md = '<div id="root"><ul>'
    + '<li>父项<ul><li>子项A<ol><li>孙项X</li><li>孙项Y</li></ol></li><li>子项B</li></ul></li>'
    + '</ul></div>';
  const dom = new JSDOM(md, { runScripts: 'dangerously' });
  const w = dom.window;
  const fn = loadDomModule(w);
  const structure = fn(w.document.getElementById('root'));
  const items = structure.filter((n) => n.type === 'bullet');
  // 注意：domToDocxStructure 是在 jsdom realm 里 eval 的，它返回的是 **jsdom 的 Array**；
  // 直接对它 .map 得到的仍是 jsdom 数组 → deepStrictEqual 会因原型不同而"内容一样却失败"。
  // 这里用主 realm 的 Array.from 重新组装，顺带把断言写成一眼可读的表格。
  const summary = Array.from(items, (i) => [i.level, i.ordered === true, i.runs.map((r) => r.text).join('')]);
  assert.deepStrictEqual(
    summary,
    [[0, false, '父项'], [1, false, '子项A'], [2, true, '孙项X'], [2, true, '孙项Y'], [1, false, '子项B']],
    '【关键断言】5 个条目逐层独立：父项不得吞掉子/孙项文字，第 3 层（level=2）不得整项丢失');
  assert.strictEqual(items[2].marker, '1.', '有序子列表应带序号 1.');
  assert.strictEqual(items[3].marker, '2.', '有序子列表应带序号 2.');
  assert.strictEqual(items[0].marker, '', '无序列表不产出序号文本');
});

// 回归（2026-09-26，P2）：<a> 此前不在任何分支里 → 落到兜底递归，文字保留但 href 丢失，
// Word 里所有链接都退化成纯文本。只接受绝对可点击协议（相对路径/#锚点/javascript: 不放链接，
// 免得在 Word 里写出点不动的坏链接）。
test('domToDocxStructure: 超链接保留 href，非法协议不产出链接（P2）', () => {
  const md = '<div id="root"><p>见 <a href="https://example.com/a?b=1&amp;c=2">官网</a>'
    + ' 与 <a href="#top">锚点</a> 与 <a href="javascript:void(0)">脚本</a>'
    + ' 与 <a href="mailto:a@b.c">邮箱</a> 与 <a>无 href</a>。</p></div>';
  const dom = new JSDOM(md, { runScripts: 'dangerously' });
  const w = dom.window;
  const fn = loadDomModule(w);
  const structure = fn(w.document.getElementById('root'));
  const runs = structure[0].runs;
  const at = (t) => runs.find((r) => r.text === t);
  assert.strictEqual(at('官网').link, 'https://example.com/a?b=1&c=2', '【关键断言】href 必须原样带上（含 query）');
  assert.strictEqual(at('邮箱').link, 'mailto:a@b.c', 'mailto: 应可点');
  for (const bad of ['锚点', '脚本', '无 href']) {
    assert.ok(at(bad), '链接文字不得丢：' + bad);
    assert.strictEqual(at(bad).link, undefined, '不可点协议/无 href 不得产出链接：' + bad);
  }
});

// 回归（2026-09-26，P3）：th/td 此前同等对待 → Word 里看不出哪行是表头；列对齐只读
// style.textAlign，而渲染器输出的是 align **属性**（表格插件产出 <th align="center">，
// styles.css 也按 th[align=...] 选择）→ Markdown 的 :---: 在 Word 里全丢。
test('domToDocxStructure: 表头单元格与列对齐被保留（P3）', () => {
  const md = '<div id="root"><table>'
    + '<thead><tr><th align="left">左列</th><th align="center">中列</th></tr></thead>'
    + '<tbody><tr><td align="right">右值</td><td>默认值</td></tr></tbody></table></div>';
  const dom = new JSDOM(md, { runScripts: 'dangerously' });
  const w = dom.window;
  const fn = loadDomModule(w);
  const structure = fn(w.document.getElementById('root'));
  const table = structure.find((n) => n.type === 'table');
  assert.strictEqual(table.rows[0].header, true, '【关键断言】表头行应带 header 标记');
  assert.strictEqual(table.rows[0].cells[0].header, true, 'th 单元格应带 header 标记');
  assert.strictEqual(table.rows[1].cells[0].header, false, 'td 单元格不得被当成表头');
  assert.strictEqual(table.rows[0].cells[0].align, 'left');
  assert.strictEqual(table.rows[0].cells[1].align, 'center');
  assert.strictEqual(table.rows[1].cells[0].align, 'right');
  assert.strictEqual(table.rows[1].cells[1].align, undefined, '无对齐信息不得凭空产出 align');
  assert.strictEqual(table.rows[1].header, false, '数据行不得被当成表头');
});

test('domToDocxStructure: 内联 style 的 text-align 作为列对齐兜底（P3）', () => {
  const md = '<div id="root"><table><tr><td style="text-align:center">居中值</td></tr></table></div>';
  const dom = new JSDOM(md, { runScripts: 'dangerously' });
  const w = dom.window;
  const fn = loadDomModule(w);
  const structure = fn(w.document.getElementById('root'));
  const table = structure.find((n) => n.type === 'table');
  assert.strictEqual(table.rows[0].cells[0].align, 'center', 'style 里的对齐应被读到');
});

// 回归（2026-09-26，P4）：<u> 由渲染层净化白名单显式放开（用户手写 <u> 可达），预览有
// text-decoration: underline，但导出层此前不认 → 兜底递归保住文字、丢掉下划线语义。
// <ins>/<del> 会被 _prepareWordDOM 改写成带 text-decoration 的 <span>（Word 会把原生
// <ins>/<del> 当修订追踪），所以标签名之外的**内联样式**路径也必须认。
test('domToDocxStructure: 下划线按标签名与内联样式两条路径都能认到（P4）', () => {
  const md = '<div id="root"><p><u>u 标签</u> 与 <span style="text-decoration: underline">样式下划线</span></p></div>';
  const dom = new JSDOM(md, { runScripts: 'dangerously' });
  const w = dom.window;
  const fn = loadDomModule(w);
  const structure = fn(w.document.getElementById('root'));
  const runs = structure[0].runs;
  for (const t of ['u 标签', '样式下划线']) {
    const r = runs.find((x) => x.text === t);
    assert.ok(r, '文字不得丢：' + t);
    assert.strictEqual(r.underline, true, '【关键断言】应带 underline 标记：' + t);
  }
});

// 回归（2026-09-26 审计，内容丢失级）：折叠提示框（`???` / `???+` / `::: details`）在 Word 里
// **正文整块消失**。渲染产物见 unified-admonitions.js 的 buildAdmonitionHTML：
//   <details class="alert alert-note admonition …" data-admonition="note">
//     <summary class="alert-title admonition-summary">Note</summary>
//     <div class="alert-content admonition-content">正文</div></details>
// 两个原因叠加：① 容器是 <details> 不是 div → 落到兜底分支；② 正文容器自身带 "alert-" 前缀，
// 会命中 /alert/ 子串判断、却又找不到**后代** .alert-content → 产出空数组。于是父级 <details>
// 「把 <summary> 那个标题算作唯一产出」（nested.length > 0，兜底的纯文本救援不触发）
// → 正文连文字都没了。实测修前结构只有 [{paragraph:[Note]}]，document.xml 搜不到正文。
test('domToDocxStructure: 折叠提示框（details.admonition）的正文不得丢失', () => {
  const md = '<div id="root"><details class="alert alert-note admonition admonition-note" data-admonition="note">'
    + '<summary class="alert-title admonition-summary">Note</summary>'
    + '<div class="alert-content admonition-content"><p>折叠正文内容</p></div></details></div>';
  const dom = new JSDOM(md, { runScripts: 'dangerously' });
  const w = dom.window;
  const fn = loadDomModule(w);
  const structure = fn(w.document.getElementById('root'));
  const json = JSON.stringify(structure);
  assert.ok(json.includes('折叠正文内容'), '【关键断言】折叠提示框的正文不得丢，实际结构：' + json);
  assert.ok(json.includes('Note'), '标题不得丢');
  const para = structure.find((n) => n.type === 'paragraph');
  assert.strictEqual(para.quote, true, '折叠提示框应与普通提示框同样按引用块输出（带底色/左边框色）');
  const titleRun = para.runs.find((r) => r.text === 'Note');
  assert.strictEqual(titleRun.bold, true, '标题应加粗');
});

// 同一根因的另一面：.alert-content / .alert-title 自身此前会被当成「空提示框」吞掉 ——
// 它们出现在提示框之外的任何位置（或裸 <div class="alert">）都不能丢字。
test('domToDocxStructure: 提示框子容器与无标题的 .alert 不吞字', () => {
  const cases = [
    ['裸正文容器', '<div class="alert-content admonition-content"><p>裸正文容器</p></div>'],
    ['只有文字的提示框', '<div class="alert alert-note">只有文字的提示框</div>'],
  ];
  for (const [mark, html] of cases) {
    const dom = new JSDOM('<div id="root">' + html + '</div>', { runScripts: 'dangerously' });
    const w = dom.window;
    const fn = loadDomModule(w);
    const json = JSON.stringify(fn(w.document.getElementById('root')));
    assert.ok(json.includes(mark), '【关键断言】不得整块丢失：' + mark + '，实际结构：' + json);
  }
});
