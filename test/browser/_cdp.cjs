/**
 * 零依赖 Chromium 驱动（CDP over Node 内置 WebSocket）。
 *
 * 为什么需要它（2026-09-26 审计）：test/browser/ 三支真实浏览器用例此前在本机与 CI **都不会执行**
 * ——它们 require('puppeteer-core')，并把可执行文件写死为 Google Chrome 默认路径；本机只有 Edge
 * （同为 Chromium 内核），run-tests.cjs 于是直接清空 browserFiles（"跳过"），浏览器行为回归无关卡。
 * 本模块用 Node ≥ 22.4 内置 WebSocket 直接讲 CDP：不需要 puppeteer-core，Chrome/Edge 自动发现。
 *
 * 只实现仓库用例实际用到的 puppeteer 子集；范围外方法刻意不实现（宁可报错，也不给可疑的假实现）。
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const IS_WIN = process.platform === 'win32';
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function candidates() {
  const list = [process.env.CHROME_PATH];
  if (IS_WIN) {
    const pf = process.env['ProgramFiles'] || 'C:\\Program Files';
    const p86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    const la = process.env.LOCALAPPDATA || '';
    list.push(path.join(pf, 'Google/Chrome/Application/chrome.exe'),
      path.join(p86, 'Google/Chrome/Application/chrome.exe'),
      la ? path.join(la, 'Google/Chrome/Application/chrome.exe') : null,
      path.join(p86, 'Microsoft/Edge/Application/msedge.exe'),
      path.join(pf, 'Microsoft/Edge/Application/msedge.exe'));
  } else if (process.platform === 'darwin') {
    list.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Chromium.app/Contents/MacOS/Chromium');
  } else {
    list.push('/usr/bin/google-chrome', '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge');
  }
  return list.filter(Boolean);
}

/** 可执行文件探测：CHROME_PATH 优先，其余为常见安装位置。找不到返回 null（调用方据此跳过）。 */
function findBrowser() {
  for (const p of candidates()) {
    try { if (fs.existsSync(p)) return p; } catch (_e) { /* 单路径失败不影响其它候选 */ }
  }
  return null;
}

/** 跳过原因（无可运行环境）或 null（可运行）。用例开头统一据此 exit(0)。 */
function skipReason() {
  if (typeof WebSocket === 'undefined') return 'Node 内置 WebSocket 不可用（需 Node ≥ 22.4）';
  const exe = process.env.CHROME_PATH || findBrowser();
  if (!exe) return '未找到 Chromium 系浏览器（Chrome / Edge 均未探测到）';
  if (!fs.existsSync(exe)) return 'CHROME_PATH 指向的文件不存在：' + exe;
  return null;
}

class Cdp {
  constructor(ws) {
    this._ws = ws;
    this._nextId = 0;
    this._pending = new Map();
    this._handlers = new Map();   // 'method|sessionId' -> [cb]
    this._closed = false;
    ws.addEventListener('message', (ev) => this._dispatch(ev.data));
    ws.addEventListener('close', () => {
      this._closed = true;
      for (const { reject } of this._pending.values()) reject(new Error('CDP 连接已关闭'));
      this._pending.clear();
    });
  }

  _dispatch(raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch (_e) { return; }
    if (msg.id != null) {
      const p = this._pending.get(msg.id);
      if (!p) return;
      this._pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message + (msg.error.data ? ' / ' + msg.error.data : '')));
      else p.resolve(msg.result || {});
      return;
    }
    for (const cb of (this._handlers.get(msg.method + '|' + (msg.sessionId || '')) || []).slice()) {
      try { cb(msg.params || {}); } catch (_e) { /* 监听器异常不打断分发 */ }
    }
  }

  send(method, params, sessionId) {
    const id = ++this._nextId;
    return new Promise((resolve, reject) => {
      if (this._closed) { reject(new Error('CDP 连接已关闭：' + method)); return; }
      this._pending.set(id, { resolve, reject });
      const payload = { id, method, params: params || {} };
      if (sessionId) payload.sessionId = sessionId;
      try { this._ws.send(JSON.stringify(payload)); } catch (e) { this._pending.delete(id); reject(e); }
    });
  }

  on(method, cb, sessionId) {
    const key = method + '|' + (sessionId || '');
    if (!this._handlers.has(key)) this._handlers.set(key, []);
    this._handlers.get(key).push(cb);
    return () => {
      const arr = this._handlers.get(key) || [];
      const i = arr.indexOf(cb);
      if (i >= 0) arr.splice(i, 1);
    };
  }

  /** 导航等竞态场景：必须先登记再发命令。超时返回 null 而不是抛错（由调用方决定是否致命）。 */
  onceEvent(method, sessionId, timeoutMs) {
    return new Promise((resolve) => {
      let done = false;
      const off = this.on(method, (p) => { if (!done) { done = true; off(); resolve(p); } }, sessionId);
      if (timeoutMs) setTimeout(() => { if (!done) { done = true; off(); resolve(null); } }, timeoutMs);
    });
  }

  close() { try { this._ws.close(); } catch (_e) { /* 已关闭 */ } }
}

