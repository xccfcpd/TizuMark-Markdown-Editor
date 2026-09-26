// 测试运行器：每个 test 文件在【独立的 Node 进程】中运行。
//
// 为什么需要它：node:test 在单次 `node --test test/*.test.cjs` 调用下会把所有 test 文件
// 放进【同一个进程】并发执行，而各测试文件共享 global.window/document/navigator，并且
// codemirror 是 require 缓存单例 —— 并发时互相踩踏，导致 outline / file-watcher / tauri
// 等用例“漂移”式间歇性失败（同一批跑有时过、有时挂在不同文件）。把每个文件拆到独立进程
// 后，进程内各 test 顺序执行（node:test 同文件内串行）、进程间全局互不干扰，从根本消除串扰。
//
// 用法：
//   node scripts/run-tests.cjs                     全量
//   node scripts/run-tests.cjs preview outline     只跑文件名含 preview 或 outline 的测试
//
// 为什么要支持过滤（P0-0f / R7）：项目约定「只跑改动相关的测试」，但运行器原先不读 argv，
// 于是日常做法是绕过运行器直跑 `node --test test/x.test.cjs` —— 也就绕过了这里的全部前置
// 守护（产物检查等）。加上过滤后，日常入口重新回到守护之内。

const { spawnSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');

const ROOT = path.join(__dirname, '..');
const TEST_DIR = path.join(ROOT, 'test');
const BUNDLE = path.join(ROOT, 'src', 'lib', 'unified-bundle.js');
const PER_FILE_TIMEOUT = 120; // 单文件超时（秒），避免某个用例死等导致整批卡死

// 构建产物兜底检查（P0-0b）。注意：package.json 的 pretest 已会先跑 build:renderer，
// 所以走 `npm test` 时这条永不触发；它只在【直跑本运行器】（不经 npm）时兜底。
function checkBundle() {
  if (fs.existsSync(BUNDLE)) return;
  console.error('✗ 构建产物缺失：src/lib/unified-bundle.js');
  console.error('  该文件由 esbuild 生成、不在版本库中。请先运行：');
  console.error('    npm run build:renderer');
  process.exit(1);
}

function listTestFiles(filters) {
  // P1-2.2：递归扫 test/**/*.test.cjs，防止「写了不跑」的假覆盖。
  // 跳过 node_modules / .git 等无关目录。
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch (_) { return []; }
    const out = [];
    for (const e of entries) {
      if (e.name === 'node_modules' || e.name === '.git') continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) out.push(...walk(full));
      else if (e.isFile() && e.name.endsWith('.test.cjs')) out.push(full);
    }
    return out;
  };
  let files = walk(TEST_DIR);
  if (filters && filters.length) {
    // 子串匹配（大小写不敏感），任一命中即纳入（按相对路径匹配，子目录文件同样可过滤）
    const keys = filters.map((k) => k.toLowerCase());
    files = files.filter((f) => {
      const rel = path.relative(TEST_DIR, f).toLowerCase();
      return keys.some((k) => rel.includes(k));
    });
  }
  return files.sort();
}

function runOne(file) {
  // --test-concurrency=1：同文件内子测试串行执行，避免并发 buildEnv 互相踩踏共享的
  // global.window/document 与 codemirror 单例（每个文件已是独立进程，仅剩文件内并发问题）。
  const res = spawnSync(process.execPath, ['--test', '--test-concurrency=1', file], {
    cwd: path.join(__dirname, '..'),
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    timeout: PER_FILE_TIMEOUT * 1000,
    killSignal: 'SIGKILL',
  });
  const out = (res.stdout || '') + (res.stderr || '');
  const tests = /(?:^|\n)# tests\s+(\d+)/.exec(out);
  const pass = /(?:^|\n)# pass\s+(\d+)/.exec(out);
  const fail = /(?:^|\n)# fail\s+(\d+)/.exec(out);
  const timedOut = res.error && res.error.code === 'ETIMEDOUT';
  const failed = timedOut || /(?:^|\n)not ok\b/.test(out) || res.status !== 0;
  return {
    file: path.basename(file),
    status: res.status,
    tests: tests ? Number(tests[1]) : null,
    pass: pass ? Number(pass[1]) : null,
    fail: fail ? Number(fail[1]) : null,
    timedOut: !!timedOut,
    failed,
    output: out,
  };
}

