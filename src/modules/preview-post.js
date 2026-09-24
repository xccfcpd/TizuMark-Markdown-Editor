// 预览后处理聚合：emoji 短码、数学(KaTeX)、缩写(abbr)、标题锚点、Mermaid、复制按钮。
// 从 app.js 的 renderPreview 中抽取，独立后可单独测试、降低改动爆炸半径。
//
// 设计：每个函数接收 (preview, opts)，依赖通过 opts 注入，不隐式读取全局 this：
//   - preview: 预览容器元素
//   - opts.t: i18n 函数（复制按钮文案）
//   - opts.isDark: 是否深色主题（Mermaid 主题）
//   - opts.escapeHtml / escapeAttr / headingToId: 纯函数（由 app.js 传入，保持既有一致行为）
// 全局依赖：document / navigator / getComputedStyle / mermaid / renderMathInElement（浏览器环境提供）。

const EMOJI_MAP = {
  ':smile:': '😄', ':joy:': '😂', ':heart:': '❤️', ':thumbsup:': '👍',
  ':thumbsdown:': '👎', ':clap:': '👏', ':wave:': '👋', ':fire:': '🔥',
  ':star:': '⭐', ':check:': '✅', ':x:': '❌', ':warning:': '⚠️',
  ':memo:': '📝', ':bulb:': '💡', ':info:': 'ℹ️', ':question:': '❓',
  ':exclamation:': '❗', ':ok:': '👌', ':cool:': '😎', ':sad:': '😢',
  ':angry:': '😠', ':love:': '😍', ':laughing:': '😆', ':wink:': '😉',
  ':thinking:': '🤔', ':rocket:': '🚀', ':100:': '💯', ':tada:': '🎉',
  ':trophy:': '🏆', ':eyes:': '👀', ':pray:': '🙏', ':muscle:': '💪',
  ':sparkles:': '✨', ':zap:': '⚡', ':sunny:': '☀️', ':cloud:': '☁️',
  ':rain:': '🌧️', ':snow:': '🌨️', ':coffee:': '☕', ':book:': '📖',
  ':pencil:': '✏️', ':computer:': '💻', ':phone:': '📱', ':email:': '📧',
  ':calendar:': '📅', ':clock:': '⏰', ':gift:': '🎁', ':balloon:': '🎈',
  ':party:': '🎉', ':crown:': '👑', ':gem:': '💎', ':key:': '🔑',
  ':lock:': '🔒', ':bell:': '🔔', ':mag:': '🔍', ':package:': '📦',
  ':earth:': '🌍', ':moon:': '🌙', ':rainbow:': '🌈', ':umbrella:': '☂️',
  ':cyclone:': '🌀', ':ocean:': '🌊', ':seedling:': '🌱', ':tree:': '🌳',
  ':flower:': '🌼', ':rose:': '🌹', ':dog:': '🐕', ':cat:': '🐈',
  ':bear:': '🐻', ':bird:': '🐦', ':fish:': '🐟', ':turtle:': '🐢',
  ':octopus:': '🐙', ':penguin:': '🐧', ':butterfly:': '🦋', ':bee:': '🐝',
  ':art:': '🎨', ':music:': '🎵', ':film:': '🎬', ':camera:': '📷',
  ':unlock:': '🔓', ':link:': '🔗', ':scissors:': '✂️', ':pushpin:': '📌'
};

function processEmojiShortcodes(preview) {
  const emojiMap = EMOJI_MAP;
  const skipTags = ['CODE', 'PRE', 'ABBR', 'SCRIPT', 'STYLE', 'TEXTAREA', 'A'];
  const walker = document.createTreeWalker(
    preview,
    NodeFilter.SHOW_TEXT,
    {
      acceptNode: (node) => {
        let p = node.parentElement;
        while (p) {
          if (skipTags.includes(p.tagName)) return NodeFilter.FILTER_REJECT;
          if (p.classList && p.classList.contains('katex')) return NodeFilter.FILTER_REJECT;
          p = p.parentElement;
        }
        return NodeFilter.FILTER_ACCEPT;
      }
    },
    false
  );
  const textNodes = [];
  let node;
  while (node = walker.nextNode()) textNodes.push(node);

  textNodes.forEach(textNode => {
    const text = textNode.textContent;
    if (!text.includes(':')) return;
    let newText = text;
    for (const [code, emoji] of Object.entries(emojiMap)) {
      if (newText.includes(code)) newText = newText.split(code).join(emoji);
    }
    if (newText !== text) textNode.textContent = newText;
  });
}