function consoleEntry(params) {
  const type = params.type || 'log';
  const text = (params.args || []).map((a) => {
    if (a == null) return String(a);
    if ('value' in a) return (a.value !== null && typeof a.value === 'object') ? JSON.stringify(a.value) : String(a.value);
    return a.description || a.unserializableValue || '';
  }).join(' ');
  return { type: () => type, text: () => text };
}

class Page {
  constructor(cdp, sessionId) {
    this._cdp = cdp;
    this._sid = sessionId;
    this._inflight = new Set();
    this._lastNet = Date.now();
    cdp.on('Network.requestWillBeSent', (p) => {
      if (p.requestId) this._inflight.add(p.requestId);
      this._lastNet = Date.now();
    }, sessionId);
    for (const ev of ['Network.loadingFinished', 'Network.loadingFailed', 'Network.requestServedFromCache']) {
      cdp.on(ev, (p) => {
        if (p.requestId) this._inflight.delete(p.requestId);
        this._lastNet = Date.now();
      }, sessionId);
    }
  }

  _send(method, params) { return this._cdp.send(method, params, this._sid); }

  on(event, cb) {
    if (event === 'pageerror') {
      return this._cdp.on('Runtime.exceptionThrown', (p) => {
        const d = p.exceptionDetails || {};
        cb({ message: String((d.exception && (d.exception.description || d.exception.value)) || d.text || 'unknown error') });
      }, this._sid);
    }
    if (event === 'console') return this._cdp.on('Runtime.consoleAPICalled', (p) => cb(consoleEntry(p)), this._sid);
    if (event === 'requestfailed') return this._cdp.on('Network.loadingFailed', (p) => cb(p), this._sid);
    throw new Error('未实现的页面事件：' + event + '（见 _cdp.cjs 顶注）');
  }

  async setViewport({ width, height, deviceScaleFactor = 1 }) {
    await this._send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor, mobile: false });
  }

  /** 必须在页面脚本执行前注入：EULA 预设 / Tauri mock 走这里，否则纯前端 app 无法启动。 */
  async evaluateOnNewDocument(fnOrSource, arg) {
    const source = (typeof fnOrSource === 'function')
      ? '(' + fnOrSource.toString() + ')(' + JSON.stringify(arg === undefined ? null : arg) + ');'
      : String(fnOrSource);
    await this._send('Page.addScriptToEvaluateOnNewDocument', { source });
  }

  async goto(url, opts = {}) {
    const timeout = opts.timeout || 30000;
    await this._send('Page.enable');
    await this._send('Runtime.enable');
    await this._send('Network.enable');
    const loaded = this._cdp.onceEvent('Page.loadEventFired', this._sid, timeout);
    await this._send('Page.navigate', { url });
    await loaded;
    await this._waitReadyState(timeout);
    if (opts.waitUntil === 'networkidle0' || opts.waitUntil === 'networkidle2') {
      await this._waitNetworkIdle(timeout, opts.waitUntil === 'networkidle0' ? 0 : 2);
    }
  }

  async _waitReadyState(timeout) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      try { if (await this.evaluate(() => document.readyState) === 'complete') return; } catch (_e) { /* 导航中间态 */ }
      await delay(50);
    }
  }

  /** 近似 puppeteer 的 networkidle：在途请求 ≤ threshold 且静默 ≥ 500ms */
  async _waitNetworkIdle(timeout, threshold) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (this._inflight.size <= threshold && Date.now() - this._lastNet >= 500) return;
      await delay(100);
    }
  }

  _expr(fnOrExpr, arg) {
    return (typeof fnOrExpr === 'function')
      ? '(' + fnOrExpr.toString() + ')(' + JSON.stringify(arg === undefined ? null : arg) + ')'
      : String(fnOrExpr);
  }

  _exMsg(d) {
    const ex = d && d.exception;
    return String((ex && (ex.description || ex.value)) || (d && d.text) || '未知页面异常');
  }

  async evaluate(fnOrExpr, arg) {
    const res = await this._send('Runtime.evaluate', {
      expression: this._expr(fnOrExpr, arg), awaitPromise: true, returnByValue: true, userGesture: true,
    });
    if (res.exceptionDetails) throw new Error(this._exMsg(res.exceptionDetails));
    return res.result ? res.result.value : undefined;
  }

  /** 轮询等待为真；函数/表达式会被 await（兼容 async 断言），抛错视为"尚未就绪"继续重试。 */
  async waitForFunction(fnOrExpr, opts = {}, ...args) {
    const timeout = opts.timeout || 30000;
    const base = (typeof fnOrExpr === 'function')
      ? '(' + fnOrExpr.toString() + ')(' + args.map((a) => JSON.stringify(a === undefined ? null : a)).join(', ') + ')'
      : String(fnOrExpr);
    const expression = '(async () => !!(await (' + base + ')))()';
    const deadline = Date.now() + timeout;
    let lastErr = null;
    while (Date.now() < deadline) {
      try {
        const res = await this._send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
        if (!res.exceptionDetails && res.result && res.result.value === true) return true;
        if (res.exceptionDetails) lastErr = new Error(this._exMsg(res.exceptionDetails));
      } catch (e) { lastErr = e; }
      await delay(opts.polling || 100);
    }
    throw new Error('waitForFunction 超时（' + timeout + 'ms）：' + base.slice(0, 160) +
      (lastErr ? '；最后一次错误：' + lastErr.message : ''));
  }

  async waitForSelector(selector, opts = {}) {
    return this.waitForFunction('!!document.querySelector(' + JSON.stringify(selector) + ')', opts);
  }

  async click(selector) {
    await this.waitForSelector(selector, { timeout: 10000 });
    await this.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (el) { el.scrollIntoView({ block: 'center' }); el.click(); }
    }, selector);
  }

  async screenshot(opts = {}) {
    const res = await this._send('Page.captureScreenshot', { format: 'png' });
    if (opts.path) fs.writeFileSync(opts.path, Buffer.from(res.data, 'base64'));
    return Buffer.from(res.data, 'base64');
  }

  async close() { try { await this._cdp.send('Target.closeTarget', { targetId: this._targetId }); } catch (_e) { /* 已关闭 */ } }

  setTargetId(id) { this._targetId = id; }
}

