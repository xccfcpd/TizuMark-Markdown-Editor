// Tauri 集成路径测试：drag-drop 文件拖放 / file-open 二次实例 / EULA / 窗口控制 /
// 更新检查 / exportHTML / 图片粘贴（assets 与 base64 两种模式）
const test = require('node:test');
const assert = require('node:assert');
const { buildEnv, cleanup, delay, waitForEditor } = require('./helpers/app-env.cjs');

async function makeEnv(invokeImpl) {
  const { w, tauriListeners } = await buildEnv({ captureInitErr: true, invokeImpl });
  const ed = await waitForEditor(w);
  return { w, ed, listeners: tauriListeners };
}

function fire(listeners, name, payload) {
  const cbs = listeners[name] || [];
  return Promise.all(cbs.map((cb) => cb({ payload })));
}

test('tauri: drag-drop 拖入文件打开新标签', async () => {
  const { w, ed, listeners } = await makeEnv(async (cmd, args) => {
    if (cmd === 'read_file') return '# 拖入的文档';
    if (cmd === 'get_cli_args') return [];
    if (cmd === 'app_data_dir') return 'C:/tmp/tizumark-data';
    return undefined;
  });
  try {
    assert.ok(listeners['tauri://drag-drop'], '应注册 tauri://drag-drop 监听');
    const before = ed.tabs.length;
    await fire(listeners, 'tauri://drag-drop', { paths: ['C:/t/dnd.md'] });
    await delay(50);
    assert.strictEqual(ed.tabs.length, before + 1, '应新增标签');
    const tab = ed.tabs.find((t) => t.filePath === 'C:/t/dnd.md');
    assert.ok(tab, '标签路径应为拖入文件');
    assert.strictEqual(tab.content, '# 拖入的文档');
  } finally { cleanup(w); }
});

test('tauri: drag-enter/leave 切换拖放遮罩', async () => {
  const { w, ed, listeners } = await makeEnv();
  try {
    const app = w.document.querySelector('.app') || w.document.getElementById('app');
    const overlay = w.document.getElementById('drag-overlay');
    assert.ok(overlay, '应有拖放遮罩元素');
    await fire(listeners, 'tauri://drag-over', { paths: ['C:/x.md'] });
    assert.ok(!overlay.classList.contains('hidden'), '拖入时遮罩应显示');
    await fire(listeners, 'tauri://drag-leave', {});
    assert.ok(overlay.classList.contains('hidden'), '拖离时遮罩应隐藏');
  } finally { cleanup(w); }
});

test('tauri: file-open 事件（二次实例传参）打开文件并跳过 - 开头参数', async () => {
  const reads = [];
  const { w, ed, listeners } = await makeEnv(async (cmd, args) => {
    if (cmd === 'read_file') { reads.push(args.path); return '内容'; }
    if (cmd === 'get_cli_args') return [];
    if (cmd === 'app_data_dir') return 'C:/tmp/tizumark-data';
    return undefined;
  });
  try {
    assert.ok(listeners['file-open'], '应注册 file-open 监听');
    ed.applyViewMode = () => {};
    await fire(listeners, 'file-open', ['-flag', 'C:/t/second.md']);
    await delay(50);
    assert.ok(!reads.includes('-flag'), '- 开头参数应跳过');
    assert.ok(ed.tabs.some((t) => t.filePath === 'C:/t/second.md'), '应打开传入文件');
  } finally { cleanup(w); }
});

test('tauri: EULA 已接受时对话框隐藏且初始化继续', async () => {
  const { w, ed } = await makeEnv();
  try {
    const dlg = w.document.getElementById('eula-dialog');
    assert.ok(dlg, '应有 EULA 对话框元素');
    assert.ok(dlg.classList.contains('hidden'), '已接受 EULA 应隐藏对话框');
    assert.ok(ed, '编辑器应完成初始化');
    assert.strictEqual(w.localStorage.getItem('tizumark-eula-accepted'), 'true');
  } finally { cleanup(w); }
});

test('tauri: 窗口控制 minimize/toggleMaximize 调用对应窗口 API', async () => {
  const { w, ed } = await makeEnv();
  try {
    const calls = [];
    let maximized = false;
    w.__TAURI__.window.getCurrentWindow = () => ({
      minimize: async () => calls.push('minimize'),
      maximize: async () => { calls.push('maximize'); maximized = true; },
      unmaximize: async () => { calls.push('unmaximize'); maximized = false; },
      isMaximized: async () => maximized,
    });
    await ed.minimizeWindow();
    assert.deepStrictEqual(calls, ['minimize']);
    await ed.toggleMaximize();
    assert.ok(calls.includes('maximize'), '未最大化时应调用 maximize');
    await ed.toggleMaximize();
    assert.ok(calls.includes('unmaximize'), '已最大化时应调用 unmaximize');
  } finally { cleanup(w); }
});