// 将文本中"不成对"的 $ / $$ 包进 <span class="katex-ignore">，让 KaTeX 跳过后处理、
// 原样显示 $，同时避免 KaTeX 把孤 $ 跨段配对吞掉内容。
// 规则：成对 $...$ / $$...$$ 保持原样（交给 KaTeX 渲染）；不成对的 $ 包忽略 span。
function isLineBoundary(ch) {
  return ch === undefined || ch === '\n' || ch === '\r' || ch === ' ' || ch === '\t';
}

// 判断行内 $...$ 的内容是否像数学公式（含反斜杠、下标/上标、花括号、运算符等），
// 用于在前后都带空格时避免把 "$ 100 $" "$ or $" 这类货币/短词误判为公式。
function looksLikeMath(inner) {
  const t = inner.trim();
  if (!t) return false;
  // 包含明显数学标记：反斜杠、下标/上标、花括号、对齐符、
  // 常用数学运算符/关系符（> < = + - * / |）以及 ° ± × ÷ ≤ ≥ ≠ ≈ ∞ 等符号；
  // ASCII 单引号 ' 视为求导/素数标记（如 R'、f'）。
  if (/[\\{}_^&#@=+\-*/|<>°±×÷≤≥≠≈∞∈∪∩⊂⊃∑∏∫√′″']/.test(t)) return true;
  // 单字母变量（含希腊字母 Unicode 范围）也视为数学符号；
  // 仅放行单字符，避免 "$ 100 $" "$ or $" 等货币/短词被误判。
  if (/^[A-Za-z\u0370-\u03FF\u1F00-\u1FFF]$/.test(t)) return true;
  return false;
}

function protectUnpairedDollar(text) {
  let out = '';
  let i = 0;
  const n = text.length;
  while (i < n) {
    if (text[i] === '$' && i + 1 < n && text[i + 1] === '$') {
      // 仅当 $$ 处于"块级"边界（前后为行首/行尾/空白）时才视为显示公式 $$...$$
      const openOk = isLineBoundary(text[i - 1]);
      const close = text.indexOf('$$', i + 2);
      // 块级放宽：只要 $$ 自身成对 + 闭合 $$ 后跟行边界就信任，让 KaTeX 自己用 throwOnError:false 容错。
      // 块级允许跨行（多行 LaTeX 公式），也允许内含 | > ｜（条件概率/绝对值/范数/比较符号等是合法 LaTeX）。
      // 行内 $...$ 也允许 | > ｜；仅在文本节点里还存在另一个 | 时保守跳过，避免把表格单元格分隔符吞进数学。
      const closeOk = close !== -1 &&
        (close + 2 === n || isLineBoundary(text[close + 2])) &&
        (text[close - 1] !== '$');
      if (openOk && closeOk) {
        out += text.substring(i, close + 2);
        i = close + 2;
        continue;
      }
      // 不成对的 $$：包忽略 span（两个独立 $）
      out += '<span class="katex-ignore">$$</span>';
      i += 2;
    } else if (text[i] === '$') {
      // 行内 $...$ 允许前后带空格，但闭合 $ 前是空白且 inner 不像数学时，
      // 保守视为文本边界（如 "$ 100 $"），避免跨段配对吞掉后续真正公式。
      if (i + 1 < n && text[i + 1] !== '$' && text[i + 1] !== '\n' && text[i + 1] !== '\r') {
        const close = text.indexOf('$', i + 1);
        const inner = text.substring(i + 1, close);
        const closePrevIsSpace = close !== -1 &&
          (text[close - 1] === ' ' || text[close - 1] === '\n' || text[close - 1] === '\r' || text[close - 1] === '\t');
        if (close !== -1 &&
            !(closePrevIsSpace && !looksLikeMath(inner)) &&
            !/[\n\r]/.test(inner) &&
            // | 在 inner 内紧邻空白（^|\s \|(?:\s|$)）才是表格列分隔符形态；
            // 紧邻非空白（如 P(A|B)、k|z）是合法数学符号。
            // 修复：只检查 inner 内部的 | 紧邻空白，不再去 $ 前后整个文本里找 |，
            // 否则相邻多个含 | 的合法公式（如 $F\hat{x}_{k-1|k-1}$ $\hat{x}_{k|k-1}=...$）
            // 会因为下一个公式的 | 误把前一个 reject、成对公式被错误包成 ignore span，
            // 导致 KaTeX 跳过 → 预览里只剩 $...$ 源码。
            !/(?:^|\s)\|(?:\s|$)/.test(inner) &&
            (close + 1 >= n || text[close + 1] !== '$')) {
          out += text.substring(i, close + 1);
          i = close + 1;
          continue;
        }
      }
      out += '<span class="katex-ignore">$</span>';
      i += 1;
    } else {
      out += text[i];
      i += 1;
    }
  }
  return out;
}
function processMath(preview) {
  if (typeof renderMathInElement === 'undefined') {
    if (typeof console !== 'undefined') console.warn('[math] renderMathInElement not loaded');
    return;
  }
  try {
    // 先把不成对的 $ / $$ 包进 <span class="katex-ignore">，让 KaTeX 跳过、原样显示 $，
    // 避免孤 $ 跨段配对吞掉正文/表格。
    const skipTags = ['CODE', 'PRE', 'SCRIPT', 'STYLE', 'TEXTAREA'];
    const walker = document.createTreeWalker(
      preview,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode: (node) => {
          let p = node.parentElement;
          while (p) {
            if (skipTags.includes(p.tagName)) return NodeFilter.FILTER_REJECT;
            if (p.classList && p.classList.contains('katex')) return NodeFilter.FILTER_REJECT;
            p = p.parentElement;
          }
          return NodeFilter.FILTER_ACCEPT;
        }
      },
      false
    );
    const toProtect = [];
    let node;
    while (node = walker.nextNode()) {
      if (node.textContent.includes('$')) toProtect.push(node);
    }
    for (const t of toProtect) {
      const protectedHTML = protectUnpairedDollar(t.textContent);
      if (protectedHTML !== t.textContent) {
        // 用临时容器把含 span 的 HTML 解析为节点片段，替换原文本节点
        const tmp = document.createElement('div');
        tmp.innerHTML = protectedHTML;
        const frag = document.createDocumentFragment();
        while (tmp.firstChild) frag.appendChild(tmp.firstChild);
        t.parentNode.replaceChild(frag, t);
      }
    }

    // 公式自动编号：unified-renderer 给带 \label 的块级公式标注了统一锚点 data-eq-anchor
    // （自动编号 eq-N / 自定义 \tag eql-<slug>），这里把它落成 id，
    // 使 \eqref / \ref / \cref / \autoref 生成的 #锚点 都能跳转到对应公式。
    preview.querySelectorAll('[data-eq-anchor]').forEach((el) => {
      const a = el.getAttribute('data-eq-anchor');
      if (a && !el.id) el.id = a;
    });
    // 兼容旧产物（只带 data-eq-number 的 HTML）
    preview.querySelectorAll('[data-eq-number]').forEach((el) => {
      const n = el.getAttribute('data-eq-number');
      if (n && !el.id) el.id = 'eq-' + n;
    });

    renderMathInElement(preview, {
      delimiters: [
        { left: '$$', right: '$$', display: true },
        { left: '$', right: '$', display: false },
        { left: '\\(', right: '\\)', display: false },
        { left: '\\[', right: '\\]', display: true }
      ],
      throwOnError: false,
      ignoredTags: ['script', 'noscript', 'style', 'textarea', 'pre', 'code'],
      ignoredClasses: ['katex-ignore'],
      // 只信任指向文内锚点（#eq-N）的 \href —— 公式编号交叉引用所需。
      // 其余 \href / \url / \includegraphics 一律不信任，保持 KaTeX 默认安全姿态。
      trust: (context) => !!context && context.command === '\\href' &&
        typeof context.url === 'string' && context.url.charAt(0) === '#'
    });

    // 公式编号「点一下复制 \eqref{label}」：KaTeX 把 \tag 渲染成 .tag 元素，
    // 绑在它上面（找不到则退到整个公式块）。data-eq-label 由 unified-renderer 输出；
    // 用 dataset 标记避免重复绑定（预览会反复重渲染，否则监听器会累积）。
    preview.querySelectorAll('[data-eq-label]').forEach((el) => {
      if (el.dataset.eqCopyBound) return;
      el.dataset.eqCopyBound = '1';
      const label = el.getAttribute('data-eq-label');
      if (!label) return;
      const tex = '\\eqref{' + label + '}';
      const target = el.querySelector('.katex-display .tag, .tag') || el;
      target.classList.add('eq-copy-target');
      target.setAttribute('title', tex);
      target.addEventListener('click', async (ev) => {
        ev.preventDefault();
        try {
          await navigator.clipboard.writeText(tex);
        } catch (_e) {
          // 与代码块复制按钮同一套降级：WebView 里 clipboard API 可能不可用
          const ta = document.createElement('textarea');
          ta.value = tex;
          document.body.appendChild(ta);
          ta.select();
          try { document.execCommand('copy'); } catch (_e2) { /* 复制失败：静默，不影响阅读 */ }
          document.body.removeChild(ta);
        }
        target.classList.add('eq-copied');
        setTimeout(() => target.classList.remove('eq-copied'), 1200);
      });
    });
  } catch (e) {
    if (typeof console !== 'undefined') console.warn('[math] auto-render error:', e);
  }
}

function processAbbreviations(preview, opts) {
  const { escapeAttr, escapeHtml } = opts;
  const dataDiv = preview.querySelector('#abbr-data');
  if (!dataDiv) return;
  try {
    const abbrs = JSON.parse(dataDiv.getAttribute('data-abbrs'));
    if (!abbrs || !abbrs.length) { dataDiv.remove(); return; }

    abbrs.sort((a, b) => b[0].length - a[0].length);

    const skipTags = ['CODE', 'PRE'];
    const walker = document.createTreeWalker(
      preview,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode: (node) => {
          let p = node.parentElement;
          while (p) {
            if (skipTags.includes(p.tagName)) return NodeFilter.FILTER_REJECT;
            if (p.classList && p.classList.contains('katex')) return NodeFilter.FILTER_REJECT;
            p = p.parentElement;
          }
          return NodeFilter.FILTER_ACCEPT;
        }
      },
      false
    );

    const replacements = [];
    let node;
    while (node = walker.nextNode()) {
      let text = node.textContent;
      let modified = false;

      for (const [term, def] of abbrs) {
        if (!text.includes(term)) continue;
        const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const regex = new RegExp(`(?<![a-zA-Z0-9])${escaped}(?![a-zA-Z0-9])`, 'g');
        if (regex.test(text)) {
          modified = true;
          const safeDef = escapeAttr(def);
          const safeTerm = escapeHtml(term);
          text = text.replace(regex, `<abbr title="${safeDef}">${safeTerm}</abbr>`);
        }
      }

      if (modified) replacements.push({ node, html: text });
    }

    for (const { node, html } of replacements) {
      const span = document.createElement('span');
      span.innerHTML = html;
      node.replaceWith(...span.childNodes);
    }

    dataDiv.remove();
  } catch (e) {
    if (typeof console !== 'undefined') console.warn('[preview] Abbreviations error:', e);
    dataDiv.remove();
  }
}