async function connectWs(url) {
  const ws = new WebSocket(url);
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('CDP WebSocket 连接超时：' + url)), 15000);
    ws.addEventListener('open', () => { clearTimeout(t); resolve(); });
    ws.addEventListener('error', () => { clearTimeout(t); reject(new Error('CDP WebSocket 连接失败：' + url)); });
  });
  return ws;
}

/**
 * 启动浏览器并返回 puppeteer 风格的 browser（newPage / close）。
 * opts: { executablePath, args, headless }（headless 一律用 --headless=new）
 */
async function launch(opts = {}) {
  if (typeof WebSocket === 'undefined') throw new Error('Node 内置 WebSocket 不可用（需 Node ≥ 22.4）');
  const exe = opts.executablePath || findBrowser();
  if (!exe) throw new Error('未找到 Chromium 系浏览器：请设置 CHROME_PATH 或安装 Chrome/Edge');
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tizu-cdp-'));
  const baseArgs = [
    '--remote-debugging-port=0',
    '--user-data-dir=' + userDataDir,
    '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    '--disable-background-networking', '--disable-sync', '--disable-translate',
    ...(opts.args || []),
  ];

  const spawnOnce = (headlessFlag) => {
    const child = spawn(exe, [headlessFlag, ...baseArgs, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
    return new Promise((resolve, reject) => {
      let buf = '';
      let wsUrl = '';
      const timer = setTimeout(() => {
        if (!wsUrl) { try { child.kill('SIGKILL'); } catch (_e) { /* ignore */ } reject(new Error('浏览器调试端口未就绪（15s）：' + buf.slice(-400))); }
      }, 15000);
      const onData = (d) => {
        buf += d.toString();
        const m = buf.match(/DevTools listening on (ws:\/\/[^\s]+)/);
        if (m && !wsUrl) { wsUrl = m[1]; clearTimeout(timer); resolve({ child, wsUrl }); }
      };
      child.stderr.on('data', onData);
      child.on('exit', (code) => {
        if (!wsUrl) { clearTimeout(timer); reject(new Error('浏览器进程提前退出（code=' + code + '）：' + buf.slice(-400))); }
      });
    });
  };

  let child = null;
  let cdpWs = null;
  let wsUrl = null;
  try {
    ({ child, wsUrl } = await spawnOnce('--headless=new'));
  } catch (e) {
    // 老版本 Chromium 不认 --headless=new：退回旧无头模式再试一次
    ({ child, wsUrl } = await spawnOnce('--headless'));
  }
  cdpWs = await connectWs(wsUrl);
  const cdp = new Cdp(cdpWs);

  return {
    _child: child,
    _userDataDir: userDataDir,
    cdp,
    async newPage() {
      const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
      const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
      const page = new Page(cdp, sessionId);
      page.setTargetId(targetId);
      return page;
    },
    async close() {
      try { await cdp.send('Browser.close'); } catch (_e) { /* 可能已退出 */ }
      try { cdp.close(); } catch (_e) { /* ignore */ }
      await delay(200);
      try { if (child && !child.killed) child.kill('SIGKILL'); } catch (_e) { /* ignore */ }
      try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch (_e) { /* Windows 上句柄可能未释放，留给系统清理 */ }
    },
  };
}

module.exports = { launch, findBrowser, skipReason, candidates };