test('tauri: updater 已停用 —— checkUpdate 不发起 IPC、不弹窗', async () => {
  // 背景：本 fork 的 updater 端点/公钥指向上游，会被带到上游版本，故停用更新检查
  // （app.js checkUpdate 直接短路；菜单项 #btn-check-update 在 index.html 中隐藏）。
  // 即使用假的上游更新结果诱导，也必须什么都不做。
  const calls = [];
  const { w, ed } = await makeEnv(async (cmd) => {
    calls.push(cmd);
    if (cmd === 'plugin:updater|check') return { version: '9.9.9', body: '修复了一些问题', rid: 42 };
    if (cmd === 'get_cli_args') return [];
    if (cmd === 'app_data_dir') return 'C:/tmp/tizumark-data';
    return undefined;
  });
  try {
    await ed.checkUpdate(true);
    assert.ok(!calls.includes('plugin:updater|check'), '停用后不得调用更新检查 IPC');
    assert.strictEqual(ed.pendingUpdate ?? null, null, '不应设置 pendingUpdate');
    assert.strictEqual(ed.pendingUpdateRid ?? null, null, '不应记录 update rid');
    assert.ok(
      w.document.getElementById('update-dialog').classList.contains('hidden'),
      '不应弹出更新对话框'
    );
    const updItem = w.document.getElementById('btn-check-update');
    assert.ok(
      updItem.classList.contains('hidden'),
      '「检查更新」菜单项应带 .hidden 类（HTML hidden 属性会被 .dropdown-item 的 display:flex 覆盖而失效）'
    );
  } finally { cleanup(w); }
});

test('tauri: exportHTML 组装完整 HTML 并写文件', async () => {
  const calls = [];
  const { w, ed } = await makeEnv(async (cmd, args) => {
    calls.push({ cmd, args });
    if (cmd === 'plugin:dialog|save') return 'C:/out/doc.html';
    if (cmd === 'get_cli_args') return [];
    if (cmd === 'app_data_dir') return 'C:/tmp/tizumark-data';
    return undefined;
  });
  try {
    w.fetch = async () => ({ ok: false }); // jsdom 无 fetch，样式内联步骤降级
    await ed.addTab('doc.md', '# 导出标题\n\n正文', 'C:/out/doc.md');
    ed.preview.innerHTML = '<h1>导出标题</h1><p>正文</p><button class="copy-btn">复制</button>';
    await ed.exportHTML();
    const write = calls.find((c) => c.cmd === 'write_file');
    assert.ok(write, '应调用 write_file');
    assert.strictEqual(write.args.path, 'C:/out/doc.html');
    assert.ok(write.args.content.startsWith('<!DOCTYPE html>'), '应为完整 HTML 文档');
    assert.ok(write.args.content.includes('导出标题'), '应包含预览内容');
    assert.ok(!write.args.content.includes('copy-btn'), '复制按钮应被剔除');
    assert.ok(write.args.content.includes('<title>doc.md</title>'), '标题应为文件名');
  } finally { cleanup(w); }
});

test('tauri: exportHTML 用户取消对话框时不写文件', async () => {
  const calls = [];
  const { w, ed } = await makeEnv(async (cmd, args) => {
    calls.push({ cmd, args });
    if (cmd === 'plugin:dialog|save') return null;
    if (cmd === 'get_cli_args') return [];
    if (cmd === 'app_data_dir') return 'C:/tmp/tizumark-data';
    return undefined;
  });
  try {
    w.fetch = async () => ({ ok: false });
    await ed.exportHTML();
    assert.ok(!calls.some((c) => c.cmd === 'write_file'), '取消后不应写文件');
  } finally { cleanup(w); }
});

test('tauri: 粘贴图片 assets 模式保存到附件目录并插入 img 标签', async () => {
  const calls = [];
  const { w, ed } = await makeEnv(async (cmd, args) => {
    calls.push({ cmd, args });
    if (cmd === 'save_image_to_assets') return { filename: 'img_001.png', width: 32, height: 16 };
    if (cmd === 'get_cli_args') return [];
    if (cmd === 'app_data_dir') return 'C:/tmp/tizumark-data';
    return undefined;
  });
  try {
    await ed.addTab('doc.md', '', 'C:/notes/doc.md');
    ed.settings.imageInsertMode = 'assets';
    const file = {
      type: 'image/png',
      arrayBuffer: async () => new Uint8Array([137, 80, 78, 71]).buffer,
    };
    await ed.handlePasteImage(file);
    const save = calls.find((c) => c.cmd === 'save_image_to_assets');
    assert.ok(save, '应调用 save_image_to_assets');
    // app.js 在 jsdom realm 中执行，数组原型跨 realm，需按值比较
    assert.strictEqual(JSON.stringify(save.args.bytes), '[137,80,78,71]', '字节应透传');
    assert.strictEqual(save.args.ext, 'png');
    assert.ok(save.args.assetsDir.includes('C:/notes'), '附件目录应基于文档目录');
    const doc = ed.cm.getValue();
    assert.ok(doc.includes('<img src="assets/img_001.png" width="32" height="16"'), '应插入带尺寸的 img 标签');
  } finally { cleanup(w); }
});

