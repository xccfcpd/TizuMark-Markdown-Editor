// docx 真 OOXML 构建器：把「DOM→中间结构」转成 DocxLib 的 Document 并打包成 Blob。
//
// 运行位置：优先由 export.js 把它与 docx 库内联进 Web Worker 脚本里执行（释放主线程）；
// 若 Worker 不可用 / 依赖加载失败 / 超时 / 报错，则回退到主线程直构建（lib/docx.min.js
// 由 index.html 常驻加载）。主线程直构建时打包期间会有短暂阻塞（有 loading 遮罩兜底）。
// 因此本模块需同时支持三种全局：node(module.exports)、浏览器(window)、Worker(self)。
//
// 双导出：node 走 module.exports（测试），浏览器走 window 全局。
(function () {
  'use strict';

  // 解析 docx 库：node 测试走全局，浏览器走 window.DocxLib，Worker 走 self.DocxLib。
  function resolveDocxLib() {
    if (typeof window !== 'undefined' && window && window.DocxLib) return window.DocxLib;
    if (typeof self !== 'undefined' && self && self.DocxLib) return self.DocxLib;
    if (typeof DocxLib !== 'undefined') return DocxLib;
    return null;
  }

  // run → docx 子元素：omml run（可编辑公式）经 ImportedXmlComponent 注入 oMath；普通 run 转 TextRun。
  // 放在模块级是因为表格单元格 / 列表项也要用它（此前只在段落分支里内联，
  // 单元格与列表项只能退化成 textContent 纯文本，公式被拼成 "α\alphaα"）。
  function runToChild(D, r, opts) {
    // <br> 等换行标记：docx 用 break run 表达（此前被忽略成空 TextRun，换行在 Word 里丢失）
    if (r && r.break) return new D.TextRun({ break: 1 });
    if (r && r.omml) {
      try {
        const comp = D.ImportedXmlComponent.fromXmlString(r.omml);
        return (comp && comp.root && comp.root[0]) || new D.TextRun({ text: '' });
      } catch (e) {
        // 兜底：OMML 非法 XML（mml2omml 对复杂公式可能产出非良构 XML）时，
        // 降级为 OMML 内的纯文本，绝不让单个坏公式拖垮整篇文档构建。
        const fallback = String(r.omml).replace(/<[^>]+>/g, '').trim();
        return new D.TextRun({ text: fallback });
      }
    }
    // 标题强制加粗：docx 默认 Heading 样式（本库生成）不含 <w:b/>，
    // 仅靠样式不会加粗，故在 run 层显式 bold，保证标题在 Word 里显眼（用户反馈"标题没加粗"）。
    const bold = (opts && typeof opts.bold !== 'undefined') ? opts.bold : (r && r.bold);
    // 行内代码（<code>）：docx 无原生 code 样式，显式套等宽字体以与正文区分
    const font = (r && r.codeStyle) ? { name: 'Consolas' } : undefined;
    // <mark> 高亮：collectRuns 标了 runBase.highlight，此前 runToChild 直接丢弃，
    // 导致预览里的黄底高亮在 Word 里变成普通文字。这里落到 TextRun 的 highlight。
    const highlight = (r && r.highlight) ? 'yellow' : undefined;
    // 上标/下标（脚注引用 [1] 等）：collectRuns 标了 superScript/subScript
    // 颜色：docx 的颜色字段只接受 6 位 HEX，其余值（命名色 / 3 位 HEX / rgba() / var()）
    // 会让 `new TextRun(...)` 直接抛 "Invalid hex value 'XXX'. Expected 6 digit hex value"，
    // 一个内联颜色就能让整篇导出失败（2026-09-26 实测）。上游 collectRuns 已把颜色归一成
    // 6 位 HEX，这里是最后防线：不合法就丢弃颜色 —— 与上面非法 OMML「降级为纯文本不抛错」
    // 同一原则（坏输入绝不中止整篇）。
    const color = (r && typeof r.color === 'string' && /^[0-9A-Fa-f]{6}$/.test(r.color))
      ? r.color.toUpperCase()
      : undefined;
    return new D.TextRun({
      text: (r && r.text) || '',
      bold,
      italics: r && r.italics,
      strike: r && r.strike,
      color,
      font,
      highlight,
      superScript: (r && r.superScript) ? true : undefined,
      subScript: (r && r.subScript) ? true : undefined,
    });
  }

  // CSS text-align → docx AlignmentType。
  // 必须显式映射，不能用 AlignmentType[值] 动态取：AlignmentType 的【属性名是大写、值是小写】
  //（AlignmentType.CENTER === 'center'），而 CSS 读回来就是小写（el.style.textAlign === 'center'），
  // 所以原先的 AlignmentType[node.align] 永远取到 undefined → 对齐被【静默丢弃】：
  // 独立公式的居中、text-align:center/right 的段落在 Word 里全部变成左对齐（2026-09-26 实测，
  // document.xml 里连 <w:jc> 都没有）。start/end 归一为 left/right：视觉等价且各版 Word 都认。
  const CSS_ALIGN_TO_KEY = {
    left: 'LEFT', start: 'LEFT', center: 'CENTER', right: 'RIGHT',
    end: 'RIGHT', justify: 'JUSTIFIED', justified: 'JUSTIFIED',
  };
  function alignmentOf(AlignmentType, align) {
    if (!AlignmentType || !align) return undefined;
    const key = CSS_ALIGN_TO_KEY[String(align).trim().toLowerCase()];
    return key ? AlignmentType[key] : undefined;
  }

  function buildTable(D, node, theme, toChild) {
    // 空表格（无 <tr> 的 <table>，原始 HTML 里常见）必须在这里挡掉：
    // docx 的 Table 构造器会算 Array(Math.max(...rows.map(r => r.CellCount)))，rows 为空时
    // Math.max() 得 -Infinity → 抛 RangeError: Invalid array length，**整篇导出失败**（2026-09-26 实测）。
    const rowsIn = (node.rows || []).filter(r => r && Array.isArray(r.cells) && r.cells.length);
    if (!rowsIn.length) return null;
    // 列宽：cell.width 之前传 0 导致 Word 列宽全 0、排版乱。按列数平均分配 100%。
    const colCount = rowsIn[0].cells.length;
    const colW = Math.floor(100 / Math.max(1, colCount));
    const borderColor = (theme && theme.border) || 'D4D4D8';
    // 表格单元格行距跟随预览「行高」（theme 即 page 配置），与正文 docDefaults 保持一致；
    // 之前硬编码 line:276（≈1.15 倍），导致表格内行距比正文（1.7）明显更紧。
    const tableLineH = (theme && Number(theme.lineHeight)) ? Number(theme.lineHeight) : 1.7;
    const rows = rowsIn.map(row => new D.TableRow({
      children: row.cells.map(cell => new D.TableCell({
        children: (cell.paragraphs || []).map(p => new D.Paragraph({
          // 单元格段落优先用 runs（公式/高亮/加粗/上标在里面）；没有 runs 才退回纯文本。
          ...(Array.isArray(p.runs) && p.runs.length
            ? { children: p.runs.map(r => toChild(r)) }
            : { text: p.text || '' }),
          // 行高调高：before/after 由 20 提升到 60 让表格每行更舒展（用户反馈"每行高度调高一点"）
          spacing: { before: 60, after: 60, line: Math.round(tableLineH * 240), lineRule: 'auto' },
        })),
        width: { size: (cell.width && cell.width > 0) ? cell.width : colW, type: D.WidthType.PERCENTAGE },
      }))
    }));
    return new D.Table({
      rows,
      width: { size: 100, type: D.WidthType.PERCENTAGE },
      borders: {
        top: { style: D.BorderStyle.SINGLE, size: 4, color: borderColor },
        bottom: { style: D.BorderStyle.SINGLE, size: 4, color: borderColor },
        left: { style: D.BorderStyle.SINGLE, size: 4, color: borderColor },
        right: { style: D.BorderStyle.SINGLE, size: 4, color: borderColor },
        insideHorizontal: { style: D.BorderStyle.SINGLE, size: 4, color: borderColor },
        insideVertical: { style: D.BorderStyle.SINGLE, size: 4, color: borderColor },
      },
    });
  }

  async function buildDocxFromStructure(structure, page) {
    const D = resolveDocxLib();
    if (!D) throw new Error('docx 库未加载（DocxLib）');
    const { Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType } = D;
    // run → docx 子元素统一走模块级 runToChild(D, ...)：表格单元格 / 列表项也复用它。
    const toChild = (r, opts) => runToChild(D, r, opts);
    const children = [];
    // 分块让出主线程：构建大文档的 docx 节点是同步重 CPU 操作，全程不 yield 会表现为
    // "导出时界面独占、转圈卡死、点不动"（2026-09-25 用户复现）。每 200 个节点让出一帧，
    // 使 loading spinner 持续转动、取消按钮可响应；纯局部改写，不改变产出结构。
    const _nodes = structure || [];
    for (let _i = 0; _i < _nodes.length; _i++) {
      const node = _nodes[_i];
      if (_i % 200 === 0) await new Promise((r) => setTimeout(r, 0));
      if (node.type === 'heading') {
        children.push(new Paragraph({ heading: HeadingLevel['HEADING_' + (node.level || 1)], children: (node.runs || []).map(r => toChild(r, { bold: true })) }));
      } else if (node.type === 'paragraph') {
        // quote 段落（blockquote / alert）：加左缩进 + 左边框，否则与普通段落无视觉区分。
        const opts = { children: (node.runs || []).map(r => toChild(r)) };
        // 对齐必须走 CSS→枚举映射，不能 AlignmentType[node.align]（键大写/值小写，查不到就静默丢）
        const align = alignmentOf(AlignmentType, node.align);
        if (align) opts.alignment = align;
        // 缩进段落（定义列表 <dd> 等）：预览里 dd 有左缩进，Word 里同步
        if (node.indent) opts.indent = node.indent;
        if (node.quote) {
          opts.indent = { left: 360 }; // 0.25 英寸
          opts.border = { left: { style: D.BorderStyle.SINGLE, size: 24, color: node.quoteColor || (page && page.accent) || '2563EB', space: 8 } };
          opts.spacing = { before: 80, after: 80 };
          // 引用块/提示框底色：预览里是灰底或彩色底，此前只加左边框 → Word 里"底没了"
          if (node.quoteBg) opts.shading = { type: D.ShadingType.CLEAR, fill: node.quoteBg };
        }
        children.push(new Paragraph(opts));
      } else if (node.type === 'bullet') {
        // 列表项用 runs（不再只取 runs[0].text）：脚注定义挂在 <ol><li> 里，
        // 其公式/高亮必须在 Word 里保住，不能退化成首个 run 的纯文本。
        const runs = (Array.isArray(node.runs) && node.runs.length) ? node.runs : [{ text: '' }];
        const level = node.level || 0;
        if (node.ordered) {
          // 有序列表：docx 的 bullet 只有圆点、无内置编号样式，故用「序号 + 悬挂缩进」呈现，
          // 视觉与预览的 1. 2. 3. 一致（不参与 Word 自动重新编号，改条目需重新导出）。
          children.push(new Paragraph({
            children: [{ text: `${node.marker || ''} ` }, ...runs].map(r => toChild(r)),
            indent: { left: 360 + level * 360, hanging: 240 },
            spacing: { before: 20, after: 20 },
          }));
        } else {
          children.push(new Paragraph({ children: runs.map(r => toChild(r)), bullet: { level } }));
        }
      } else if (node.type === 'table') {
        // buildTable 对「无有效行」的表格返回 null（空 rows 会让 new D.Table 抛 RangeError 中止整篇）
        const table = buildTable(D, node, page, toChild);
        if (table) children.push(table);
      } else if (node.type === 'code') {
        // 代码块：灰底 + 边框 + 等宽。每行一个独立段落，行间【不用】<w:br/> 软换行——
        // Word/WPS 的东亚排版会把「软换行结尾的行」按两端对齐强行拉伸到整行宽
        //（即使段落未设 w:jc、全文 0 处 jc，实测仍拉伸），代码行被扯出巨大空隙；
        // 而段落末行永远不会被拉伸。相邻段落的边框/底纹/缩进完全一致时 Word 会把
        // 边框合并为一个整体框，视觉上仍是一个连续代码块。显式 LEFT 对齐双保险。
        const total = (node.lines || []).length;
        (node.lines || []).forEach((l, idx) => {
          children.push(new Paragraph({
            alignment: AlignmentType.LEFT,
            children: [new TextRun({ text: l, font: { name: 'Consolas' } })],
            shading: { type: D.ShadingType.CLEAR, fill: (page && page.codeBg) || 'F6F5F4' },
            border: {
              top: { style: D.BorderStyle.SINGLE, size: 4, color: 'D4D4D8' },
              bottom: { style: D.BorderStyle.SINGLE, size: 4, color: 'D4D4D8' },
              left: { style: D.BorderStyle.SINGLE, size: 4, color: 'D4D4D8' },
              right: { style: D.BorderStyle.SINGLE, size: 4, color: 'D4D4D8' },
            },
            // 首行 before / 末行 after 各留 120 与正文过渡，行间 0 间距保持紧凑
            spacing: { before: idx === 0 ? 120 : 0, after: idx === total - 1 ? 120 : 0, line: 300, lineRule: 'auto' },
            indent: { left: 120, right: 120 },
          }));
        });
      } else if (node.type === 'image') {
        children.push(new Paragraph({
          children: [new D.ImageRun({
            type: node.imageType || 'png',
            data: Uint8Array.from(node.data || []),
            transformation: { width: node.width, height: node.height },
          })]
        }));
      } else if (node.type === 'hr') {
        // 水平线：段落底边框。
        children.push(new Paragraph({
          border: { bottom: { style: D.BorderStyle.SINGLE, size: 6, color: (page && page.border) || 'D4D4D8', space: 1 } },
          spacing: { before: 80, after: 80 },
        }));
      }
    }
    // 全局默认段落间距 + 正文字体/字号（跟随预览）：否则 Word 默认段落零间距、字体不一致。
    const fontName = (page && page.baseFont) || undefined;
    const docRun = {};
    if (fontName) docRun.font = fontName;
    if (page && page.baseSize) docRun.size = page.baseSize;
    // 行距跟随预览的「行高」设置（page.lineHeight，默认 1.7）；OOXML 里 1 倍行距 = 240。
    // 之前固定 line:276（≈1.15 倍），所以 Word 里行距明显比预览紧。
    const lineH = (page && Number(page.lineHeight)) ? Number(page.lineHeight) : 1.7;
    const docDefaults = { paragraph: { spacing: { before: 40, after: 40, line: Math.round(lineH * 240), lineRule: 'auto' } } };
    if (Object.keys(docRun).length) docDefaults.run = docRun;

    // 标题样式：覆盖 Word 内置的蓝色 Calibri Light，改用预览字体 + 主题标题色 + 加粗，
    // 并还原预览的字号倍率与 h1/h2 下边框，使 docx 标题与软件预览一致。
    const headingStyles = {};
    if (page && page.headingSizes) {
      const hc = page.headingColor || '2C2C2E';
      const sc = page.textSecondary || '6E6E72';
      const bc = page.border || 'D4D4D8';
      const mkHeading = (idx, color, border) => {
        const run = { bold: true, color };
        if (page.headingSizes[idx]) run.size = page.headingSizes[idx];
        if (fontName) run.font = fontName;
        const paragraph = { spacing: { before: 200, after: 100 } };
        if (border) paragraph.border = { bottom: { style: D.BorderStyle.SINGLE, size: border.size, color: border.color, space: 4 } };
        return { run, paragraph };
      };
      headingStyles.heading1 = mkHeading(0, hc, { size: 12, color: hc });
      headingStyles.heading2 = mkHeading(1, hc, { size: 6, color: bc });
      headingStyles.heading3 = mkHeading(2, hc, null);
      headingStyles.heading4 = mkHeading(3, hc, null);
      headingStyles.heading5 = mkHeading(4, sc, null);
      headingStyles.heading6 = mkHeading(5, sc, null);
    }

    const doc = new Document({
      styles: {
        default: {
          document: docDefaults,
          ...headingStyles,
        },
      },
      sections: [{
        properties: {
          page: {
            size: { width: page.pageWidth, height: page.pageHeight },
            margin: { top: page.marginTop, bottom: page.marginBottom, left: page.marginLeft, right: page.marginRight },
          },
        },
        children,
      }]
    });
    return Packer.toBlob(doc);
  }

  const api = { buildDocxFromStructure };
  // 双导出：node 走 module.exports（测试），浏览器走 window 全局，Web Worker 走 self 全局。
  // 注：docx 构建现可放进 Worker 以释放主线程（见 export.js _buildDocxInWorker），
  // 故需在 self 上暴露，使 Worker 经 importScripts 加载后能拿到 buildDocxFromStructure。
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else if (typeof window !== 'undefined') {
    window.buildDocxFromStructure = buildDocxFromStructure;
  } else if (typeof self !== 'undefined') {
    self.buildDocxFromStructure = buildDocxFromStructure;
  }
})();