function processHeadings(preview, opts) {
  const { headingToId } = opts;
  const idCount = {};
  preview.querySelectorAll('h1, h2, h3, h4, h5, h6').forEach(heading => {
    if (heading.id) return;
    const text = heading.textContent;
    let id = headingToId(text);
    if (idCount[id]) {
      idCount[id]++;
      heading.id = id + '-' + idCount[id];
    } else {
      idCount[id] = 1;
      heading.id = id;
    }
  });
}

async function processMermaid(preview, opts) {
  const { isDark, mermaidCache } = opts;
  if (typeof mermaid === 'undefined') return;

  const blocks = Array.from(preview.querySelectorAll('code.language-mermaid'));
  if (blocks.length === 0) return;

  const themeKey = isDark ? 'dark' : 'light';
  const toRender = []; // cache miss：需调 mermaid.run 的容器

  blocks.forEach((block, index) => {
    const pre = block.parentElement;
    const sourceLine = block.dataset.sourceLine;
    const code = block.textContent;
    const cacheKey = themeKey + '::' + code;

    const container = document.createElement('div');
    // 双类名：mermaid-container 沿用既有样式/导出/灯箱链路，diagram-container 标记「图表容器」
    container.className = 'mermaid-container diagram-container';
    container.id = 'mermaid-' + Date.now() + '-' + index;
    container.setAttribute('data-diagram-type', 'mermaid');
    container.setAttribute('data-theme', themeKey);
    container.setAttribute('data-code', code);
    if (sourceLine) container.setAttribute('data-source-line', sourceLine);

    const cached = mermaidCache ? mermaidCache.get(cacheKey) : null;
    if (cached) {
      // 命中缓存：直接复用上次的 SVG，不进 mermaid.run
      container.innerHTML = cached;
    } else {
      // 未命中：放入待渲染队列（textContent 必须是原始 code，mermaid.run 才能解析）。
      // 但**不能让它显示出来** —— 直接显示会"一会儿源码一会儿图"地闪（用户报障）。
      // 用 .diagram-pending 把文本透明化并显示"渲染中"占位，渲染完成即摘掉。
      container.classList.add('diagram-pending');
      container.textContent = code;
      toRender.push({ container, cacheKey });
    }
    pre.replaceWith(container);
  });

  // 只渲染未命中的（命中复用的不再跑 mermaid.run，避免 "already rendered" 报错）
  if (toRender.length === 0) return;

  try {
    mermaid.initialize({
      startOnLoad: false,
      theme: isDark ? 'dark' : 'default',
      // strict：转义图内嵌 HTML 标签/click 事件（loose 允许 <img onerror> 在预览执行，XSS 面）
      securityLevel: 'strict',
      fontFamily: getComputedStyle(document.documentElement).getPropertyValue('--font-preview').trim() || '-apple-system, sans-serif',
    });
    await mermaid.run({ nodes: toRender.map(x => x.container) });
    // 渲染结束（无论成败）都要摘掉 pending：失败时源码重新可见，便于用户排查语法。
    for (const { container } of toRender) container.classList.remove('diagram-pending');
    // 渲染成功后存入缓存（仅缓存含 SVG 的成功结果，错误信息不缓存）
    if (mermaidCache) {
      for (const { container, cacheKey } of toRender) {
        if (container.querySelector('svg')) {
          mermaidCache.set(cacheKey, container.innerHTML);
        }
      }
    }
  } catch (e) {
    if (typeof console !== 'undefined') console.error('Mermaid rendering error:', e);
  }
}

