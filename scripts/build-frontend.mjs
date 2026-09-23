// 前端 release 产物编排（ADR-4 完整落地）。
//
// 背景 / 实现方式：
//   ADR-4 目标：dev 走 src/（源码即运行）、release 走 dist/（独立产物目录）。
//   经典 <script> 全局模式（src/app.js 等普通 <script>，依赖 window.CodeMirror /
//   window.hljs / window.katex 等浏览器全局，非 ESM 模块图）在 dev server 下完全可用，
//   因此完整切换不需要 ESM 化。本脚本做「资源聚合拷贝」：把 src/ 整棵前端树
//   （含已生成的 unified-bundle.js 与 vendor 库）+ 顶层 assets 聚合到 dist/。
//   tauri.conf.json：frontendDist = ../dist（release 加载本目录）；
//   devUrl = http://localhost:1420 + beforeDevCommand 起 scripts/dev-server.mjs
//   （serve src/，改完即刷）。ESM 化/压缩属后续可选项，不做也不影响分离机制。
//
// 前置：必须先 npm run build:renderer（生成 src/lib/unified-bundle.js），否则预览渲染会白屏。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const srcDir = path.join(root, 'src');
const distDir = path.join(root, 'dist');
const assetsDir = path.join(root, 'assets');

function fail(msg) {
  console.error('[build-frontend] ✗ ' + msg);
  process.exit(1);
}

// 前置校验：unified-bundle 必须已生成（否则预览渲染会白屏）。
if (!fs.existsSync(path.join(srcDir, 'lib', 'unified-bundle.js'))) {
  fail('src/lib/unified-bundle.js 不存在，请先运行 `npm run build:renderer`');
}
if (!fs.existsSync(path.join(srcDir, 'index.html'))) {
  fail('src/index.html 缺失，无法编排前端');
}

// 清理旧 dist，避免残留过期文件。
// 健壮性：某些环境（如 WorkBuddy 开发沙箱）对批量递归删除有防护，rmSync 可能抛错；
// 回退为「重命名旧 dist 到临时名」继续构建，避免整个 release 构建被打断。
try {
  fs.rmSync(distDir, { recursive: true, force: true });
} catch (e) {
  const tmp = distDir + '.old-' + Date.now();
  try {
    if (fs.existsSync(distDir)) fs.renameSync(distDir, tmp);
    console.warn('[build-frontend] ⚠ 旧 dist 删除被拦截，已重命名为 ' + path.basename(tmp) + '（可手动清理）');
  } catch (e2) {
    fail('无法清空 dist：' + (e && e.message ? e.message : String(e)));
  }
}

let copied = 0;
function copyTree(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const s = path.join(from, entry.name);
    const d = path.join(to, entry.name);
    if (entry.isDirectory()) {
      copyTree(s, d);
    } else {
      fs.copyFileSync(s, d);
      copied += 1;
    }
  }
}

copyTree(srcDir, distDir);
// 顶层 assets（图标等）一并带进 dist，保证 release 产物自包含。
if (fs.existsSync(assetsDir)) {
  copyTree(assetsDir, path.join(distDir, 'assets'));
}

console.log(
  `✓ 前端已编排到 dist/（拷贝 ${copied} 个文件，含已生成的 unified-bundle.js 与 vendor 库）。\n` +
    '  tauri.conf.json frontendDist = ../dist（release 加载本目录）；dev 走 devUrl 静态 server（src/）。'
);

// 构建指纹：写进 dist/index.html 的 <body data-build="<sha> <时间>">，应用「关于」对话框会显示。
// 为什么需要：同一版本号可能对应多次构建，而 exe 里前端是**内嵌**的，没有指纹就无法判断
// 「手上这个包到底是哪次提交」——本仓库已因此把旧包的故障误当新代码的 bug 排查过三次。
// dev 不经过本脚本，故 dev 下该属性缺失，应用侧判空跳过。
function readGitSha() {
  try {
    const head = fs.readFileSync(path.join(root, '.git', 'HEAD'), 'utf8').trim();
    if (head.startsWith('ref:')) {
      const refFile = path.join(root, '.git', head.slice(4).trim());
      return fs.readFileSync(refFile, 'utf8').trim().slice(0, 7);
    }
    return head.slice(0, 7);
  } catch (_) { return ''; }
}
const stamp = [
  (process.env.GITHUB_SHA || '').slice(0, 7) || readGitSha() || 'unknown',
  new Date().toISOString().slice(0, 16).replace('T', ' '),
].join(' ');
try {
  const distIndex = path.join(distDir, 'index.html');
  const html = fs.readFileSync(distIndex, 'utf8');
  fs.writeFileSync(distIndex, html.replace(/<body([^>]*)>/i, '<body$1 data-build="' + stamp.replace(/"/g, '') + '">'));
  console.log('[build-frontend] 构建指纹 data-build="' + stamp + '" 已写入 dist/index.html');
} catch (e) {
  console.warn('[build-frontend] 构建指纹写入失败（不影响构建）：' + (e && e.message ? e.message : e));
}
