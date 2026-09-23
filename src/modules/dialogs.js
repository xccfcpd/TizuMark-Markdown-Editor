// 通用对话框（保存 / 确认）抽取：从 app.js 的 showSaveDialog / showConfirmDialog 拆出。
// 设计：纯 DOM + 回调，不依赖渲染管线；i18n(t) 与提示(showToast)通过 opts 注入，
// 与 preview-post / outline 模块的注入风格一致，降低改动爆炸半径。
//   - showSaveDialog({ title, message, saveLabel, discardLabel, cancelLabel, t, doc }): Promise<'save'|'discard'|'cancel'>
//   - showConfirmDialog({ title, message, action, t, showToast, doc }): Promise<boolean>

function showSaveDialog(opts) {
  const doc = opts.doc || document;
  const t = opts.t || ((k) => k);
  return new Promise((resolve) => {
    const dialog = doc.getElementById('save-dialog');
    const titleEl = doc.getElementById('save-dialog-title');
    const msgEl = doc.getElementById('save-dialog-message');
    const saveBtn = doc.getElementById('save-dialog-save');
    const discardBtn = doc.getElementById('save-dialog-discard');
    const cancelBtn = doc.getElementById('save-dialog-cancel');

    const origTitle = titleEl.textContent;
    const origMsg = msgEl.textContent;
    const origSave = saveBtn.textContent;
    const origDiscard = discardBtn.textContent;
    const origCancel = cancelBtn.textContent;

    if (opts.title !== undefined) titleEl.textContent = opts.title;
    if (opts.message !== undefined) msgEl.textContent = opts.message;
    if (opts.saveLabel) saveBtn.textContent = opts.saveLabel;
    if (opts.discardLabel) discardBtn.textContent = opts.discardLabel;
    if (opts.cancelLabel) cancelBtn.textContent = opts.cancelLabel;
    dialog.classList.remove('hidden');

    const cleanup = () => {
      dialog.classList.add('hidden');
      titleEl.textContent = origTitle;
      msgEl.textContent = origMsg;
      saveBtn.textContent = origSave;
      discardBtn.textContent = origDiscard;
      cancelBtn.textContent = origCancel;
      saveBtn.removeEventListener('click', onSave);
      discardBtn.removeEventListener('click', onDiscard);
      cancelBtn.removeEventListener('click', onCancel);
    };
    const onSave = () => { cleanup(); resolve('save'); };
    const onDiscard = () => { cleanup(); resolve('discard'); };
    const onCancel = () => { cleanup(); resolve('cancel'); };

    saveBtn.addEventListener('click', onSave);
    discardBtn.addEventListener('click', onDiscard);
    cancelBtn.addEventListener('click', onCancel);
  });
}

