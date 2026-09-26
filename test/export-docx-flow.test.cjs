// exportWord 真 OOXML 流程：页面设置对话框 → DOM→结构 → 主线程构建 → write_binary_file；失败回退 html-docx。
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const JSZip = require('jszip');
const { withEditor } = require('./helpers/app-env.cjs');

// ── 「结构 → docx 字节 → 解 OOXML」共用脚手架 ───────────────────────────────
// 本文件所有验 OOXML 的用例都要这几步（此前每处各抄一份，且都藏着两个必须照做的动作）：
//   ① node 下 DocxLib.Packer.toBlob 依赖浏览器 Blob 流、不会 settle → 用真实 toBuffer 桩掉；
//   ② 上游 jsdom 用例会把 window 泄漏到全局（其 Packer.toBlob 被桩成返回 3 字节）→
//      构建期间必须临时置空 globalThis.window，强制走 ①。
const DOCX_PAGE = {
  pageWidth: 11906, pageHeight: 16838,
  marginTop: 1440, marginBottom: 1440, marginLeft: 1800, marginRight: 1800,
};

// 结构 → docx ArrayBuffer（pageOpts 覆盖页面设置，例如 lineHeight）
async function buildDocxBuffer(structure, pageOpts) {
  if (!globalThis.DocxLib) globalThis.DocxLib = require('docx');
  const D = globalThis.DocxLib;
  if (!D.Packer.__toBufferPatched) {
    const realToBuffer = D.Packer.toBuffer.bind(D.Packer);
    D.Packer.toBlob = async (doc) => {
      const buf = await realToBuffer(doc);
      return { arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) };
    };
    D.Packer.__toBufferPatched = true;
  }
  const build = require(path.join(__dirname, '..', 'src', 'modules', 'docx-builder.js')).buildDocxFromStructure;
  const savedWindow = globalThis.window;
  globalThis.window = undefined;
  try {
    const blob = await build(structure, Object.assign({}, DOCX_PAGE, pageOpts));
    return await blob.arrayBuffer();
  } finally {
    globalThis.window = savedWindow;
  }
}

// 解 zip 取 word/document.xml（关系表另取：zip.file('word/_rels/document.xml.rels')）。
// 仓库内 jszip 为 2.x：同步 load + asText（无 3.x 的 loadAsync）。
function unzipDocx(ab) {
  const zip = new JSZip();
  zip.load(Buffer.from(ab));
  return { zip, xml: zip.file('word/document.xml').asText() };
}

test('exportWord: docx 流程主线程构建并写出二进制', async () => {
  const captured = {};
  await withEditor({ invokeImpl: (cmd, args) => {
    if (cmd === 'plugin:dialog|save') return '/tmp/out.docx';
    if (cmd === 'write_binary_file') { captured.path = args.path; captured.contents = args.contents; return undefined; }
    return null;
  } }, async (w, ed) => {
    ed._confirmDocxExport = async () => true;
    ed.showConfirmDialog = async () => true;
    const fakeBytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);
    ed._buildDocxBuffer = async () => fakeBytes.buffer;
    ed.activeTab.filePath = '/docs/note.md';
    ed.activeTab.name = '我的笔记';
    w.editor.preview.innerHTML = '<h1>标题</h1><p>正文</p>';

    await ed.exportWord();

    assert.strictEqual(captured.path, '/tmp/out.docx', '应写出 docx');
    // 现改为 base64 字符串过 IPC（避免数字数组 ~8x 内存膨胀）；解码后应是 mock 的 PK 头。
    assert.strictEqual(typeof captured.contents, 'string', 'contents 应以 base64 字符串传输');
    assert.deepStrictEqual(Array.from(Buffer.from(captured.contents, 'base64')), [0x50, 0x4b, 0x03, 0x04], 'base64 应解码回原二进制');
  });
});

test('exportWord: docx 构建失败时回退 html-docx', async () => {
  const captured = {};
  await withEditor({ invokeImpl: (cmd, args) => {
    if (cmd === 'plugin:dialog|save') return '/tmp/out.docx';
    if (cmd === 'write_binary_file') { captured.path = args.path; captured.contents = args.contents; return undefined; }
    return null;
  } }, async (w, ed) => {
    ed._confirmDocxExport = async () => true;
    ed.showConfirmDialog = async () => true;
    ed._buildDocxBuffer = async () => { throw new Error('docx build failed'); };
    ed._convertHtmlToDocxBuffer = async (html) => { return new Uint8Array([0x50, 0x4b, 0x03, 0x04]).buffer; };
    ed.activeTab.filePath = '/docs/note.md';
    ed.activeTab.name = '我的笔记';
    w.editor.preview.innerHTML = '<h1>标题</h1><p>正文</p>';

    await ed.exportWord();

    assert.strictEqual(captured.path, '/tmp/out.docx', '回退路径也应写出 docx');
  });
});

test('exportWord: 确认框取消时不写文件', async () => {
  let wrote = false;
  await withEditor({ invokeImpl: (cmd, args) => {
    if (cmd === 'plugin:dialog|save') return '/tmp/out.docx';
    if (cmd === 'write_binary_file') { wrote = true; return undefined; }
    return null;
  } }, async (w, ed) => {
    ed._confirmDocxExport = async () => false; // 取消
    ed.showConfirmDialog = async () => true;
    ed.activeTab.filePath = '/docs/note.md';
    w.editor.preview.innerHTML = '<p>hello</p>';
    await ed.exportWord();
    assert.strictEqual(wrote, false, '取消确认框时不写文件');
  });
});

test('exportWord: KaTeX 公式经 MathML→OMML 转可编辑公式传给构建器（非图片）', async () => {
  const fs = require('fs');
  const path = require('path');
  const captured = {};
  await withEditor({ invokeImpl: (cmd, args) => {
    if (cmd === 'plugin:dialog|save') return '/tmp/out.docx';
    if (cmd === 'write_binary_file') { captured.path = args.path; captured.contents = args.contents; return undefined; }
    return null;
  } }, async (w, ed) => {
    // 加载 mathml2omml vendor（真实 index.html 由 <script> 引入，harness 手动加载）
    w.eval(fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'mathml2omml.min.js'), 'utf8'));
    ed._confirmDocxExport = async () => true;
    ed.showConfirmDialog = async () => true;
    ed._buildDocxBuffer = async (structure) => {
      captured.structure = structure;
      return new Uint8Array([0x50, 0x4b, 0x03, 0x04]).buffer;
    };
    ed.activeTab.filePath = '/docs/note.md';
    ed.activeTab.name = '我的笔记';
    // 预览含 KaTeX 公式（行内 + 独立块）
    w.editor.preview.innerHTML =
      '<p>行内 <span class="katex"><span class="katex-mathml"><math xmlns="http://www.w3.org/1998/Math/MathML"><semantics><mrow><mi>E</mi><mo>=</mo><mi>m</mi><msup><mi>c</mi><mn>2</mn></msup></mrow></semantics></math></span><span class="katex-html">E=mc2</span></span> 公式</p>' +
      '<span class="math-display"><span class="katex"><span class="katex-mathml"><math xmlns="http://www.w3.org/1998/Math/MathML"><semantics><mrow><mi>x</mi><mo>+</mo><mi>y</mi></mrow></semantics></math></span><span class="katex-html">x+y</span></span></span>';

    await ed.exportWord();

    assert.ok(captured.structure, '应捕获传给构建器的 structure');
    const allRuns = [];
    for (const n of captured.structure) if (n && n.runs) allRuns.push(...n.runs);
    const ommlRuns = allRuns.filter(r => typeof r.omml === 'string');
    assert.ok(ommlRuns.length >= 2, '行内与独立公式都应转成 omml run，实际: ' + ommlRuns.length);
    assert.ok(ommlRuns.every(r => r.omml.includes('oMath')), 'omml run 应含 <m:oMath>');
    // 公式不应以图片形式出现（skipMathImage 保留 .katex 后转 OMML，而非 html2canvas 转图）
    const mathImgs = captured.structure.filter(n => n.type === 'image');
    assert.strictEqual(mathImgs.length, 0, '公式不应转成 image 节点');
  });
});

// 回归：导出入口只弹一个弹框（页面设置 + 说明合并），不再额外弹二次确认框。
test('exportWord: 只弹一次合并弹框（不再单独调用 showConfirmDialog）', async () => {
  await withEditor({ invokeImpl: (cmd) => (cmd === 'plugin:dialog|save' ? '/tmp/out.docx' : null) }, async (w, ed) => {
    let pageDialogCalls = 0;
    let confirmCalls = 0;
    ed._confirmDocxExport = async () => { pageDialogCalls++; return true; };
    ed.showConfirmDialog = async () => { confirmCalls++; return true; };
    ed._buildDocxBuffer = async () => new Uint8Array([0x50, 0x4b]).buffer;
    ed.activeTab.filePath = '/docs/note.md';
    w.editor.preview.innerHTML = '<p>hello</p>';
    await ed.exportWord();
    assert.strictEqual(pageDialogCalls, 1, '合并弹框应只弹一次');
    assert.strictEqual(confirmCalls, 0, '不应再弹独立的确认框');
  });
});