test('tauri: 粘贴图片 assets 模式下未保存文档提示先保存', async () => {
  const { w, ed } = await makeEnv();
  try {
    const toasts = [];
    ed.showToast = (m) => toasts.push(m);
    ed.settings.imageInsertMode = 'assets';
    // 默认标签无 filePath
    await ed.handlePasteImage({ type: 'image/png', arrayBuffer: async () => new ArrayBuffer(0) });
    assert.ok(toasts.length > 0, '应提示需先保存');
    assert.strictEqual(ed.cm.getValue(), '', '不应插入任何内容');
  } finally { cleanup(w); }
});

test('tauri: 粘贴图片 base64 模式插入 data URL', async () => {
  const { w, ed } = await makeEnv();
  try {
    ed.settings.imageInsertMode = 'base64';
    const file = new w.Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' });
    await ed.handlePasteImage(file);
    const doc = ed.cm.getValue();
    assert.ok(/!\[image\]\(data:image\/png;base64,[A-Za-z0-9+/=]+\)/.test(doc), '应插入 base64 data URL 图片');
  } finally { cleanup(w); }
});

// ===== PR #25 目录分发（openPathsSmart / maybeOpenFolderPath）=====

// 目录路径集中在 mock 里判定：is_directory 按路径后缀 '/dir' 约定返回
function dirAwareInvoke(extra = {}) {
  return async (cmd, args) => {
    if (cmd === 'is_directory') return String(args.path).includes('/dir');
    if (cmd === 'read_file') return '# 内容';
    if (cmd === 'list_dir') return [];
    if (cmd === 'get_cli_args') return extra.cliArgs || [];
    if (cmd === 'app_data_dir') return 'C:/tmp/tizumark-data';
    if (extra.impl) return extra.impl(cmd, args);
    return undefined;
  };
}

test('tauri: drag-drop 拖入目录加载为工作区且不新增标签', async () => {
  const { w, ed, listeners } = await makeEnv(dirAwareInvoke());
  try {
    const before = ed.tabs.length;
    await fire(listeners, 'tauri://drag-drop', { paths: ['C:/t/dir-ws'] });
    await delay(50);
    assert.strictEqual(ed.workspaceFolder, 'C:/t/dir-ws', '目录应设为工作区');
    assert.strictEqual(ed.tabs.length, before, '目录不应新增标签');
  } finally { cleanup(w); }
});

test('tauri: drag-drop 混拖目录+文件——目录进工作区、文件开标签', async () => {
  const { w, ed, listeners } = await makeEnv(dirAwareInvoke());
  try {
    ed.applyViewMode = () => {};
    await fire(listeners, 'tauri://drag-drop', { paths: ['C:/t/dir-ws', 'C:/t/note.md'] });
    await delay(50);
    assert.strictEqual(ed.workspaceFolder, 'C:/t/dir-ws');
    assert.ok(ed.tabs.some((t) => t.filePath === 'C:/t/note.md'), '文件应打开为标签');
  } finally { cleanup(w); }
});

test('tauri: drag-drop 拖入两个目录——多余目录合并为一条 toast（extraDirsIgnoredBatch）', async () => {
  const { w, ed, listeners } = await makeEnv(dirAwareInvoke());
  try {
    const toasts = [];
    ed.showToast = (msg, type) => { toasts.push({ msg: String(msg), type }); };
    await fire(listeners, 'tauri://drag-drop', { paths: ['C:/t/dir-a', 'C:/t/dir-b'] });
    await delay(50);
    assert.strictEqual(ed.workspaceFolder, 'C:/t/dir-a', '仅第一个目录进工作区');
    const expected = ed.t('extraDirsIgnoredBatch', { n: 1 });
    assert.strictEqual(toasts.length, 1, '只应弹一条聚合 toast，不刷屏');
    assert.ok(toasts[0].msg === expected, 'toast 应显示「已忽略 N 个多余目录」');
    assert.ok(toasts[0].type === 'warning', '应以 warning 类型提示');
    assert.ok(!toasts.some((t) => t.msg.includes(ed.t('openFailed'))), '不应误报打开失败');
  } finally { cleanup(w); }
});