// 取代码块原始文本（不含行号、保留缩进与换行）。
// 渲染后结构为 .code-scroll > .code-line >(.code-line-num + .code-line-text)，
// 若直接读 code.textContent 会把「行号数字」和「代码」无换行地拼在一起，
// 导致粘贴后格式/缩进丢失且混入行号。这里只取每行 .code-line-text。
function getRawCodeText(pre) {
  const code = pre.querySelector('code');
  if (!code) return pre.textContent;
  const lineTexts = code.querySelectorAll('.code-line-text');
  if (lineTexts.length === 0) {
    // 单行块（无 .code-line 包裹）或未做行号包裹的原始 <code>：
    // 直接 textContent 即可，已含正确换行与缩进，且不含行号。
    const t = code.textContent;
    return t === ' ' ? '' : t;
  }
  // 多行块：逐行取 .code-line-text（仅原始代码，不含行号），按 \n 还原。
  // 渲染时空行被替换为 &nbsp; 占位，这里还原为空，避免粘贴出多余不间断空格。
  return Array.from(lineTexts, span => {
    const t = span.textContent;
    return t === ' ' ? '' : t;
  }).join('\n');
}

function addCopyButtons(preview, opts) {
  const { t } = opts;
  preview.querySelectorAll('pre').forEach(pre => {
    if (pre.querySelector('.copy-btn')) return;
    if (pre.querySelector('code.language-mermaid')) return;

    const btn = document.createElement('button');
    btn.className = 'copy-btn';
    btn.textContent = t('copy');
    btn.title = t('copyCode');

    btn.addEventListener('click', async () => {
      const text = getRawCodeText(pre);
      try {
        await navigator.clipboard.writeText(text);
        btn.textContent = t('copied');
        btn.classList.add('copied');
        setTimeout(() => {
          btn.textContent = t('copy');
          btn.classList.remove('copied');
        }, 2000);
      } catch (err) {
        const textarea = document.createElement('textarea');
        textarea.value = text;
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy');
        document.body.removeChild(textarea);
        btn.textContent = t('copied');
        btn.classList.add('copied');
        setTimeout(() => {
          btn.textContent = t('copy');
          btn.classList.remove('copied');
        }, 2000);
      }
    });

    pre.style.position = 'relative';
    pre.appendChild(btn);
  });
}

