'use strict';
/**
 * 发布说明格式红线测试 —— 发布说明的骨架必须与 Gitee 上 v1.2.0 真实发布内容一致：
 *   1. `## ⬇️ 下载` + 三行下载链接
 *   2. `### 三种安装包说明` + 三行对比表格
 *   3. `---` 分隔线
 *   4. `## ✨ v<版本> 更新内容` + `### 新增` / `### 改进` / `### 修复` 三分类
 *   5. 尾部 `> 使用中遇到问题欢迎加 QQ 群：1035294939`
 *
 * 这些断言是硬约束，任何破坏模板结构的改动都会在这里失败（红线）。
 */
const test = require('node:test');
const assert = require('node:assert');
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const REPO = path.resolve(__dirname, '..');
const EN_PATH = path.join(REPO, 'RELEASE_NOTES_en.md');
function gitOk() {
  try { execSync('git rev-parse --git-dir', { cwd: REPO, stdio: 'ignore' }); return true; }
  catch { return false; }
}

const { VERSION, notesLines, lastTag, summarize, categorize, isInternalReleaseCommit } =
  require('../scripts/release-notes.js');
const BODY = notesLines.join('\n');

test('VERSION 与 package.json 一致', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
  assert.strictEqual(VERSION, pkg.version);
});

