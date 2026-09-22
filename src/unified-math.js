// ============================================================
// unified-math —— 数学渲染增强的**纯函数**模块（无外部依赖）
// ------------------------------------------------------------
// 从 unified-renderer.js 抽出，理由有二：
//   1) 可被 node 直接 require 做单测（渲染器本体 require 了 unified/remark 等
//      数十个包，测试环境必须装齐依赖；本模块零依赖，单测无门槛）；
//   2) 数学增强与 Markdown 主渲染管线职责分离，便于独立演进。
//
// 提供：
//   - siunitx 兼容层：\SI / \qty / \si / \unit / \num / \ang / \SIrange
//   - 公式自动编号：\label / \tag / \notag 与 \eqref / \ref 交叉引用
// ============================================================
'use strict';

// ============================================================
// siunitx 兼容层
// ------------------------------------------------------------
// KaTeX 不提供 siunitx 包，故在此实现常用子集：把 \SI / \qty / \si / \unit / \num /
// \ang / \SIrange 展开为 KaTeX 原生可渲染的 TeX。
// 设计要点：单位整体包进一个 \mathrm{}（而非逐单位包裹），这样 \per 产生的 `/` 与
// \squared 产生的上标都保持正体，形如 \mathrm{m/s^{2}}，符合物理排版惯例。
// 未知宏**原样保留**，交给 KaTeX（throwOnError:false）降级显示，不静默丢弃。
// ============================================================

// 十进倍数前缀（值直接拼到单位符号前）
const SI_PREFIX = {
  quecto: 'q', ronto: 'r', yocto: 'y', zepto: 'z', atto: 'a', femto: 'f',
  pico: 'p', nano: 'n', micro: '\\mu ', milli: 'm', centi: 'c', deci: 'd',
  deca: 'da', deka: 'da', hecto: 'h', kilo: 'k', mega: 'M', giga: 'G',
  tera: 'T', peta: 'P', exa: 'E', zetta: 'Z', yotta: 'Y', ronna: 'R', quetta: 'Q',
};

// 单位宏（键为小写宏名）
const SI_UNIT = {
  meter: 'm', metre: 'm', second: 's', ampere: 'A', kelvin: 'K',
  mole: 'mol', candela: 'cd', gram: 'g', gramme: 'g', kilogram: 'kg',
  radian: 'rad', steradian: 'sr', hertz: 'Hz', newton: 'N', pascal: 'Pa',
  joule: 'J', watt: 'W', volt: 'V', ohm: '\\Omega', siemens: 'S',
  farad: 'F', weber: 'Wb', tesla: 'T', henry: 'H', lumen: 'lm', lux: 'lx',
  becquerel: 'Bq', gray: 'Gy', sievert: 'Sv', katal: 'kat',
  liter: 'L', litre: 'L', tonne: 't', hectare: 'ha',
  secondpersquaremeter: 's/m^{2}',
  bar: 'bar', electronvolt: 'eV', dalton: 'Da', atomicmassunit: 'u',
  astronomicalunit: 'au', nauticalmile: 'M', knot: 'kn', angstrom: '\\mathring{A}',
  minute: 'min', hour: 'h', day: 'd', arcminute: '\\prime', arcsecond: '\\prime\\prime',
  degree: '^{\\circ}', percent: '\\%', rpm: 'rpm',
};

// siunitx v2 风格的单位简写（区分大小写，与规范符号一致）
const SI_SHORTHAND = {
  km: 'km', cm: 'cm', mm: 'mm', um: '\\mu m', nm: 'nm', pm: 'pm', fm: 'fm',
  ms: 'ms', us: '\\mu s', ns: 'ns', ps: 'ps',
  kg: 'kg', mg: 'mg', ug: '\\mu g', t: 't',
  mA: 'mA', uA: '\\mu A', kA: 'kA',
  kV: 'kV', mV: 'mV', MV: 'MV', uV: '\\mu V',
  kW: 'kW', MW: 'MW', GW: 'GW', mW: 'mW',
  Hz: 'Hz', kHz: 'kHz', MHz: 'MHz', GHz: 'GHz', THz: 'THz',
  Pa: 'Pa', kPa: 'kPa', MPa: 'MPa', GPa: 'GPa', hPa: 'hPa',
  kN: 'kN', MN: 'MN', kJ: 'kJ', MJ: 'MJ', mJ: 'mJ',
  L: 'L', mL: 'mL', dL: 'dL', cL: 'cL', uL: '\\mu L',
  Np: 'Np', dB: 'dB', Bq: 'Bq', Gy: 'Gy', Sv: 'Sv', kat: 'kat',
  eV: 'eV', keV: 'keV', MeV: 'MeV', GeV: 'GeV', TeV: 'TeV',
  mol: 'mol', mmol: 'mmol', kmol: 'kmol', bar: 'bar', mbar: 'mbar',
  degC: '^{\\circ}\\mathrm{C}', rpm: 'rpm', kn: 'kn',
};

