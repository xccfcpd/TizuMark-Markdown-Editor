// 回归测试：引用块懒续 + 文字段紧接表格 的渲染。
// 历史 bug：原 convertContainerTables 仅在「表格紧邻 > 行」或「表格行本身带 >」时转换；
// 当引用块首行带 >、后续多段普通文字（无 >）懒续、末尾接表格（无空行）时，
// 表格检测失败，整段被当纯文本，<table> 不生成。
// 修复后：追踪容器懒续状态，且「无空行紧接的表格」统一转 HTML。
const test = require('node:test');
const assert = require('node:assert');
const { renderMarkdown } = require('../src/unified-renderer.js');

test('引用块首行带> + 多段普通文字懒续 + 末尾表格(无空行) → 表格渲染进引用块内', async () => {
  const md = [
    '> **本节结论**：平台以开发者代码场景为主。',
    '**分类体系**：12 类，多信号融合。',
    '**整体分布**：',
    '| 意图 | 总量 | 占比 |',
    '|------|------|------|',
    '| other | 5,482 | 27.0% |',
    '| code_review | 5,374 | 26.5% |',
  ].join('\n');
  const html = renderMarkdown(md, { softBreaks: false });
  assert.ok(/<table/.test(html), '应生成 <table>');
  assert.ok(/<blockquote[^>]*>[\s\S]*<table/.test(html), '表格应在 <blockquote> 内');
});

test('顶层段落紧接表格(无空行) → 渲染为顶层表格', async () => {
  const md = [
    '**整体分布**：',
    '| 意图 | 总量 |',
    '|------|------|',
    '| other | 5,482 |',
  ].join('\n');
  const html = renderMarkdown(md, { softBreaks: false });
  assert.ok(/<table/.test(html), '应生成 <table>');
  assert.ok(!/<blockquote/.test(html), '顶层表格不应在 blockquote 内');
});

test('有空行分隔的顶层表格 → 仍正常(remark 处理)', async () => {
  const md = [
    '以下是数据：',
    '',
    '| 意图 | 总量 |',
    '|------|------|',
    '| other | 5,482 |',
  ].join('\n');
  const html = renderMarkdown(md, { softBreaks: false });
  assert.ok(/<table/.test(html), '有空行分隔的表格应正常渲染');
});

test('引用块内每行带>的表格 → 仍在引用块内', async () => {
  const md = [
    '> **整体分布**：',
    '> | 意图 | 总量 |',
    '> |------|------|',
    '> | other | 5,482 |',
  ].join('\n');
  const html = renderMarkdown(md, { softBreaks: false });
  assert.ok(/<table/.test(html), '应生成 <table>');
  assert.ok(/<blockquote[^>]*>[\s\S]*<table/.test(html), '表格应在 <blockquote> 内');
});

// ===== 转换路径下单元格内的行内公式不得退化成占位符源码（用户复现 2026-09-13）=====
// 现场：`### 标题` 紧邻（无空行）希腊字母表，整张表的 $\alpha$ 等全部显示成
// <!--MATHBLOCK_380--> 文字。原因：convertContainerTables 把表格转成 HTML 时
// renderCellContent 用 escapeHTML 转义了单元格内容，占位符注释被转义成
// &lt;!--MATHBLOCK_380--&gt;，restoreMathBlocks 匹配不到，占位符就成了可见文字。

test('标题紧邻表格(无空行)内的行内公式还原为字面量，不残留占位符', async () => {
  const md = [
    '### 1.1 希腊字母',
    '| 类型 | 小写 | 大写 | 变体 |',
    '| --- | --- | --- | --- |',
    '| Alpha | $\\alpha$ | $A$ | - |',
    '| Gamma | $\\gamma$ | $\\Gamma$ | $\\varGamma$ |',
  ].join('\n');
  const html = renderMarkdown(md, { softBreaks: false });
  assert.ok(html.includes('<table'), '应渲染为 <table>');
  assert.strictEqual((html.match(/<td/g) || []).length, 8, '2 行 × 4 列 = 8 个单元格');
  assert.ok(!html.includes('MATHBLOCK'), '不应残留 MATHBLOCK 占位符（注释或 &lt;!-- 转义形态）');
  assert.ok(html.includes('$\\alpha$'), '公式应还原为字面量文本供 DOM 阶段 KaTeX 渲染');
  assert.ok(html.includes('$\\varGamma$'), '反斜杠命令公式应完整还原');
});

test('引用块内表格的单元格行内公式同样还原（容器转换路径）', async () => {
  const md = [
    '> 符号说明：',
    '> | 符号 | 含义 |',
    '> | --- | --- |',
    '> | $\\theta$ | 角度 |',
  ].join('\n');
  const html = renderMarkdown(md, { softBreaks: false });
  assert.ok(/<blockquote[^>]*>[\s\S]*<table/.test(html), '表格应在 <blockquote> 内');
  assert.ok(!html.includes('MATHBLOCK'), '引用块内表格不应残留占位符');
  assert.ok(html.includes('$\\theta$'), '公式应还原为字面量文本');
});
