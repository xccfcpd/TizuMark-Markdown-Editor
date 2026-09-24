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
  // 注意 skipTags 里的 'svg'：主题/滚动重渲染时，命中缓存的 mermaid 图在**同步阶段**就已经
  // 是 <svg>（不是 <pre><code>），若不跳过，`:fire:` 之类的短码会被写进 SVG 的 <text> 里，
  // 造成"同一份源码第一次正常、第二次被改坏"（审计发现，2026-09-24）。
  const skipTags = ['CODE', 'PRE', 'ABBR', 'SCRIPT', 'STYLE', 'TEXTAREA', 'A', 'svg', 'SVG'];
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
    // 'svg'：命中缓存的图表在**同步阶段**就已经是 <svg>（不再包在 <pre><code> 里），
    // KaTeX 若进去插节点会破坏 SVG 结构（同一份源码第一次正常、第二次被改坏 —— 审计发现）。
    // 注：SVG 元素的 tagName 保持小写（HTML 元素才大写），两种都列上更稳。
    const skipTags = ['CODE', 'PRE', 'SCRIPT', 'STYLE', 'TEXTAREA', 'svg', 'SVG'];
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

    // 'svg'：同 processMath —— 不往已渲染的图表 SVG 里插 <abbr>
    const skipTags = ['CODE', 'PRE', 'svg', 'SVG'];
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

// ---- 图表两阶段：① 同步占位（必须早于任何 await）② 异步渲染 ----
// 为什么要拆成两阶段（用户 2026-09-23、09-24 两次报障「预览里一会儿源码一会儿图」）：
// 预览流程是「innerHTML 写入 → 后处理」，其中 processImages 等步骤含 await；
// 只要图表块在这段时间里仍以**源码**形态留在 DOM 中，浏览器就会把它画出来。
// 因此：占位必须**同步**做完（紧跟 innerHTML），真正渲染可以异步慢慢来。

// ① 同步：给 mermaid 系代码块（含 PlantUML / D2 转换结果）打占位标记。
// 刻意**不搬动 DOM** —— 源码留在 <pre><code> 内，各后处理器都会按 PRE/CODE 跳过、不会误改；
// 真正的容器替换放到渲染阶段（那时后处理已结束）。
// 统一构造 mermaid 容器（同步缓存复原与异步渲染共用，保证两处属性完全一致）
function buildMermaidContainer(doc, code, themeKey, index, cachedHtml, sourceLine) {
  const container = doc.createElement('div');
  // 双类名：mermaid-container 沿用既有样式/导出/灯箱链路，diagram-container 标记「图表容器」
  container.className = 'mermaid-container diagram-container';
  container.id = 'mermaid-' + Date.now() + '-' + index;
  container.setAttribute('data-diagram-type', 'mermaid');
  container.setAttribute('data-theme', themeKey);
  container.setAttribute('data-code', code);
  if (sourceLine) container.setAttribute('data-source-line', sourceLine);
  if (cachedHtml) {
    container.innerHTML = cachedHtml;   // 命中缓存：容器里直接就是渲染好的图
  } else {
    // 未命中：textContent 必须是原始 code（mermaid.run 才能解析），
    // 用 .diagram-pending 把文本透明化 + 显示「渲染中」占位，渲染结束即摘掉。
    container.classList.add('diagram-pending');
    container.textContent = code;
  }
  return container;
}

// ① 同步：mermaid 系（含 PlantUML / D2 转换结果）占位。
//    **命中缓存的当场复原成图**（连占位都不显示）—— 这是"滚动/打字重渲染不再闪一下"的关键：
//    窗口切片重渲染时，视口里的图绝大多数都渲染过，复原全部发生在同一个同步任务里，
//    浏览器一次绘制就是最终画面。未命中的才打 .diagram-src-pending 占位，交渲染阶段处理。
function prepareMermaidPlaceholders(preview, opts) {
  const opt = opts || {};
  const cache = opt.mermaidCache || null;
  const themeKey = opt.isDark ? 'dark' : 'light';
  const pending = [];
  if (typeof mermaid === 'undefined' || !preview) return pending;
  preview.querySelectorAll('pre > code.language-mermaid').forEach((code, index) => {
    const pre = code.parentElement;
    if (!pre) return;
    const text = code.textContent;
    const cached = cache ? cache.get(themeKey + '::' + text) : null;
    if (cached) {
      const doc = pre.ownerDocument || (typeof document !== 'undefined' ? document : null);
      if (!doc) return;
      const sourceLine = code.dataset ? code.dataset.sourceLine : null;
      pre.replaceWith(buildMermaidContainer(doc, text, themeKey, index, cached, sourceLine));
      return;
    }
    pre.classList.add('diagram-src-pending');
    pending.push(pre);
  });
  return pending;
}