// 回归：公式一律以「Word 可编辑公式（OMML）」导出，不再转图片。
// 主路径由 domToDocxStructure 提取 <math> → _structureMathmlToOmml → oMath；
// 只有 html-docx 回退路径才会把公式降级成 LaTeX 源码文本（仍不是图片）。
test('_katexElsToLatexText: 回退路径把公式降为 LaTeX 源码文本（不产生图片）', async () => {
  await withEditor({}, async (w, ed) => {
    const clone = w.document.createElement('div');
    clone.innerHTML =
      '<p>行内 <span class="katex"><span class="katex-mathml"><math xmlns="http://www.w3.org/1998/Math/MathML"><semantics>' +
      '<mrow><mi>E</mi><mo>=</mo><mi>m</mi><msup><mi>c</mi><mn>2</mn></msup></mrow>' +
      '<annotation encoding="application/x-tex">E=mc^2</annotation></semantics></math></span>' +
      '<span class="katex-html">E=mc2</span></span> 结束</p>';
    w.document.body.appendChild(clone);

    ed._katexElsToLatexText(clone);

    assert.strictEqual(clone.querySelectorAll('.katex').length, 0, '.katex 应被替换掉');
    assert.strictEqual(clone.querySelectorAll('img').length, 0, '公式不应变成图片');
    const src = clone.querySelector('.tizu-math-source');
    assert.ok(src, '应生成 LaTeX 源码节点');
    assert.strictEqual(src.textContent, 'E=mc^2', '应取 annotation 里的 LaTeX 源码');
  });
});

// 回归：公式必须是可编辑的 OMML，而不是图片 —— 主路径 structure 里出现 omml run。
test('exportWord: 公式导出为可编辑 OMML，不产生公式图片', async () => {
  const fs = require('fs');
  const path = require('path');
  const captured = {};
  await withEditor({ invokeImpl: (cmd, args) => {
    if (cmd === 'plugin:dialog|save') return '/tmp/out.docx';
    if (cmd === 'write_binary_file') { captured.contents = args.contents; return undefined; }
    return null;
  } }, async (w, ed) => {
    w.eval(fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'mathml2omml.min.js'), 'utf8'));
    ed._confirmDocxExport = async () => true;
    ed._buildDocxBuffer = async (structure) => {
      captured.structure = structure;
      return new Uint8Array([0x50, 0x4b, 0x03, 0x04]).buffer;
    };
    ed.activeTab.filePath = '/docs/note.md';
    w.editor.preview.innerHTML =
      '<span class="math-display"><span class="katex"><span class="katex-mathml">' +
      '<math xmlns="http://www.w3.org/1998/Math/MathML"><semantics><mrow><mi>x</mi><mo>+</mo><mi>y</mi></mrow>' +
      '<annotation encoding="application/x-tex">x+y</annotation></semantics></math></span>' +
      '<span class="katex-html">x+y</span></span></span>';
    await ed.exportWord();

    const runs = [];
    for (const n of captured.structure || []) if (n && n.runs) runs.push(...n.runs);
    assert.ok(runs.some(r => typeof r.omml === 'string' && r.omml.includes('oMath')), '应产出 OMML 公式 run');
    assert.ok(!runs.some(r => typeof r.mathml === 'string'), 'mathml run 应全部转成 omml');
    assert.strictEqual(captured.structure.filter(n => n.type === 'image').length, 0, '公式不应是图片节点');
  });
});

// 回归：缺库返回 false（走回退）；有公式时逐个容错，转换失败/非良构 OMML 降级为 LaTeX 文本，
// 不再因单个坏公式让整篇构建失败回退（曾导致所有公式变文字）。
test('_structureMathmlToOmml: 缺库返回 false；非良构 OMML 降级为 LaTeX 文本不拖垮整篇', async () => {
  await withEditor({}, async (w, ed) => {
    // harness 未加载 mathml2omml vendor → MathML2OMML 缺失 → 返回 false
    const withMath = [{ type: 'paragraph', runs: [{ mathml: '<math><mrow><mi>x</mi></mrow></math>' }] }];
    assert.strictEqual(ed._structureMathmlToOmml(withMath), false, '缺转换库应返回 false');

    // 模拟有库但某公式产出非良构 OMML：用桩让 mml2omml 返回非法 XML
    w.MathML2OMML = { mml2omml: () => '<m:oMath><m:r><m:t>x</m:t>' }; // 缺闭合 </m:r></m:oMath>
    const struct = [{
      type: 'paragraph',
      runs: [{ mathml: '<math><semantics><mrow><mi>x</mi></mrow><annotation encoding="application/x-tex">x</annotation></semantics></math>' }],
    }];
    const ok = ed._structureMathmlToOmml(struct);
    assert.strictEqual(ok, true, '有库时返回 true（走主路径），个别公式降级不影响整体');
    assert.strictEqual(typeof struct[0].runs[0].text, 'string', '非良构 OMML 应降级为 text run');
    assert.strictEqual(struct[0].runs[0].text, 'x', '降级文本应取 annotation 里的 LaTeX 源码');

    // 无公式返回 true
    const noMath = [{ type: 'paragraph', runs: [{ text: 'hi' }] }];
    assert.strictEqual(ed._structureMathmlToOmml(noMath), true, '无公式时返回 true');
  });
});

// 回归（2026-09-09）：mml2omml 产出 <m:t> 文本不转义，公式含 < 时 OMML 非良构被误判坏公式，
// 降级文本又从序列化 mathml 正则捕获 annotation（未解码实体）→ Word 显示字面 O(1) &lt; O(\log n)。
// 修复：对 <m:t> 内文本定向转义修复后走 OMML 主路径；降级文本解码实体。
test('_structureMathmlToOmml: 含 < 的公式修复转义后走 OMML 主路径（不再降级）', async () => {
  const fs = require('fs');
  const path = require('path');
  await withEditor({}, async (w, ed) => {
    w.eval(fs.readFileSync(path.join(__dirname, '..', 'node_modules', 'katex', 'dist', 'katex.js'), 'utf8'));
    w.eval(fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'mathml2omml.min.js'), 'utf8'));
    // 真实 KaTeX 产出含 < 公式的 mathml（outerHTML 序列化与浏览器一致：< 已转义为 &lt;）
    const holder = w.document.createElement('div');
    w.katex.render('O(1) < O(\\log n) < O(n^2)', holder, { displayMode: true, output: 'mathml' });
    const mathEl = holder.querySelector('math');
    assert.ok(mathEl, 'KaTeX 应产出 <math>');
    const mathml = mathEl.outerHTML;

    const struct = [{ type: 'paragraph', runs: [{ mathml }] }];
    const ok = ed._structureMathmlToOmml(struct);
    assert.strictEqual(ok, true, '有库应返回 true');
    const run = struct[0].runs[0];
    assert.ok(typeof run.omml === 'string', '含 < 的公式应转成 omml run（不再降级为 LaTeX 文本），实际: ' + JSON.stringify(run).slice(0, 120));
    const doc = new w.DOMParser().parseFromString(run.omml, 'application/xml');
    assert.strictEqual(doc.getElementsByTagName('parsererror').length, 0, '修复后的 OMML 应为良构 XML');
    assert.ok(run.omml.includes('&lt;'), 'm:t 内的 < 应转义为 &lt;（XML 文本合法）');
    assert.ok(!/<m:t[^>]*>[^<]*[^<&]<[^<]*<\/m:t>/.test(run.omml.replace(/&lt;/g, '\u0001')), 'm:t 内不应残留裸 <');
  });
});

// 回归（2026-09-14 用户复现）：\overset / \underset（MathML <mover>/<munder>）会被 mml2omml
// 多包一层 <m:r><m:t>，把 <m:limUpp>/<m:limLow> 塞进"文本节点"；随后 repairTextEscaping 把里面的
// < 转义成 &lt; → XML 不成对 → 良构校验失败 → 整条公式降级成 LaTeX 源码（Word 里看到 {}^{14}_{6}…）。
// 修复：先按 OMML 语法把错位结构上提（m:t 只装文本、m:r 只装 run 子元素），再做文本转义。
// 下面的 mathml 是 KaTeX 0.17.0 的真实产出（与真机一致）。
test('_structureMathmlToOmml: \\overset / \\underset 结构错位修复后走 OMML（不再降级源码）', async () => {
  const fs = require('fs');
  const path = require('path');
  await withEditor({}, async (w, ed) => {
    w.eval(fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'mathml2omml.min.js'), 'utf8'));
    const cases = [
      ['overset', '<math xmlns="http://www.w3.org/1998/Math/MathML" display="block"><semantics><mrow><mi><mover><mo><mi>X</mi></mo><mo lspace="0em" rspace="0em">∗</mo></mover></mi></mrow><annotation encoding="application/x-tex">\\overset{*}{X}</annotation></semantics></math>', '<m:limUpp>'],
      ['underset', '<math xmlns="http://www.w3.org/1998/Math/MathML" display="block"><semantics><mrow><mi><munder><mo><mi>X</mi></mo><mo lspace="0em" rspace="0em">∗</mo></munder></mi></mrow><annotation encoding="application/x-tex">\\underset{*}{X}</annotation></semantics></math>', '<m:limLow>'],
      ['嵌套', '<math xmlns="http://www.w3.org/1998/Math/MathML" display="block"><semantics><mrow><mi><mover><mo><mi><munder><mo><mi>X</mi></mo><mrow><mo>∗</mo><mo>∗</mo></mrow></munder></mi></mo><mo lspace="0em" rspace="0em">∗</mo></mover></mi></mrow><annotation encoding="application/x-tex">\\overset{*}{\\underset{**}{X}}</annotation></semantics></math>', '<m:limUpp>'],
    ];
    for (const [name, mathml, expectTag] of cases) {
      const struct = [{ type: 'paragraph', runs: [{ mathml }] }];
      const ok = ed._structureMathmlToOmml(struct);
      assert.strictEqual(ok, true, name + ': 应返回 true');
      const run = struct[0].runs[0];
      assert.ok(typeof run.omml === 'string', name + ': 应转成 omml run（而不是降级 LaTeX 源码），实际: ' + JSON.stringify(run).slice(0, 140));
      assert.ok(run.omml.includes(expectTag), name + ': 应保留 ' + expectTag + ' 结构');
      assert.ok(!run.omml.includes('&lt;m:lim'), name + ': 结构不得被转义成文本');
      const doc = new w.DOMParser().parseFromString(run.omml, 'application/xml');
      assert.strictEqual(doc.getElementsByTagName('parsererror').length, 0, name + ': 修复后 OMML 应良构');
      // <m:t> 里只能有文本：不得再出现元素
      for (const t of Array.from(doc.getElementsByTagName('m:t'))) {
        assert.strictEqual(t.children.length, 0, name + ': m:t 内不应再嵌元素');
      }
    }
  });
});

