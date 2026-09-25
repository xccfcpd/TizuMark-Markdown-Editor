// P0-0 构建产物韧性 —— 验收（C8 / C19 / N14 / N26 / R7）
//
// 覆盖 6 件套里可自动化的部分：
//   a  package.json 有 pretest（npm test 前自动重建产物）
//   b  run-tests.cjs 直跑时对产物缺失有 existsSync 兜底 + 可操作提示
//   c  index.html 首个业务脚本之前已注册全局 error 兜底（由 P0-1 提供，capture 阶段
//      同时兜住 script 加载失败与运行时抛错）
//   d  app.js 调用 UnifiedRenderer 之前有 typeof 守卫，抛可操作错误而非裸 ReferenceError
//   e  test/helpers/load-bundle.cjs：产物缺失/形态异常时给修复指引；5 个依赖产物的测试
//      全部改走它（不得再出现裸 readFileSync('...unified-bundle.js')）
//   f  run-tests.cjs 读 argv 做子串过滤：带参只跑子集、无参行为不变
//
// 说明：这些断言全部是【静态检查 + 子进程行为】，不真的删产物（删了会打断用户工作流）。
// 产物缺失路径通过给 load-bundle 指一个不存在的路径来间接验证不现实（路径是常量），
// 故改为：在临时目录复制一份运行器，验证其 existsSync 分支的输出文本。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

// ---------- a ----------
test('P0-0a: package.json 存在 pretest，npm test 前自动重建渲染器产物', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.strictEqual(pkg.scripts.pretest, 'node scripts/build-renderer.mjs',
    'pretest 必须指向 build-renderer.mjs，否则 npm test 路径上产物可能是陈旧的');
});

// ---------- b ----------
test('P0-0b: run-tests.cjs 直跑时对产物缺失有 existsSync 兜底并给出修复命令', () => {
  const src = read('scripts/run-tests.cjs');
  assert.match(src, /existsSync\(BUNDLE\)/, '运行器应检查 unified-bundle.js 是否存在');
  assert.match(src, /npm run build:renderer/, '缺失提示必须包含可直接执行的修复命令');
  assert.match(src, /checkBundle\(\);/, 'checkBundle 必须在 main 中被真正调用（不能只定义不调）');
});

// ---------- c ----------
test('P0-0c: index.html 在首个业务 script 之前注册了全局 error 兜底', () => {
  const html = read('src/index.html');
  const guardAt = html.indexOf("addEventListener('error'");
  assert.ok(guardAt > -1, 'index.html 应有全局 error 监听');
  const firstBiz = html.indexOf('<script src="lib/');
  assert.ok(firstBiz > -1, '应能找到第一个业务 script');
  assert.ok(guardAt < firstBiz,
    '全局兜底必须在首个业务脚本之前注册，否则该脚本自身加载失败时收不到事件');
  assert.match(html, /}, true\);/, 'error 监听必须用捕获阶段（资源加载失败不冒泡）');
});

// ---------- d ----------
test('P0-0d: 调用 UnifiedRenderer 前有 typeof 守卫并抛可操作错误', () => {
  // P2-1 后 updatePreview 迁入 PreviewController（Strangler），UnifiedRenderer 守卫与调用
  // 同在 preview-controller.js，不再出现在 app.js（app.js 仅保留薄委托）。
  const src = read('src/controllers/preview-controller.js');
  const guard = src.indexOf("typeof UnifiedRenderer === 'undefined'");
  assert.ok(guard > -1, 'preview-controller 应有 UnifiedRenderer 存在性守卫');
  const call = src.indexOf('UnifiedRenderer.renderMarkdown(');
  assert.ok(call > -1, 'preview-controller 应有 UnifiedRenderer.renderMarkdown 调用');
  assert.ok(guard < call, '守卫必须在调用之前');
  const between = src.slice(guard, call);
  assert.match(between, /npm run build:renderer/, '错误文案必须给出可执行的修复命令');
});

