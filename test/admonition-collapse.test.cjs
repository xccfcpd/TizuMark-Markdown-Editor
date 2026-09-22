// 折叠型 admonition（??? / ???+）默认开合状态 —— 回归测试
//
// 背景：preview-controller 在渲染后有一行「强制展开所有未展开的 <details>」，
// 该行早于 admonition 存在（自 app.js 经 b24b227 搬迁而来），未考虑 ??? 语义，
// 会把 ??? （默认收起）与 ???+ （默认展开）拉平成「都展开」。
//
// 本测试锁定两件事：
//   ① 行为：渲染后 ??? 保持收起、???+ 保持展开，且折叠正文仍在 DOM 中（不丢内容）；
//   ② 实现：强制展开的选择器必须排除 [data-admonition]，同时**不得**误伤
//      Markdown 手写的原生 <details>（既有「渲染后展开」行为不回归）。
//   ② 做成源码级 + 选择器语义断言，避免依赖 jsdom 对原生 HTML block 的解析细节。
const fs = require('fs');
const path = require('path');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { buildEnv, cleanup, waitForEditor } = require('./helpers/app-env.cjs');
const { loadUnifiedRenderer } = require('./helpers/load-bundle.cjs');

const CONTROLLER_PATH = path.join(__dirname, '..', 'src', 'controllers', 'preview-controller.js');

test('??? 默认收起、???+ 默认展开（渲染后不被强制展开）', async () => {
  const { w } = await buildEnv();
  const ed = await waitForEditor(w);
  loadUnifiedRenderer(w);
  try {
    ed.cm.setValue([
      '# 折叠测试',
      '',
      '??? note "收起块"',
      '    折叠正文内容。',
      '',
      '???+ tip "展开块"',
      '    展开正文内容。',
      '',
    ].join('\n'));
    await ed.updatePreview();

    const preview = w.editor.preview;
    const details = preview.querySelectorAll('details.admonition');
    assert.equal(details.length, 2, '应渲染出 2 个折叠块，实际 ' + details.length);

    const collapsed = preview.querySelector('details.admonition:not([open])');
    assert.ok(collapsed, '??? 应渲染为收起的 <details>（当前被强制展开了）');
    assert.equal(collapsed.open, false, '??? 的 .open 应为 false');
    // 收起不等于丢内容：正文必须在 DOM 内，展开后立即可见
    assert.ok(collapsed.textContent.includes('折叠正文内容'), '??? 的正文仍应在 DOM 中');
    assert.ok(collapsed.querySelector('.admonition-content'), '??? 应含 admonition-content 容器');

    const opened = preview.querySelector('details.admonition[open]');
    assert.ok(opened, '???+ 应渲染为展开的 <details>');
    assert.equal(opened.open, true, '???+ 的 .open 应为 true');
    assert.ok(opened.textContent.includes('展开正文内容'), '???+ 的正文应可见');
  } finally {
    cleanup(w);
  }
});

test('强制展开选择器排除 admonition，且不误伤原生 <details>（源码级 + 语义）', () => {
  const src = fs.readFileSync(CONTROLLER_PATH, 'utf8');
  const m = src.match(/querySelectorAll\(\s*(['"])(details[^'"]*)\1\s*\)/);
  assert.ok(m, '未能定位 preview-controller 中强制展开 <details> 的选择器');
  const selector = m[2];
  assert.match(selector, /:not\(\[data-admonition\]\)/,
    '强制展开选择器必须排除 admonition，当前为：' + selector);

  // 用真实选择器语义验证：admonition 不收强制展开，原生 details 仍被强制展开
  const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>');
  const d = dom.window.document;
  const admClosed = d.createElement('details');
  admClosed.setAttribute('data-admonition', 'note');
  const admOpen = d.createElement('details');
  admOpen.setAttribute('data-admonition', 'note');
  admOpen.setAttribute('open', '');
  const nativeClosed = d.createElement('details');
  const nativeOpen = d.createElement('details');
  nativeOpen.setAttribute('open', '');

  assert.equal(admClosed.matches(selector), false, '收起的 admonition 不应被强制展开');
  assert.equal(admOpen.matches(selector), false, '已展开的 admonition 本就不在选择器内');
  assert.equal(nativeClosed.matches(selector), true, '原生 <details> 应保持既有强制展开行为');
  assert.equal(nativeOpen.matches(selector), false, '已展开的原生 <details> 不在选择器内');
});