// 找到 openIdx 处 `{` 的配对 `}` 下标（不支持嵌套转义）
function findMatchingBrace(s, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < s.length; i++) {
    if (s[i] === '{') depth++;
    else if (s[i] === '}') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

// siunitx 数字格式化：千分位细空格 + 科学计数法
function formatSiNumber(raw) {
  const v = String(raw == null ? '' : raw).trim();
  if (!v) return '';
  const em = v.match(/^([\d.,]+)\s*[eE]([+-]?\d+)$/);
  if (em) return formatSiNumber(em[1]) + '\\times 10^{' + parseInt(em[2], 10) + '}';
  const nm = v.match(/^(\d{4,})(\.\d+)?$/);
  if (nm) {
    const grouped = nm[1].replace(/\B(?=(\d{3})+(?!\d))/g, '\\,');
    return grouped + (nm[2] || '');
  }
  return v;
}

// 单位串 → 正体单位体（不加 \mathrm，由调用方统一包裹）
function expandSiUnit(raw) {
  const s = String(raw == null ? '' : raw);
  let out = '';
  let i = 0;
  let pending = '';
  const flush = () => { if (pending) { out += pending; pending = ''; } };
  while (i < s.length) {
    const c = s[i];
    if (c === '\\') {
      const m = s.slice(i).match(/^\\([A-Za-z]+)/);
      if (!m) { i++; continue; }
      const name = m[1];
      const lower = name.toLowerCase();
      i += m[0].length;
      if (lower === 'per') { flush(); out += '/'; continue; }
      if (lower === 'squared') { out += '^{2}'; continue; }
      if (lower === 'cubed') { out += '^{3}'; continue; }
      if (lower === 'tothe' || lower === 'raiseto') {
        const bm = s.slice(i).match(/^\s*\{([^{}]*)\}/);
        if (bm) { out += '^{' + bm[1] + '}'; i += bm[0].length; }
        continue;
      }
      if (lower === 'degree') { out += '^{\\circ}'; continue; }
      if (lower === 'celsius') { out += '^{\\circ}C'; continue; }
      if (lower === 'percent') { out += '\\%'; continue; }
      if (lower === 'of' || lower === 'highlight' || lower === 'cancel') continue;
      if (Object.prototype.hasOwnProperty.call(SI_PREFIX, lower)) {
        flush();
        pending = SI_PREFIX[lower];
        continue;
      }
      if (Object.prototype.hasOwnProperty.call(SI_UNIT, lower)) {
        out += pending + SI_UNIT[lower];
        pending = '';
        continue;
      }
      if (Object.prototype.hasOwnProperty.call(SI_SHORTHAND, name)) {
        out += pending + SI_SHORTHAND[name];
        pending = '';
        continue;
      }
      // 未知宏：原样保留
      flush();
      out += '\\' + name;
      continue;
    }
    if (c === '{') {
      const e = findMatchingBrace(s, i);
      i = e > i ? e + 1 : i + 1;
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i++; continue; }
    if (c === '^' || c === '_') { flush(); out += c; i++; continue; }
    flush();
    if (c === '%') out += '\\%';
    else if (c === '&') out += '\\&';
    else if (c === '#') out += '\\#';
    else if (c === '~') out += '\\sim';
    else out += c;
    i++;
  }
  flush();
  return out.trim();
}

// 单位体包裹：为空则不产生任何输出
function siWrapUnit(body) {
  const t = String(body || '').trim();
  return t ? '\\,\\mathrm{' + t + '}' : '';
}

// siunitx 数值列表：`1;2;3` / `1,2,3` → `1,\;2,\;3`
// （数学模式会忽略普通空格，故用 `\;` 而非 ' '，否则分隔在渲染后看不出来）
function siFormatList(raw) {
  return String(raw == null ? '' : raw)
    .split(/[;,]/)
    .map((x) => formatSiNumber(String(x).trim()))
    .filter((x) => x !== '')
    .join(',\\;');
}

// siunitx 命令展开（仅在数学块内调用）
function expandSiunitx(tex) {
  if (!tex || tex.indexOf('\\') === -1) return tex;
  let out = String(tex);
  // \SIrange / \qtyrange {a}{b}{unit}（先处理带选项形式，再处理无选项形式）
  out = out.replace(/\\(?:SIrange|qtyrange)\s*\[[^\]]*\]\s*\{([^{}]*)\}\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g,
    (m, a, b, u) => formatSiNumber(a) + '\\text{--}' + formatSiNumber(b) + siWrapUnit(expandSiUnit(u)));
  out = out.replace(/\\(?:SIrange|qtyrange)\*?\s*\{([^{}]*)\}\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g,
    (m, a, b, u) => formatSiNumber(a) + '\\text{--}' + formatSiNumber(b) + siWrapUnit(expandSiUnit(u)));
  // \SIlist / \qtylist {a;b;c}{unit}（数值列表；分号或逗号分隔）
  out = out.replace(/\\(?:SIlist|qtylist)\s*\[[^\]]*\]\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g,
    (m, vals, u) => siFormatList(vals) + siWrapUnit(expandSiUnit(u)));
  out = out.replace(/\\(?:SIlist|qtylist)\*?\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g,
    (m, vals, u) => siFormatList(vals) + siWrapUnit(expandSiUnit(u)));
  // \SI / \qty {value}{unit}
  out = out.replace(/\\(?:SI|qty)\s*\[[^\]]*\]\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g,
    (m, a, u) => formatSiNumber(a) + siWrapUnit(expandSiUnit(u)));
  // \SI* / \qty* 无选项形式
  out = out.replace(/\\(?:SI|qty)\*?\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g,
    (m, a, u) => formatSiNumber(a) + siWrapUnit(expandSiUnit(u)));
  // \si / \unit {unit}
  out = out.replace(/\\(?:si|unit)\s*\[[^\]]*\]\s*\{([^{}]*)\}/g,
    (m, u) => siWrapUnit(expandSiUnit(u)));
  out = out.replace(/\\(?:si|unit)\*?\s*\{([^{}]*)\}/g,
    (m, u) => siWrapUnit(expandSiUnit(u)));
  // \ang{12;30;0} → 12^\circ30^\prime0^\prime\prime（分号分隔度分秒）
  out = out.replace(/\\ang\s*\{([^{}]*)\}/g, (m, v) => {
    const parts = String(v).split(';');
    const marks = ['^{\\circ}', '^{\\prime}', '^{\\prime\\prime}'];
    return parts.map((p, idx) => String(p).trim() + (marks[idx] || '')).join('');
  });
  // \num{...}
  out = out.replace(/\\num\s*\[[^\]]*\]\s*\{([^{}]*)\}/g, (m, v) => formatSiNumber(v));
  out = out.replace(/\\num\s*\{([^{}]*)\}/g, (m, v) => formatSiNumber(v));
  return out;
}

