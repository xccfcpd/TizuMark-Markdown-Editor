// 标签页切换滚动位置回归测试：
// 编辑模式（分屏）+ 滚动同步开启（默认）时，切换不同标签页后编辑器与预览应各自恢复到
// 该 tab 记忆的滚动位置，不应被滚动同步互相重定位（表现为「切换后页面跳到别处」）。
// 使用真实渲染（eval unified-bundle.js 到 window.UnifiedRenderer），走真实 switchTab 链路。
const test = require('node:test');
const assert = require('node:assert');
const { buildEnv, cleanup, delay, waitForEditor } = require('./helpers/app-env.cjs');
const { loadUnifiedRenderer } = require('./helpers/load-bundle.cjs');

// 产物加载统一走 helpers/load-bundle.cjs（P0-0e）：缺失时给可操作指引而非 ENOENT 堆栈。

async function makeEditor() {
  const { w } = await buildEnv();
  loadUnifiedRenderer(w);
  const ed = await waitForEditor(w);
  // harness 初始化会打开「Untitled1 + 使用说明.md」两个 tab 且 activeTabIndex=1；
  // 本测试需要 [tab0] + activeTabIndex=0 的干净前提（switchTab 切到新 push 的 tab1），
  // 否则 switchTab(1) 会因 index===activeTabIndex 直接 return，滚动恢复断言全部失效。
  ed.tabs.length = 1;
  ed.activeTabIndex = 0;
  ed.activeTab = ed.tabs[0];
  return { w, ed };
}

test('tab-scroll: 切换标签后预览滚动位置恢复到目标 tab 记忆值（分屏 + 滚动同步开启）', async () => {
  const { w, ed } = await makeEditor();
  try {
    // 默认开启滚动同步，复现「分屏 + 滚动同步」场景
    ed.settings.scrollSync = true;

    // jsdom 无布局，桩出预览可滚动范围，使 maxScroll > 0 以便断言 clamp
    Object.defineProperty(ed.preview, 'scrollHeight', { configurable: true, value: 1000 });
    Object.defineProperty(ed.preview, 'clientHeight', { configurable: true, value: 500 });

    // 桩编辑器滚动测量，让 switchTab 保存/恢复走可控值（jsdom 下 getScrollInfo 恒为 0）
    ed.cm.getScrollInfo = () => ({ top: 50, left: 0, height: 1000, clientHeight: 500 });
    let lastScrollTo = null;
    ed.cm.scrollTo = (l, t) => { lastScrollTo = { l, t }; };

    // 初始 tab0：模拟已滚动到预览 200 处
    ed.cm.setValue('# Tab A\n\n正文内容 A'.repeat(20));
    ed.preview.scrollTop = 200;

    // 构造第二个 tab（无 filePath，避免触发文件加载）
    const tab1 = {
      name: 'tabB',
      content: '# Tab B\n\n正文内容 B'.repeat(20),
      filePath: null,
      _loaded: true,
      cursorPos: { line: 0, ch: 0 },
      scrollPos: { top: 10, left: 0 },     // 切换回去后编辑器应恢复到这里
      previewScrollTop: 100,               // 切换过去后预览应恢复到这里
    };
    ed.tabs.push(tab1);

    // 切到 tab1
    await ed.switchTab(1);
    assert.strictEqual(ed.preview.scrollTop, 100,
      '分屏 + 滚动同步开启时，切换到 tab1 预览应恢复到其记忆的 100（修复前会被编辑器同步覆盖）');
    assert.ok(lastScrollTo && lastScrollTo.t === 10,
      '编辑器应恢复到 tab1 记忆的滚动位置 top=10');

    // 切回 tab0：应恢复到 tab0 记忆的预览 200 / 编辑器 50
    await ed.switchTab(0);
    assert.strictEqual(ed.preview.scrollTop, 200,
      '切回 tab0 后预览应恢复到其记忆的 200，且 tab0 的预览位置未被切换过程破坏');
    assert.ok(lastScrollTo && lastScrollTo.t === 50,
      '编辑器应恢复到 tab0 记忆的滚动位置 top=50');

    // 恢复滚动同步标志，交还给用户
    await delay(10);
    assert.strictEqual(ed._canScroll.editor, true, '_restoreSwitchScroll 后编辑器滚动同步应恢复');
    assert.strictEqual(ed._canScroll.preview, true, '_restoreSwitchScroll 后预览滚动同步应恢复');
  } finally {
    cleanup(w);
  }
});

test('tab-scroll: 关闭滚动同步时同样恢复预览滚动位置', async () => {
  const { w, ed } = await makeEditor();
  try {
    ed.settings.scrollSync = false;
    Object.defineProperty(ed.preview, 'scrollHeight', { configurable: true, value: 1000 });
    Object.defineProperty(ed.preview, 'clientHeight', { configurable: true, value: 500 });
    ed.cm.getScrollInfo = () => ({ top: 30, left: 0, height: 1000, clientHeight: 500 });
    ed.cm.scrollTo = () => {};

    ed.cm.setValue('# A\n'.repeat(30));
    ed.preview.scrollTop = 150;

    const tab1 = {
      name: 'b', content: '# B\n'.repeat(30), filePath: null, _loaded: true,
      cursorPos: { line: 0, ch: 0 }, scrollPos: { top: 5, left: 0 }, previewScrollTop: 80,
    };
    ed.tabs.push(tab1);

    await ed.switchTab(1);
    assert.strictEqual(ed.preview.scrollTop, 80, '关闭滚动同步也应恢复预览到 80');
    await ed.switchTab(0);
    assert.strictEqual(ed.preview.scrollTop, 150, '切回后预览应恢复 150');
  } finally {
    cleanup(w);
  }
});

// 滚动同步位置表缓存的失效契约（2026-09-25 优化）：仅当「预览重渲染置脏」或「行数变化」
// 时重算；否则滚动 tick 复用缓存。这里用哨兵值直接钉住守卫，防止后续改动把它悄悄破坏。
test('scroll-cache: 未置脏且行数未变时复用位置表；置脏或行数变化时重算', async () => {
  const { w, ed } = await makeEditor();
  try {
    ed.cm.setValue('a\nb\nc');
    const sentinelE = ['SE'];
    const sentinelP = ['SP'];
    ed._editorElementList = sentinelE;
    ed._previewElementList = sentinelP;
    ed._positionLineCount = ed.cm.lineCount();
    ed._positionCacheDirty = false;

    // 未置脏 + 行数未变 → 早退复用（jsdom 预览无 data-source-line，若重算会把列表置 null）
    ed._computedPosition();
    assert.strictEqual(ed._editorElementList, sentinelE, '未置脏且行数不变时应复用缓存（不重算）');
    assert.strictEqual(ed._previewElementList, sentinelP, '预览位置表同样应复用');

    // 置脏 → 必须重算（哨兵被替换）
    ed._positionCacheDirty = true;
    ed._computedPosition();
    assert.notStrictEqual(ed._editorElementList, sentinelE, '置脏后应重算位置表');

    // 行数变化 → 必须重算（即使未置脏）
    ed._editorElementList = sentinelE;
    ed._previewElementList = sentinelP;
    ed._positionLineCount = ed.cm.lineCount();
    ed._positionCacheDirty = false;
    ed.cm.setValue('a\nb\nc\nd\ne');
    ed._computedPosition();
    assert.notStrictEqual(ed._editorElementList, sentinelE, '行数变化后应重算位置表');
  } finally {
    cleanup(w);
  }
});
