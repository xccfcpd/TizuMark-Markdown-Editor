// 一次性脚本：提交本轮（图表两阶段占位 + 移除「联系我们」板块）并推送 + retag
const { execFileSync } = require('child_process');
const G = 'C:/Program Files/Portable/VSCode/git/cmd/git.exe';
const R = 'c:/Users/Administrator/.vscode/TizuMark-Markdown-Editor';
const T = 'build-win-more-function-20260923';

function raw(args) {
  try {
    return { ok: true, out: (execFileSync(G, args, { cwd: R, encoding: 'utf8', maxBuffer: 1 << 24, timeout: 150000 }) || '').trim() };
  } catch (x) {
    return { ok: false, out: String(x.stdout || x.stderr || '').trim().split('\n').slice(-1)[0] };
  }
}

const name = raw(['config', 'user.name']).out;
const mail = raw(['config', 'user.email']).out;
const ID = (name && mail) ? [] : ['-c', 'user.name=xccfcpd', '-c', 'user.email=xccfcpd@users.noreply.github.com'];
const g = (args) => raw(ID.concat(args));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const MSG = [
  'fix(preview,ui): 图表源码不再闪动（占位提前到 await 之前）+ 移除「联系我们」板块',
  '',
  '闪动根因：占位做得太晚 —— processDiagrams / processMermaid 都排在 await processImages()',
  '之后，等待期间图表块仍是源码形态，于是每轮重渲染都重演「先源码、后被图替换」。',
  '',
  '- preview-post: processMermaid / processDiagrams 拆为「同步占位 + 异步渲染」两阶段，',
  '  新增组合入口 prepareDiagramPlaceholders / renderDiagramPlaceholders（旧函数保留为兼容包装）',
  '- preview-controller: innerHTML 之后立刻同步占位；渲染统一走 renderDiagramPlaceholders',
  '- preview-post: mermaid 的 .diagram-pending 改在 finally 摘除 —— 修「图已渲出、中间仍压着',
  '  一行『图表渲染中…』」（initialize / run 抛错时整批占位摘不掉）',
  '- styles: 新增 pre.diagram-src-pending（visibility 隐藏 code + 居中占位，保住原高度）',
  '- About 对话框: 删除「联系我们」面板（QQ 群 / Gitee / GitHub + 说明行），以及对应 JS 监听、',
  '  CSS 规则、9 个 i18n 键（中英）、三个图标；许可协议 / 第三方组件索引前移，避免中英切换串位',
  '- test: preview-post 新增 3 例两阶段回归（占位生效 / 缓存命中不再占位 / 失败也摘占位）',
  '- docs: 记录 §2.18',
].join('\n');

(async () => {
  console.log('add   : ' + (g(['add', '-A']).ok ? 'ok' : 'fail'));
  const c = g(['commit', '-m', MSG]);
  console.log('commit: ' + (c.ok ? c.out.split('\n')[0] : c.out));

  let pushed = false;
  for (let i = 1; i <= 5; i++) {
    const p = g(['push', 'origin', 'HEAD:more-function']);
    console.log('推送' + i + ' : ' + (p.ok ? ('成功  ' + p.out.replace(/\s+/g, ' ')) : p.out));
    if (p.ok) { pushed = true; break; }
    if (i < 5) await sleep(20000);
  }

  if (pushed) {
    console.log('retag : ' + (g(['tag', '-f', '-a', T, '-m', 'build-win: diagram placeholder two-phase + remove contact panel']).ok ? 'ok' : 'fail'));
    const t = g(['push', '-f', 'origin', 'refs/tags/' + T]);
    console.log('推tag : ' + (t.ok ? ('成功  ' + t.out.replace(/\s+/g, ' ')) : t.out));
  } else {
    console.log('（网络不通：已提交，留在本地）');
  }

  console.log('--- status ---');
  console.log(g(['status', '-sb']).out);
  console.log('HEAD=' + g(['--no-pager', 'log', '-1', '--format=%h %s']).out);
})();
