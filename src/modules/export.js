// 导出 HTML / Word / PDF / 图片
// 从 src/app.js 拆分而来：方法体原样搬运，经 mixin 挂到 MarkdownEditor.prototype，
// 因此方法内的 this 仍指向编辑器实例，模块之间可继续用 this.xxx() 互调。
(function () {
  'use strict';
  const { dialogSave } = TMConst;

  // ============================================================
  // OMML「空必需参数槽」修复
  // ------------------------------------------------------------
  // Word 对【元素存在但为空】的必需参数槽一律渲染成**虚线占位小方框**，而 mathml2omml
  // 经常产出这种空槽，于是导出的 Word 里公式周围冒出虚框（用户 2026-09-14 截图）：
  //   ① 只有下标的 ∑/∫（\sum_i、\int_D）→ 空的 <m:sup/>（框画在运算符上方）
  //   ② 大运算符的"被作用表达式"在 MathML 里是**兄弟节点**（KaTeX：<munderover>∑…</munderover><mfrac>…），
  //      没被搬进 <m:e> → 空 <m:e/>（框画在运算符旁，后续分式被当成独立元素排在旁边）
  //   ③ 空基上下标（{}^{14}_{6}C 这种前置上下标写法）→ 空 <m:e/>
  //   ④ 空 lim（\xrightarrow{}、\ce{->}）→ 空 <m:lim/>
  // 处理规则（按 OMML schema 语义，而非按具体公式特征）：
  //   R1 nary 的空 sub/sup：直接删除（schema 允许缺省 → 槽不存在就没有框）
  //   R2 nary 的空 e：把后继「原子表达式」搬进去（连同一行前导空白一起搬，保持文本顺序）；
  //      没有可搬的 → 按 limLoc 降级成「字符 + 上下限」（视觉与预览一致，无框）
  //   R3 空基上下标：有后继原子 → 转前缀上下标 m:sPre（schema 次序 sub,sup,e，文本顺序不倒置）；
  //      无 → 把 sub/sup 内容上提为普通 run（不留孤儿槽）
  //   R4 空 lim：降级为 e 的内容
  //   R5 整块全空的上下标结构（mhchem 的零宽占位残渣）→ 直接删除：不删它会抢占后继原子，
  //      把生成的 sPre 槽位克隆成空 → 又变虚线框（2026-09-14 核素记号 \ce{^{235}_{92}U} 定位）
  //   R6 元素内「不在 <m:t> 里的裸文本」→ 包成正规 run <m:r><m:t>：mml2omml 会产出混排内容
  //      （<m:e><m:r><m:t>f</m:t></m:r>dx</m:e>），而 docx 库导入这类元素时会把带 run 的部分丢掉、
  //      只留裸文本 → Word 里该槽视觉为空 → 又是虚线框（2026-09-14 用户复核：∫_D f dx 等 29 条命中）
  //   R9 最终归一化（仅 docx 路径）：m:sPre / m:sSubSup 缺 sub 或 sup 任一必需槽时，Word 在另一侧
  //      画虚线框（化学式 CH₃COOH 等的下标框即此成因；HTML/PDF 经 KaTeX 不画）→ 补不可见占位 U+2061
  //      并校正 schema 子元素次序；同时填实残留的空基线 m:e 与空 num/den，使 docx 与软件渲染一致无框。
  // 输入健壮性（2026-09-14 定位）：mml2omml 不转义 <m:t> 文本，公式含裸 <（i<j、0<i<n）时
  //   OMML 非良构 → DOM 解析失败；旧行为直接原样返回，规则被静默跳过、空槽残留成虚线框。
  //   现在解析失败时先做「最小可解析化」（只转义 m:t 里不像 OMML 标签的裸 < 与游离 &）再重试。
  // 安全兜底（任一不满足即放弃本次修改、原样返回 —— 宁可保留现状也不产出坏公式）：
  //   I1 良构；I2 无孤儿槽（sub/sup/lim/e/num/den 不得直接挂在 m:oMath 下，违反 schema）；
  //   I3 原有文本顺序完整保留（允许新增 nary 的运算符字符）；I4 未命中的公式零改动
  // 说明：m:e 出现在矩阵行 m:mr 里时是【单元格】而非参数，Word 不画框，故规则里明确排除。
  // ============================================================
  const OMML_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/math';
  const OMML_ARG_SLOTS = {
    e: ['nary', 'rad', 'func', 'acc', 'bar', 'groupChr', 'limLow', 'limUpp', 'sSub', 'sSup', 'sSubSup', 'sPre', 'd', 'box', 'borderBox', 'f'],
    num: ['f'], den: ['f'],
    sub: ['nary', 'limLow', 'limUpp', 'sSub', 'sSubSup', 'sPre'],
    sup: ['nary', 'limUpp', 'sSup', 'sSubSup', 'sPre'],
    lim: ['limLow', 'limUpp'],
    fName: ['func'],
  };
  // 能整体作为 nary 操作数的「原子表达式」
  const OMML_ATOM_TAGS = ['f', 'sSup', 'sSub', 'sSubSup', 'sPre', 'rad', 'd', 'func', 'acc', 'bar', 'groupChr', 'limUpp', 'limLow', 'm', 'eqArr', 'box', 'borderBox', 'r'];
  // 以运算符 / 关系符 / 闭括号开头的 run 不是操作数（否则 ∑ 后面的 "+ ⋯" 会被吞进操作数）
  const OMML_OPERATOR_HEADS = ['+', '-', '−', '=', '<', '>', '≤', '≥', '≠', '±', '∓', '×', '÷', '⋅', '·', ',', ';', ')', ']', '}', '|', '/', ':', '→', '↔', '⇒', '⇔', '∈', '⊂', '∪', '∩', '≈', '≡', '∴', '…', '⋯'];

  const ommlTag = (el) => String(el.localName || el.nodeName).replace(/^.*:/, '');
  const ommlChild = (el, tag) => {
    for (const c of Array.from(el.children || [])) if (ommlTag(c) === tag) return c;
    return null;
  };
  const ommlIsEmpty = (el) => !!el && el.children.length === 0 && String(el.textContent || '').trim() === '';
  // 「视觉为空」：只含空 run（<m:r><m:t/></m:r>）或空白，没有任何实际内容/结构。
  // Word 对【存在但视觉为空】的必需参数槽同样画虚线占位框（2026-09-14 用户复核新版 docx：
  // ∑/∏/∫ 的"被作用表达式"槽里 mml2omml 塞了一个空 run，旧判定只认"完全没有子节点"→ 漏修 34 处）。
  const ommlVisuallyEmpty = (el) => {
    if (!el) return true;
    for (const c of Array.from(el.children)) {
      const t = ommlTag(c);
      if (t === 'rPr') continue;
      if (t === 'r') { if (String(c.textContent || '').trim()) return false; continue; }
      return false;
    }
    return String(el.textContent || '').trim() === '';
  };
  function ommlBottomUp(node, acc) {
    acc = acc || [];
    for (const c of Array.from(node.children || [])) { ommlBottomUp(c, acc); acc.push(c); }
    return acc;
  }
  function ommlText(root) {
    let s = '';
    (function walk(n) {
      for (const c of Array.from(n.childNodes || [])) {
        if (c.nodeType === 1) { if (ommlTag(c) === 't') s += c.textContent || ''; else walk(c); }
      }
    })(root);
    return s;
  }
  function ommlHasEmptyArgSlot(root) {
    for (const el of ommlBottomUp(root)) {
      const parents = OMML_ARG_SLOTS[ommlTag(el)];
      if (!parents) continue;
      const p = el.parentNode && el.parentNode.nodeType === 1 ? ommlTag(el.parentNode) : '';
      if (parents.indexOf(p) !== -1 && ommlIsEmpty(el)) return true;
    }
    return false;
  }
  const ommlMake = (doc, tag) => doc.createElementNS(OMML_NS, 'm:' + tag);
  function ommlMakeRun(doc, str) {
    const r = ommlMake(doc, 'r');
    const t = ommlMake(doc, 't');
    t.setAttribute('xml:space', 'preserve');
    t.textContent = str;
    r.appendChild(t);
    return r;
  }
  function ommlWrap(doc, tag, kids) {
    const w = ommlMake(doc, tag);
    for (const k of kids) if (k) w.appendChild(k);
    return w;
  }
  // 取 el 的"内容"（子节点）——用于把 sub/sup 的表达式放进 m:lim 等槽，避免把槽元素本身搬错位置
  function ommlInner(el) {
    const frag = el.ownerDocument.createDocumentFragment();
    for (const c of Array.from(el.childNodes)) frag.appendChild(c);
    return frag;
  }
  // nary 后面第一个可当操作数的"原子"（跳过纯空白 run，但不动它）
  function ommlNextAtom(el) {
    let n = el.nextElementSibling;
    while (n) {
      const tag = ommlTag(n);
      if (tag === 'r' && String(n.textContent || '').trim() === '') { n = n.nextElementSibling; continue; }
      if (OMML_ATOM_TAGS.indexOf(tag) === -1) return null;
      if (tag === 'r') {
        const t = String(n.textContent || '').trim();
        if (!t) return null;
        for (const op of OMML_OPERATOR_HEADS) if (t.indexOf(op) === 0) return null;
      }
      return n;
    }
    return null;
  }
  // 搬运操作数时连同一行前导空白 run 一起搬（否则空白落到操作数之后，文本顺序倒置）
  function ommlMoveToSlot(slot, atom) {
    const lead = [];
    let p = atom.previousElementSibling;
    while (p && ommlTag(p) === 'r' && String(p.textContent || '').trim() === '') { lead.unshift(p); p = p.previousElementSibling; }
    for (const n of lead) slot.appendChild(n);
    slot.appendChild(atom);
  }
  // R2 兜底：没有操作数可搬 → 把 nary 降级成「运算符字符 + 上下限」（按 limLoc 选上下 / 右侧布局）
  // 注意 OMML schema：sSub/sSup/sSubSup/limLow/limUpp 的"基数"必须放在 <m:e> 里（不能裸挂 run），
  // 且 sSubSup 的次序是 e,sub,sup、sPre 是 sub,sup,e、limLow/limUpp 是 e,lim。写错会被 Word 判为坏结构。
  function ommlDowngradeNary(doc, el) {
    // 注意：chr / limLoc 在 <m:naryPr> 里面，不是 nary 的直接子元素
    const pr = ommlChild(el, 'naryPr');
    const chrEl = pr ? ommlChild(pr, 'chr') : null;
    const chr = chrEl ? (chrEl.getAttribute('m:val') || chrEl.getAttribute('val') || '') : '';
    const limLocEl = pr ? ommlChild(pr, 'limLoc') : null;
    const overUnder = (limLocEl ? (limLocEl.getAttribute('m:val') || '') : '') === 'undOvr';
    const sub = ommlChild(el, 'sub');
    const sup = ommlChild(el, 'sup');
    // 取不到运算符字符时不降级（宁可保留原结构，也不要造一个空 run 出来）
    if (!chr) return;
    // 没有任何上下限：直接退化成运算符字符本身（不能留裸 <m:e> 挂在 oMath 下）
    if (!sub && !sup) {
      el.parentNode.replaceChild(ommlMakeRun(doc, chr), el);
      return;
    }
    const base = ommlWrap(doc, 'e', [ommlMakeRun(doc, chr)]);
    let node = base;
    if (sub && sup) {
      if (overUnder) {
        const low = ommlWrap(doc, 'limLow', [base, ommlWrap(doc, 'lim', [ommlInner(sub)])]);
        node = ommlWrap(doc, 'limUpp', [ommlWrap(doc, 'e', [low]), ommlWrap(doc, 'lim', [ommlInner(sup)])]);
      } else {
        node = ommlWrap(doc, 'sSubSup', [base, sub.cloneNode(true), sup.cloneNode(true)]);
      }
    } else if (sub) {
      node = overUnder
        ? ommlWrap(doc, 'limLow', [base, ommlWrap(doc, 'lim', [ommlInner(sub)])])
        : ommlWrap(doc, 'sSub', [base, sub.cloneNode(true)]);
    } else {
      node = overUnder
        ? ommlWrap(doc, 'limUpp', [base, ommlWrap(doc, 'lim', [ommlInner(sup)])])
        : ommlWrap(doc, 'sSup', [base, sup.cloneNode(true)]);
    }
    el.parentNode.replaceChild(node, el);
  }
  // R3：空基 + 后继原子 → 前缀上下标 m:sPre（schema 次序 sub, sup, e）
  function ommlToSPre(doc, el, atom) {
    const tag = ommlTag(el);
    const sPre = ommlMake(doc, 'sPre');
    // 属性元素必须换成 <m:sPrePr>（把原 sSubSupPr/sSubPr 直接搬过来不符合 schema）
    const pr = ommlChild(el, tag + 'Pr');
    if (pr && pr.children.length) {
      const newPr = ommlMake(doc, 'sPrePr');
      for (const c of Array.from(pr.children)) newPr.appendChild(c.cloneNode(true));
      sPre.appendChild(newPr);
    }
    const sub = ommlChild(el, 'sub');
    const sup = ommlChild(el, 'sup');
    if (sub) sPre.appendChild(sub.cloneNode(true));
    if (sup) sPre.appendChild(sup.cloneNode(true));
    const base = ommlMake(doc, 'e');
    ommlMoveToSlot(base, atom);
    sPre.appendChild(base);
    return sPre;
  }
  // R3 兜底：空基且后面没有原子 → 上提 sub/sup 的内容（不留孤儿槽）
  function ommlFlattenScript(el) {
    const frag = el.ownerDocument.createDocumentFragment();
    for (const c of Array.from(el.childNodes)) {
      const tag = ommlTag(c);
      if (tag === 'sup' || tag === 'sub') { while (c.firstChild) frag.appendChild(c.firstChild); }
      else if (tag === 'e' || /Pr$/.test(tag)) { /* 空基与属性丢弃 */ }
      else frag.appendChild(c);
    }
    el.parentNode.replaceChild(frag, el);
  }
  // R9 辅助：造一个「不可见占位槽」——槽里塞一个零宽函数应用符 U+2061（Word 不渲染、不改版式）。
  // 用于填补 m:sPre / m:sSubSup 缺失的 sub/sup 以及空基线 m:e、空 num/den，消除 Word 的虚线占位框。
  function ommlHiddenSlot(doc, name) {
    const slot = ommlMake(doc, name);
    const r = ommlMake(doc, 'r');
    const t = ommlMake(doc, 't');
    t.setAttribute('xml:space', 'preserve');
    t.textContent = '\u2061';
    r.appendChild(t);
    slot.appendChild(r);
    return slot;
  }
  // R9 辅助：按 OMML schema 次序重排某元素的「属性块 + 槽位」（属性块置首，槽位按 order 排）。
  // 例：sPre 次序 sub,sup,e；sSubSup 次序 e,sub,sup。仅对已知结构操作，避免误动其它元素。
  function ommlReorderSlots(el, order) {
    const prName = ommlTag(el) + 'Pr';
    const pr = ommlChild(el, prName);
    const slots = order.map((n) => ommlChild(el, n)).filter(Boolean);
    if (pr) el.removeChild(pr);
    for (const s of slots) el.removeChild(s);
    if (pr) el.appendChild(pr);
    for (const s of slots) el.appendChild(s);
  }

  // mml2omml 产出 <m:t> 文本时不做 XML 转义：公式含 <（如 i<j、0<i<n）时 OMML 里是裸 <，
  // 文档整体非良构 → DOMParser 报 parsererror。这里做「最小可解析化」：只对 m:t 文本里
  // 【不可能构成 OMML 标签】的裸 < 与【游离的 &】转义（实体引用保留、幂等），使解析得以进行。
  // 文本语义不变，最终仍由 repairTextEscaping 统一收敛为 &lt;/&amp;。
  const makeOmmlParsable = (xml) => String(xml).replace(
    /(<m:t(?:\s[^>]*[^/>])?>)([\s\S]*?)(<\/m:t>)/g,
    (_, open, text, close) => open
      + text
        // mml2omml 会把 \text{ 中的空格写成 XML 未定义实体 &nbsp;（解析报 Unexpected entity）。
        // 这里先还原成真正的不换行空格 —— 若直接转义成 &amp;nbsp;，DOM 文本就变成字面量
        // "&nbsp;"，后续 repairTextEscaping 也匹配不到它，Word 里会直接显示 "&nbsp;"
        //（2026-09-14 用户复核：p&nbsp;prime / 其中&nbsp;x_i&nbsp;是陈根）。
        .replace(/&nbsp;/gi, '\u00a0').replace(/&#0*160;/gi, '\u00a0').replace(/&#x0*a0;/gi, '\u00a0')
        .replace(/&(?!(?:lt|gt|amp|quot|apos|#\d+|#x[0-9a-fA-F]+);)/g, '&amp;')
        .replace(/<(?!\/?[mw]:)/g, '&lt;')
      + close
  );
  // 解析 OMML（必要时先最小可解析化）。成功返回 { doc, xml }（xml 是实际解析成功的串），失败返回 null。
  const parseOmmlForRepair = (xml) => {
    const tryParse = (s) => {
      let d = null;
      try { d = new DOMParser().parseFromString(s, 'application/xml'); } catch (e) { d = null; }
      return d && !d.getElementsByTagName('parsererror').length ? d : null;
    };
    const src = String(xml);
    const doc = tryParse(src);
    if (doc) return { doc, xml: src };
    const parsable = makeOmmlParsable(src);
    if (parsable === src) return null;
    const retry = tryParse(parsable);
    return retry ? { doc: retry, xml: parsable } : null;
  };

  // R6 的实现：把元素内非 <m:t> 的文本节点包成 <m:r><m:t>（在 <m:r> 里则补 <m:t>）。
  // 纯空白文本节点直接删除（OMML 里不参与渲染，删掉还能避免 docx 库的混排处理）。
  function ommlWrapStrayText(doc, root) {
    let touched = false;
    for (const el of [root].concat(ommlBottomUp(root))) {
      const tag = ommlTag(el);
      if (tag === 't') continue;
      for (const node of Array.from(el.childNodes)) {
        if (node.nodeType !== 3) continue;
        const text = String(node.nodeValue || '');
        if (!text.trim()) { el.removeChild(node); touched = true; continue; }
        let holder;
        if (tag === 'r') {
          holder = ommlMake(doc, 't');
          holder.setAttribute('xml:space', 'preserve');
          holder.textContent = text;
        } else {
          holder = ommlMake(doc, 'r');
          const t = ommlMake(doc, 't');
          t.setAttribute('xml:space', 'preserve');
          t.textContent = text;
          holder.appendChild(t);
        }
        el.replaceChild(holder, node);
        touched = true;
      }
    }
    return touched;
  }

  function repairOmmlEmptyArgs(xml) {
    const parsed = parseOmmlForRepair(xml);
    if (!parsed) return xml;
    const doc = parsed.doc;
    const beforeText = ommlText(doc);
    let changed = false;
    try {
      for (let pass = 0; pass < 20; pass++) {
        let touched = false;
        // R6：先把裸文本包成正规 run（幂等），再做槽位修复
        if (ommlWrapStrayText(doc, doc.documentElement)) touched = true;
        for (const el of ommlBottomUp(doc.documentElement)) {
          const tag = ommlTag(el);
          // R5：整块全空的上下标结构（mhchem 的零宽占位残渣）→ 删除，避免它抢占后继原子
          if (tag === 'sSub' || tag === 'sSup' || tag === 'sSubSup' || tag === 'sPre') {
            const slots = ['e', 'sub', 'sup'].map((n) => ommlChild(el, n));
            if (slots.every((n) => !n || ommlVisuallyEmpty(n))) { el.parentNode.removeChild(el); touched = true; continue; }
          }
          // R7：删除「完全没有文本」的 run（<m:r><m:t/></m:r>）—— mml2omml 对空 <mrow/> 会产出这种
          // 空 run（用户文档里 319 处），Word 在公式里可能把它们画成占位小框。
          // 注意：只删"文本为空字符串"的，不能删"仅含空白"的 —— \quad 的 <m:t> </m:t> 是真实间距，
          // 删掉会触发 I3 文本顺序不变量、整条公式的修复被兜底吞掉（2026-09-14 定位）。
          if (tag === 'r') {
            const hasStruct = Array.from(el.children).some((c) => ommlTag(c) !== 't' && ommlTag(c) !== 'rPr');
            if (String(el.textContent || '') === '' && !hasStruct) { el.parentNode.removeChild(el); touched = true; continue; }
          }
          // R8：矩阵的空单元格填一个不可见字符（U+2061 函数应用）—— Word 对公式矩阵里的空格子
          // 会画虚线占位框（2026-09-14 用户复核：aligned/cases 类公式共 35 个）。不可见字符不改版式。
          if (tag === 'e' && el.parentNode && ommlTag(el.parentNode) === 'mr' && ommlVisuallyEmpty(el)) {
            const fillRun = ommlMake(doc, 'r');
            const fillT = ommlMake(doc, 't');
            fillT.setAttribute('xml:space', 'preserve');
            fillT.textContent = '\u2061';
            fillRun.appendChild(fillT);
            el.appendChild(fillRun);
            touched = true;
          }
          if (tag === 'nary') {
            // R1：空限定槽直接删（schema 允许缺省）
            const sup = ommlChild(el, 'sup');
            const sub = ommlChild(el, 'sub');
            // 注意：ommlVisuallyEmpty(null) 为 true，这里必须判空再删（否则 removeChild(null) 抛错 →
            // 整个修复被兜底吞掉，后续规则全部失效：2026-09-14 定位 12 条公式漏修的原因）
            if (sup && ommlVisuallyEmpty(sup)) { el.removeChild(sup); touched = true; }
            if (sub && ommlVisuallyEmpty(sub)) { el.removeChild(sub); touched = true; }
            // R2：空操作数 → 搬入后继原子，搬不到则降级
            const e = ommlChild(el, 'e');
            if (!e || ommlVisuallyEmpty(e)) {
              const atom = ommlNextAtom(el);
              if (atom) {
                const slot = e || (function () { const n = ommlMake(doc, 'e'); el.appendChild(n); return n; })();
                // 槽里可能只剩空 run（视觉为空）→ 先清掉，避免它在 Word 里被画成占位框
                while (slot.firstChild) slot.removeChild(slot.firstChild);
                ommlMoveToSlot(slot, atom);
              } else {
                ommlDowngradeNary(doc, el);
              }
              touched = true;
            }
          } else if (tag === 'limLow' || tag === 'limUpp') {
            // R4：lim 是必填槽且为空 → 整结构降级为 e 的内容
            if (ommlVisuallyEmpty(ommlChild(el, 'lim'))) {
              const e = ommlChild(el, 'e');
              const frag = doc.createDocumentFragment();
              if (e) for (const c of Array.from(e.childNodes)) frag.appendChild(c);
              el.parentNode.replaceChild(frag, el);
              touched = true;
            }
          } else if (tag === 'sSubSup' || tag === 'sSub' || tag === 'sSup') {
            const e = ommlChild(el, 'e');
            if (ommlVisuallyEmpty(e)) {
              const atom = ommlNextAtom(el);
              if (atom) el.parentNode.replaceChild(ommlToSPre(doc, el, atom), el);
              else ommlFlattenScript(el);
              touched = true;
            }
          }
        }
        if (!touched) break;
        changed = true;
      }
      // R9：最终归一化（仅 docx 路径；HTML/PDF 经 KaTeX 本就无框）。
      // Word 对「存在但缺必需槽」的前缀/上下标结构画虚线占位框，而 KaTeX/预览不画。
      // 这里给缺失的 sub/sup（m:sPre / m:sSubSup）补不可见占位 U+2061，并校正 schema 子元素次序；
      // 同时把残留的空基线 m:e、空 num/den 也填实，确保导出与软件渲染一致。
      {
        let touched9 = false;
        for (let pass = 0; pass < 6; pass++) {
          let t = false;
          for (const el of ommlBottomUp(doc.documentElement)) {
            const tag = ommlTag(el);
            if (tag === 'sPre' || tag === 'sSubSup') {
              // 缺 sub 或 sup 任一项 → Word 在另一侧画框；补齐（不可见）后重排 schema 次序
              let added = false;
              if (!ommlChild(el, 'sub')) { el.appendChild(ommlHiddenSlot(doc, 'sub')); added = true; }
              if (!ommlChild(el, 'sup')) { el.appendChild(ommlHiddenSlot(doc, 'sup')); added = true; }
              if (added) { ommlReorderSlots(el, tag === 'sPre' ? ['sub', 'sup', 'e'] : ['e', 'sub', 'sup']); t = true; }
            } else if (tag === 'e' && el.parentNode && ommlTag(el.parentNode) !== 'mr' && ommlVisuallyEmpty(el)) {
              // 残留空基线（非矩阵单元格，矩阵由 R8 处理）→ 填不可见占位
              const fillRun = ommlMake(doc, 'r');
              const fillT = ommlMake(doc, 't');
              fillT.setAttribute('xml:space', 'preserve');
              fillT.textContent = '\u2061';
              fillRun.appendChild(fillT);
              el.appendChild(fillRun);
              t = true;
            } else if ((tag === 'num' || tag === 'den') && ommlVisuallyEmpty(el)) {
              el.appendChild(ommlHiddenSlot(doc, tag));
              t = true;
            }
          }
          if (!t) break;
          touched9 = true;
        }
        if (touched9) changed = true;
      }
      if (!changed) return xml;
      const out = new XMLSerializer().serializeToString(doc);
      // I1 良构
      const chk = new DOMParser().parseFromString(out, 'application/xml');
      if (chk.getElementsByTagName('parsererror').length) return xml;
      // I2 无孤儿槽
      for (const el of ommlBottomUp(chk.documentElement)) {
        const tag = ommlTag(el);
        if (['sub', 'sup', 'lim', 'e', 'num', 'den'].indexOf(tag) !== -1
            && el.parentNode && el.parentNode.nodeType === 1 && ommlTag(el.parentNode) === 'oMath') return xml;
      }
      // I3 文本顺序完整保留
      const afterText = ommlText(chk.documentElement);
      let i = 0;
      for (const ch of beforeText) {
        const at = afterText.indexOf(ch, i);
        if (at === -1) return xml;
        i = at + 1;
      }
      return out;
    } catch (e) {
      return xml; // 修复失败不放大问题：由下游良构校验与降级逻辑兜底
    }
  }

  const mixin = {
      // 导出时把预览里的图片全部内联为 base64 data URI，使导出文档自包含、不受运行时
      // blob: 回收 / 源解析影响（同源 srcdoc 打印帧在 PDF 导出、外部打开在 HTML 导出都适用）。
      // 分支：blob:→fetch 还原；file://→Rust 读盘；相对路径→按文档目录 Rust 读盘；data:/http(s): 保留。
      // 挑出「真正的 mermaid 容器」供导出时重渲染。
      //
      // 为什么不直接 `querySelectorAll('.mermaid-container')`：**我们的图表容器刻意复用了
      // `.mermaid-container` 类**（为复用灰底框样式 / 灯箱 / 导出链路），于是它们也会被选中，
      // 容器里的 `data-code`（DOT / ECharts option / WaveDrom JSON / Markmap /
      // TikZ / plot 源码）会被当成 Mermaid 语法喂给 mermaid.render()：
      //   - mermaid 抛异常 → 调用处 try/catch 保住原图（侥幸）；
      //   - mermaid 以「错误图」返回（v11 的 run() 就是这种行为；实测过一次导出里出现
      //     20 个 "Syntax error in text / mermaid version …" 炸弹把原图顶掉）→ **直接丢图**。
      // 判据：`data-diagram-type` 缺省（上游历史形态的 mermaid 容器）或等于 'mermaid'；
      // 其余（graphviz / echarts / wavedrom / markmap / tikz / plot）一律跳过。
      _mermaidContainersForRerender(root) {
        if (!root || typeof root.querySelectorAll !== 'function') return [];
        return Array.from(root.querySelectorAll('.mermaid-container')).filter((el) => {
          const t = el.getAttribute ? el.getAttribute('data-diagram-type') : null;
          return !t || t === 'mermaid';
        });
      },

      async _inlineImagesForExport(clone, filePath) {
        // 未保存文档：相对路径/本地图无法解析目录，仅跳过这两类；
        // blob:/data:/http(s) 不依赖 filePath，仍照常内联，避免「未保存就导出」时连粘贴图都丢。
        const warnings = [];
        const dir = filePath ? filePath.replace(/[/\\][^/\\]*$/, '') : '';
        const mimeOfExt = (name) => {
          const ext = String(name).split('.').pop().toLowerCase();
          if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
          if (ext === 'gif') return 'image/gif';
          if (ext === 'svg') return 'image/svg+xml';
          if (ext === 'webp') return 'image/webp';
          if (ext === 'png') return 'image/png';
          if (ext === 'bmp') return 'image/bmp';
          return 'image/png';
        };
        const blobToDataUri = (blob) => new Promise((resolve, reject) => {
          const fr = new FileReader();
          fr.onload = () => resolve(fr.result);
          fr.onerror = () => reject(fr.error || new Error('readAsDataURL failed'));
          fr.readAsDataURL(blob);
        });
        // 单张图片内联上限：超过则不再内联（改为提示），避免一张超大图就把导出期内存顶爆。
        const MAX_SINGLE_INLINE = 15 * 1024 * 1024; // 15MB（base64 字符串长度）
        const inlineOne = async (img) => {
          let src = img.getAttribute('src');
          if (!src) return;
          // 已内联（data:）资源直接保留
          if (src.startsWith('data:')) return;
          try {
            let dataUri = null;
            if (src.startsWith('blob:')) {
              // 预览里 img.src 已被 processImages 经 getCachedImageURL 缓存成 blob: URL，
              // 导出时必须还原为内联 base64。优先 fetch(blob:)（同源可读）；
              // fetch 失败（CSP 拦截 / blob 已被 LRU 回收）时，从 _imageURLCache
              // （dataUri→blobUrl 映射）反查原始 data URI 兜底，保证导出不依赖 fetch。
              try {
                const resp = await fetch(src);
                if (resp.ok) {
                  const blob = await resp.blob();
                  dataUri = await blobToDataUri(blob);
                }
              } catch (_e) { /* fallthrough：走缓存反查兜底 */ }
              if (!dataUri && this._imageURLCache) {
                for (const [dataUriKey, blobUrl] of this._imageURLCache) {
                  if (blobUrl === src) { dataUri = dataUriKey; break; }
                }
              }
              if (!dataUri) warnings.push('图片内联失败（blob 已被回收，图片可能缺失）：' + src.slice(0, 60));
            } else if (src.startsWith('http://') || src.startsWith('https://')) {
              // 网络图片：下载内联为 base64，保证导出的 HTML 离线（换目录/断网）也能显示。
              // 走浏览器 fetch（blob.type 携带真实 mime，避免按扩展名猜错）；
              // 下载失败（离线/超时）时保留原 URL，至少联网打开仍可见；但 DOCX 无法嵌入外链，会缺失。
              try {
                const resp = await fetch(src);
                if (resp.ok) {
                  const blob = await resp.blob();
                  dataUri = await blobToDataUri(blob);
                }
              } catch (_e) { /* 离线或网络异常：保留原 src */ }
              if (!dataUri) warnings.push('远程图片离线无法内联（联网打开仍可见；Word 中可能缺失）：' + src.slice(0, 60));
            } else if (src.startsWith('file://')) {
              // file:// 走 Rust 读磁盘（绕过 CSP，与 processImages 一致）
              if (!filePath) { warnings.push('文档未保存，本地图片无法内联：' + src.slice(0, 60)); return; }
              const url = src.replace(/^file:\/\//, '');
              const base64 = await TauriApi.fetchImageAsBase64({ url });
              dataUri = `data:${mimeOfExt(url)};base64,${base64}`;
            } else {
              // 纯相对路径：按当前 .md 所在目录补全。未保存文档则无法解析，跳过并提示。
              if (!filePath) { warnings.push('文档未保存，相对路径图片无法解析：' + src.slice(0, 60)); return; }
              let rel = src;
              if (rel.startsWith('/')) rel = rel.slice(1);
              const base64 = await TauriApi.fetchImageAsBase64({ url: dir + '/' + rel });
              dataUri = `data:${mimeOfExt(rel)};base64,${base64}`;
            }
            // 单图过大（如数 MB 的 PNG/照片）：内联会让整份导出字符串与内存瞬间翻倍，
            // 多图/大图导出时极易触发假死或崩溃 —— 超限则保留外链并提示，而非硬塞进文档。
            if (dataUri) {
              if (dataUri.length > MAX_SINGLE_INLINE) {
                warnings.push('图片过大（>' + Math.round(MAX_SINGLE_INLINE / 1048576) + 'MB）未内联，导出文件可能外链/缺失：' + src.slice(0, 60));
              } else {
                img.src = dataUri;
              }
            }
          } catch (e) {
            // 还原失败不阻断导出：保留原 src，至少用户能手动补
            console.warn('[export] 图片内联失败，保留原 src:', src, e);
            warnings.push('图片内联异常，保留原链接：' + src.slice(0, 60));
          }
        };
        // 有界并发（默认 6）：「多图导出」时不再一次性发起几百个 fetch / IPC 拉取，
        // 避免主线程被 IPC 往返与内存峰值拖死（界面假死）。
        const imgs = Array.from(clone.querySelectorAll('img'));
        const CONCURRENCY = 6;
        let cursor = 0;
        const worker = async () => {
          while (cursor < imgs.length) {
            const i = cursor++;
            await inlineOne(imgs[i]);
          }
        };
        const pool = [];
        const n = Math.min(CONCURRENCY, imgs.length);
        for (let k = 0; k < n; k++) pool.push(worker());
        await Promise.all(pool);
        this._lastExportImageWarnings = warnings;
      },

      // 把导出过程中「图片未能完全内联」的告警（离线远程图 / 未保存文档的本地图等）
      // 以非阻断方式提示用户；无告警则静默。
      _flushExportImageWarnings() {
        const w = this._lastExportImageWarnings;
        this._lastExportImageWarnings = null;
        if (!w || !w.length) return;
        const msg = '部分图片未能完全内联（' + w.length + ' 张，详见控制台）';
        if (typeof this.showToast === 'function') this.showToast(msg, 'warning', { duration: 4500 });
        else if (typeof this.setStatus === 'function') this.setStatus(msg);
        w.forEach((x) => console.warn('[export] 图片内联警告：', x));
      },

      // ECharts 是 <canvas> 渲染：cloneNode 不复制 canvas 像素（HTML/PDF 克隆后空白），
      // html2canvas 对 echarts canvas 也常捕不到（DOCX 丢失）。导出前用实例 getDataURL 截成
      // PNG，替换容器内 canvas 为 <img>，使三端都能稳定显示且与预览一致（含主题配色）。
      async _snapshotEchartsForExport() {
        const snaps = [];
        const containers = Array.from(this.preview.querySelectorAll('.diagram-container[data-diagram-type="echarts"]'));
        const ec = (typeof window !== 'undefined' && window.echarts)
          ? window.echarts
          : (typeof echarts !== 'undefined' ? echarts : null);
        if (!ec || !ec.getInstanceByDom) return snaps;
        const bg = this.isDark ? '#1e1e1e' : '#ffffff';
        for (const c of containers) {
          try {
            const inst = ec.getInstanceByDom(c);
            if (!inst || inst.isDisposed()) { snaps.push(null); continue; }
            const url = inst.getDataURL({ type: 'png', pixelRatio: 2, backgroundColor: bg });
            snaps.push({ url, w: inst.getWidth() || 0, h: inst.getHeight() || 0 });
          } catch (_e) {
            snaps.push(null);
          }
        }
        return snaps;
      },

      // 把 ECharts 快照（取自真实预览）按索引替换到 clone 的对应容器里。
      _applyEchartsSnapshots(clone, snaps) {
        if (!snaps || !snaps.length) return;
        const cloneContainers = Array.from(clone.querySelectorAll('.diagram-container[data-diagram-type="echarts"]'));
        cloneContainers.forEach((cc, i) => {
          const snap = snaps[i];
          if (!snap || !snap.url) return;
          const img = document.createElement('img');
          img.src = snap.url;
          img.className = 'tizu-echarts-img';
          img.style.cssText = 'display:block;max-width:100%;height:auto;margin:0 auto;';
          // 记录真实像素与显示尺寸，供 DOCX 普通图片路径正确等比缩放（避免被放大/超页）。
          if (snap.w > 0 && snap.h > 0) {
            img.dataset.natW = String(Math.round(snap.w * 2));
            img.dataset.natH = String(Math.round(snap.h * 2));
            img.dataset.dispW = String(Math.round(snap.w));
            img.dataset.dispH = String(Math.round(snap.h));
          }
          const canvas = cc.querySelector('canvas');
          if (canvas) canvas.replaceWith(img); else cc.appendChild(img);
        });
      },
      // PDF 导出需要完整 styles.css。优先运行时 fetch（原始文本保真），失败则回退读取
      // 已加载样式表的 CSSOM（自包含、不依赖网络/打包路径），彻底杜绝
      // 「fetch 失败 → appCSS 空 → 打印样式大面积缺失」的软依赖风险。
      async _loadStylesheetText(url) {
        try {
          const resp = await fetch(url);
          if (resp.ok) {
            const txt = await resp.text();
            if (txt && txt.trim()) return txt;
          }
        } catch (e) { /* fallthrough to CSSOM */ }
        try {
          const links = Array.from(document.querySelectorAll('link[rel="stylesheet"]'));
          for (const link of links) {
            const href = link.getAttribute('href') || '';
            if (href.indexOf(url) === -1) continue;
            const sheet = link.sheet;
            if (!sheet) continue;
            const rules = Array.from(sheet.cssRules).map((r) => r.cssText).join('\n');
            if (rules && rules.trim()) return rules;
          }
        } catch (e) { /* cross-origin 等忽略 */ }
        return '';
      },
      // 把 KaTeX CSS 里的 @font-face 字体内联为 base64 data URI。
      // 为什么必须：KaTeX CSS 中字体是相对路径 url(fonts/KaTeX_*.woff2)；导出成独立 HTML 后
      // 该目录不存在 → 数学字体回退到系统 serif，大运算符（∫/∑/∏）与整体符号尺寸随之变小，
      // 与软件预览（有 KaTeX 字体）出现可见差异。内联后导出文件自包含、与预览一致。
      async _inlineKatexFonts(css) {
        if (!css) return css;
        const cache = (this._katexFontCache || (this._katexFontCache = new Map()));
        const toBase64 = (buf) => {
          const bytes = new Uint8Array(buf);
          let bin = '';
          const CHUNK = 0x8000; // 分块避免 apply 参数过多导致栈溢出
          for (let i = 0; i < bytes.length; i += CHUNK) {
            bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
          }
          return btoa(bin);
        };
        const loadFont = async (file) => {
          if (cache.has(file)) return cache.get(file);
          let uri = '';
          try {
            const resp = await fetch('lib/katex/fonts/' + file);
            if (resp.ok) uri = 'data:font/woff2;base64,' + toBase64(await resp.arrayBuffer());
          } catch (e) { /* 单个字体拉取失败：保留原相对路径，不影响其它字体 */ }
          cache.set(file, uri);
          return uri;
        };
        // 逐个 @font-face 块处理：只保留 woff2（现代浏览器全支持），避免 woff/ttf 重复内联。
        const blocks = css.match(/@font-face\s*\{[^}]*\}/g) || [];
        let out = css;
        for (const block of blocks) {
          const m = /url\(\s*['"]?([^'")]+\.woff2)['"]?\s*\)/.exec(block);
          if (!m) continue;
          const file = m[1].split('/').pop();
          const uri = await loadFont(file);
          if (!uri) continue;
          out = out.replace(block, block.replace(/src:[^;}]*/, `src:url(${uri}) format("woff2")`));
        }
        return out;
      },
      // 文档导出（HTML / Word）共用的基础样式表。
      // 使用标签级选择器（h1/pre/...）而非 .preview-content 后代选择器，
      // 因为导出时 this.preview 的外层容器被丢弃，仅其 children 进入 <body>。
      // 该 CSS 同时被 Word 的 altChunk 导入器识别（html-docx-js 把整段 HTML 原样嵌入 MHT）。
      _documentExportCSS() {
        return `body { max-width: 860px; margin: 0 auto; padding: 40px 20px; line-height: 1.8; color: #2a2a2e; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
        h1, h2, h3, h4, h5, h6 { margin-top: 24px; margin-bottom: 12px; font-weight: 600; line-height: 1.3; }
        h1 { font-size: 2em; border-bottom: 2px solid #d4d4d8; padding-bottom: 10px; }
        h2 { font-size: 1.5em; border-bottom: 1px solid #d4d4d8; padding-bottom: 8px; }
        h3 { font-size: 1.25em; }
        h4 { font-size: 1.1em; }
        h5 { font-size: 1em; color: #5e5e62; }
        h6 { font-size: 0.9em; color: #5e5e62; }
        p { margin-bottom: 14px; }
        a { color: #2563eb; text-decoration: none; }
        a:hover { text-decoration: underline; }
        strong { font-weight: 600; }
        em { font-style: italic; }
        del { text-decoration: line-through; color: #5e5e62; }
        code { padding: 2px 6px; background: #f0efee; border: 1px solid #d4d4d8; border-radius: 4px; font-family: "SF Mono", "Fira Code", monospace; font-size: 0.88em; }
        pre { padding: 16px; background: #f6f5f4; border-radius: 6px; white-space: pre-wrap; word-wrap: break-word; word-break: break-word; overflow: visible; margin: 16px 0; max-width: 100%; border: 1px solid #d4d4d8; }
        pre code { padding: 0; background: transparent; border: none; font-size: 0.9em; line-height: 1.5; white-space: pre-wrap; word-wrap: break-word; word-break: break-word; }
        /* 代码块：hljs 主题里 .hljs{background:#fff}（specificity 0,1,0）会盖住上面 pre code(0,0,2) 的 transparent，
           形成"内白外灰"。用 .hljs 同类选择 + !important 显式压住，让 pre 的灰底透出到 code 上。 */
        pre code.hljs, pre code .hljs { background: transparent !important; padding: 0; }
        /* 代码块行结构（code-block.js 输出的 .code-line/.code-line-num/.code-line-text 在导出里也要换行） */
        .code-scroll { max-height: none; overflow: visible; }
        .code-line { display: flex; line-height: 1.8; min-width: 0; }
        .code-line-num { flex-shrink: 0; width: 3em; text-align: right; padding-right: 0.8em; color: #888; user-select: none; display: none; }
        .preview-content.code-line-numbers .code-line-num { display: inline; }
        .code-line-text { white-space: pre-wrap; word-wrap: break-word; word-break: break-word; flex: 1 1 auto; min-width: 0; }
        blockquote { padding: 12px 20px; margin: 0 0 16px 0; border-left: 4px solid #2563eb; background: #f6f5f4; border-radius: 0 6px 6px 0; color: #5e5e62; }
        blockquote p:last-child { margin-bottom: 0; }
        table { border-collapse: collapse; width: 100%; margin-bottom: 16px; }
        th, td { padding: 8px 12px; border: 1px solid #d4d4d8; text-align: left; }
        th { background: #f0efee; font-weight: 600; }
        img { max-width: 100%; }
        hr { border: none; border-top: 1px solid #d4d4d8; margin: 24px 0; }
        ul, ol { padding-left: 24px; margin-bottom: 14px; }
        li { margin-bottom: 4px; }
        mark { display: inline-block; background: #fbbf24; color: #1a1a1a; padding: 1px 4px; border-radius: 3px; }
        kbd { display: inline-block; padding: 2px 7px; font-size: 0.82em; font-family: "SF Mono", "Fira Code", monospace; background: #f0efee; border: 1px solid #d4d4d8; border-bottom-width: 2px; border-radius: 4px; line-height: 1.5; }
        abbr { text-decoration: underline dotted; cursor: help; }
        .mermaid-container { text-align: center; margin: 16px 0; padding: 16px; max-width: 100%; background: #f0efee; border-radius: 8px; border: 1px solid #d4d4d8; overflow-x: auto; }
        .mermaid-container svg { max-width: 100%; height: auto; }
        .alert { border-radius: 10px; padding: 14px 18px; margin: 16px 0; max-width: 100%; border-left: 4px solid; overflow-wrap: break-word; }
        .alert-title { font-weight: 700; margin-bottom: 6px; font-size: 0.95em; display: flex; align-items: center; gap: 8px; }
        .alert-icon { width: 18px; height: 18px; flex-shrink: 0; }
        .alert-content p:last-child { margin-bottom: 0; }
        .alert-note { background: rgba(56,132,255,0.06); border-left-color: #3884ff; }
        .alert-tip { background: rgba(16,185,129,0.06); border-left-color: #10b981; }
        .alert-important { background: rgba(139,92,246,0.06); border-left-color: #8b5cf6; }
        .alert-warning { background: rgba(245,158,11,0.06); border-left-color: #f59e0b; }
        .alert-caution { background: rgba(239,68,68,0.06); border-left-color: #ef4444; }
        .math-display { display: block; text-align: center; margin: 16px 0; overflow-x: auto; }
        .toc-wrapper { padding: 12px 16px; margin: 16px 0; background: #f6f5f4; border-radius: 8px; border: 1px solid #d4d4d8; }
        .toc-list ul { list-style: none; padding-left: 16px; margin: 2px 0; }
        .toc-list li { margin-bottom: 3px; line-height: 1.6; }
    .toc a { color: #2563eb; text-decoration: underline; font-size: 0.92em; }
    input[type="checkbox"] { -webkit-appearance: none; appearance: none; margin-right: 8px; width: 16px; height: 16px; border: 1.5px solid #d4d4d8; border-radius: 3px; vertical-align: middle; position: relative; top: -1px; cursor: default; }
    input[type="checkbox"]:checked { background: #16a34a url("data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgc3Ryb2tlPSJ3aGl0ZSIgc3Ryb2tlLXdpZHRoPSIzIiBmaWxsPSJub25lIj48cGF0aCBkPSJNNSAxM2w0IDRMMTkgNyIvPjwvc3ZnPg==") center / 14px no-repeat; border-color: #16a34a; }
        input[type="checkbox"] { -webkit-appearance: none; appearance: none; margin-right: 8px; width: 16px; height: 16px; border: 1.5px solid #d4d4d8; border-radius: 3px; vertical-align: middle; position: relative; top: -1px; cursor: default; }
        input[type="checkbox"]:checked { background: #16a34a; border-color: #16a34a; }
        input[type="checkbox"]:checked::after { content: ''; position: absolute; left: 4px; top: 1px; width: 5px; height: 9px; border: solid white; border-width: 0 2px 2px 0; transform: rotate(45deg); }
        details { margin-bottom: 14px; padding: 8px 12px; background: #f6f5f4; border-radius: 6px; border: 1px solid #d4d4d8; }
        summary { font-weight: 600; cursor: pointer; }`;
      },
      // 裁剪 canvas 四周空白/透明/背景色边距，仅保留有内容的区域。
      // backgroundColor 为 null 时只裁剪完全透明像素；传入 {r,g,b} 时按颜色裁剪（容差 15）。
      _trimCanvas(canvas, { backgroundColor = null, padding = 4, tolerance = 15 } = {}) {
        try {
          const ctx = canvas.getContext('2d');
          if (!ctx) return canvas;
          const { width, height } = canvas;
          if (width <= 0 || height <= 0) return canvas;
          const imageData = ctx.getImageData(0, 0, width, height);
          const bounds = MarkdownEditor._computeTrimBounds(imageData.data, width, height, { backgroundColor, padding, tolerance });
          if (!bounds) return canvas;
          const { x, y, w, h } = bounds;
          const out = document.createElement('canvas');
          out.width = w;
          out.height = h;
          const outCtx = out.getContext('2d');
          if (!outCtx) return canvas;
          outCtx.drawImage(canvas, x, y, w, h, 0, 0, w, h);
          return out;
        } catch (e) {
          return canvas;
        }
      },
      // 把 SVG 元素转成 PNG data URL（用于 Mermaid 图表落入 Word）。
      // 失败时返回空字符串，调用方应保留原 SVG 作为降级。
      // 收集 markmap 注入到文档的样式表（markmap-view 把 .markmap 相关规则放进 document 的 <style> /
      // CSSStyleSheet，不内联进 <svg>）。独立序列化 <svg> 成 <img> 时这些样式不生效 → 文字/连线落到
      // 默认黑色（Word 灰底上即"变黑"）。导出前把它们内联进 SVG 的 <style> 子节点修正（2026-09-25 审计）。
      _collectMarkmapCss() {
        let css = '';
        try {
          const styleEls = Array.from(document.querySelectorAll('style'))
            .filter((s) => /markmap/i.test(s.id) || /markmap/.test(s.textContent || ''));
          for (const s of styleEls) css += (s.textContent || '') + '\n';
          for (const sheet of Array.from(document.styleSheets)) {
            let rules;
            try { rules = sheet.cssRules; } catch (_e) { continue; } // 跨域样式表不可读
            if (!rules) continue;
            for (const r of Array.from(rules)) {
              if (r.selectorText && /markmap/i.test(r.selectorText)) css += (r.cssText || '') + '\n';
            }
          }
        } catch (_e) { /* 忽略不可读样式表 */ }
        return css.trim();
      },
      async _svgToPngDataUrl(svg) {
        try {
          if (typeof XMLSerializer === 'undefined' || typeof Blob === 'undefined' || typeof Image === 'undefined') return '';
          // Markmap：把其样式表内联进 SVG 再序列化，避免导出后变黑/错位（样式本在文档级 <style> 未随 svg 序列化）
          let target = svg;
          if (svg && svg.classList && svg.classList.contains('markmap-svg')) {
            const markmapCss = this._collectMarkmapCss();
            if (markmapCss) {
              const doc = svg.ownerDocument || document;
              target = svg.cloneNode(true);
              const styleEl = doc.createElementNS('http://www.w3.org/2000/svg', 'style');
              styleEl.textContent = markmapCss;
              if (target.firstChild) target.insertBefore(styleEl, target.firstChild);
              else target.appendChild(styleEl);
            }
          }
          const serializer = new XMLSerializer();
          let svgStr = serializer.serializeToString(target);
          if (!svgStr) return '';
          // 解析尺寸：优先 viewBox，其次 width/height 属性
          let width = 0, height = 0;
          const vb = svg.getAttribute('viewBox');
          if (vb) {
            const parts = vb.trim().split(/\s+/).map(Number);
            if (parts.length >= 4 && Number.isFinite(parts[2]) && Number.isFinite(parts[3])) {
              width = parts[2];
              height = parts[3];
            }
          }
          if (!width || !height) {
            const w = parseFloat(svg.getAttribute('width'));
            const h = parseFloat(svg.getAttribute('height'));
            if (w && h) { width = w; height = h; }
          }
          if (!width || !height) {
            const rect = svg.getBoundingClientRect ? svg.getBoundingClientRect() : null;
            if (rect && rect.width > 0 && rect.height > 0) {
              width = rect.width;
              height = rect.height;
            }
          }
          if (!width || !height) { width = 600; height = 400; }
          // 声明命名空间，避免 canvas 绘制空白
          if (!/xmlns="http:\/\/www\.w3\.org\/2000\/svg"/.test(svgStr)) {
            svgStr = svgStr.replace('<svg', '<svg xmlns="http://www.w3.org/2000/svg"');
          }
          const blob = new Blob([svgStr], { type: 'image/svg+xml;charset=utf-8' });
          const url = (typeof URL !== 'undefined' && URL.createObjectURL) ? URL.createObjectURL(blob) : '';
          if (!url) return '';
          try {
            const img = new Image();
            await new Promise((resolve, reject) => {
              img.onload = resolve;
              img.onerror = reject;
              img.src = url;
            });
            const canvas = document.createElement('canvas');
            const ctx = canvas.getContext('2d');
            if (!ctx) return '';
            canvas.width = Math.max(1, Math.floor(width));
            canvas.height = Math.max(1, Math.floor(height));
            ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
            return canvas.toDataURL('image/png');
          } finally {
            // 无论成功 / 失败 / 提前 return 都释放。以前只在成功路径 revoke，而
            // `img.onerror` 是导出 Word/PNG 的常见降级路径 → 每次失败泄漏一个 Blob（审计发现）。
            if (typeof URL !== 'undefined' && URL.revokeObjectURL) URL.revokeObjectURL(url);
          }
        } catch (e) {
          return '';
        }
      },
      // 把 Word HTML（altChunk 方案）转成 docx 的 ArrayBuffer（主线程，html-docx-js 同步打包）。
      // 曾走 Web Worker：Worker 在部分 Tauri/WebView 环境下不可用（自定义协议对 Worker 脚本
      // 加载支持不稳），导致整条导出链静默降级、公式全变文字，故全部改为主线程直构建。
      async _convertHtmlToDocxBuffer(html) {
        if (typeof htmlDocx === 'undefined' || !htmlDocx.asBlob) {
          throw new Error('导出组件未加载（html-docx 未加载）');
        }
        const blob = htmlDocx.asBlob(html);
        return await blob.arrayBuffer();
      },
      // 给导出到 Word 的 <img> 同时设置 HTML width/height 属性 + CSS 尺寸。
      // Word 的 HTML 导入器对 CSS width 支持不可靠（会按图片原始像素渲染导致超宽被裁），
      // 但对 HTML width/height 属性支持稳定，因此以属性为主、CSS 为辅双保险。
      //   natW/natH : 图像真实像素尺寸（用于算宽高比）
      //   maxW      : 宽度上限（CSS px），默认 500；原显示宽度 < maxW 的小图保持原尺寸不放大
      //   cssW      : 原始「显示宽度」（CSS px）；未传时以 natW 当作显示宽（普通图片路径）
      _applyWordImgSize(img, natW, natH, maxW, cssW) {
        // 单图高度上限（CSS px）：A4 默认页边距下内容区约 930px，取 850 留出容器/上下文余量，避免高图跨页被截断。
        const WORD_PAGE_MAX_CSS_HEIGHT = 850;
        const wMax = Math.max(1, Math.round(maxW || 500));
        // 显示参考宽度：优先用 cssW（原始显示宽），否则退化为 natW（普通图片的 naturalWidth）
        const refW = (cssW && cssW > 0) ? cssW : (natW > 0 ? natW : wMax);
        // 小图（显示宽 < 上限）保持原显示尺寸，不放大；大图限制到上限宽度
        let targetW = refW < wMax ? Math.max(1, Math.round(refW)) : wMax;
        let targetH = null;
        if (natW > 0 && natH > 0) {
          const ratio = natH / natW;
          targetH = Math.round(targetW * ratio);
          // 高度限制：等比缩放后高度超过一页可用高度，则按高度反推宽度，强制等比例缩小
          if (targetH > WORD_PAGE_MAX_CSS_HEIGHT) {
            targetH = WORD_PAGE_MAX_CSS_HEIGHT;
            targetW = Math.max(1, Math.round(targetH / ratio));
          }
        }
        img.setAttribute('width', targetW);
        img.style.width = targetW + 'px';
        if (targetH != null) {
          img.setAttribute('height', targetH);
          img.style.height = targetH + 'px';
        } else {
          img.style.height = 'auto';
        }
      },
      // 把 canvas 像素宽度限制在 maxPxW 以内（等比缩小），返回新 canvas；无需缩放时原样返回。
      // 用于避免 html2canvas 2× 截图后像素过大导致 docx 膨胀、且 Word 按原始大像素渲染溢出页面。
      _scaleCanvasDown(canvas, maxPxW) {
        try {
          if (!canvas || canvas.width <= 0 || canvas.width <= maxPxW) return canvas;
          const scale = maxPxW / canvas.width;
          const newW = Math.max(1, Math.round(maxPxW));
          const newH = Math.max(1, Math.round(canvas.height * scale));
          const out = document.createElement('canvas');
          out.width = newW;
          out.height = newH;
          const ctx = out.getContext('2d');
          if (!ctx) return canvas;
          ctx.drawImage(canvas, 0, 0, newW, newH);
          return out;
        } catch (e) {
          return canvas;
        }
      },
      // 导出前的预览克隆 —— 四路导出（HTML / Word / PNG / PDF）的唯一入口。
      // 集中在此做「克隆 + 折叠块处理」，避免各路径各写一遍、漏掉同一预处理。
      //
      // expandDetails（默认 true）——是否把折叠块（`???` 等）全部展开：
      //   · true  → PDF / PNG / Word。这些是**固定版式**：PDF 走系统打印、PNG 走
      //             html2canvas，二者遵循真实布局，收起即隐藏，隐藏内容会直接从导出
      //             结果里消失，故必须展开。这也让它们的输出与修 `???` 折叠语义之前
      //             完全一致（当时预览里的 <details> 一律被强制展开）。
      //   · false → HTML。产物是**可交互网页**，内容不会丢，收起只是「等读者点开」，
      //             故保留实时预览所见的状态，使 `???` 的「默认收起」语义在导出的
      //             HTML 里同样成立（而非替读者预先展开）。
      // 导出期间的全屏提示层：用于「正在全量渲染」这类**同步阻塞**阶段 ——
      // 必须在阻塞开始前画出来并让浏览器真正渲染一帧，否则用户只会看到假死
      // （用户 2026-09-23 报障：大文档导出时点 × 无反应、只能任务管理器结束进程）。
      _showExportOverlay(text) {
        try {
          const el = document.createElement('div');
          el.className = 'export-overlay';
          el.innerHTML = '<div class="pdf-loading-spinner"></div><div class="pdf-loading-text"></div>';
          const textEl = el.querySelector('.pdf-loading-text');
          if (textEl) textEl.textContent = text;
          el.style.cssText = 'position:fixed;inset:0;z-index:9999;display:flex;flex-direction:column;' +
            'align-items:center;justify-content:center;background:rgba(0,0,0,0.35);font-family:-apple-system,sans-serif;';
          document.body.appendChild(el);
          return el;
        } catch (_e) {
          return null;
        }
      },
      // 导出前的大文档预处理（A+B）：
      // 大文档的预览只渲染**滑动窗口**（约 1200 行，见 PreviewController.render），
      // 而四个导出路径都基于 preview.cloneNode(true) → 直接导出只会得到窗口那一段
      // （用户 2026-09-23 报：大文档导出的 HTML/PDF/Word 内容残缺）。
      // 这里在导出前临时要求「全量渲染」，返回 { full, restore }；用户取消则返回 null。
      async _preparePreviewForExport() {
        const content = this.cm.getValue();
        const C = (typeof TMConst !== 'undefined' && TMConst) ? TMConst : null;
        const totalLines = content.split('\n').length;
        // 判定走 preview-window.js 的纯函数（与预览同一套阈值，可零依赖单测）
        const PW = (typeof PreviewWindow !== 'undefined') ? PreviewWindow : null;
        const needsFull = (PW && typeof PW.shouldRenderFullForExport === 'function')
          ? PW.shouldRenderFullForExport({
            chars: content.length,
            lines: totalLines,
            maxChars: C ? C.MAX_PREVIEW_CHARS : undefined,
            maxLines: C ? C.MAX_PREVIEW_LINES : undefined,
            hasWindow: !!this.previewWindow,
          })
          : (!!this.previewWindow || totalLines > (C ? C.MAX_PREVIEW_LINES : 5000));
        if (!needsFull) return { full: false, restore: async () => {} };
        // 全量渲染大文档会明显卡顿（这正是窗口模式存在的原因），先问一次。
        // 同一会话内确认过就不再追问，避免每次导出都弹框。
        if (!this._exportFullRenderConfirmed) {
          // ⚠ 第 3 参是「确认后执行的动作」**函数**（见 font.js / files.js 的既有用法），
          // 不是按钮文案！传字符串会被 Dialogs 当函数调用并抛
          // TypeError: opts.action is not a function
          // —— 用户 2026-09-23 报障「大文件导出为 html 报错」即此。
          // 「确定 / 取消」语义由对话框本身提供，故传 null（与 exportPDF 一致）。
          const ask = (typeof this.showConfirmDialog === 'function')
            ? this.showConfirmDialog(
              this.t('exportLargeDocTitle'),
              this.t('exportLargeDocMessage', { lines: totalLines }),
              null)
            : Promise.resolve(true);
          const ok = await ask;
          if (!ok) {
            this.setStatus(this.t('exportLargeDocCancelled'));
            return null;
          }
          this._exportFullRenderConfirmed = true;
        }
        // ① 硬上限：全量渲染是**同步阻塞**的（渲染管线无法分片），文档再大就必须明确拒绝 ——
        //    宁可报错，也绝不让界面进"假死"（历史教训：导出时界面无响应、点 × 无效、
        //    只能任务管理器结束进程）。
        const EXPORT_FULL_RENDER_MAX_LINES = 20000;
        const EXPORT_FULL_RENDER_MAX_CHARS = 8 * 1024 * 1024;
        if (totalLines > EXPORT_FULL_RENDER_MAX_LINES || content.length > EXPORT_FULL_RENDER_MAX_CHARS) {
          this.showToast(this.t('exportTooLargeToRender', { lines: totalLines }), 'danger', { duration: 8000 });
          return null;
        }
        // ② 阻塞前先给出可见反馈，并等它真正画出来（否则用户看到的就是"点了没反应"）
        const overlay = this._showExportOverlay(this.t('exportFullRendering', { lines: totalLines }));
        if (overlay && typeof requestAnimationFrame === 'function') {
          await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        }
        const prevScrollTop = this.preview ? this.preview.scrollTop : 0;
        this._previewForceFull = true;
        try {
          await this.updatePreview(true);
        } catch (e) {
          this._previewForceFull = false;   // 渲染失败必须复位，否则预览会一直尝试全量渲染
          if (overlay) overlay.remove();
          throw e;
        }
        if (overlay) overlay.remove();
        return {
          full: true,
          restore: async () => {
            this._previewForceFull = false;
            try { await this.updatePreview(true); } catch (_e) { /* 恢复窗口渲染失败不掩盖导出结果 */ }
            if (this.preview) this.preview.scrollTop = prevScrollTop;
          },
        };
      },
      // 导出用克隆（⚠ 现在是 async）：大文档会先全量渲染，克隆完成后**立即**恢复窗口渲染 ——
      // 克隆是脱离文档的副本，故恢复预览不影响后续对克隆的处理。
      // 返回 null 表示用户在确认框里取消了导出，调用方应直接结束。
      async _clonePreviewForExport(opts) {
        const prep = await this._preparePreviewForExport();
        if (!prep) {
          // 取消路径也兜底复位：无论 _preparePreviewForExport 内部执行到哪一步，
          // 返回后都必须保证"不处于强制全量"状态（否则预览会一直全量渲染、越用越卡）。
          this._previewForceFull = false;
          return null;
        }
        try {
          const clone = this.preview.cloneNode(true);
          const expandDetails = !opts || opts.expandDetails !== false;
          if (expandDetails) {
            clone.querySelectorAll('details:not([open])').forEach((el) => { el.open = true; });
          }
          return clone;
        } finally {
          if (prep.full) await prep.restore();
        }
      },
      // Word 导出前的 DOM 预处理：把 Web 预览中 Word HTML 导入器会曲解的结构，
      // 转成 Word 能稳定渲染的等价形式，并内联关键样式。
      // 把 Web 预览 DOM 预处理成 Word 兼容结构。
      // 公式（.katex）本函数一律原样保留：DOCX 真 OOXML 主路径需要它内部的 <math>
      // 来生成 Word 可编辑公式（OMML）；公式不再转图片。
      async _prepareWordDOM(clone, opts) {
        // opts.control：{ onProgress(done, total), isCancelled() } —— 让调用方把进度显示出来、
        // 并能在阶段之间取消。否则「逐图转 PNG」这步在图表多时只能干等（用户报障：
        // Word 到处慢且无法导出、界面像死了一样）。
        const ctl = (opts && opts.control) || null;
        // 把 clone 临时挂到离屏 DOM，确保 html2canvas 能拿到真实布局与样式。
        const holder = document.createElement('div');
        holder.style.position = 'fixed';
        holder.style.left = '-9999px';
        holder.style.top = '0';
        holder.style.zIndex = '-1';
        holder.appendChild(clone);
        document.body.appendChild(holder);
  
        try {
        // 1. 删除线 / 插入线：Word 会把 <del>/<ins> 当成修订追踪，换成等效 <span>
        clone.querySelectorAll('del').forEach((el) => {
          const span = document.createElement('span');
          span.style.textDecoration = 'line-through';
          span.style.color = '#5e5e62';
          span.innerHTML = el.innerHTML;
          el.replaceWith(span);
        });
        clone.querySelectorAll('ins').forEach((el) => {
          const span = document.createElement('span');
          span.style.textDecoration = 'underline';
          span.innerHTML = el.innerHTML;
          el.replaceWith(span);
        });
  
        // 2. 任务列表：Word 不会渲染 <input type="checkbox">，换成 Unicode 字符
        clone.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
          const span = document.createElement('span');
          span.textContent = cb.checked ? '☑ ' : '☐ ';
          const li = cb.closest ? cb.closest('li') : null;
          if (li) {
            const ul = li.parentElement;
            if (ul && ul.tagName === 'UL') {
              ul.style.listStyleType = 'none';
              ul.style.paddingLeft = '0';
            }
          }
          cb.replaceWith(span);
        });
  
        // 3. 列表项包裹的 <p> 会导致 Word 把 bullet 与文字分两段；含嵌套列表时也要 unwrap。
        //    循环处理直到没有 <li> 直接子 <p> 为止。
        let pInLi;
        while ((pInLi = clone.querySelector('li > p'))) {
          const li = pInLi.parentElement;
          // 把 <p> 的内容移到 <p> 之前，保留后续兄弟（如嵌套 <ul>/<ol>）
          while (pInLi.firstChild) li.insertBefore(pInLi.firstChild, pInLi);
          pInLi.remove();
        }
        // 清除列表项里的空文本节点，避免 Word 把它们渲染成空 bullet
        clone.querySelectorAll('li').forEach((li) => {
          for (let i = li.childNodes.length - 1; i >= 0; i--) {
            const node = li.childNodes[i];
            if (node.nodeType === Node.TEXT_NODE && !node.textContent.trim()) {
              node.remove();
            }
          }
        });
  
        // 4. 代码块：.code-line flex 结构 + 语法高亮 span 在 Word 里常变成带框小格。
        //     Word 对 <pre> 预格式化识别最好；内部用 <br> 强制换行，white-space:pre 禁止自动硬折行。
        const escapeHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        clone.querySelectorAll('pre').forEach((pre) => {
          const code = pre.querySelector('code');
          let plain = '';
          if (code) {
            const scroll = code.querySelector('.code-scroll');
            if (scroll) {
              const lines = [];
              scroll.querySelectorAll('.code-line').forEach((line) => {
                const text = line.querySelector('.code-line-text');
                lines.push(text ? text.textContent : line.textContent);
              });
              plain = lines.join('\n');
            } else {
              plain = code.textContent;
            }
          } else {
            plain = pre.textContent;
          }
          plain = plain.replace(/\n+\s*$/, '');
          if (!plain) plain = '';
  
          const wrapper = document.createElement('div');
          wrapper.className = 'tizu-code-block';
          wrapper.style.background = '#f6f5f4';
          wrapper.style.border = '1px solid #d4d4d8';
          wrapper.style.borderRadius = '6px';
          wrapper.style.padding = '16px';
          wrapper.style.margin = '16px 0';
          wrapper.style.maxWidth = '100%';
          wrapper.style.overflowX = 'auto';
          wrapper.style.fontFamily = '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
  
          const newPre = document.createElement('pre');
          newPre.style.cssText = 'margin:0;padding:0;background:transparent;border:none;font-family:"SF Mono","Fira Code",monospace;font-size:0.9em;line-height:1.5;white-space:pre;word-wrap:normal;word-break:keep-all;';
          newPre.innerHTML = plain.split('\n').map((line) => escapeHtml(line || ' ')).join('<br>');
  
          wrapper.appendChild(newPre);
          pre.replaceWith(wrapper);
        });
  
        // 5. 引用块：内联样式 + 段落内换行换成 <br>
        clone.querySelectorAll('blockquote').forEach((bq) => {
          bq.style.background = '#f6f5f4';
          bq.style.borderLeft = '4px solid #2563eb';
          bq.style.padding = '12px 20px';
          bq.style.margin = '0 0 16px 0';
          bq.style.borderRadius = '0 6px 6px 0';
          bq.style.color = '#5e5e62';
          bq.querySelectorAll('p').forEach((p) => {
            p.style.marginBottom = '0';
            if (p.innerHTML.includes('\n')) p.innerHTML = p.innerHTML.replace(/\n/g, '<br>');
          });
        });
  
        // 6. 提示框（Alerts）：Word 对 <style> 里的 rgba/类选择器支持不稳定，内联实色
        const alertMap = {
          'alert-note': { bg: '#eef4ff', border: '#3884ff' },
          'alert-tip': { bg: '#e9f9f1', border: '#10b981' },
          'alert-important': { bg: '#f3edfd', border: '#8b5cf6' },
          'alert-warning': { bg: '#fef6e7', border: '#f59e0b' },
          'alert-caution': { bg: '#fdecec', border: '#ef4444' }
        };
        clone.querySelectorAll('.alert').forEach((alert) => {
          let style = alertMap['alert-note'];
          for (const cls of alert.classList) {
            if (alertMap[cls]) { style = alertMap[cls]; break; }
          }
          alert.style.borderRadius = '10px';
          alert.style.padding = '14px 18px';
          alert.style.margin = '16px 0';
          alert.style.maxWidth = '100%';
          alert.style.borderLeft = `4px solid ${style.border}`;
          alert.style.background = style.bg;
          alert.style.overflowWrap = 'break-word';
          const title = alert.querySelector('.alert-title');
          if (title) {
            title.style.fontWeight = '700';
            title.style.marginBottom = '6px';
            title.style.fontSize = '0.95em';
            title.style.display = 'block';
          }
          alert.querySelectorAll('p').forEach((p) => { p.style.marginBottom = '0'; });
        });
  
        // 7. 高亮：内联背景色
        clone.querySelectorAll('mark').forEach((m) => {
          m.style.display = 'inline-block';
          m.style.background = '#fbbf24';
          m.style.color = '#1a1a1a';
          m.style.padding = '1px 4px';
          m.style.borderRadius = '3px';
        });
  
        // 8. 数学公式：不做任何转换，保留 .katex 原样。
        //    DOCX 真 OOXML 主路径由 domToDocxStructure 提取 <math> → OMML，得到 Word 可编辑公式；
        //    公式不再转图片（图片公式不可二次编辑，产品上不提供）。
        //    仅在 html-docx 回退路径（_fallbackWordHtmlExport）里降级为 LaTeX 源码文本。
  
        // 9. Mermaid 图表：SVG 在 Word HTML 导入里常丢失，转成 PNG 内联图。
        //    截图前临时去掉容器 padding/border/background，让容器紧包 SVG；
        //    截图后裁剪透明边，并以实际内容尺寸显示（不超宽时不满页拉伸）。
        //    截图前先 mermaid.render() 重渲染：预览时 mermaid 偶发未渲染（切换标签页
        //    触发重排后才渲染），直接 html2canvas 会截到空容器导致图表缺失/报错。
        if (typeof mermaid !== 'undefined') {
          const ff = getComputedStyle(document.documentElement).getPropertyValue('--font-preview').trim() || '-apple-system, sans-serif';
          // mermaid.initialize 失败不致命：下方 mermaid.render 有独立 try/catch，且初始化异常不应阻断导出
          // securityLevel 必须是 strict（与预览管线一致）：导出会把 result.svg 用 innerHTML 注入
          // **真实 DOM**，loose 下文档里的 <img onerror> / click 指令会被保留并在 WebView 内执行，
          // 且同一段 SVG 还会写进导出的 HTML/PDF/DOCX（审计发现，2026-09-24）。
          try { mermaid.initialize({ startOnLoad: false, theme: this.isDark ? 'dark' : 'default', securityLevel: 'strict', fontFamily: ff, themeVariables: { fontSize: '14px' } }); } catch (e) { console.error('[export] mermaid.initialize 失败（不影响导出）:', e); }
        }
        // 注意：本循环**必须遍历所有 `.mermaid-container`** —— 它除了「重渲染 Mermaid」，还负责
        // 把容器截图成 PNG（Word 的 HTML 导入器不支持内联 SVG）。我们的图表容器（Graphviz /
        // ECharts / WaveDrom / Markmap / TikZ / plot）复用了该类名，同样需要被截图，
        // 但**不能**被送进 mermaid.render —— 它们的源码不是 Mermaid 语法，会被当成语法错误、
        // 并可能被错误图整块覆盖。故只对「真正的 mermaid 容器」开重渲染闸门（见
        // _mermaidContainersForRerender），其余容器照常走下面的截图逻辑。
        const mermaidContainers = Array.from(clone.querySelectorAll('.mermaid-container'));
        const rerenderable = new Set(this._mermaidContainersForRerender(clone));
        // 有界并发（默认 4）：含大量图表（尤其 SVG→PNG 快路之外的 ECharts canvas 走 html2canvas）时，
        // 不再严格串行逐图 await，也避免一次性全并发把 CPU/内存打满；每个图表仍独立做取消检查与进度回调。
        const CONCURRENCY = 4;
        let cancelled = false;
        const processChart = async (container, mi) => {
          if (cancelled) return;
          // 阶段之间（每个图表一次）检查取消：html2canvas / SVG 转 PNG 之间都是 await 点，
          // 能真正响应，不必再"任务管理器结束进程"。
          if (ctl && typeof ctl.isCancelled === 'function' && ctl.isCancelled()) { cancelled = true; return; }
          // 重渲染确保 SVG 就绪（仅真 mermaid 容器）
          if (rerenderable.has(container) && typeof mermaid !== 'undefined' && container.getAttribute('data-code')) {
            try {
              const code = (container.getAttribute('data-code') || '').trim();
              if (code) {
                const result = await mermaid.render('docx-mermaid-' + Date.now() + '-' + mi, code);
                container.innerHTML = result.svg;
                const svgEl = container.querySelector('svg');
                if (svgEl) {
                  svgEl.removeAttribute('style');
                  const vb = svgEl.getAttribute('viewBox');
                  if (vb) { const parts = vb.split(/\s+/); if (parts.length >= 4) { svgEl.setAttribute('width', parts[2]); svgEl.setAttribute('height', parts[3]); } }
                }
              }
            } catch (e) { /* 渲染失败保留原 SVG，截图兜底 */ }
          }
          let dataUrl = '';
          let natW = 0, natH = 0, cssW = 0;
          // ① **优先**走 SVG→PNG 直转：Mermaid / TikZ / plot / Graphviz / WaveDrom / Markmap 的
          //    产物本身就是 SVG，序列化后用 canvas 画一次即可（毫秒级）。
          //    历史 bug：这段"快路"原本排在 html2canvas **之后**（只有截图失败才轮到它），
          //    而 html2canvas 是整页样式重放，每张图 0.3–3 秒 → 75 张图要跑几分钟、
          //    界面全程无响应（用户报「Word 到处慢且无法导出」「行数少的能导出、多了没反应」）。
          //    现在调换顺序：有 SVG 就走快路，没有（ECharts canvas 等）才用 html2canvas 兜底。
          const svgFast = container.querySelector('svg');
          if (svgFast) {
            try {
              dataUrl = await this._svgToPngDataUrl(svgFast);
              let sw = 0, sh = 0;
              const vb0 = svgFast.getAttribute('viewBox');
              if (vb0) { const p0 = vb0.trim().split(/\s+/).map(Number); if (p0.length >= 4) { sw = p0[2]; sh = p0[3]; } }
              if (!sw || !sh) { sw = parseFloat(svgFast.getAttribute('width')) || 0; sh = parseFloat(svgFast.getAttribute('height')) || 0; }
              if (!sw || !sh) { const r0 = svgFast.getBoundingClientRect ? svgFast.getBoundingClientRect() : null; if (r0) { sw = r0.width; sh = r0.height; } }
              natW = sw; natH = sh; cssW = sw; // sw 已是 CSS 显示宽
            } catch (e) { dataUrl = ''; }
          }
          // 备份原样式，截图后恢复（最终 Word HTML 里仍保留灰底框装饰）。
          const savedStyle = {
            padding: container.style.padding,
            border: container.style.border,
            background: container.style.background,
            backgroundColor: container.style.backgroundColor,
            borderRadius: container.style.borderRadius,
            margin: container.style.margin,
            overflow: container.style.overflow,
            textAlign: container.style.textAlign,
          };
          try {
            container.style.padding = '0';
            container.style.border = 'none';
            container.style.background = 'transparent';
            container.style.backgroundColor = 'transparent';
            container.style.borderRadius = '0';
            container.style.margin = '0';
            container.style.overflow = 'visible';
            container.style.textAlign = 'left';
            // ② 兜底：没有 SVG（ECharts canvas 等）或快路失败时才用 html2canvas（慢）
            if (!dataUrl && typeof html2canvas !== 'undefined') {
              const canvas = await html2canvas(container, {
                scale: 2,
                backgroundColor: null,
                useCORS: true
              });
              const trimmed = this._trimCanvas(canvas, { backgroundColor: null, padding: 4 });
              // 把图片像素本身限制在 1000px 宽以内（2× 显示宽度），避免 docx 膨胀且 Word 按原始大像素渲染时溢出页面。
              const scaled = this._scaleCanvasDown(trimmed, 1000);
              dataUrl = scaled.toDataURL('image/png');
              natW = scaled.width;
              natH = scaled.height;
              cssW = scaled.width / 2; // 2× 截图，显示参考宽度取一半
            }
          } catch (e) { dataUrl = ''; }
          // 恢复容器装饰样式
          Object.assign(container.style, savedStyle);
          if (!dataUrl) {
            const svg = container.querySelector('svg');
            if (svg) {
              try {
                dataUrl = await this._svgToPngDataUrl(svg);
                // 从 svg 取自然尺寸用于等比高度
                let sw = 0, sh = 0;
                const vb = svg.getAttribute('viewBox');
                if (vb) { const p = vb.trim().split(/\s+/).map(Number); if (p.length >= 4) { sw = p[2]; sh = p[3]; } }
                if (!sw || !sh) { sw = parseFloat(svg.getAttribute('width')) || 0; sh = parseFloat(svg.getAttribute('height')) || 0; }
                if (!sw || !sh) { const r = svg.getBoundingClientRect ? svg.getBoundingClientRect() : null; if (r) { sw = r.width; sh = r.height; } }
                natW = sw; natH = sh; cssW = sw; // sw 已是 CSS 显示宽
              } catch (e) { dataUrl = ''; }
            }
          }
          if (!dataUrl) return;
          const img = document.createElement('img');
          img.src = dataUrl;
          img.className = 'tizu-mermaid-img';
          // 同时设置 HTML width/height 属性：小于 500 的小图保持原显示尺寸，大图限制 500，
          // 过高则按页面高度上限等比缩小，确保 Word 中完整显示、不跨页裁切。
          this._applyWordImgSize(img, natW, natH, 500, cssW);
          img.style.display = 'inline-block';
          container.innerHTML = '';
          container.style.textAlign = 'center';
          container.style.padding = '16px';
          container.style.background = '#f0efee';
          container.style.border = '1px solid #d4d4d8';
          container.style.borderRadius = '8px';
          container.style.maxWidth = '100%';
          container.style.boxSizing = 'border-box';
          container.appendChild(img);
          // 让出主线程，使 loading spinner 与鼠标事件有机会处理。
          await new Promise((r) => setTimeout(r, 0));
          // 进度回调（含"已用秒数"由调用方计算）——让用户看到它在干活
          if (ctl && typeof ctl.onProgress === 'function') ctl.onProgress(mi + 1, mermaidContainers.length);
        };
        let cursor = 0;
        const chartWorker = async () => {
          while (cursor < mermaidContainers.length && !cancelled) {
            const mi = cursor++;
            await processChart(mermaidContainers[mi], mi);
          }
        };
        const chartPool = [];
        const cpn = Math.min(CONCURRENCY, mermaidContainers.length);
        for (let k = 0; k < cpn; k++) chartPool.push(chartWorker());
        await Promise.all(chartPool);
        if (cancelled) return 'cancelled';
  
        // 10. 普通图片：读取自然尺寸，按宽高比等比缩放到 500px，并设置 HTML width/height 属性，
        //     确保 Word 按此尺寸完整显示、不裁切（CSS width 在 Word 导入器里不可靠）。
        //     Mermaid（.tizu-mermaid-img）已单独处理为 500px，这里跳过以免被覆盖。
        //     （公式不再转图片，故无 .tizu-math-img 分支。）
        const plainImages = Array.from(clone.querySelectorAll('img')).filter((img) => {
          return !img.classList.contains('tizu-mermaid-img');
        });
        await Promise.all(plainImages.map(async (img) => {
          // 优先用导出前从真实预览采集的渲染尺寸（dataset），不再依赖 new Image() 异步重加载——
          // 该方式在 SVG（naturalWidth 为 0）、图片未成功内联、或加载超时时会读取失败，
          // 导致 natW=0、所有图片退化为 width=500（小图被放大、超高图高度上限失效）。
          let natW = parseInt(img.dataset.natW || '0', 10) || 0;
          let natH = parseInt(img.dataset.natH || '0', 10) || 0;
          const dispW = parseInt(img.dataset.dispW || '0', 10) || 0;
          const dispH = parseInt(img.dataset.dispH || '0', 10) || 0;
          // naturalWidth/naturalHeight 不可靠（如 SVG）时，用显示尺寸兜底，保证宽高比与高度上限可用。
          if (natW <= 0 && dispW > 0) natW = dispW;
          if (natH <= 0 && dispH > 0) natH = dispH;
          // 先清除原始 width/height 属性（如 width="1200"），再由 _applyWordImgSize 写入正确的等比尺寸。
          img.removeAttribute('width');
          img.removeAttribute('height');
          this._applyWordImgSize(img, natW, natH, 500, dispW > 0 ? dispW : natW);
          img.style.display = 'inline-block';
          img.style.maxWidth = '100%';
        }));
  
        } finally {
          holder.remove();
        }
      },
      // 公式兜底：把 clone 里残留的 .katex 换成「LaTeX 源码文本」。
      // 只在 html-docx 回退路径（真 OOXML 主路径整体失败）才会走到，正常导出不会用到。
      //
      // 为什么是文本而不是图片：公式一律以 Word 原生可编辑公式（OMML）为目标，图片公式
      // 不能二次编辑、缩放后发虚，产品上不提供。主路径失败时与其塞一张图，不如保留可读、
      // 可复制回编辑器重新编辑的 LaTeX 源码（.katex-mathml 里的 <annotation encoding="application/x-tex">）。
      _katexElsToLatexText(clone) {
        const katexEls = Array.from(clone.querySelectorAll('.katex'));
        for (const katex of katexEls) {
          let tex = '';
          const annotation = katex.querySelector('.katex-mathml annotation[encoding="application/x-tex"]')
            || katex.querySelector('annotation[encoding="application/x-tex"]');
          if (annotation) tex = (annotation.textContent || '').trim();
          if (!tex) {
            const mathml = katex.querySelector('.katex-mathml');
            if (mathml) tex = (mathml.textContent || '').replace(/\s+/g, ' ').trim();
          }
          if (!tex) tex = (katex.textContent || '').replace(/\s+/g, ' ').trim();
          const span = document.createElement('code');
          span.className = 'tizu-math-source';
          span.textContent = tex;
          katex.replaceWith(span);
        }
      },
      async exportHTML() {
        try {
          const path = await dialogSave({
            defaultPath: this.activeTab.filePath
              ? this.activeTab.filePath.replace(/\.md$/, '.html')
              : 'export.html',
            filters: [{ name: 'HTML', extensions: ['html'] }]
          });
          if (!path) return;
  
          const clone = await this._clonePreviewForExport({ expandDetails: false });
          if (!clone) return;   // 大文档：用户在「全量渲染」确认框里取消了导出
          clone.style.position = '';
          clone.style.left = '';
          clone.style.top = '';
          clone.style.width = '';
          clone.style.padding = '';
          clone.style.overflow = '';
          clone.style.height = '';
  
          clone.querySelectorAll('.copy-btn').forEach(el => el.remove());
          const abbrData = clone.querySelector('#abbr-data');
          if (abbrData) abbrData.remove();

          // ECharts 是 canvas，克隆会丢像素：先截成 <img> 再内联，三端稳定显示。
          const echSnapsHtml = await this._snapshotEchartsForExport();
          this._applyEchartsSnapshots(clone, echSnapsHtml);
          await this._inlineImagesForExport(clone, this.activeTab.filePath);
          this._flushExportImageWarnings();
  
          let katexCSS = '';
          try {
            const resp = await fetch('lib/katex/katex.min.css');
            if (resp.ok) katexCSS = await this._inlineKatexFonts(await resp.text());
          } catch (e) { /* skip */ }
  
          let hljsCSS = '';
          try {
            const themeLink = document.getElementById('highlight-theme');
            if (themeLink) {
              const resp = await fetch(themeLink.getAttribute('href'));
              if (resp.ok) hljsCSS = await resp.text();
            }
          } catch (e) { /* skip */ }
  
          const escapedTitle = this.activeTab.name.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

          // 复用与 PDF 一致的真实 styles.css（而非手写精简 CSS），使导出 HTML 与软件预览外观一致：
          // 主题色/代码块底色/强调色/字体均来自 CSS 变量，由 <html> 上的 data-color-scheme /
          // data-theme 属性驱动。复制当前属性即可 1:1 还原当前主题（含深色模式）。
          const appCSS = await this._loadStylesheetText('styles.css');
          const customFontStyleEl = document.getElementById('custom-fonts-style');
          const customFontCSS = customFontStyleEl ? (customFontStyleEl.textContent || '') : '';
          const colorScheme = document.documentElement.getAttribute('data-color-scheme') || 'default';
          const themeMode = document.documentElement.getAttribute('data-theme')
            || (this.isDark ? 'dark' : 'light');
          // === 100% 还原软件预览 ===
          // styles.css 已内联、主题属性已复制，但以下「运行时」才生效、不在静态 CSS 里的
          // 样式必须显式带过去，否则和界面有偏差：
          //   - documentElement 内联 style：--preview-weight / --preview-bold-weight /
          //     --custom-bg / --custom-fg 等（applySettings / applyCustomBg 写入）；
          //   - #preview 实算字体：正文 font-family（previewFont 写到元素 style 上）、
          //     代码块 --font-code-preview（codeFont 写到元素 style 上）；
          //   - 设置项：预览字号 / 行高 / 最大宽度 / 行号类。
          const rootInline = (document.documentElement.getAttribute('style') || '').trim();
          const previewFontFamily = getComputedStyle(this.preview).fontFamily || '';
          const codeFontVar = (getComputedStyle(this.preview).getPropertyValue('--font-code-preview') || '').trim();
          const s = this.settings;
          const customBg = !!s.customBgEnabled;
          const rootVarsCSS = [
            `color-scheme: ${themeMode};`,
            `--font-preview: ${previewFontFamily};`,
            rootInline,
            codeFontVar ? `--font-code-preview: ${codeFontVar};` : '',
          ].filter(Boolean).join(' ');

          // 复用预览容器本身（clone 保留其 class 与内联 style），不再手写 padding / 字号 /
          // 行高 / 最大宽度 / 字体，避免与 styles.css 及预览实际样式产生偏差：
          //   - 内联样式已带 font-size / line-height / max-width / margin / font-family；
          //   - class 已带 code-wrap / code-no-scroll / code-line-numbers / max-width-active，
          //     代码换行与行号设置因此与预览逐一致；
          //   - 自定义底色由 styles.css 的 body.custom-bg-active #preview 规则自动驱动。
          // 这里只解除「静态文档」不需要的滚动 / 高度约束，让整篇内容自然铺开。
          if (!clone.style.maxWidth) {
            // 未设置「最大宽度」时，给导出文档一个 860px 的阅读列默认值（静态文档更易读）
            clone.style.maxWidth = '860px';
            clone.style.margin = '0 auto';
          }

          const shellCSS = `
    :root { ${rootVarsCSS} }
    /* 关键：styles.css 里 html{overflow:hidden;height:100%} / body{height:100vh;overflow:hidden}
       是应用外壳写法（页面不滚动、由内部面板滚动）。导出为独立文档必须解除，
       否则页面无滚动条、超出视口的内容看不到。同时恢复文本可选（外壳默认 user-select:none）。 */
    html, body { margin: 0; padding: 0; height: auto !important; overflow: visible !important; -webkit-user-select: text; user-select: text; background: ${customBg ? 'var(--custom-bg)' : 'var(--preview-bg, #f8f7f4)'} !important; }
    #preview { height: auto !important; min-height: 0 !important; overflow: visible !important; }
    .code-scroll { max-height: none !important; overflow: visible !important; }
    input[type="checkbox"] { -webkit-appearance: none; appearance: none; margin-right: 8px; width: 16px; height: 16px; border: 1.5px solid var(--border-color, #d4d4d8); border-radius: 3px; vertical-align: middle; position: relative; top: -1px; cursor: default; }
    input[type="checkbox"]:checked { background: #16a34a url("data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgc3Ryb2tlPSJ3aGl0ZSIgc3Ryb2tlLXdpZHRoPSIzIiBmaWxsPSJub25lIj48cGF0aCBkPSJNNSAxM2w0IDRMMTkgNyIvPjwvc3ZnPg==") center / 14px no-repeat; border-color: #16a34a; }
    input[type="checkbox"]:checked::after { display: none !important; }
    .mermaid-container { margin: 8px 0; max-width: 100%; overflow: hidden; }
    .mermaid-container svg { width: auto; max-width: 100%; height: auto; display: block; margin: 0 auto; }
    `;

          const bodyClass = customBg ? ' class="custom-bg-active"' : '';

          // CSS 分层（特异性由低到高）：_documentExportCSS 是「标签级兜底」——styles.css
          // 拉取失败时导出仍可读，且 jsdom 测试环境无 fetch、只能靠它做结构断言；
          // styles.css 用 .preview-content 作用域选择器（特异性更高）真正决定视觉，与预览一致。
          const fullHTML = `<!DOCTYPE html>
    <html lang="zh-CN" data-color-scheme="${colorScheme}" data-theme="${themeMode}">
    <head>
      <meta charset="UTF-8">
      <title>${escapedTitle}</title>
      <style>${this._documentExportCSS()}${customFontCSS}${appCSS}${hljsCSS}${katexCSS}${shellCSS}</style>
    </head>
    <body${bodyClass}>
    ${clone.outerHTML}
    </body>
    </html>`;
  
          // 让出主线程：整篇 HTML 字符串拼接与写文件是同步大操作，yield 让界面（含其他面板）不至于"假死"（2026-09-25 优化）。
          await new Promise(r => setTimeout(r, 0));
          await TauriApi.writeFile({ path, content: fullHTML });
          this.setStatus(`${this.t('exportedHTML')}: ${path}`);
        } catch (error) {
          this.setStatus(`${this.t('exportFailed')}: ${error}`);
        }
      },
      // docx 页面尺寸（twips，1/20 pt）：A4 / Letter，支持纵向/横向。
      _docxPageSize(kind, orientation = 'portrait') {
        const sizes = {
          A4: { width: 11906, height: 16838 },
          Letter: { width: 12240, height: 15840 },
        };
        const s = sizes[kind] || sizes.A4;
        return orientation === 'landscape'
          ? { width: s.height, height: s.width }
          : { width: s.width, height: s.height };
      },
      // docx 边距（twips）：标准 / 窄 / 宽。
      _docxMargins(preset) {
        const map = {
          normal: { top: 1440, bottom: 1440, left: 1800, right: 1800 },
          narrow: { top: 720, bottom: 720, left: 720, right: 720 },
          wide: { top: 2880, bottom: 2880, left: 2880, right: 2880 },
        };
        return map[preset] || map.normal;
      },
      // 把 DOM→structure 中的 mathml run 转成 OMML（Word 可编辑公式）。
      // KaTeX 渲染的 <math>（export-docx.js 收集为 { mathml } run）经 MathML2OMML.mml2omml
      // 转成 OMML 字符串，主线程构建时用 ImportedXmlComponent 注入 <m:oMath>。
      //
      // 容错策略（关键）：mml2omml 对部分复杂公式（矩阵/aligned/cases 等）产出的 OMML
      // 可能不是良构 XML，docx 的 XML 解析器会抛 "Unexpected close tag"，**单个坏公式会
      // 拖垮整篇文档构建 → 全部回退 altChunk → 所有公式变文字**。因此这里逐公式处理：
      //   - 缺库 → 返回 false（走 html-docx 回退，公式降级 LaTeX 文本）
      //   - 转换且 OMML 良构 → { omml }（Word 可编辑公式）
      //   - 转换失败 / OMML 非良构 → { text: LaTeX源码 }（不丢内容，也不拖垮整篇）
      // 返回 true 表示可走主路径（个别公式降级文本不影响整体）。
      async _structureMathmlToOmml(structure) {
        const convert = (typeof MathML2OMML !== 'undefined' && MathML2OMML.mml2omml)
          ? MathML2OMML.mml2omml
          : null;
        // OMML 良构预检：非法 XML 会让 docx 的 fromXmlString 抛错拖垮整篇。
        const isWellFormed = (xml) => {
          try {
            const doc = new DOMParser().parseFromString(xml, 'application/xml');
            return doc && doc.getElementsByTagName('parsererror').length === 0;
          } catch (e) { return false; }
        };
        // 从 MathML 里取 LaTeX 源码（<annotation encoding="application/x-tex">…</annotation>）
        const extractLatex = (mathml) => {
          const m = /<annotation[^>]*encoding=["']application\/x-tex["'][^>]*>([\s\S]*?)<\/annotation>/.exec(mathml);
          if (m) return m[1].trim();
          const m2 = /<annotation[^>]*>([\s\S]*?)<\/annotation>/.exec(mathml);
          return m2 ? m2[1].trim() : '';
        };
        // mathml 是序列化字符串（outerHTML），annotation 文本里的 < > & 已被实体转义；
        // 正则捕获的是转义形态，直接当纯文本塞进 Word 会显示字面 &lt;（用户实测）。
        const decodeXmlEntities = (s) => String(s)
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&quot;/g, '"')
          .replace(/&apos;/g, "'")
          .replace(/&#39;/g, "'")
          .replace(/&amp;/g, '&');
        // mml2omml（0.5.0）遇到 \overset / \underset（MathML <mover>/<munder>）时，会把
        // <m:limUpp>/<m:limLow> 这类公式对象多包一层 <m:r><m:t>，塞进"文本节点"里。
        // 原始串能被 XML 解析器接受，但语义是错的；更致命的是紧随其后的 repairTextEscaping
        // 会把里面的 < 当文本转义成 &lt;，XML 立刻不成对 → 良构校验失败 → 整条公式降级成
        // LaTeX 源码（用户 2026-09-14 复现：5.3 上下节组合整块显示源码）。
        // 这里按 OMML 语法把错位结构逐层上提：<m:t> 只允许装文本、<m:r> 只允许 run 子元素。
        // 未发生改动时原样返回（不做重新序列化），保证对已正确的 500+ 公式零影响。
        const OMML_RUN_CHILD_TAGS = ['rPr', 't', 'br', 'sym', 'noBreakHyphen', 'softHyphen'];
        const ommlLocalTag = (el) => String(el.localName || el.nodeName).replace(/^.*:/, '');
        const repairMisplacedOMML = (xml) => {
          try {
            // 与 repairOmmlEmptyArgs 同理：含裸 < 的 OMML 直接解析会失败而被静默跳过，
            // 这里先做「最小可解析化」再解析，否则 \overset/\underset 的结构上提同样会被跳过。
            const parsed = parseOmmlForRepair(xml);
            if (!parsed) return xml;
            const doc = parsed.doc;
            let changed = false;
            // 多趟：上提后父层可能又暴露出新的错位（如 \overset{*}{\underset{**}{X}} 的两层嵌套）
            for (let pass = 0; pass < 20; pass++) {
              const nodes = [];
              const collect = (n) => {
                for (const c of Array.from(n.children || [])) { collect(c); nodes.push(c); }
              };
              collect(doc.documentElement); // 自底向上，先处理子节点
              let touched = false;
              for (const el of nodes) {
                const tag = ommlLocalTag(el);
                if (tag === 't' && el.children.length) {
                  // <m:t> 里出现元素 → 元素上提到 m:t 的位置，文本片段重新包成 <m:t>
                  const parent = el.parentNode;
                  let buf = '';
                  const flush = () => {
                    if (!buf) return;
                    const t = el.cloneNode(false);
                    t.textContent = buf;
                    buf = '';
                    parent.insertBefore(t, el);
                  };
                  for (const child of Array.from(el.childNodes)) {
                    if (child.nodeType === 1) { flush(); parent.insertBefore(child, el); }
                    else buf += child.textContent || '';
                  }
                  flush();
                  parent.removeChild(el);
                  touched = true;
                } else if (tag === 'r') {
                  // <m:r> 里出现非 run 子元素（m:limUpp / m:limLow / m:sSubSup…）→ 提到 run 外
                  const stray = Array.from(el.children).filter((c) => OMML_RUN_CHILD_TAGS.indexOf(ommlLocalTag(c)) === -1);
                  if (stray.length) {
                    const parent = el.parentNode;
                    for (const s of stray) parent.insertBefore(s, el);
                    if (!el.children.length && !String(el.textContent || '').trim()) parent.removeChild(el);
                    touched = true;
                  }
                }
              }
              changed = changed || touched;
              if (!touched) break;
            }
            return changed ? new XMLSerializer().serializeToString(doc) : xml;
          } catch (e) {
            return xml; // 修复失败不放大问题：交给下游良构校验与降级逻辑
          }
        };
        // mml2omml 产出 <m:t> 文本内容时不做 XML 转义：公式含 <（如 O(1) < O(\log n)）时
        // OMML 里出现裸 < → 非良构（parsererror）→ 被误判坏公式降级成 LaTeX 纯文本。
        // 这里对 <m:t>…</m:t> 内文本定向转义修复（< 一律转义；& 仅在非实体引用处转义，幂等；
        // > 在 XML 文本中合法不动），修复后良构校验通过即可走 OMML 主路径保留可编辑公式。
        // 注意：正则必须排除自闭合的 <m:t .../>（空文本 run）—— 它一旦被当成"开始标签"，
        // 惰性匹配会一路吞到后面某个 </m:t>，把中间的结构全部转义成文本，整条公式报废
        //（2026-09-14 定位：nary 降级产生空 <m:t/> 后触发）。
        const repairTextEscaping = (xml) => String(xml).replace(
          /(<m:t(?:\s[^>]*[^/>])?>)([\s\S]*?)(<\/m:t>)/g,
          (_, open, text, close) => open
            // DOM 序列化会把 U+00A0 写成 &nbsp; 实体；mml2omml 不还原，最终被下面的 & 转义
            // 修成字面文本 "&nbsp;"（用户实测公式里出现 p&nbsp;prime）。这里先还原成普通空格。
            // 注意也要处理【已双重转义】的形态 &amp;nbsp;：那条路径上 DOM 文本本身就是字面量
            // "&nbsp;"，序列化后成了 &amp;nbsp;，只匹配 &nbsp; 会漏掉 → Word 里直接显示 "&nbsp;"
            //（2026-09-14 用户复核：其中&nbsp;x_i&nbsp;是陈根）。
            + text
              .replace(/&(?:amp;)?nbsp;/gi, ' ')
              .replace(/&(?:amp;)?#0*160;/gi, ' ')
              .replace(/&(?:amp;)?#x0*a0;/gi, ' ')
              .replace(/&(?!(?:lt|gt|amp|quot|apos|#\d+|#x[0-9a-fA-F]+);)/g, '&amp;').replace(/</g, '&lt;')
            + close
        );
        // mhchem（\ce{}）用 <mphantom>X</mphantom> 作「零宽基座」（预览里不可见），但 mml2omml
        // 不认识 <mphantom>，会把里面的 X 当可见文本输出 —— Word 里就成了 CHX₃COOH、X²³⁵X₉₂U。
        // phantom 按定义不可见 → 转换前直接剥离（视觉等价）；剩余的"空基上下标"由
        // repairOmmlEmptyArgs 的 R3/R5 收敛成前缀上下标 m:sPre（2026-09-14 定位）。
        const stripMathmlPhantom = (mathml) => {
          let out = String(mathml);
          for (let i = 0; i < 10; i++) {
            const next = out
              .replace(/<mphantom(?:\s[^>]*)?\/>/g, '')
              .replace(/<mphantom(?:\s[^>]*)?>[\s\S]*?<\/mphantom>/g, '');
            if (next === out) break;
            out = next;
          }
          return out;
        };
        let sawMath = false;
        // 先同步收集所有含公式的 run 位置（开销极小），再分批转换并让出主线程，
        // 避免大量公式的逐条 DOMParser/mml2omml 在主线程堆叠导致界面独占卡死。
        const targets = [];
        const collectMathRuns = (runs) => {
          if (!Array.isArray(runs)) return;
          for (let i = 0; i < runs.length; i++) {
            const r = runs[i];
            if (r && typeof r.mathml === 'string') targets.push({ runs, i });
          }
        };
        for (const node of structure) {
          if (node && node.runs) collectMathRuns(node.runs);
          if (node && node.type === 'table') {
            for (const row of node.rows || []) {
              for (const cell of row.cells || []) {
                for (const p of cell.paragraphs || []) collectMathRuns(p.runs);
              }
            }
          }
        }
        const CHUNK = 20; // 每处理 20 个公式让出一次主线程
        for (let start = 0; start < targets.length; start += CHUNK) {
          const end = Math.min(start + CHUNK, targets.length);
          for (let k = start; k < end; k++) {
            const { runs, i } = targets[k];
            const r = runs[i];
            if (!r || typeof r.mathml !== 'string') continue;
            sawMath = true;
            if (!convert) continue; // 缺库：保留 mathml run，外层据 sawMath 决定走主路径还是回退
            let ommlStr = null;
            try { ommlStr = String(convert(stripMathmlPhantom(r.mathml))); } catch (e) { ommlStr = null; }
            // 先修结构错位（\overset/\underset 被 mml2omml 包进了 m:t），再修空必需参数槽
            // （Word 会把空槽画成虚线占位框），最后做文本转义 —— 三者顺序不可颠倒：
            // 反了会把错位结构里的 < 转义掉、或在已转义文本上做结构搬迁，都会产出坏 OMML。
            // （含裸 < 的 OMML 由两个 repair 内部先做最小可解析化，不再被解析失败跳过。）
            if (ommlStr) ommlStr = repairMisplacedOMML(ommlStr);
            if (ommlStr) ommlStr = repairOmmlEmptyArgs(ommlStr);
            if (ommlStr) ommlStr = repairTextEscaping(ommlStr);
            if (ommlStr && isWellFormed(ommlStr)) {
              runs[i] = { omml: ommlStr };
            } else {
              // 降级为 LaTeX 源码文本：宁可显示源码也不让坏 OMML 拖垮整篇文档。
              const tex = decodeXmlEntities(extractLatex(r.mathml)) || r.mathml.replace(/<[^>]+>/g, '').trim();
              runs[i] = { text: tex };
            }
          }
          if (start + CHUNK < targets.length) await new Promise((res) => setTimeout(res, 0));
        }
        // 无公式 → 走主路径；有公式但缺转换库 → 走 html-docx 回退（公式降级 LaTeX 文本）。
        if (!sawMath) return true;
        return !!convert;
      },
      // 弹「导出 DOCX」确认框：只做说明 + 确认，返回 Promise<boolean>（true=开始导出）。
      // 纸张/方向/边距固定 A4/纵向/标准——Word 是页面模型需要这些值，但让用户在导出前选
      // 是多余的一步（Word 里「布局 → 页面设置」随时可改，多数人导出也不是为了打印）。
      _confirmDocxExport() {
        return new Promise((resolve) => {
          const dlg = document.getElementById('docx-page-dialog');
          if (!dlg) { resolve(true); return; }
          const tipEl = dlg.querySelector('.docx-page-tip');
          if (tipEl) tipEl.textContent = `${this.t('wordTip1')} ${this.t('wordTip2')}`;
          const warnEl = dlg.querySelector('.docx-page-warn');
          if (warnEl) warnEl.textContent = this.t('wordBigFileWarn');
          dlg.classList.remove('hidden');
          const done = (val) => { dlg.classList.add('hidden'); resolve(val); };
          const cancels = dlg.querySelectorAll('.docx-page-cancel');
          const okBtn = dlg.querySelector('.docx-page-ok');
          cancels.forEach((btn) => { btn.onclick = () => done(false); });
          if (okBtn) okBtn.onclick = () => done(true);
        });
      },
      // 导出 DOCX 固定页面设置（不再让用户选）：A4 / 纵向 / 标准边距。
      _docxPageConfig() {
        const pageSize = this._docxPageSize('A4', 'portrait');
        const margins = this._docxMargins('normal');
        // 读取当前主题的语义色，让导出的 docx 在代码块底色/引用左边框/表格边框/正文
        // 字体上贴近软件预览（DOCX 无法 1:1 还原 CSS，但能对齐关键主题色）。
        const cs = getComputedStyle(document.documentElement);
        const hex = (name, fallback) => {
          const v = (cs.getPropertyValue(name) || '').trim().replace(/^#/, '').toUpperCase();
          return /^[0-9A-Fa-f]{6}$/.test(v) ? v : fallback;
        };
        // DOCX 只能指定单一字体名（不像 CSS 可给字体链）：优先用户选的预览字体，
        // 否则用中文字体（与预览的中文回退一致）。自定义导入字体无法嵌入 docx，故跳过，
        // 避免把 -apple-system 这类 CSS 系统关键字直接当成 Word 字体名导致回退异常。
        const userFont = (this._fontFamilyFor(this.settings.previewFont) || '').replace(/^["']|["']$/g, '');
        const baseFont = (userFont && !userFont.startsWith('tizumark-custom-'))
          ? userFont.slice(0, 32)
          : 'Microsoft YaHei';
        // 预览正文字号（px）→ Word 半点（half-point）：1px = 0.75pt = 1.5 half-point。
        // 标题字号沿用 styles.css 里 h1–h6 相对正文的 em 倍率，保证与预览的层次一致。
        const basePx = Number(this.settings.previewFontSize) || 16;
        const toHalfPt = (px) => Math.max(16, Math.round(px * 0.75 * 2));
        const sizeEm = [2, 1.5, 1.25, 1.1, 1, 0.9];
        return {
          pageWidth: pageSize.width, pageHeight: pageSize.height,
          marginTop: margins.top, marginBottom: margins.bottom,
          marginLeft: margins.left, marginRight: margins.right,
          codeBg: hex('--code-bg', 'F6F5F4'),
          accent: hex('--accent-color', '2563EB'),
          border: hex('--border-color', 'D4D4D8'),
          headingColor: hex('--text-primary', '2C2C2E'),
          textSecondary: hex('--text-secondary', '6E6E72'),
          baseSize: toHalfPt(basePx),
          headingSizes: sizeEm.map(m => toHalfPt(basePx * m)),
          baseFont,
          // 预览「行高」设置 → docx 全局行距（docx-builder 换算成 w:spacing/@w:line）
          lineHeight: Number(this.settings.lineHeight) || 1.7,
        };
      },
      // 确保 lib/docx.min.js 已加载（定义 window.DocxLib）。
      // index.html 已常驻加载它，但用户若在改动 index.html 前就打开了 dev 页面且没刷新，
      // 旧页面里没有 docx.min.js → window.DocxLib 缺失 → 主路径整条失败、静默降级 altChunk。
      // 这里在导出时兜底按需加载，已加载则秒回；加载带 10s 超时（本地资源，正常几百毫秒）。
      _ensureDocxLibLoaded(timeoutMs = 10000) {
        if (window.DocxLib) return Promise.resolve(true);
        const src = 'lib/docx.min.js';
        if (document.querySelector('script[src="lib/docx.min.js"]')) {
          // 标签在但还没定义全局：等 onload（理论不该发生，等 2s 兜底）。
          return new Promise((resolve) => setTimeout(() => resolve(!!window.DocxLib), 2000));
        }
        return new Promise((resolve, reject) => {
          const s = document.createElement('script');
          s.src = src;
          let settled = false;
          const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            reject(new Error('docx 库加载超时'));
          }, timeoutMs);
          const done = (ok) => { if (settled) return; settled = true; clearTimeout(timer); resolve(ok); };
          s.onload = () => done(!!window.DocxLib);
          s.onerror = () => { clearTimeout(timer); reject(new Error('docx 库加载失败')); };
          document.head.appendChild(s);
        });
      },
      // 生成 docx（真 OOXML）：主线程直构建（lib/docx.min.js 常驻加载，缺失时按需补加载）。
      // 曾走 Web Worker，但真机上 Worker 不可用会导致整条导出退化成 altChunk（公式全变文字），
      // 可用性优先，直接主线程构建。
      async _buildDocxBuffer(structure, page) {
        await this._ensureDocxLibLoaded();
        if (typeof window.buildDocxFromStructure !== 'function') {
          throw new Error('导出组件未加载（docx-builder 未加载）');
        }
        // 优先用 Web Worker 离主线程构建：彻底消除「导出时界面独占」，并把构建内存压力隔离在
        // Worker 线程（Worker 终止后即回收，不拖累主线程）。Worker 不可用/加载失败/超时/报错时，
        // 自动回退到当前稳定的主线程真 OOXML 路径——因此最坏情况与现在一致，不会更差。
        try {
          const buf = await this._buildDocxInWorker(structure, page);
          if (buf) return buf;
        } catch (e) {
          console.warn('[export] docx Worker 构建失败，回退主线程：', e);
        }
        // 主线程兜底（当前稳定路径）
        // 构建若卡住（极端环境缺 Blob 等）不能让导出永远悬着，超时后仍回退 html-docx，保证「导出一定有结果」。
        const MAIN_BUILD_TIMEOUT = 60000;
        let timer = null;
        const timeout = new Promise((_, rej) => {
          timer = setTimeout(() => rej(new Error('主线程 docx 构建超时')), MAIN_BUILD_TIMEOUT);
        });
        try {
          const blob = await Promise.race([window.buildDocxFromStructure(structure, page), timeout]);
          return await blob.arrayBuffer();
        } finally {
          clearTimeout(timer);
        }
      },
      // 在 Web Worker 里执行 buildDocxFromStructure。依赖加载采用「主线程 fetch 文本 → blob URL →
      // Worker 内 importScripts」方式，规避老 Tauri/WebView 下直接 importScripts 绝对 URL 不稳
      // 的问题，最大化 Worker 真正生效的概率。Worker 不可用/依赖加载失败/超时/报错时，抛错交给
      // _buildDocxBuffer 的主线程兜底——最坏情况与现在一致，不会更差。
      _buildDocxInWorker(structure, page) {
        return new Promise((resolve, reject) => {
          if (typeof Worker === 'undefined' || typeof URL === 'undefined' || !URL.createObjectURL || typeof fetch === 'undefined') {
            return reject(new Error('Web Worker / fetch 不可用'));
          }
          const base = location.href;
          let libUrl, builderUrl;
          try {
            libUrl = new URL('lib/docx.min.js', base).href;
            builderUrl = new URL('modules/docx-builder.js', base).href;
          } catch (e) {
            return reject(e);
          }
          let depUrl = null;
          // 主线程先 fetch 两个依赖文本（同源 fetch 在 Tauri webview 通常可靠），拼成 blob URL。
          Promise.all([
            fetch(libUrl).then((r) => r.text()),
            fetch(builderUrl).then((r) => r.text()),
          ]).then(([libText, builderText]) => {
            const depBlob = new Blob([libText + '\n;\n' + builderText], { type: 'application/javascript' });
            depUrl = URL.createObjectURL(depBlob);
            // 经典 Worker（importScripts 仅经典 Worker 可用）：启动脚本仅 importScripts(depUrl)。
            const src =
              "self.onmessage=async function(e){" +
              "try{" +
              "importScripts(" + JSON.stringify(depUrl) + ");" +
              "var blob=await self.buildDocxFromStructure(e.data.structure,e.data.page);" +
              "var buf=await blob.arrayBuffer();" +
              "self.postMessage({ok:true,buf:buf},[buf]);" +
              "}catch(err){self.postMessage({ok:false,error:String((err&&err.stack)||err)});}" +
              "};";
            let worker = null;
            let settled = false;
            let url = null;
            try {
              const blob = new Blob([src], { type: 'application/javascript' });
              url = URL.createObjectURL(blob);
              worker = new Worker(url);
            } catch (e) {
              if (url) { try { URL.revokeObjectURL(url); } catch (_) {} }
              if (depUrl) { try { URL.revokeObjectURL(depUrl); } catch (_) {} }
              return reject(e);
            }
            // Worker 构建整体超时（含 importScripts 静默卡住的情况），到时回退主线程。
            const timer = setTimeout(() => {
              if (settled) return;
              settled = true;
              try { worker.terminate(); } catch (_) {}
              try { URL.revokeObjectURL(url); } catch (_) {}
              try { URL.revokeObjectURL(depUrl); } catch (_) {}
              reject(new Error('docx Worker 构建超时'));
            }, 60000);
            worker.onmessage = (ev) => {
              if (settled) return;
              const d = ev.data || {};
              if (d.ok) {
                // 静默坏文件兜底：Worker 不抛错却产出空/非法 buffer 时，不能当成成功直接写出
                // （否则导出的 docx 打不开），判空即视为失败，回退主线程重建。
                if (!d.buf || !(d.buf instanceof ArrayBuffer) || d.buf.byteLength === 0) {
                  settled = true;
                  clearTimeout(timer);
                  try { worker.terminate(); } catch (_) {}
                  try { URL.revokeObjectURL(url); } catch (_) {}
                  try { URL.revokeObjectURL(depUrl); } catch (_) {}
                  reject(new Error('docx Worker 产出为空/非法，回退主线程'));
                  return;
                }
                settled = true;
                clearTimeout(timer);
                // 拿到结果立即终止 Worker：释放其线程内 docx 库与已构建文档占用的内存，
                // 真正实现「导出内存压力隔离」，避免 worker 残留导致主线程依旧内存高压。
                try { worker.terminate(); } catch (_) {}
                try { URL.revokeObjectURL(url); } catch (_) {}
                try { URL.revokeObjectURL(depUrl); } catch (_) {}
                resolve(d.buf);
              } else {
                settled = true;
                clearTimeout(timer);
                try { worker.terminate(); } catch (_) {}
                try { URL.revokeObjectURL(url); } catch (_) {}
                try { URL.revokeObjectURL(depUrl); } catch (_) {}
                reject(new Error(d.error || 'docx Worker 构建失败'));
              }
            };
            worker.onerror = (err) => {
              if (settled) return;
              settled = true;
              clearTimeout(timer);
              try { worker.terminate(); } catch (_) {}
              try { URL.revokeObjectURL(url); } catch (_) {}
              try { URL.revokeObjectURL(depUrl); } catch (_) {}
              reject(new Error('docx Worker 错误: ' + (err && err.message ? err.message : err)));
            };
            // structure 含 Uint8Array 图片数据：structured clone 拷贝即可（不 transfer，避免主线程侧被置空）。
            worker.postMessage({ structure, page });
          }).catch((err) => {
            // 依赖 fetch 失败：回退主线程。
            if (depUrl) { try { URL.revokeObjectURL(depUrl); } catch (_) {} }
            reject(new Error('docx 依赖加载失败，回退主线程: ' + (err && err.message ? err.message : err)));
          });
        });
      },
      async exportWord() {
        // 主路径：docx 库主线程直构建真 OOXML（可编辑公式 + 二进制图片）；
        // html-docx（altChunk）仅在主路径失败时兜底。
  
        // 唯一的确认框：说明导出特性后点「导出」开始（取消即中止）。不再让用户选
        // 纸张/方向/边距——固定 A4/纵向/标准，需要改的人在 Word 里改。
        const proceed = await this._confirmDocxExport();
        if (!proceed) return;
  
        // Loading overlay：导出过程（尤其是 html2canvas 渲染公式/图表）可能阻塞主线程，
        // 给用户一个明确的等待反馈；60s watchdog 兜底防止 overlay 永远不消失。
        const overlay = document.createElement('div');
        overlay.innerHTML = `<div class="pdf-loading-spinner"></div><div class="pdf-loading-text">${this.t('preparingWordExport')}</div>`;
        overlay.style.cssText = 'position:fixed;inset:0;z-index:9999;display:flex;flex-direction:column;align-items:center;justify-content:center;background:rgba(0,0,0,0.35);font-family:-apple-system,sans-serif;';
        if (!document.getElementById('pdf-loading-style')) {
          const s = document.createElement('style');
          s.id = 'pdf-loading-style';
          s.textContent = '.pdf-loading-spinner{width:36px;height:36px;border:3px solid rgba(255,255,255,0.25);border-top-color:#fff;border-radius:50%;animation:pdf-spin .7s linear infinite;margin-bottom:14px;}@keyframes pdf-spin{to{transform:rotate(360deg)}}.pdf-loading-text{color:#fff;font-size:15px;letter-spacing:.5px;}';
          document.head.appendChild(s);
        }
        document.body.appendChild(overlay);
  
        // 取消按钮 + 进度文案：大文档 Word 导出的耗时主要在"逐图转 PNG"，
        // 必须让用户看到进度、并且能退出（历史：界面像死了，只能任务管理器结束进程）。
        let exportCancelled = false;
        const t0 = Date.now();
        const progressText = overlay.querySelector('.pdf-loading-text');
        const cancelBtn = document.createElement('button');
        cancelBtn.type = 'button';
        cancelBtn.textContent = this.t('exportCancel');
        cancelBtn.style.cssText = 'margin-top:14px;padding:6px 18px;border-radius:6px;' +
          'border:1px solid rgba(255,255,255,0.5);background:rgba(255,255,255,0.14);color:#fff;' +
          'cursor:pointer;font-size:13px;font-family:inherit;';
        cancelBtn.addEventListener('click', () => {
          exportCancelled = true;
          cancelBtn.disabled = true;
          cancelBtn.textContent = this.t('exportCancelling');
        });
        overlay.appendChild(cancelBtn);

        let overlayDone = false;
        let exported = false;
        const hideOverlay = () => {
          if (overlayDone) return;
          overlayDone = true;
          if (overlay.parentNode) overlay.remove();
        };
  
        let watchdog = null;
        try {
          // 先让 overlay 渲染出来，再执行可能较重的同步/阻塞操作。
          await new Promise(r => requestAnimationFrame(r));
  
          const path = await dialogSave({
            defaultPath: this.activeTab.filePath
              ? this.activeTab.filePath.replace(/\.md$/, '.docx')
              : 'export.docx',
            filters: [{ name: 'Word 文档', extensions: ['docx'] }]
          });
          if (!path) {
            hideOverlay();
            return;
          }
  
          // watchdog 只在「真正开始导出处理」之后才计时，不把用户选文件的时间算进去；
          // 超时放宽到 120s，避免公式/图表多、文档大时导出仍在进行却被误判卡死提前撤掉遮罩。
          watchdog = setTimeout(() => {
            this.setStatus(this.t('exportError'));
            hideOverlay();
          }, 120000);
  
          const clone = await this._clonePreviewForExport();
          // 大文档：用户在确认框里取消了导出。watchdog 已启动，必须一并清掉，
          // 否则 120s 后它会误报「导出失败」。
          if (!clone) { clearTimeout(watchdog); hideOverlay(); return; }
          // 预告工作量：让用户对"要等多久"有预期（图表数 × 经验系数，仅提示不阻塞）
          const diagramTotal = clone.querySelectorAll('.mermaid-container').length;
          if (diagramTotal > 0 && progressText) {
            progressText.textContent = this.t('exportDiagramPreflight', {
              total: diagramTotal,
              sec: Math.max(5, Math.round(diagramTotal * 0.8)),
            });
          }
          clone.style.position = '';
          clone.style.left = '';
          clone.style.top = '';
          clone.style.width = '';
          clone.style.padding = '';
          clone.style.overflow = '';
          clone.style.height = '';
  
          clone.querySelectorAll('.copy-btn').forEach(el => el.remove());
          const abbrData = clone.querySelector('#abbr-data');
          if (abbrData) abbrData.remove();
  
          // 从真实预览元素采集每张图片的渲染尺寸（仍在文档流中，getBoundingClientRect / naturalWidth 可靠），
          // 写入 clone 的同源 <img>，供 _prepareWordDOM 设置导出尺寸。
          // 不再依赖 _prepareWordDOM 内 new Image() 异步重加载：该方式在 SVG（naturalWidth 为 0）、
          // 图片未成功内联、或加载超时时会读取失败 → natW=0 → 所有图片退化为 width=500
          // （小图被放大、超高图因不设 height 而跨页被裁）。
          {
            const srcImgs = Array.from(this.preview.querySelectorAll('img'));
            const dstImgs = Array.from(clone.querySelectorAll('img'));
            dstImgs.forEach((dimg, i) => {
              const simg = srcImgs[i];
              if (!simg) return;
              // 若预览元素已带 dataset（测试模拟已渲染），优先使用；否则取真实布局尺寸。
              const dw = simg.dataset.dispW ? parseInt(simg.dataset.dispW, 10)
                : (Math.round(simg.getBoundingClientRect().width) || 0);
              const dh = simg.dataset.dispH ? parseInt(simg.dataset.dispH, 10)
                : (Math.round(simg.getBoundingClientRect().height) || 0);
              dimg.dataset.natW = String(simg.naturalWidth || 0);
              dimg.dataset.natH = String(simg.naturalHeight || 0);
              dimg.dataset.dispW = String(dw || (simg.naturalWidth || 0));
              dimg.dataset.dispH = String(dh || (simg.naturalHeight || 0));
            });
          }
  
          // ECharts 是 canvas，克隆会丢像素：先截成 <img> 再内联，三端稳定显示。
          const echSnapsDocx = await this._snapshotEchartsForExport();
          this._applyEchartsSnapshots(clone, echSnapsDocx);
          await this._inlineImagesForExport(clone, this.activeTab.filePath);
          this._flushExportImageWarnings();

          // 把 Web 预览 DOM 预处理成 docx 兼容结构。
          // skipMathImage=true：保留 .katex（其 <math> 供 MathML→OMML 转可编辑公式），
          // 公式转 PNG 仅在 html-docx 回退路径需要（_fallbackWordHtmlExport 内补跑）。
          const prep = await this._prepareWordDOM(clone, {
            skipMathImage: true,
            control: {
              isCancelled: () => exportCancelled,
              onProgress: (done, total) => {
                if (progressText) {
                  progressText.textContent = this.t('exportDiagramProgress', {
                    done: done, total: total, sec: Math.round((Date.now() - t0) / 1000),
                  });
                }
              },
            },
          });
          if (prep === 'cancelled') {
            clearTimeout(watchdog);
            hideOverlay();
            this.setStatus(this.t('exportLargeDocCancelled'));
            return;
          }
  
          // 页面设置已在流程开始的弹框里选好（pageCfg），此处不再二次弹框打断导出。
  
          // 用 docx 库生成真 OOXML：DOM → 中间结构 → 主线程构建 Document → toBlob。
          // _buildDocxBuffer 内部保证 docx 库已加载（缺失时按需补加载），主路径失败才回退 altChunk。
          // 让出主线程：DOM→结构转换与后续 docx 构建都是同步重 CPU 调用，先 yield 让 spinner 动起来、
          // 并响应取消按钮，避免「界面像死了、其他功能用不了」（2026-09-25 优化）。
          await new Promise(r => setTimeout(r, 0));
          if (exportCancelled) { clearTimeout(watchdog); hideOverlay(); this.setStatus(this.t('exportLargeDocCancelled')); return; }
          const structure = (typeof window.domToDocxStructure === 'function')
            ? await window.domToDocxStructure(clone)
            : null;
          await new Promise(r => setTimeout(r, 0));
          if (exportCancelled) { clearTimeout(watchdog); hideOverlay(); this.setStatus(this.t('exportLargeDocCancelled')); return; }
          const mathConverted = (structure && Array.isArray(structure))
            ? await this._structureMathmlToOmml(structure)
            : false;
          if (structure && Array.isArray(structure) && structure.length > 0 && mathConverted) {
            const page = this._docxPageConfig(); // 固定 A4/纵向/标准边距
            const diag = {
              build: '2026-09-08-r3',
              hasDocxLib: !!window.DocxLib,
              hasBuilder: typeof window.buildDocxFromStructure === 'function',
              hasDomToDocx: typeof window.domToDocxStructure === 'function',
              hasMathML2OMML: typeof MathML2OMML !== 'undefined',
              structureNodes: structure ? structure.length : 0,
              mathConverted,
            };
            try {
              // 进入 docx 库最终构建（同步大调用）前再让出主线程，确保 spinner 完成一帧渲染、
              // 并使取消按钮在构建开始前可响应。
              await new Promise(r => setTimeout(r, 0));
              if (exportCancelled) { clearTimeout(watchdog); hideOverlay(); this.setStatus(this.t('exportLargeDocCancelled')); return; }
              const arrayBufferDocx = await this._buildDocxBuffer(structure, page);
              clearTimeout(watchdog);
              const bufDocx = new Uint8Array(arrayBufferDocx);
              await TauriApi.writeBinaryFile({ path, contents: bufDocx });
              this.setStatus(`${this.t('exportedWord')}: ${path}`);
              exported = true;
            } catch (docxErr) {
              // 明确暴露主路径失败原因（之前静默降级，公式/图片全废却看不出为什么）。
              console.error('[export] docx 主路径失败，降级 html-docx：', docxErr);
              this.setStatus(`${this.t('exportError')}: docx ${docxErr && docxErr.message ? docxErr.message : docxErr}`);
              // 写诊断文件到 docx 同目录，便于用户反馈精准定位（真机上拿不到 console）。
              try {
                const diagText = `TizuMark 导出诊断\n代码版本: ${diag.build}\n\n` +
                  `window.DocxLib: ${diag.hasDocxLib}\n` +
                  `window.buildDocxFromStructure: ${diag.hasBuilder}\n` +
                  `window.domToDocxStructure: ${diag.hasDomToDocx}\n` +
                  `MathML2OMML: ${diag.hasMathML2OMML}\n` +
                  `structure 节点数: ${diag.structureNodes}\n` +
                  `公式是否全部转换: ${diag.mathConverted}\n\n` +
                  `主路径错误: ${docxErr && docxErr.stack ? docxErr.stack : docxErr}\n`;
                const diagPath = path.replace(/\.docx$/i, '_diagnostic.txt');
                await TauriApi.writeFile({ path: diagPath, content: diagText });
                this.showToast('公式导出失败，已生成诊断文件：' + diagPath, 'warning');
              } catch (e) { /* 写诊断文件失败也不阻塞回退 */ }
              await this._fallbackWordHtmlExport(clone, path, watchdog, (ok) => { exported = ok; });
            }
          } else {
            // 主路径前置条件不满足（structure 空 / 公式未转换）：写诊断帮助定位。
            try {
              const diagText = `TizuMark 导出诊断\n代码版本: 2026-09-08-r3\n\n` +
                `走回退原因: ${!structure || !structure.length ? 'structure 为空' : '公式未全部转换(mathConverted=false)'}\n` +
                `window.DocxLib: ${!!window.DocxLib}\n` +
                `MathML2OMML: ${typeof MathML2OMML !== 'undefined'}\n` +
                `structure 节点数: ${structure ? structure.length : 0}\n`;
              await TauriApi.writeFile({ path: path.replace(/\.docx$/i, '_diagnostic.txt'), content: diagText });
            } catch (e) { /* 诊断文件为排查用途，写入失败不阻塞回退导出 */ console.error('[export] 诊断文件写入失败:', e); }
            await this._fallbackWordHtmlExport(clone, path, watchdog, (ok) => { exported = ok; });
          }
        } catch (error) {
          clearTimeout(watchdog);
          console.error('exportWord error:', error);
          this.setStatus(`${this.t('exportFailed')}: ${error}`);
        } finally {
          hideOverlay();
          // 导出真正完成后（写入文件成功）再弹成功提示；先关遮罩，确保 toast 不被遮住。
          if (exported) {
            this.showToast(this.t('exportSuccess'), 'success');
          }
        }
      },
      // 回退路径：用 html-docx 把 HTML altChunk 写入 docx（兼容性较差，仅 docx 生成失败时兜底）。
      async _fallbackWordHtmlExport(clone, path, watchdog, onDone) {
        // DOCX 主路径保留 .katex（转 OMML 可编辑公式）；回退到 Word HTML 导入器时
        // KaTeX/MathML 都不被识别，这里把公式降级为 LaTeX 源码文本（不转图片：公式一律
        // 以可编辑为目标，图片公式不可二次编辑，产品上不提供）。
        this._katexElsToLatexText(clone);
        const escapedTitle = this.activeTab.name.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
        // 公式已降级为 LaTeX 源码文本，不再需要内联 KaTeX CSS（约 300KB，白白撑大 docx）。
        let hljsCSS = '';
        if (!this.isDark) {
          try {
            const themeLink = document.getElementById('highlight-theme');
            if (themeLink) {
              const resp = await fetch(themeLink.getAttribute('href'));
              if (resp.ok) hljsCSS = await resp.text();
            }
          } catch (e) { /* 高亮主题 CSS 为可选样式，拉取失败不阻断导出 */ console.error('[export] 高亮主题 CSS 拉取失败:', e); }
        }
        const wordOverride = `
        .alert { background: #f6f5f4; border-left-color: #d4d4d8; }
        .alert-note { background: #eef4ff; border-left-color: #3884ff; }
        .alert-tip { background: #e9f9f1; border-left-color: #10b981; }
        .alert-important { background: #f3edfd; border-left-color: #8b5cf6; }
        .alert-warning { background: #fef6e7; border-left-color: #f59e0b; }
        .alert-caution { background: #fdecec; border-left-color: #ef4444; }
        .mermaid-container { width: 100%; max-width: 100%; box-sizing: border-box; }
        .tizu-math-source { font-family: Consolas, "SF Mono", monospace; background: #f6f5f4; padding: 1px 4px; border-radius: 3px; }`;
        const wordStyle = `${this._documentExportCSS()}\n${wordOverride}\n${hljsCSS ? hljsCSS : ''}`;
        const wordHTML = `<!DOCTYPE html>
    <html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40">
    <head><meta charset="UTF-8"><title>${escapedTitle}</title>
    <style>
    ${wordStyle}
    </style></head>
    <body>
    ${clone.innerHTML}
    </body>
    </html>`;
        try {
          const arrayBuffer = await this._convertHtmlToDocxBuffer(wordHTML);
          const buf = new Uint8Array(arrayBuffer);
          await TauriApi.writeBinaryFile({ path, contents: buf });
          this.setStatus(`${this.t('exportedWord')}: ${path}`);
          onDone(true);
        } catch (error) {
          clearTimeout(watchdog);
          console.error('fallback Word export error:', error);
          this.setStatus(`${this.t('exportFailed')}: ${error}`);
          onDone(false);
        }
      },
      async exportImage() {
        if (typeof html2canvas === 'undefined') {
          this.reportError('E_RENDER', { detail: '导出组件未加载（html2canvas not loaded）' });
          return;
        }
  
        let clone = null;
        try {
          this.setStatus(this.t('generatingImg'));
  
          clone = await this._clonePreviewForExport();
          if (!clone) return;   // 大文档：用户在确认框里取消了导出
          clone.style.position = 'fixed';
          clone.style.left = '-9999px';
          clone.style.top = '0';
          clone.style.width = '800px';
          clone.style.padding = '32px';
          clone.style.background = this.isDark ? '#1a1b1e' : '#ffffff';
          clone.style.color = this.isDark ? '#d4d4d8' : '#2a2a2e';
          clone.style.overflow = 'visible';
          clone.style.height = 'auto';
          document.body.appendChild(clone);

          // ECharts 是 <canvas> 渲染：cloneNode **不复制** canvas 像素，html2canvas 只克隆不快照
          // → 导出长图时 ECharts 图表整块空白。HTML / Word / PDF 三路都已做「快照 → 替换成 <img>」，
          // 唯独 PNG 这一路漏了（审计发现，2026-09-24）。
          try {
            const echSnapsImg = await this._snapshotEchartsForExport();
            this._applyEchartsSnapshots(clone, echSnapsImg);
          } catch (e) {
            console.warn('[export] ECharts 快照失败（不影响其它内容）:', e);
          }
  
          // 图片加载策略与实时预览 processImages 保持一致：
          // data:/http(s):/file:/blob: 直接保留；绝对路径直接读取；相对路径按当前文档目录解析
          const images = clone.querySelectorAll('img');
          const tabFile = this.activeTab ? this.activeTab.filePath : '';
          const imgDir = tabFile ? tabFile.replace(/[/\\][^/\\]*$/, '') : '';
          const imagePromises = Array.from(images).map(async (img) => {
            const src = img.getAttribute('src');
            if (!src || src.startsWith('data:') || src.startsWith('http://') ||
                src.startsWith('https://') || src.startsWith('file://') || src.startsWith('blob:')) return;
  
            let url = src;
            if (!(src.startsWith('/') || /^[a-zA-Z]:[/\\]/.test(src)) && imgDir) {
              url = imgDir + '/' + src; // 相对路径按文档目录解析
            }
  
            try {
              const base64 = await TauriApi.fetchImageAsBase64({ url });
              const ext = src.split('.').pop().split('?')[0].toLowerCase();
              let mime = 'image/png';
              if (ext === 'jpg' || ext === 'jpeg') mime = 'image/jpeg';
              else if (ext === 'gif') mime = 'image/gif';
              else if (ext === 'svg') mime = 'image/svg+xml';
              else if (ext === 'webp') mime = 'image/webp';
              img.src = `data:${mime};base64,${base64}`;
            } catch (e) {
              img.style.border = '1px solid red';
              img.alt = this.t('imageLoadFailed');
            }
          });
  
          await Promise.all(imagePromises);
          await new Promise(r => setTimeout(r, 300));
  
          const canvas = await html2canvas(clone, {
            scale: 2,
            useCORS: true,
            allowTaint: true,
            logging: false,
            backgroundColor: this.isDark ? '#1a1b1e' : '#ffffff',
            width: 800,
            windowWidth: 800
          });
  
          const imgData = canvas.toDataURL('image/png');
  
          const result = await dialogSave({
            defaultPath: `${this.activeTab.name.replace(/\.[^.]+$/, '')}.png`,
            filters: [{ name: 'PNG', extensions: ['png'] }]
          });
  
          if (!result) return;
  
          const base64 = imgData.split(',')[1];
          const binaryStr = atob(base64);
          const bytes = new Uint8Array(binaryStr.length);
          for (let i = 0; i < binaryStr.length; i++) {
            bytes[i] = binaryStr.charCodeAt(i);
          }
  
          const arr = Array.from(bytes);
          await TauriApi.writeBinaryFile({ path: result, contents: arr });
  
          this.setStatus(`${this.t('exportedImg')}: ${result}`);
        } catch (error) {
          this.setStatus(`${this.t('exportFailed')}: ${error}`);
        } finally {
          if (clone && clone.parentNode) {
            clone.parentNode.removeChild(clone);
          }
        }
      },
      async exportPDF() {
        // Print tips + 醒目警示（"文件较大时生成 PDF 耗时较长..."）一起在确认框里展示，
        // 用户点确认后直接走系统打印对话框，不再做任何"是否写完"的承诺。
        const proceed = await this.showConfirmDialog(
          this.t('exportPDF'),
          this.t('printTip1') + '\n\n' + this.t('printTip2'),
          null,
          this.t('pdfBigFileWarn'),
        );
        if (!proceed) return;
  
        // --- Loading overlay (打印准备中，afterprint 立即收尾) ---
        const overlay = document.createElement('div');
        overlay.innerHTML = `<div class="pdf-loading-spinner"></div><div class="pdf-loading-text">${this.t('preparingPrint')}</div>`;
        overlay.style.cssText = 'position:fixed;inset:0;z-index:9999;display:flex;flex-direction:column;align-items:center;justify-content:center;background:rgba(0,0,0,0.35);font-family:-apple-system,sans-serif;';
        if (!document.getElementById('pdf-loading-style')) {
          const s = document.createElement('style');
          s.id = 'pdf-loading-style';
          s.textContent = '.pdf-loading-spinner{width:36px;height:36px;border:3px solid rgba(255,255,255,0.25);border-top-color:#fff;border-radius:50%;animation:pdf-spin .7s linear infinite;margin-bottom:14px;}@keyframes pdf-spin{to{transform:rotate(360deg)}}.pdf-loading-text{color:#fff;font-size:15px;letter-spacing:.5px;}';
          document.head.appendChild(s);
        }
        document.body.appendChild(overlay);
  
        let overlayDone = false;
        const hideOverlay = () => {
          if (overlayDone) return;
          overlayDone = true;
          if (overlay.parentNode) overlay.remove();
        };
  
        try {
          // Yield so the overlay paints before CPU-heavy Mermaid work
          await new Promise(r => requestAnimationFrame(r));
  
          // 文件名：取自当前 md，去扩展名。系统打印对话框默认文件名走主窗口 document.title
          // （_exportViaSystemPrint 在 iframe.onload 里临时覆盖为该值），无需在应用内另弹保存框。
          const pdfBaseName = String(this.activeTab.name || '').replace(/\.[^.]+$/, '');
          const safeBaseName = pdfBaseName || this.t('untitled') || 'document';
  
          const clone = await this._clonePreviewForExport();
          if (!clone) { hideOverlay(); return; }   // 大文档：用户在确认框里取消了导出
          clone.querySelectorAll('.copy-btn, #abbr-data').forEach(el => el.remove());

          // ECharts 是 canvas，克隆会丢像素：先截成 <img> 再内联，PDF 稳定显示。
          const echSnapsPdf = await this._snapshotEchartsForExport();
          this._applyEchartsSnapshots(clone, echSnapsPdf);
          // 图片内联：把预览里的 blob:/file:///相对路径图片全部转内联 base64，
          // 使打印帧自包含（不受 blob LRU 回收 / 源解析影响，根除 PDF 空白图）。
          await this._inlineImagesForExport(clone, this.activeTab.filePath);
          this._flushExportImageWarnings();
  
          // Re-render Mermaid via mermaid.render() so every diagram gets a
          // consistent viewBox regardless of the current preview-pane width.
          // 只挑真正的 mermaid 容器：我们的图表容器也带 `.mermaid-container` 类，
          // 若一并送进 mermaid.render，其源码（DOT / ECharts option / WaveDrom / TikZ …）
          // 会被当成 Mermaid 语法解析，并可能被错误图整块顶掉（见 _mermaidContainersForRerender）。
          const mermaidContainers = this._mermaidContainersForRerender(clone);
          if (typeof mermaid !== 'undefined' && mermaidContainers.length) {
            const ff = this._exportPdfFontStack();
            mermaid.initialize({ startOnLoad: false, theme: this.isDark ? 'dark' : 'default', securityLevel: 'strict', fontFamily: ff, themeVariables: { fontSize: '14px' } });
            for (let i = 0; i < mermaidContainers.length; i++) {
              const code = (mermaidContainers[i].getAttribute('data-code') || mermaidContainers[i].textContent || '').trim();
              if (!code) continue;
              try {
                const result = await mermaid.render('pdf-mermaid-' + i, code);
                const wrapper = document.createElement('div');
                wrapper.className = 'mermaid-container';
                wrapper.innerHTML = result.svg;
                const svgEl = wrapper.querySelector('svg');
                if (svgEl) {
                  svgEl.removeAttribute('style');
                  svgEl.removeAttribute('width');
                  svgEl.removeAttribute('height');
                  const vb = svgEl.getAttribute('viewBox');
                  if (vb) {
                    const parts = vb.split(/\s+/);
                    if (parts.length >= 4) {
                      svgEl.setAttribute('width', parts[2]);
                      svgEl.setAttribute('height', parts[3]);
                    }
                  }
                }
                mermaidContainers[i].replaceWith(wrapper);
              } catch (e) {
                console.error('Mermaid PDF render error for diagram', i, ':', e);
              }
            }
          }
  
          // 完整 styles.css：优先 fetch（原始文本保真），失败回退已加载样式表 CSSOM（加固，避免软依赖）
          const appCSS = await this._loadStylesheetText('styles.css');
          let hljsCSS = '';
          try { const themeLink = document.getElementById('highlight-theme'); if (themeLink) { const resp = await fetch(themeLink.getAttribute('href')); if (resp.ok) hljsCSS = await resp.text(); } } catch (e) { /* skip */ }
          let katexCSS = '';
          try { const resp = await fetch('lib/katex/katex.min.css'); if (resp.ok) katexCSS = await this._inlineKatexFonts(await resp.text()); } catch (e) { /* skip */ }
          // 自定义字体的 @font-face（base64 内联）由 #custom-fonts-style 持有。打印帧是独立文档，
          // 必须一并携带，否则用户选了自定义预览字体时，字体链首项在 PDF 里无字形可落。
          const customFontStyleEl = document.getElementById('custom-fonts-style');
          const customFontCSS = customFontStyleEl ? (customFontStyleEl.textContent || '') : '';
  
          // escapedTitle：用于打印帧 <title> / contentDocument.title（去扩展名文件名已在上文取得）
          const escapedTitle = safeBaseName.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  
          const colorScheme = document.documentElement.getAttribute('data-color-scheme') || 'default';
          const themeMode = document.documentElement.getAttribute('data-theme')
            || (this.isDark ? 'dark' : 'light');

          // 打印帧是【独立文档】：<html> 上的运行时内联变量（--preview-weight / --preview-bold-weight /
          // --custom-bg / --custom-fg 等，由 applySettings / applyCustomBg 写入）不会被继承；
          // 不复制过去，PDF 里正文字重会回落 400、加粗回落 700，自定义底色也会失效。
          // （data-color-scheme / data-theme 已复制到 <html> 属性上，这里只补 CSS 变量。）
          const rootInline = (document.documentElement.getAttribute('style') || '').trim();
          const previewElStyle = getComputedStyle(this.preview);
          const pdfFontVar = previewElStyle.fontFamily || '';
          const pdfCodeFontVar = (previewElStyle.getPropertyValue('--font-code-preview') || '').trim();
          const pdfCustomBg = !!this.settings.customBgEnabled;
          const rootVarsCSS = [
            pdfFontVar ? `--font-preview: ${pdfFontVar};` : '',
            rootInline,
            pdfCodeFontVar ? `--font-code-preview: ${pdfCodeFontVar};` : '',
          ].filter(Boolean).join(' ');

          const printCSS = `
    :root { ${rootVarsCSS} }
    @page { margin: 1.5cm; }
    html, body { margin: 0 !important; padding: 0 !important; height: auto !important; overflow: visible !important; background: ${pdfCustomBg ? 'var(--custom-bg)' : 'var(--preview-bg, #ffffff)'} !important; }
    ${pdfCustomBg ? '.preview-content { background: var(--custom-bg) !important; color: var(--custom-fg) !important; }' : ''}
    .preview-content { max-width: 680px !important; margin: 0 auto !important; padding: 16px 24px !important; font-family: ${this._exportPdfFontStack()} !important; }
    .preview-content pre { white-space: pre-wrap !important; word-wrap: break-word !important; word-break: break-word !important; overflow: visible !important; }
    .preview-content pre code { white-space: pre-wrap !important; word-wrap: break-word !important; word-break: break-word !important; }
    /* 代码块 hljs 默认主题里 .hljs 元素带 background:#ffffff，会盖住 pre 的灰色形成"内白外灰"。
       强制透明 + 12px 内边距，让整个代码块统一是 pre 的 --code-bg 灰色（与软件预览一致）。 */
    .preview-content pre code.hljs,
    .preview-content pre .hljs { background: transparent !important; padding: 12px 16px !important; }
    /* 代码块行结构（导出 iframe 没载入 styles.css，code-block.js 输出的 .code-line 必须显式块级化） */
    .code-scroll { max-height: none !important; overflow: visible !important; }
    .code-line { display: flex !important; line-height: 1.8 !important; min-width: 0 !important; }
    .code-line-num { flex-shrink: 0 !important; width: 3em !important; text-align: right !important; padding-right: 0.8em !important; color: #888 !important; user-select: none !important; display: none !important; }
    .preview-content.code-line-numbers .code-line-num { display: inline !important; }
    .code-line-text { white-space: pre-wrap !important; word-wrap: break-word !important; word-break: break-word !important; flex: 1 1 auto !important; min-width: 0 !important; }
    .mermaid-container { margin: 8px 0 !important; max-width: 100% !important; overflow: hidden !important; break-inside: avoid; page-break-inside: avoid; }
    .mermaid-container svg { width: auto !important; max-width: 100% !important; height: auto !important; display: block !important; margin: 0 auto !important; }
    .mermaid-container svg text, .mermaid-container svg .nodeLabel, .mermaid-container svg .edgeLabel, .mermaid-container svg .label, .mermaid-container svg textPath { font-size: 14px !important; }
    .mermaid-container svg foreignObject,
    .mermaid-container svg foreignObject div,
    .mermaid-container svg foreignObject span { font-size: 14px !important; line-height: 1.4 !important; }
    h1, h2, h3 { page-break-after: avoid; }
    blockquote, table, img, .math-display, .alert, .mermaid-container { page-break-inside: avoid; }
    p, li { orphans: 3; widows: 3; }
    input[type="checkbox"] { -webkit-appearance: none; appearance: none; margin-right: 8px; width: 16px; height: 16px; border: 1.5px solid #d4d4d8; border-radius: 3px; vertical-align: middle; position: relative; top: -1px; cursor: default; }
    input[type="checkbox"]:checked { background: #16a34a url("data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgc3Ryb2tlPSJ3aGl0ZSIgc3Ryb2tlLXdpZHRoPSIzIiBmaWxsPSJub25lIj48cGF0aCBkPSJNNSAxM2w0IDRMMTkgNyIvPjwvc3ZnPg==") center / 14px no-repeat; border-color: #16a34a; }
    input[type="checkbox"]:checked::after { display: none !important; }
    `;
  
          const html = `<!DOCTYPE html>
    <html lang="zh-CN" data-color-scheme="${colorScheme}" data-theme="${themeMode}">
    <head><meta charset="UTF-8"><title>${escapedTitle}</title>
    <style>${customFontCSS}${appCSS}${hljsCSS}${katexCSS}${printCSS}</style></head>
    <body>
    <div class="preview-content">${clone.innerHTML}</div>
    </body></html>`;
  
          // 系统打印（iframe + contentWindow.print()）：用 OS 打印引擎生成 PDF，保证文字可选中。
          // afterprint 即收尾，不做落盘检测——OS 打印后台异步落盘是浏览器架构限制，
          // 应用拿不到"写完"回调。警示已在确认框里展示，由用户自己判断何时打开。
          await this._exportViaSystemPrint(html, safeBaseName, escapedTitle, hideOverlay);
        } catch (e) {
          console.error('exportPDF error:', e);
          hideOverlay();
          this.setStatus(this.t('exportError'));
        }
      },
      // 系统打印路径（iframe + contentWindow.print()）：用 OS 打印引擎生成 PDF。
      // 不做落盘检测（OS 打印后台异步写盘，应用拿不到"写完"回调；警示已前置到确认框）。
      // afterprint（用户在系统框里点完打印/取消后触发）一回调即收尾；30s watchdog 兜底异常。
      async _exportViaSystemPrint(html, safeBaseName, escapedTitle, hideOverlay) {
        const iframe = document.createElement('iframe');
        iframe.style.cssText = 'position:fixed;left:-9999px;top:0;width:680px;height:600px;border:none;';
        iframe.srcdoc = html;
        document.body.appendChild(iframe);
  
        // 文件名来源：Chromium 打印 PDF 默认文件名取自【主窗口】(顶层 frame) title，
        // 而非 srcdoc 子 frame <title>。故 onload 临时覆盖主窗口 document.title 为 md 文件名，
        // 打印结束后还原（afterprint 或 watchdog 兜底）。同时显式写 contentDocument.title 兼容。
        const originalTitle = document.title;
        let titleRestored = false;
        const restoreTitle = () => {
          if (titleRestored) return;
          titleRestored = true;
          document.title = originalTitle;
        };
  
        // 两条清理路径（afterprint / 30s 兜底 watchdog）共用 cleanupIframe + cleaned 互斥标志，
        // 避免"iframe 已 remove 后再次读 contentWindow.removeEventListener"报 NPE。
        let cleaned = false;
        let finished = false;
        const cleanupIframe = () => {
          if (cleaned) return;
          cleaned = true;
          restoreTitle();
          if (iframe.contentWindow) {
            try { iframe.contentWindow.removeEventListener('afterprint', after); } catch (_) {}
          }
          if (iframe.parentNode) iframe.remove();
        };
        const finish = () => {
          if (finished) return;
          finished = true;
          clearTimeout(watchdog);
          cleanupIframe();
          hideOverlay();
        };
        const after = () => finish();
        // 30s 兜底：覆盖"用户在系统框里点取消 / afterprint 不触发"等异常路径，
        // 走完整收尾（清 iframe + 还原 title + 隐藏 overlay）。
        const watchdog = setTimeout(finish, 30000);
  
        iframe.onload = () => {
          if (iframe.contentDocument) iframe.contentDocument.title = escapedTitle;
          document.title = safeBaseName; // 主窗口 title 决定系统打印对话框默认文件名
          iframe.contentWindow.addEventListener('afterprint', after);
          iframe.contentWindow.print();
        };
      },
      getCachedImageURL(dataUri) {
        if (!dataUri || !dataUri.startsWith('data:')) return dataUri;
        const cached = this._imageURLCache.get(dataUri);
        if (cached) {
          // LRU 刷新：命中项移到队尾（Map 插入序），保证淘汰的是最久未用的
          this._imageURLCache.delete(dataUri);
          this._imageURLCache.set(dataUri, cached);
          return cached;
        }
        try {
          const comma = dataUri.indexOf(',');
          const meta = dataUri.slice(0, comma);
          const b64 = dataUri.slice(comma + 1);
          const mimeMatch = meta.match(/data:([^;]+)/);
          const mime = mimeMatch ? mimeMatch[1] : 'image/png';
          const bin = atob(b64);
          const len = bin.length;
          const bytes = new Uint8Array(len);
          for (let i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
          const blob = new Blob([bytes], { type: mime });
          const url = URL.createObjectURL(blob);
          this._imageURLCache.set(dataUri, url);
          // 记入"已创建但可能还没进 DOM"的保护集合（见 app.js 该字段的说明）。
          // 只在**构建预览 HTML 的窗口内**生效：否则测试/直接调用方会看到"永不淘汰"
          // （LRU 上限形同虚设 —— CI 的 image-url-cache 用例正是这么钉住的）。
          if (this._imageURLBuilding && this._imageURLPending) {
            if (this._imageURLPending.size > 1024) this._imageURLPending.clear();   // 兜底：异常路径下别无限增长
            this._imageURLPending.add(url);
          }
          // 容量上限：超限 revoke 最旧 Blob URL，防止长会话多图内存持续增长（历史 bug：只增不减）
          // 超限时向前找**第一条未被引用的**淘汰；**必须**确认该 Blob URL 不在文档中被
          // <img> 引用 —— 撤销在用 URL 会让正在显示的图片当场裂开（image-processor 早有
          // blobUrlInUse 护栏，这条热路径漏了同款判断）。
          // 注意：不能"只看最旧一条，在用就挪到队尾"——那样每次插入净增 1 条，缓存永不回落
          //（审计复核发现）。这里最多扫描 32 条，找到可淘汰的就停，避免 O(n²) 且保证有上界。
          if (this._imageURLCache.size > this._imageURLCacheMax) {
            const keys = Array.from(this._imageURLCache.keys());
            let scans = 0;
            for (const k of keys) {
              if (this._imageURLCache.size <= this._imageURLCacheMax) break;
              if (++scans > 32) break;
              const u = this._imageURLCache.get(k);
              // 构建期间刚创建、还没写进 DOM 的 URL 不淘汰（否则会撤销马上要显示的图片）
              if (this._imageURLBuilding && this._imageURLPending && this._imageURLPending.has(u)) continue;
              let inUse = false;
              try {
                inUse = !!(typeof document !== 'undefined' && document.querySelector('img[src="' + u + '"]'));
              } catch (_e) { inUse = false; }
              if (inUse) continue;                    // 在用：跳过，继续找下一条
              this._imageURLCache.delete(k);
              if (typeof URL !== 'undefined' && URL.revokeObjectURL) URL.revokeObjectURL(u);
            }
          }
          return url;
        } catch (e) {
          return dataUri;
        }
      },
  };

  const statics = {
      // 纯函数：计算 canvas/imageData 的裁剪边界（去除四周空白/透明/背景色）。
      // 返回 { x, y, w, h }；若全空返回 null。
      _computeTrimBounds(data, width, height, { backgroundColor = null, padding = 4, tolerance = 15 } = {}) {
        if (!data || width <= 0 || height <= 0) return null;
        const isEmpty = (idx) => {
          if (data[idx + 3] < 10) return true;
          if (!backgroundColor) return false;
          const dr = data[idx] - backgroundColor.r;
          const dg = data[idx + 1] - backgroundColor.g;
          const db = data[idx + 2] - backgroundColor.b;
          return Math.sqrt(dr * dr + dg * dg + db * db) <= tolerance;
        };
        let minX = width, minY = height, maxX = -1, maxY = -1;
        for (let y = 0; y < height; y++) {
          for (let x = 0; x < width; x++) {
            const idx = (y * width + x) * 4;
            if (!isEmpty(idx)) {
              if (x < minX) minX = x;
              if (y < minY) minY = y;
              if (x > maxX) maxX = x;
              if (y > maxY) maxY = y;
            }
          }
        }
        if (maxX < 0 || maxY < 0) return null;
        const x = Math.max(0, minX - padding);
        const y = Math.max(0, minY - padding);
        const w = Math.min(width - x, maxX - minX + 1 + padding * 2);
        const h = Math.min(height - y, maxY - minY + 1 + padding * 2);
        if (w <= 0 || h <= 0) return null;
        return { x, y, w, h };
      },
  };

  const api = { mixin, statics };
  window.TMExport = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
