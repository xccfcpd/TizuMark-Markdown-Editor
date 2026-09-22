// 导出时必须展开折叠块 —— 回归测试
//
// 背景：修 `???` 折叠语义后，预览里的 <details> 会保持收起（此前一律被强制展开）。
// 而四路导出（HTML / Word / PNG / PDF）都是**克隆预览**再产出结果，其中 PDF 走系统打印、
// PNG 走 html2canvas，二者遵循真实布局 —— 收起即隐藏，隐藏内容会直接从导出结果里消失。
//
// 修复：`export.js` 的四个克隆点收敛为唯一入口 `_clonePreviewForExport()`，
// 克隆后统一展开所有 `<details>`，使四路导出结果与修复前**完全一致**。
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');
const { withEditor } = require('./helpers/app-env.cjs');

const EXPORT_PATH = path.join(__dirname, '..', 'src', 'modules', 'export.js');

// 预览里一个收起的折叠块（`??? note` 的渲染结果）+ 一个本就未展开的原生 <details>
const PREVIEW_HTML =
  '<p>正文</p>' +
  '<details class="alert admonition" data-admonition="note">' +
  '<summary>收起块</summary><div class="admonition-content">折叠正文内容</div></details>' +
  '<details><summary>原生折叠</summary>原生内容</details>';

test('_clonePreviewForExport：克隆并展开所有折叠 <details>，且不改动原预览', async () => {
  await withEditor({}, async (w, ed) => {
    w.editor.preview.innerHTML = PREVIEW_HTML;

    const clone = ed._clonePreviewForExport();

    const originals = w.editor.preview.querySelectorAll('details');
    assert.equal(originals.length, 2, '原预览应有 2 个 details');
    for (const d of originals) {
      assert.equal(d.open, false, '原预览的折叠状态不应被克隆过程改动');
    }

    const cloned = clone.querySelectorAll('details');
    assert.equal(cloned.length, 2, '克隆应保留 2 个 details');
    for (const d of cloned) {
      assert.equal(d.open, true, '克隆中的 details 应全部展开');
    }
    assert.ok(clone.textContent.includes('折叠正文内容'), '折叠正文应随克隆保留');
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
    assert.match(captured, /<details[^>]*\sopen/, '打印帧里的 details 必须带 open');
    assert.ok(captured.includes('折叠正文内容'), '折叠正文应出现在打印帧里');
  });
});

test('exportHTML：导出的 HTML 中折叠块已展开（与修复前行为一致，且内容不丢）', async () => {
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
    assert.match(captured.content, /<details[^>]*\sopen/, '导出 HTML 里的 details 必须带 open');
    assert.ok(captured.content.includes('折叠正文内容'), '折叠正文不应在导出 HTML 中丢失');
  });
});

test('四路导出共用 _clonePreviewForExport（防止将来新增导出路径漏展开）', () => {
  const src = fs.readFileSync(EXPORT_PATH, 'utf8');
  const calls = (src.match(/this\._clonePreviewForExport\(\)/g) || []).length;
  assert.equal(calls, 4, 'HTML / Word / PNG / PDF 四路导出都应经统一入口，当前 ' + calls + ' 处');

  const raw = (src.match(/this\.preview\.cloneNode\(/g) || []).length;
  assert.equal(raw, 1, '裸 cloneNode 只应出现在 _clonePreviewForExport 内，当前 ' + raw + ' 处');
});