test('_structureMathmlToOmml: 本来就正确的公式不受结构修复影响', async () => {
  const fs = require('fs');
  const path = require('path');
  await withEditor({}, async (w, ed) => {
    w.eval(fs.readFileSync(path.join(__dirname, '..', 'node_modules', 'katex', 'dist', 'katex.js'), 'utf8'));
    w.eval(fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'mathml2omml.min.js'), 'utf8'));
    const holder = w.document.createElement('div');
    w.katex.render('x^2 + \\sum_{i=1}^{n} i', holder, { displayMode: true, output: 'mathml' });
    const mathml = holder.querySelector('math').outerHTML;
    const struct = [{ type: 'paragraph', runs: [{ mathml }] }];
    assert.strictEqual(ed._structureMathmlToOmml(struct), true);
    const run = struct[0].runs[0];
    assert.ok(typeof run.omml === 'string', '普通公式仍应转成 OMML');
    assert.ok(/<m:sup>/.test(run.omml) && /<m:nary>/.test(run.omml), '上下标/求和结构应保留');
    assert.ok(!run.omml.includes('&lt;m:'), '普通公式不应出现被转义的标记');
    const doc = new w.DOMParser().parseFromString(run.omml, 'application/xml');
    assert.strictEqual(doc.getElementsByTagName('parsererror').length, 0, 'OMML 应良构');
    // 结构修复不得改动本来就正确的公式：再跑一次结果应完全一致（幂等）
    const again = [{ type: 'paragraph', runs: [{ mathml }] }];
    ed._structureMathmlToOmml(again);
    assert.strictEqual(again[0].runs[0].omml, run.omml, '同一公式两次转换结果应一致');
  });
});

test('_structureMathmlToOmml: 降级 LaTeX 文本须解码实体（&lt; 不再字面进 Word）', async () => {
  await withEditor({}, async (w, ed) => {
    // 桩库恒产出非良构 OMML → 强制走降级路径
    w.MathML2OMML = { mml2omml: () => '<broken' };
    const mathml = '<math><semantics><mrow><mi>x</mi></mrow>' +
      '<annotation encoding="application/x-tex">O(1) &lt; O(\\log n) &amp; more</annotation></semantics></math>';
    const struct = [{ type: 'paragraph', runs: [{ mathml }] }];
    ed._structureMathmlToOmml(struct);
    assert.strictEqual(struct[0].runs[0].text, 'O(1) < O(\\log n) & more', '降级文本应解码 &lt;/&amp; 为真实字符');
  });
});

// 回归（2026-09-14 用户复现）：Word 对【存在但为空的必需参数槽】一律画虚线占位框。
// mml2omml 会产出：① 只有下标的 ∑/∫ 的空 <m:sup/>；② 大运算符的空操作数 <m:e/>（被作用表达式
// 在 MathML 里是兄弟节点）；③ 空基上下标（{}^{14}_{6}C）；④ 空 lim（\xrightarrow{}）。
// 修复后：这些位置不得再有空槽，且原有文本不得丢失、OMML 必须良构且形状合规。
test('_structureMathmlToOmml: 空必需参数槽被修掉（Word 虚线占位框）', async () => {
  const fs = require('fs');
  const path = require('path');
  await withEditor({}, async (w, ed) => {
    w.eval(fs.readFileSync(path.join(__dirname, '..', 'node_modules', 'katex', 'dist', 'katex.js'), 'utf8'));
    w.eval(fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'mathml2omml.min.js'), 'utf8'));

    const ARG_SLOTS = {
      e: ['nary', 'rad', 'func', 'acc', 'bar', 'groupChr', 'limLow', 'limUpp', 'sSub', 'sSup', 'sSubSup', 'sPre', 'd', 'box', 'borderBox', 'f'],
      num: ['f'], den: ['f'],
      sub: ['nary', 'limLow', 'limUpp', 'sSub', 'sSubSup', 'sPre'],
      sup: ['nary', 'limUpp', 'sSup', 'sSubSup', 'sPre'],
      lim: ['limLow', 'limUpp'], fName: ['func'],
    };
    const tagOf = (el) => String(el.localName || el.nodeName).replace(/^.*:/, '');
    const all = (node, acc) => { acc = acc || []; for (const c of Array.from(node.children || [])) { all(c, acc); acc.push(c); } return acc; };
    const textOf = (root) => {
      let s = '';
      (function walk(n) { for (const c of Array.from(n.childNodes || [])) { if (c.nodeType === 1) { if (tagOf(c) === 't') s += c.textContent || ''; else walk(c); } } })(root);
      return s;
    };
    const emptySlotCount = (root) => {
      let n = 0;
      for (const el of all(root)) {
        const parents = ARG_SLOTS[tagOf(el)];
        if (!parents) continue;
        const p = el.parentNode && el.parentNode.nodeType === 1 ? tagOf(el.parentNode) : '';
        if (parents.indexOf(p) !== -1 && el.children.length === 0 && String(el.textContent || '').trim() === '') n++;
      }
      return n;
    };
    const orphanCount = (root) => {
      let n = 0;
      for (const el of all(root)) {
        const t = tagOf(el);
        if (['sub', 'sup', 'lim', 'e', 'num', 'den'].indexOf(t) !== -1
            && el.parentNode && el.parentNode.nodeType === 1 && tagOf(el.parentNode) === 'oMath') n++;
      }
      return n;
    };
    const isSubseq = (needle, hay) => { let i = 0; for (const ch of needle) { i = hay.indexOf(ch, i); if (i === -1) return false; i++; } return true; };

    const cases = [
      ['\\sum_{n=1}^{\\infty} \\frac{1}{n^s}', 'Σ 空上标槽 + 空操作数'],
      ['\\iint_D f\\,dxdy', '∬ 空上标槽'],
      ['\\int_D', '∫ 仅下标、无操作数 → 降级'],
      ['\\prod_{p}', '∏ 无操作数 → 按 undOvr 降级为上下限'],
      ['{}^{14}_{6}\\mathrm{C}', '空基 → 前缀上下标 m:sPre'],
      ['\\xrightarrow{}', '空 lim → 降级'],
    ];
    for (const [tex, label] of cases) {
      const holder = w.document.createElement('div');
      w.katex.render(tex, holder, { displayMode: true, throwOnError: false });
      assert.ok(!holder.querySelector('.katex-error'), label + '：KaTeX 应能渲染（用于取真实 MathML）');
      const mathml = holder.querySelector('.katex-mathml math').outerHTML;
      const raw = String(w.MathML2OMML.mml2omml(mathml));
      const struct = [{ type: 'paragraph', runs: [{ mathml }] }];
      assert.strictEqual(ed._structureMathmlToOmml(struct), true, label + '：应返回 true');
      const run = struct[0].runs[0];
      assert.ok(typeof run.omml === 'string', label + '：应转成 OMML（而非降级源码），实际 ' + JSON.stringify(run).slice(0, 120));
      assert.ok(!run.omml.includes('&lt;m:'), label + '：不应出现被转义的标记');
      const doc = new w.DOMParser().parseFromString(run.omml, 'application/xml');
      assert.strictEqual(doc.getElementsByTagName('parsererror').length, 0, label + '：应良构');
      assert.strictEqual(emptySlotCount(doc.documentElement), 0, label + '：不应残留空必需槽（会显示虚线框）');
      assert.strictEqual(orphanCount(doc.documentElement), 0, label + '：不应有孤儿槽（违反 OMML schema）');
      const rawDoc = new w.DOMParser().parseFromString(raw, 'application/xml');
      assert.ok(isSubseq(textOf(rawDoc.documentElement), textOf(doc.documentElement)), label + '：原有文本不得丢失');
    }
    // 具体形状抽查：空基转前缀上下标、无操作数降级后基数必须放在 <m:e> 里
    const renderTex = (tex) => {
      const h = w.document.createElement('div');
      w.katex.render(tex, h, { displayMode: true, throwOnError: false });
      return h.querySelector('.katex-mathml math').outerHTML;
    };
    const sp = [{ type: 'paragraph', runs: [{ mathml: renderTex('{}^{14}_{6}\\mathrm{C}') }] }];
    ed._structureMathmlToOmml(sp);
    const spDoc = new w.DOMParser().parseFromString(sp[0].runs[0].omml, 'application/xml');
    assert.strictEqual(spDoc.getElementsByTagName('m:sPre').length, 1, '应产出 m:sPre');
    assert.strictEqual(spDoc.getElementsByTagName('m:sPrePr').length, 1, '前缀上下标的属性元素应是 m:sPrePr');
    assert.ok(spDoc.getElementsByTagName('m:sPre')[0].getElementsByTagName('m:e').length > 0, 'm:sPre 必须有 <m:e> 基数');
    const s3 = [{ type: 'paragraph', runs: [{ mathml: renderTex('\\int_D') }] }];
    ed._structureMathmlToOmml(s3);
    const d3 = new w.DOMParser().parseFromString(s3[0].runs[0].omml, 'application/xml');
    assert.strictEqual(d3.getElementsByTagName('m:nary').length, 0, '无操作数的 nary 应被降级');
    assert.strictEqual(d3.getElementsByTagName('m:sSub').length, 1, '应降级为字符 + 下标');
    assert.ok(d3.getElementsByTagName('m:sSub')[0].getElementsByTagName('m:e').length > 0, '降级后的基数必须在 <m:e> 里（schema 要求）');
  });
});