test('tauri: drag-drop 拖入多个目录——多余目录合并为一条 toast 且计数正确', async () => {
  const { w, ed, listeners } = await makeEnv(dirAwareInvoke());
  try {
    const toasts = [];
    ed.showToast = (msg, type) => { toasts.push({ msg: String(msg), type }); };
    await fire(listeners, 'tauri://drag-drop', { paths: ['C:/t/dir-a', 'C:/t/dir-b', 'C:/t/dir-c', 'C:/t/dir-d'] });
    await delay(50);
    assert.strictEqual(ed.workspaceFolder, 'C:/t/dir-a', '仅第一个目录进工作区');
    const expected = ed.t('extraDirsIgnoredBatch', { n: 3 });
    assert.strictEqual(toasts.length, 1, '一条 toast 聚合所有多余目录');
    assert.ok(toasts[0].msg === expected, 'toast 计数应为 3');
  } finally { cleanup(w); }
});

test('tauri: file-open 传目录且已有不同工作区——确认取消则不切换', async () => {
  const { w, ed, listeners } = await makeEnv(dirAwareInvoke());
  try {
    ed.workspaceFolder = 'C:/t/dir-old';
    const confirms = [];
    ed.showConfirmDialog = async (title, msg) => { confirms.push({ title, msg }); return false; };
    await fire(listeners, 'file-open', ['C:/t/dir-new']);
    await delay(50);
    assert.strictEqual(confirms.length, 1, '应弹出切换工作区确认');
    assert.strictEqual(confirms[0].title, ed.t('switchWorkspaceTitle'));
    assert.strictEqual(ed.workspaceFolder, 'C:/t/dir-old', '取消后工作区不变');
    // 确认「切换」则替换工作区
    ed.showConfirmDialog = async () => true;
    await fire(listeners, 'file-open', ['C:/t/dir-new']);
    await delay(50);
    assert.strictEqual(ed.workspaceFolder, 'C:/t/dir-new', '确认后应切换工作区');
  } finally { cleanup(w); }
});

test('tauri: CLI 参数传目录直接作为工作区打开（不弹确认）', async () => {
  const { w, ed } = await makeEnv(dirAwareInvoke({ cliArgs: ['C:/t/dir-cli', 'C:/t/a.md'] }));
  try {
    await delay(80);
    assert.strictEqual(ed.workspaceFolder, 'C:/t/dir-cli', 'CLI 目录应直接设为工作区');
    assert.ok(ed.tabs.some((t) => t.filePath === 'C:/t/a.md'), 'CLI 文件参数应打开为标签');
  } finally { cleanup(w); }
});

// 回归：二次拖文件夹触发切换确认时，加载遮罩绝不能提前显示（否则会盖住确认框、点不到而卡在加载页）
test('tauri: 切换工作区确认期间不提前显示加载遮罩（修复卡加载）', async () => {
  const { w, ed, listeners } = await makeEnv(dirAwareInvoke());
  try {
    ed.workspaceFolder = 'C:/t/dir-old';
    const overlay = w.document.getElementById('loading-overlay');
    assert.ok(overlay.classList.contains('hidden'), '初始状态加载遮罩应隐藏');
    // 确认框保持 pending，模拟用户正在看弹窗、尚未点击
    let resolveConfirm;
    const pending = new Promise((r) => { resolveConfirm = r; });
    ed.showConfirmDialog = () => pending;
    let folderOpened = false;
    const origOpen = ed.openFolderPath.bind(ed);
    ed.openFolderPath = async (p) => { folderOpened = true; return origOpen(p); };

    const flow = fire(listeners, 'file-open', ['C:/t/dir-new']);
    await new Promise((r) => setTimeout(r, 20)); // 让出事件循环，确认框应已弹出
    assert.ok(!folderOpened, '确认前不应开始打开文件夹');
    // 关键回归点：确认框等待期间，加载遮罩绝不能被提前显示
    assert.ok(overlay.classList.contains('hidden'),
      '确认框等待期间加载遮罩不应显示，否则会盖住确认框导致卡死');

    // 用户点击确认：开始加载，完成后遮罩应隐藏（不卡在加载页）
    resolveConfirm(true);
    await flow;
    await new Promise((r) => setTimeout(r, 300)); // 跨越 hideLoading 的 minDuration(200ms)
    assert.ok(folderOpened, '确认后应打开文件夹');
    assert.ok(overlay.classList.contains('hidden'), '完成后加载遮罩应隐藏（不应卡在加载页）');
  } finally { cleanup(w); }
});