// 浏览器：作为独立 <script> 加载，挂到全局 PreviewPost
// ---- 图表引擎（Mermaid 之外）：ECharts / WaveDrom / Graphviz / TikZ / plot / Markmap ----
// 通过 DiagramRenderers 全局（浏览器）或 require（node 测试）拿到引擎适配器，惰性获取，
// 因此模块加载顺序不影响；引擎未加载时本函数安全跳过。
function getDiagramRenderers() {
  if (typeof DiagramRenderers !== 'undefined') return DiagramRenderers;
  if (typeof require === 'function') {
    try { return require('./diagram-renderers.js'); } catch (_) { return null; }
  }
  return null;
}

// ---- PlantUML / D2 → Mermaid 源码改写 ----
// 这两者的真正难点是自动布局，故降级为等价的 Mermaid 图描述，复用既有 processMermaid
// （同一套渲染 / 缓存 / 主题重绘逻辑，不重复实现）。**必须在 processMermaid 之前调用**。
// 转换器是纯函数模块 modules/diagram-converters.js（可零依赖单测）。
function getDiagramConverters() {
  if (typeof DiagramConverters !== 'undefined') return DiagramConverters;
  if (typeof require === 'function') {
    try { return require('./diagram-converters.js'); } catch (_) { return null; }
  }
  return null;
}