// 回归（2026-09-14）：repairTextEscaping 的正则曾把自闭合的 <m:t .../>（空文本 run）当成开始标签，
// 惰性匹配一路吞到后面某个 </m:t>，把中间的结构全部转义成文本 → OMML 报废、整条公式降级为源码。
test('_structureMathmlToOmml: 空 <m:t/> 不再吞掉后续结构', async () => {
  await withEditor({}, async (w, ed) => {
    // 桩必须带命名空间声明：OMML 里用了 m:/w: 前缀，缺声明会让 XML 解析报 parsererror
    //（良构校验失败 → 走 LaTeX 降级路径，就测不到"空 <m:t/> 吞结构"这一条了）
    const M = 'http://schemas.openxmlformats.org/officeDocument/2006/math';
    w.MathML2OMML = {
      mml2omml: () => '<m:oMath xmlns:m="' + M + '"><m:r><m:t xml:space="preserve"/></m:r>'
        + '<m:r><m:t>O(1) &lt; O(n)</m:t></m:r>'
        + '<m:f><m:num><m:r><m:t>1</m:t></m:r></m:num><m:den><m:r><m:t>2</m:t></m:r></m:den></m:f></m:oMath>',
    };
    const struct = [{ type: 'paragraph', runs: [{ mathml: '<math><semantics><mrow><mi>x</mi></mrow><annotation encoding="application/x-tex">x</annotation></semantics></math>' }] }];
    assert.strictEqual(ed._structureMathmlToOmml(struct), true, '有库应返回 true');
    const run = struct[0].runs[0];
    assert.ok(typeof run.omml === 'string', '应产出 OMML');
    const doc = new w.DOMParser().parseFromString(run.omml, 'application/xml');
    assert.strictEqual(doc.getElementsByTagName('parsererror').length, 0, '应为良构（旧正则会把结构转义成文本导致标签不成对）');
    assert.ok(run.omml.includes('&lt;'), 'm:t 内的 < 仍应转义');
    assert.ok(!run.omml.includes('&lt;/m:r>') && !run.omml.includes('&lt;m:f>'), '不得把后续结构转义进 m:t');
    assert.strictEqual(doc.getElementsByTagName('m:f').length, 1, '分式结构应保留在树里');
  });
});

// 回归：builder 层兜底——_structureMathmlToOmml 预检漏过的非法 OMML，runToChild 也不能抛。
test('docx-builder: runToChild 对非法 OMML 降级为纯文本不抛错', async () => {
  const fs = require('fs');
  const path = require('path');
  await withEditor({}, async (w, ed) => {
    w.eval(fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'docx.min.js'), 'utf8'));
    // stub Packer.toBlob：jsdom 里真实 toBlob 不 settle，这里只验 runToChild 容错
    w.DocxLib.Packer.toBlob = async () => ({ arrayBuffer: async () => new w.Uint8Array([1, 2, 3]).buffer });
    const builder = require(path.join(__dirname, '..', 'src', 'modules', 'docx-builder.js')).buildDocxFromStructure;
    const structure = [
      { type: 'paragraph', runs: [
        { omml: '<m:oMath><m:r><m:t>坏' }, // 非法 XML
        { text: '正常文字' },
      ] },
    ];
    const page = { pageWidth: 11906, pageHeight: 16838, marginTop: 1440, marginBottom: 1440, marginLeft: 1800, marginRight: 1800 };
    const blob = await builder(structure, page);
    const ab = await blob.arrayBuffer();
    assert.ok(ab.byteLength > 0, '含非法 OMML 的文档也应成功构建（不拖垮整篇）');
  });
});

// 回归（2026-09-26，用户报障「导出 Word 失败」）：builder 层最后防线。
// docx 的颜色字段只接受恰好 6 位 HEX，上游若漏出命名色（"RED"）/ rgba() / var()，
// new TextRun(...) 会直接抛 "Invalid hex value 'RED'. Expected 6 digit hex value" 并中止
// **整篇**导出。runToChild 必须丢弃非法颜色（与上面非法 OMML「降级不抛错」同一原则），
// 同时不能误伤合法 HEX —— 这里用真实 docx 打包 + 解 XML 验证两头都对。
test('docx-builder: runToChild 丢弃非法颜色不抛错，合法 HEX 仍写进 w:color', async () => {
  const ab = await buildDocxBuffer([{ type: 'paragraph', runs: [
    { text: '命名色', color: 'RED' },        // 旧行为：原样下传 → 抛错中止整篇
    { text: '半透明', color: 'rgba(1,2,3,0.5)' },
    { text: '变量', color: 'var(--x)' },
    { text: '合法', color: 'FF0000' },
  ] }]);
  assert.ok(ab.byteLength > 0, '含非法颜色的文档也应成功构建（不拖垮整篇）');
  const { xml } = unzipDocx(ab);
  assert.strictEqual((xml.match(/<w:color\b/g) || []).length, 1, '只有合法 HEX 的那个 run 应带颜色');
  assert.ok(xml.includes('w:val="FF0000"'), '合法 6 位 HEX 必须保留');
  for (const bad of ['RED', 'rgba(', 'var(--x', 'currentColor']) {
    assert.ok(!xml.includes(bad), '非法颜色不得进入 document.xml：' + bad);
  }
});

