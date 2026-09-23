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
  joule: 'J', watt: 'W', volt: 'V', coulomb: 'C', ohm: '\\Omega', siemens: 'S',
  farad: 'F', weber: 'Wb', tesla: 'T', henry: 'H', lumen: 'lm', lux: 'lx',
  becquerel: 'Bq', gray: 'Gy', sievert: 'Sv', katal: 'kat',
  liter: 'L', litre: 'L', tonne: 't', hectare: 'ha',
  secondpersquaremeter: 's/m^{2}',
  bar: 'bar', electronvolt: 'eV', dalton: 'Da', atomicmassunit: 'u',
  astronomicalunit: 'au', nauticalmile: 'M', knot: 'kn', angstrom: '\\mathring{A}',
  minute: 'min', hour: 'h', day: 'd', arcminute: '\\prime', arcsecond: '\\prime\\prime',
  degree: '^{\\circ}', percent: '\\%', rpm: 'rpm',
  // 2026-09 补齐：此前漏登记 → `\kWh` / `\decibel` 等会以未知宏形式残留，被 KaTeX 标红
  // （与 `\coulomb` 同一类问题；凡「拼写无前缀、无法由前缀+基本单位拆出」的单位都需在此登记）
  wh: 'Wh', watthour: 'Wh', kwh: 'kWh', kilowatthour: 'kWh',
  mwh: 'MWh', gwh: 'GWh', va: 'VA', voltampere: 'VA', kva: 'kVA', kilovoltampere: 'kVA',
  db: 'dB', decibel: 'dB', np: 'Np', neper: 'Np',
  // 2026-09 ⑤：按 siunitx 官方单位清单批量补齐。判据是「符号不能由 名字→符号 直推」——
  // 前缀+基本单位的组合本就能解析（`\kilo\metre` → km、`\milli\second` → ms），
  // 因此这里只登记**不可组合**的那批（历史符号、约定俗成的缩写、特殊符号）。
  parsec: 'pc', lightyear: 'ly', barn: 'b',
  atmosphere: 'atm', torr: 'Torr', mmhg: 'mmHg', millimetreofmercury: 'mmHg', psi: 'psi',
  dyne: 'dyn', erg: 'erg', calorie: 'cal', horsepower: 'hp',
  curie: 'Ci', poise: 'P', stokes: 'St', gauss: 'G', molar: 'M',
  bit: 'bit', byte: 'B', baud: 'Bd',
  fahrenheit: '^{\\circ}F', degreecelsius: '^{\\circ}C',
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
  let pending = '';        // 待拼接的前缀（\kilo 等）
  let pendingExp = '';     // 待拼接的指数（\square / \cubic，作用于**紧随其后的单位**）
  let lastWasUnit = false; // 上一个原子是否为单位 → 相邻单位之间补细空格（siunitx 惯例）
  const flush = () => { if (pending) { out += pending; pending = ''; } };
  // 单位原子落地：前缀 + 符号 + 指数；相邻单位补 `\,`（\kilogram\metre → kg\,m，而非 kgm）
  const emitUnit = (sym) => {
    if (lastWasUnit) out += '\\,';
    out += pending + sym + pendingExp;
    pending = '';
    pendingExp = '';
    lastWasUnit = true;
  };
  while (i < s.length) {
    const c = s[i];
    if (c === '\\') {
      const m = s.slice(i).match(/^\\([A-Za-z]+)/);
      if (!m) { i++; continue; }
      const name = m[1];
      const lower = name.toLowerCase();
      i += m[0].length;
      if (lower === 'per') { flush(); out += '/'; lastWasUnit = false; continue; }
      if (lower === 'squared') { out += '^{2}'; continue; }
      if (lower === 'cubed') { out += '^{3}'; continue; }
      // \square\metre → m^{2} / \cubic\metre → m^{3}：**前置于单位**，指数要落到单位之后
      if (lower === 'square') { pendingExp = '^{2}'; continue; }
      if (lower === 'cubic') { pendingExp = '^{3}'; continue; }
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
        emitUnit(SI_UNIT[lower]);
        continue;
      }
      if (Object.prototype.hasOwnProperty.call(SI_SHORTHAND, name)) {
        emitUnit(SI_SHORTHAND[name]);
        continue;
      }
      // 未知宏：原样保留（交由 KaTeX 降级显示，不静默丢弃）
      flush();
      out += '\\' + name;
      lastWasUnit = false;
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

// ---- siunitx 命令展开 ----
// 为什么不用一串正则：原实现的参数匹配是 `\{([^{}]*)\}`，**遇到花括号嵌套就整条不匹配**，
// 于是 `\si{\metre\tothe{3}}`、`\SI{1}{\frac{a}{b}}` 这类会原样留给 KaTeX → 报未知命令（红字）。
// 改为**配对花括号扫描**：天然支持嵌套，同时顺带支持 `\SI*` 与 `[选项]`（选项内也可含 {}）。

// 数值乘积（\qtyproduct）：`2 x 3` / `2×3` → `2\times3`。
// 注意分隔符必须"独立成词"：不能把 `2 \times 3` 里的 `x` 当分隔符（那会切碎 \times）。
const SI_PRODUCT_SEP = /\s*×\s*|(?<=\d)\s*[xX]\s*(?=\d)/;
function siFormatProduct(raw) {
  return String(raw == null ? '' : raw)
    .split(SI_PRODUCT_SEP)
    .map((x) => formatSiNumber(String(x).trim()))
    .filter((x) => x !== '')
    .join('\\times');
}

// 复数（\complexnum）：仅把虚数单位改为正体 `\mathrm{i}` / `\mathrm{j}`，数值原样（不做舍入）
function siFormatComplex(raw) {
  return String(raw == null ? '' : raw).trim().replace(/([ij])\s*$/, (m, u) => '\\mathrm{' + u + '}');
}

// 单位列表（\unitlist）：`\metre;\second` → 同一个 \mathrm 内以 `,\;` 分隔
function siFormatUnitList(raw) {
  const items = String(raw == null ? '' : raw)
    .split(';')
    .map((x) => expandSiUnit(String(x).trim()))
    .filter((x) => x !== '');
  return items.length ? '\\,\\mathrm{' + items.join(',\\;') + '}' : '';
}

const SI_COMMANDS = {
  SI: { args: ['num', 'unit'] },
  qty: { args: ['num', 'unit'] },
  SIrange: { args: ['num', 'num', 'unit'], join: 'range' },
  qtyrange: { args: ['num', 'num', 'unit'], join: 'range' },
  SIlist: { args: ['list', 'unit'] },
  qtylist: { args: ['list', 'unit'] },
  si: { args: ['unit'] },
  unit: { args: ['unit'] },
  num: { args: ['num'] },
  ang: { args: ['ang'] },
  // 2026-09 补齐（此前未实现 → 原样留给 KaTeX → 红字）
  numrange: { args: ['num', 'num'], join: 'range' },
  numlist: { args: ['list'] },
  unitlist: { args: ['unitlist'] },
  complexnum: { args: ['complex'] },
  qtyproduct: { args: ['product', 'unit'] },
  // \sisetup{…}：全局配置。本兼容层是**无状态纯函数**（每个公式独立、跨公式不共享状态），
  // 无法持久化全局配置，故**安全吞掉**（消除"未知命令"红字），其语义不生效。
  // 大小写两种写法都吞（siunitx 只提供小写，但用户常写错）。
  sisetup: { args: ['raw'], drop: true },
  SIsetup: { args: ['raw'], drop: true },
};

// 取一个配对参数 {…}；不是参数或括号不配对时返回 null
function readBracedArg(s, i) {
  let j = i;
  while (j < s.length && /\s/.test(s[j])) j++;
  if (s[j] !== '{') return null;
  const end = findMatchingBrace(s, j);
  if (end < 0) return null;
  return { value: s.slice(j + 1, end), next: end + 1 };
}

// 跳过 [选项]（选项内可能含 {}，如 list-final-separator={, }）；没有选项则原样返回 i
function skipSiOption(s, i) {
  let j = i;
  while (j < s.length && /\s/.test(s[j])) j++;
  if (s[j] !== '[') return i;
  let depth = 0;
  for (; j < s.length; j++) {
    if (s[j] === '{') { const e = findMatchingBrace(s, j); if (e < 0) return i; j = e; continue; }
    if (s[j] === '[') depth++;
    else if (s[j] === ']') { depth--; if (depth === 0) return j + 1; }
  }
  return i;
}

function renderSiCommand(name, args) {
  const spec = SI_COMMANDS[name];
  const parts = spec.args.map((kind, k) => {
    const a = args[k] == null ? '' : args[k];
    if (kind === 'raw') return '';
    if (kind === 'num') return formatSiNumber(a);
    if (kind === 'list') return siFormatList(a);
    if (kind === 'product') return siFormatProduct(a);
    if (kind === 'complex') return siFormatComplex(a);
    if (kind === 'unitlist') return siFormatUnitList(a);
    if (kind === 'ang') {
      const marks = ['^{\\circ}', '^{\\prime}', '^{\\prime\\prime}'];
      return String(a).split(';').map((p, idx) => String(p).trim() + (marks[idx] || '')).join('');
    }
    return siWrapUnit(expandSiUnit(a));
  });
  if (spec.join === 'range') return parts[0] + '\\text{--}' + parts[1] + (parts[2] || '');
  return parts.join('');
}

// 逐字符扫描展开（仅在数学块内调用）。未知命令一律原样保留，交由 KaTeX 降级显示。
function expandSiunitx(tex) {
  if (!tex || tex.indexOf('\\') === -1) return tex;
  const s = String(tex);
  let out = '';
  let i = 0;
  while (i < s.length) {
    if (s[i] !== '\\') { out += s[i]; i++; continue; }
    const m = /^\\([A-Za-z]+)\*?/.exec(s.slice(i));
    if (!m || !Object.prototype.hasOwnProperty.call(SI_COMMANDS, m[1])) {
      out += m ? m[0] : '\\';
      i += m ? m[0].length : 1;
      continue;
    }
    const name = m[1];
    const spec = SI_COMMANDS[name];
    let j = skipSiOption(s, i + m[0].length);
    const args = [];
    let ok = true;
    for (let k = 0; k < spec.args.length; k++) {
      const arg = readBracedArg(s, j);
      if (!arg) { ok = false; break; }
      args.push(arg.value);
      j = arg.next;
    }
    if (!ok) { out += m[0]; i += m[0].length; continue; } // 参数不全 → 原样保留，不猜
    if (spec.drop) { i = j; continue; }                    // 吞掉（\sisetup）
    out += renderSiCommand(name, args);
    i = j;
  }
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