// 把 ```plantuml / ```d2 就地改写为 ```mermaid。
// 超出语法子集时**保留原代码块**并加一行可读提示（绝不静默丢弃用户内容）。
// 返回改写数量，便于测试断言。
function convertMermaidSources(preview) {
  const DC = getDiagramConverters();
  if (!DC || typeof DC.classify !== 'function') return 0;
  const doc = preview.ownerDocument || (typeof document !== 'undefined' ? document : null);
  let converted = 0;
  preview.querySelectorAll('pre > code').forEach((block) => {
    const m = /(?:^|\s)language-([\w-]+)/.exec(block.className || '');
    if (!m) return;
    const info = DC.classify(m[1].toLowerCase(), block.textContent);
    if (!info || info.kind !== 'mermaid') return;
    const pre = block.parentElement;
    const mermaid = DC.toMermaid(info.type, block.textContent);
    if (!mermaid) {
      if (pre && !pre.dataset.diagramFallback) {
        pre.dataset.diagramFallback = info.type;
        if (doc) {
          const note = doc.createElement('div');
          note.className = 'diagram-fallback-note';
          // 提示尽量具体：能识别出是哪条语法超集就写出来（识别不到才退回笼统说法）。
          // 目的：用户不必来问"为什么没渲染"，提示条本身就说清了缺哪条语法。
          const hints = (DC && typeof DC.unsupportedHints === 'function')
            ? DC.unsupportedHints(info.type, block.textContent)
            : [];
          note.textContent = '⚠ ' + info.type + ' 未转换' +
            (hints.length ? '：检测到未支持语法 ' + hints.join('、') : '：超出本地支持的语法子集') +
            '，已保留原始源码';
          if (pre.parentNode) pre.parentNode.insertBefore(note, pre);
        }
      }
      return;
    }
    block.className = 'language-mermaid';
    block.textContent = mermaid;
    if (pre) pre.dataset.diagramSource = info.type;
    converted++;
  });
  return converted;
}

