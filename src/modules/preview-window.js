/**
 * preview-window.js —— 大文档虚拟窗口纯函数（ADR-2 / N7）
 *
 * 只搬两个纯函数：isBlockStart + computePreviewWindow。
 * 不依赖任何全局、不读模块级常量（常量由 opts 注入），便于单测与将来随 PreviewController 迁移。
 * NaN 归一化放在模块入口（N22 ①），覆盖全部现在与将来的写入点。
 *
 * 双导出：浏览器挂 window.PreviewWindow；node 走 module.exports（互斥式，N29）。
 */
(function () {
  'use strict';

  // 是否“块起点”（用于切割窗口时选择边界）：空行、标题、围栏、分割线、表格行
  function isBlockStart(s) {
    s = (s || '').trim();
    return s === '' || /^#{1,6}\s/.test(s) || /^`{3,}/.test(s) || /^~{3,}/.test(s) ||
           /^(-{3,}|\*{3,}|_{3,})$/.test(s) || s.startsWith('|');
  }

  // 大文档滑动窗口：根据焦点行（0-based）计算需要渲染的源码切片 [start, end)
  // opts: { maxLines = 5000, lead = 200, windowLines = 1200 }
  function computePreviewWindow(content, focusLine, opts) {
    opts = opts || {};
    const maxLines = Number.isFinite(opts.maxLines) ? opts.maxLines : 5000;
    const lead = Number.isFinite(opts.lead) ? opts.lead : 200;
    const windowLines = Number.isFinite(opts.windowLines) ? opts.windowLines : 1200;

    // N22 ①：模块入口归一化，焦点行非有限数一律视作 0（不污染窗口）
    const f = Number.isFinite(focusLine) ? focusLine : 0;
    const lines = (content == null ? '' : String(content)).split('\n');
    const total = lines.length;
    if (total <= maxLines) return { start: 0, end: total };

    let start = Math.max(0, f - lead);
    let end = Math.min(total, start + windowLines);
    if (end - start < windowLines) start = Math.max(0, end - windowLines);

    // 起点回退到块边界（含代码围栏起点，避免从围栏中间切开）
    let guard = 0;
    while (start > 0 && guard < 500) {
      if (isBlockStart(lines[start - 1])) { start -= 1; break; }
      start -= 1; guard++;
    }

    // 终点后移到块边界 / 围栏闭合处
    // P1-9 优化（N17）：原实现每步对整窗口 lines.slice(start,end+1).join('\n') 再全局正则，
    // 最坏 ~windowLines 次 join+match ≈ O(n²)。改为预计算每行围栏标记 + 前缀和，循环内 O(1)
    // 取区间 [start,end] 围栏奇偶，与原 slice+join+match 计数语义严格一致。
    const isFence = new Array(total);
    for (let i = 0; i < total; i++) isFence[i] = /^`{3,}|^~{3,}/.test(lines[i]);
    const fencePre = new Array(total + 1).fill(0);
    for (let i = 0; i < total; i++) fencePre[i + 1] = fencePre[i] + (isFence[i] ? 1 : 0);
    const fenceParityEven = (a, b) => ((fencePre[b + 1] - fencePre[a]) % 2) === 0;

    guard = 0;
    while (end < total && guard < 500) {
      if (fenceParityEven(start, end) && isBlockStart(lines[end]) && end > start) break;
      end += 1; guard++;
    }
    if (end > total) end = total;
    if (end <= start) end = Math.min(total, start + 1);
    return { start, end };
  }

  // 导出是否需要先做「全量渲染」：大文档预览只渲染滑动窗口（约 1200 行），而四个导出
  // 路径都基于 preview.cloneNode(true) → 直接导出只会得到窗口那一段。
  // 判定与预览用**同一套阈值**（由调用方注入，避免常量漂移）。
  // opts: { chars, lines, maxChars, maxLines, hasWindow }
  function shouldRenderFullForExport(opts) {
    opts = opts || {};
    if (opts.hasWindow === true) return true;                  // 已在窗口模式 → 必须全量
    const maxChars = Number.isFinite(opts.maxChars) ? opts.maxChars : 4 * 1024 * 1024;
    const maxLines = Number.isFinite(opts.maxLines) ? opts.maxLines : 5000;
    const chars = Number.isFinite(opts.chars) ? opts.chars : 0;
    const lines = Number.isFinite(opts.lines) ? opts.lines : 0;
    return chars > maxChars || lines > maxLines;               // 与 PreviewController 的 > 语义一致
  }

  const api = {
    isBlockStart: isBlockStart,
    computePreviewWindow: computePreviewWindow,
    shouldRenderFullForExport: shouldRenderFullForExport,
  };

  if (typeof window !== 'undefined' && typeof module === 'undefined') {
    window.PreviewWindow = api;
  } else if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})();
