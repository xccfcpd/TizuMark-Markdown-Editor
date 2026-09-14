// DOM → docx 中间结构（纯 JSON，可 postMessage 给 worker）的转换模块。
// 浏览器：挂 window.domToDocxStructure；node：module.exports（互斥式，与现有模块一致）。
//
// 注意：elementToNode 内部返回【节点数组】而非单节点，以便把包裹在 <p>/<blockquote>
// 里的 <img> 打捞成顶层 image 节点（DocxLib 用块级节点，未打捞的图片会被静默丢弃）。
(function () {
  function dataUrlToBytes(dataUrl) {
    const m = /^data:[^;]+;base64,(.+)$/.exec(String(dataUrl || ''));
    if (!m) return null;
    try { return Uint8Array.from(atob(m[1]), c => c.charCodeAt(0)); } catch (e) { return null; }
  }

  // data: URL → docx 的 ImageRun type（docx 9.x 需要 png/jpg/gif/bmp/svg 之一）。
  function mimeToImageType(dataUrl) {
    const m = /^data:([^;,]+)/.exec(String(dataUrl || ''));
    const mime = (m ? m[1] : '').toLowerCase();
    if (mime === 'image/jpeg' || mime === 'image/jpg') return 'jpg';
    if (mime === 'image/gif') return 'gif';
    if (mime === 'image/bmp') return 'bmp';
    return 'png';
  }

  // CSS 颜色（#hex / rgb() / rgba()）→ docx 需要的 6 位大写 HEX（不带 #）；取不到返回 ''。
  // 用途：blockquote / alert 在 _prepareWordDOM 里被写成内联 background / borderLeft，
  // 这里转成 docx 段落的 shading / 左边框色，避免「预览有底色，Word 里只剩一条竖线」。
  function cssColorToHex(v) {
    const s = String(v || '').trim();
    let m = /^#([0-9a-fA-F]{6})$/.exec(s);
    if (m) return m[1].toUpperCase();
    m = /^#([0-9a-fA-F]{3})$/.exec(s);
    if (m) return m[1].split('').map((c) => c + c).join('').toUpperCase();
    m = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(s);
    if (m) return ((1 << 24) + (parseInt(m[1], 10) << 16) + (parseInt(m[2], 10) << 8) + parseInt(m[3], 10)).toString(16).slice(1).toUpperCase();
    return '';
  }

  function imageToNode(el) {
    const dataUrl = el.getAttribute('src') || '';
    const data = dataUrlToBytes(dataUrl);
    if (!data) return null;
    // 优先读 _applyWordImgSize 设的 width/height 属性（已按 500px 上限等比缩放）；
    // 没有再退回 data-dispW（原始显示尺寸，可能超宽）→ naturalWidth → 兜底 100。
    // 此前优先读 data-dispW 导致 _applyWordImgSize 的限宽失效，大图在 Word 里溢出页面。
    const ds = el.dataset || {};
    const wSrc = el.getAttribute('width') || el.getAttribute('data-dispW') || ds.dispW || ds.dispw || el.naturalWidth || 100;
    const hSrc = el.getAttribute('height') || el.getAttribute('data-dispH') || ds.dispH || ds.disph || el.naturalHeight || 100;
    const w = parseInt(wSrc, 10) || 100;
    const h = parseInt(hSrc, 10) || 100;
    // data 用 Uint8Array 而非 Array.from 的普通数组：postMessage 的 structuredClone
    // 对 typed array 是整块内存拷贝，对普通数组则是逐元素克隆（大图时会明显拖慢导出）。
    return { type: 'image', data, imageType: mimeToImageType(dataUrl), width: w, height: h };
  }

  // 收集一个块元素内所有 <img> 为顶层 image 节点（块级，DocxLib 落图）。
  function collectBlockImages(el) {
    const out = [];
    for (const img of el.querySelectorAll('img')) {
      const node = imageToNode(img);
      if (node) out.push(node);
    }
    return out;
  }

  // 收集行内 runs；遇到 <img> 时若传入 images 数组则把图片节点打捞进去（不产生 run）。
  function collectRuns(el, runs = [], images = null) {
    if (!el) return runs;
    for (const child of el.childNodes) {
      if (child.nodeType === 3) {
        const text = child.textContent || '';
        if (text) runs.push({ text });
      } else if (child.nodeType === 1) {
        const tag = child.tagName.toLowerCase();
        const style = child.style || {};
        let runBase = {};
        if (tag === 'strong' || tag === 'b') runBase.bold = true;
        else if (tag === 'em' || tag === 'i') runBase.italics = true;
        else if (tag === 'del' || tag === 's') runBase.strike = true;
        else if (tag === 'code') runBase.codeStyle = true;
        else if (tag === 'mark') { runBase.highlight = true; }
        // 上标/下标：脚注引用 <sup class="footnote-ref">[1]</sup> 此前退化成普通文本 "[1]"
        else if (tag === 'sup') runBase.superScript = true;
        else if (tag === 'sub') runBase.subScript = true;
        else if (tag === 'br') { runs.push({ break: true }); continue; }
        // KaTeX 公式：提取 .katex-mathml 的 <math> 作为 mathml run（可编辑公式源），
        // 不递归收集 katex-html 可见文本（避免公式退化为纯文本 + 重复计数）。
        // 兼容两种结构：span.katex > (katex-mathml, katex-html) 与
        // KaTeX 直接输出 <math>（output:'mathml' 时 span.katex 下即 <math>）。
        if (tag === 'span' && typeof child.className === 'string' && child.className.split(/\s+/).includes('katex')) {
          const mathEl = child.querySelector('.katex-mathml math') || child.querySelector('math');
          if (mathEl) {
            const mathml = mathEl.outerHTML;
            if (mathml) runs.push({ mathml });
            continue;
          }
        }
        else if (tag === 'img') {
          if (images) { const img = imageToNode(child); if (img) images.push(img); }
          continue;
        }
        const color = style.color;
        if (color) {
          if (/^rgb\(/.test(color)) {
            const m = /^rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/.exec(color);
            if (m) {
              runBase.color = ((1 << 24) + (parseInt(m[1], 10) << 16) + (parseInt(m[2], 10) << 8) + parseInt(m[3], 10)).toString(16).slice(1).toUpperCase();
            }
          } else {
            runBase.color = color.replace('#', '').toUpperCase();
          }
        }
        const before = runs.length;
        collectRuns(child, runs, images);
        for (let i = before; i < runs.length; i++) {
          for (const k of Object.keys(runBase)) {
            if (!(k in runs[i])) runs[i][k] = runBase[k];
          }
        }
      }
    }
    return runs;
  }

  // 「行内容器」（表格单元格 / 列表项 / 提示块标题）的 runs：在 collectRuns 基础上
  // 折叠空白（HTML 源码缩进会带进多余空格）、去掉首尾空白与空文本 run。
  // 关键：必须走 collectRuns（而不是 textContent），否则 KaTeX 单元格里
  // MathML 渲染文本 + <annotation> 的 LaTeX 源码 + katex-html 可见文本会被拼成
  // "α\alphaα"，Word 里显示成乱码（2026-09-14 用户导出验证）。
  function collectInlineRuns(el) {
    const runs = collectRuns(el, [], null).filter((r) => {
      if (r && typeof r.text === 'string') return r.text.trim() !== '';
      return !!r;
    });
    for (const r of runs) {
      if (typeof r.text === 'string') r.text = r.text.replace(/\s+/g, ' ');
    }
    if (runs.length) {
      const first = runs[0];
      const last = runs[runs.length - 1];
      if (typeof first.text === 'string') first.text = first.text.replace(/^\s+/, '');
      if (typeof last.text === 'string') last.text = last.text.replace(/\s+$/, '');
    }
    return runs;
  }

  // 非内容标签：兜底下探（见 elementToNode 末尾）必须跳过，
  // 否则 <style> 里的 CSS 文本会被当成正文段落灌进 Word。
  // math 一并跳过：KaTeX 产出的 <math> 一律经 span.katex 分支处理（不会走到兜底），
  // 用户手写的裸 MathML 若被下探会被拆成一堆碎片段落，保持与改动前一致的丢弃行为。
  const SKIP_TAGS = new Set(['style', 'script', 'link', 'meta', 'title', 'head', 'noscript', 'template', 'math']);

  function elementToNode(el) {
    const tag = el.tagName.toLowerCase();
    if (/^h[1-6]$/.test(tag)) {
      return [{ type: 'heading', level: parseInt(tag[1], 10), runs: collectRuns(el) }];
    }
    if (tag === 'p') {
      const imgs = [];
      const runs = collectRuns(el, undefined, imgs);
      const nodes = [];
      if (runs.length) nodes.push({ type: 'paragraph', runs, align: el.style.textAlign || undefined });
      nodes.push(...imgs);
      return nodes;
    }
    if (tag === 'blockquote') {
      const paras = el.querySelectorAll('p');
      const runs = [];
      paras.forEach(p => { runs.push(...collectRuns(p)); });
      // 若块内无 <p>（纯文本/列表），退化到 collectRuns 整块
      if (runs.length === 0) runs.push(...collectRuns(el));
      const nodes = [];
      // _prepareWordDOM 已把底色/左边框写成内联样式；取出来带给 docx，
      // 否则预览里的灰底引用在 Word 里只剩一条竖线。
      if (runs.length) nodes.push({
        type: 'paragraph', runs, quote: true,
        quoteBg: cssColorToHex(el.style.backgroundColor || el.style.background) || 'F6F5F4',
        quoteColor: cssColorToHex(el.style.borderLeftColor) || '',
      });
      nodes.push(...collectBlockImages(el));
      return nodes;
    }
    if (tag === 'pre') {
      const code = el.querySelector('code');
      const text = (code ? code.textContent : el.textContent) || '';
      const lines = text.split('\n').map(l => l.trimEnd()).filter((l, i, a) => !(i === a.length - 1 && l === ''));
      return [{ type: 'code', lines }];
    }
    if (tag === 'ul' || tag === 'ol') {
      // 有序（ol）与无序（ul）必须区分：此前两者都产出 {type:'bullet'}，
      // 导致预览里的 "1. 2. 3." 在 Word 里全变成圆点。这里带上 ordered + 序号文本。
      const ordered = tag === 'ol';
      const nodes = [];
      let idx = 0;
      // 列表项内容走 runs：脚注定义就在 <ol><li> 里，用 textContent 会把公式三重化
      //（"E=mc2E = mc^2E=mc2"），高亮/加粗也一并丢失。
      const liRuns = (li, prefix) => {
        const inner = li.cloneNode(true);
        const cbIn = inner.querySelector('input[type="checkbox"]');
        if (cbIn && cbIn.parentNode) cbIn.parentNode.removeChild(cbIn);
        const runs = collectInlineRuns(inner);
        if (prefix) runs.unshift({ text: prefix });
        if (!runs.length) runs.push({ text: '' });
        return runs;
      };
      for (const li of el.querySelectorAll(':scope > li')) {
        idx += 1;
        const cb = li.querySelector('input[type="checkbox"]');
        const prefix = cb ? (cb.checked ? '☑ ' : '☐ ') : '';
        nodes.push({ type: 'bullet', ordered, marker: ordered ? `${idx}.` : '', level: 0, runs: liRuns(li, prefix) });
        const nestedUl = li.querySelector(':scope > ul, :scope > ol');
        if (nestedUl) {
          const nOrdered = nestedUl.tagName.toLowerCase() === 'ol';
          let nidx = 0;
          for (const nli of nestedUl.querySelectorAll(':scope > li')) {
            nidx += 1;
            nodes.push({
              type: 'bullet', ordered: nOrdered, marker: nOrdered ? `${nidx}.` : '', level: 1,
              runs: liRuns(nli, ''),
            });
          }
        }
      }
      return [{ type: 'list', children: nodes }];
    }
    // 定义列表 <dl>：<dt> 加粗段落 + <dd> 缩进段落（对齐预览 .preview-content dt/dd）。
    // 此前 dl 不在白名单里 → 整个定义列表在 Word 里整块丢失。
    if (tag === 'dl') {
      const nodes = [];
      for (const child of el.children) {
        const ct = child.tagName.toLowerCase();
        if (ct === 'dt') {
          const runs = collectInlineRuns(child);
          for (const r of runs) if (typeof r.text === 'string') r.bold = true;
          if (runs.length) nodes.push({ type: 'paragraph', runs });
        } else if (ct === 'dd') {
          const runs = collectInlineRuns(child);
          if (runs.length) nodes.push({ type: 'paragraph', runs, indent: { left: 360 } });
        }
      }
      return nodes;
    }
    if (tag === 'table') {
      const rows = [];
      for (const tr of el.querySelectorAll('tr')) {
        const cells = [];
        for (const td of tr.querySelectorAll('th, td')) {
          const runs = collectInlineRuns(td);
          // text 保留（无 runs 时的兜底 + 既有结构契约），但必须由 runs 拼接 ——
          // 用 textContent 会把公式的 MathML/LaTeX 源码/可见文本拼成 "α\alphaα"。
          const text = runs.map((r) => (typeof r.text === 'string' ? r.text : '')).join('');
          const para = runs.length ? { text, runs } : { text };
          cells.push({ paragraphs: [para], width: 0 });
        }
        rows.push({ cells });
      }
      return [{ type: 'table', rows }];
    }
    if (tag === 'img') {
      const img = imageToNode(el);
      return img ? [img] : [];
    }
    if (tag === 'hr') return [{ type: 'hr' }];
    // 独立公式块：<span class="math-display"> / <div class="math-display"> 内含已渲染 KaTeX
    if (/math-display/.test(el.className || '')) {
      const mathEl = el.querySelector('.katex-mathml math') || el.querySelector('math');
      if (mathEl) {
        const mathml = mathEl.outerHTML;
        if (mathml) {
          return [{ type: 'paragraph', runs: [{ mathml }], align: 'center' }];
        }
      }
      // 未渲染成 KaTeX（公式渲染失败等）：回退到纯文本
      const txt = (el.textContent || '').trim();
      return txt ? [{ type: 'paragraph', runs: [{ text: txt }], align: 'center' }] : [];
    }
    // 顶层直接是 .katex（无 math-display 包裹）：提取公式
    if (tag === 'span' && typeof el.className === 'string' && el.className.split(/\s+/).includes('katex')) {
      const mathEl = el.querySelector('.katex-mathml math') || el.querySelector('math');
      if (mathEl) {
        const mathml = mathEl.outerHTML;
        if (mathml) return [{ type: 'paragraph', runs: [{ mathml }] }];
      }
    }
    if (tag === 'div' && /mermaid-container|diagram-container/.test(el.className || '')) {
      const img = el.querySelector('img');
      return img ? elementToNode(img) : [];
    }
    if (tag === 'div' && /alert/.test(el.className || '')) {
      const imgs = [];
      const title = el.querySelector('.alert-title');
      const content = el.querySelector('.alert-content');
      const runs = [];
      if (title) {
        // 标题按纯文本 + 加粗；公式必须走 mathml run —— textContent 会把 KaTeX 的
        // MathML 渲染文本 + <annotation> 的 LaTeX 源码 + katex-html 可见文本拼成
        // "公式 α\alphaα 的取值"（2026-09-14 用户导出验证）。
        const titleRuns = collectInlineRuns(title);
        for (const r of titleRuns) if (typeof r.text === 'string') r.bold = true;
        if (titleRuns.length) runs.push(...titleRuns);
        runs.push({ text: '\n' });
      }
      if (content) runs.push(...(collectRuns(content, undefined, imgs)));
      const nodes = [];
      // 提示框同理：把 _prepareWordDOM 内联的彩色底/左边框色带进 docx（此前底纹全丢）
      if (runs.length) nodes.push({
        type: 'paragraph', runs, quote: true,
        quoteBg: cssColorToHex(el.style.backgroundColor || el.style.background) || '',
        quoteColor: cssColorToHex(el.style.borderLeftColor) || '',
      });
      nodes.push(...imgs);
      return nodes;
    }
    // 代码块容器：_prepareWordDOM 会把每个 <pre> 换成 div.tizu-code-block（内部 pre 用 <br> 换行）。
    // 这里必须下探取回代码文本，否则代码块在 docx 主路径里会整块丢失。
    if (tag === 'div' && /tizu-code-block/.test(el.className || '')) {
      const pre = el.querySelector('pre') || el;
      const copy = pre.cloneNode(true);
      copy.querySelectorAll('br').forEach((br) => br.replaceWith('\n'));
      const text = copy.textContent || '';
      const lines = text.split('\n').map(l => l.trimEnd()).filter((l, i, a) => !(i === a.length - 1 && l === ''));
      return lines.length ? [{ type: 'code', lines }] : [];
    }
    // 兜底：白名单未命中的标签不再整块丢弃（历史 bug：<dl> 定义列表、
    // <section class="footnotes"> 脚注区在 Word 里整块消失，页面上只剩一条分隔线）。
    // 策略：先把子元素当块级继续下探（list 节点展平），子元素无产出但自身有文本时
    // 退化为段落（覆盖裸 <span>/<a>/<figure> 这类纯包裹层）。
    if (SKIP_TAGS.has(tag)) return [];
    const nested = [];
    for (const child of el.children) {
      for (const n of elementToNode(child)) {
        if (n && n.type === 'list') nested.push(...n.children);
        else if (n) nested.push(n);
      }
    }
    if (nested.length) return nested;
    const fallbackText = (el.textContent || '').replace(/\s+/g, ' ').trim();
    return fallbackText ? [{ type: 'paragraph', runs: collectRuns(el) }] : [];
  }

  function domToDocxStructure(root) {
    const out = [];
    const walk = (el) => {
      for (const child of el.childNodes) {
        if (child.nodeType === 3) {
          const t = (child.textContent || '').trim();
          if (t) out.push({ type: 'paragraph', runs: [{ text: t }] });
          continue;
        }
        if (child.nodeType !== 1) continue;
        const nodes = elementToNode(child);
        for (const node of nodes) {
          if (node && node.type === 'list') out.push(...node.children);
          else if (node) out.push(node);
        }
      }
    };
    walk(root);
    return out;
  }

  const api = { domToDocxStructure };
  // 互斥式双导出（对齐仓库模块约定）：node 走 module.exports，浏览器/测试走 window，二者只触发其一。
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else if (typeof window !== 'undefined') {
    window.domToDocxStructure = domToDocxStructure;
  }
})();