function summarize(results) {
  const total = results.length;
  const failedFiles = results.filter((r) => r.failed);
  const totalTests = results.reduce((a, r) => a + (r.tests || 0), 0);
  const totalPass = results.reduce((a, r) => a + (r.pass || 0), 0);
  const totalFail = results.reduce((a, r) => a + (r.fail || 0), 0);

  console.log('\n================ 测试汇总 ================');
  for (const r of results) {
    const mark = r.failed ? 'FAIL' : 'ok  ';
    let detail;
    if (r.timedOut) detail = `超时(>${PER_FILE_TIMEOUT}s)被杀`;
    else if (r.tests != null) detail = `${r.pass}/${r.tests} passed`;
    else detail = `exit=${r.status}`;
    console.log(`  [${mark}] ${r.file}  (${detail})`);
  }
  console.log('------------------------------------------');
  console.log(`  文件: ${total - failedFiles.length}/${total} 通过`);
  console.log(`  用例: ${totalPass}/${totalTests} 通过, ${totalFail} 失败`);
  console.log('==========================================\n');

  if (failedFiles.length) {
    console.error(`✗ ${failedFiles.length} 个测试文件存在失败：`);
    for (const r of failedFiles) {
      console.error(`  - ${r.file}${r.timedOut ? ' (超时)' : ''}`);
      // 打印失败文件的完整 TAP 输出，便于定位具体子测试与错误
      if (r.output) {
        console.error('---- ' + r.file + ' 输出 ----');
        console.error(r.output);
      }
    }
    process.exit(1);
  }
  console.log('✓ 全部测试文件通过');
}

// ---------- 浏览器测试（真实 Chrome）支持 ----------
// 浏览器测试位于 test/browser/，是自治脚本（自起 puppeteer + process.exit），
// 不能用 `node --test` 收集，且依赖 dev-server(1420) 提供页面 + NODE_PATH 指向 puppeteer-core。
function isBrowserTest(file) {
  return path.relative(TEST_DIR, file).split(path.sep).includes('browser');
}

function resolvePuppeteerModules() {
  // 优先级：显式 env > 当前 NODE_PATH；**没有配置就返回 null，绝不猜本机路径**。
  // 历史教训：这里曾写死 'C:/Users/admin/node_modules' —— 换一台机器后它只会指向一个
  // 不存在的目录，反而令人误判为「依赖已就绪，只是用例有问题」（release.js 有过同类问题）。
  return process.env.PUPPETEER_MODULES || process.env.NODE_PATH || null;
}

function waitForDevServer(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      const req = http.get('http://localhost:1420/', (res) => { res.resume(); resolve(res.statusCode); });
      req.on('error', () => {
        if (Date.now() > deadline) reject(new Error('dev-server 未就绪（超时）'));
        else setTimeout(tryOnce, 400);
      });
      req.setTimeout(800, () => { req.destroy(); if (Date.now() > deadline) reject(new Error('dev-server 超时')); });
    };
    tryOnce();
  });
}