test('【格式红线】下载块：## 下载 + 三行链接（中文段）', () => {
  assert.ok(BODY.includes('## ⬇️ 下载'), '缺少下载标题');
  const zhPart = BODY.split('\n---\n')[0];
  const links = zhPart.match(/\[⬇ TizuMark_/g) || [];
  assert.strictEqual(links.length, 3, '中文下载块应有 3 个下载链接');
  for (const name of [`TizuMark_${VERSION}_x64-setup.exe`, `TizuMark_${VERSION}_x64_en-US.msi`, `TizuMark_${VERSION}_x64.exe`]) {
    assert.ok(BODY.includes(name), `下载块应包含 ${name}`);
    assert.ok(BODY.includes(`/v${VERSION}/`), `下载 URL 应使用 /v${VERSION}/`);
  }
});

test('【格式红线】安装包说明表格：标题 + 3 行表格 + 表头', () => {
  assert.ok(BODY.includes('### 三种安装包说明'), '缺少「三种安装包说明」标题');
  const table = BODY.match(/\| 安装包 \| 适用人群 \| 特点 \|/g) || [];
  assert.strictEqual(table.length, 1, '应有表头行');
  // 三行表格：NSIS（含 ⭐ 前缀）、MSI、绿色版
  assert.ok(BODY.includes('NSIS 安装包 (.exe)'), '表格应有 NSIS 行');
  assert.ok(BODY.includes('MSI 安装包 (.msi)'), '表格应有 MSI 行');
  assert.ok(BODY.includes('绿色版 (.exe)'), '表格应有绿色版行');
  assert.ok(BODY.includes('msiexec /i TizuMark_' + VERSION + '_x64_en-US.msi /qn'), 'MSI 行应含静默安装命令');
});

test('【格式红线】更新内容标题 + 三分类小节，顺序为 新增→改进→修复', () => {
  assert.ok(BODY.includes('## ✨ v' + VERSION + ' 更新内容'), '缺少更新内容标题');
  const idxNew = BODY.indexOf('### 新增');
  const idxImp = BODY.indexOf('### 改进');
  const idxFix = BODY.indexOf('### 修复');
  assert.ok(idxNew > -1 && idxImp > -1 && idxFix > -1, '缺少 新增/改进/修复 分类');
  assert.ok(idxNew < idxImp && idxImp < idxFix, '分类顺序必须是 新增→改进→修复');
  // 三分类在「更新内容」之后
  assert.ok(idxNew > BODY.indexOf('更新内容'), '分类应位于更新内容标题之后');
});

test('【格式红线】尾部以 QQ 群尾注结束', () => {
  const hasZhQQ = BODY.includes('> 使用中遇到问题欢迎加 QQ 群：1035294939');
  const hasEnQQ = BODY.includes('> Questions? Join QQ group: 1035294939');
  assert.ok(hasZhQQ, '应包含中文 QQ 群尾注');
  const tail = BODY.trimEnd();
  if (hasEnQQ) assert.ok(tail.endsWith('> Questions? Join QQ group: 1035294939'), '双语时应以英文 QQ 群尾注结束');
  else assert.ok(tail.endsWith('> 使用中遇到问题欢迎加 QQ 群：1035294939'), '仅中文时应以中文 QQ 群尾注结束');
});

test('【格式】双语：含英文下载块与 Changelog 分类（提供英文文件时）', () => {
  const enPath = EN_PATH;
  if (!fs.existsSync(enPath)) return; // 未提供英文文件时跳过
  assert.ok(BODY.includes('## ⬇️ Download'), '双语应包含英文下载标题');
  assert.ok(BODY.includes('## ✨ v' + VERSION + ' Changelog'), '双语应包含英文更新内容标题');
  assert.ok(BODY.includes('### Added') && BODY.includes('### Improved') && BODY.includes('### Fixed'), '双语英文分类应含 Added/Improved/Fixed');
});

test('【内容】不含面向内部的备注（人工复核/自xx起/仅警告等）', () => {
  assert.ok(!/人工复核|请人工|自动归纳|自 v\d.*起共|仅警告|不致命|调试/i.test(BODY), 'body 不应含内部备注: ' + BODY);
});

test('【内容】不含 markdown 代码块（避免 Gitee 渲染异常）', () => {
  assert.ok(!BODY.includes('```'), 'body 不应包含 ``` 代码块');
});

test('【内容】lastTag 选出的基准严格小于当前 VERSION', () => {
  if (!gitOk()) return;
  const prev = lastTag();
  if (!prev) return; // 首发版本
  const pa = prev.replace(/^v/, '').split('.').map((n) => parseInt(n, 10));
  const pb = VERSION.replace(/^v/, '').split('.').map((n) => parseInt(n, 10));
  for (let i = 0; i < 3; i++) {
    const a = pa[i] || 0, b = pb[i] || 0;
    if (a < b) return;
    if (a > b) break;
  }
  assert.fail(`基准 tag (${prev}) 应严格小于 VERSION (${VERSION})`);
});

test('【内容】提交归纳覆盖全部提交（除内部发布提交）', () => {
  if (!gitOk()) return;
  const prev = lastTag();
  const range = prev ? `${prev}..HEAD` : 'HEAD';
  const out = execSync('git log ' + range + ' --pretty=format:%s', { cwd: REPO, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
  const commits = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const visible = commits.filter((c) => !isInternalReleaseCommit(c));
  const summarized = commits.filter((c) => !isInternalReleaseCommit(c)).map((c) => summarize(c));
  // 每条可见提交都应有对应归纳（允许去重后比原文少）
  assert.ok(summarized.length >= 1, '应有至少 1 条可见提交');
  assert.ok(summarized.every((s) => s && s.length > 0), '每条提交都应归纳出非空条目');
  assert.ok(visible.length >= summarized.length, '归纳不应超过可见提交数');
});

test('categorize 归类正确', () => {
  assert.strictEqual(categorize('feat: 新增导出'), 'new');
  assert.strictEqual(categorize('fix: 修复崩溃'), 'fix');
  assert.strictEqual(categorize('refactor: 统一下拉框'), 'improve');
  assert.strictEqual(categorize('代码描述：【TizuMark】修复文件树复制粘贴 - 布局'), 'fix');
});

test('isInternalReleaseCommit 识别内部发布提交', () => {
  assert.ok(isInternalReleaseCommit('release: v1.2.0 重新打包'));
  assert.ok(isInternalReleaseCommit('chore: release v1.2.1'));
  assert.ok(!isInternalReleaseCommit('feat: 真实 DOCX 导出'));
  assert.ok(!isInternalReleaseCommit('fix: 在线更新下载失败'));
});

test('summarize 去 Conventional Commits 前缀与代码描述元信息', () => {
  assert.strictEqual(summarize('feat: 真实 DOCX 导出'), '真实 DOCX 导出');
  assert.strictEqual(summarize('fix(侧边栏): 大纲美化'), '大纲美化');
  const out = summarize('代码描述：【TizuMark】修复文件树复制粘贴 - 大文件提示条合并 - 同步测试 需求名称：xxx');
  assert.ok(out.startsWith('修复文件树复制粘贴'), '应取主句: ' + out);
  assert.ok(!out.includes('需求名称'), '应去掉需求名称');
});

test('summarize 去除反引号（含 ``` 围栏标记），避免泄漏进 Release 正文', () => {
  // 提交主题偶尔会带 ```math / ```dot 之类写法（如数学渲染修复、Graphviz 引擎提交）
  const a = summarize('fix(renderer): 围栏识别兼容引用块内的 ``` （回归风险）');
  const b = summarize('feat(diagram): 新增 Graphviz 引擎（```dot / ```graphviz / ```gv）');
  assert.ok(!a.includes('`'), '不应含反引号: ' + a);
  assert.ok(!b.includes('`'), '不应含反引号: ' + b);
  assert.ok(a.includes('围栏识别'), '中文语义应保留: ' + a);
  assert.ok(b.includes('Graphviz'), '中文语义应保留: ' + b);
});
