// 代码块后处理：语法高亮（highlight.js）+ 行号包裹 + 缓存。
// 从 app.js 的 renderPreview 中抽取，独立后可单独测试、降低改动爆炸半径。
//
// 设计：纯函数式，依赖通过参数注入，不隐式读取全局 this。
//   - preview: 预览容器元素（含 <pre><code> 结构）
//   - opts.hljs: highlight.js 实例（浏览器传 window.hljs，测试传加载的实例）
//   - opts.cache: 缓存 Map（对应原 app.js 的 this._hljsCache）
//   - opts.lineNumbers: 是否开启行号（对应原 preview.classList.contains('code-line-numbers')）
//
// 关键修复（避免预览代码块出现多余 [] / 结构破损）：
//   1. 已包裹 .code-scroll 的块直接跳过，避免对已包装内容重复切分/高亮；
//   2. 高亮前清除 hljs 的 dataset.highlighted，消除 "previously highlighted" 警告与错误处理；
//   3. 缓存键纳入行号状态，开/关行号不共用不匹配 display 规则的缓存；
//   4. 行号包裹在语法高亮之前完成：按原始文本行拆分并包装，再对每行单独高亮。
//      这避免 highlight.js 的跨行 <span>（如 gherkin 对 |...| 的字符串包裹）被 block.innerHTML.split('\n')
//      在标签中间切断，导致预览代码块 HTML 结构破碎、换行错乱。

function escapeHTML(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;');
}

function detectLanguage(hljs, block) {
  const cls = block.className || '';
  const m = cls.match(/language-([a-zA-Z0-9_-]+)/);
  if (m) return m[1];
  try {
    const auto = hljs.highlightAuto(block.textContent);
    return auto.language || null;
  } catch (_) {
    return null;
  }
}

function highlightLine(hljs, lang, line) {
  if (!lang || !hljs.getLanguage(lang)) return escapeHTML(line);
  try {
    return hljs.highlight(line, { language: lang, ignoreIllegals: true }).value;
  } catch (_) {
    return escapeHTML(line);
  }
}

function buildCodeScroll(lines, hljs, lang) {
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
  if (lines.length <= 1) {
    return `<div class="code-scroll">${highlightLine(hljs, lang, lines[0] || '')}</div>`;
  }
  return `<div class="code-scroll">${
    lines.map((line, i) =>
      `<span class="code-line"><span class="code-line-num">${i + 1}</span><span class="code-line-text">${highlightLine(hljs, lang, line) || '&nbsp;'}</span></span>`
    ).join('')
  }</div>`;
}

function buildCodeScrollNoHljs(lines) {
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
  if (lines.length <= 1) {
    return `<div class="code-scroll">${escapeHTML(lines[0] || '')}</div>`;
  }
  return `<div class="code-scroll">${
    lines.map((line, i) =>
      `<span class="code-line"><span class="code-line-num">${i + 1}</span><span class="code-line-text">${escapeHTML(line) || '&nbsp;'}</span></span>`
    ).join('')
  }</div>`;
}

function processCodeBlocks(preview, opts) {
  const { hljs, cache, lineNumbers } = opts;
  const lineNumOn = !!lineNumbers;

  if (typeof hljs !== 'undefined' && hljs) {
    try {
      preview.querySelectorAll('pre code').forEach((block) => {
        const cls = block.className || '';
        if (/language-(math|mermaid|katex)/.test(cls)) return;
        // 图表块一律不碰：mermaid 系（含 PlantUML / D2 转换结果）的源码要在渲染阶段被引擎
        // 原样读取（.code-line 包裹会把 textContent 弄脏）；原生引擎块此刻已是占位容器，
        // 这里再兜一层以防顺序变化。
        if (block.closest && block.closest('pre.diagram-src-pending, .diagram-container')) return;
        // 已包裹过（上一次渲染的结果）直接跳过，避免对已包 code-line 的内容重复切分/高亮
        if (block.querySelector('.code-scroll')) return;
        // 缓存键纳入行号状态：开/关行号不共用可能不匹配 display 规则的缓存
        const key = block.textContent + '|' + (lineNumOn ? 1 : 0);
        const cached = cache.get(key);
        if (cached !== undefined) {
          block.innerHTML = cached;
          // 关键修复：bundle 输出的 <code> 没有 hljs class（bundle 不调 hljs），
          // 而 hljs github.min.css / styles.css 的 pre code.hljs { display:block } 依赖此 class。
          // 缓存命中路径只设 innerHTML 不调 hljs.highlightElement，导致重渲染后 <code> 缺 hljs class
          // → 默认 display:inline → 内嵌 <div class="code-scroll"> 不合法 → 浏览器把 inline <code>
          // 打断成两段，预览出现两个浅色矩形装饰。
          if (!block.classList.contains('hljs')) block.classList.add('hljs');
          return;
        }
        // 清除 hljs 上次高亮标记，避免 "previously highlighted" 警告与错误处理（行号数字被错误叠入文本）
        if (block.dataset.highlighted) {
          delete block.dataset.highlighted;
          block.className = (block.className || '').replace(/\bhljs\b/g, '').trim();
        }
        // 先按原始文本拆分行并包裹行号，再对每行单独高亮，避免跨行 span 被切断。
        const lang = detectLanguage(hljs, block);
        const lines = block.textContent.split('\n');
        const finalHtml = buildCodeScroll(lines, hljs, lang);
        block.innerHTML = finalHtml;
        block.classList.add('hljs');
        if (lang && !block.classList.contains(`language-${lang}`)) {
          block.classList.add(`language-${lang}`);
        }
        block.dataset.highlighted = 'yes';
        cache.set(key, finalHtml);
      });
    } catch (e) {
      if (typeof console !== 'undefined') console.warn('[preview] HLJS error:', e);
    }
  } else {
    // 代码块行号（拆分代码行，CSS 控制行号显隐和换行）
    try {
      preview.querySelectorAll('pre code').forEach((block) => {
        if (block.querySelector('.code-scroll')) return;
        const lines = block.textContent.split('\n');
        block.innerHTML = buildCodeScrollNoHljs(lines);
      });
    } catch (e) {
      if (typeof console !== 'undefined') console.warn('[preview] Code line error:', e);
    }
  }
}

// 浏览器：作为独立 <script> 加载，挂到全局 CodeBlock（与 unified-renderer.js 的 UnifiedRenderer 一致）
if (typeof window !== 'undefined' && typeof module === 'undefined') {
  window.CodeBlock = { processCodeBlocks };
}
// Node（测试 / 构建）：CommonJS 导出
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { processCodeBlocks };
}
