// ============================================================
// unified-admonitions —— Admonition（MkDocs 风格 !!! 语法）纯函数模块
// ------------------------------------------------------------
// 从 unified-renderer.js 抽出：零外部依赖，可被 node 直接 require 做单测。
// 渲染结构复用 .alert 类，从而免费获得既有样式与导出（DOCX/PDF/PNG）支持。
// ============================================================
'use strict';

// ============================================================
// Admonition（MkDocs / Python-Markdown 风格 !!! 语法）
// ------------------------------------------------------------
//   !!! note "自定义标题"
//       正文（缩进 4 空格，内部可用完整 Markdown，含嵌套 !!!）
//
//   ??? note "点击展开"      折叠（默认收起）
//   ???+ note "默认展开"     折叠（默认展开）
//
// 实现范式与 convertAlerts 完全一致：起始标记独立成行、结束标记独立成行并
// 「借用」紧随其后的空行，从而**不改变总行数** —— 这是 data-source-line
// 映射（滚动同步 / 点击跳转）保持正确的硬前提。
// 渲染结构复用 .alert 类，从而免费获得既有样式、导出（DOCX/PDF/PNG）支持。
// ============================================================

// 类型别名 → 规范类型
const ADMONITION_ALIASES = {
  note: 'note',
  abstract: 'abstract', summary: 'abstract', tldr: 'abstract',
  info: 'info', todo: 'info',
  tip: 'tip', hint: 'tip', important: 'important',
  success: 'success', check: 'success', done: 'success',
  question: 'question', help: 'question', faq: 'question',
  warning: 'warning', caution: 'warning', attention: 'warning',
  failure: 'failure', fail: 'failure', missing: 'failure',
  danger: 'danger', error: 'danger',
  bug: 'bug',
  example: 'example',
  quote: 'quote', cite: 'quote',
  // `:::` 容器语法里的 `details`（可折叠）。配色/图标复用 note，
  // 折叠语义由 parseContainerHeader 单独标记，无需新增 CSS 类型。
  details: 'note',
};

const ADMONITION_TITLES = {
  note: 'Note', abstract: 'Abstract', info: 'Info', tip: 'Tip', important: 'Important',
  success: 'Success', question: 'Question', warning: 'Warning', failure: 'Failure',
  danger: 'Danger', bug: 'Bug', example: 'Example', quote: 'Quote',
};

// Lucide 图标（内联 SVG，currentColor 继承各类型主题色）
const ADMONITION_ICONS = {
  note: '<svg class="alert-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 9a2.4 2.4 0 0 0-.706-1.706l-3.588-3.588A2.4 2.4 0 0 0 15 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2z"/><path d="M15 3v5a1 1 0 0 0 1 1h5"/></svg>',
  abstract: '<svg class="alert-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 6h13"/><path d="M8 12h13"/><path d="M8 18h13"/><path d="M3 6h.01"/><path d="M3 12h.01"/><path d="M3 18h.01"/></svg>',
  info: '<svg class="alert-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>',
  tip: '<svg class="alert-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5"/><path d="M9 18h6"/><path d="M10 22h4"/></svg>',
  important: '<svg class="alert-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>',
  success: '<svg class="alert-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.801 10A10 10 0 1 1 17 3.335"/><path d="m9 11 3 3L22 4"/></svg>',
  question: '<svg class="alert-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><path d="M12 17h.01"/></svg>',
  warning: '<svg class="alert-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>',
  failure: '<svg class="alert-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="m15 9-6 6"/><path d="m9 9 6 6"/></svg>',
  danger: '<svg class="alert-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 16h.01"/><path d="M12 8v4"/><path d="M15.312 2a2 2 0 0 1 1.414.586l4.688 4.688A2 2 0 0 1 22 8.688v6.624a2 2 0 0 1-.586 1.414l-4.688 4.688a2 2 0 0 1-1.414.586H8.688a2 2 0 0 1-1.414-.586l-4.688-4.688A2 2 0 0 1 2 15.312V8.688a2 2 0 0 1 .586-1.414l4.688-4.688A2 2 0 0 1 8.688 2z"/></svg>',
  bug: '<svg class="alert-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m8 2 1.88 1.88"/><path d="M14.12 3.88 16 2"/><path d="M9 7.13v-1a3.003 3.003 0 1 1 6 0v1"/><path d="M12 20c-3.3 0-6-2.7-6-6v-3a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v3c0 3.3-2.7 6-6 6"/><path d="M12 20v-9"/><path d="M6.53 9C4.6 8.8 3 7.1 3 5"/><path d="M6 13H2"/><path d="M3 21c0-2.1 1.7-3.9 3.8-4"/><path d="M20.97 5c0 2.1-1.6 3.8-3.5 4"/><path d="M22 13h-4"/><path d="M17.2 17c2.1.1 3.8 1.9 3.8 4"/></svg>',
  example: '<svg class="alert-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 6h13"/><path d="M8 12h13"/><path d="M8 18h13"/><path d="M3 6h.01"/><path d="M3 12h.01"/><path d="M3 18h.01"/></svg>',
  quote: '<svg class="alert-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 3a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h2a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2z"/><path d="M4 3a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h2a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2z"/></svg>',
};

