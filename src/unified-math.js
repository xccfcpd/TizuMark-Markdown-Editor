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
    // 空白与 `.` 是 siunitx 的"单位连接符"：相邻单位之间要补细空格（`kg m` → `kg\,m`）。
    // 旧实现直接把空格丢掉 → `kg m` 变成 `kgm`（= 毫秒，语义完全变了；审计发现，2026-09-24）。
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '.') {
      if (lastWasUnit) out += '\\,';
      lastWasUnit = false;
      i++;
      continue;
    }
    // siunitx 的 `//` 表示"每"（`kJ//mol` → `kJ/mol`）；`*` 表示乘（→ `\cdot`）
    if (c === '/' && s[i + 1] === '/') { flush(); out += '/'; lastWasUnit = false; i += 2; continue; }
    if (c === '*') { flush(); out += '\\cdot '; lastWasUnit = false; i++; continue; }
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
// 公式自动编号（\label / \eqref / \ref / \cref / \Cref / \autoref / \tag / \notag）
// ------------------------------------------------------------
// 规则（与 LaTeX 语义对齐，且对既有文档零破坏）：
//   - 只有**写了 \label{}** 的块级公式才自动编号；未写 label 的公式保持原样。
//   - 用户自带 \tag{} 时尊重自定义编号：**不占自动流水号，但 label 仍注册** ——
//     于是 `\tag{3'}\label{eq:a}` 之后 `\eqref{eq:a}` 能显示 (3')（LaTeX 语义）。
//   - \notag / \nonumber 关闭编号（该式的 \label 随之失效，与 LaTeX 一致）。
//   - 引用：\eqref{x} → 可点击 (n)；\ref{x} → 可点击 n；\cref{a,b,c} → (1, 2)，
//     连续 ≥3 压成 (1)–(3)；\Cref / \autoref 带类型词（公式 (1) / Equation (1)）；
//     标签不存在 → (?) 并记入 warnings。
//   - 锚点：自动编号 → `eq-N`；自定义 \tag → `eql-<slug>`。分两个命名空间，
//     避免 tag 文本（如 "3'"）与自动序号（3）撞 id。
// 编号按文档顺序、跨全文连续。
// labels.warnings：未定义引用 / 重复 label / 无效 \label（供界面提示，见 unified-renderer）
// ============================================================

// 锚点 id：自动编号（1 / 2.1）走 eq-，自定义 \tag 文本走 eql-<slug>
function equationAnchor(value) {
  if (value == null) return '';
  const s = String(value).trim();
  // 纯数字与章节号（2.1）都属自动编号 → 同一命名空间，
  // 这样"锚点"与"引用链接"两侧用同一函数推导，永远不会失配。
  if (typeof value === 'number' || /^\d+(?:\.\d+)*$/.test(s)) return 'eq-' + s;
  const slug = s.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return 'eql-' + (slug || 'tag');
}

// 收集诊断（同一 label + 同一类型只记一次）
function pushWarning(labels, type, label, detail) {
  if (!labels || !Array.isArray(labels.warnings)) return;
  const key = type + '|' + label;
  for (let i = 0; i < labels.warnings.length; i++) if (labels.warnings[i].key === key) return;
  labels.warnings.push({ key: key, type: type, label: label, detail: detail || '' });
}