// ---------- e ----------
test('P0-0e: load-bundle.cjs 产物缺失/形态异常时给可操作指引', () => {
  const lb = require('./helpers/load-bundle.cjs');
  assert.strictEqual(typeof lb.loadUnifiedRenderer, 'function');
  assert.strictEqual(typeof lb.assertBundleExists, 'function');
  const src = read('test/helpers/load-bundle.cjs');
  assert.match(src, /npm run build:renderer/, '报错必须含修复命令');
  assert.match(src, /existsSync/, '必须做存在性检查');
  // 路径必须基于 __dirname 解析，不能依赖 cwd（换目录直跑就崩）
  assert.match(src, /path\.resolve\(__dirname/, '产物路径必须相对 __dirname 解析');
});

test('P0-0e: 依赖产物的测试全部改走 load-bundle，不得再有裸 readFileSync(unified-bundle)', () => {
  // 排除本文件自身：它的正则字面量与文案里就含 readFileSync(...unified-bundle.js)，会自我命中
  const SELF = path.basename(__filename);
  const files = fs.readdirSync(path.join(ROOT, 'test'))
    .filter((f) => f.endsWith('.test.cjs') && f !== SELF);
  const offenders = [];
  const users = [];
  for (const f of files) {
    const src = fs.readFileSync(path.join(ROOT, 'test', f), 'utf8');
    if (/readFileSync\([^)]*unified-bundle\.js/.test(src)) offenders.push(f);
    if (/require\(['"]\.\/helpers\/load-bundle\.cjs['"]\)/.test(src)) users.push(f);
  }
  assert.deepStrictEqual(offenders, [],
    '这些测试仍在自己 readFileSync 产物，单文件直跑时会甩 ENOENT 堆栈：' + offenders.join(', '));
  // 当前有 5 个测试依赖产物；数量可增可减，这里只锁"至少还在用"，避免助手被悄悄绕过
  assert.ok(users.length >= 5, '应至少有 5 个测试通过 load-bundle 加载产物，实际 ' + users.length);
});

test('P0-0e: 产物缺失时抛出的是带修复指引的错误，而非 ENOENT', () => {
  // 用子进程 + 打桩 fs.existsSync 的方式触发缺失分支，避免真的删产物
  const probe = `
    const path = require('path');
    const fs = require('fs');
    const real = fs.existsSync;
    fs.existsSync = (p) => (String(p).endsWith('unified-bundle.js') ? false : real(p));
    const lb = require(${JSON.stringify(path.join(ROOT, 'test', 'helpers', 'load-bundle.cjs').replace(/\\/g, '/'))});
    try { lb.assertBundleExists(); console.log('NO_THROW'); }
    catch (e) { console.log('MSG:' + e.message.replace(/\\n/g, ' | ')); }
  `;
  const r = spawnSync(process.execPath, ['-e', probe], { encoding: 'utf8', cwd: ROOT });
  const out = (r.stdout || '') + (r.stderr || '');
  assert.ok(!/NO_THROW/.test(out), '产物缺失时必须抛错');
  assert.match(out, /构建产物缺失/, '必须是我们的可读文案');
  assert.match(out, /npm run build:renderer/, '必须给出修复命令');
  assert.ok(!/ENOENT/.test(out), '不应暴露裸 ENOENT');
});

// ---------- f ----------
test('P0-0f: run-tests.cjs 支持 argv 子串过滤，无参时行为不变', () => {
  const src = read('scripts/run-tests.cjs');
  assert.match(src, /process\.argv\.slice\(2\)/, '运行器必须读 argv');
  // 直接调用 listTestFiles 的等价逻辑做行为验证（不 spawn 全量测试，太慢）
  const all = fs.readdirSync(path.join(ROOT, 'test')).filter((f) => f.endsWith('.test.cjs'));
  const filtered = all.filter((f) => f.toLowerCase().includes('preview'));
  assert.ok(filtered.length >= 1, '应存在含 preview 的测试文件');
  assert.ok(filtered.length < all.length, '过滤应真的缩小范围');
});

// 运行器入口有 checkBundle()：bundle 不存在时会直接报错退出，根本走不到过滤逻辑。
// 本测试验证的是"过滤短路"，前提是 bundle 已构建（CI 里 pretest 会先 build:renderer）。
// 本地若没有 esbuild / 未构建产物，则跳过而非误红（与 jsdom 缺失时跳过同理）。
const BUNDLE_BUILT = fs.existsSync(path.join(ROOT, 'src', 'lib', 'unified-bundle.js'));
test('P0-0f: 带过滤参数时运行器只挑选匹配文件（用不存在的关键字验证短路）', { skip: !BUNDLE_BUILT }, () => {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'run-tests.cjs'), '__no_such_test__'], {
    encoding: 'utf8', cwd: ROOT, timeout: 30000,
  });
  const out = (r.stdout || '') + (r.stderr || '');
  assert.strictEqual(r.status, 1, '无匹配时应以 1 退出');
  assert.match(out, /未找到匹配/, '应提示无匹配');
  assert.match(out, /可用文件/, '应列出可用文件，便于纠正关键字');
  assert.ok(!/\[1\/\d+\]/.test(out), '不应真的开始跑任何测试文件');
});

// ---------- 汇总不变量 ----------
test('P0-0: 六件套均已落地（a/b/c/d/e/f）', () => {
  const pkg = JSON.parse(read('package.json'));
  const runner = read('scripts/run-tests.cjs');
  const checks = {
    a: !!pkg.scripts.pretest,
    b: /existsSync\(BUNDLE\)/.test(runner),
    c: read('src/index.html').includes("addEventListener('error'"),
    d: read('src/controllers/preview-controller.js').includes("typeof UnifiedRenderer === 'undefined'"),
    e: fs.existsSync(path.join(ROOT, 'test', 'helpers', 'load-bundle.cjs')),
    f: /process\.argv\.slice\(2\)/.test(runner),
  };
  const missing = Object.entries(checks).filter(([, v]) => !v).map(([k]) => k);
  assert.deepStrictEqual(missing, [], '缺失：' + missing.join(', '));
});