// 前导空白宽度（Tab 记 4 列），用于判定缩进层级
function indentWidth(line) {
  let w = 0;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === ' ') w += 1;
    else if (c === '\t') w += 4;
    else break;
  }
  return w;
}

// 去掉最多 n 列前导空白（Tab 记 4 列），保留更深的相对缩进
function dedentLine(line, n) {
  let removed = 0;
  let i = 0;
  while (i < line.length && removed < n) {
    const c = line[i];
    if (c === ' ') { removed += 1; i++; }
    else if (c === '\t') { removed += 4; i++; }
    else break;
  }
  return line.slice(i);
}

function parseAdmonitionHeader(line) {
  const m = line.match(/^([ \t]*)(!!!|\?\?\?\+?)\s+([A-Za-z][\w-]*)(?:\s+"([^"]*)")?\s*$/);
  if (!m) return null;
  const type = ADMONITION_ALIASES[m[3].toLowerCase()];
  if (!type) return null;
  return {
    indent: indentWidth(m[1]),
    marker: m[2],
    type: type,
    title: m[4] || null,
    collapsible: m[2].charAt(0) === '?',
    open: m[2] === '???+',
  };
}

function getAdmonitionTitleHTML(type, customTitle) {
  let label = ADMONITION_TITLES[type] || type;
  if (customTitle) {
    label = customTitle
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  return '<div class="alert-title">' + (ADMONITION_ICONS[type] || '') + label + '</div>';
}

function convertAdmonitions(content) {
  const blocks = [];
  const text = convertAdmonitionsInto(String(content), blocks);
  return { content: text, blocks: blocks };
}

// ============================================================
// `:::` 容器语法（markdown-it-container / MkDocs 风格）
// ------------------------------------------------------------
//   ::: note                ::: tip "自定义标题"
//   正文（完整 Markdown）     正文
//   :::                     :::
//
// 与 `!!!` 的关键区别：正文由**同名围栏**显式闭合，不靠缩进。由此：
//   ① 开头/闭合各占一行，标记原地替换它们即天然保持总行数不变（`!!!` 需借空行）；
//   ② 正文可完全不缩进，且支持同级嵌套（靠深度计数配对）。
// 名字必须是已知的 admonition 类型，否则原样保留 —— 避免吃掉 `::: python` 这类习惯写法。
// `::: details` 渲染为**默认收起**的折叠块。
// ============================================================

const CONTAINER_OPEN_RE = /^([ \t]*)(:{3,})[ \t]*([A-Za-z][\w-]*)?[ \t]*(.*)$/;
const CONTAINER_CLOSE_RE = /^[ \t]*:{3,}[ \t]*$/;

function parseContainerHeader(line) {
  const m = String(line).match(CONTAINER_OPEN_RE);
  if (!m) return null;
  const name = (m[3] || '').toLowerCase();
  if (!name) return null; // 纯 `:::` 行是闭合标记，不是开头
  const type = ADMONITION_ALIASES[name];
  if (!type) return null; // 未知名字：不当容器
  let title = (m[4] || '').trim();
  if (title) {
    const q = title.match(/^"([\s\S]*)"$/) || title.match(/^'([\s\S]*)'$/);
    if (q) title = q[1];
  } else {
    title = null;
  }
  return { type: type, title: title, collapsible: name === 'details' };
}

function convertAdmonitionsInto(content, blocks) {
  const lines = content.split('\n');
  const out = [];
  let i = 0;
  let inFence = false;
  let fenceChar = '';

  while (i < lines.length) {
    const line = lines[i];

    // 围栏代码块内不做任何转换
    const fm = line.match(/^\s*(`{3,}|~{3,})/);
    if (fm) {
      if (!inFence) { inFence = true; fenceChar = fm[1][0]; }
      else if (fm[1][0] === fenceChar) { inFence = false; }
      out.push(line);
      i++;
      continue;
    }
    if (inFence) { out.push(line); i++; continue; }

    const chdr = parseContainerHeader(line);
    if (chdr) {
      // 配对闭合围栏：用深度计数，内层的闭合行**留给递归**处理，
      // 这样嵌套的 `:::` 也能正确配对（只认"第一个冒号行"会把内层闭合当外层）。
      const body = [];
      let j = i + 1;
      let depth = 1;
      let inF = false;
      let fch = '';
      while (j < lines.length) {
        const l = lines[j];
        const fm2 = l.match(/^\s*(`{3,}|~{3,})/);
        if (fm2) {
          if (!inF) { inF = true; fch = fm2[1][0]; }
          else if (fm2[1][0] === fch) inF = false;
          body.push(l);
          j++;
          continue;
        }
        if (inF) { body.push(l); j++; continue; }
        if (CONTAINER_CLOSE_RE.test(l)) {
          depth--;
          if (depth === 0) { j++; break; }
          body.push(l);
        } else if (parseContainerHeader(l)) {
          depth++;
          body.push(l);
        } else {
          body.push(l);
        }
        j++;
      }
      if (depth !== 0) { out.push(line); i++; continue; } // 未闭合：原样保留，不吞内容

      const cidx = blocks.length;
      blocks.push({
        type: chdr.type,
        title: chdr.title || (chdr.collapsible ? 'Details' : null),
        collapsible: chdr.collapsible,
        open: false, // `::: details` 默认收起
      });
      const cInner = convertAdmonitionsInto(body.join('\n'), blocks);
      out.push('<!--ADMONITION_' + cidx + '-->');
      for (const l of cInner.split('\n')) out.push(l);
      out.push('<!--ADMONITION_' + cidx + '_END-->');
      i = j;
      continue;
    }

    const hdr = parseAdmonitionHeader(line);
    if (!hdr) { out.push(line); i++; continue; }

    // 收集缩进体；尾随空行不属于正文（留给外层），避免吞掉段落分隔
    const body = [];
    let j = i + 1;
    while (j < lines.length) {
      const l = lines[j];
      if (l.trim() === '') {
        let k = j;
        while (k < lines.length && lines[k].trim() === '') k++;
        if (k < lines.length && indentWidth(lines[k]) > hdr.indent) {
          for (; j < k; j++) body.push('');
          continue;
        }
        break;
      }
      if (indentWidth(l) <= hdr.indent) break;
      body.push(dedentLine(l, hdr.indent + 4));
      j++;
    }

    if (body.length === 0) { out.push(line); i++; continue; }

    const idx = blocks.length;
    blocks.push({
      type: hdr.type,
      title: hdr.title,
      collapsible: hdr.collapsible,
      open: hdr.open,
    });
    // 递归处理嵌套 admonition（外层 idx 更小 → 还原时倒序先处理内层）
    const innerText = convertAdmonitionsInto(body.join('\n'), blocks);
    out.push('<!--ADMONITION_' + idx + '-->');
    for (const l of innerText.split('\n')) out.push(l);
    out.push('<!--ADMONITION_' + idx + '_END-->');

    // 结束标记「借用」紧随其后的一个空行，保持总行数不变
    if (j < lines.length && lines[j].trim() === '') j++;
    i = j;
  }

  return out.join('\n');
}

