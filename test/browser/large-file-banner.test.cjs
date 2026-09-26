/**
 * 无头浏览器回归测试：大文档提示条「不再提醒」按钮
 *
 * 为什么用真实浏览器（而非 jsdom）：
 *   本测试验证「点击不再提醒 → 本次会话内再次打开大文件不再弹横幅」这一端到端交互，
 *   依赖真实 DOM 事件、真实 classList 切换和真实 MarkdownEditor 实例（app.js 在
 *   DOMContentLoaded 时 new MarkdownEditor()）。jsdom 无法实例化 app.js（会拉起
 *   CodeMirror / Tauri），故用系统 Chrome 通过 dev-server(1420) 加载真实应用验证。
 *
 * 运行：由 scripts/run-tests.cjs 的 browser/ 分支自动拉起 dev-server(1420) + NODE_PATH 后执行。
 *   （也可手动：NODE_PATH=<managed node_modules> node test/browser/large-file-banner.test.cjs，需 dev-server 在 1420）
 */
'use strict';
const fs = require('fs');

// 驱动已改为零依赖 CDP（见 _cdp.cjs）：不再需要 puppeteer-core，Chrome / Edge 都能跑
//（此前把可执行文件写死成 Chrome 默认路径，本机只有 Edge → 恒跳过，回归毫无关卡）。
const { launch, findBrowser, skipReason } = require('./_cdp.cjs');
const CHROME_PATH = process.env.CHROME_PATH || findBrowser();
const URL = 'http://localhost:1420/';
const SKIP_REASON = skipReason();
if (SKIP_REASON || !CHROME_PATH || !fs.existsSync(CHROME_PATH)) {
  console.log('SKIP: ' + (SKIP_REASON || '未探测到 Chrome / Edge'));
  console.log('      设置 CHROME_PATH 环境变量指向本机 Chromium 系浏览器即可运行本测试。');
  process.exit(0);
}

const puppeteer = { launch };

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  const page = await browser.newPage();
  let failed = 0;
  const assert = (name, cond) => {
    if (cond) { console.log('  ✓ ' + name); }
    else { console.log('  ✗ ' + name); failed++; }
  };

  try {
    await page.goto(URL, { waitUntil: 'networkidle0', timeout: 30000 });
    await page.waitForFunction("window.editor && window.editor.preview", { timeout: 30000 });

    // 前置：切到「编辑+预览」双栏。默认 viewMode='preview' 时 showLargeFileNotice 按设计
    // 直接隐藏横幅（纯预览用虚拟滚动，可拖到全文，不需要提示，见 app.js:190），
    // 本用例验证的却是**编辑态**的大文档提示 —— 此前缺这一步，3 项断言在本机恒失败
    //（该文件此前从未真正执行过，2026-09-26 才被启用）。另两支浏览器用例同样有此前置。
    await page.evaluate(() => { window.editor.setViewMode('edit'); });
    await page.waitForFunction(
      "(() => { const e = document.querySelector('.CodeMirror'); return !!e && e.getBoundingClientRect().width > 50; })()",
      { timeout: 8000 }
    );

    // 1) 横幅与按钮初始存在
    const hasBtn = await page.evaluate(() => !!document.getElementById('large-file-banner-dont-remind'));
    assert('存在「不再提醒」按钮', hasBtn);

    // 2) 初始会话标志为 false → showLargeFileNotice 应显示横幅
    const showsInitially = await page.evaluate(() => {
      const ed = window.editor;
      ed._largeFileNoticeSessionSuppressed = false;
      ed._largeFileNoticeDismissed = false;
      ed._largeFileNoticeKey = null;
      const banner = document.getElementById('large-file-banner');
      banner.classList.add('hidden');
      ed.showLargeFileNotice('perf-banner', 50000, 1024 * 1024 * 8);
      return !banner.classList.contains('hidden');
    });
    assert('未点「不再提醒」时打开大文件会显示横幅', showsInitially);

    // 3) 点击「不再提醒」→ 会话标志置 true 且横幅隐藏
    const afterClick = await page.evaluate(() => {
      const ed = window.editor;
      ed._largeFileNoticeSessionSuppressed = false;
      ed._largeFileNoticeDismissed = false;
      const banner = document.getElementById('large-file-banner');
      banner.classList.remove('hidden');
      document.getElementById('large-file-banner-dont-remind').click();
      return { suppressed: ed._largeFileNoticeSessionSuppressed, hidden: banner.classList.contains('hidden') };
    });
    assert('点击「不再提醒」后会话标志置 true', afterClick.suppressed === true);
    assert('点击「不再提醒」后横幅立即隐藏', afterClick.hidden === true);

    // 4) 会话标志为 true 后，再次打开大文件不再弹（本次应用运行期间）
    //    注意：这里不再手动摘掉 hidden。抑制态下横幅本就应当是隐身的（点「不再提醒」时已隐藏），
    //    人为显示它属于不可达状态；从真实状态出发断言依然有效力 —— 抑制一旦失效，
    //    showLargeFileNotice 会 remove('hidden') 把它显示出来，断言随即失败。
    const staysHidden = await page.evaluate(() => {
      const ed = window.editor;
      const banner = document.getElementById('large-file-banner');
      ed.showLargeFileNotice('perf-banner', 60000, 1024 * 1024 * 9);
      return banner.classList.contains('hidden');
    });
    assert('点过「不再提醒」后再次打开大文件不再弹横幅', staysHidden);

    // 5) 「不再提醒」必须是会话级：重新实例化（模拟重启）后标志复位为 false 仍可弹
    const resetsOnRestart = await page.evaluate(() => {
      const ed = window.editor;
      // 模拟应用重启：标志回到初始 false（构造函数里初始化为 false）
      ed._largeFileNoticeSessionSuppressed = false;
      const banner = document.getElementById('large-file-banner');
      banner.classList.add('hidden');
      ed.showLargeFileNotice('perf-banner', 50000, 1024 * 1024 * 8);
      return !banner.classList.contains('hidden');
    });
    assert('模拟重启（标志复位）后打开大文件仍会提醒', resetsOnRestart);

  } catch (e) {
    console.error('测试执行异常：', e);
    failed++;
  } finally {
    await browser.close();
  }

  console.log(failed === 0 ? '\nlarge-file-banner 浏览器测试全部通过 ✓' : `\nlarge-file-banner 浏览器测试失败 ${failed} 项`);
  process.exit(failed === 0 ? 0 : 1);
})();