// 收集「图表语言」代码块。typeOf(lang) 返回引擎类型或 null（便于单测注入）。
// 只认 <pre><code class="language-X">（围栏代码块），行内 code 不算。
function collectDiagramBlocks(preview, typeOf) {
  const out = [];
  preview.querySelectorAll('pre > code').forEach((block) => {
    const m = /(?:^|\s)language-([\w-]+)/.exec(block.className || '');
    if (!m) return;
    const type = typeOf(m[1].toLowerCase());
    if (!type) return;
    out.push({
      type,
      code: block.textContent,
      pre: block.parentElement,
      sourceLine: (block.dataset && block.dataset.sourceLine) || undefined,
    });
  });
  return out;
}

// 哪些引擎的渲染结果可以通过 innerHTML 复用（SVG）。
// ECharts 走 canvas，canvas 无法被 innerHTML 序列化保存，必须每次重绘。
const DIAGRAM_HTML_CACHEABLE = {
  wavedrom: true,
  graphviz: true,
  echarts: false,
  tikz: true,
  plot: true,
  // Markmap 的 SVG 带交互（缩放/平移）与内部状态，innerHTML 复用会丢掉，故不缓存
  markmap: false,
};

function buildDiagramContainer(document, type, code, sourceLine, themeKey, idSuffix) {
  const container = document.createElement('div');
  container.className = 'mermaid-container diagram-container';
  container.id = 'diagram-' + type + '-' + Date.now() + '-' + idSuffix;
  container.setAttribute('data-diagram-type', type);
  container.setAttribute('data-theme', themeKey);
  container.setAttribute('data-code', code);
  if (sourceLine) container.setAttribute('data-source-line', sourceLine);
  return container;
}

