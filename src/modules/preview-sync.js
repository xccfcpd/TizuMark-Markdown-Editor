// 预览渲染与滚动同步、虚拟滚动
// 从 src/app.js 拆分而来：方法体原样搬运，经 mixin 挂到 MarkdownEditor.prototype，
// 因此方法内的 this 仍指向编辑器实例，模块之间可继续用 this.xxx() 互调。
(function () {
  'use strict';

  const mixin = {
      debounceUpdatePreview() {
        // 任务列表勾选来源：预览 DOM 已就地同步，跳过全量重渲染（不防抖，立即轻量刷新字数/大纲）
        if (this._suppressNextPreviewRerender) {
          this._suppressNextPreviewRerender = false;
          this.updateWordCount();
          this.updateOutline();
          return;
        }
        clearTimeout(this.debounceTimer);
        this.debounceTimer = setTimeout(() => {
          this.updatePreview(true);
          this.updateWordCount();
          this.updateOutline();
        }, 300);
      },
      // 从预览元素获取对应的源文件行号（通过 unified 嵌入的 data-source-line）
      _getSourceLine(el) {
        if (el.dataset && el.dataset.sourceLine) {
          return parseInt(el.dataset.sourceLine, 10);
        }
        const inner = el.querySelector('[data-source-line]');
        if (inner) {
          return parseInt(inner.dataset.sourceLine, 10);
        }
        return null;
      },
      // 构建逐行密集位置映射（纯线性插值，无速度限制）
      // 每个编辑器行都有精确的 previewTop 插值
      // 无缓存：每次调用全量重建，与 legacy-master 行为一致（用户报告精准匹配）。
      // 3dac68c 引入的 dirty 缓存 + 布局指纹会造成某些场景下位置表过期（编辑器布局变化但
      // preview scrollHeight 未变时缓存命中 → 用旧表插值），此版本回退到 legacy 行为。
      // elements 可选：调用方（rebuildScrollSync）已查询过同一批元素时直接传入，
      // 省掉一次对整棵预览 DOM 的 querySelectorAll（2026-09-26）。
      _computedPosition(elements) {
        // 缓存：大文档（数千行/数千块级元素）下，原实现每次滚动 tick 都全量重算
        //（对所有行调 cm.heightAtLine + 重建与行数等长的数组），导致滚动掉帧。
        // 仅在「预览重渲染」（rebuildScrollSync 置脏）或「编辑器内容变化」（changeGeneration 改变）
        // 时才重算，滚动 tick 直接复用上次结果；内容没变则同步精度不变。
        // 仅以「预览重渲染」（rebuildScrollSync 置脏）与「行数变化」为失效条件：
        // 去掉原先的 changeGeneration 键——它每次键击都变，会使大文档每次输入后全量重算
        // （对所有行 cm.heightAtLine + 重建与行数等长的数组），造成打字/滚动偶发卡顿（2026-09-25 审计）。
        // 现在仅在内容真实改变结构（行数增减）或预览重渲后才重算，输入过程复用缓存、与延迟渲染中的预览一致。
        const lineCount = (typeof this.cm.lineCount === 'function') ? this.cm.lineCount() : 0;
        if (!this._positionCacheDirty && this._editorElementList && this._previewElementList &&
            this._positionLineCount === lineCount) {
          return;
        }
        this._positionCacheDirty = false;
        this._positionLineCount = lineCount;
        const allElements = elements || this.preview.querySelectorAll('[data-source-line]');
        const anchors = [];
        const seenLines = new Set();
  
        for (const el of allElements) {
          // 跳过脚注区域内的元素（source line 在文档中部但渲染在预览最底部）
          if (el.closest('.footnotes')) continue;
  
          const sourceLine = parseInt(el.dataset.sourceLine, 10);
          if (isNaN(sourceLine)) continue;
          if (seenLines.has(sourceLine)) continue;
          seenLines.add(sourceLine);
  
          const editorTop = this.cm.heightAtLine(Math.max(0, sourceLine - 1), 'local');
          const previewTop = this._getOffsetTop(el);
          if (typeof editorTop !== 'number' || typeof previewTop !== 'number') continue;
  
          anchors.push({ line: sourceLine, editorTop, previewTop });
        }
  
        if (anchors.length < 2) {
          this._editorElementList = null;
          this._previewElementList = null;
          return;
        }
  
        anchors.sort((a, b) => a.line - b.line);
  
        // 过滤非单调锚点（只检查 editorTop）
        const clean = [anchors[0]];
        for (let i = 1; i < anchors.length; i++) {
          if (anchors[i].editorTop > clean[clean.length - 1].editorTop) {
            clean.push(anchors[i]);
          }
        }
  
        if (clean.length < 2) {
          this._editorElementList = null;
          this._previewElementList = null;
          return;
        }
  
        // 逐行构建密集数组
        const totalLines = this.cm.lineCount();
        const editorList = new Array(totalLines);
        const rawPreviewList = new Array(totalLines);
        let anchorIdx = 0;
  
        for (let line = 0; line < totalLines; line++) {
          editorList[line] = this.cm.heightAtLine(line, 'local');
          const sourceLine = line + 1;
  
          while (anchorIdx + 1 < clean.length && clean[anchorIdx + 1].line <= sourceLine) {
            anchorIdx++;
          }
  
          if (anchorIdx >= clean.length - 1) {
            const last = clean[clean.length - 1];
            rawPreviewList[line] = last.previewTop + Math.max(0, sourceLine - last.line) * 20;
          } else {
            const a1 = clean[anchorIdx];
            const a2 = clean[anchorIdx + 1];
            const lineGap = a2.line - a1.line;
            if (lineGap <= 0) {
              rawPreviewList[line] = a1.previewTop;
            } else {
              rawPreviewList[line] = a1.previewTop + (sourceLine - a1.line) / lineGap * (a2.previewTop - a1.previewTop);
            }
          }
        }
  
        this._editorElementList = editorList;
        this._previewElementList = rawPreviewList;
      },
      // 返回预览视口顶部对应的源码行号（1-based）；测量失败返回 null。
      // 用于切换模式时把「预览像素位置」转成宽度无关的行锚点。
      _lineAtPreviewTop(pvTop) {
        this._computedPosition();
        const list = this._previewElementList;
        if (!list || list.length < 2) return null;
        // 二分找 previewList 中 <= pvTop 的最大行索引
        let lo = 0, hi = list.length - 1, ans = 0;
        while (lo <= hi) {
          const mid = (lo + hi) >> 1;
          if (list[mid] <= pvTop) { ans = mid; lo = mid + 1; }
          else hi = mid - 1;
        }
        return ans + 1; // 1-based 源码行
      },
      // 根据 unified 渲染结果重建滚动同步数据（仅在内容变化时调用）
      // content 可选：调用方（render）已持有同一份内容时传入，省一次 O(N) 的 cm.getValue() 大字符串重建。
      rebuildScrollSync(content) {
        const text = (content == null) ? this.cm.getValue() : content;
        // 行数按换行符扫描计数（不 split 分配）：空内容 = 1 行，与 split('\n').length 等价。
        let totalLines = 1;
        for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) totalLines++;

        // 预览内容变化：滚动同步位置表作废，下次 _computedPosition 重算（缓存守卫）
        this._positionCacheDirty = true;
        // 一次性取出预览中所有 [data-source-line] 元素：位置表与下方的 _linePositions 共用
        // 这一次查询 —— 原先同一次重建对整棵 DOM 查了两遍（2026-09-26）。
        const allElements = Array.from(this.preview.querySelectorAll('[data-source-line]'));
        // 构建平行位置数组（使用 data-source-line）
        this._computedPosition(allElements);
  
        // 生成 _linePositions（兼容 updatePreview 滚动恢复）；allElements 复用上方那一次查询
        const previewRect = this.preview.getBoundingClientRect();
        const st = this.preview.scrollTop;
        const sh = this.preview.scrollHeight || 1;
        const positions = [{ line: 0, fraction: 0 }];
        const seen = new Set();
  
        // 超大预览：元素过多时只采样测量，未测行靠行号线性插值，避免全量 getBoundingClientRect 重排卡顿
        const MAX_SYNC_SAMPLES = 2000;
        const step = Math.max(1, Math.ceil(allElements.length / MAX_SYNC_SAMPLES));
  
        for (let i = 0; i < allElements.length; i++) {
          if (step > 1 && i % step !== 0 && i !== allElements.length - 1) continue;
          const child = allElements[i];
          const sourceLine = parseInt(child.dataset.sourceLine, 10);
          if (isNaN(sourceLine)) continue;
          if (seen.has(sourceLine)) continue;
          seen.add(sourceLine);
  
          const rect = child.getBoundingClientRect();
          const elTop = rect.top - previewRect.top + st;
          const elBottom = elTop + child.offsetHeight;
  
          positions.push({ line: sourceLine, fraction: Math.min(Math.max(elTop / sh, 0), 1) });
          positions.push({ line: sourceLine + 1, fraction: Math.min(Math.max(elBottom / sh, 0), 1) });
        }
  
        positions.push({ line: totalLines - 1, fraction: 1 });
        positions.sort((a, b) => a.line - b.line);
  
        const deduped = [];
        let lastLine = -1;
        for (const p of positions) {
          if (p.line !== lastLine) {
            deduped.push(p);
            lastLine = p.line;
          }
        }
        if (deduped.length === 0 || deduped[0].line > 0) deduped.unshift({ line: 0, fraction: 0 });
        if (deduped[deduped.length - 1].line < totalLines - 1) deduped.push({ line: totalLines - 1, fraction: 1 });
        this._linePositions = deduped;
      },
      // demo 的 getHeightToTop：计算元素到容器顶部的距离（offsetTop 遍历 offsetParent）
      _getOffsetTop(el) {
        let top = el.offsetTop;
        let parent = el.offsetParent;
        while (parent && parent !== this.preview) {
          top += parent.offsetTop;
          parent = parent.offsetParent;
        }
        return top;
      },
      // demo 风格：节流函数（首次立即执行，后续在 delay 内只保存最后一次调用）
      _throttleScroll(fn, delay) {
        if (this._scrollThrottleTimer) {
          this._scrollThrottlePending = fn;
          return;
        }
        fn();
        this._scrollThrottleTimer = setTimeout(() => {
          this._scrollThrottleTimer = null;
          if (this._scrollThrottlePending) {
            const pending = this._scrollThrottlePending;
            this._scrollThrottlePending = null;
            this._throttleScroll(pending, delay);
          }
        }, delay);
      },
      // demo 风格：防抖函数（每次调用重置计时器）
      _debounceScroll(fn, delay) {
        clearTimeout(this._scrollDebounceTimer);
        this._scrollDebounceTimer = setTimeout(fn, delay);
      },
      // demo 风格：恢复滚动（重置双标志锁）
      _resumeScroll() {
        this._canScroll.editor = true;
        this._canScroll.preview = true;
      },
      // 编辑器 → 预览同步（逐行密集插值）
      _syncEditorToPreview(editorTop) {
        if (this.previewWindow) { this._syncEditorToPreviewWindow(); return; }
        this._computedPosition();
  
        const editorList = this._editorElementList;
        const previewList = this._previewElementList;
        if (!editorList || editorList.length < 2) return;
  
        const { scrollHeight, clientHeight } = this.preview;
        const cmInfo = this.cm.getScrollInfo();
        const top = (editorTop != null) ? editorTop : cmInfo.top;
  
        if (top <= 0.5) { this.preview.scrollTop = 0; return; }
        if (top + clientHeight >= cmInfo.height - 0.5) {
          this.preview.scrollTop = Math.max(0, scrollHeight - clientHeight);
          return;
        }
  
        let lo = 0, hi = editorList.length - 1;
        while (lo < hi) {
          const mid = (lo + hi) >>> 1;
          if (editorList[mid] <= top) lo = mid + 1;
          else hi = mid;
        }
        let idx = lo - 1;
        if (idx < 0) { this.preview.scrollTop = 0; return; }
        if (idx >= editorList.length - 1) {
          this.preview.scrollTop = Math.max(0, scrollHeight - clientHeight);
          return;
        }
  
        const editorStart = editorList[idx];
        const editorEnd = editorList[idx + 1];
        const previewStart = previewList[idx];
        const previewEnd = previewList[idx + 1];
  
        if (editorEnd <= editorStart || previewEnd < 0 || previewStart < 0) {
          this.preview.scrollTop = previewStart;
          return;
        }
  
        const targetScrollTop = previewStart + (top - editorStart) / (editorEnd - editorStart) * (previewEnd - previewStart);
        this.preview.scrollTop = Math.max(0, Math.min(targetScrollTop, scrollHeight - clientHeight));
      },
      // 预览 → 编辑器同步（逐行密集插值）
      // previewTop 可选：指定预览滚动位置作为来源；省略则读当前预览 scrollTop。
      // 切换模式时用它传入「已保存的预览位置」，避免依赖此刻可能不可靠的实时值。
      _syncPreviewToEditor(previewTop) {
        if (this.previewWindow) { this._syncPreviewToEditorWindow(); return; }
        this._computedPosition();
  
        const previewList = this._previewElementList;
        const editorList = this._editorElementList;
        if (!previewList || previewList.length < 2) return;
  
        const { scrollHeight, clientHeight } = this.preview;
        const cmInfo = this.cm.getScrollInfo();
        const pvTop = (previewTop != null) ? previewTop : this.preview.scrollTop;
  
        if (pvTop <= 0.5) { this.cm.scrollTo(0, 0); return; }
        if (pvTop + clientHeight >= scrollHeight - 0.5) {
          this.cm.scrollTo(0, Math.max(0, cmInfo.height - cmInfo.clientHeight));
          return;
        }
  
        let lo = 0, hi = previewList.length - 1;
        while (lo < hi) {
          const mid = (lo + hi) >>> 1;
          if (previewList[mid] <= pvTop) lo = mid + 1;
          else hi = mid;
        }
        let idx = lo - 1;
        if (idx < 0) { this.cm.scrollTo(0, 0); return; }
        if (idx >= previewList.length - 1) {
          this.cm.scrollTo(0, Math.max(0, cmInfo.height - cmInfo.clientHeight));
          return;
        }
  
        const previewStart = previewList[idx];
        const previewEnd = previewList[idx + 1];
        const editorStart = editorList[idx];
        const editorEnd = editorList[idx + 1];
  
        if (previewEnd <= previewStart || editorEnd < 0 || editorStart < 0) {
          this.cm.scrollTo(0, editorStart);
          return;
        }
  
        const targetEditorTop = editorStart + (pvTop - previewStart) / (previewEnd - previewStart) * (editorEnd - editorStart);
        this.cm.scrollTo(0, targetEditorTop);
      },
      // 滑动窗口模式：编辑器滚动 → 预览
      // 焦点（编辑区视口顶部对应行）落在窗口内则直接定位预览；否则以焦点重新渲染窗口
      _syncEditorToPreviewWindow() {
        const win = this.previewWindow;
        if (!win) return;
        const cmInfo = this.cm.getScrollInfo();
        const focus = this.cm.lineAtHeight(cmInfo.top, 'local'); // 0-based
        if (focus < win.start + 8 || focus > win.end - 8) {
          this._previewFocusLine = Math.max(0, Math.min(focus, this.cm.lineCount() - 1));
          this.debounceUpdatePreview();
          return;
        }
        this._focusPreviewToLine(focus);
      },
      // 滑动窗口模式：预览滚动 → 编辑器
      // 预览仅含窗口片段，按当前预览滚动位置反查窗口内对应源码行，回滚编辑器
      _syncPreviewToEditorWindow() {
        if (!this._windowLineTops || !this._windowLineTops.length) return;
        const st = this.preview.scrollTop;
        let bestLine = this.previewWindow.start;
        let bestTop = -Infinity;
        for (const [ln, top] of this._windowLineTops) {
          if (top <= st + 1 && top > bestTop) { bestLine = ln - 1; bestTop = top; }
        }
        const targetTop = this.cm.heightAtLine(bestLine, 'local');
        if (this.activeTab) this.activeTab.scrollPos = { top: targetTop, left: 0 };
        this.cm.scrollTo(0, targetTop);
      },
      // P2-1 Strangler（ADR-3）：以下 5 个虚拟窗口方法逻辑已迁至 PreviewController，
      // 当前保留薄委托，待全部调用点迁移后删除。
      _buildWindowLineTops() {
        return this.previewController._buildWindowLineTops();
      },
      _focusPreviewToLine(line) {
        return this.previewController._focusPreviewToLine(line);
      },
      _renderPreviewWindowBlock(finalHtml, win, totalLines) {
        return this.previewController._renderPreviewWindowBlock(finalHtml, win, totalLines);
      },
      _updateVirtualScrollMetrics() {
        return this.previewController._updateVirtualScrollMetrics();
      },
      _syncPreviewVirtualScroll() {
        return this.previewController._syncPreviewVirtualScroll();
      },
        async updatePreview(suppressLoading = false) {
          // P2-1 Strangler（ADR-3）：编排逻辑已迁至 PreviewController.render()，此处保留薄委托。
          return this.previewController.render(suppressLoading);
        },
      // P1-1：逻辑已抽到 src/modules/image-processor.js（纯函数 + 依赖注入）。
      // 这里只做 DI 适配：把实例字段/方法包成注入项，错误仍上交调用方（6772 处的 try/catch）。
      // hasImg 由渲染方按本次 HTML 预判传入：明确为 false 时无图可内联，直接跳过整棵预览 DOM
      // 的 img 查询与替换（2026-09-26）。不传（旧调用方 / 测试）时行为与原来完全一致。
      async processImages(hasImg) {
        if (hasImg === false) return;
        return ImageProcessor.processImages(this.preview, {
          activeTab: this.activeTab,
          imageCache: this._imageBase64Cache,
          tauri: TauriApi,
          getCachedImageURL: (dataUri) => this.getCachedImageURL(dataUri),
          getRenderGeneration: () => this._renderGeneration,
        });
      },
      processFootnotes() {
        this.preview.querySelectorAll('.footnote-ref a').forEach(link => {
          link.addEventListener('click', (e) => {
            e.preventDefault();
            const href = link.getAttribute('href');
            if (!href) return;
            const target = this.preview.querySelector(href);
            if (target) {
              target.scrollIntoView({ behavior: 'smooth', block: 'center' });
              target.classList.add('footnote-flash');
              setTimeout(() => target.classList.remove('footnote-flash'), 1500);
            }
          });
        });
  
        this.preview.querySelectorAll('.footnote-backref').forEach(link => {
          link.addEventListener('click', (e) => {
            e.preventDefault();
            const href = link.getAttribute('href');
            if (!href) return;
            const target = this.preview.querySelector(href);
            if (target) {
              target.scrollIntoView({ behavior: 'smooth', block: 'center' });
              target.classList.add('footnote-flash');
              setTimeout(() => target.classList.remove('footnote-flash'), 1500);
            }
          });
        });
      },
  };

  const api = { mixin };
  window.TMPreviewSync = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
