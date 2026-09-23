// 纯函数测试：导出前的「是否需要全量渲染」判定（零依赖，node 直接跑）。
//
// 背景（2026-09-23 用户报障）：大文档预览只渲染**滑动窗口**（约 1200 行，见
// PreviewController.render），而四个导出路径都基于 preview.cloneNode(true)
// → 直接导出只得到窗口那一段，导出的 HTML / PDF / Word 内容残缺。
// 修法：导出前先判定是否需要全量渲染（本文件），再临时强制全量渲染一次。
const test = require('node:test');
const assert = require('node:assert/strict');
const PW = require('../src/modules/preview-window.js');

test('shouldRenderFullForExport: 已在窗口模式 → 必须全量', () => {
  assert.equal(PW.shouldRenderFullForExport({ chars: 100, lines: 10, hasWindow: true }), true);
});

test('shouldRenderFullForExport: 超行数 / 超字符 → 需全量（0.5 MB 多行文档走行数分支）', () => {
  // 用户场景：约 0.5 MB 但行数多（>5000 行）→ 必须全量，否则只导出约 1200 行
  assert.equal(PW.shouldRenderFullForExport({ chars: 500 * 1024, lines: 6000 }), true);
  // 字符超 4 MB（即使行数不多）
  assert.equal(PW.shouldRenderFullForExport({ chars: 5 * 1024 * 1024, lines: 100 }), true);
  // 阈值由调用方注入（避免与预览常量漂移）
  assert.equal(PW.shouldRenderFullForExport({ chars: 2000, lines: 10, maxChars: 1000 }), true);
  assert.equal(PW.shouldRenderFullForExport({ chars: 10, lines: 200, maxLines: 100 }), true);
});

test('shouldRenderFullForExport: 小文档直通（零开销），阈值边界不算超', () => {
  assert.equal(PW.shouldRenderFullForExport({ chars: 100 * 1024, lines: 4000 }), false);
  // 恰好等于阈值不算超 —— 与 PreviewController 的 `>` 语义保持一致
  assert.equal(PW.shouldRenderFullForExport({ chars: 5000, lines: 5000, maxChars: 5000, maxLines: 5000 }), false);
  // 缺省参数不得抛错
  assert.equal(PW.shouldRenderFullForExport(), false);
  assert.equal(PW.shouldRenderFullForExport({}), false);
});

test('PreviewWindow 导出：纯函数仍在（防止误删既有 API）', () => {
  assert.equal(typeof PW.isBlockStart, 'function');
  assert.equal(typeof PW.computePreviewWindow, 'function');
});
