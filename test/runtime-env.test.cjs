// runtime.js（宿主能力探测 + 诊断）回归测试
//
// 为什么这里是【行为测试】而不是源码正则断言：本模块的价值恰恰在于「不同宿主下**运行结果**不同」
//（有布局/无布局、有 rAF/无 rAF）。正则只能锁住写法、锁不住语义 —— test/code-block-scroll.test.cjs
// 那类静态契约在实现改成等价写法后会误报（2026-09-26 实测过一次）。凡语义可用行为覆盖的，
// 就不再对源码文本下断言。
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { JSDOM } = require('jsdom');

const MOD = path.join(__dirname, '..', 'src', 'modules', 'runtime.js');

test('纯 node 可 require，顶层不触碰 document/window（harness 装载安全）', () => {
  assert.strictEqual(typeof document, 'undefined', '前提：本文件在纯 node 下运行');
  assert.strictEqual(typeof window, 'undefined', '前提：无全局 window');
  const RuntimeEnv = require(MOD);
  assert.strictEqual(typeof RuntimeEnv.hasLayout, 'function');
  assert.strictEqual(RuntimeEnv.hasLayout(), false, '无 document → 判定为无布局能力');
  assert.strictEqual(RuntimeEnv.isVisibleInLayout(null), false, '空元素视为不可见');
});

test('jsdom（无真实布局）：hasLayout=false，且元素一律视为可见', () => {
  const dom = new JSDOM('<!DOCTYPE html><html><body><div id="pv"></div></body></html>');
  const { window } = dom;
  const RuntimeEnv = require(MOD);
  const el = window.document.getElementById('pv');

  assert.strictEqual(RuntimeEnv.hasLayout(window.document), false, 'jsdom 的 documentElement 宽度恒为 0');
  assert.strictEqual(el.offsetParent, null, '前提：jsdom 里 offsetParent 恒为 null');
  // 关键回归：此处若返回 false，状态栏「预览字数」在 jsdom 下将永不更新（word-count 变红）。
  assert.strictEqual(
    RuntimeEnv.isVisibleInLayout(el), true,
    '无布局能力的宿主不得把元素判为隐藏（否则功能会静默失效）',
  );
  dom.window.close();
});

test('有布局能力的宿主：按 offsetParent 判定可见性（与浏览器语义一致）', () => {
  const RuntimeEnv = require(MOD);
  const doc = { documentElement: { getBoundingClientRect: () => ({ width: 800 }) } };
  assert.strictEqual(RuntimeEnv.hasLayout(doc), true);
  assert.strictEqual(RuntimeEnv.isVisibleInLayout({ ownerDocument: doc, offsetParent: {} }), true);
  assert.strictEqual(RuntimeEnv.isVisibleInLayout({ ownerDocument: doc, offsetParent: null }), false);
});

test('hasLayout：documentElement 不可用时降级为 false，不抛错', () => {
  const RuntimeEnv = require(MOD);
  assert.strictEqual(RuntimeEnv.hasLayout({}), false, '无 documentElement');
  assert.strictEqual(RuntimeEnv.hasLayout({ documentElement: {} }), false, '无 getBoundingClientRect');
  assert.strictEqual(
    RuntimeEnv.hasLayout({ documentElement: { getBoundingClientRect: () => { throw new Error('boom'); } } }),
    false,
    '量取尺寸抛错时应降级，不得把异常抛给调用方',
  );
});

test('whenPainted：无 rAF 宿主也必须 resolve（不得永久挂起）', async () => {
  assert.strictEqual(typeof requestAnimationFrame, 'undefined', '前提：纯 node 无 rAF');
  const RuntimeEnv = require(MOD);
  const t0 = Date.now();
  await RuntimeEnv.whenPainted();
  assert.ok(Date.now() - t0 >= 1, '应至少让出一次事件循环（原实现靠 rAF，缺失时会永久 pending）');
});

test('warnOnce：同标签只告警一次，不同标签各自一次（不静默，也不刷屏）', () => {
  const RuntimeEnv = require(MOD);
  const calls = [];
  const orig = console.warn;
  console.warn = (...args) => { calls.push(args); };
  try {
    RuntimeEnv.warnOnce('t:same', new Error('first'));
    RuntimeEnv.warnOnce('t:same', new Error('second'));
    RuntimeEnv.warnOnce('t:other', new Error('third'));
  } finally {
    console.warn = orig;
  }
  assert.strictEqual(calls.length, 2, '同标签应去重为一次，不同标签各自输出一次');
  assert.match(String(calls[0][0]), /t:same/);
  assert.match(String(calls[1][0]), /t:other/);
  assert.strictEqual(calls[0][1].message, 'first', '保留首次的错误对象作为唯一线索');
});
