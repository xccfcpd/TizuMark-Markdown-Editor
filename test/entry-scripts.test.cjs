// 护栏（T9 / N15）：src/index.html 的模块脚本清单 必须 与 src/modules/ 目录 双向一致。
//
// 这是 P0-2a（建 tauri-api.js 并加 <script> 标签）的安全带 —— 漏加一个 <script> 标签时，
// 本测试立刻变红，而不是"54 个测试全绿 + 真机白屏"那种最难自查的失效。
//
// 实现严格按 N24/N25 四条规范，否则一写出来就是假的红：
//   ① 枚举必须 statSync().isFile() 过滤 —— src/lib/highlight.js 是目录但名字带 .js 后缀；
//   ② 双向相等【只对 src/modules/ 生效】（新增模块高频动作、N15 命中面）；
//   ③ src/lib/ 只做【单向包含】（unified-bundle.js / md-links.js 必须在清单内，绝不反向枚举
//      vendor 目录里那几百个 js）；
//   ④ 顺序断言【只限业务 8 条】（6 模块 + 2 lib + app.js）都在 app.js 之前，
//      不牵扯 367-393 的 27 条 vendor，且【不断言模块之间的相对顺序】
//      （生产 / 测试字典序今天就已不同，preview-post 生产第 2 / 测试第 5，N25）。
//
// 纯 node 静态解析，不依赖 harness / DOM。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const INDEX = path.join(ROOT, 'src', 'index.html');
const MODULES_DIR = path.join(ROOT, 'src', 'modules');
const LIB_DIR = path.join(ROOT, 'src', 'lib');

// 提取 index.html 中所有 <script src="..."> 的 src（单/双引号都兼容；不匹配无 src 的 inline 脚本）
function scriptSrcs(html) {
  const out = [];
  const re = /<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/g;
  let m;
  while ((m = re.exec(html)) !== null) out.push(m[1]);
  return out;
}

// ① 目录侧：仅取 .js 且为【文件】的条目（排除 highlight.js 这种"名字带 .js 的目录"）
function moduleJsFiles() {
  return fs.readdirSync(MODULES_DIR)
    .filter((f) => f.endsWith('.js'))
    .filter((f) => fs.statSync(path.join(MODULES_DIR, f)).isFile())
    .map((f) => 'modules/' + f)
    .sort();
}

// ② 双向相等：src/modules/ 目录内容 == index.html 的 modules 脚本清单
test('src/modules 目录 与 index.html 的 modules 脚本清单 双向相等', () => {
  const html = fs.readFileSync(INDEX, 'utf8');
  const srcs = scriptSrcs(html);

  const dirModules = moduleJsFiles();
  const htmlModules = srcs.filter((s) => s.startsWith('modules/')).sort();

  assert.deepStrictEqual(
    htmlModules,
    dirModules,
    'index.html 的 modules 脚本清单 与 src/modules/ 目录不一致：' +
      '可能新增模块漏加 <script>，或目录里有未被清单引用的残留 .js 文件',
  );
});

// ③ src/lib/ 只做单向包含：unified-bundle.js / md-links.js 必须在清单内
test('src/lib 关键文件（unified-bundle.js / md-links.js）必须在 index.html 清单内', () => {
  const html = fs.readFileSync(INDEX, 'utf8');
  const srcs = scriptSrcs(html);
  for (const need of ['lib/unified-bundle.js', 'lib/md-links.js']) {
    assert.ok(srcs.includes(need), `index.html 缺少必须的 <script src="${need}">`);
  }
});

// ④ 业务 8 条（6 模块 + 2 lib）全部位于 app.js 之前；【不断言模块之间的相对顺序】（N25）
test('业务脚本（6 模块 + 2 lib）全部位于 app.js 之前', () => {
  const html = fs.readFileSync(INDEX, 'utf8');
  const srcs = scriptSrcs(html);

  const appIdx = srcs.indexOf('app.js');
  assert.ok(appIdx !== -1, 'index.html 缺少 app.js，无法定位业务脚本顺序基准');

  const business = ['lib/unified-bundle.js', 'lib/md-links.js', ...moduleJsFiles()];
  for (const s of business) {
    const i = srcs.indexOf(s);
    assert.ok(i !== -1, `index.html 缺少业务脚本 ${s}`);
    assert.ok(i < appIdx, `业务脚本 ${s} 必须位于 app.js 之前（实际在 app.js 之后或同位置）`);
  }
  // 注意：此处故意只断言"都在 app.js 之前"，【不】断言 business 内部相对顺序。
  // 生产 index.html 与 harness readdirSync 的字典序今天就已不同（N25），
  // 顺序不敏感由"新模块一律延迟求值"的设计保证，写进 ARCHITECTURE.md，不靠测试。
});

