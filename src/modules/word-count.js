// 字数 / 字符 / 行数统计：从 app.js 的 updateWordCount 抽取纯计算部分。
// 设计：纯函数不依赖 DOM 或 this，便于单独测试、降低改动爆炸半径。
//   - countStats(content, opts): 返回 { words, chars, lines }（编辑器源码口径）
//       * opts.skipWords: true 时跳过 words 计算（字段仍返回 0），供只要 chars/lines 的调用方省开销
//       * words: 去除 markdown 标记符号并按空白分词后的词数
//       * chars: 原始字符数（含换行）
//       * lines: 按 \n 切分的行数（空内容记为 0）
//   - countPreviewText(previewRoot): 返回预览「可见文本」的字符数（渲染后口径）
//       * 遍历 DOM 文本节点，跳过隐藏区（script/style/noscript）、图形内部文字
//         （mermaid svg、KaTeX 的隐藏 MathML）与代码复制按钮等非正文节点；
//       * 代码块文字、表格文字、图片 alt 计入（读者实际能看到的内容）。

// opts.skipWords：跳过词数统计。状态栏只用 chars / lines，而词数需要把整篇内容做
// 两次全量正则替换再逐字符扫描 —— 大文档下每次防抖键入都是纯浪费（审计发现，2026-09-26）。
// 默认仍统计，返回值与既有测试口径不变。
function countStats(content, opts) {
  const raw = content || '';
  const chars = raw.length;
  // 行数：按换行符扫描计数，避免 split('\n') 生成 N 个子串（大文档下是明显开销）。空内容记 0。
  let lines = 0;
  if (raw) {
    lines = 1;
    for (let i = 0; i < raw.length; i++) if (raw.charCodeAt(i) === 10) lines++;
  }
  let words = 0;
  if (!(opts && opts.skipWords)) {
    const text = raw
      .replace(/[#*`~\[\]()>_|\\-]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    // 词数：text 已被折叠成「单空格分隔 + trim」，故词数 = 空格数 + 1 —— 避免 split(/\s+/) 分配大数组。
    if (text) {
      let sp = 0;
      for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 32) sp++;
      words = sp + 1;
    }
  }
  return { words, chars, lines };
}

// 从根元素统计预览可见文本字符数。纯 DOM 遍历，无副作用。
function countPreviewText(previewRoot) {
  if (!previewRoot) return 0;
  let count = 0;
  const walk = (node) => {
    if (node.nodeType === 3) { // text node
      count += (node.textContent || '').length;
      return;
    }
    if (node.nodeType !== 1) return;
    const el = node;
    const tag = el.tagName ? el.tagName.toLowerCase() : '';
    // 跳过的容器：脚本/样式、隐藏的 KaTeX MathML、图形类（mermaid 的 svg、
    // 数学/流程图内部文字不应计入「可见文本」）、复制按钮等 UI 元素
    if (tag === 'script' || tag === 'style' || tag === 'noscript') return;
    if (el.classList && (
      el.classList.contains('katex-mathml') ||
      el.classList.contains('copy-btn') ||
      el.classList.contains('code-line-num')
    )) return;
    if (tag === 'svg') return;
    // 显式隐藏/零尺寸的元素跳过（避免排版残留文本重复计数）
    if (el.hidden) return;
    const style = el.style;
    if (style && (style.display === 'none' || style.visibility === 'hidden')) return;
    for (const child of el.childNodes) walk(child);
  };
  walk(previewRoot);
  return count;
}

// 浏览器：作为独立 <script> 加载，挂到全局 WordCount
if (typeof window !== 'undefined' && typeof module === 'undefined') {
  window.WordCount = { countStats, countPreviewText };
}
// Node（测试 / 构建）：CommonJS 导出
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { countStats, countPreviewText };
}