// ② 异步：把打了标记的 <pre> 换成图表容器并渲染（命中缓存则直接复用上次的 SVG）。
async function renderMermaidPlaceholders(pres, opts) {
  const opt = opts || {};
  const isDark = !!opt.isDark;
  const mermaidCache = opt.mermaidCache || null;
  const list = pres || [];
  const themeKey = isDark ? 'dark' : 'light';
  const toRender = []; // cache miss：需调 mermaid.run 的容器

  // 先**同步**把所有 <pre> 换成容器：等待期间看到的是占位，而不是源码、也不是空白
  list.forEach((pre, index) => {
    if (!pre || !pre.parentElement) return;   // 已被别的渲染替换掉（期间发生新一轮渲染）
    const codeEl = pre.querySelector('code.language-mermaid');
    if (!codeEl) { pre.classList.remove('diagram-src-pending'); return; }
    const code = codeEl.textContent;
    const sourceLine = codeEl.dataset ? codeEl.dataset.sourceLine : null;
    const cacheKey = themeKey + '::' + code;
    const doc = pre.ownerDocument || (typeof document !== 'undefined' ? document : null);
    if (!doc) return;

    // 走到这里的一定是「未命中缓存」的（命中的已在同步阶段复原），故直接建占位容器
    const container = buildMermaidContainer(doc, code, themeKey, index, null, sourceLine);
    toRender.push({ container, cacheKey });
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
  } catch (e) {
    if (typeof console !== 'undefined') console.error('Mermaid rendering error:', e);
  } finally {
    // 渲染结束（**无论成败**）都要摘掉 pending：失败时源码重新可见，便于用户排查语法。
    // 历史 bug：摘 pending 原本只在 try 内、紧跟 await 之后 —— 一旦 initialize / run 抛错，
    // 占位就一直挂着，已经渲染出来的图上会压着一行「图表渲染中…」（用户截图报障）。
    for (const { container, cacheKey } of toRender) {
      container.classList.remove('diagram-pending');
      // 仅缓存含 SVG 的成功结果（错误信息不缓存）
      if (mermaidCache && container.querySelector('svg')) mermaidCache.set(cacheKey, container.innerHTML);
    }
  }
}

// 兼容入口（既有调用方 / 测试）：等价于「先占位、再渲染」两步
async function processMermaid(preview, opts) {
  await renderMermaidPlaceholders(prepareMermaidPlaceholders(preview, opts), opts);
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

// ① 同步：原生引擎（ECharts / WaveDrom / Graphviz / TikZ / plot / Markmap）源码块 → 占位容器。
// 容器里**不含源码**，因此不会误导后续任何处理器；真正渲染见 renderNativePlaceholders。
function prepareNativePlaceholders(preview, opts) {
  const opt = opts || {};
  const DR = getDiagramRenderers();
  const jobs = [];
  if (!DR || !preview) return jobs;
  const themeKey = opt.isDark ? 'dark' : 'light';
  const cache = opt.mermaidCache || null;
  const blocks = collectDiagramBlocks(preview, (lang) => DR.diagramTypeFromLanguage(lang));
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    const container = buildDiagramContainer(preview.ownerDocument || document, b.type, b.code, b.sourceLine, themeKey, i);
    // 命中缓存（仅可序列化的 SVG 引擎）：**同步**复原成图，连占位都不显示 ——
    // 这样滚动切片重渲染时，视口里已渲染过的图不会先变成「图表渲染中…」。
    // ECharts / Markmap 走 canvas / 内部交互状态，无法序列化复用，只能重新渲染。
    const key = cache ? b.type + '::' + themeKey + '::' + b.code : null;
    if (key && DIAGRAM_HTML_CACHEABLE[b.type] && cache.has(key)) {
      container.innerHTML = cache.get(key);
    } else {
      container.classList.add('diagram-pending');   // 占位文案：既不显示源码，也不是白块
      jobs.push({ container: container, type: b.type, code: b.code });
    }
    b.pre.replaceWith(container);
  }
  return jobs;
}

// ② 异步：逐个渲染占位容器，并对「主题已过期」的既有容器按 data-code 重画。
async function renderNativePlaceholders(preview, jobs, opts) {
  const opt = opts || {};
  const DR = getDiagramRenderers();
  if (!DR) return;
  const themeKey = opt.isDark ? 'dark' : 'light';
  const cache = opt.mermaidCache || null;

  // 折叠型 admonition（???）内的容器处于 display:none 时量不到宽高，ECharts / Markmap
  // 会据此得到 0 尺寸（画布空白、脑图不可见）。TikZ / plot 是纯函数生成的 SVG 字符串，
  // 不依赖布局，不受影响。故仅在渲染期间临时展开祖先 <details>，渲染后立即恢复原状态，
  // 兼顾 ??? 的「默认收起」语义与图表尺寸正确性。
  // 定义为函数内部闭包（而非模块顶层函数）：本文件未包 IIFE，
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

  // 逐个渲染（顺序 await：同一篇里的多个图只触发一次 wasm 初始化）
  const list = jobs || [];
  for (let i = 0; i < list.length; i++) {
    const job = list[i];
    const container = job.container;
    // 容器已脱离文档（例如期间发起了新一轮预览渲染）→ 画了也看不见，跳过更省时
    if (!container || !container.parentElement) continue;
    // 单个图出错绝不能影响后续图：这里再兜一层。
    // renderInto 内部已有 try/catch，但它只覆盖**同步**异常；引擎若在 await 期间以
    // 别的方式抛出（或 renderInto 被替换/扩展），整篇文档里靠前的一个图就会让后面
    // 所有图都渲染不出来 —— 这个代价远大于"多一层 try"。
    try {
      await paint(container, job.type, job.code);
    } catch (e) {
      console.warn('[diagrams] ' + job.type + ' 渲染异常（已隔离，不影响其它图）：', e);
      if (container.classList) container.classList.add('diagram-error');
    } finally {
      // 无论成败都摘掉占位：失败时错误框/源码要可见
      container.classList.remove('diagram-pending');
    }
  }

  // 主题切换后的重渲染：容器里的图属于旧主题时按 data-code 重画
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

// 兼容入口（既有调用方 / 测试）：等价于「先占位、再渲染」两步
async function processDiagrams(preview, opts) {
  await renderNativePlaceholders(preview, prepareNativePlaceholders(preview, opts), opts);
}

// ---- 组合入口（控制器用这两个）----
// 顺序不可颠倒：prepare 必须**同步**跑完（紧跟 innerHTML），否则 await 期间会露出源码。
function prepareDiagramPlaceholders(preview, opts) {
  const opt = opts || {};
  const jobs = { mermaid: [], native: [], themeKey: opt.isDark ? 'dark' : 'light' };
  if (!preview) return jobs;
  // PlantUML / D2 → Mermaid 源码改写（同步）：必须在占位之前，改写后它们才归入 mermaid 系
  try { convertMermaidSources(preview); } catch (e) { console.warn('[diagrams] PlantUML/D2 转换失败：', e); }
  jobs.mermaid = prepareMermaidPlaceholders(preview, opt);
  jobs.native = prepareNativePlaceholders(preview, opt);
  return jobs;
}

async function renderDiagramPlaceholders(preview, jobs, opts) {
  const opt = opts || {};
  const prep = jobs || { mermaid: [], native: [] };
  if (prep.mermaid && prep.mermaid.length) {
    try {
      await renderMermaidPlaceholders(prep.mermaid, opt);
    } catch (e) {
      console.warn('[diagrams] mermaid 渲染异常（已隔离）：', e);
    }
  }
  if (preview) {
    try {
      await renderNativePlaceholders(preview, prep.native, opt);
    } catch (e) {
      console.warn('[diagrams] 原生引擎渲染异常（已隔离）：', e);
    }
    // 兜底：任何没被替换掉的占位标记都要摘掉 —— 宁可看见源码，也不能把内容藏起来。
    // 两种情况都要覆盖（审计发现这里原来只覆盖了前者）：
    //   · pre.diagram-src-pending：mermaid 系未走到容器替换
    //   · .diagram-container.diagram-pending：某引擎的 await 不 settle 时 finally 不会执行，
    //     容器会带着 pending 常驻，而 `color: transparent` 会把内容永久藏住（只剩「渲染中…」）
    preview.querySelectorAll('pre.diagram-src-pending').forEach((pre) => pre.classList.remove('diagram-src-pending'));
    preview.querySelectorAll('.diagram-container.diagram-pending').forEach((el) => el.classList.remove('diagram-pending'));
  }
}

if (typeof window !== 'undefined' && typeof module === 'undefined') {
  window.PreviewPost = {
    processEmojiShortcodes, processMath, processAbbreviations,
    processHeadings, processMermaid, processDiagrams, collectDiagramBlocks,
    convertMermaidSources, buildDiagramContainer, DIAGRAM_HTML_CACHEABLE,
    prepareDiagramPlaceholders, renderDiagramPlaceholders,
    addCopyButtons, getRawCodeText,
  };
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    processEmojiShortcodes, processMath, processAbbreviations,
    processHeadings, processMermaid, processDiagrams, collectDiagramBlocks,
    convertMermaidSources, buildDiagramContainer, DIAGRAM_HTML_CACHEABLE,
    prepareDiagramPlaceholders, renderDiagramPlaceholders,
    addCopyButtons, EMOJI_MAP,
    protectUnpairedDollar, getRawCodeText,
  };
}