async function processDiagrams(preview, opts) {
  const opt = opts || {};
  const DR = getDiagramRenderers();
  if (!DR) return;
  const themeKey = opt.isDark ? 'dark' : 'light';
  const cache = opt.mermaidCache || null;
  const typeOf = (lang) => DR.diagramTypeFromLanguage(lang);

  // 折叠型 admonition（???）内的容器处于 display:none 时量不到宽高，ECharts / Markmap
  // 会据此得到 0 尺寸（画布空白、脑图不可见）。TikZ / plot 是纯函数生成的 SVG 字符串，
  // 不依赖布局，不受影响。故仅在渲染期间临时展开祖先 <details>，渲染后立即恢复原状态，
  // 兼顾 ??? 的「默认收起」语义与图表尺寸正确性。
  // 定义为 processDiagrams 内部闭包（而非模块顶层函数）：本文件未包 IIFE，
  // 顶层声明会进入全局词法环境并与其它经典 <script> 共享，能不加就不加。
  const withVisibleLayout = async (el, fn) => {
    const opened = [];
    for (let node = el && el.parentElement; node; node = node.parentElement) {
      if (node.tagName === 'DETAILS' && !node.open) { node.open = true; opened.push(node); }
    }
    try {
      return await fn();
    } finally {
      for (let i = 0; i < opened.length; i++) opened[i].open = false;
    }
  };

  // 命中缓存（仅 SVG 引擎）：直接复用上次渲染结果，跳过重新渲染。
  // 异步：Graphviz 需要 await wasm 实例化。
  const paint = async (container, type, code) => {
    const key = cache ? type + '::' + themeKey + '::' + code : null;
    if (key && DIAGRAM_HTML_CACHEABLE[type] && cache.has(key)) {
      container.innerHTML = cache.get(key);
      return true;
    }
    const ok = await withVisibleLayout(container, () => DR.renderInto(container, type, code, { isDark: !!opt.isDark }));
    if (ok && key && DIAGRAM_HTML_CACHEABLE[type] && container.querySelector('svg')) {
      cache.set(key, container.innerHTML);
    }
    return ok;
  };

  // 1) 首次渲染：围栏代码块 → 图表容器。
  //    **两阶段**：先把所有源码块换成占位容器，再逐个渲染。
  //    历史 bug：原来是"替换一个、await 渲染一个"，于是还没轮到的图仍以**源码**形式显示，
  //    表现为"代码与渲染图交替闪现"（用户 2026-09-23、09-24 两次报障）。
  const blocks = collectDiagramBlocks(preview, typeOf);
  const jobs = [];
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    const container = buildDiagramContainer(preview.ownerDocument || document, b.type, b.code, b.sourceLine, themeKey, i);
    container.classList.add('diagram-pending');   // 占位文案：既不显示源码，也不是白块
    b.pre.replaceWith(container);
    jobs.push({ container: container, type: b.type, code: b.code });
  }
  // 2) 逐个渲染（顺序 await：同一篇里的多个图只触发一次 wasm 初始化）
  for (let i = 0; i < jobs.length; i++) {
    const job = jobs[i];
    // 单个图出错绝不能影响后续图：这里再兜一层。
    // renderInto 内部已有 try/catch，但它只覆盖**同步**异常；引擎若在 await 期间以
    // 别的方式抛出（或 renderInto 被替换/扩展），整篇文档里靠前的一个图就会让后面
    // 所有图都渲染不出来 —— 这个代价远大于"多一层 try"。
    try {
      await paint(job.container, job.type, job.code);
    } catch (e) {
      console.warn('[diagrams] ' + job.type + ' 渲染异常（已隔离，不影响其它图）：', e);
      if (job.container && job.container.classList) job.container.classList.add('diagram-error');
    } finally {
      // 无论成败都摘掉占位：失败时错误框/源码要可见
      job.container.classList.remove('diagram-pending');
    }
  }

  // 2) 主题切换后的重渲染：容器里的图属于旧主题时按 data-code 重画
  const stale = Array.from(preview.querySelectorAll('.diagram-container[data-diagram-type]'))
    .filter((el) => el.getAttribute('data-diagram-type') !== 'mermaid')
    .filter((el) => el.getAttribute('data-theme') !== themeKey);
  for (const container of stale) {
    const type = container.getAttribute('data-diagram-type');
    const code = container.getAttribute('data-code') || '';
    container.setAttribute('data-theme', themeKey);
    container.classList.remove('diagram-error');
    container.innerHTML = '';
    try {
      await paint(container, type, code);
    } catch (e) {
      console.warn('[diagrams] 主题重绘 ' + type + ' 异常（已隔离）：', e);
      if (container && container.classList) container.classList.add('diagram-error');
    }
  }
}

if (typeof window !== 'undefined' && typeof module === 'undefined') {
  window.PreviewPost = {
    processEmojiShortcodes, processMath, processAbbreviations,
    processHeadings, processMermaid, processDiagrams, collectDiagramBlocks,
    convertMermaidSources, buildDiagramContainer, DIAGRAM_HTML_CACHEABLE,
    addCopyButtons, getRawCodeText,
  };
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    processEmojiShortcodes, processMath, processAbbreviations,
    processHeadings, processMermaid, processDiagrams, collectDiagramBlocks,
    convertMermaidSources, buildDiagramContainer, DIAGRAM_HTML_CACHEABLE,
    addCopyButtons, EMOJI_MAP,
    protectUnpairedDollar, getRawCodeText,
  };
}
