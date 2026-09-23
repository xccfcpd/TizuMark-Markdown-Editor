// 图表/图片查看器（lightbox）关闭路径回归（jsdom）：
// 用户报障「文件都关闭了，五线谱还会浮动到其他 md 的渲染界面之上」——
// 根因：灯箱挂在 document.body 上（position:fixed; z-index:9999），
//       而提示条上的 × 只 remove 了提示本身，**灯箱没关**；切标签/关标签也不收。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { buildEnv, cleanup, waitForEditor } = require('./helpers/app-env.cjs');
const SVG_NS = 'http://www.w3.org/2000/svg';

function makeSvg(w) {
  const svg = w.document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('width', '120');
  svg.setAttribute('height', '60');
  return svg;
}

test('灯箱的 × 真正关闭灯箱（历史 bug：只隐藏提示条，图仍浮在别的文档上）', async () => {
  const { w } = await buildEnv();
  const ed = await waitForEditor(w);
  try {
    ed.showLightbox(makeSvg(w), 'svg');
    const overlay = w.document.querySelector('.image-lightbox');
    assert.ok(overlay, '应创建灯箱覆盖层');
    assert.equal(w.document.body.style.overflow, 'hidden', '打开时应锁滚动');

    const btn = overlay.querySelector('.lightbox-hint-close');
    assert.ok(btn, '提示条上应有 × 按钮');
    btn.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));

    assert.equal(w.document.querySelector('.image-lightbox'), null, '点 × 必须关掉灯箱');
    assert.equal(w.document.body.style.overflow, '', '必须还原 body 滚动');
  } finally {
    cleanup(w);
  }
});

test('closeLightbox()：外部强制关闭可用，且句柄会清空（切换标签/关标签靠它）', async () => {
  const { w } = await buildEnv();
  const ed = await waitForEditor(w);
  try {
    ed.showLightbox(makeSvg(w), 'svg');
    assert.ok(w.document.querySelector('.image-lightbox'), '应创建灯箱');
    assert.equal(typeof ed._lightboxClose, 'function', '应登记外部关闭句柄');

    ed.closeLightbox();
    assert.equal(w.document.querySelector('.image-lightbox'), null, '强制关闭应生效');
    assert.equal(ed._lightboxClose, null, '关闭后句柄应清空');
    assert.equal(w.document.body.style.overflow, '', '必须还原 body 滚动');

    // 无灯箱时调用必须安全（切换标签会无条件调用它）
    ed.closeLightbox();
  } finally {
    cleanup(w);
  }
});

test('接点守卫：切换标签 / 关闭标签 / 切换视图模式都必须调用 closeLightbox', () => {
  // 灯箱是 body 上的固定层，不随预览重渲染消失 —— 这三处是"跨文档残留"的必经入口。
  const root = path.join(__dirname, '..', 'src', 'modules');
  const tabs = fs.readFileSync(path.join(root, 'tabs.js'), 'utf8');
  const theme = fs.readFileSync(path.join(root, 'theme.js'), 'utf8');
  assert.ok(/switchTab\(index\)[\s\S]{0,400}closeLightbox\(\)/.test(tabs), 'switchTab 应收掉灯箱');
  assert.ok(/closeTab\(index\)[\s\S]{0,400}closeLightbox\(\)/.test(tabs), 'closeTab 应收掉灯箱');
  assert.ok(/closeLightbox\(\)[\s\S]{0,200}this\.viewMode = mode;/.test(theme), 'setViewMode 应收掉灯箱');
});