// 回归（2026-09-26）：对齐此前被【静默丢弃】—— AlignmentType 的属性名是大写、值是小写
//（AlignmentType.CENTER === 'center'），而 CSS 读回来就是小写（el.style.textAlign === 'center'），
// 所以 AlignmentType[node.align] 永远取到 undefined：独立公式的居中、text-align:center/right 的
// 段落在 Word 里全部变左对齐（document.xml 里连 <w:jc> 都没有）。同时验证空表格不再抛错。
test('docx-builder: CSS text-align 正确落到 w:jc；空表格不抛错不产出 tbl', async () => {
  const ab = await buildDocxBuffer([
    { type: 'paragraph', runs: [{ text: '居中' }], align: 'center' },
    { type: 'paragraph', runs: [{ text: '右对齐' }], align: 'right' },
    { type: 'paragraph', runs: [{ text: '两端' }], align: 'justify' },
    { type: 'paragraph', runs: [{ text: '无对齐' }] },
    { type: 'paragraph', runs: [{ text: '未知值' }], align: 'foo' },
    { type: 'table', rows: [] },                      // 空表格：此前整篇导出中止
    { type: 'table', rows: [{ cells: [] }] },          // 行内无单元格：同上
    { type: 'paragraph', runs: [{ text: '表格之后的正文' }] },
  ]);
  assert.ok(ab.byteLength > 0, '含空表格的文档也应成功构建（不拖垮整篇）');
  const { xml } = unzipDocx(ab);
  const jc = (xml.match(/<w:jc w:val="[^"]+"\/>/g) || []).map(s => s.replace(/.*w:val="([^"]+)".*/, '$1'));
  assert.deepStrictEqual(jc, ['center', 'right', 'both'],
    '【关键断言】三类 CSS 对齐各落一条 w:jc，且无对齐/未知值不得产出（此前全部丢失）');
  assert.ok(!xml.includes('<w:tbl>'), '空表格不应产出 <w:tbl>');
  assert.ok(xml.includes('表格之后的正文'), '空表格被跳过后，后续正文必须仍在（构建未中断）');
});

// 回归（2026-09-26）：builder 层图片最后防线。docx 的 ImageRun 只接受 png/jpg/gif/bmp
// （svg 还需 fallback 才能构造，未知类型会让 [Content_Types].xml 缺声明 → 整包 OPC 不合法）。
// 上游 export.js 已把 svg/webp 栅格化成 PNG，这里守住 Worker/上游漏传的情况：类型不在白名单
// 或字节为空就跳过该图，绝不中止整篇（与「非法 OMML 降级」「非法颜色丢弃」同一原则）。
// 另外宽高必须落成正整数：transformation 是必填项，undefined/NaN 会写进非法尺寸。
test('docx-builder: 非白名单图片格式/空字节被跳过，合法 png 仍嵌入且宽高为正整数', async () => {
  // 1×1 真 PNG：docx 会把字节原样放进 word/media
  const pngBytes = Array.from(Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==', 'base64'));
  // 非法节点用与合法图完全不同的字节：一旦漏进 zip，媒体文件名/扩展名会立刻暴露
  const junkBytes = [1, 2, 3, 4];
  const ab = await buildDocxBuffer([
    { type: 'paragraph', runs: [{ text: '图片之前的正文' }] },
    { type: 'image', imageType: 'svg', data: junkBytes, width: 20, height: 20, srcMime: 'image/svg+xml' }, // 漏栅格化
    { type: 'image', imageType: 'webp', data: junkBytes, width: 20, height: 20, srcMime: 'image/webp' },   // 漏栅格化
    { type: 'image', imageType: 'png', data: [], width: 20, height: 20 },                                  // 空字节
    { type: 'image', data: junkBytes, width: 20, height: 20 },                                             // 老结构漏传 imageType
    { type: 'image', imageType: 'png', data: pngBytes, width: 80, height: 40 },                            // 合法
    { type: 'image', imageType: 'png', data: pngBytes },                                                   // 宽高缺失 → 兜底
    { type: 'paragraph', runs: [{ text: '图片之后的正文' }] },
  ]);
  assert.ok(ab.byteLength > 0, '含非法图片节点的文档也应成功构建（不拖垮整篇）');
  const { zip, xml } = unzipDocx(ab);
  const drawings = xml.match(/<w:drawing\b/g) || [];
  assert.strictEqual(drawings.length, 2, '只有两张合法 png 应产出 drawing，其余四张必须被跳过');
  // 注意排除目录条目自身（zip.files 里含 'word/media/' 这个 dir）。docx 会按图片字节去重：
  // 两张同字节的 png 只落 1 个 media（实测），所以这里只要求"不多于落地图片数"。
  const media = Object.keys(zip.files).filter(f => f.startsWith('word/media/') && !zip.files[f].dir);
  assert.ok(media.length >= 1 && media.length <= 2,
    '只有落地的图片才应有媒体文件（被跳过的不得留残留）：' + media.join(','));
  for (const f of media) assert.ok(f.endsWith('.png'), '媒体文件应是 png：' + f);
  const extents = [...xml.matchAll(/<wp:extent cx="([^"]+)" cy="([^"]+)"/g)];
  assert.strictEqual(extents.length, 2, '每张落地的图都应有 extent');
  for (const [, cx, cy] of extents) {
    assert.ok(/^\d+$/.test(cx) && Number(cx) > 0 && /^\d+$/.test(cy) && Number(cy) > 0,
      `【关键断言】宽高必须落成正整数（transformation 必填，NaN/undefined 会写坏文档）：cx=${cx} cy=${cy}`);
  }
  assert.ok(xml.includes('图片之前的正文') && xml.includes('图片之后的正文'),
    '跳图不得中断构建，前后正文必须都在');
});

// 回归（2026-09-26）：Word 不认的内联图片格式（SVG/WebP/AVIF/ICO）在导出前栅格化成 PNG。
// 此前结构层把 svg/webp 的字节直接标成 png —— 字节与声明不符，Word 按 PNG 解码失败（坏图）。
// jsdom 没有 canvas、也不解码图片，这里桩掉 Image 与 canvas，只验证控制流：
// 转换必须发生在 exportWord 主流程内（产物 imageType/srcMime 都变成 png）、原生支持格式不动、
// 转换失败只丢该图并进告警通道（不中断导出）。
test('exportWord: 非 png/jpg/gif/bmp 的内联图栅格化成 PNG 后交给构建器', async () => {
  const warnings = [];
  const drawSizes = [];
  let captured = null;
  await withEditor({ invokeImpl: (cmd) => {
    if (cmd === 'plugin:dialog|save') return '/tmp/out.docx';
    if (cmd === 'write_binary_file') return undefined;
    return null;
  } }, async (w, ed) => {
    ed._confirmDocxExport = async () => true;
    ed.showConfirmDialog = async () => true;
    ed._buildDocxBuffer = async (structure) => { captured = structure; return new Uint8Array([0x50, 0x4b]).buffer; };
    // 捕获告警通道（jsdom 里 showToast 无意义，改为记录）
    ed._flushExportImageWarnings = function () {
      if (Array.isArray(this._lastExportImageWarnings)) warnings.push(...this._lastExportImageWarnings);
      this._lastExportImageWarnings = null;
    };
    // 桩 Image：同步触发 onload（jsdom 不解码图片）；ICO 那张故意失败 → 走丢弃分支
    const BAD_SRC = 'data:image/vnd.microsoft.icon;base64,AAABAA';
    w.Image = class {
      set src(v) {
        this._v = v;
        if (v === BAD_SRC) { if (this.onerror) this.onerror(new Error('decode failed')); }
        else if (this.onload) this.onload({});
      }
      get src() { return this._v; }
      get naturalWidth() { return 40; }
      get naturalHeight() { return 20; }
    };
    // 桩 canvas：只记录取样尺寸
    w.HTMLCanvasElement.prototype.getContext = function () {
      return { drawImage: (el, x, y, cw, ch) => drawSizes.push([cw, ch]) };
    };
    w.HTMLCanvasElement.prototype.toDataURL = function () { return 'data:image/png;base64,R0FUSVpFRA=='; };

    ed.activeTab.filePath = '/docs/note.md';
    ed.activeTab.name = '我的笔记';
    w.editor.preview.innerHTML =
      '<p><img src="data:image/svg+xml;base64,PHN2Zy8+" width="60" height="30"></p>' +
      '<p><img src="data:image/webp;base64,UklGRg==" width="60" height="30"></p>' +
      '<p><img src="data:image/png;base64,iVBORw0KGgo=" width="60" height="30"></p>' +
      '<p><img src="' + BAD_SRC + '" width="60" height="30"></p>';
    // 导出尺寸来自预览侧采集的 dataset（jsdom 里 naturalWidth 恒为 0），固定成 60×30 让断言可预测
    Array.from(w.editor.preview.querySelectorAll('img')).forEach((el) => {
      el.dataset.natW = '60'; el.dataset.natH = '30'; el.dataset.dispW = '60'; el.dataset.dispH = '30';
    });

    await ed.exportWord();
  });

  const collectImages = (nodes) => {
    const out = [];
    const walk = (list) => {
      for (const n of list || []) {
        if (!n || typeof n !== 'object') continue;
        if (n.type === 'image') out.push(n);
        if (Array.isArray(n.children)) walk(n.children);
        if (Array.isArray(n.runs)) walk(n.runs);
        if (Array.isArray(n.rows)) n.rows.forEach((r) => walk(r && r.cells));
      }
    };
    walk(nodes);
    return out;
  };
  const imgs = collectImages(captured);
  assert.strictEqual(imgs.length, 3, '栅格化失败的那张应被丢弃，其余三张保留：' + JSON.stringify(imgs.map(i => i.srcMime)));
  assert.strictEqual(imgs[0].imageType, 'png', 'svg 应被栅格化成 png 交给构建器');
  assert.strictEqual(imgs[0].srcMime, 'image/png', 'srcMime 应反映转换后的格式');
  assert.strictEqual(imgs[1].imageType, 'png', 'webp 应被栅格化成 png');
  assert.strictEqual(imgs[2].imageType, 'png', '原生 png 不动');
  assert.deepStrictEqual(drawSizes, [[120, 60], [120, 60]], '应按显示尺寸 ×2 取样（60×30 → 120×60）');
  assert.strictEqual(warnings.length, 1, '栅格化失败必须进告警通道（此前该阶段告警会被静默丢弃）');
  assert.ok(warnings[0].includes('image/vnd.microsoft.icon'), '告警要指明是哪个格式：' + warnings[0]);
});

// 回归（2026-09-09）：Word/WPS 的东亚排版会把「<w:br/> 软换行结尾的行」按两端对齐强行
// 拉伸到整行宽（即便全文无一处 w:jc，实测仍拉伸），导出的代码块每行被扯出巨大空隙。
// 修复：代码块每行一个独立段落 + 显式左对齐——段落末行永不被拉伸；相邻段落
// 边框/底纹/缩进一致时 Word 自动把边框合并为一个整体框，视觉仍是一个连续代码块。
test('docx-builder: 代码块每行独立段落（无软换行 <w:br/>，显式左对齐）', async () => {
  const lines = ['let left = 0;', '', '  return -1;'];
  const ab = await buildDocxBuffer([{ type: 'code', lines }]);
  assert.ok(ab.byteLength > 0, '代码块文档应成功构建');
  const { xml } = unzipDocx(ab);
  assert.strictEqual((xml.match(/<w:br/g) || []).length, 0, '不得含 <w:br/> 软换行（软换行行会被两端对齐拉伸）');
  assert.strictEqual((xml.match(/F6F5F4/g) || []).length, lines.length, '每行一个灰底段落');
  assert.strictEqual((xml.match(/<w:jc w:val="left"/g) || []).length, lines.length, '每段显式左对齐');
  assert.ok(xml.includes('<w:spacing w:after="0" w:before="120"'), '首段保留 before 外边距');
  assert.ok(xml.includes('<w:spacing w:after="120" w:before="0"'), '末段保留 after 外边距');
});

// 回归（2026-09-14 用户导出验证）：表格单元格 / 列表项里的公式此前被 textContent 拼成
// "α\alphaα" 纯文本；现在这两处与段落一样走 runs，公式落成 OMML，上标/换行/缩进也保留。
test('docx-builder: 单元格与列表项内的公式落成 OMML（不再退化成纯文本）', async () => {
  const omml = '<m:oMath xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"><m:r><m:t>x</m:t></m:r></m:oMath>';
  const structure = [
    { type: 'table', rows: [{ cells: [{ paragraphs: [{ text: '', runs: [{ omml }, { text: ' 尾' }] }], width: 0 }] }] },
    { type: 'bullet', ordered: true, marker: '1.', level: 0, runs: [{ text: '质能方程 ' }, { omml }, { text: ' ↩' }] },
    { type: 'paragraph', runs: [{ text: '[1]', superScript: true }], indent: { left: 720 } },
    { type: 'paragraph', runs: [{ text: 'a' }, { break: true }, { text: 'b' }] },
  ];
  const ab = await buildDocxBuffer(structure, { lineHeight: 1.7 });
  const { xml } = unzipDocx(ab);
  assert.strictEqual((xml.match(/<m:oMath/g) || []).length, 2, '单元格与列表项里的公式都应落成 OMML');
  assert.ok(xml.includes('质能方程'), '列表项文本保留');
  assert.ok(xml.includes('↩'), '列表项尾部文本保留');
  assert.ok(/superscript/.test(xml), '上标（脚注引用）应保留');
  assert.ok(xml.includes('w:left="720"'), '缩进段落（定义列表 dd）应保留');
  assert.ok(/<w:br/.test(xml), 'break run 应落成 <w:br/>');
});

// 回归：docx 主路径 = 主线程直构建（window.buildDocxFromStructure，docx 库常驻加载）。
// 曾走 Web Worker，真机上 Worker 不可用时整条链静默降级成 altChunk（公式变纯文本）。
test('_buildDocxBuffer: 主线程直构建，把页面设置与结构传给 builder', async () => {
  await withEditor({}, async (w, ed) => {
    let mainCalled = false;
    w.DocxLib = {}; // 让 _ensureDocxLibLoaded 秒回，不触发动态加载
    w.buildDocxFromStructure = async (structure, page) => {
      mainCalled = true;
      assert.ok(Array.isArray(structure), '应把 structure 传给 builder');
      assert.strictEqual(page.pageWidth, 11906, '应把页面设置传给 builder');
      return { arrayBuffer: async () => new Uint8Array([0x50, 0x4b, 0x03, 0x04]).buffer };
    };

    const ab = await ed._buildDocxBuffer([{ type: 'paragraph', runs: [{ text: 'hi' }] }], {
      pageWidth: 11906, pageHeight: 16838, marginTop: 1440, marginBottom: 1440, marginLeft: 1800, marginRight: 1800,
    });

    assert.strictEqual(mainCalled, true, '应调用主线程 builder');
    assert.strictEqual(new Uint8Array(ab).length, 4, '应返回构建出的字节');
  });
});

// 回归：页面没刷新导致 window.DocxLib 缺失时，_ensureDocxLibLoaded 按需补加载，
// 不再因缺库整条降级成 altChunk（公式变文字）。
test('_buildDocxBuffer: DocxLib 缺失时按需加载后再构建', async () => {
  await withEditor({}, async (w, ed) => {
    // 模拟旧页面：DocxLib 未定义；_ensureDocxLibLoaded 用桩模拟加载完成
    ed._ensureDocxLibLoaded = async () => { w.DocxLib = {}; return true; };
    let mainCalled = false;
    w.buildDocxFromStructure = async () => { mainCalled = true; return { arrayBuffer: async () => new Uint8Array([0x50]).buffer }; };

    const ab = await ed._buildDocxBuffer([{ type: 'paragraph', runs: [{ text: 'hi' }] }], {
      pageWidth: 1, pageHeight: 1, marginTop: 0, marginBottom: 0, marginLeft: 0, marginRight: 0,
    });

    assert.strictEqual(mainCalled, true, 'DocxLib 补加载后应继续构建');
    assert.strictEqual(new Uint8Array(ab).length, 1, '应返回构建字节');
  });
});

// 回归：Worker 路径会把图片字节 transfer 走（主线程侧 buffer 变 detached），若其失败，
// 主线程兜底必须先重建一份等价结构，否则会拿到空图片。未 transfer（如 Worker 不可用）则不必重建。
test('_buildDocxBuffer: Worker 已 transfer 图片且失败时，先重建结构再走主线程构建', async () => {
  await withEditor({}, async (w, ed) => {
    w.DocxLib = {};
    let rebuildCalled = 0;
    let builtWith = null;
    w.buildDocxFromStructure = async (structure) => {
      builtWith = structure;
      return { arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer };
    };
    ed._buildDocxInWorker = async (structure, page, state) => {
      if (state) state.transferred = true; // 模拟图片已被 transfer（主线程 buffer detached）
      throw new Error('worker fail');
    };
    const rebuilt = [{ type: 'paragraph', runs: [{ text: 'rebuilt' }] }];
    const original = [{ type: 'paragraph', runs: [{ text: 'original' }] }];
    const ab = await ed._buildDocxBuffer(original, {
      pageWidth: 1, pageHeight: 1, marginTop: 0, marginBottom: 0, marginLeft: 0, marginRight: 0,
    }, async () => { rebuildCalled++; return rebuilt; });
    assert.strictEqual(rebuildCalled, 1, '已 transfer 时应调用 rebuild 重建结构');
    assert.strictEqual(builtWith, rebuilt, '主线程构建应使用重建后的结构');
    assert.ok(new Uint8Array(ab).length > 0, '应返回构建字节');
  });
});

test('_buildDocxBuffer: Worker 未 transfer（不可用等）时，不重建、直接用原结构', async () => {
  await withEditor({}, async (w, ed) => {
    w.DocxLib = {};
    let rebuildCalled = 0;
    let builtWith = null;
    w.buildDocxFromStructure = async (structure) => {
      builtWith = structure;
      return { arrayBuffer: async () => new Uint8Array([1]).buffer };
    };
    ed._buildDocxInWorker = async () => { throw new Error('no worker'); }; // 不设 transferred
    const original = [{ type: 'paragraph', runs: [{ text: 'original' }] }];
    await ed._buildDocxBuffer(original, {
      pageWidth: 1, pageHeight: 1, marginTop: 0, marginBottom: 0, marginLeft: 0, marginRight: 0,
    }, async () => { rebuildCalled++; return [{ type: 'paragraph' }]; });
    assert.strictEqual(rebuildCalled, 0, '未 transfer 不应重建');
    assert.strictEqual(builtWith, original, '应直接用原结构构建');
  });
});

// 回归（2026-09-14 用户第二次验证 docx）：
// ① 【修复被静默跳过】mml2omml 不转义 <m:t> 文本，公式含裸 <（i<j、0<i<n）时 OMML 非良构，
//    DOMParser 报 parsererror → 旧实现直接 return，空槽规则/错位上提全部失效、虚线框残留。
//    现在两个 repair 解析失败时会先做「最小可解析化」（只转义 m:t 里不像 OMML 标签的裸 < 与游离 &）再试。
// ② 【phantom 实体化成 X】mhchem（\ce{}）用 <mphantom>X</mphantom> 当零宽基座（预览里不可见），
//    mml2omml 不认识 mphantom → 把 X 当可见文本 → Word 里出现 CHX₃COOH / X²³⁵X₉₂U。
//    现在转换前剥离 phantom，视觉等价。
// ③ 【占位残渣抢占原子】剥离后残留的「整块全空」上下标结构会抢走后继原子、把 sPre 槽位克隆成空
//    （核素记号 \ce{^{235}_{92}U}）→ 规则 R5 直接删除这类空结构。
test('_structureMathmlToOmml: 裸 < 公式不再被跳过 + mhchem 不再出现 X（2026-09-14 用户验证）', async () => {
  const fs = require('fs');
  const path = require('path');
  await withEditor({}, async (w, ed) => {
    w.eval(fs.readFileSync(path.join(__dirname, '..', 'node_modules', 'katex', 'dist', 'katex.js'), 'utf8'));
    w.eval(fs.readFileSync(path.join(__dirname, '..', 'node_modules', 'katex', 'dist', 'contrib', 'mhchem.js'), 'utf8'));
    w.eval(fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'mathml2omml.min.js'), 'utf8'));

    const ARG_SLOTS = {
      e: ['nary', 'rad', 'func', 'acc', 'bar', 'groupChr', 'limLow', 'limUpp', 'sSub', 'sSup', 'sSubSup', 'sPre', 'd', 'box', 'borderBox', 'f'],
      num: ['f'], den: ['f'],
      sub: ['nary', 'limLow', 'limUpp', 'sSub', 'sSubSup', 'sPre'],
      sup: ['nary', 'limUpp', 'sSup', 'sSubSup', 'sPre'],
      lim: ['limLow', 'limUpp'], fName: ['func'],
    };
    const tagOf = (el) => String(el.localName || el.nodeName).replace(/^.*:/, '');
    const all = (node, acc) => { acc = acc || []; for (const c of Array.from(node.children || [])) { all(c, acc); acc.push(c); } return acc; };
    const textOf = (root) => {
      let s = '';
      (function walk(n) { for (const c of Array.from(n.childNodes || [])) { if (c.nodeType === 1) { if (tagOf(c) === 't') s += c.textContent || ''; else walk(c); } } })(root);
      return s;
    };
    const emptySlotCount = (root) => {
      let n = 0;
      for (const el of all(root)) {
        const parents = ARG_SLOTS[tagOf(el)];
        if (!parents) continue;
        const p = el.parentNode && el.parentNode.nodeType === 1 ? tagOf(el.parentNode) : '';
        if (parents.indexOf(p) !== -1 && el.children.length === 0 && String(el.textContent || '').trim() === '') n++;
      }
      return n;
    };
    const orphanCount = (root) => {
      let n = 0;
      for (const el of all(root)) {
        const t = tagOf(el);
        if (['sub', 'sup', 'lim', 'e', 'num', 'den'].indexOf(t) !== -1
            && el.parentNode && el.parentNode.nodeType === 1 && tagOf(el.parentNode) === 'oMath') n++;
      }
      return n;
    };
    const build = (tex) => {
      const holder = w.document.createElement('div');
      w.katex.render(tex, holder, { displayMode: true, throwOnError: false });
      assert.ok(!holder.querySelector('.katex-error'), tex + '：KaTeX 应能渲染（用于取真实 MathML）');
      const struct = [{ type: 'paragraph', runs: [{ mathml: holder.querySelector('.katex-mathml math').outerHTML }] }];
      assert.strictEqual(ed._structureMathmlToOmml(struct), true, tex + '：应返回 true');
      const run = struct[0].runs[0];
      assert.ok(typeof run.omml === 'string', tex + '：应转成 OMML（而非降级源码），实际 ' + JSON.stringify(run).slice(0, 120));
      const doc = new w.DOMParser().parseFromString(run.omml, 'application/xml');
      assert.strictEqual(doc.getElementsByTagName('parsererror').length, 0, tex + '：应良构');
      assert.strictEqual(emptySlotCount(doc.documentElement), 0, tex + '：不应残留空必需槽（Word 虚线框）');
      assert.strictEqual(orphanCount(doc.documentElement), 0, tex + '：不应有孤儿槽（违反 OMML schema）');
      return { run, doc, text: textOf(doc.documentElement) };
    };

    // ① 裸 < + 空必需槽：修复必须真正生效（旧实现会因解析失败被静默跳过，残留空槽）
    const lt = build('\\int_{D} f\\,dx \\quad 0<i<n');
    assert.ok(lt.run.omml.includes('&lt;'), '含 < 的公式仍应把文本转义为 &lt;');
    assert.ok(lt.text.indexOf('<') !== -1, '文本应保留（DOM 文本里是真实 <），实际 ' + lt.text);
    // ①b 错位结构（\overset 被 mml2omml 包进 m:t）+ 裸 <：两处修复都要生效
    const ov = build('\\overset{i<j}{\\mathrm{X}}');
    assert.ok(!ov.run.omml.includes('&lt;m:'), '不得把 OMML 标记转义进文本（m:t 内应是纯文本），实际 ' + ov.run.omml.slice(0, 200));
    assert.ok(ov.text.indexOf('<') !== -1, 'overset 内的 < 文本应保留');

    // R9 终归化：mhchem 下标基（mphantom 被剥离后变空）转 m:sPre 后，缺失的 sup 槽会补一个
    // 不可见占位符 U+2061（函数应用，零宽，Word 不渲染、不改版式）—— 这正是消除 Word 虚线框所需的，
    // 与 HTML/PDF（KaTeX 本就无框）保持一致。比对文本前先剥离 U+2061，避免不可见占位符干扰断言。
    const norm = (s) => String(s).replace(/\u2061/g, '');
    // ② mhchem 零宽基座不得实体化成 X
    const water = build('\\ce{H2O}');
    assert.ok(norm(water.text).indexOf('H2O') !== -1, '\\ce{H2O} 文本应为 H2O，实际 ' + water.text);
    const acid = build('\\ce{CH3COOH}');
    assert.ok(norm(acid.text).indexOf('CH3COOH') !== -1, '\\ce{CH3COOH} 文本应为 CH3COOH，实际 ' + acid.text);
    assert.ok(!/X/.test(acid.text), '不得出现 phantom 实体化出来的 X，实际 ' + acid.text);
    const cx = build('\\ce{[Co(NH3)6]^{3+} + 3en -> [Co(en)3]^{3+} + 6NH3}');
    assert.ok(!/X/.test(cx.text), '配位化学式不得出现 X，实际 ' + cx.text);
    assert.ok(norm(cx.text).indexOf('NH3') !== -1, '下标应保留（NH3），实际 ' + cx.text);

    // ③ 核素前缀上下标：占位残渣删除 + 收敛为 m:sPre，且不残留空槽
    const nuc = build('\\ce{^{235}_{92}U}');
    assert.ok(norm(nuc.text).indexOf('92235U') !== -1, '核素记号文本应为 92235U，实际 ' + nuc.text);
    assert.strictEqual(nuc.doc.getElementsByTagName('m:sPre').length, 1, '应产出 1 个 m:sPre（前缀上下标）');
    assert.ok(!/X/.test(nuc.text), '核素记号不得出现 X，实际 ' + nuc.text);
  });
});

