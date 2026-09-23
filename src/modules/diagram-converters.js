// ============================================================
// diagram-converters —— 图表「语言转换器 + 原生 SVG 渲染器」纯函数模块
// ------------------------------------------------------------
// 职责边界（与 diagram-renderers.js 分工）：
//   本模块 = 纯函数，不碰 DOM、不读全局引擎、不联网。输入源码字符串，输出
//             Mermaid 图描述（交给既有 processMermaid 渲染）或 SVG 字符串。
//   diagram-renderers.js = 容器编排与引擎适配（含 ECharts/WaveDrom/abcjs/Graphviz）。
// 这样拆分的收益：转换逻辑可零依赖单测（test/diagrams.test.cjs 直接 require）。
//
// 支持的围栏语言：
//   ```plantuml / ```uml / ```puml / ```pu   PlantUML 子集 → Mermaid
//   ```d2                                    D2 子集 → Mermaid
//   ```tikz                                  TikZ 子集 → 原生 SVG
//   ```plot / ```gnuplot                     gnuplot 风格函数绘图 → 原生 SVG
//
// 为什么 PlantUML / D2 转 Mermaid 而不是自研布局：这两者的真正难点是自动布局，
// 自研成本高、质量不可控；降级为等价 Mermaid 图描述后复用已分发的 mermaid.min.js，
// 得到纯本地、可离线、零体积增量的渲染。语法子集之外的内容由调用方保留原代码块
// 并提示，绝不静默丢弃。
//
// 为什么 TikZ / plot 自研 SVG：无等价替代（Graphviz 只认 DOT，Mermaid 无 TikZ 语法）。
// 表达式解析器为自研递归下降，**不使用 eval / new Function**（预览内容来自用户文档，
// 任何代码求值都是 XSS 面）。
//
// 整文件包 IIFE：经典 <script> 的顶层 const/function 会进入全局词法环境且跨脚本共享，
// 与其它脚本同名即 SyntaxError。用函数作用域隔离，仅经 window.DiagramConverters 暴露。
// ============================================================
(function () {
  'use strict';

  /* ============================================================
   * 0. 通用工具
   * ============================================================ */

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#x27;');
  }

  // Mermaid 双引号标签：内部 " 必须转义，换行转 <br/>
  function mq(s) {
    return '"' + String(s == null ? '' : s)
      .replace(/"/g, '#quot;')
      .replace(/\r?\n/g, '<br/>') + '"';
  }

  // Mermaid 边标签 |>| 包裹：| 会截断标签
  function mpipe(s) {
    return String(s == null ? '' : s)
      .replace(/\|/g, '&#124;')
      .replace(/\r?\n/g, ' ');
  }

  // Mermaid 节点 id 归一化：仅保留 [A-Za-z0-9_]，数字开头加前缀
  function mid(raw, fallback) {
    let s = String(raw == null ? '' : raw).trim().replace(/[^\w]/g, '_').replace(/^_+|_+$/g, '');
    if (!s) s = fallback || 'n';
    if (/^\d/.test(s)) s = 'n_' + s;
    return s;
  }

  // 从 openIdx（指向 open 字符）找到配对的 close 下标；考虑引号与转义
  function matchBracket(text, openIdx, open, close) {
    let depth = 0;
    let q = false;
    for (let i = openIdx; i < text.length; i++) {
      const c = text[i];
      if (q) {
        if (c === '\\') { i++; continue; }
        if (c === '"') q = false;
        continue;
      }
      if (c === '"') { q = true; continue; }
      if (c === open) depth++;
      else if (c === close) {
        depth--;
        if (depth === 0) return i;
      }
    }
    return -1;
  }

  function stripQuotes(s) {
    const t = String(s == null ? '' : s).trim();
    if (t.length >= 2 && t[0] === '"' && t[t.length - 1] === '"') return t.slice(1, -1);
    return t;
  }

  // 顶层分隔（忽略引号 / 括号 / 方括号内部）
  function splitTopLevel(s, sepChar) {
    const out = [];
    let cur = '';
    let depth = 0;
    let q = false;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (q) {
        cur += c;
        if (c === '\\') { if (i + 1 < s.length) cur += s[++i]; continue; }
        if (c === '"') q = false;
        continue;
      }
      if (c === '"') { q = true; cur += c; continue; }
      if (c === '(' || c === '[' || c === '{') depth++;
      if (c === ')' || c === ']' || c === '}') depth--;
      if (c === sepChar && depth <= 0) { out.push(cur); cur = ''; continue; }
      cur += c;
    }
    out.push(cur);
    return out;
  }

  // 行注释 / 块注释剥离器（保留字符串字面量）
  function stripComments(text, opts) {
    const o = opts || {};
    const lineTokens = o.line || [];
    const hashAtLineStart = !!o.hashLine;
    let out = '';
    let i = 0;
    let q = false;
    while (i < text.length) {
      const c = text[i];
      if (q) {
        out += c;
        if (c === '\\' && i + 1 < text.length) { out += text[++i]; i++; continue; }
        if (c === '"') q = false;
        i++;
        continue;
      }
      if (c === '"') { q = true; out += c; i++; continue; }
      if (c === '/' && text[i + 1] === '*') {
        i += 2;
        while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
        i += 2;
        continue;
      }
      if (lineTokens.some((t) => text.startsWith(t, i))) {
        while (i < text.length && text[i] !== '\n') i++;
        continue;
      }
      if (hashAtLineStart && c === '#' && (i === 0 || text[i - 1] === '\n')) {
        while (i < text.length && text[i] !== '\n') i++;
        continue;
      }
      out += c;
      i++;
    }
    return out;
  }

  function indent(n) {
    return new Array(n + 1).join('  ');
  }

  /* ============================================================
   * 2. PlantUML → Mermaid
   * ------------------------------------------------------------
   * 覆盖：类图 / 时序图 / 活动图 / 状态图 / 思维导图 / 组件与用例图 / 甘特图。
   * 判定顺序即下方 plantumlKind 的分支顺序（先特征更明确的图种）。
   * 不覆盖：JSON/YAML 视图、salt、时序图的 create/destroy 精确语义、
   *         活动图的 fork/split 并发分支（超出时返回 null 保留代码块并提示）。
   * ============================================================ */

  function stripPlantumlDecorations(src) {
    let text = String(src == null ? '' : src);
    // 块注释 /' ... '/
    text = text.replace(/\/'[\s\S]*?'\//g, '');
    // 整行行注释（' 开头，但要排除地址中的撇号：仅当行首非空白后紧跟 ' 时）
    text = text.split('\n').filter((l) => !/^\s*'/.test(l)).join('\n');
    return text;
  }

  // 关系记号归一化：去掉 up/down/left/right 方向词，补齐虚线/实线
  function normalizePumlArrow(a) {
    let x = String(a || '').replace(/(?:up|down|left|right)/gi, '');
    if (/^<\|-+$/.test(x)) return '<|--';
    if (/^<\|\.+$/.test(x)) return '<|..';
    if (/\|>$/.test(x)) return '..|>';
    if (/\*/.test(x)) return '*--';
    if (/^o/.test(x)) return 'o--';
    if (/^<-+$/.test(x)) return '<--';
    if (/^\.+>$/.test(x)) return '..>';
    if (/^\.+$/.test(x)) return '..';
    if (/^-+>?$/.test(x)) return x.indexOf('>') !== -1 ? '-->' : '--';
    if (/\./.test(x)) return '..>';
    return x;
  }

  // PlantUML 成员 → Mermaid 类成员
  function pumlMember(raw) {
    let s = String(raw || '').trim();
    if (!s) return '';
    let mod = '';
    s = s.replace(/\{(\w+)\}/g, (m, k) => {
      if (/static/i.test(k)) mod += '$';
      if (/abstract/i.test(k)) mod += '*';
      return '';
    }).trim();
    let vis = '';
    if (/^[+\-#~]/.test(s)) vis = s[0];
    if (vis) s = s.slice(1).trim();
    // 方法：name(args): Ret
    const mm = s.match(/^([\w$]+)\s*(\([^)]*\))\s*(?::\s*(.*))?$/);
    if (mm) {
      const ret = (mm[3] || 'void').trim();
      return vis + ret + ' ' + mm[1] + mm[2] + mod;
    }
    // 字段：name: Type
    const fm = s.match(/^([\w$]+)\s*:\s*(.+)$/);
    if (fm) return vis + fm[2].trim() + ' ' + fm[1] + mod;
    return vis + s + mod;
  }

  function plantumlKind(text) {
    if (/@startmindmap|@startwbs/i.test(text)) return 'mindmap';
    if (/@startgantt/i.test(text)) return 'gantt';
    // 明确不属于图种的非渲染视图：直接判为 unsupported（toMermaid 的 default 分支 → null），
    // 免得它们落到后面某个图种分支里"被猜着转换"，产出看似成功却错误的结果。
    if (/@start(?:json|yaml|salt)\b/i.test(text)) return 'unsupported';

    // 状态图优先于时序图：`Idle --> Running : ev` 与时序图 `A -> B : msg` 形态相近，
    // 但状态图必带 [*] 起止或 state 关键字，故先用它们消歧（否则状态图会被误判为时序图）。
    if (/^\s*\[\*\]\s*-+>/m.test(text) || /^\s*state\s+["\w]/mi.test(text)) return 'state';

    // 活动图：start/stop 独立成行、:动作; 语句、if(...) / while(...)
    if (/^\s*(start|stop)\s*$/mi.test(text) || /^\s*:[^;\n]+;\s*$/m.test(text) ||
        /^\s*(if|while)\s*\(/mi.test(text)) return 'activity';

    // 类图：显式关键字或类图专有关系符
    if (/\bclass\s+[\w"<]|\binterface\s+[\w"<]|\benum\s+[\w"<]|\babstract\s+class\b|<\|--|<\|\.\.|\*--|o--|\.\.>|\.\.\|>/.test(text)) return 'class';

    // 时序图
    const seqDecl = /^\s*(participant|actor|boundary|control|entity|database|collections|queue)\s+/mi.test(text);
    // 带消息文本：A -> B : msg
    const seqMsg = /^\s*("[^"]+"|[\w.$]+)\s*(?:<?-{1,2}(?:>>?|x|\\|\/|o)?|o-{1,2}>?)\s*("[^"]+"|[\w.$]+)\s*:/m.test(text);
    // 无消息文本：A -> B（**单短横线**才是时序箭头；类图关联用双短横线 -->，
    // 故这里刻意只认单短横线，避免把类图关联误判成时序图）
    const seqArrow = /^\s*("[^"]+"|[\w.$]+)\s*->{1,2}\s*("[^"]+"|[\w.$]+)\s*$/m.test(text);
    if (seqDecl || seqMsg || seqArrow) return 'sequence';

    if (/^\s*\(\s*[^)]+\s*\)/m.test(text)) return 'usecase';
    if (/^\s*\[[^\]]+\]/m.test(text) || /^\s*component\s+/mi.test(text) ||
        /^\s*(package|node|folder|frame|cloud|database)\s+["\w]/mi.test(text)) return 'component';

    // 只剩 --> 关系、无关键字：按类图处理（最常见）
    if (/--+>|\.\.>/.test(text)) return 'class';
    return 'unsupported';
  }

  function plantumlClassToMermaid(src) {
    const lines = stripPlantumlDecorations(src).split('\n');
    const out = ['classDiagram'];
    const declared = new Set();
    const aliasOf = new Map();
    const SKIP = /^(@(start|end)|skinparam\b|hide\b|show\b|scale\b|header\b|footer\b|legend\b|caption\b|title\b|note\b|namespace\b|together\b|allowmixing|allow_mixing|left to right direction|top to bottom direction|package\b|set\b|!|remove\b|delete\b)/i;
    const REL = /^(.+?)\s+([-.<>|o*]{2,}?)\s+(.+)$/;

    let i = 0;
    while (i < lines.length) {
      const l = lines[i].trim();
      i++;
      if (!l || SKIP.test(l)) continue;

      // class / interface / enum / abstract class 定义（可带 as 别名与 { } 主体）
      const cm = l.match(/^(abstract\s+class|abstract|class|interface|enum|annotation|struct|protocol|entity|circle|diamond)\s+("?[^"{\s]+"?)\s*(?:as\s+(\w+))?\s*(\{)?\s*$/i);
      if (cm) {
        const kw = cm[1].toLowerCase().replace(/\s+/g, ' ');
        const name = stripQuotes(cm[2]);
        const id = mid(cm[3] || name, 'C');
        aliasOf.set(name, id);
        const stere = kw === 'interface' ? 'interface'
          : (kw === 'enum' || kw === 'annotation' ? 'enumeration'
            : (kw === 'abstract' || kw === 'abstract class' ? 'abstract' : ''));
        const body = [];
        if (cm[4]) {
          let depth = 1;
          while (i < lines.length && depth > 0) {
            const bl = lines[i].trim();
            i++;
            if (/\{$/.test(bl)) depth++;
            if (/^\}/.test(bl)) { depth--; if (depth === 0) break; }
            if (bl && !/^(--|\.\.|__|==)\s*$/.test(bl)) body.push(bl);
          }
        }
        out.push('    class ' + id + ' {');
        if (stere) out.push('        <<' + stere + '>>');
        for (const b of body) {
          const mem = pumlMember(b);
          if (mem) out.push('        ' + mem);
        }
        out.push('    }');
        if (name !== id) out.push('    class ' + id + '["' + name.replace(/"/g, '#quot;') + '"]');
        declared.add(id);
        continue;
      }

      // 关系
      const rm = l.match(REL);
      if (rm) {
        const left = rm[1].trim();
        const arrow = normalizePumlArrow(rm[2]);
        let right = rm[3].trim();
        let label = '';
        const colon = right.match(/^(.*?)\s*:\s*(.+)$/);
        if (colon) { right = colon[1].trim(); label = colon[2].trim(); }
        // 拆基数 "1" / "many"
        const parseSide = (s) => {
          const m2 = s.match(/^"([^"]*)"\s*(.*)$/);
          if (m2) return { card: m2[1], name: m2[2].trim() };
          return { card: '', name: s };
        };
        const ls = parseSide(left);
        const rs = parseSide(right);
        if (!ls.name || !rs.name) continue;
        const lid = mid(ls.name, 'C');
        const rid = mid(rs.name, 'C');
        aliasOf.set(ls.name, lid);
        aliasOf.set(rs.name, rid);
        const cardL = ls.card ? '"' + ls.card + '" ' : '';
        const cardR = rs.card ? ' "' + rs.card + '"' : '';
        out.push('    ' + lid + ' ' + cardL + arrow + cardR + ' ' + rid + (label ? ' : ' + label : ''));
        continue;
      }

      // 裸类名声明（无关键字、无关系）
      if (/^[\w."<>]+$/.test(l)) {
        const id = mid(stripQuotes(l), 'C');
        if (!declared.has(id)) { out.push('    class ' + id); declared.add(id); }
      }
    }
    void aliasOf;
    if (out.length <= 1) return null;
    return out.join('\n');
  }

  // PlantUML 时序箭头 → Mermaid 时序箭头
  function pumlSeqArrow(a) {
    const s = String(a || '');
    const dashed = /^--|^\.\./.test(s);
    const base = dashed ? '--' : '-';
    return base + (/x/.test(s) ? 'x' : '>>');
  }

  function plantumlSequenceToMermaid(src) {
    const lines = stripPlantumlDecorations(src).split('\n');
    const out = ['sequenceDiagram'];
    const declared = new Set();
    const MSG = /^("[^"]*"|[A-Za-z_][A-Za-z0-9_.$]*)\s*([<>ox\\\/]*[-=.]+[<>ox\\\/]*)\s*("[^"]*"|[A-Za-z_][A-Za-z0-9_.$]*)\s*(?::\s*([\s\S]*))?$/;
    const SKIP = /^(@(start|end)|skinparam\b|hide\b|show\b|scale\b|header\b|footer\b|legend\b|caption\b|newpage\b|autoactivate\b|return\b|ref\s+over\b|group\b|end\s+group\b|\.\.\.\s*$|==+.*==+\s*$|--+\s*$)/i;

    const declare = (raw) => {
      let name = String(raw || '').trim();
      let display = null;
      if (/^".*"$/.test(name)) { display = stripQuotes(name); name = mid(display, 'P'); }
      const id = mid(name, 'P');
      if (!declared.has(id)) {
        declared.add(id);
        if (display) out.push('    participant ' + id + ' as ' + display.replace(/\s+/g, ' '));
      }
      return id;
    };

    let i = 0;
    let noteBlock = null;
    while (i < lines.length) {
      const l = lines[i].trim();
      i++;
      if (!l) continue;

      if (noteBlock) {
        if (/^end\s*note$/i.test(l)) {
          out.push('    ' + noteBlock.header + ': ' + noteBlock.lines.join('<br/>'));
          noteBlock = null;
        } else {
          noteBlock.lines.push(l);
        }
        continue;
      }
      if (SKIP.test(l)) continue;

      const tm = l.match(/^title\s+(.+)$/i);
      if (tm) { out.push('    accTitle: ' + tm[1].trim()); continue; }
      if (/^autonumber\b/i.test(l)) { out.push('    autonumber'); continue; }

      // participant / actor 声明
      const pm = l.match(/^(participant|actor|boundary|control|entity|database|collections|queue)\s+(\S+)\s*(?:as\s+("[^"]*"|\S+))?\s*$/i);
      if (pm) {
        const kind = /^actor$/i.test(pm[1]) ? 'actor' : 'participant';
        const id = mid(pm[2], 'P');
        const alias = pm[3] ? stripQuotes(pm[3]) : null;
        declared.add(id);
        out.push('    ' + kind + ' ' + id + (alias ? ' as ' + alias : ''));
        continue;
      }

      // 激活 / 销毁
      const am = l.match(/^(activate|deactivate|destroy)\s+(\S+)/i);
      if (am) { out.push('    ' + am[1].toLowerCase() + ' ' + declare(am[2])); continue; }

      // box 分组
      if (/^box\b/i.test(l)) { out.push('    ' + l); continue; }
      if (/^end\s+box$/i.test(l)) { out.push('    end'); continue; }

      // 控制块
      if (/^(alt|opt|loop|par|critical|break|rect)\b/i.test(l)) { out.push('    ' + l.replace(/\s+/g, ' ')); continue; }
      if (/^else\b/i.test(l)) { out.push('    ' + l.replace(/\s+/g, ' ')); continue; }
      if (/^and\b/i.test(l)) { out.push('    ' + l.replace(/\s+/g, ' ')); continue; }
      if (/^end\b/i.test(l)) { out.push('    end'); continue; }

      // 注释
      const nm = l.match(/^note\s+(left of|right of|over)\s+([^:]+?)\s*(?::\s*([\s\S]*))?$/i);
      if (nm) {
        const pos = nm[1].toLowerCase();
        const who = nm[2].split(',').map((x) => declare(x.trim())).join(',');
        const text = (nm[3] || '').trim();
        if (text) out.push('    Note ' + pos + ' ' + who + ': ' + text.replace(/\n/g, '<br/>'));
        else noteBlock = { header: 'Note ' + pos + ' ' + who, lines: [] };
        continue;
      }

      // 消息
      const mm = l.match(MSG);
      if (mm) {
        let from = declare(mm[1]);
        let to = declare(mm[3]);
        const arrow = mm[2];
        const text = (mm[4] || '').trim();
        if (/^</.test(arrow)) { const t = from; from = to; to = t; }
        const a = pumlSeqArrow(arrow);
        out.push('    ' + from + a + to + (text ? ': ' + text.replace(/\n/g, '<br/>') : ''));
        continue;
      }
      // 其余（delay / ||| / || 等）忽略
    }
    if (out.length <= 1) return null;
    return out.join('\n');
  }

  function plantumlStateToMermaid(src) {
    const lines = stripPlantumlDecorations(src).split('\n');
    const out = ['stateDiagram-v2'];
    const SKIP = /^(@(start|end)|skinparam\b|hide\b|show\b|scale\b|header\b|footer\b|legend\b|caption\b|note\b)/i;
    let inBlock = 0;
    for (const raw of lines) {
      const l = raw.trim();
      if (!l || SKIP.test(l)) continue;
      const tm = l.match(/^title\s+(.+)$/i);
      if (tm) { out.push('    accTitle: ' + tm[1].trim()); continue; }

      const sm = l.match(/^state\s+("[^"]*"|\S+)\s+as\s+(\S+)/i);
      if (sm) { out.push('    state ' + mq(stripQuotes(sm[1])) + ' as ' + mid(sm[2], 'S')); continue; }
      const sm2 = l.match(/^state\s+("[^"]*"|\S+)\s*(\{)?\s*$/i);
      if (sm2) {
        const id = mid(stripQuotes(sm2[1]), 'S');
        out.push('    state ' + id + (sm2[2] ? ' {' : ''));
        if (sm2[2]) inBlock++;
        continue;
      }
      if (/^\}/.test(l)) { if (inBlock > 0) { out.push('    }'); inBlock--; } continue; }

      const rm = l.match(/^([\w."\-\[\]*]+)\s*-+>\s*([\w."\-\[\]*]+)\s*(?::\s*(.*))?$/);
      if (rm) {
        const from = rm[1] === '[*]' ? '[*]' : mid(rm[1], 'S');
        const to = rm[2] === '[*]' ? '[*]' : mid(rm[2], 'S');
        out.push('    ' + from + ' --> ' + to + (rm[3] ? ' : ' + rm[3] : ''));
        continue;
      }
      const dm = l.match(/^([\w."\-\[\]*]+)\s*:\s*(.+)$/);
      if (dm) { out.push('    ' + dm[1] + ' : ' + dm[2]); continue; }
      out.push('    ' + l);
    }
    if (out.length <= 1) return null;
    return out.join('\n');
  }

  function plantumlActivityToMermaid(src) {
    const lines = stripPlantumlDecorations(src).split('\n');
    const out = ['flowchart TD'];
    let seq = 0;
    const nid = () => 'n' + (++seq);
    let prevIds = [];
    let pending = {};
    const stack = [];

    const newNode = (shape, text) => {
      const id = nid();
      if (shape === 'diamond') out.push('    ' + id + '{' + mq(text) + '}');
      else if (shape === 'circle') out.push('    ' + id + '((' + mq(text) + '))');
      else if (shape === 'round') out.push('    ' + id + '([' + mq(text) + '])');
      else out.push('    ' + id + '[' + mq(text) + ']');
      for (const p of prevIds) {
        const lbl = pending[p];
        out.push('    ' + p + ' -->' + (lbl ? '|' + mpipe(lbl) + '|' : '') + ' ' + id);
      }
      prevIds = [id];
      pending = {};
      return id;
    };
    const labelNext = (lbl) => { for (const p of prevIds) pending[p] = lbl; };
    const SKIP = /^(@(start|end)|skinparam\b|hide\b|show\b|scale\b|header\b|footer\b|legend\b|caption\b|title\b|partition\b|swimlane\b|detach\b|kill\b|note\b|floating\s+note\b|label\b|end\s*(fork|split|merge)\b|fork\b|split\b)/i;

    for (const raw of lines) {
      const l = raw.trim();
      if (!l) continue;
      if (/^endwhile$|^end\s+while$/i.test(l)) {
        const top = stack.pop();
        if (top) {
          for (const p of prevIds) out.push('    ' + p + ' --> ' + top.condId);
          prevIds = [top.condId];
          pending = {};
          pending[top.condId] = 'no';
        }
        continue;
      }
      if (/^endif$/i.test(l)) {
        const top = stack.pop();
        if (top) {
          const yesExit = top.yesExit || [];
          prevIds = yesExit.concat(prevIds);
          pending = {};
        } else {
          pending = {};
        }
        continue;
      }
      if (SKIP.test(l)) continue;

      if (/^start$/i.test(l)) {
        if (prevIds.length === 0) {
          const id = nid();
          out.push('    ' + id + '((开始))');
          prevIds = [id];
        }
        continue;
      }
      if (/^(stop|end)$/i.test(l)) { newNode('circle', '结束'); continue; }

      if (/^:/.test(l)) {
        let text = l.replace(/^:/, '').replace(/;\s*$/, '').trim();
        text = text.replace(/^#\w+\s*[:|]/, '');
        text = text.replace(/\|/g, '\n').replace(/(?:\r?\n)+/g, '<br/>');
        if (text) newNode('rect', text);
        continue;
      }
      if (/^->/.test(l)) {
        const lbl = l.replace(/^->\s*/, '').replace(/;\s*$/, '').trim();
        if (lbl) labelNext(lbl);
        continue;
      }

      const im = l.match(/^if\s*\(([\s\S]+?)\)\s*then\s*(?:\(([^)]*)\))?/i);
      if (im) {
        const condId = newNode('diamond', im[1]);
        stack.push({ k: 'if', condId: condId, yesExit: null });
        prevIds = [condId];
        pending = {};
        pending[condId] = (im[2] || 'yes').trim() || 'yes';
        continue;
      }
      const imm = l.match(/^elseif\s*\(([\s\S]+?)\)\s*then\s*(?:\(([^)]*)\))?/i);
      if (imm) {
        const top = stack.length ? stack[stack.length - 1] : null;
        if (top) {
          top.yesExit = top.yesExit ? top.yesExit.concat(prevIds) : prevIds.slice();
          prevIds = [top.condId];
          pending = {};
          pending[top.condId] = 'no';
          const condId = newNode('diamond', imm[1]);
          top.condId = condId;
          pending = {};
          pending[condId] = (imm[2] || 'yes').trim() || 'yes';
        }
        continue;
      }
      const em = l.match(/^else\s*(?:\(([^)]*)\))?/i);
      if (em) {
        const top = stack.length ? stack[stack.length - 1] : null;
        if (top) {
          top.yesExit = top.yesExit ? top.yesExit.concat(prevIds) : prevIds.slice();
          prevIds = [top.condId];
          pending = {};
          pending[top.condId] = (em[1] || 'no').trim() || 'no';
        }
        continue;
      }

      const wm = l.match(/^while\s*\(([\s\S]+?)\)/i);
      if (wm) {
        const condId = newNode('diamond', wm[1]);
        stack.push({ k: 'while', condId: condId });
        prevIds = [condId];
        pending = {};
        pending[condId] = 'yes';
        continue;
      }
      if (/^(repeat|backward)\b/i.test(l)) continue;
      const rw = l.match(/^repeat\s+while\s*\(/i);
      if (rw) continue;
      // 未识别语句：忽略，避免产出非法 Mermaid
    }
    if (out.length <= 1) return null;
    return out.join('\n');
  }

  function plantumlMindmapToMermaid(src) {
    const lines = stripPlantumlDecorations(src).split('\n');
    const out = ['mindmap'];
    let hasRoot = false;
    for (const raw of lines) {
      if (!raw.trim()) continue;
      if (/^@(start|end)/i.test(raw)) continue;
      const m = raw.match(/^(\s*)([*+]{1,20})\s*(.*)$/);
      if (!m) continue;
      const depth = m[2].length;
      let text = m[3].trim();
      text = text.replace(/^\[[^\]]*\]\s*/, '').replace(/^:\s*/, '').trim();
      if (!text) continue;
      if (!hasRoot && depth === 1) {
        out.push(indent(1) + 'root((' + text.replace(/[()]/g, '') + '))');
        hasRoot = true;
        continue;
      }
      const needQuote = /[()\[\]{}:#"|]/.test(text);
      const safe = needQuote ? '[' + text.replace(/[\[\]]/g, '') + ']' : text;
      out.push(indent(depth) + safe);
    }
    if (out.length <= 1) return null;
    return out.join('\n');
  }

  function plantumlComponentToMermaid(src) {
    const lines = stripPlantumlDecorations(src).split('\n');
    const out = ['flowchart LR'];
    const declared = new Set();
    const ARROW_AT = /(\s*)(<-{1,2}|-{1,2}\|?>|\.{2}>|-{1,2}>|o-{1,2}|<\|-{1,2}|\*--|--|\.\.)(\s*)/;

    const tokenOf = (raw) => {
      let s = String(raw || '').trim();
      let shape = 'component';
      if (/^\(.*\)$/.test(s)) { shape = 'usecase'; s = s.slice(1, -1).trim(); }
      else if (/^\[.*\]$/.test(s)) { shape = 'component'; s = s.slice(1, -1).trim(); }
      s = stripQuotes(s);
      return { id: mid(s, 'C'), shape: shape, label: s };
    };
    const declare = (t) => {
      if (declared.has(t.id)) return;
      declared.add(t.id);
      if (t.shape === 'usecase') out.push('    ' + t.id + '([' + mq(t.label) + '])');
      else if (t.shape === 'actor') out.push('    ' + t.id + '(( ' + mq(t.label) + ' ))');
      else out.push('    ' + t.id + '[' + mq(t.label) + ']');
    };
    const SKIP = /^(@(start|end)|skinparam\b|hide\b|show\b|scale\b|title\b|header\b|footer\b|legend\b|caption\b|note\b|together\b|left to right direction|top to bottom direction)/i;

    for (const raw of lines) {
      const l = raw.trim();
      if (!l || SKIP.test(l)) continue;

      const am = l.match(/^actor\s+("[^"]*"|\S+)(?:\s+as\s+("[^"]*"|\S+))?/i);
      if (am) {
        const t = tokenOf(am[1]);
        t.shape = 'actor';
        if (am[2]) t.label = stripQuotes(am[2]);
        declare(t);
        continue;
      }
      const pm = l.match(/^(package|node|folder|frame|cloud|database)\s+("[^"]*"|\S+)\s*\{/i);
      if (pm) {
        const title = stripQuotes(pm[2]);
        out.push('    subgraph ' + mid(title, 'G') + '[' + mq(title) + ']');
        continue;
      }
      if (/^\}/.test(l)) { out.push('    end'); continue; }

      const dm = l.match(/^(component|usecase|rectangle|interface)\s+("[^"]*"|\S+)(?:\s+as\s+("[^"]*"|\S+))?/i);
      if (dm) {
        const t = tokenOf(dm[2]);
        if (/^usecase$/i.test(dm[1])) t.shape = 'usecase';
        if (dm[3]) t.label = stripQuotes(dm[3]);
        declare(t);
        continue;
      }

      const arrow = ARROW_AT.exec(l);
      if (arrow && arrow.index > 0) {
        const leftRaw = l.slice(0, arrow.index).trim();
        const rest = l.slice(arrow.index + arrow[0].length);
        const rightRaw = rest.split(/\s*:\s*/)[0].trim();
        if (leftRaw && rightRaw) {
          const lt = tokenOf(leftRaw);
          const rt = tokenOf(rightRaw);
          declare(lt);
          declare(rt);
          const raw2 = arrow[2];
          let arrowStr = /\.\./.test(raw2) ? '-.->' : '-->';
          if (/^</.test(raw2)) out.push('    ' + rt.id + ' ' + arrowStr + ' ' + lt.id);
          else out.push('    ' + lt.id + ' ' + arrowStr + ' ' + rt.id);
          continue;
        }
      }
      // 纯节点声明：[Name] / (Name) / "Name"
      if (/^[\[\(("]/.test(l)) {
        const t = tokenOf(l);
        if (t.label) declare(t);
      }
    }
    if (out.length <= 1) return null;
    return out.join('\n');
  }

  /* ---- 甘特图：@startgantt → Mermaid gantt ---- */
  // 依据 PlantUML Gantt 语言的**常见语句**实现（按语法面，不针对任何示例文档）：
  //   Project starts <date> / [T] lasts N days|weeks / [T] starts <date|[U]'s end|N days after …>
  //   / [T] ends <…> / [T] happens at <…>（里程碑）/ [T] -> [U]（依赖）/ [T] is done
  //   / -- 分组 --（→ Mermaid section）/ title。
  // **无法可靠解析时返回 null**（调用方保留原代码块 + 提示），不猜、也不静默丢弃任务。
  // 有意忽略（Mermaid gantt 无对应语义，属表现层）：skinparam / zoom / printscale / hide /
  //   颜色（is colored in）/ 星期开关（saturday are closed 之类）。
  const PM_GANTT_MONTHS = {
    january: 0, february: 1, march: 2, april: 3, may: 4, june: 5, july: 6,
    august: 7, september: 8, october: 9, november: 10, december: 11,
  };
  const PM_GANTT_DAY = 86400000;

  // 支持 ISO（2024-01-01 / 2024/1/1）与英文写法（1st of January 2024 / January 1, 2024）
  function ganttParseDate(raw) {
    const t = String(raw == null ? '' : raw).trim().replace(/^the\s+/i, '');
    let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(t);
    if (m) return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    m = /^(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?([A-Za-z]+),?\s+(\d{4})$/.exec(t);
    if (m && PM_GANTT_MONTHS[m[2].toLowerCase()] !== undefined) {
      return new Date(Date.UTC(+m[3], PM_GANTT_MONTHS[m[2].toLowerCase()], +m[1]));
    }
    m = /^([A-Za-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})$/.exec(t);
    if (m && PM_GANTT_MONTHS[m[1].toLowerCase()] !== undefined) {
      return new Date(Date.UTC(+m[3], PM_GANTT_MONTHS[m[1].toLowerCase()], +m[2]));
    }
    return null;
  }

  function ganttFmtDate(d) { return d.toISOString().slice(0, 10); }

  function ganttDurationDays(raw) {
    const m = /^(\d+)\s*(day|days|week|weeks)$/i.exec(String(raw == null ? '' : raw).trim());
    if (!m) return null;
    return /week/i.test(m[2]) ? parseInt(m[1], 10) * 7 : parseInt(m[1], 10);
  }

  // 时间参照：绝对日期 / [U]'s start / [U]'s end / N days (after|before) [U]'s end
  function ganttParseRef(raw) {
    const t = String(raw == null ? '' : raw).trim().replace(/^at\s+/i, '');
    const direct = ganttParseDate(t);
    if (direct) return { kind: 'date', date: direct };
    let m = /^\[([^\]]+)\]\s*'s\s*(start|end)$/i.exec(t);
    if (m) return { kind: m[2].toLowerCase() === 'start' ? 'atStart' : 'afterEnd', name: m[1], offset: 0 };
    m = /^(\d+)\s*(day|days|week|weeks)\s+(after|before)\s+\[([^\]]+)\]\s*'s\s*(start|end)$/i.exec(t);
    if (m) {
      const n = /week/i.test(m[2]) ? parseInt(m[1], 10) * 7 : parseInt(m[1], 10);
      return {
        kind: m[5].toLowerCase() === 'start' ? 'atStart' : 'afterEnd',
        name: m[4],
        offset: /before/i.test(m[3]) ? -n : n,
      };
    }
    return null;
  }

  function plantumlGanttToMermaid(src) {
    const lines = stripPlantumlDecorations(src).split('\n');
    const tasks = [];
    const byName = new Map();
    const NOISE = /^(skinparam|zoom|printscale|hide\b|show\b|language\b|today\b|!|')/i;
    let projectStart = null;
    let title = '';
    let section = '';
    const taskOf = (name) => {
      const key = String(name).trim().toLowerCase();
      if (!byName.has(key)) {
        const t = { key: key, name: String(name).trim(), deps: [] };
        byName.set(key, t);
        tasks.push(t);
      }
      return byName.get(key);
    };

    for (const raw of lines) {
      const line = String(raw).trim();
      if (!line || /^@(start|end)/i.test(line)) continue;
      if (line.charAt(0) === "'") continue;
      if (/^--.*--$/.test(line)) { section = line.replace(/^--\s*/, '').replace(/\s*--$/, '').trim(); continue; }
      if (/^title\s+/i.test(line)) { title = line.replace(/^title\s+/i, '').trim(); continue; }
      if (/^project\s+starts?\b/i.test(line)) {
        const d = ganttParseDate(line.replace(/^project\s+starts?\s+(?:at\s+|the\s+)?/i, ''));
        if (!d) return null;
        projectStart = d;
        continue;
      }
      // 日历设置：Mermaid gantt 无对应语义
      if (/^[A-Za-z]+\s+are\s+(closed|open|working)/i.test(line)) continue;
      if (NOISE.test(line)) continue;
      const dep = /^\[([^\]]+)\]\s*-{1,2}>{1,2}\s*\[([^\]]+)\]\s*$/.exec(line);
      if (dep) { taskOf(dep[2]).deps.push(taskOf(dep[1]).key); continue; }
      const m = /^\[([^\]]+)\]\s+(.+)$/.exec(line);
      if (!m) continue;                    // 其它指令（日历、皮肤等）：忽略
      const t = taskOf(m[1]);
      const rest = m[2].trim();
      if (t.section === undefined && section) t.section = section;
      let mm;
      if ((mm = /^(?:lasts|takes?)\s+(.+)$/i.exec(rest))) {
        const d = ganttDurationDays(mm[1]);
        if (d === null) return null;
        t.days = d;
        continue;
      }
      if ((mm = /^starts?\s+(.+)$/i.exec(rest))) {
        const ref = ganttParseRef(mm[1]);
        if (!ref) return null;
        t.startRef = ref;
        continue;
      }
      if ((mm = /^ends?\s+(.+)$/i.exec(rest))) {
        const ref = ganttParseRef(mm[1]);
        if (!ref) return null;
        t.endRef = ref;
        continue;
      }
      if ((mm = /^happens\s+(?:at|on|in)\s+(.+)$/i.exec(rest))) {
        const ref = ganttParseRef(mm[1]);
        if (!ref) return null;
        t.milestone = true;
        t.days = 0;
        t.startRef = ref;
        continue;
      }
      if (/^is\s+colou?red\s+in\s+/i.test(rest)) continue;     // 颜色：表现层，忽略
      if (/^is\s+(done|completed|finished)\b/i.test(rest)) { t.done = true; continue; }
      if (/^is\s+(closed|open)\b/i.test(rest)) continue;        // 日历
      return null;   // 无法解析的任务语句 → 保留原代码块（不猜）
    }
    if (!tasks.length) return null;

    const addDays = (d, n) => new Date(d.getTime() + n * PM_GANTT_DAY);
    const resolveRef = (ref) => {
      if (ref.kind === 'date') return ref.date;
      const other = byName.get(String(ref.name).trim().toLowerCase());
      if (!other) return null;
      if (ref.kind === 'afterEnd') return other.end ? addDays(other.end, ref.offset) : null;
      return other.start ? addDays(other.start, ref.offset) : null;
    };

    // ① 显式绝对起点；② 迭代消解引用（含由 lasts 推出的终点），最多 tasks.length + 2 轮
    for (const t of tasks) if (t.startRef && t.startRef.kind === 'date') t.start = t.startRef.date;
    if (projectStart && !tasks.some((t) => t.start)) tasks[0].start = projectStart;
    for (let pass = 0; pass < tasks.length + 2; pass++) {
      let moved = false;
      for (const t of tasks) {
        if (!t.start && t.startRef) {
          const d = resolveRef(t.startRef);
          if (d) { t.start = d; moved = true; }
        }
        if (t.start && t.days != null && !t.end) { t.end = addDays(t.start, t.days); moved = true; }
        if (t.endRef) {
          const d = resolveRef(t.endRef);
          if (d && (!t.end || t.end.getTime() !== d.getTime())) {
            t.end = d;
            if (!t.start) t.start = addDays(d, -(t.days || 0));
            moved = true;
          }
        }
      }
      if (!moved) break;
    }
    // ③ 仍无起点者：按声明顺序接在前一任务之后（PlantUML gantt 的默认行为），
    //    且不得早于其依赖任务的结束。
    let prevEnd = projectStart;
    for (const t of tasks) {
      if (!t.start) {
        const depEnds = t.deps.map((k) => (byName.get(k) || {}).end).filter(Boolean);
        const base = depEnds.length
          ? new Date(Math.max.apply(null, depEnds.map((d) => d.getTime())))
          : prevEnd;
        if (!base) return null;
        t.start = base;
      }
      if (t.days == null) t.days = t.milestone ? 0 : 1;
      if (!t.end) t.end = addDays(t.start, t.days);
      prevEnd = t.end;
    }

    // 输出 Mermaid gantt（统一用绝对日期，确定性输出，便于单测）
    const esc = (s) => String(s).replace(/[:;,]/g, ' ').replace(/\s+/g, ' ').trim() || '任务';
    const out = ['gantt'];
    if (title) out.push('    title ' + esc(title));
    out.push('    dateFormat YYYY-MM-DD');
    let curSection = null;
    tasks.forEach((t, i) => {
      const sec = t.section || '';
      if (sec !== curSection) { if (sec) out.push('    section ' + esc(sec)); curSection = sec; }
      const tags = [];
      if (t.milestone) tags.push('milestone');
      if (t.done) tags.push('done');
      const days = t.milestone ? 0 : Math.max(1, Math.round((t.end - t.start) / PM_GANTT_DAY));
      out.push('    ' + esc(t.name) + ' :' + (tags.length ? tags.join(', ') + ', ' : '') +
        't' + (i + 1) + ', ' + ganttFmtDate(t.start) + ', ' + days + 'd');
    });
    return out.join('\n');
  }

  /* ---- 「超出本地子集」特征指纹 → 人类可读提示 ---- */
  // 用途：把「超出本地支持的语法子集」这种笼统说法，换成"检测到哪条语法"，
  // 既出现在预览的提示条，也拼进引擎抛出的错误信息。
  // 原则：**只做关键字识别**，识别不到就返回空数组（不编造原因）。
  const UNSUPPORTED_HINTS = {
    plantuml: [
      [/@startjson/i, '@startjson'],
      [/@startyaml/i, '@startyaml'],
      [/@startsalt/i, '@startsalt'],
      [/^\s*(?:fork|split|repeat)\b/im, '活动图 fork/split 并发分支'],
      [/\b(?:create|destroy)\s+\w/i, '时序图 create/destroy'],
      [/^\s*(?:skinparam|!include|!define|!theme|!pragma)\b/im, 'skinparam / 预处理指令'],
      [/^\s*autonumber\b/im, '时序图 autonumber'],
    ],
    tikz: [
      [/\\begin\{axis\}/, 'pgfplots 的 \\begin{axis}'],
      [/\\matrix\b/, '\\matrix 矩阵布局'],
      [/\\tikzset\b/, '\\tikzset 自定义样式'],
      [/\.style\s*=/, '自定义样式（.style=…）'],
      [/\\usetikzlibrary/, '\\usetikzlibrary'],
      [/\b(?:node\s+distance|right\s+of|left\s+of|above\s+of|below\s+of)\b/i, '相对定位（node distance / right of…）'],
      [/(?:\barc\b|\.\.\s*controls|\]\s*to\s*\[)/, '弧线 / 贝塞尔曲线 / to[…]'],
      [/\b(?:rotate|skew\s*[xy])\s*=/, 'rotate / skew'],
      [/\\(?:clip|shade|pattern|decorate)\b/, '\\clip / \\shade / \\pattern / decorations'],
    ],
  };

  function unsupportedHints(type, source) {
    const table = UNSUPPORTED_HINTS[String(type == null ? '' : type).toLowerCase()];
    if (!table) return [];
    const text = String(source == null ? '' : source);
    const out = [];
    for (let i = 0; i < table.length; i++) {
      if (table[i][0].test(text) && out.indexOf(table[i][1]) === -1) out.push(table[i][1]);
    }
    return out;
  }

  // 统一入口：PlantUML → Mermaid；不支持时返回 null（调用方保留原代码块）
  function plantumlToMermaid(src) {
    const text = stripPlantumlDecorations(src);
    const kind = plantumlKind(text);
    switch (kind) {
      case 'mindmap': return plantumlMindmapToMermaid(src);
      case 'sequence': return plantumlSequenceToMermaid(src);
      case 'state': return plantumlStateToMermaid(src);
      case 'activity': return plantumlActivityToMermaid(src);
      case 'usecase':
      case 'component': return plantumlComponentToMermaid(src);
      case 'class': return plantumlClassToMermaid(src);
      case 'gantt': return plantumlGanttToMermaid(src);
      default: return null;
    }
  }

  /* ============================================================
   * 3. D2 → Mermaid
   * ------------------------------------------------------------
   * 支持：direction、a -> b: label、a <- b、a <-> b、a -- b、
   *       key: label、key.shape: circle/diamond/cylinder/...、
   *       嵌套块 key: { ... }、# 行注释。
   * 不覆盖：样式类（style.fill/stroke）、class、icon、markdown 块、vars、imports。
   * ============================================================ */

  function d2ShapeWrap(id, label, shape) {
    const l = mq(label == null ? id : label);
    switch (String(shape || '').toLowerCase()) {
      case 'circle': return '((' + l + '))';
      case 'diamond': return '{' + l + '}';
      case 'oval': return '([' + l + '])';
      case 'cylinder':
      case 'stored_data': return '[(' + l + ')]';
      case 'person': return '(( ' + l + ' ))';
      case 'hexagon': return '{{' + l + '}}';
      case 'queue': return '[/' + l + '/]';
      case 'cloud': return '([' + l + '])';
      case 'parallelogram': return '[/' + l + '/]';
      case 'document': return '[/' + l + '\\]';
      case 'text': return label === id ? '' : '[' + l + ']';
      default: return '[' + l + ']';
    }
  }

  function d2ToMermaid(src) {
    const rawLines = stripComments(String(src == null ? '' : src), { hashLine: true }).split('\n');
    const nodes = new Map();
    const events = [];
    let direction = 'LR';
    const idOf = (s) => mid(stripQuotes(String(s).trim()), 'N');

    const parse = (lines, prefix) => {
      let i = 0;
      while (i < lines.length) {
        const l = String(lines[i]).trim();
        i++;
        if (!l) continue;

        const dm = l.match(/^direction\s*:\s*(\w+)/i);
        if (dm) {
          const v = dm[1].toLowerCase();
          direction = v === 'right' ? 'LR' : v === 'left' ? 'RL' : v === 'up' ? 'BT' : 'TB';
          continue;
        }

        // 嵌套块：key: {
        const bm = l.match(/^("[^"]*"|[\w.$-]+)\s*:\s*\{\s*$/);
        if (bm) {
          const title = stripQuotes(bm[1]);
          const name = (prefix || '') + idOf(title);
          events.push({ t: 'open', name: name, title: title });
          const inner = [];
          let depth = 1;
          while (i < lines.length) {
            const il = lines[i];
            i++;
            depth += (il.match(/\{/g) || []).length - (il.match(/\}/g) || []).length;
            if (depth <= 0) break;
            inner.push(il);
          }
          parse(inner, name + '_');
          events.push({ t: 'close' });
          continue;
        }

        // 属性行：key.shape / key.label / key.style.*
        const pm = l.match(/^("[^"]*"|[\w.$-]+)\.([\w.]+)\s*:\s*(.+)$/);
        if (pm) {
          const id = idOf(pm[1]);
          const prop = pm[2].toLowerCase();
          const val = stripQuotes(pm[3]);
          const n = nodes.get(id) || {};
          if (prop === 'shape') n.shape = val;
          else if (prop === 'label') n.label = val;
          nodes.set(id, n);
          continue;
        }

        // 关系
        const cmRe = /^(.*?)\s*(<->|<--|-->|<-|->|--)\s*(.+)$/;
        const cm = cmRe.exec(l);
        if (cm) {
          const left = stripQuotes(cm[1].trim());
          const rightRaw = cm[3].trim();
          let right = rightRaw;
          let label = '';
          const ci = rightRaw.indexOf(':');
          if (ci !== -1) { label = rightRaw.slice(ci + 1).trim(); right = rightRaw.slice(0, ci).trim(); }
          right = stripQuotes(right);
          if (left && right) {
            const arrow = cm[2] === '<->' ? '<-->' : (cm[2] === '--' ? '---' : '-->');
            events.push({ t: 'edge', from: idOf(left), to: idOf(right), arrow: arrow, label: label });
            continue;
          }
        }

        // 单节点：key: label
        const sm = l.match(/^("[^"]*"|[\w.$-]+)\s*:\s*([\s\S]+)$/);
        if (sm) {
          const id = idOf(sm[1]);
          const n = nodes.get(id) || {};
          n.label = stripQuotes(sm[2]);
          nodes.set(id, n);
          events.push({ t: 'node', id: id });
          continue;
        }
        if (/^("[^"]*"|[\w.$-]+)$/.test(l)) {
          const id = idOf(l);
          if (!nodes.has(id)) nodes.set(id, {});
          events.push({ t: 'node', id: id });
        }
      }
    };
    parse(rawLines, '');

    const out = ['flowchart ' + direction];
    const emitted = new Set();
    const emitNode = (id) => {
      if (emitted.has(id)) return;
      emitted.add(id);
      const n = nodes.get(id) || {};
      out.push('    ' + id + d2ShapeWrap(id, n.label, n.shape));
    };
    for (const ev of events) {
      if (ev.t === 'open') out.push('    subgraph ' + ev.name + '[' + mq(ev.title) + ']');
      else if (ev.t === 'close') out.push('    end');
      else if (ev.t === 'node') emitNode(ev.id);
      else if (ev.t === 'edge') {
        emitNode(ev.from);
        emitNode(ev.to);
        out.push('    ' + ev.from + ' ' + ev.arrow + (ev.label ? '|' + mpipe(ev.label) + '|' : '') + ' ' + ev.to);
      }
    }
    for (const id of nodes.keys()) emitNode(id);
    if (out.length <= 1) return null;
    return out.join('\n');
  }

  /* ============================================================
   * 4. 表达式解析器（plot 与 TikZ 坐标共用）
   * ------------------------------------------------------------
   * 自研递归下降解析器，**不使用 eval / new Function**（预览内容来自用户文档，
   * 任何形式的代码求值都是 XSS 面）。支持：
   *   + - * / % ^（以及 **）、一元正负、括号、隐式乘法（2x、3sin(x)）
   *   常量 pi/e/tau、函数 sin cos tan asin acos atan sinh cosh tanh
   *   exp ln log log2 log10 sqrt abs floor ceil round sign min max pow mod atan2 hypot
   * ============================================================ */

  const EXPR_FUNCS = {
    sin: Math.sin, cos: Math.cos, tan: Math.tan,
    asin: Math.asin, acos: Math.acos, atan: Math.atan,
    sinh: Math.sinh, cosh: Math.cosh, tanh: Math.tanh,
    exp: Math.exp, sqrt: Math.sqrt, abs: Math.abs,
    floor: Math.floor, ceil: Math.ceil, round: Math.round,
    sign: Math.sign,
    ln: Math.log, log: Math.log10, log2: Math.log2, log10: Math.log10,
    min: Math.min, max: Math.max, pow: Math.pow, mod: (a, b) => a % b,
    atan2: Math.atan2, hypot: Math.hypot,
  };
  const EXPR_CONSTS = { pi: Math.PI, e: Math.E, tau: Math.PI * 2, inf: Infinity };

  function tokenizeExpr(src) {
    const toks = [];
    let i = 0;
    const s = String(src == null ? '' : src);
    while (i < s.length) {
      const c = s[i];
      if (/\s/.test(c)) { i++; continue; }
      if (/[0-9.]/.test(c)) {
        const m = s.slice(i).match(/^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/);
        if (!m) return null;
        toks.push({ t: 'num', v: parseFloat(m[0]) });
        i += m[0].length;
        continue;
      }
      if (/[A-Za-z_]/.test(c)) {
        const m = s.slice(i).match(/^[A-Za-z_][A-Za-z_0-9]*/);
        toks.push({ t: 'name', v: m[0] });
        i += m[0].length;
        continue;
      }
      if (s.startsWith('**', i)) { toks.push({ t: 'op', v: '^' }); i += 2; continue; }
      if ('+-*/%^(),'.indexOf(c) !== -1) { toks.push({ t: 'op', v: c }); i++; continue; }
      return null; // 未知字符 → 整式判定失败
    }
    return toks;
  }

  // 返回 (x) => number 或 null
  function compileExpr(src) {
    const toks = tokenizeExpr(src);
    if (!toks || toks.length === 0) return null;
    let p = 0;
    let bad = false;

    const peek = () => toks[p];
    const eat = (v) => {
      const t = toks[p];
      if (t && t.t === 'op' && t.v === v) { p++; return true; }
      return false;
    };

    const parseExpr = () => {
      let node = parseTerm();
      for (;;) {
        const t = peek();
        if (t && t.t === 'op' && (t.v === '+' || t.v === '-')) {
          p++;
          const rhs = parseTerm();
          const op = t.v;
          const a = node;
          node = (x) => (op === '+' ? a(x) + rhs(x) : a(x) - rhs(x));
          continue;
        }
        break;
      }
      return node;
    };

    const parseTerm = () => {
      let node = parseUnary();
      for (;;) {
        const t = peek();
        if (t && t.t === 'op' && '*/%'.indexOf(t.v) !== -1) {
          p++;
          const rhs = parseUnary();
          const op = t.v;
          const a = node;
          node = (x) => {
            const av = a(x);
            const bv = rhs(x);
            if (op === '*') return av * bv;
            if (op === '/') return av / bv;
            return av % bv;
          };
          continue;
        }
        // 隐式乘法：2x / 2(x+1) / (x+1)(x-1)
        if (t && ((t.t === 'num' && false) || t.t === 'name' || (t.t === 'op' && t.v === '('))) {
          const rhs = parseUnary();
          const a = node;
          node = (x) => a(x) * rhs(x);
          continue;
        }
        break;
      }
      return node;
    };

    const parseUnary = () => {
      const t = peek();
      if (t && t.t === 'op' && (t.v === '-' || t.v === '+')) {
        p++;
        const inner = parseUnary();
        if (t.v === '-') return (x) => -inner(x);
        return inner;
      }
      return parsePower();
    };

    const parsePower = () => {
      const base = parseAtom();
      const t = peek();
      if (t && t.t === 'op' && t.v === '^') {
        p++;
        const expo = parseUnary(); // 右结合
        return (x) => Math.pow(base(x), expo(x));
      }
      return base;
    };

    const parseAtom = () => {
      const t = peek();
      if (!t) { bad = true; return () => NaN; }
      if (t.t === 'num') { p++; const v = t.v; return () => v; }
      if (t.t === 'name') {
        p++;
        const name = t.v;
        if (eat('(')) {
          const args = [];
          if (!eat(')')) {
            args.push(parseExpr());
            while (eat(',')) args.push(parseExpr());
            if (!eat(')')) { bad = true; return () => NaN; }
          }
          const fn = EXPR_FUNCS[name.toLowerCase()];
          if (!fn) { bad = true; return () => NaN; }
          return (x) => fn.apply(null, args.map((f) => f(x)));
        }
        const lower = name.toLowerCase();
        if (Object.prototype.hasOwnProperty.call(EXPR_CONSTS, lower)) {
          const c = EXPR_CONSTS[lower];
          return () => c;
        }
        // 变量：仅 x（plot）与 t；其它视为未知 → 交由调用方决定
        return (x) => x;
      }
      if (t.t === 'op' && t.v === '(') {
        p++;
        const inner = parseExpr();
        if (!eat(')')) { bad = true; return () => NaN; }
        return inner;
      }
      bad = true;
      return () => NaN;
    };

    const root = parseExpr();
    if (bad || p !== toks.length) return null;
    return root;
  }

  /* ============================================================
   * 5. plot（gnuplot 风格子集）→ 原生 SVG
   * ------------------------------------------------------------
   * 支持指令：
   *   set title "文本" | set xlabel "x" | set ylabel "y"
   *   set xrange [-6.28:6.28]  或  set xrange -6.28 6.28
   *   set yrange [...]          set grid on|off        set samples 400
   *   plot <expr>[, <expr> ...]  每条可带 title "名称" / with lines|points|linespoints
   *   散点：plot '-' 后跟数据行（x y）   —— 本子集把 `-` 行视为数据块
   * 说明：坐标轴与文字使用 currentColor，自动适配深浅主题。
   * ============================================================ */

  const PLOT_PALETTE = ['#2563eb', '#dc2626', '#16a34a', '#d97706', '#7c3aed', '#0891b2', '#db2777', '#65a30d', '#f97316', '#0ea5e9'];

  function plotQuote(s) {
    const t = String(s || '').trim();
    const m = t.match(/^"([\s\S]*)"$/) || t.match(/^'([\s\S]*)'$/);
    return m ? m[1] : t;
  }

  // 范围边界：纯数字走 parseFloat 快路径，其余按**表达式**求值
  // （gnuplot 里 `set trange [0:2*pi]` 很常见，用 parseFloat 会把 2*pi 读成 2）
  function plotBound(s) {
    const t = String(s == null ? '' : s).trim();
    if (/^[+-]?\d+(?:\.\d+)?$/.test(t)) return parseFloat(t);
    const fn = compileExpr(t);
    if (!fn) return NaN;
    const v = fn(0);
    return isFinite(v) ? v : NaN;
  }

  function parseRangeArg(s) {
    let t = String(s || '').trim();
    const br = t.match(/^\[([\s\S]*)\]$/);
    if (br) t = br[1];
    const parts = t.split(/[:,]/).map((x) => x.trim()).filter(Boolean);
    if (parts.length >= 2) {
      const a = plotBound(parts[0]);
      const b = plotBound(parts[1]);
      if (isFinite(a) && isFinite(b) && b > a) return [a, b];
    }
    const nums = t.split(/\s+/).map(plotBound).filter((x) => isFinite(x));
    if (nums.length >= 2 && nums[1] > nums[0]) return [nums[0], nums[1]];
    return null;
  }

  function niceTicks(min, max, count) {
    const span = max - min;
    if (!(span > 0)) return [min];
    const raw = span / Math.max(2, count);
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const norm = raw / mag;
    const step = (norm >= 5 ? 5 : norm >= 2 ? 2 : norm >= 1 ? 1 : 0.5) * mag;
    const out = [];
    const start = Math.ceil(min / step) * step;
    for (let v = start; v <= max + step * 1e-6; v += step) out.push(Number(v.toFixed(10)));
    return out;
  }

  function fmtNum(v) {
    if (!isFinite(v)) return '';
    const a = Math.abs(v);
    if (a !== 0 && (a < 1e-3 || a >= 1e5)) return v.toExponential(1);
    return String(Number(v.toFixed(4)));
  }

  function plotToSvg(src, opts) {
    const o = opts || {};
    const W = o.width || 680;
    const H = o.height || 400;
    const cfg = {
      title: '', xlabel: 'x', ylabel: 'y', grid: false, samples: 400,
      xrange: null, yrange: null, series: [], points: [],
      // 参数方程（gnuplot `set parametric`）：plot 的两个表达式是 x(t), y(t)
      parametric: false, trange: null,
    };
    const lines = String(src == null ? '' : src).split('\n');
    let dataMode = false;
    for (const raw of lines) {
      const line = raw.trim();
      if (!line || line[0] === '#') continue;
      if (dataMode) {
        if (line === 'e' || line === 'end') { dataMode = false; continue; }
        const nums = line.split(/[\s,]+/).map(Number).filter((x) => isFinite(x));
        if (nums.length >= 2) cfg.points.push([nums[0], nums[1]]);
        continue;
      }
      if (/^unset\s+parametric\b/i.test(line)) { cfg.parametric = false; continue; }
      const sm = line.match(/^set\s+(\w+)\s*(.*)$/i);
      if (sm) {
        const key = sm[1].toLowerCase();
        const val = sm[2].trim();
        if (key === 'title') cfg.title = plotQuote(val);
        else if (key === 'xlabel') cfg.xlabel = plotQuote(val);
        else if (key === 'ylabel') cfg.ylabel = plotQuote(val);
        else if (key === 'xrange') cfg.xrange = parseRangeArg(val) || cfg.xrange;
        else if (key === 'yrange') cfg.yrange = parseRangeArg(val) || cfg.yrange;
        else if (key === 'grid') cfg.grid = /^(on|true|1)$/i.test(val);
        else if (key === 'samples') { const n = parseInt(val, 10); if (n >= 10 && n <= 5000) cfg.samples = n; }
        // `set parametric`（无参数即开启）；`set trange [0:2*pi]` 指定参数区间
        else if (key === 'parametric') cfg.parametric = !/^(off|false|0|no)$/i.test(val);
        else if (key === 'trange') cfg.trange = parseRangeArg(val) || cfg.trange;
        continue;
      }
      const pm = line.match(/^plot\s+([\s\S]+)$/i);
      if (pm) {
        const seg = stripComments(pm[1], { hashLine: true }).split(';')[0];
        // 数据文件规格：`'-'`（可带 `using 1:2`、`title "…"` 等修饰）或裸 `-`。
        // 注意别把负号开头的表达式（如 `plot -x**2 + 10`）误判成数据文件。
        const segTrim = seg.trim();
        if (/^['"]-['"](\s|$)/.test(segTrim) || segTrim === '-') { dataMode = true; continue; }
        // 参数方程：`set parametric` 下 plot 的两个表达式是 x(t), y(t)，**不能**当成两条
        // 函数曲线按 x 采样 —— 那会画出"看着像样但完全不对"的图（原先就是被静默降级成这样）。
        // 这里按 trange 对 t 采样，得到真正的 (x(t), y(t)) 轨迹。
        if (cfg.parametric) {
          const specs = splitTopLevel(seg, ',').map((s) => s.trim()).filter(Boolean);
          if (specs.length < 2) return null; // 参数方程必须给出两个表达式，否则不猜
          const stripKw = (s) => {
            const kw = s.search(/\s(?:title|with|lt|lc|lw|color|linecolor)\b/i);
            return (kw === -1 ? s : s.slice(0, kw)).trim();
          };
          const tm = specs.map((s) => s.match(/\btitle\s+("[^"]*"|'[^']*')/i)).find(Boolean);
          const fx = compileExpr(stripKw(specs[0]));
          const fy = compileExpr(stripKw(specs[1]));
          if (!fx || !fy) return null;
          const [ta, tb] = cfg.trange || [0, 1];
          const n = Math.max(10, cfg.samples);
          const pts = [];
          for (let k = 0; k <= n; k++) {
            const tv = ta + (tb - ta) * (k / n);
            const xv = fx(tv);
            const yv = fy(tv);
            pts.push([isFinite(xv) ? xv : NaN, isFinite(yv) ? yv : NaN]);
          }
          cfg.series.push({
            fn: null, pts: pts,
            expr: specs.join(', '),
            title: tm ? plotQuote(tm[1]) : 'x(t), y(t)',
            style: 'lines', color: null,
          });
          continue;
        }
        for (const part of splitTopLevel(seg, ',')) {
          const spec = part.trim();
          if (!spec) continue;
          const kw = spec.search(/\s(?:title|with|lt|lc|lw|color|linecolor)\b/i);
          const exprText = (kw === -1 ? spec : spec.slice(0, kw)).trim();
          const rest = kw === -1 ? '' : spec.slice(kw);
          const tm = rest.match(/\btitle\s+("[^"]*"|'[^']*')/i);
          const wm = rest.match(/\bwith\s+(\w+)/i);
          const cm = rest.match(/\b(?:lc|color|linecolor)\s+(?:rgb\s+)?("[^"]*"|'[^']*'|#\w{3,8}|\w+)/i);
          if (!exprText) continue;
          const fn = compileExpr(exprText);
          if (!fn) return null; // 有无法解析的表达式 → 交给调用方提示
          let color = null;
          if (cm) {
            const cv = plotQuote(cm[1]);
            color = /^#/.test(cv) ? cv : (TIKZ_COLORS[cv.toLowerCase()] || null);
          }
          cfg.series.push({
            fn: fn,
            expr: exprText,
            title: tm ? plotQuote(tm[1]) : exprText,
            style: wm ? wm[1].toLowerCase() : 'lines',
            color: color,
          });
        }
        continue;
      }
      // 裸数据行
      const nums = line.split(/[\s,]+/).map(Number).filter((x) => isFinite(x));
      if (nums.length >= 2) cfg.points.push([nums[0], nums[1]]);
    }
    if (cfg.series.length === 0 && cfg.points.length === 0) return null;

    const pad = { l: 62, r: 18, t: cfg.title ? 40 : 18, b: cfg.xlabel ? 48 : 34 };
    const w = W - pad.l - pad.r;
    const h = H - pad.t - pad.b;

    // 采样
    const sampled = cfg.series.map((s) => {
      // 参数方程已在解析阶段采完（x、y 都来自 t），不能再按 xrange 重采一次
      if (s.pts) return s.pts;
      const pts = [];
      const [xa, xb] = cfg.xrange || [-10, 10];
      const n = Math.max(10, cfg.samples);
      for (let i = 0; i <= n; i++) {
        const x = xa + (xb - xa) * (i / n);
        let y;
        try { y = s.fn(x); } catch (e) { y = NaN; }
        pts.push([x, typeof y === 'number' && isFinite(y) ? y : NaN]);
      }
      return pts;
    });

    // 值域
    let xmin; let xmax; let ymin; let ymax;
    if (cfg.xrange) { xmin = cfg.xrange[0]; xmax = cfg.xrange[1]; }
    else {
      const xs = [];
      for (const pts of sampled) for (const p of pts) xs.push(p[0]);
      for (const p of cfg.points) xs.push(p[0]);
      xmin = Math.min.apply(null, xs);
      xmax = Math.max.apply(null, xs);
    }
    const ys = [];
    for (const pts of sampled) for (const p of pts) if (isFinite(p[1])) ys.push(p[1]);
    for (const p of cfg.points) ys.push(p[1]);
    if (cfg.yrange) { ymin = cfg.yrange[0]; ymax = cfg.yrange[1]; }
    else if (ys.length) {
      ymin = Math.min.apply(null, ys);
      ymax = Math.max.apply(null, ys);
      if (ymin === ymax) { ymin -= 1; ymax += 1; }
      const mp = (ymax - ymin) * 0.08;
      ymin -= mp; ymax += mp;
    } else { ymin = -1; ymax = 1; }

    const sx = (x) => pad.l + (x - xmin) / (xmax - xmin) * w;
    const sy = (y) => pad.t + (ymax - y) / (ymax - ymin) * h;

    const tb = [];
    tb.push('<svg class="tm-diagram-svg tm-plot" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + W + ' ' + H + '" width="' + W + '" height="' + H + '" role="img" font-family="inherit">');
    tb.push('<rect x="0" y="0" width="' + W + '" height="' + H + '" fill="none"/>');

    // 网格
    const xticks = niceTicks(xmin, xmax, 8);
    const yticks = niceTicks(ymin, ymax, 6);
    if (cfg.grid) {
      for (const t of xticks) tb.push('<line x1="' + sx(t).toFixed(2) + '" y1="' + pad.t + '" x2="' + sx(t).toFixed(2) + '" y2="' + (pad.t + h) + '" stroke="currentColor" stroke-opacity="0.12"/>');
      for (const t of yticks) tb.push('<line x1="' + pad.l + '" y1="' + sy(t).toFixed(2) + '" x2="' + (pad.l + w) + '" y2="' + sy(t).toFixed(2) + '" stroke="currentColor" stroke-opacity="0.12"/>');
    }
    tb.push('<rect x="' + pad.l + '" y="' + pad.t + '" width="' + w + '" height="' + h + '" fill="none" stroke="currentColor" stroke-opacity="0.35"/>');
    // 零轴
    if (ymin < 0 && ymax > 0) tb.push('<line x1="' + pad.l + '" y1="' + sy(0).toFixed(2) + '" x2="' + (pad.l + w) + '" y2="' + sy(0).toFixed(2) + '" stroke="currentColor" stroke-opacity="0.5"/>');
    if (xmin < 0 && xmax > 0) tb.push('<line x1="' + sx(0).toFixed(2) + '" y1="' + pad.t + '" x2="' + sx(0).toFixed(2) + '" y2="' + (pad.t + h) + '" stroke="currentColor" stroke-opacity="0.5"/>');
    // 刻度
    for (const t of xticks) {
      tb.push('<line x1="' + sx(t).toFixed(2) + '" y1="' + (pad.t + h) + '" x2="' + sx(t).toFixed(2) + '" y2="' + (pad.t + h + 4) + '" stroke="currentColor"/>');
      tb.push('<text x="' + sx(t).toFixed(2) + '" y="' + (pad.t + h + 16) + '" font-size="11" text-anchor="middle" fill="currentColor">' + escapeHtml(fmtNum(t)) + '</text>');
    }
    for (const t of yticks) {
      tb.push('<line x1="' + (pad.l - 4) + '" y1="' + sy(t).toFixed(2) + '" x2="' + pad.l + '" y2="' + sy(t).toFixed(2) + '" stroke="currentColor"/>');
      tb.push('<text x="' + (pad.l - 8) + '" y="' + (sy(t) + 4).toFixed(2) + '" font-size="11" text-anchor="end" fill="currentColor">' + escapeHtml(fmtNum(t)) + '</text>');
    }
    if (cfg.title) tb.push('<text x="' + (W / 2) + '" y="22" font-size="15" font-weight="600" text-anchor="middle" fill="currentColor">' + escapeHtml(cfg.title) + '</text>');
    if (cfg.xlabel) tb.push('<text x="' + (pad.l + w / 2) + '" y="' + (H - 6) + '" font-size="12" text-anchor="middle" fill="currentColor">' + escapeHtml(cfg.xlabel) + '</text>');
    if (cfg.ylabel) tb.push('<text x="14" y="' + (pad.t + h / 2) + '" font-size="12" text-anchor="middle" fill="currentColor" transform="rotate(-90 14 ' + (pad.t + h / 2) + ')">' + escapeHtml(cfg.ylabel) + '</text>');

    // 曲线
    sampled.forEach((pts, idx) => {
      const s = cfg.series[idx];
      const color = s.color || PLOT_PALETTE[idx % PLOT_PALETTE.length];
      const withLines = s.style !== 'points';
      const withPoints = s.style === 'points' || s.style === 'linespoints';
      let d = '';
      let pen = false;
      for (const p of pts) {
        if (!isFinite(p[1])) { pen = false; continue; }
        const X = sx(p[0]);
        const Y = sy(p[1]);
        if (Y < pad.t - h * 4 || Y > pad.t + h * 5) { pen = false; continue; }
        if (withLines) d += (pen ? 'L' : 'M') + X.toFixed(2) + ' ' + Y.toFixed(2) + ' ';
        if (withPoints) d += 'M' + X.toFixed(2) + ' ' + Y.toFixed(2) + ' l0.01 0 ';
        pen = true;
      }
      if (d) {
        tb.push('<path d="' + d.trim() + '" fill="none" stroke="' + color + '" stroke-width="' + (withPoints && !withLines ? 3.2 : 2) + '" stroke-linejoin="round" stroke-linecap="round"/>');
      }
    });
    // 散点数据
    if (cfg.points.length) {
      let d = '';
      for (const p of cfg.points) d += 'M' + sx(p[0]).toFixed(2) + ' ' + sy(p[1]).toFixed(2) + ' l0.01 0 ';
      tb.push('<path d="' + d.trim() + '" fill="none" stroke="' + PLOT_PALETTE[0] + '" stroke-width="3.4" stroke-linecap="round"/>');
    }
    // 图例
    const legendItems = cfg.series.map((s, i) => ({ label: s.title, color: s.color || PLOT_PALETTE[i % PLOT_PALETTE.length] }));
    if (legendItems.length > 1 || (legendItems.length === 1 && legendItems[0].label)) {
      let ly = pad.t + 6;
      const lx = pad.l + w - 6;
      tb.push('<g font-size="12" text-anchor="end" fill="currentColor">');
      for (const it of legendItems) {
        tb.push('<line x1="' + (lx - 34) + '" y1="' + (ly - 4) + '" x2="' + (lx - 20) + '" y2="' + (ly - 4) + '" stroke="' + it.color + '" stroke-width="2.4"/>');
        tb.push('<text x="' + lx + '" y="' + ly + '">' + escapeHtml(it.label) + '</text>');
        ly += 18;
      }
      tb.push('</g>');
    }
    tb.push('</svg>');
    return tb.join('\n');
  }

  /* ============================================================
   * 6. TikZ 子集 → 原生 SVG
   * ------------------------------------------------------------
   * 支持：
   *   \draw[opts] (x,y) -- (x,y) -- ... ;       折线
   *   \draw[opts] (x,y) -- cycle ;              多边形
   *   \draw[opts] (x,y) circle (r) ;            圆
   *   \draw[opts] (x,y) rectangle (x,y) ;       矩形
   *   \fill[color] ... / \filldraw ...          填充
   *   \node[opts] at (x,y) {文本} ;             文本节点
   *   \draw ... node[midway,above] {文本} ... ;  路径内联文本
   *   opts: red/blue/... 、thick/thin/very thick/ultra thick、dashed/dotted/dash dot、
   *         ->/<-/<-> 、fill=color、draw=color、opacity=n、scale=n、line width=npt
   * 不覆盖：\foreach、\matrix、\begin{axis}(pgfplots)、贝塞尔/弧线参数、坐标变换(rotate/skew)、
   *         样式定义 (\tikzset)、\newcommand、外部 \usetikzlibrary。
   * 坐标单位：裸数字按 cm 处理（与 TikZ 一致）；支持 pt/mm/cm/in 后缀。
   * ============================================================ */

  const TIKZ_COLORS = {
    red: '#e11d48', blue: '#2563eb', green: '#16a34a', black: 'currentColor',
    gray: '#6b7280', grey: '#6b7280', white: '#ffffff', orange: '#f97316',
    purple: '#7c3aed', violet: '#8b5cf6', cyan: '#0891b2', magenta: '#db2777',
    pink: '#ec4899', yellow: '#eab308', brown: '#92400e', teal: '#0d9488',
    olive: '#65a30d', lime: '#84cc16', lightgray: '#d1d5db', darkgray: '#374151',
  };

  const CM_PER_PT = 1 / 28.4527;

  // 长度 → cm（defUnit 为无后缀时的默认单位）
  function tikzLength(s, defUnit) {
    const t = String(s == null ? '' : s).trim();
    if (!t) return NaN;
    const m = t.match(/^(-?[\d.]+(?:[eE][+-]?\d+)?)\s*(pt|cm|mm|in)?$/i);
    if (m) {
      const v = parseFloat(m[1]);
      const u = (m[2] || defUnit || 'cm').toLowerCase();
      if (u === 'pt') return v * CM_PER_PT;
      if (u === 'mm') return v / 10;
      if (u === 'in') return v * 2.54;
      return v;
    }
    const fn = compileExpr(t);
    if (!fn) return NaN;
    const v = fn(0);
    return isFinite(v) ? v : NaN;
  }

  // ---- TikZ plot 表达式 → JS ----
  // PGF 的三角函数**默认按度**求值，写成 `sin(\x r)` 才是弧度。这里：
  //   \x → x；`sin(... r)` 去掉 r（弧度正是 JS 的语义）；无 r/deg 后缀的三角函数按度→弧度包裹。
  // 这样 `{0.2*\x*\x}` 与 `{sin(\x r)}` 都得到与 TikZ 一致的结果，而不是"看起来对"的猜。
  function tikzDegToRad(s) {
    return String(s).replace(
      /\b(sin|cos|tan|sec|csc|cot)\s*\(([^()]*(?:\([^()]*\)[^()]*)*)\)/g,
      (m, fn, arg) => {
        const a = String(arg).trim();
        if (/\br\s*$/.test(a)) return fn + '(' + a.replace(/\br\s*$/, '').trim() + ')';
        if (/\bdeg\s*$/.test(a)) return fn + '(' + a.replace(/\bdeg\s*$/, '').trim() + ' * pi / 180)';
        return fn + '(' + a + ' * pi / 180)';
      },
    );
  }

  function compileTikzExpr(raw) {
    let s = String(raw == null ? '' : raw).trim();
    const br = s.match(/^\{([\s\S]*)\}$/);
    if (br) s = br[1].trim();
    s = s.replace(/\\x(?![A-Za-z])/g, 'x');
    s = tikzDegToRad(s);
    return compileExpr(s);
  }

  // ---- \foreach 展开 ----
  // 支持 `\foreach \x in {0,1,...,8} <单条命令>;` 与 `\foreach \x in {a,b} { ... }`。
  // 在拆分命令**之前**做纯文本展开，所以展开出来的命令会被后续流程正常识别。
  function expandForeachList(spec) {
    const parts = String(spec).split(',').map((x) => x.trim()).filter((x) => x !== '');
    const dots = parts.indexOf('...');
    if (dots === 1 && parts.length >= 3) {
      // 形式二：{1,...,5} —— 步长 1
      const a = plotBound(parts[0]);
      const z = plotBound(parts[2]);
      return foreachRange(a, 1, z);
    }
    if (dots === 2 && parts.length >= 4) {
      // 形式一：{0,1,...,8} / {0,2,...,10} —— 步长由前两项差决定
      const a = plotBound(parts[0]);
      const b = plotBound(parts[1]);
      const z = plotBound(parts[3]);
      return foreachRange(a, b - a, z);
    }
    return parts;
  }

  function foreachRange(a, step, z) {
    if (!isFinite(a) || !isFinite(step) || !isFinite(z) || step === 0) return [];
    const out = [];
    const up = step > 0;
    if (up ? z < a : z > a) return out;
    for (let v = a, guard = 0; guard < 500; guard++) {
      if (up ? v > z + 1e-9 : v < z - 1e-9) break;
      out.push(String(Number(v.toFixed(6))));
      v += step;
    }
    return out;
  }

  function expandTikzForeach(src) {
    let out = String(src == null ? '' : src);
    for (let guard = 0; guard < 200; guard++) {
      const m = out.match(/\\foreach\s*\\([A-Za-z]+)\s+in\s*\{([^{}]*)\}\s*/);
      if (!m) break;
      const varName = m[1];
      const items = expandForeachList(m[2]);
      let p = m.index + m[0].length;
      let body;
      let isBlock = false;
      if (out.charAt(p) === '{') {
        const end = matchBracket(out, p, '{', '}');
        if (end < 0) break;
        body = out.slice(p + 1, end);
        p = end + 1;
        isBlock = true; // 花括号体内自带 `;`，直接拼接即可
      } else {
        // 单条命令：扫到顶层 `;` 为止（该 `;` 不在 body 内，展开时要补回）
        let depth = 0;
        let q = p;
        for (; q < out.length; q++) {
          const c = out.charAt(q);
          if (c === '{' || c === '[' || c === '(') depth++;
          else if (c === '}' || c === ']' || c === ')') depth--;
          else if (c === ';' && depth <= 0) break;
        }
        if (q >= out.length) break;
        body = out.slice(p, q);
        p = q + 1;
      }
      const reVar = new RegExp('\\\\' + varName + '(?![A-Za-z])', 'g');
      // 单条命令形式必须用 `;` 重新分隔：否则多条命令会被粘成一条，
      // 后续按 `;` 拆命令时只认到最后一个分号，整段被当成一条路径。
      const expanded = items.map((v) => body.replace(reVar, v)).join(isBlock ? ' ' : '; ')
        + (isBlock ? '' : ';');
      out = out.slice(0, m.index) + expanded + out.slice(p);
    }
    return out;
  }

  function tikzOptions(str) {
    const st = { color: null, width: 0.4, dash: null, arrow: '', fill: null, opacity: 1, scale: 1, font: null, domain: null, samples: 0 };
    const parts = splitTopLevel(String(str || ''), ',');
    for (const raw of parts) {
      const t = raw.trim();
      if (!t) continue;
      if (/^very\s+thick$/i.test(t)) { st.width = 1.0; continue; }
      if (/^ultra\s+thick$/i.test(t)) { st.width = 1.6; continue; }
      if (/^thick$/i.test(t)) { st.width = 0.8; continue; }
      if (/^thin$/i.test(t)) { st.width = 0.2; continue; }
      if (/^semi\s+thick$/i.test(t)) { st.width = 0.6; continue; }
      if (/^dashed$/i.test(t)) { st.dash = '6 3'; continue; }
      if (/^dotted$/i.test(t)) { st.dash = '1.5 3'; continue; }
      if (/^dash\s*dot(ted)?$/i.test(t)) { st.dash = '6 3 1.5 3'; continue; }
      if (t === '->' || t === '-|>' || t === '-latex') { st.arrow = 'end'; continue; }
      if (t === '<-' || t === '<|-' || t === 'latex-') { st.arrow = 'start'; continue; }
      if (t === '<->' || t === '<|-|>' || t === '<->>') { st.arrow = 'both'; continue; }
      if (/^scale\s*=/.test(t)) { const v = parseFloat(t.split('=')[1]); if (isFinite(v) && v > 0) st.scale = v; continue; }
      // \draw[domain=0:4, samples=100] plot (\x, {...})；也可写在 \begin{tikzpicture}[...]
      if (/^domain\s*=/.test(t)) { const r = parseRangeArg(t.slice(t.indexOf('=') + 1)); if (r) st.domain = r; continue; }
      if (/^samples\s*=/.test(t)) { const n = parseInt(t.split('=')[1], 10); if (n >= 2 && n <= 2000) st.samples = n; continue; }
      if (/^opacity\s*=/.test(t)) { const v = parseFloat(t.split('=')[1]); if (isFinite(v)) st.opacity = Math.max(0, Math.min(1, v)); continue; }
      if (/^line\s+width\s*=/.test(t)) { const v = tikzLength(t.split('=')[1], 'pt'); if (isFinite(v)) st.width = v; continue; }
      if (/^font\s*=/.test(t)) {
        const v = t.split('=')[1];
        const fm = v.match(/\\(\w+)?size|(\d+)/);
        void fm;
        if (/huge|Large|LARGE/i.test(v)) st.font = 18;
        else if (/large|Large/i.test(v)) st.font = 15;
        else if (/small/i.test(v)) st.font = 10;
        else if (/tiny|scriptsize|footnotesize/i.test(v)) st.font = 8;
        continue;
      }
      if (/^fill\s*=/.test(t)) {
        const v = t.split('=')[1].trim().toLowerCase();
        st.fill = TIKZ_COLORS[v] || (/^#/.test(v) ? v : null);
        continue;
      }
      if (/^draw\s*=/.test(t)) {
        const v = t.split('=')[1].trim().toLowerCase();
        st.color = TIKZ_COLORS[v] || (/^#/.test(v) ? v : null);
        continue;
      }
      const key = t.toLowerCase();
      if (TIKZ_COLORS[key]) { st.color = TIKZ_COLORS[key]; continue; }
      if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(t)) { st.color = t; continue; }
    }
    return st;
  }

  function tikzText(raw) {
    let s = String(raw == null ? '' : raw);
    s = s.replace(/\\textbf\{([^{}]*)\}/g, '$1').replace(/\\textit\{([^{}]*)\}/g, '$1');
    s = s.replace(/\$([^$]*)\$/g, '$1');
    s = s.replace(/\\\\/g, '<br/>');
    s = s.replace(/[{}]/g, '');
    return s.trim();
  }

  function tikzTokenizePath(path) {
    const toks = [];
    let i = 0;
    const s = String(path || '');
    while (i < s.length) {
      const c = s[i];
      if (/\s/.test(c)) { i++; continue; }
      if (c === '(') {
        const end = matchBracket(s, i, '(', ')');
        if (end < 0) break;
        toks.push({ t: 'coord', v: s.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
      if (c === '{') {
        const end = matchBracket(s, i, '{', '}');
        if (end < 0) break;
        toks.push({ t: 'brace', v: s.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
      if (c === '[') {
        const end = matchBracket(s, i, '[', ']');
        if (end < 0) break;
        toks.push({ t: 'opt', v: s.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
      if (c === '-' && s[i + 1] === '-') { toks.push({ t: 'op', v: '--' }); i += 2; continue; }
      const m = s.slice(i).match(/^[A-Za-z]+/);
      if (m) { toks.push({ t: 'op', v: m[0].toLowerCase() }); i += m[0].length; continue; }
      i++;
    }
    return toks;
  }

  function tikzToSvg(src, opts) {
    const o = opts || {};
    const raw = String(src == null ? '' : src);
    const text = expandTikzForeach(
      raw
        .replace(/\\begin\{tikzpicture\}(\s*\[[^\]]*\])?/g, '')
        .replace(/\\end\{tikzpicture\}/g, ''),
    );
    if (!/\\/.test(text)) return null;

    let globalScale = 1;
    let globalDomain = null;
    let globalSamples = 0;
    // 图片级选项要在剥离 \begin{tikzpicture} **之前**抓取：
    // 原实现先 replace 掉 \begin{tikzpicture} 再 match 含它的正则 → 永远匹配不到（死代码），
    // 等价于 `[scale=…]`/`[domain=…]` 全被忽略。
    const head = raw.match(/\\begin\{tikzpicture\}\s*\[([^\]]*)\]/);
    if (head) {
      const gs = head[1].match(/scale\s*=\s*([\d.]+)/);
      if (gs) { const v = parseFloat(gs[1]); if (v > 0) globalScale = v; }
      const gopts = tikzOptions(head[1]);
      globalDomain = gopts.domain || null;
      globalSamples = gopts.samples || 0;
    }

    // 拆命令
    const cmds = [];
    {
      const re = /\\(draw|fill|filldraw|shade|node|path)\b/g;
      let m;
      while ((m = re.exec(text)) !== null) {
        let depth = 0;
        let q = false;
        let j = m.index + m[0].length;
        for (; j < text.length; j++) {
          const c = text[j];
          if (q) { if (c === '"') q = false; continue; }
          if (c === '"') { q = true; continue; }
          if (c === '{' || c === '[' || c === '(') depth++;
          else if (c === '}' || c === ']' || c === ')') depth--;
          else if (c === ';' && depth <= 0) break;
        }
        cmds.push({ cmd: m[1].toLowerCase(), body: text.slice(m.index + m[0].length, j) });
        re.lastIndex = j + 1;
      }
    }
    if (cmds.length === 0) return null;

    const items = []; // {kind:'poly'|'circle'|'rect'|'text', ...}
    const parseCoord = (str) => {
      const parts = splitTopLevel(String(str), ',');
      if (parts.length < 2) return null;
      const x = tikzLength(parts[0], 'cm');
      const y = tikzLength(parts[1], 'cm');
      if (!isFinite(x) || !isFinite(y)) return null;
      return { x: x, y: y };
    };

    for (const c of cmds) {
      let rest = c.body;
      let optStr = '';
      const om = rest.match(/^\s*\[/);
      if (om) {
        const b = rest.indexOf('[');
        const e = matchBracket(rest, b, '[', ']');
        if (e > 0) { optStr = rest.slice(b + 1, e); rest = rest.slice(e + 1); }
      }
      const st = tikzOptions(optStr);

      if (c.cmd === 'node') {
        const nm = rest.match(/^\s*(?:\[([^\]]*)\])?\s*(?:at\s*)?\(([^()]*)\)\s*(?:\[([^\]]*)\])?\s*\{([\s\S]*)\}\s*$/);
        if (!nm) continue;
        const at = parseCoord(nm[2]);
        if (!at) continue;
        const st2 = tikzOptions((nm[1] || '') + ',' + (nm[3] || ''));
        let anchor = 'middle';
        if (/\babove\b/i.test(nm[1] || '') || /\babove\b/i.test(nm[3] || '')) anchor = 'above';
        else if (/\bbelow\b/i.test(nm[1] || '') || /\bbelow\b/i.test(nm[3] || '')) anchor = 'below';
        else if (/\bleft\b/i.test(nm[1] || '')) anchor = 'left';
        else if (/\bright\b/i.test(nm[1] || '')) anchor = 'right';
        items.push({ kind: 'text', at: at, text: tikzText(nm[4]), color: st2.color, font: st2.font, anchor: anchor });
        continue;
      }
      if (c.cmd === 'path') continue;

      // 路径：draw / fill / filldraw / shade
      const isFill = c.cmd === 'fill' || c.cmd === 'filldraw' || c.cmd === 'shade';
      const isStroke = c.cmd === 'draw' || c.cmd === 'filldraw';
      const toks = tikzTokenizePath(rest);
      let pts = [];
      let lastPt = null;
      let prevPt = null;
      let startPt = null;
      let i = 0;
      const flush = () => {
        if (pts.length >= 2) items.push({ kind: 'poly', pts: pts.slice(), style: st, fill: isFill, stroke: isStroke });
        else if (pts.length === 1 && isFill) items.push({ kind: 'poly', pts: [pts[0], pts[0]], style: st, fill: true, stroke: false });
        pts = [];
        startPt = null;
      };
      while (i < toks.length) {
        const t = toks[i];
        if (t.t === 'coord') {
          const p = parseCoord(t.v);
          if (p) { pts.push(p); prevPt = lastPt; lastPt = p; if (!startPt) startPt = p; }
          i++;
          continue;
        }
        if (t.t === 'op') {
          const op = t.v;
          if (op === '--' || op === 'to' || op === 'edge') { i++; continue; }
          if (op === 'cycle') { if (startPt) pts.push(startPt); flush(); lastPt = null; prevPt = null; i++; continue; }
          if (op === 'circle') {
            const rTok = toks[i + 1];
            if (rTok && rTok.t === 'coord' && lastPt) {
              const r = tikzLength(rTok.v, 'cm');
              if (isFinite(r) && r > 0) items.push({ kind: 'circle', c: lastPt, r: r, style: st, fill: isFill, stroke: isStroke });
              i += 2;
            } else { i++; }
            continue;
          }
          if (op === 'rectangle') {
            const rTok = toks[i + 1];
            if (rTok && rTok.t === 'coord' && lastPt) {
              const p2 = parseCoord(rTok.v);
              if (p2) items.push({ kind: 'rect', a: lastPt, b: p2, style: st, fill: isFill, stroke: isStroke });
              i += 2;
            } else { i++; }
            continue;
          }
          if (op === 'node') {
            let j = i + 1;
            let nopt = '';
            if (toks[j] && toks[j].t === 'opt') { nopt = toks[j].v; j++; }
            let ntext = '';
            if (toks[j] && toks[j].t === 'brace') { ntext = toks[j].v; j++; }
            const anchorPt = prevPt && lastPt
              ? { x: (prevPt.x + lastPt.x) / 2, y: (prevPt.y + lastPt.y) / 2 }
              : lastPt;
            if (anchorPt && ntext) {
              let anchor = 'middle';
              if (/above/i.test(nopt)) anchor = 'above';
              else if (/below/i.test(nopt)) anchor = 'below';
              else if (/left/i.test(nopt)) anchor = 'left';
              else if (/right/i.test(nopt)) anchor = 'right';
              items.push({ kind: 'text', at: anchorPt, text: tikzText(ntext), color: null, font: tikzOptions(nopt).font, anchor: anchor });
            }
            i = j;
            continue;
          }
          if (op === 'plot') {
            // TikZ 的 `\draw[...] plot (\x, {<expr>})`：以 \x 参数化，在 domain 上按 samples 采样。
            // 默认 domain=-5:5（与 TikZ 一致）；结果是一段折线，因此能吃到线宽/颜色/虚线等样式。
            const c = toks[i + 1];
            if (c && c.t === 'coord') {
              const parts = splitTopLevel(c.v, ',');
              if (parts.length === 2) {
                const fx = compileTikzExpr(parts[0]);
                const fy = compileTikzExpr(parts[1]);
                const dom = st.domain || globalDomain || [-5, 5];
                const n = Math.max(2, Math.min(2000, st.samples || globalSamples || 50));
                const pts = [];
                if (fx && fy) {
                  for (let k = 0; k <= n; k++) {
                    const xv = dom[0] + (dom[1] - dom[0]) * (k / n);
                    const px = fx(xv);
                    const py = fy(xv);
                    if (isFinite(px) && isFinite(py)) pts.push({ x: px, y: py });
                  }
                }
                if (pts.length >= 2) {
                  items.push({ kind: 'poly', pts: pts, style: st, fill: false, stroke: true });
                  // 让紧跟在 plot 后面的 `node[right] {…}` 落在曲线末端（常见写法）
                  prevPt = pts.length >= 2 ? pts[pts.length - 2] : null;
                  lastPt = pts[pts.length - 1];
                }
              }
              i += 2;
              continue;
            }
            i++;
            continue;
          }
          if (op === 'grid' || op === 'arc' || op === 'sin' || op === 'cos' || op === 'controls' || op === 'parabola') {
            // 不支持：跳过其后的坐标参数，避免误画
            i++;
            while (toks[i] && toks[i].t === 'coord') i++;
            continue;
          }
          i++;
          continue;
        }
        i++;
      }
      flush();
    }

    // 计算包围盒（cm 空间）
    let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
    const grow = (x, y) => {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    };
    for (const it of items) {
      if (it.kind === 'poly') for (const p of it.pts) grow(p.x, p.y);
      else if (it.kind === 'circle') { grow(it.c.x - it.r, it.c.y - it.r); grow(it.c.x + it.r, it.c.y + it.r); }
      else if (it.kind === 'rect') { grow(it.a.x, it.a.y); grow(it.b.x, it.b.y); }
      else if (it.kind === 'text') { grow(it.at.x, it.at.y); grow(it.at.x + 0.6, it.at.y + 0.3); }
    }
    if (!isFinite(minX)) return null;

    const spanX = Math.max(maxX - minX, 0.5);
    const spanY = Math.max(maxY - minY, 0.5);
    const padPx = 22;
    const maxW = o.width || 700;
    let k = 37.795 * globalScale;
    k = Math.min(k, (maxW - padPx * 2) / spanX);
    if (!isFinite(k) || k <= 0) k = 30;
    const W = Math.round(spanX * k + padPx * 2);
    const H = Math.round(spanY * k + padPx * 2);
    const X = (x) => (x - minX) * k + padPx;
    const Y = (y) => (maxY - y) * k + padPx;

    const g = [];
    g.push('<svg class="tm-diagram-svg tm-tikz" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + W + ' ' + H + '" width="' + W + '" height="' + H + '" role="img" font-family="inherit">');
    g.push('<defs>');
    g.push('<marker id="tm-tikz-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="currentColor"/></marker>');
    g.push('<marker id="tm-tikz-dot" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="5" markerHeight="5"><circle cx="5" cy="5" r="4" fill="currentColor"/></marker>');
    g.push('</defs>');

    for (const it of items) {
      const st = it.style || { color: null, width: 0.4, dash: null, arrow: '', fill: null, opacity: 1 };
      const stroke = it.stroke === false ? 'none' : (st.color || 'currentColor');
      const fill = it.fill ? (st.fill || st.color || 'currentColor') : 'none';
      const wid = Math.max(0.6, st.width * CM_PER_PT * 28.4527); // pt → px（1pt = 1.333px）
      const dash = st.dash ? ' stroke-dasharray="' + st.dash + '"' : '';
      const op = st.opacity < 1 ? ' stroke-opacity="' + st.opacity + '" fill-opacity="' + st.opacity + '"' : '';
      const mk = st.arrow === 'end' ? ' marker-end="url(#tm-tikz-arrow)"'
        : st.arrow === 'start' ? ' marker-start="url(#tm-tikz-arrow)"'
          : st.arrow === 'both' ? ' marker-start="url(#tm-tikz-arrow)" marker-end="url(#tm-tikz-arrow)"' : '';
      const common = 'fill="' + fill + '" stroke="' + stroke + '" stroke-width="' + wid.toFixed(2) + '"' + dash + op + mk + ' stroke-linejoin="round" stroke-linecap="round"';

      if (it.kind === 'poly') {
        const d = it.pts.map((p, idx) => (idx === 0 ? 'M' : 'L') + X(p.x).toFixed(2) + ' ' + Y(p.y).toFixed(2)).join(' ');
        g.push('<path d="' + d + '" ' + common + '/>');
      } else if (it.kind === 'circle') {
        g.push('<circle cx="' + X(it.c.x).toFixed(2) + '" cy="' + Y(it.c.y).toFixed(2) + '" r="' + (it.r * k).toFixed(2) + '" ' + common + '/>');
      } else if (it.kind === 'rect') {
        const x1 = Math.min(X(it.a.x), X(it.b.x));
        const y1 = Math.min(Y(it.a.y), Y(it.b.y));
        g.push('<rect x="' + x1.toFixed(2) + '" y="' + y1.toFixed(2) + '" width="' + Math.abs(X(it.b.x) - X(it.a.x)).toFixed(2) + '" height="' + Math.abs(Y(it.b.y) - Y(it.a.y)).toFixed(2) + '" ' + common + '/>');
      } else if (it.kind === 'text') {
        let dx = 0;
        let dy = 4;
        let anchor = 'middle';
        if (it.anchor === 'above') dy = -8;
        else if (it.anchor === 'below') dy = 16;
        else if (it.anchor === 'left') { anchor = 'end'; dx = -6; }
        else if (it.anchor === 'right') { anchor = 'start'; dx = 6; }
        const fs = it.font || 13;
        g.push('<text x="' + (X(it.at.x) + dx).toFixed(2) + '" y="' + (Y(it.at.y) + dy).toFixed(2) + '" font-size="' + fs + '" text-anchor="' + anchor + '" fill="' + (it.color || 'currentColor') + '">' + escapeHtml(it.text) + '</text>');
      }
    }
    g.push('</svg>');
    return g.join('\n');
  }


  /* ============================================================
   * 语言路由（供 diagram-renderers 判定围栏语言归属）
   * ============================================================ */
  // 转 Mermaid 的语言别名（键为围栏 info 的小写形式）
  const MERMAID_ALIASES = {
    plantuml: 'plantuml', puml: 'plantuml', uml: 'plantuml', pu: 'plantuml',
    d2: 'd2',
  };
  // 直出 SVG 的语言别名
  const SVG_ALIASES = { tikz: 'tikz', pgf: 'tikz', tikzpicture: 'tikz', plot: 'plot', gnuplot: 'plot' };
  // ```latex / ```tex 只在明确含 tikzpicture 环境时才视为 TikZ（普通 LaTeX 文档不该被当图渲染）
  const CONDITIONAL_TIKZ = { latex: true, tex: true };

  // 围栏语言 → 归属。返回 { kind, type } 或 null
  //   kind: 'mermaid'（转 Mermaid）/ 'svg'（直出 SVG）
  function classify(lang, source) {
    const l = String(lang == null ? "" : lang).trim().toLowerCase();
    if (!l) return null;
    if (Object.prototype.hasOwnProperty.call(MERMAID_ALIASES, l)) {
      return { kind: 'mermaid', type: MERMAID_ALIASES[l] };
    }
    if (Object.prototype.hasOwnProperty.call(SVG_ALIASES, l)) {
      return { kind: 'svg', type: SVG_ALIASES[l] };
    }
    if (Object.prototype.hasOwnProperty.call(CONDITIONAL_TIKZ, l) &&
        /\\begin\{tikzpicture\}/.test(String(source == null ? "" : source))) {
      return { kind: 'svg', type: 'tikz' };
    }
    return null;
  }

  // 把源码转成 Mermaid 图描述；不支持时返回 null（调用方保留原代码块）
  function toMermaid(type, source) {
    if (type === 'plantuml') return plantumlToMermaid(source);
    if (type === 'd2') return d2ToMermaid(source);
    return null;
  }

  // 把源码渲染成 SVG 字符串；不支持时返回 null
  function toSvg(type, source, opts) {
    if (type === 'tikz') return tikzToSvg(source, opts);
    if (type === 'plot') return plotToSvg(source, opts);
    return null;
  }

  const api = {
    // 纯转换（可零依赖单测）
    plantumlToMermaid: plantumlToMermaid,
    d2ToMermaid: d2ToMermaid,
    tikzToSvg: tikzToSvg,
    plotToSvg: plotToSvg,
    compileExpr: compileExpr,
    // 路由
    classify: classify,
    toMermaid: toMermaid,
    toSvg: toSvg,
    // 「超出子集」的特征提示（供预览提示条与引擎错误信息使用）
    unsupportedHints: unsupportedHints,
    MERMAID_ALIASES: MERMAID_ALIASES,
    SVG_ALIASES: SVG_ALIASES,
  };

  if (typeof window !== 'undefined' && typeof module === 'undefined') window.DiagramConverters = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