// ============================================================
// 公式自动编号（\label / \eqref / \ref / \tag / \notag）
// ------------------------------------------------------------
// 规则（与 LaTeX 习惯一致，且对既有文档零破坏）：
//   - 只有**写了 \label{}** 的块级公式才自动编号；未写 label 的公式保持原样。
//   - 用户自带 \tag{} 时尊重自定义编号，不覆盖。
//   - \notag / \nonumber 显式关闭编号。
//   - \eqref{x} → 可点击的 (n)（经 \href + KaTeX trust 白名单）；
//     \ref{x} → 可点击的 n；标签不存在时渲染为 (?)。
// 编号按文档顺序、跨全文连续。
// ============================================================

function assignEquationNumbers(placeholders) {
  const labels = new Map();
  let counter = 0;
  for (const ph of placeholders) {
    const found = [];
    // \label 从**所有**数学块剥离（行内数学里的 \label 无意义，留着只会让 KaTeX 报未知命令）
    ph.text = String(ph.text).replace(/\\label\s*\{([^{}]*)\}/g, (m, name) => {
      const key = String(name).trim();
      if (key) found.push(key);
      return '';
    });
    const noNumber = /\\notag\b|\\nonumber\b/.test(ph.text);
    if (noNumber) ph.text = ph.text.replace(/\\notag\b|\\nonumber\b/g, '');
    // 只有块级公式参与自动编号
    if (!ph.display) continue;
    const hasTag = /\\tag\*?\s*\{/.test(ph.text);
    if (found.length === 0 || noNumber || hasTag) continue;
    counter += 1;
    ph.eqNumber = counter;
    for (const k of found) if (!labels.has(k)) labels.set(k, counter);
  }
  return labels;
}

function eqrefHtml(name, labels, parens) {
  const key = String(name == null ? '' : name).trim();
  const n = labels.get(key);
  if (!n) return '\\text{?}';
  const body = '\\text{' + n + '}';
  const shown = parens ? '(' + body + ')' : body;
  return '\\href{\\#eq-' + n + '}{' + shown + '}';
}

function expandEqref(tex, labels) {
  if (!tex || (tex.indexOf('\\eqref') === -1 && tex.indexOf('\\ref') === -1)) return tex;
  let out = String(tex).replace(/\\eqref\s*\{([^{}]*)\}/g, (m, name) => eqrefHtml(name, labels, true));
  out = out.replace(/(^|[^A-Za-z\\])\\ref\s*\{([^{}]*)\}/g,
    (m, pre, name) => pre + eqrefHtml(name, labels, false));
  return out;
}

// 正文（非数学）中的 \eqref / \ref。
// 为什么需要单独一趟：KaTeX 的 delimiters 只认 $...$，写在正文里的 `\eqref{eq:x}`
// 根本进不了数学占位符，于是原样显示成反斜杠命令（最典型的写法就是
// 「由式 \eqref{eq:a} 可知…」）。本趟在**已还原的 HTML** 上做替换，
// 跳过 <pre>/<code> 以免误改代码块里的示例文本；输出普通 HTML 链接，
// 不依赖 KaTeX 的 trust 白名单（也就无需 \href）。
function expandProseEqref(html, labels) {
  if (!html || html.indexOf('\\') === -1) return html;
  const map = labels || new Map();
  const link = (name, parens) => {
    const key = String(name == null ? '' : name).trim();
    const n = map.get(key);
    if (!n) return '<span class="eq-ref-missing">' + (parens ? '(?)' : '?') + '</span>';
    const shown = parens ? '(' + n + ')' : String(n);
    return '<a class="eq-ref" href="#eq-' + n + '">' + shown + '</a>';
  };
  const expand = (seg) => String(seg)
    .replace(/\\eqref\s*\{([^{}]*)\}/g, (m, name) => link(name, true))
    .replace(/(^|[^A-Za-z\\])\\ref\s*\{([^{}]*)\}/g, (m, pre, name) => pre + link(name, false));
  // 以 <pre>/<code> 为界分段，命中片段原样保留
  return String(html)
    .split(/(<pre[\s\S]*?<\/pre>|<code[\s\S]*?<\/code>)/g)
    .map((seg) => (/^<(?:pre|code)\b/i.test(seg) ? seg : expand(seg)))
    .join('');
}

// 把 \tag{n} 插到块级公式闭合 $$ 之前（用户已写 \tag 时不插入）
function insertEquationTag(tex, n) {
  if (!n) return tex;
  const s = String(tex);
  if (/\\tag\*?\s*\{/.test(s)) return s;
  const idx = s.lastIndexOf('$$');
  if (idx > 0) return s.slice(0, idx) + '\\tag{' + n + '}' + s.slice(idx);
  return s + '\\tag{' + n + '}';
}


module.exports = {
  expandSiunitx,
  expandSiUnit,
  formatSiNumber,
  siFormatList,
  assignEquationNumbers,
  expandEqref,
  expandProseEqref,
  insertEquationTag,
};