// options.sectionAt(line) —— 可选：返回该行所属的**章节号**（如 '2'），启用章节级编号（2.1）。
// 公式序号在章节内重置，因此引用不会歧义；取不到章节（首个标题之前）时回退全局流水号。
function assignEquationNumbers(placeholders, options) {
  const opts = options || {};
  const sectionAt = typeof opts.sectionAt === 'function' ? opts.sectionAt : null;
  const labels = new Map();
  labels.warnings = [];
  let counter = 0;
  let lastSection = null;
  let sectionCounter = 0;
  const register = (key, value) => {
    if (labels.has(key)) {
      pushWarning(labels, 'duplicate-label', key, '重复定义，保留首次出现的 ' + labels.get(key));
      return;
    }
    labels.set(key, value);
  };
  for (const ph of placeholders) {
    const found = [];
    // \label 从**所有**数学块剥离（行内数学里的 \label 无意义，留着只会让 KaTeX 报未知命令）
    ph.text = String(ph.text).replace(/\\label\s*\{([^{}]*)\}/g, (m, name) => {
      const key = String(name).trim();
      if (key) found.push(key);
      return '';
    });
    // 用户自带 `\tag`：即使没有 `\label` 也必须**占用编号**。否则紧随其后的自动编号会与它撞号
    // （同页出现两个 (1)，且 \eqref 指向的号与视觉不符 —— 审计发现，2026-09-24）。
    // 数字型 tag 直接抬高流水号；非数字（如 \tag{$\ast$}）无法参与流水，保持原样。
    if (!sectionAt) {
      const tagOnly = /\\tag\*?\s*\{([^{}]*)\}/.exec(ph.text);
      if (tagOnly) {
        const shown = String(tagOnly[1]).trim();
        if (/^\d+$/.test(shown)) {
          const n = parseInt(shown, 10);
          if (n > counter) counter = n;
        }
      }
    }
    const noNumber = /\\notag\b|\\nonumber\b/.test(ph.text);
    if (noNumber) ph.text = ph.text.replace(/\\notag\b|\\nonumber\b/g, '');
    if (found.length === 0) continue;
    // 行内数学不参与编号（LaTeX 同理），其 \label 无效
    if (!ph.display) {
      pushWarning(labels, 'inline-label', found[0], '行内公式的 \\label 被忽略（仅块级公式参与编号）');
      continue;
    }
    if (noNumber) {
      pushWarning(labels, 'notag-label', found[0], '\\notag 关闭了编号，该 \\label 无法被引用');
      continue;
    }
    // 用户自带 \tag：不占自动流水号，但注册 label（引用显示用户写的编号）
    const tagMatch = /\\tag\*?\s*\{([^{}]*)\}/.exec(ph.text);
    if (tagMatch) {
      const shown = String(tagMatch[1]).trim();
      if (shown) {
        ph.eqTag = shown;
        ph.eqLabelName = found[0];
        ph.eqAnchor = equationAnchor(shown);
        for (const k of found) register(k, shown);
      }
      continue;
    }
    counter += 1;
    let shown = counter;
    if (sectionAt) {
      const sec = sectionAt(ph.line);
      if (sec) {
        if (sec !== lastSection) { lastSection = sec; sectionCounter = 0; }
        sectionCounter += 1;
        shown = sec + '.' + sectionCounter;
      }
    }
    ph.eqNumber = shown;
    ph.eqAnchor = equationAnchor(shown);
    ph.eqLabelName = found[0];
    for (const k of found) register(k, shown);
  }
  return labels;
}

// ---- 数学侧引用（KaTeX 片段，依赖 trust 只放行 # 锚点）----

function eqrefOne(name, labels, mode) {
  const key = String(name == null ? '' : name).trim();
  const v = labels.get(key);
  if (v == null) {
    pushWarning(labels, 'undefined-ref', key, '未定义的标签');
    return '\\text{?}';
  }
  const body = '\\text{' + v + '}';
  const shown = mode === 'ref' ? body : '(' + body + ')';
  return '\\href{\\#' + equationAnchor(v) + '}{' + shown + '}';
}

// 编号列表压缩："1,2,3" → "1–3"；含自定义 tag 文本时不压缩
function compactNumbers(values) {
  if (!values.length) return '';
  if (!values.every((v) => typeof v === 'number')) return values.join(', ');
  const nums = values.slice().sort((a, b) => a - b);
  const out = [];
  let i = 0;
  while (i < nums.length) {
    let j = i;
    while (j + 1 < nums.length && nums[j + 1] === nums[j] + 1) j++;
    if (j - i >= 2) out.push(nums[i] + '\u2013' + nums[j]);
    else for (let k = i; k <= j; k++) out.push(String(nums[k]));
    i = j + 1;
  }
  return out.join(', ');
}