let _devServer = null;
async function ensureDevServer() {
  if (_devServer) return _devServer;
  const child = spawn(process.execPath, ['scripts/dev-server.mjs'], {
    cwd: path.join(__dirname, '..'),
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  _devServer = child;
  await waitForDevServer(20000);
  return child;
}
function killDevServer() {
  if (!_devServer) return;
  try { _devServer.kill('SIGKILL'); } catch {}
  _devServer = null;
}

function runBrowserOne(file) {
  const mods = resolvePuppeteerModules();
  const env = { ...process.env };
  if (mods) env.NODE_PATH = mods;   // 未配置时不注入，由子进程继承父进程环境
  const res = spawnSync(process.execPath, [file], {
    cwd: path.join(__dirname, '..'),
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    timeout: PER_FILE_TIMEOUT * 1000,
    killSignal: 'SIGKILL',
    env,
  });
  const out = (res.stdout || '') + (res.stderr || '');
  const passCount = (out.match(/✅\s*PASS/g) || []).length;
  const failCount = (out.match(/❌\s*FAIL/g) || []).length;
  const tests = passCount + failCount;
  return {
    file: path.relative(TEST_DIR, file),
    status: res.status,
    tests, pass: passCount, fail: failCount,
    timedOut: !!(res.error && res.error.code === 'ETIMEDOUT'),
    failed: failCount > 0 || res.status !== 0,
    output: out,
  };
}

function runBatch(files, total, runner, idxStart) {
  const results = [];
  let i = idxStart;
  for (const f of files) {
    i++;
    process.stdout.write(`[${i}/${total}] ${path.relative(TEST_DIR, f)} ... `);
    const r = runner(f);
    const tag = r.timedOut ? 'TIMEOUT' : (r.failed ? 'FAIL' : 'ok');
    const detail = r.tests != null ? `${r.pass}/${r.tests}` : (r.timedOut ? 'timeout' : `exit=${r.status}`);
    console.log(`${tag} (${detail})`);
    results.push(r);
  }
  return results;
}

function main() {
  checkBundle();
  const filters = process.argv.slice(2).filter((a) => !a.startsWith('-'));
  const files = listTestFiles(filters);
  if (!files.length) {
    if (filters.length) {
      console.error(`未找到匹配 [${filters.join(', ')}] 的 test/**/*.test.cjs`);
      console.error('可用文件：');
      for (const f of listTestFiles()) console.error('  - ' + path.relative(TEST_DIR, f));
    } else {
      console.error('未找到任何 test/**/*.test.cjs');
    }
    process.exit(1);
  }
  const browserFiles = files.filter(isBrowserTest);
  const normalFiles = files.filter((f) => !isBrowserTest(f));
  // 浏览器测试依赖系统 Chrome + 本机 node_modules 中的 puppeteer-core（本地范式，
  // 见 ADR-7）。CI（ubuntu）/ 任何缺少该环境的机器上自动跳过，避免「找不到
  // puppeteer-core」直接崩溃导致整批测试失败。
  if (browserFiles.length) {
    const mods = resolvePuppeteerModules();
    let hasPuppeteer = false;
    try { require.resolve('puppeteer-core'); hasPuppeteer = true; } catch (_) {}
    if (!hasPuppeteer && mods) {
      try { hasPuppeteer = fs.existsSync(path.join(mods, 'puppeteer-core', 'package.json')); } catch (_) {}
    }
    if (!hasPuppeteer) {
      console.log(`⚠ 跳过 ${browserFiles.length} 个浏览器测试（环境缺少 puppeteer-core / 系统 Chrome；属本地范式）。\n`);
      if (!mods) {
        console.log('  未配置 puppeteer-core 所在目录。需要运行这批用例时：\n' +
          '      PUPPETEER_MODULES=<装有 puppeteer-core 的目录> npm test\n' +
          '  （也可导出为 NODE_PATH。运行器不再内置本机路径猜测。）\n');
      }
      // 显式提示覆盖缺口（审计发现，2026-09-24）：CI（ubuntu）恒定缺该环境，于是这批用例
      // 永远不跑且没有任何汇总痕迹 —— 涉及浏览器行为的回归只能在本地被发现。
      if (process.env.CI) console.log('⚠ 注意：CI 环境同样缺少该依赖，这批浏览器用例不会执行（已知测试缺口）。\n');
      browserFiles.length = 0;
    }
  }
  const total = normalFiles.length + browserFiles.length;
  const scope = filters.length ? `（过滤：${filters.join(', ')}）` : '';
  console.log(`运行 ${total} 个测试文件${scope}（jsdom ${normalFiles.length} + 浏览器 ${browserFiles.length}）...\n`);

  const results = [];
  results.push(...runBatch(normalFiles, files.length, runOne, 0));
  if (browserFiles.length) {
    ensureDevServer()
      .then(() => {
        results.push(...runBatch(browserFiles, files.length, runBrowserOne, results.length));
        killDevServer();
        summarize(results);
      })
      .catch((e) => {
        console.error('启动 dev-server 失败：', e.message);
        killDevServer();
        process.exit(1);
      });
  } else {
    summarize(results);
  }
}

main();
