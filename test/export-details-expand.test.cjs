// 导出时的折叠块（`???`）处理 —— 回归测试
//
// 背景：预览里折叠块默认收起属于**交互语义**；而四路导出都是克隆预览再产出结果。
//   固定版式（PDF 走系统打印、PNG 走 html2canvas、Word）遵循真实布局 —— 收起即隐藏，
//   隐藏内容会直接从导出结果里消失，故必须展开；而 HTML 产物是**可交互网页**，
//   内容不会丢，收起只是「等读者点开」，故保留收起状态、不替读者预先展开。
//
// 规则：`_clonePreviewForExport()`（唯一克隆入口）
//   · 默认（expandDetails !== false）→ 展开所有 <details>：exportWord / exportImage / exportPDF
//   · { expandDetails: false }        → 保持实时预览所见状态：exportHTML
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');
const { withEditor } = require('./helpers/app-env.cjs');

const EXPORT_PATH = path.join(__dirname, '..', 'src', 'modules', 'export.js');

// 预览里：一个收起的折叠块（`??? note` 的渲染结果）+ 一个已被预览强制展开的原生 <details>
const PREVIEW_HTML =
  '<p>正文</p>' +
  '<details class="alert admonition" data-admonition="note">' +
  '<summary>收起块</summary><div class="admonition-content">折叠正文内容</div></details>' +
  '<details open=""><summary>原生折叠</summary>原生内容</details>';

test('_clonePreviewForExport：默认展开所有折叠 <details>，且不改动原预览', async () => {
  await withEditor({}, async (w, ed) => {
    w.editor.preview.innerHTML = PREVIEW_HTML;

    const clone = ed._clonePreviewForExport();

    // 原预览必须原样不动：收起的仍收起、已展开的仍展开
    // （fixture 里原生 <details> 带 open 属性，故不能笼统断言"全部 open === false"）
    assert.equal(
      w.editor.preview.querySelector('details[data-admonition]').open, false,
      '原预览中收起的 admonition 不应被克隆过程改动',
    );
    assert.equal(
      w.editor.preview.querySelector('details:not([data-admonition])').open, true,
      '原预览中已展开的原生 <details> 不应被克隆过程改动',
    );
    const cloned = clone.querySelectorAll('details');
    assert.equal(cloned.length, 2, '克隆应保留 2 个 details');
    for (const d of cloned) {
      assert.equal(d.open, true, '默认应展开克隆中的所有 details');
    }
    assert.ok(clone.textContent.includes('折叠正文内容'), '折叠正文应随克隆保留');
  });
});

test('_clonePreviewForExport({ expandDetails: false })：保持收起状态', async () => {
  await withEditor({}, async (w, ed) => {
    w.editor.preview.innerHTML = PREVIEW_HTML;

    const clone = ed._clonePreviewForExport({ expandDetails: false });

    const adm = clone.querySelector('details[data-admonition]');
    assert.ok(adm, '克隆应含 admonition 折叠块');
    assert.equal(adm.open, false, 'expandDetails:false 时不应展开折叠块');
    assert.ok(clone.textContent.includes('折叠正文内容'), '收起不等于丢内容，正文仍应在克隆里');
  });
});

test('exportPDF：交给打印帧的 HTML 中折叠块已展开（否则 PDF 丢内容）', async () => {
  await withEditor({}, async (w, ed) => {
    w.editor.preview.innerHTML = PREVIEW_HTML;
    // 只看「克隆 → 组装 HTML → 交给系统打印」这一段，其余重活全部桩掉
    ed.showConfirmDialog = async () => true;
    ed._snapshotEchartsForExport = async () => [];
    ed._inlineImagesForExport = async () => {};
    let captured = null;
    ed._exportViaSystemPrint = async (html) => { captured = html; };

    await ed.exportPDF();

    assert.ok(captured, 'exportPDF 应把 HTML 交给系统打印路径');
    const admTag = (captured.match(/<details[^>]*data-admonition[^>]*>/) || [])[0];
    assert.ok(admTag, '打印帧中应含 admonition 折叠块');
    assert.ok(/\bopen\b/.test(admTag), '固定版式导出必须展开折叠块，实际: ' + admTag);
    assert.ok(captured.includes('折叠正文内容'), '折叠正文应出现在打印帧里');
  });
});

test('exportHTML：保持 `???` 的收起状态，且内容不丢', async () => {
  const captured = {};
  await withEditor({
    invokeImpl: (cmd, args) => {
      if (cmd === 'plugin:dialog|save') return '/tmp/out.html';
      if (cmd === 'write_file') { captured.content = args.content; return undefined; }
      return null;
    },
  }, async (w, ed) => {
    ed.activeTab.filePath = '/docs/note.md';
    w.editor.preview.innerHTML = PREVIEW_HTML;

    await ed.exportHTML();

    assert.ok(captured.content, '应调用 write_file 写入 HTML');
    const html = captured.content;

    // admonition 折叠块：必须保持收起（这正是 `???` 的语义）
    const admTag = (html.match(/<details[^>]*data-admonition[^>]*>/) || [])[0];
    assert.ok(admTag, '导出 HTML 中应含 admonition 折叠块');
    assert.ok(!/\bopen\b/.test(admTag), 'admonition 折叠块应保持收起，实际: ' + admTag);

    // 原生 <details>：跟随实时预览状态（预览已强制展开 → 导出亦为展开），未被过度改动
    const nativeTag = (html.match(/<details(?![^>]*data-admonition)[^>]*>/) || [])[0];
    assert.ok(nativeTag, '导出 HTML 中应含原生 <details>');
    assert.ok(/\bopen\b/.test(nativeTag), '原生 <details> 应保持预览中的展开态，实际: ' + nativeTag);

    // 收起不等于丢内容：正文必须完整保留在 HTML 里，读者点击即可展开
    assert.ok(html.includes('折叠正文内容'), '折叠正文不应在导出 HTML 中丢失');
  });
});

test('四路导出共用 _clonePreviewForExport，且仅 HTML 关闭展开', () => {
  const src = fs.readFileSync(EXPORT_PATH, 'utf8');

  const calls = (src.match(/this\._clonePreviewForExport\(/g) || []).length;
  assert.equal(calls, 4, 'HTML / Word / PNG / PDF 四路导出都应经统一入口，当前 ' + calls + ' 处');

  const raw = (src.match(/this\.preview\.cloneNode\(/g) || []).length;
  assert.equal(raw, 1, '裸 cloneNode 只应出现在 _clonePreviewForExport 内，当前 ' + raw + ' 处');

  const flags = [...src.matchAll(/expandDetails:\s*false/g)];
  assert.equal(flags.length, 1, '只应有 HTML 导出关闭折叠块展开，当前 ' + flags.length + ' 处');
  const iHtml = src.indexOf('async exportHTML()');
  const iWord = src.indexOf('async exportWord()');
  assert.ok(iHtml > 0 && iWord > iHtml, '未能定位 exportHTML / exportWord 方法边界');
  assert.ok(
    flags[0].index > iHtml && flags[0].index < iWord,
    '关闭展开的必须是 exportHTML 路径（固定版式导出不能关）',
  );
});