function refWord(lang, count) {
  if (lang === 'en') return count > 1 ? 'Equations' : 'Equation';
  return '公式';
}

function expandEqref(tex, labels, opts) {
  if (!tex || (tex.indexOf('\\eqref') === -1 && tex.indexOf('\\ref') === -1 &&
    tex.indexOf('\\cref') === -1 && tex.indexOf('\\Cref') === -1 && tex.indexOf('\\autoref') === -1)) {
    return tex;
  }
  const map = labels || new Map();
  const lang = (opts && opts.lang) === 'en' ? 'en' : 'zh';
  let out = String(tex);
  // \cref / \Cref：合并多标签，可带类型词
  out = out.replace(/\\(Cref|cref)\s*\{([^{}]*)\}/g, (m, cmd, list) => {
    const names = String(list).split(',').map((s) => s.trim()).filter(Boolean);
    if (!names.length) return m;
    const vals = [];
    for (const n of names) {
      const v = map.get(n);
      if (v == null) { pushWarning(map, 'undefined-ref', n, '未定义的标签'); continue; }
      vals.push(v);
    }
    if (!vals.length) return '\\text{?}';
    const body = compactNumbers(vals);
    const word = (cmd === 'Cref' || lang !== 'en') ? refWord(lang, vals.length) + ' ' : '';
    return '\\text{' + word + '(' + body + ')}';
  });
  // \autoref：类型词 + 可点击编号
  out = out.replace(/\\autoref\s*\{([^{}]*)\}/g, (m, name) => {
    const key = String(name).trim();
    const v = map.get(key);
    if (v == null) {
      pushWarning(map, 'undefined-ref', key, '未定义的标签');
      return '\\text{?}';
    }
    return '\\text{' + refWord(lang, 1) + '}~\\href{\\#' + equationAnchor(v) + '}{\\text{' + v + '}}';
  });
  out = out.replace(/\\eqref\s*\{([^{}]*)\}/g, (m, name) => eqrefOne(name, map, 'eqref'));
  out = out.replace(/(^|[^A-Za-z\\])\\ref\s*\{([^{}]*)\}/g,
    (m, pre, name) => pre + eqrefOne(name, map, 'ref'));
  return out;
}

// ---- 正文侧引用（已还原的 HTML；不依赖 KaTeX trust）----

