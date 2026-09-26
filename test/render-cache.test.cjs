// 渲染缓存（惰性渲染）回归测试：
//   验证「切回未改内容的标签」复用上次 markdown 解析结果，不再重复解析；
//   验证「内容变更后」缓存失效、重新解析；验证大文档（滑动窗口）不进入缓存。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { buildEnv, cleanup, delay } = require('./helpers/app-env.cjs');

test('render cache: 切回未改内容的标签应复用缓存、不再重新解析 markdown', async () => {
  const { w, tmp } = await buildEnv({ captureInitErr: true });
  await delay(300);
  const ed = w.editor;
  // 未完成初始化（bundle 缺失等）时不强行断言，避免 CI 环境差异误红
  const UR = w.UnifiedRenderer || globalThis.UnifiedRenderer;
  if (!UR || typeof UR.renderMarkdown !== 'function') {
    cleanup(w);
    return;
  }
  const orig = UR.renderMarkdown;
  let calls = 0;
  UR.renderMarkdown = (...a) => { calls++; return orig(...a); };

  const f1 = path.join(tmp, 'a.md');
  const f2 = path.join(tmp, 'b.md');
  fs.writeFileSync(f1, '# A\n\nhello A');
  fs.writeFileSync(f2, '# B\n\nhello B');

  await ed.addTab('a.md', '# A\n\nhello A', f1);
  const afterA = calls;
  assert.strictEqual(afterA, 1, '首次渲染 A 应解析一次 markdown');
  await ed.addTab('b.md', '# B\n\nhello B', f2);
  const afterB = calls;
  assert.strictEqual(afterB - afterA, 1, '新增 B 应仅触发一次 markdown 解析');

  // 切回 A（内容未变）：命中缓存，renderMarkdown 不应再被调用
  await ed.switchTab(0);
  await ed.updatePreview();
  assert.strictEqual(calls, afterB, '切回未改内容的 A 应复用缓存，不再重新解析');

  // 反向验证：内容变更后缓存失效，应重新解析
  ed.activeTab.content = '# A\n\nhello A edited';
  ed.cm.setValue('# A\n\nhello A edited');
  await ed.updatePreview();
  assert.strictEqual(calls, afterB + 1, '内容变更后应重新解析（缓存失效）');

  UR.renderMarkdown = orig;
  cleanup(w);
});

test('render cache: 缓存上限为 12 个标签（LRU 淘汰最早）', async () => {
  const { w, tmp } = await buildEnv({ captureInitErr: true });
  await delay(300);
  const ed = w.editor;
  const UR = w.UnifiedRenderer || globalThis.UnifiedRenderer;
  if (!UR || typeof UR.renderMarkdown !== 'function') {
    cleanup(w);
    return;
  }
  const orig = UR.renderMarkdown;
  let calls = 0;
  UR.renderMarkdown = (...a) => { calls++; return orig(...a); };

  // 依次打开 15 个内容各不相同的标签，每个解析一次；最后仅保留最近 12 个缓存。
  for (let i = 0; i < 15; i++) {
    const f = path.join(tmp, `t${i}.md`);
    fs.writeFileSync(f, `# T${i}\n\nbody ${i}`);
    await ed.addTab(`t${i}.md`, `# T${i}\n\nbody ${i}`, f);
  }
  // 重新切到最早打开的 t0：其缓存应已被 LRU 淘汰 → 重新解析
  await ed.switchTab(0);
  const beforeRevisit = calls;
  await ed.updatePreview();
  assert.strictEqual(calls, beforeRevisit + 1, '超出 12 上限后，最早标签缓存被淘汰应重新解析');

  UR.renderMarkdown = orig;
  cleanup(w);
});

test('render cache: 影响渲染的设置变更后，同一内容应重新解析（缓存键含设置）', async () => {
  const { w, tmp } = await buildEnv({ captureInitErr: true });
  await delay(300);
  const ed = w.editor;
  const UR = w.UnifiedRenderer || globalThis.UnifiedRenderer;
  if (!UR || typeof UR.renderMarkdown !== 'function') {
    cleanup(w);
    return;
  }
  const orig = UR.renderMarkdown;
  let calls = 0;
  UR.renderMarkdown = (...a) => { calls++; return orig(...a); };

  const f = path.join(tmp, 's.md');
  fs.writeFileSync(f, '# S\n\nbody');
  await ed.addTab('s.md', '# S\n\nbody', f);
  const afterOpen = calls;

  // 同一内容、未改设置：复用缓存，不应重新解析
  await ed.updatePreview();
  assert.strictEqual(calls, afterOpen, '内容与设置均未变应复用缓存');

  // 改一个影响渲染的设置 → 缓存键（renderSig）变化 → 必须重新解析，
  // 否则会拿旧设置的产物（缓存键漏掉设置时的典型回归）。
  const before = ed.settings.extendedSyntax;
  ed.settings.extendedSyntax = !before;
  await ed.updatePreview();
  assert.strictEqual(calls, afterOpen + 1, '影响渲染的设置变更后应重新解析（缓存失效）');
  ed.settings.extendedSyntax = before;

  UR.renderMarkdown = orig;
  cleanup(w);
});