// 回归（2026-09-14 用户第二次复核仍有虚框）：
// mml2omml 会产出「run + 裸文本」混排内容，如 <m:e><m:r><m:t>f</m:t></m:r>dx</m:e>；
// docx 库的 ImportedXmlComponent 导入这种元素时会把带 run 的部分丢掉、只留裸文本，
// 于是 Word 里该槽视觉为空 → 又画虚线占位框（∫_D f dx、∑ 等 29 条公式命中）。
// 修复：R6 把「非 <m:t> 的裸文本」包成正规 run。
// 顺带修掉一个致命细节：ommlVisuallyEmpty(null) 返回 true，旧 R1 会在 nary 已无 sup/sub 时
// 执行 el.removeChild(null) 抛 TypeError → 整条公式的修复被兜底 catch 吞掉（12 条漏修）。
test('_structureMathmlToOmml: 槽内裸文本被包成 run（Word 虚线框）', async () => {
  await withEditor({}, async (w, ed) => {
    const M = 'http://schemas.openxmlformats.org/officeDocument/2006/math';
    // 桩直接给「混排」OMML：nary 的 e 里既有 run 又有裸文本 dx，且 sup 为空
    w.MathML2OMML = {
      mml2omml: () => '<m:oMath xmlns:m="' + M + '">'
        + '<m:nary><m:naryPr><m:chr m:val="∫"/></m:naryPr>'
        + '<m:sub><m:r><m:t>D</m:t></m:r></m:sub><m:sup/>'
        + '<m:e><m:r><m:t xml:space="preserve">f</m:t></m:r>dx</m:e>'
        + '</m:nary></m:oMath>',
    };
    const struct = [{ type: 'paragraph', runs: [{ mathml: '<math><semantics><mrow><mi>x</mi></mrow><annotation encoding="application/x-tex">x</annotation></semantics></math>' }] }];
    assert.strictEqual(ed._structureMathmlToOmml(struct), true, '应返回 true');
    const run = struct[0].runs[0];
    assert.ok(typeof run.omml === 'string', '应转成 OMML（而非降级源码）');
    const omml = run.omml;
    assert.ok(/<m:r><m:t[^>]*>dx<\/m:t><\/m:r>/.test(omml), '裸文本 dx 应被包成 <m:r><m:t>，实际 ' + omml.slice(0, 240));
    assert.ok(omml.indexOf('>dx<') === -1 || omml.indexOf('<m:t') !== -1, '不得残留裸文本');
    const doc = new w.DOMParser().parseFromString(omml, 'application/xml');
    assert.strictEqual(doc.getElementsByTagName('parsererror').length, 0, '应良构');
    // 每个槽/元素下都不应有直接文本节点（文字必须在 m:t 里）
    const tagOf = (el) => String(el.localName || el.nodeName).replace(/^.*:/, '');
    const stray = [];
    (function walk(n) {
      for (const c of Array.from(n.childNodes || [])) {
        if (c.nodeType === 3 && String(c.nodeValue || '').trim() && tagOf(n) !== 't') stray.push(tagOf(n) + '>' + c.nodeValue);
        else if (c.nodeType === 1) walk(c);
      }
    })(doc.documentElement);
    assert.deepStrictEqual(stray, [], '不应有非 <m:t> 的裸文本，实际 ' + JSON.stringify(stray));
    // 空 sup 必须被删掉（这条同时验证 R1 不再因 removeChild(null) 抛错而被兜底吞掉）
    assert.strictEqual(doc.getElementsByTagName('m:sup').length, 0, '空 sup 应被删除');
  });
});