function escapeAttr(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/"/g, '&quot;')
    .replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// 正文（非数学）中的 \eqref / \ref / \cref / \autoref。
// 为什么需要单独一趟：KaTeX 的 delimiters 只认 $...$，写在正文里的 `\eqref{eq:x}`
// 根本进不了数学占位符，于是原样显示成反斜杠命令（最典型的写法就是
// 「由式 \eqref{eq:a} 可知…」）。本趟在**已还原的 HTML** 上做替换，
// 跳过 <pre>/<code> 以免误改代码块里的示例文本。
function expandProseEqref(html, labels, opts) {
  if (!html || html.indexOf('\\') === -1) return html;
  const map = labels || new Map();
  const lang = (opts && opts.lang) === 'en' ? 'en' : 'zh';
  const missing = (key, parens) =>
    '<span class="eq-ref-missing" title="' + escapeAttr('未定义的标签：' + key) + '">' +
    (parens ? '(?)' : '?') + '</span>';
  // 已知编号 → 链接（parens=true 时含括号）
  const linkValue = (v, parens) =>
    '<a class="eq-ref" href="#' + equationAnchor(v) + '">' + (parens ? '(' + v + ')' : String(v)) + '</a>';
  const link = (name, parens) => {
    const key = String(name == null ? '' : name).trim();
    const v = map.get(key);
    if (v == null) {
      pushWarning(map, 'undefined-ref', key, '未定义的标签');
      return missing(key, parens);
    }
    return linkValue(v, parens);
  };
  const expand = (seg) => String(seg)
    // \cref / \Cref：多标签，各自成链，连续 ≥3 用 en dash
    .replace(/\\(Cref|cref)\s*\{([^{}]*)\}/g, (m, cmd, list) => {
      const names = String(list).split(',').map((s) => s.trim()).filter(Boolean);
      if (!names.length) return m;
      const known = [];
      for (const n of names) {
        const v = map.get(n);
        if (v == null) { pushWarning(map, 'undefined-ref', n, '未定义的标签'); continue; }
        known.push(v);
      }
      if (!known.length) return missing(names[0], true);
      let body;
      if (known.every((v) => typeof v === 'number')) {
        const nums = known.slice().sort((a, b) => a - b);
        const groups = [];
        let i = 0;
        while (i < nums.length) {
          let j = i;
          while (j + 1 < nums.length && nums[j + 1] === nums[j] + 1) j++;
          if (j - i >= 2) groups.push(linkValue(nums[i], false) + '\u2013' + linkValue(nums[j], false));
          else for (let k = i; k <= j; k++) groups.push(linkValue(nums[k], false));
          i = j + 1;
        }
        body = groups.join(', ');
      } else {
        body = known.map((v) => linkValue(v, false)).join(', ');
      }
      const word = (cmd === 'Cref' || lang !== 'en') ? refWord(lang, known.length) + ' ' : '';
      return '<span class="eq-ref-group">' + word + '(' + body + ')</span>';
    })
    .replace(/\\autoref\s*\{([^{}]*)\}/g, (m, name) => {
      const key = String(name).trim();
      const v = map.get(key);
      if (v == null) {
        pushWarning(map, 'undefined-ref', key, '未定义的标签');
        return missing(key, false);
      }
      return '<span class="eq-autoref">' + refWord(lang, 1) + ' ' + linkValue(v, false) + '</span>';
    })
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


// 章节编号解析：扫描 Markdown 标题（跳过围栏代码块），返回 sectionAt(line)。
// 规则（可预测优先，且保证引用不歧义）：
//   · 以**存在的最深章节级标题**作前缀：有 H2 用 H2，否则用 H1（H3+ 不参与，避免 (1.2.3.4)）；
//   · 前缀 = 该级标题的**全局序号**（H2 不随 H1 重置 —— 否则第 2 章第 1 节与第 1 章第 1 节
//     都会得到 1，引用就歧义了）；
//   · 该级标题之前的公式返回 null（调用方回退全局流水号）；
//   · 完全没有 H1/H2 的文档返回 null（等于不启用章节编号）。
function buildSectionResolver(content) {
  const lines = String(content == null ? '' : content).split('\n');
  const heads = [];
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*(?:```|~~~)/.test(line)) { inFence = !inFence; continue; }
    if (inFence) continue;
    const m = /^(#{1,6})\s+\S/.exec(line);
    if (m) heads.push({ line: i + 1, level: m[1].length });
  }
  const useLevel = heads.some((h) => h.level === 2) ? 2 : (heads.some((h) => h.level === 1) ? 1 : 0);
  if (!useLevel) return null;
  const marks = [];
  let n = 0;
  for (let i = 0; i < heads.length; i++) {
    if (heads[i].level !== useLevel) continue;
    n += 1;
    marks.push({ line: heads[i].line, section: String(n) });
  }
  if (!marks.length) return null;
  return function sectionAt(line) {
    let cur = null;
    for (let i = 0; i < marks.length; i++) {
      if (marks[i].line <= line) cur = marks[i].section;
      else break;
    }
    return cur;
  };
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
  buildSectionResolver,
};
