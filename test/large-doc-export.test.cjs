// 大文档导出回归（jsdom）：导出必须基于**全文**，而不是预览的 ~1200 行滑动窗口。
//
// 背景（2026-09-23 用户报障）：大文档预览只渲染滑动窗口（约 1200 行，见
// PreviewController.render 的 isLarge 分支），而四个导出路径（HTML / Word / PNG / PDF）
// 都基于 preview.cloneNode(true) → 直接导出只得到窗口那一段，产物残缺。
// 修法：export.js 的 _preparePreviewForExport 先临时强制全量渲染，_clonePreviewForExport
// 克隆后立即恢复窗口渲染（克隆是脱离文档的副本，恢复预览不影响后续处理）。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildEnv, cleanup, waitForEditor } = require('./helpers/app-env.cjs');
const { loadUnifiedRenderer } = require('./helpers/load-bundle.cjs');

function largeDoc(lines = 6000) {
  const arr = [];
  for (let i = 0; i < lines; i++) {
    arr.push(i % 10 === 0 ? `# 标题 ${i}` : `正文段落内容行 ${i}`);
  }
  return arr.join('\n');
}

test('大文档导出：克隆包含文档末尾（窗口模式不可能有），导出后恢复窗口渲染', async () => {
  const { w } = await buildEnv();
  const ed = await waitForEditor(w);
  loadUnifiedRenderer(w);
  try {
    ed.cm.setValue(largeDoc());
    await ed.updatePreview();
    assert.ok(ed.previewWindow, '前置条件：大文档应进入窗口模式');
    const windowedLen = ed.preview.innerHTML.length;
    assert.ok(windowedLen > 0, '窗口渲染应有内容');

    // 确认框在测试里没有真人可点：直接放行
    ed.showConfirmDialog = async () => true;

    const clone = await ed._clonePreviewForExport();
    assert.ok(clone, '应返回克隆（非取消）');
    assert.ok(
      clone.innerHTML.includes('正文段落内容行 5999'),
      '克隆必须包含文档末尾 —— 窗口模式只渲染约 1200 行，不可能有末尾内容'
    );
    assert.ok(clone.innerHTML.length > windowedLen, '克隆应明显大于窗口渲染结果');

    // 导出后必须回到窗口渲染：不能把用户界面留在"全量渲染"状态
    assert.equal(ed._previewForceFull, false, '强制全量标志必须复位');
    assert.ok(ed.previewWindow, '导出后应恢复窗口模式');
  } finally {
    cleanup(w);
  }
});

test('大文档导出：用户在确认框取消 → 返回 null，且不进入全量渲染', async () => {
  const { w } = await buildEnv();
  const ed = await waitForEditor(w);
  loadUnifiedRenderer(w);
  try {
    ed.cm.setValue(largeDoc());
    await ed.updatePreview();
    assert.ok(ed.previewWindow, '前置条件：大文档应进入窗口模式');

    ed.showConfirmDialog = async () => false;

    const clone = await ed._clonePreviewForExport();
    assert.equal(clone, null, '取消应返回 null（四个导出入口据此直接结束）');
    assert.equal(ed._previewForceFull, false, '取消时不得开启全量渲染');
    assert.ok(ed.previewWindow, '取消后仍是窗口模式');
  } finally {
    cleanup(w);
  }
});

test('小文档导出：直通（不弹确认框、不进全量渲染）', async () => {
  const { w } = await buildEnv();
  const ed = await waitForEditor(w);
  loadUnifiedRenderer(w);
  try {
    ed.cm.setValue('# 小文档\n\n只有几行内容。');
    await ed.updatePreview();
    assert.equal(ed.previewWindow, null, '小文档不进入窗口模式');

    let asked = 0;
    ed.showConfirmDialog = async () => { asked += 1; return true; };

    const clone = await ed._clonePreviewForExport();
    assert.ok(clone, '小文档应正常返回克隆');
    assert.equal(asked, 0, '小文档不得弹「大文档导出」确认框');
    assert.equal(ed._previewForceFull, false, '小文档不做全量渲染开关');
    assert.ok(clone.innerHTML.includes('只有几行内容'), '克隆内容应正常');
  } finally {
    cleanup(w);
  }
});