// 回归（2026-09-14 用户复核）：
// ① 公式里出现字面 "&nbsp;"：\text{} 的空格被 mml2omml 写成 &nbsp;，解析路径把 DOM 文本
//    变成字面量 "&nbsp;"，序列化后是 &amp;nbsp;，只匹配 &nbsp; 会漏 → Word 直接显示 "&nbsp;"。
// ② 矩阵空单元格（aligned/cases 类公式）、③ 空 run（mml2omml 对空 <mrow/> 的产出）→ Word 画虚线框。
test('_structureMathmlToOmml: &nbsp; 还原为空格 + 矩阵空格子/空 run 清理', async () => {
  await withEditor({}, async (w, ed) => {
    const M = 'http://schemas.openxmlformats.org/officeDocument/2006/math';
    const mathml = '<math><semantics><mrow><mi>x</mi></mrow><annotation encoding="application/x-tex">x</annotation></semantics></math>';
    const runOnce = (ommlStub) => {
      w.MathML2OMML = { mml2omml: () => ommlStub };
      const struct = [{ type: 'paragraph', runs: [{ mathml }] }];
      assert.strictEqual(ed._structureMathmlToOmml(struct), true, '应返回 true');
      return struct[0].runs[0].omml;
    };
    // ① 字面 &nbsp;（docx 里以 &amp;nbsp; 形态存在）
    const o1 = runOnce('<m:oMath xmlns:m="' + M + '">'
      + '<m:r><m:t xml:space="preserve">其中&amp;nbsp;</m:t></m:r>'
      + '<m:r><m:t xml:space="preserve">xi</m:t></m:r>'
      + '<m:r><m:t xml:space="preserve">&amp;nbsp;是陈根</m:t></m:r></m:oMath>');
    assert.ok(!/nbsp/i.test(o1), '不得残留字面 nbsp，实际 ' + o1);
    assert.ok(o1.indexOf('其中') !== -1 && o1.indexOf('是陈根') !== -1, '文字应保留，实际 ' + o1);
    // ② 矩阵空格子 → 填不可见字符（U+2061），版式不变但不画框
    const o2 = runOnce('<m:oMath xmlns:m="' + M + '"><m:m><m:mr>'
      + '<m:e/><m:e><m:r><m:t>x</m:t></m:r></m:e>'
      + '</m:mr></m:m></m:oMath>');
    assert.ok(/\u2061/.test(o2), '矩阵空格子应填不可见字符，实际 ' + o2);
    assert.ok(!/<m:e\/>/.test(o2), '不应再有空单元格，实际 ' + o2);
    // ③ 空 run → 删除
    const o3 = runOnce('<m:oMath xmlns:m="' + M + '">'
      + '<m:r><m:t/></m:r><m:r><m:t>a</m:t></m:r><m:r><m:rPr><m:nor/></m:rPr><m:t/></m:r></m:oMath>');
    assert.strictEqual((o3.match(/<m:r>/g) || []).length, 1, '空 run 应被删除，实际 ' + o3);
    for (const o of [o1, o2, o3]) {
      const d = new w.DOMParser().parseFromString(o, 'application/xml');
      assert.strictEqual(d.getElementsByTagName('parsererror').length, 0, '应良构: ' + o);
    }
  });
});