function showConfirmDialog(opts) {
  const doc = opts.doc || document;
  const t = opts.t || ((k) => k);
  const showToast = opts.showToast || (() => {});
  return new Promise((resolve) => {
    const dialog = doc.getElementById('confirm-dialog');
    const confirmBtn = doc.getElementById('confirm-dialog-confirm');
    const cancelBtn = doc.getElementById('confirm-dialog-cancel');
    doc.getElementById('confirm-dialog-title').textContent = opts.title || t('confirm');
    // 安全：message 一律按纯文本渲染（历史 bug：innerHTML 会让含 <img onerror> 的
    // 目录路径 / 用户文本在确认框执行，跨平台路径注入 XSS）。需要换行用 \n + pre-line。
    doc.getElementById('confirm-dialog-message').textContent = opts.message || '';
    // 可选警示块：默认隐藏，由调用方传 opts.warning 时打开（同样 textContent 防 XSS）。
    // DOM 不存在时静默跳过——dialogs.test.cjs 的 buildDom() 只造了 4 个 id，不含此节点。
    const warnEl = doc.getElementById('confirm-dialog-warning');
    const warnTextEl = doc.getElementById('confirm-dialog-warning-text');
    if (warnEl) {
      if (opts.warning) {
        if (warnTextEl) warnTextEl.textContent = opts.warning;
        warnEl.classList.remove('hidden');
      } else {
        if (warnTextEl) warnTextEl.textContent = '';
        warnEl.classList.add('hidden');
      }
    }
    dialog.classList.remove('hidden');

    const cleanup = () => {
      dialog.classList.add('hidden');
      // 复位警示块：避免单例对话框下次给"删除字体/重置设置/切换工作区"用时残留 PDF 警示
      if (warnEl) warnEl.classList.add('hidden');
      if (warnTextEl) warnTextEl.textContent = '';
      confirmBtn.removeEventListener('click', onConfirm);
      cancelBtn.removeEventListener('click', onCancel);
    };
    const onConfirm = async () => {
      // 防御：action 必须是**函数**（确认后执行的动作）。历史 bug：某调用方误传了按钮文案
      // 字符串 → `await opts.action()` 抛 TypeError 被下面的 catch 吞掉，而函数**照旧
      // resolve(true)**，于是"报错"变成了"静默继续执行"—— 后果是导出流程在用户毫无察觉的
      // 情况下继续跑重活（用户 2026-09-23 报障：大文档导出后界面假死）。
      // 非函数一律按"无动作"处理，只走确认/取消语义。
      if (typeof opts.action === 'function') {
        confirmBtn.disabled = true;
        cancelBtn.disabled = true;
        const originalHTML = confirmBtn.innerHTML;
        confirmBtn.innerHTML = `<span class="btn-spinner"></span>` + t('processing');
        try {
          await opts.action();
        } catch (e) {
          // 文案不再写死成「删除字体」——这里服务所有确认框（导出/切换工作区/删除字体…），
          // 写死会让用户完全误解发生了什么（历史 bug：导出报错却提示"删除 失败"）。
          showToast(String(t('failed')) + ': ' + e, 'danger');
        } finally {
          confirmBtn.disabled = false;
          cancelBtn.disabled = false;
          confirmBtn.innerHTML = originalHTML;
        }
      }
      cleanup();
      resolve(true);
    };
    const onCancel = () => { cleanup(); resolve(false); };

    confirmBtn.addEventListener('click', onConfirm);
    cancelBtn.addEventListener('click', onCancel);
  });
}

// 关闭窗口确认对话框：返回 { action: 'quit'|'minimize', remember: boolean }，取消则 resolve(null)。
function showCloseDialog(opts) {
  const doc = opts.doc || document;
  const t = opts.t || ((k) => k);
  return new Promise((resolve) => {
    const dialog = doc.getElementById('close-confirm-dialog');
    const quitBtn = doc.getElementById('close-dialog-quit');
    const minimizeBtn = doc.getElementById('close-dialog-minimize');
    const rememberCb = doc.getElementById('close-dialog-remember');
    const overlay = dialog;

    dialog.classList.remove('hidden');

    const cleanup = () => {
      dialog.classList.add('hidden');
      quitBtn.removeEventListener('click', onQuit);
      minimizeBtn.removeEventListener('click', onMinimize);
      overlay.removeEventListener('click', onOverlay);
    };

    const onQuit = () => {
      cleanup();
      resolve({ action: 'quit', remember: rememberCb.checked });
    };
    const onMinimize = () => {
      cleanup();
      resolve({ action: 'minimize', remember: rememberCb.checked });
    };
    const onOverlay = (e) => {
      if (e.target === overlay) {
        cleanup();
        resolve(null);
      }
    };

    quitBtn.addEventListener('click', onQuit);
    minimizeBtn.addEventListener('click', onMinimize);
    overlay.addEventListener('click', onOverlay);
  });
}

const Dialogs = { showSaveDialog, showConfirmDialog, showCloseDialog };

// 浏览器：作为独立 <script> 加载，挂到全局 Dialogs
if (typeof window !== 'undefined' && typeof module === 'undefined') {
  window.Dialogs = Dialogs;
}
// Node（测试 / 构建）：CommonJS 导出
if (typeof module !== 'undefined' && module.exports) {
  module.exports = Dialogs;
}