// —— 以下两条为「显隐约定」护栏（2026-09-11），防的是"测试全绿但真机 UI 不对"。
//
// 事件起因：停用「检查更新」菜单项时写了 HTML hidden 属性，jsdom 测试通过（属性确实为 true），
// 但真机上该项【照旧显示】。根因有两层：
//   ① 应用【没有】全局 .hidden 规则（styles.css 明确注明），各组件各自声明 .X.hidden{display:none}；
//   ② .dropdown-item 自带 display:flex，作者样式优先级高于 UA 样式表的 [hidden]{display:none}，
//      于是 hidden 属性【静默失效】。
// jsdom 不解析样式表，所以这类失效【测试天然抓不到】——只能靠静态护栏兜住。

const CSS = path.join(ROOT, 'src', 'styles.css');

// 剔除 HTML 注释与所有引号内的属性值，避免把注释文字、class="x hidden"、aria-hidden 误判为属性
function stripHtmlNoise(html) {
  return html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/"[^"]*"/g, '""')
    .replace(/'[^']*'/g, "''");
}

// ⑤ index.html 禁用 HTML hidden 属性（一律改用 class="... hidden"）
test('index.html 不使用会静默失效的 HTML hidden 属性（改用 .hidden 类）', () => {
  const html = fs.readFileSync(INDEX, 'utf8');
  const stripped = stripHtmlNoise(html);
  const badTags = (stripped.match(/<[a-zA-Z][^>]*>/g) || [])
    .filter((tag) => /\shidden(?=[\s/>])/.test(tag));

  assert.deepStrictEqual(
    badTags,
    [],
    'index.html 出现了 HTML hidden 属性：' + badTags.join(' | ') +
      '。应用无全局 .hidden 规则，且组件自带的 display 会覆盖 [hidden]，该属性会静默失效（元素照样显示）。' +
      '请改用 class="... hidden"，并在 styles.css 声明对应的 .组件.hidden{display:none}。',
  );
});

// ⑥ index.html 中带 .hidden 类的元素，styles.css 必须有可命中的隐藏规则
//    规则可写成 .组件.hidden（用类名命中）或 #id.hidden（用 id 命中）——两者都算数。
//    2026-09-11 本测试复现#1：.update-progress 只有 display:flex 而无 .hidden 分支，
//    导致 JS 里 classList.add('hidden') 全无效（"发现新版本"对话框一直挂着 0% 进度条）。
test('index.html 带 .hidden 类的元素，在 styles.css 中都有对应的隐藏规则', () => {
  const html = fs.readFileSync(INDEX, 'utf8');
  const css = fs.readFileSync(CSS, 'utf8');
  const escaped = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const hasGlobalRule = /(^|[\s,{}])\s*\.hidden\s*(,|\{)/.test(css);

  const missing = [];
  if (!hasGlobalRule) {
    const tagRe = /<[a-zA-Z][^>]*>/g;
    let t;
    while ((t = tagRe.exec(html)) !== null) {
      const tag = t[0];
      const clsMatch = /\bclass="([^"]*)"/.exec(tag);
      if (!clsMatch) continue;
      const classes = clsMatch[1].split(/\s+/).filter(Boolean);
      if (!classes.includes('hidden')) continue;
      const id = (/\bid="([^"]+)"/.exec(tag) || [])[1] || '';

      const byClass = classes
        .filter((c) => c !== 'hidden')
        .some((c) => new RegExp('\\.' + escaped(c) + '\\.hidden\\b').test(css));
      const byId = id ? new RegExp('#' + escaped(id) + '\\.hidden\\b').test(css) : false;

      if (!byClass && !byId) missing.push(tag.replace(/\s+/g, ' ').slice(0, 140));
    }
  }

  assert.deepStrictEqual(
    missing,
    [],
    '以下元素用了 .hidden 类，但 styles.css 里既没有 .组件.hidden 也没有 #id.hidden 规则，' +
      '真机上不会被隐藏：\n  ' + missing.join('\n  ') +
      '\n（应用没有全局 .hidden 规则，每个组件必须自己声明隐藏分支）',
  );
});