// 回归：导出主路径用的「异步分块版」与既有「同步版」必须产出完全一致
//（分块只是每 20 个公式让出主线程一帧，绝不改变转换结果）。
test('_structureMathmlToOmmlChunked: 分块版与同步版产出逐位一致（>20 公式触发分块）', async () => {
  const fs = require('fs');
  const path = require('path');
  await withEditor({}, async (w, ed) => {
    w.eval(fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'mathml2omml.min.js'), 'utf8'));
    const mk = (n) => ({
      type: 'paragraph',
      runs: [
        { text: '公式 ' + n + ' ' },
        {
          mathml: '<math xmlns="http://www.w3.org/1998/Math/MathML"><semantics><mrow><msup><mi>x</mi><mn>'
            + n + '</mn></msup></mrow><annotation encoding="application/x-tex">x^' + n + '</annotation></semantics></math>',
        },
      ],
    });
    const build = () => { const a = []; for (let i = 0; i < 25; i++) a.push(mk(i + 1)); return a; };
    const syncStruct = build();
    const chunkStruct = build();
    const syncOk = ed._structureMathmlToOmml(syncStruct);
    const chunkOk = await ed._structureMathmlToOmmlChunked(chunkStruct);
    assert.strictEqual(syncOk, true, '有库且有公式应返回 true');
    assert.strictEqual(chunkOk, syncOk, '分块版与同步版返回布尔应一致');
    assert.deepStrictEqual(chunkStruct, syncStruct, '分块版与同步版产出应逐位一致');
    assert.ok(chunkStruct[0].runs.some((r) => typeof r.omml === 'string' && r.omml.includes('oMath')), '应产出 OMML run');
  });
});

// 回归（2026-09-26，P1–P4 的**终点**断言）：「中间结构对、终点丢」是导出类需求最常见的失败形态 ——
// 结构层用例（export-docx-nodes）只能证明中间结构对，这里用真实 docx 打包 + 解
// word/document.xml 与 rels，证明这四条能力真的写进了 OOXML：
//    P1 列表层级 → w:ilvl    P2 超链接 → w:hyperlink + TargetMode="External"
//    P3 表头     → w:tblHeader + 底色 + 加粗 + w:jc    P4 下划线 → w:u
test('docx-builder: P1–P4 在 OOXML 里落地（ilvl / hyperlink+External / tblHeader / w:u）', async () => {
  const ab = await buildDocxBuffer([
    // P1：第 3 层（level=2）此前整项丢失。两条路径都要能看出层级：
    // 无序项走 docx 的 bullet level（→ w:ilvl），有序项走「序号 + 悬挂缩进」
    //（docx 的 bullet 没有内置编号样式，builder 用 marker + indent 呈现，见其注释）。
    { type: 'bullet', ordered: false, marker: '', level: 0, runs: [{ text: '父项' }] },
    { type: 'bullet', ordered: false, marker: '', level: 2, runs: [{ text: '孙项' }] },
    { type: 'bullet', ordered: true, marker: '1.', level: 2, runs: [{ text: '有序孙项' }] },
    // P2 + P4：链接与下划线
    { type: 'paragraph', runs: [
      { text: '官网', link: 'https://example.com/a?b=1' },
      { text: '下划线', underline: true },
    ] },
    // P3：表头行 + 三列对齐
    { type: 'table', rows: [
      { header: true, cells: [
        { paragraphs: [{ text: '左', runs: [{ text: '左' }] }], width: 0, header: true, align: 'left' },
        { paragraphs: [{ text: '中', runs: [{ text: '中' }] }], width: 0, header: true, align: 'center' },
      ] },
      { header: false, cells: [
        { paragraphs: [{ text: '右' }], width: 0, align: 'right' },
        { paragraphs: [{ text: '默认' }], width: 0 },
      ] },
    ] },
  ]);
  assert.ok(ab.byteLength > 0, '应成功构建 docx');
  const { zip, xml } = unzipDocx(ab);
  const relFile = zip.file('word/_rels/document.xml.rels');
  const rels = relFile ? relFile.asText() : '';
  // P1：无序项的层级必须写进 w:ilvl（此前第 3 层整项丢失，只剩前两层）
  assert.ok(/<w:ilvl w:val="2"\/>/.test(xml), '【P1】第 3 层无序项应写 <w:ilvl w:val="2"/>');
  assert.ok(xml.includes('孙项'), '【P1】第 3 层文字必须在 document.xml 里');
  // P1：有序项的层级靠缩进量表达（360 + level*360），否则第 3 层在 Word 里与第 1 层齐平
  assert.ok(xml.includes('有序孙项'), '【P1】第 3 层有序项文字必须在');
  const inds = xml.match(/<w:ind\b[^>]*\/>/g) || [];
  assert.ok(inds.some((s) => s.includes('w:left="1080"') && s.includes('w:hanging="240"')),
    '【P1】第 3 层有序项应带 1080 悬挂缩进，实际 w:ind=' + JSON.stringify(inds));
  // P2：正文是可点链接，且关系表必须是 External（漏了 TargetMode，Word 打开就是死链）
  assert.ok(/<w:hyperlink\b/.test(xml), '【P2】应产出 <w:hyperlink>（此前退化成纯文本）');
  assert.ok(xml.includes('官网'), '【P2】链接文字不得丢');
  assert.ok(/TargetMode="External"/.test(rels), '【P2】超链接关系必须是 External');
  assert.ok(rels.includes('https://example.com/a?b=1'), '【P2】href 应原样进关系表');
  // P3：表头行标记（跨页重复）+ 底色 + 加粗，三列对齐各落一条 w:jc
  assert.ok(/<w:tblHeader\b/.test(xml), '【P3】表头行应带 <w:tblHeader/>');
  assert.ok(/<w:shd\b[^>]*w:fill="EEEDEC"/.test(xml), '【P3】表头单元格应有表头底色 EEEDEC');
  assert.ok(/<w:b\/>/.test(xml), '【P3】表头文字应加粗');
  const jcs = (xml.match(/<w:jc w:val="[^"]+"\/>/g) || []).map((s) => s.replace(/.*w:val="([^"]+)".*/, '$1'));
  for (const want of ['left', 'center', 'right']) {
    assert.ok(jcs.includes(want), '【P3】列对齐缺 ' + want + '，实际 w:jc=' + JSON.stringify(jcs));
  }
  // P4：下划线必须落成 w:u（此前只留文字、丢了下划线）
  assert.ok(/<w:u\b[^>]*w:val="single"/.test(xml), '【P4】下划线应落成 <w:u w:val="single"/>');
});

// 回归（2026-09-26 审计，内容丢失级）：折叠提示框（`???` / `???+` / `::: details`）的正文此前
// 在 Word 里**整块消失** —— 结构层只产出标题，正文文字都搜不到。这里走完整链路
// HTML → domToDocxStructure → docx-builder → 解 word/document.xml，证明正文真的进了 OOXML
//（结构层用例只能证明中间对，终点断言才是用户看到的结果）。
test('docx-builder: 折叠提示框的正文落进 OOXML（审计 2026-09-26）', async () => {
  const fs = require('fs');
  const { JSDOM } = require('jsdom');
  // 渲染层真实产出：容器是 <details class="alert …">（不是 div），标题在 <summary>，
  // 正文在 div.alert-content —— 与 unified-admonitions.js 的 buildAdmonitionHTML 一致。
  const html = '<div id="root">'
    + '<details class="alert alert-note admonition admonition-note" data-admonition="note">'
    + '<summary class="alert-title admonition-summary">Note</summary>'
    + '<div class="alert-content admonition-content"><p>折叠正文内容</p></div></details></div>';
  const dom = new JSDOM(html, { runScripts: 'dangerously' });
  const w = dom.window;
  w.eval(fs.readFileSync(path.join(__dirname, '..', 'src', 'modules', 'export-docx.js'), 'utf8'));
  const structure = w.domToDocxStructure(w.document.getElementById('root'));
  assert.ok(JSON.stringify(structure).includes('折叠正文内容'),
    '结构层就不该丢正文，实际：' + JSON.stringify(structure));
  const { xml } = unzipDocx(await buildDocxBuffer(structure));
  assert.ok(xml.includes('折叠正文内容'),
    '【关键断言】折叠提示框正文必须在 document.xml 里（此前整块丢失，只剩标题）');
  assert.ok(xml.includes('Note'), '标题也不得丢');
});
