// 外部文件变更检测测试：file_meta 刷新 / 队列 / 横幅 / 重载 / 忽略
// 使用 withEditor 串行化，避免 node:test 并发子测试互相踩踏共享的 global.window/document。
const test = require('node:test');
const assert = require('node:assert');
const { withEditor } = require('./helpers/app-env.cjs');

function createBanner(w) {
  // index.html 已内置 #external-change-banner，必须复用（自建元素不会被 getElementById 返回）
  const existing = w.document.getElementById('external-change-banner');
  if (existing) return existing;
  const b = w.document.createElement('div');
  b.id = 'external-change-banner';
  for (const c of ['ecb-name', 'ecb-msg', 'ecb-reload', 'ecb-ignore', 'ecb-reload-all', 'ecb-ignore-all']) {
    const e = w.document.createElement('span');
    e.className = c;
    b.appendChild(e);
  }
  w.document.body.appendChild(b);
  return b;
}

test('filewatcher: refreshFileMeta 更新 tab.fileMeta', async () => withEditor(
  { captureInitErr: true, invokeImpl: async (cmd) => (cmd === 'file_meta' ? { mtime: 123, size: 456 } : undefined) },
  async (w, ed) => {
    const tab = { filePath: 'C:/a.md' };
    await ed.refreshFileMeta(tab);
    assert.deepStrictEqual(tab.fileMeta, { mtime: 123, size: 456 });
    const tab2 = {};
    await ed.refreshFileMeta(tab2);
    assert.strictEqual(tab2.fileMeta, null, '无 filePath 应为 null');
  }
));

test('filewatcher: enqueueExternalChange 入队并显示变更横幅', async () => withEditor(
  { captureInitErr: true },
  async (w, ed) => {
    ed.updateTabDisplay = () => {};
    const banner = createBanner(w);
    const tab = { filePath: 'C:/a.md', name: 'a.md' };
    ed.tabs = [tab]; ed.activeTabIndex = 0;
    ed.enqueueExternalChange(tab);
    assert.ok(tab.pendingExternalChange, '应标记待处理变更');
    assert.ok(ed._externalQueue.includes(tab), '应入队');
    assert.ok(banner.classList.contains('visible'), '横幅应显示');
    assert.strictEqual(banner.querySelector('.ecb-name').textContent, 'a.md');
  }
));

test('filewatcher: dismissExternalChange(false) 出队并清除标记', async () => withEditor(
  { captureInitErr: true },
  async (w, ed) => {
    ed.updateTabDisplay = () => {};
    ed.updateExternalChangeBanner = () => {};
    const tab = { filePath: 'C:/a.md' };
    ed.enqueueExternalChange(tab);
    await ed.dismissExternalChange(tab, false);
    assert.ok(!ed._externalQueue.includes(tab));
    assert.strictEqual(tab.pendingExternalChange, false);
  }
));

test('filewatcher: reloadAllExternalChanges 重载并清空队列', async () => withEditor(
  { captureInitErr: true },
  async (w, ed) => {
    ed.updateTabDisplay = () => {};
    ed.updateExternalChangeBanner = () => {};
    ed.reloadTabFromDisk = async () => {};
    const t1 = { filePath: 'C:/a.md' };
    const t2 = { filePath: 'C:/b.md' };
    ed.enqueueExternalChange(t1); ed.enqueueExternalChange(t2);
    await ed.reloadAllExternalChanges();
    assert.strictEqual(ed._externalQueue.length, 0, '队列应清空');
  }
));

test('filewatcher: ignoreAllExternalChanges 忽略全部并清空队列', async () => withEditor(
  { captureInitErr: true },
  async (w, ed) => {
    ed.updateTabDisplay = () => {};
    ed.updateExternalChangeBanner = () => {};
    ed.refreshFileMeta = async () => {};
    const t1 = { filePath: 'C:/a.md' };
    const t2 = { filePath: 'C:/b.md' };
    ed.enqueueExternalChange(t1); ed.enqueueExternalChange(t2);
    ed.ignoreAllExternalChanges();
    assert.strictEqual(ed._externalQueue.length, 0);
    assert.strictEqual(t1.pendingExternalChange, false);
    assert.strictEqual(t2.pendingExternalChange, false);
  }
));

test('filewatcher: refreshTabsMeta 优先批量 file_meta_batch；不支持时逐个兜底', async () => {
  // 情形一：后端支持批量 → 一次 IPC 取回全部
  await withEditor(
    { captureInitErr: true, invokeImpl: async (cmd, args) => {
      if (cmd === 'file_meta_batch') return (args.paths || []).map(() => ({ error: false, meta: { mtime: 1, size: 2 } }));
      if (cmd === 'file_meta') return { mtime: 9, size: 9 };
      return undefined;
    } },
    async (w, ed) => {
      const t1 = { filePath: 'C:/a.md' };
      const t2 = { filePath: 'C:/b.md' };
      await ed.refreshTabsMeta([t1, t2, {}]);
      assert.deepStrictEqual(t1.fileMeta, { mtime: 1, size: 2 }, '应来自批量结果');
      assert.deepStrictEqual(t2.fileMeta, { mtime: 1, size: 2 }, '应来自批量结果');
    }
  );
  // 情形二：不支持批量（桩未实现，返回 undefined）→ 逐个 file_meta 兜底
  await withEditor(
    { captureInitErr: true, invokeImpl: async (cmd) => (cmd === 'file_meta' ? { mtime: 7, size: 8 } : undefined) },
    async (w, ed) => {
      const t = { filePath: 'C:/c.md' };
      await ed.refreshTabsMeta([t]);
      assert.deepStrictEqual(t.fileMeta, { mtime: 7, size: 8 }, '批量不可用应逐个兜底');
    }
  );
});