function buildAdmonitionHTML(block, inner) {
  const type = block.type;
  const titleHTML = getAdmonitionTitleHTML(type, block.title);
  if (block.collapsible) {
    return '<details class="alert alert-' + type + ' admonition admonition-' + type + '"' +
      (block.open ? ' open' : '') + ' data-admonition="' + type + '">' +
      '<summary class="alert-title admonition-summary">' + titleHTML.replace(/^<div class="alert-title">/, '').replace(/<\/div>$/, '') + '</summary>' +
      '<div class="alert-content admonition-content">' + inner + '</div></details>';
  }
  return '<div class="alert alert-' + type + ' admonition admonition-' + type + '" data-admonition="' + type + '">' +
    titleHTML +
    '<div class="alert-content admonition-content">' + inner + '</div></div>';
}

function restoreAdmonitions(html, blocks) {
  if (!blocks || blocks.length === 0) return html;
  let result = html;
  // 倒序还原：内层 index 更大 → 先还原内层，再还原外层
  for (let idx = blocks.length - 1; idx >= 0; idx--) {
    const startMarker = '<!--ADMONITION_' + idx + '-->';
    const endMarker = '<!--ADMONITION_' + idx + '_END-->';
    const startPos = result.indexOf(startMarker);
    const endPos = result.indexOf(endMarker);
    if (startPos === -1 || endPos === -1) continue;
    const before = result.slice(0, startPos);
    const inner = result.slice(startPos + startMarker.length, endPos);
    const after = result.slice(endPos + endMarker.length);
    result = before + buildAdmonitionHTML(blocks[idx], inner) + after;
  }
  return result;
}

module.exports = {
  convertAdmonitions,
  restoreAdmonitions,
  parseAdmonitionHeader,
  indentWidth,
  dedentLine,
  ADMONITION_ALIASES,
};
