# 本地图表 / 数学增强 / Admonition —— 变化点记录

> 本次改动**基于 `more-function` 分支**（其已有 43 个提交，含 ECharts / WaveDrom / abcjs /
> Graphviz 四引擎与一批 export/docx 修复），以 **rebase 方式**把新增能力叠加在其之上，
> 推送到 `more-function` 时为**快进推送**，不丢弃任何既有提交。
>
> 合并策略：**重复部分以 `more-function` 已有实现为准**。因此本次**不再引入**
> `src/modules/diagrams.js`，也**删除了**自研的 DOT→Mermaid 转换（改用他们基于
> `@hpcc-js/wasm` 的真实 Graphviz 引擎）与 ECharts 实现（沿用他们的）。

---

## 0. 本次新增能力（与 more-function 无重叠的部分）

| 能力 | 围栏语言 | 实现位置 | 产出 |
|------|----------|----------|------|
| PlantUML（类图/时序/状态/活动/思维导图/组件用例） | ` ```plantuml ` ` ```puml ` ` ```uml ` ` ```pu ` | `diagram-converters.js` | Mermaid 图描述 |
| D2 | ` ```d2 ` | `diagram-converters.js` | Mermaid 图描述 |
| TikZ 子集 | ` ```tikz ` ` ```pgf ` | `diagram-converters.js` | 原生 SVG |
| 函数绘图（gnuplot 风格） | ` ```plot ` ` ```gnuplot ` | `diagram-converters.js` | 原生 SVG |
| Markmap 思维导图 | ` ```markmap ` | `diagram-renderers.js` + 本地 vendor | 交互式 SVG |
| 公式自动编号 + 交叉引用 | `$$ … \label{} $$`、`\eqref{}`、`\ref{}` | `unified-math.js` | KaTeX `\tag` + `\href` 锚点 |
| siunitx | `\SI` `\qty` `\si` `\unit` `\num` `\ang` `\SIrange` | `unified-math.js` | 展开为 KaTeX 可渲染 TeX |
| Admonition | `!!! note "标题"`、`??? note`、`???+ note` | `unified-admonitions.js` | 复用 `.alert` 结构 |

**全部本地渲染**：不联网、不依赖外部服务。ECharts / Graphviz 等已有引擎保持原样。

---

## 1. 新增文件

| 文件 | 行数 | 说明 |
|------|------|------|
| `src/modules/diagram-converters.js` | ~1706 | 图表语言转换器 + 原生 SVG 渲染器，**纯函数、IIFE 隔离**，唯一全局 `DiagramConverters` |
| `src/unified-math.js` | ~243 | siunitx 兼容层 + 公式编号纯函数（渲染器兄弟模块，零依赖） |
| `src/unified-admonitions.js` | ~206 | Admonition 纯函数（渲染器兄弟模块，零依赖） |
| `test/diagrams.test.cjs` | ~330 | 31 例：PlantUML(6 图种) / D2 / TikZ（含 `\foreach`、`plot (\x,{…})`） / plot（数据文件、参数方程） / 表达式解析器安全 / 语言路由 |
| `test/unified-math.test.cjs` | ~310 | 32 例：siunitx 展开（含 `\SIlist`、`\coulomb` 等派生单位） / 编号 / `\eqref`（数学内 + 正文） / `\tag` 注入 |
| `test/unified-admonitions.test.cjs` | ~300 | 25 例：语法解析（`!!!` / `???` / `:::` 容器） / 反缩进 / 行数中立 / 嵌套 / 防注入 |
| `test/admonition-collapse.test.cjs` | ~85 | 2 例：`???` 收起 / `???+` 展开（行为）+ 强制展开选择器排除 admonition 且不误伤原生 `<details>`（选择器语义） |
| `test/export-details-expand.test.cjs` | ~120 | 5 例：默认克隆展开且不动原预览 / `expandDetails:false` 保持收起 / PDF 打印帧已展开 / HTML 导出保持收起且不丢内容 / 四路共用统一入口且仅 HTML 关闭展开 |
| `test/lightbox-svg-size.test.cjs` | ~130 | 5 例：靠 CSS 撑尺寸的 SVG 补尺寸与 viewBox / 自带尺寸的 SVG 完全不动 / 量不到尺寸时不猜 / `showLightbox` 接线 / **Markmap 现产出（自带尺寸）走早返回且保留类名** |
| `test/markmap-svg-geometry.test.cjs` | ~85 | 2 例：Markmap 的 `<svg>` 必须自带**绝对** width/height 与 viewBox（覆盖实测尺寸与兜底两条路径）—— 守卫 §2.11 的 d3-zoom `NotSupportedError` |
| `docs/local-features-changes.md` | — | 本文件 |

> 为什么把纯函数抽成「兄弟模块」：`unified-renderer.js` 顶部 `require` 了 unified / remark 等
> 数十个包，**未 `npm install` 的环境无法加载**。抽出零依赖模块后，单测可在无 node_modules
> 的机器上直接跑（本次开发即在无 npm 环境完成验证）。
>
> 为什么 `diagram-converters.js` 整文件包 IIFE：经典 `<script>` 的顶层 `const`/`function` 会进入
> 全局词法环境且跨脚本共享，与 `app.js`/`preview-post.js` 等同名即 `SyntaxError`。隔离后仅经
> `window.DiagramConverters` 暴露，与项目既有模块约定一致。

---

## 2. 修改文件

### 2.1 图表链路

| 文件 | 改动 | 风险与回归点 |
|------|------|--------------|
| `src/modules/diagram-renderers.js` | ① `LANGUAGE_MAP` 增加 tikz/pgf/tikzpicture、plot/gnuplot、markmap；② `ENGINE_LABEL` 与尺寸常量；③ 新增 `getDiagramConverters` / `renderTikz` / `renderPlot` / `renderMarkmap`（含 markmap vendor 懒加载，失败可重试）；④ 注册进 `RENDERERS` 与导出 | 他们既有的 `test/diagram-engines.test.cjs` **9/9 通过** |
| `src/modules/preview-post.js` | ① 新增 `getDiagramConverters` + `convertMermaidSources(preview)`：把 ` ```plantuml ` / ` ```d2 ` **就地改写为 ` ```mermaid `**，超出子集时保留原代码块并插入 `.diagram-fallback-note` 提示；② `DIAGRAM_HTML_CACHEABLE` 增加 tikz/plot（可缓存）/ markmap（不可缓存，交互态）；③ `processMath` 增加 `[data-eq-number]` 锚点 id 与受限 `trust` 回调 | 导出 `convertMermaidSources` / `buildDiagramContainer` / `DIAGRAM_HTML_CACHEABLE` 供测试 |
| `src/controllers/preview-controller.js` | 在 `processMermaid` **之前**插入 `convertMermaidSources` 调用 | 必须早于 processMermaid，否则改写无效 |

> 为什么 PlantUML / D2 走「改写为 mermaid」而不是新引擎：这两者的真正难点是自动布局，自研
> 成本高、质量不可控；改写后复用既有 `processMermaid`，天然获得渲染 / 缓存 / 主题重绘一致性。

### 2.2 数学与 Admonition

| 文件 | 改动 | 风险与回归点 |
|------|------|--------------|
| `src/unified-renderer.js` | ① 引入两个兄弟模块；② `restoreMathBlocks(html, ph, eqLabels)` 内做「剥离残留 `\label` → siunitx 展开 → `\eqref` 展开 → 追加 `\tag`」，块级公式加 `data-eq-number`；③ `renderMarkdown` 增加 2.5 `assignEquationNumbers`、2.8 `convertAdmonitions`（**早于** alert）、7.2 `restoreAdmonitions`（**晚于** alert、**早于**数学还原与高亮） | 他们既有的 mhchem、alert 标题内数学占位符、脚注数学还原等修复全部保留；`restoreMathBlocks` 保留其 escapedMarker 兜底分支 |

**顺序设计（关键）**：
- `convertAdmonitions` 必须在 `convertAlerts` **之前** —— 只有先把缩进体反缩进成顶层文本，
  admonition 正文里写的 `> [!NOTE]` 才能被 alert 识别。
- `restoreAdmonitions` 放在 `restoreAlerts` 之后（体内嵌套提示块已还原）、数学还原之前
  （正文里的公式仍会被第 8 步统一处理）。

### 2.3 入口与配置

| 文件 | 改动 |
|------|------|
| `src/index.html` | 新增 `<script src="modules/diagram-converters.js">`；「结构插入」下拉与右键菜单各加 7 项；「提示块」两处各加 2 项 |
| `scripts/check-globals.cjs` | `KNOWN_GLOBALS` 增加 `DiagramConverters` |
| `src/modules/slash.js` | 基础目录新增 9 项；`_buildSlashBaseCatalogIds` 的 `all` 数组同步 |
| `src/app.js` | `executeMenuAction` 新增 9 个 `case`（模板插入） |
| `src/modules/i18n.js` | `insActionKeys` 新增 9 条映射 |
| `src/modules/i18n-data.js` | zh / en 两语各新增 9 个键（本分支只有两语） |
| `src/styles.css` | 9 个新增 admonition 类型配色（含深色变体）+ `details > summary` 折叠样式 + `.diagram-fallback-note` + `.tm-diagram-svg` currentColor + `.markmap-svg` + `.katex a` 与 `:target` |
| `package.json` | dependencies 新增 `d3` / `markmap-lib` / `markmap-view` |
| `scripts/ensure-vendor.mjs` | 新增 `buildMarkmap()`（esbuild 打包为单文件，合并挂 `window.markmap`）并接入构建序列 |
| `.gitignore` | 补上**此前缺失**的图表 vendor 忽略项：`src/lib/echarts.min.js`、`abcjs.min.js`、`graphviz.min.js`、`wavedrom/`、`markmap/`（these 分支此前未忽略，会以未跟踪文件形式污染 `git status`） |
| `test/slash-order.test.cjs`、`test/slash-command.test.cjs` | 目录规模 28 → **37**（3 处）、隐藏后总数 27 → **36**、面板 23 → **32** |

### 2.4 CI / 构建链路（本次一并修复）

| 文件 | 改动 | 原因 |
|------|------|------|
| `.github/workflows/ci.yml` | push / pull_request 分支白名单加入 `more-function` | 该白名单是**显式枚举**的，未列出的分支推送时 workflow 静默不调度。`feat-diagram-engines` / `feat-updater-off` 都补过，`more-function` 从未补过 → 本分支前两次推送都没启动 CI。另注：默认分支 `master` 上的 `ci.yml` 尚无 `workflow_dispatch`，所以 GitHub UI 的「Run workflow」按钮当前不可见 |
| `.github/workflows/sync-lock.yml` | 回推分支解析改为「手动输入 > `lock-<分支名>` tag 推导 > 兜底 feat-diagram-engines」 | 旧实现 `github.event.inputs.branch \|\| 'feat-diagram-engines'` 在 **tag 触发**时 inputs 为空 → 一律回推 `feat-diagram-engines`；而从其它分支打的 tag 检出是 detached HEAD，非快进会被拒 → lock 永远同步不回目标分支 |
| `package-lock.json` | 由 CI 生成并回推（`chore(deps): 同步 package-lock.json`，+483 行） | 本机**没有 npm**（`node.exe` 单独分发，无 npm-cli），无法本地更新 lock；而 CI 与打包流程都用 `npm ci`，lock 与 package.json 不一致会直接失败 —— 即 Windows 打包报的 `Missing: markmap-lib@0.18.12 from lock file` |

**操作序列（供复现/回溯）**：
1. 推送 workflow 修复到 `more-function`；
2. 打并推送 `lock-more-function` tag；
3. `sync-lock` 运行 `npm install` 并把 `package-lock.json` 提交回 `more-function`（远程从 `4dde95f` 前进到 `7ff3d4b`）；
4. **注意**：bot 用 `GITHUB_TOKEN` 推送**不会触发**其它 workflow，所以必须再有「人」的一次推送，CI 才会在「含新 lock 的提交」上运行。

### 2.5 后续修复：`???` 折叠语义（2026-09-22）

| 文件 | 改动 | 原因 |
|------|------|------|
| `src/controllers/preview-controller.js` | 强制展开选择器由 `details:not([open])` 改为 `details:not([open]):not([data-admonition])` | 该行早于 admonition 存在（自 `app.js` 经 `b24b227` 搬迁，**无注释、无测试覆盖**），会把 `???`（默认收起）与 `???+`（默认展开）拉平成「都展开」。**Markdown 手写的原生 `<details>` 行为保持不变** |
| `src/modules/preview-post.js` | `processDiagrams` 内新增闭包 `withVisibleLayout(el, fn)`：渲染图表前临时展开祖先 `<details>`，渲染后恢复原状态 | `???` 收起时容器 `display:none`，量不到宽高 → ECharts 画布空白、Markmap 尺寸异常。TikZ / plot 是纯函数生成的 SVG 字符串，不依赖布局，不受影响 |
| `test/admonition-collapse.test.cjs` | 新增 | 锁定行为（`???` 收起 / `???+` 展开）+ 选择器语义（不误伤原生 `<details>`） |

> `withVisibleLayout` 刻意定义为 `processDiagrams` 的**内部闭包**而非模块顶层函数：`preview-post.js` 未包 IIFE，顶层声明会进入全局词法环境并与其它经典 `<script>` 共享命名空间，能不加就不加（`check-globals.cjs` 只校验 `window.X =` 赋值，管不到顶层声明，故此坑需自觉规避）。

### 2.6 回归修复：导出丢折叠块内容（2026-09-22，由 §2.5 引入）

**这是本轮自己引入、又当场修掉的回归，必须记录清楚。**

- **症状**：`???` 折叠块里的内容在导出 **PDF / PNG** 时消失。
- **根因**：四路导出（HTML / Word / PNG / PDF）**都是克隆预览**再产出结果，而 PDF 走系统打印、
  PNG 走 `html2canvas`，二者都遵循真实布局 —— 收起即隐藏，隐藏内容直接丢失。
  §2.5 之前预览里所有 `<details>` 被强制展开，克隆自然也是展开的；§2.5 之后克隆继承了
  「收起」，内容就没了。另外 `styles.css` 的 `@media print` 中**没有**任何展开 `<details>` 的规则，
  不存在兜底。
- **修复**：把 `export.js` 的 4 个克隆点收敛为**唯一入口** `_clonePreviewForExport(opts)`。

| 文件 | 改动 |
|------|------|
| `src/modules/export.js` | 新增 `_clonePreviewForExport(opts)`；`exportHTML` / `exportWord` / `exportImage` / `exportPDF` 四处 `this.preview.cloneNode(true)` 全部改为调用它 |
| `test/export-details-expand.test.cjs` | 新增 5 例（见 §1 表） |

> **收敛为单一入口的收益**：将来再加第 5 种导出，只要用 `_clonePreviewForExport()` 就自动获得该
> 预处理；测试用例 5 会拦住直接用裸 `cloneNode` 的新代码。
>
> **语义取舍（按产物类型分区，2026-09-22 二次修订）**：
> - **固定版式 PDF / PNG / Word → 一律展开**。它们遵循真实布局（系统打印 / `html2canvas`），
>   收起即隐藏、内容会丢；展开后其输出与修 `???` 折叠前完全一致。
> - **可交互 HTML → 保持收起**（`{ expandDetails: false }`）。内容不会丢，收起只是「等读者
>   点开」，故 `???` 的「默认收起」语义在导出的 HTML 里同样成立，不替读者预先展开。

### 2.7 修复：Markmap 在图表查看器里一片空白（2026-09-22）

- **症状**：` ```markmap ` 渲染正常，但点击图表打开查看器（lightbox）后**一片空白**。
- **根因**：`renderMarkmap` 生成的 `<svg>` **自身不带 width/height/viewBox**，尺寸完全依赖
  `.diagram-container .markmap-svg { width:100%; height:100% }` 这条**有作用域的 CSS**。
  而查看器（`misc-ui.js` 的 `showLightbox`）是把 SVG **克隆到 `.diagram-container` 之外**的
  `.lightbox-svg-wrapper`（该类此前**没有任何 CSS 规则**）→ 作用域选择器失配 → 克隆的视口塌陷。
  偏偏 Markmap 内部那个负责居中缩放的 `<g transform>` 是按**原容器尺寸**算好的，视口一变
  整棵树就被推到视口之外 → 空白（同时 `initFit()` 因 `rect` 为 0 而**逐帧无限重试**，附带 CPU 空转）。
- **为什么只有 Markmap 中招**：Mermaid 自带 `width` + `viewBox`；TikZ / plot 由本模块生成时
  写死了 `width`/`height` + `viewBox`；Graphviz 亦然 —— 都不依赖外部 CSS。

| 文件 | 改动 |
|------|------|
| `src/modules/misc-ui.js` | 新增 `prepareSvgForLightbox(src)`：**仅当源 SVG 不自带尺寸信息**（无 width/height 属性且无 viewBox）时，把真实渲染尺寸与 `viewBox` 显式写到克隆上，并加 `.lightbox-svg-adapt`；自带尺寸的引擎走早返回、完全不动。另外给 `initFit` 的重试加 30 帧上限，消除无限 rAF 空转 |
| `src/styles.css` | 新增 `.lightbox-svg-wrapper`（限 90vw×90vh、flex 居中）与 `.lightbox-svg-wrapper > svg.lightbox-svg-adapt { width:90vw; height:90vh }`，使补过尺寸的 SVG 等比放大到视口内（`preserveAspectRatio` 默认 `xMidYMid meet`，不变形） |
| `test/lightbox-svg-size.test.cjs` | 新增 4 例（见 §1 表） |

> **关键取舍：不给「缺的属性」顺手补齐。** 若对 Mermaid（有 `width` 无 `height`）补一个 `height`，
> 会改变它在查看器里的既有尺寸表现，故判定规则定为「**自带尺寸信息就一律不动**」。

### 2.8 补齐：siunitx 列表、正文 `\eqref`、plot 数据文件（2026-09-22）

来源：用户提供的全功能验证文档（`test.md` → 导出 `test.html`）实测取证。
该 exe 构建于 `edc2093`，**早于 §2.7 的 lightbox 修复**，故 markmap 空白不在其中。

| 缺口 | 现象 | 修法 |
|------|------|------|
| `\SIlist` / `\qtylist` | KaTeX 以红字报未知命令（未纳入 siunitx 兼容层） | `unified-math.js` 新增 `siFormatList()`（`1;2;3` → `1,\;2,\;3`；用 `\;` 而非空格——**数学模式会忽略普通空格**），并注册 `\SIlist` / `\qtylist`（含带选项与 `*` 形式） |
| **正文**中的 `\eqref` / `\ref` | 原样显示成反斜杠命令。根因：KaTeX delimiters 只认 `$...$`，写在正文里的命令根本进不了数学占位符 | 新增 `expandProseEqref(html, labels)`：在**已还原的 HTML** 上替换，按 `<pre>`/`<code>` 分段跳过代码；输出普通 `<a class="eq-ref">`，不依赖 KaTeX trust 白名单。`unified-renderer.js` 在 admonition 还原之后、数学还原之前调用（此时数学仍是占位符，不会被误伤） |
| plot 数据文件 | `plot '-' using 1:2 title 'data'` 判定失败 → 整图渲染失败 | `diagram-converters.js` 数据文件规格判定放宽为「`'-'` + 可选修饰」或裸 `-`；同时避免把 `plot -x**2 + 10` 这类**负号开头的表达式**误判成数据文件 |

新增/扩展测试（均本地可跑，零 npm 依赖）：
`test/unified-math.test.cjs` 26 → **31**（`\SIlist` ×2、正文 `\eqref` ×3），
`test/diagrams.test.cjs` 23 → **25**（数据文件、负号不误判）。

**仍未支持（需决策，见 §3）**：PlantUML `@startgantt`（**已于 §2.14 支持**）、TikZ 命名节点/相对布局、`:::` 容器语法（后已补，见 §2.13）。

### 2.9 修复：lightbox 用 flex 导致「其它图点开空白」+ 渲染逐图隔离（2026-09-22）

**回归来源：§2.7 自己引入。**

- **症状**：Markmap 在查看器里正常了，但**其它图表点开一片空白**；运行期还伴随
  `Uncaught NotSupportedError: Failed to read the 'value' property from 'SVGLength'`
  （`lib/markmap/markmap.min.js`）。
- **根因（图空白 —— 已定位）**：§2.7 给 `.lightbox-svg-wrapper` 加了 `display:flex`。
  多数引擎的 SVG 自带 `width="100%"`（Mermaid 就是），父级一变成 flex 容器，百分比宽度
  就失去确定的包含块 → 克隆体尺寸塌陷 → 空白。只有被显式赋 `90vw/90vh` 的 Markmap 不受
  影响，所以症状恰好是「思维导图能看、其它图全黑」。
  **修法**：移除 `display:flex`，恢复该容器原本的普通块级布局，仅对补过尺寸的那类
  （`.lightbox-svg-adapt`）给显式大小。
- **渲染逐图隔离**：`renderInto` 内部的 try/catch 只覆盖**同步**异常。`processDiagrams` 的
  两处渲染循环（首次渲染 / 主题重绘）各自再兜一层 try —— 单图失败只能影响它自己，
  绝不能让整篇文档里靠后的图都渲染不出来。
- **lightbox 克隆加回退**：`prepareSvgForLightbox` 的尺寸补正降级为"尽力而为"，
  任何异常都回退到裸克隆，不让「点开图表」这个动作本身抛全局错误。

> **Markmap 的 SVGLength 报错：已定位并修复（详见 §2.11）**。此前记为「尚无定论」的推断中，
> 「该库自身不读 `.baseVal`、报错落在打包进来的 d3 代码里」是对的，但触发时机不在
> `ResizeObserver`，而在**缩放手势**：markmap 自己把 d3-zoom 绑在了那个 `<svg>` 上。

### 2.10 补齐：`:::` 容器语法、TikZ `\foreach` / `plot (\x,{…})`、plot 参数方程（2026-09-22）

来源：用户全功能验证文档 §18.3 / §16.2 / §16.4 / §17.4 的实测缺口。

| 缺口 | 原状 | 现在 |
|------|------|------|
| `:::` 容器语法（§18.3） | **静默**变纯文本 | `unified-admonitions.js` 新增容器解析：`::: <type> [标题]` … `:::`，与 `!!!` 共用 blocks 与还原链路。正文由**同名围栏**显式闭合 → 开头/闭合各占一行，标记原地替换即天然保持总行数不变（不像 `!!!` 要借空行）；支持不缩进的同级嵌套（深度计数配对）；名字必须是已知类型，否则原样保留（不吃 `::: python`）；`::: details` → 默认收起的折叠块（配色复用 note，无需新增 CSS 类型） |
| TikZ `\foreach`（§16.2） | **静默**少画（刻度线不出现） | `expandTikzForeach()` 在拆命令**之前**做纯文本展开：支持 `{0,1,...,8}`（步长由前两项差决定）与 `{1,...,5}`，以及「单条命令」/「花括号命令体」两种形式。**单条命令形式必须用 `;` 重新分隔**——初版漏了，多条命令被粘成一条、整段被当成一条路径，被单测当场抓到 |
| TikZ `plot (\x, {…})`（§16.1 / §16.4） | **静默**不画曲线 | 路径内新增 `plot` 分支：以 `\x` 参数化，在 `domain` 上按 `samples` 采样成折线（因此能吃到线宽/颜色/虚线）。`domain` / `samples` 可写在 `\draw[...]` 或 `\begin{tikzpicture}[...]` —— **后者原先是死代码**（先 replace 掉 `\begin{tikzpicture}` 再匹配含它的正则，永远匹配不到），一并修掉。表达式按 PGF 语义：`sin(\x r)` 为弧度，无 `r`/`deg` 后缀的三角函数按**度**求值 |
| plot `set parametric`（§17.4） | **静默画出错误图形**（被当成两条 y=f(x) 曲线） | 正确实现参数方程：`plot x(t), y(t)` 按 `trange` 对 `t` 采样，得到真正的 (x(t), y(t)) 轨迹（**不再猜**）；缺少第二个表达式时返回 null 走错误提示。`set trange [0:2*pi]` 需要表达式边界，故 `parseRangeArg` 改为**表达式感知**（原先 `parseFloat('2*pi')` 会读成 2） |
| siunitx `\coulomb`（§6.4 对照表） | KaTeX **红字报错**（单位宏表漏登记 `coulomb`） | `SI_UNIT` 补 `coulomb: 'C'`。此前 `\SI{1.6e-19}{\coulomb}` 展开成 `\,\mathrm{\coulomb}`，`\mathrm` 内的未知命令被 KaTeX 标红；测试顺带锁住 `\newton` / `\watt` / `\joule` / `\metre\per\second`，避免再从同表漏登记 |

测试：`test/unified-admonitions.test.cjs` 20 → **25**，`test/diagrams.test.cjs` 25 → **31**，全部本地通过（零 npm 依赖）。

### 2.11 修复：点一下思维导图就抛 `NotSupportedError`（Markmap SVG 缺尺寸，2026-09-23）

- **症状**：Markmap 渲染正常，但对它做**任何缩放手势**（滚轮 / 左键按下拖动 / 双击）都弹全局
  错误条：`Uncaught NotSupportedError: Failed to read the 'value' property from 'SVGLength':
  Could not resolve relative length`（`lib/markmap/markmap.min.js`）。
- **根因（已核对上游源码，非猜测）**：`renderMarkmap` 生成的 `<svg>` **既无 width/height 也无
  viewBox**，尺寸完全交给 CSS（`.diagram-container .markmap-svg { width/height:100% }`）。而
  markmap-view 构造函数里 `this.zoom = (<d3-zoom>)().filter(...)`，把 d3-zoom 绑在了这个
  `<svg>` 上；d3-zoom 的 `defaultExtent` 在**没有 viewBox** 时执行
  `[[0, 0], [e.width.baseVal.value, e.height.baseVal.value]]` —— 只由 CSS 决定的宽度是
  **相对长度**，读 `.value` 即抛。任一缩放手势一开始就要算 extent，所以**「点一下思维导图」
  就会抛**；且它发生在 d3 的手势处理里，属**异步 Uncaught**，`renderInto` 的同步 try/catch
  拦不住。Mermaid / TikZ / plot / Graphviz 生成时即写 width + viewBox，故从未中招。
- **与 `???` 折叠改动无关**：该缺陷自 Markmap 引入即存在（§2.9 在更早的构建里就观察到同一
  报错），只是必须与图交互才触发。§2.9 中「该库自身不读 `.baseVal`、报错落在打包进来的 d3
  里」的判断正确，但触发时机不在 `ResizeObserver`，而在缩放手势。
- **修法**：`renderMarkmap` 渲染时量取容器尺寸，显式写死 `width` / `height` / `viewBox`
  （量不到时退到 `DEFAULT_SVG_WIDTH` × `DEFAULT_MARKMAP_HEIGHT`）。

| 文件 | 改动 |
|------|------|
| `src/modules/diagram-renderers.js` | `renderMarkmap` 增加 `width`/`height`/`viewBox`：绝对长度 + 与 CSS 尺寸一致的 viewBox → 用户坐标系仍 1:1，markmap 内部按 px 算的 transform 不受影响 |
| `src/styles.css` | 新增 `.lightbox-svg-wrapper > svg.markmap-svg { width:90vw; height:90vh }`：该 SVG 现已「自带尺寸」，`prepareSvgForLightbox` 会走早返回、不再补 `.lightbox-svg-adapt`，故按类名给回同样的等比放大，保持查看器里的既有观感 |
| `src/modules/misc-ui.js` | 仅更新注释：五大引擎现已全部自带尺寸，该函数转为「靠外部 CSS 撑尺寸」的兜底 |
| `test/markmap-svg-geometry.test.cjs` | 新增 2 例：按实测尺寸写入 / 量不到时兜底；均断言 width·height **不得为百分比**、必须有 viewBox |
| `test/lightbox-svg-size.test.cjs` | 夹具注释修正（原写「与 renderMarkmap 产出同构」已过时）+ 新增 1 例：现在的 Markmap 产出走早返回且保留类名 |

> **为什么必须同时给 viewBox**：只补 width/height 能让 `baseVal` 变绝对值，但 d3 仍走「读
> `width.baseVal.value`」那条分支；补上 viewBox 后它改走 `viewBox.baseVal`（必然绝对值），
> 双保险。二者都不再依赖作用域 CSS，顺带消除了 §2.7 那类「脱离 `.diagram-container` 就塌陷」
> 的隐患。

### 2.12 修复：图表被 Mermaid 接管（导出守卫 + 路由守卫，2026-09-23）

**症状**：预览 / 导出里 Graphviz、ECharts、WaveDrom、ABC 五线谱整块变成
`Syntax error in text / mermaid version …` 的错误图（Markmap 另有 §2.11 的 SVGLength 报错）。

**排查结论（两件事必须分开看）**

1. **用户手上的那份 exe 不是当前代码构建的**。证据（全部实测自其导出的 `test0923.html`）：
   - 20 个 `Syntax error in text` 炸弹；
   - 炸弹容器是 `class="mermaid-container"`（**单类名**）+ `id="mermaid-<ts>-<index>"` +
     `data-processed="true"` + `<div id="dmermaid-…">` —— 这是 **`mermaid.run()`** 的产物，
     即**预览阶段** `processMermaid` 把这些块当 Mermaid 渲染了（导出路径用的是
     `mermaid.render()`，其临时 id 前缀为 `pdf-mermaid-` / `docx-mermaid-`，文件里出现 **0 次**）；
   - 文件里 `data-diagram-type="mermaid"` 出现 **0 次**，而当前 HEAD 的 `processMermaid`
     **必设**该属性；同时我们的容器双类名完好保留 10 个 → 证明导出未剥离属性，是那段代码不同；
   - 该「单类名 + id 形态」与**已废弃旧实现线** `3a28b0a` 的 `preview-post.js:312-313` 逐字一致；
   - 块序号吻合：§9.1→13、§10.1→17、§12.1→25、§13.1→28（即 13 个真 mermaid 块之后按文档顺序
     依次排到 graphviz 4 / echarts 8 / wavedrom 3 / abc 4）。
   → **结论：必须用当前代码重新打包**（`build-windows.yml` 不监听 `more-function`，不会自动出包）。

2. **当前代码仍有一处同类隐患，本次一并修掉**：`export.js` 的 Word / PDF 两条路径用
   `clone.querySelectorAll('.mermaid-container')` 选容器后送 `mermaid.render(container.data-code)`，
   而**我们的图表容器刻意复用了 `.mermaid-container` 类**（§2.1 的样式 / 灯箱复用决策），
   且跳过条件只有 `data-diagram-type === 'echarts'` → graphviz / wavedrom / abcjs / markmap /
   tikz / plot 的容器也会被喂进去。若 `mermaid.render` 以「错误图」返回（v11 的 `run()` 就是
   这种语义，外部证据即上面那 20 个炸弹），Word / PDF 导出会被整块覆盖。

| 文件 | 改动 |
|------|------|
| `src/modules/export.js` | 新增 `_mermaidContainersForRerender(root)`：按 `data-diagram-type` 判定，只返回**真正的** mermaid 容器（属性缺省或等于 `'mermaid'`）；Word 与 PDF 两处选择点改用它，并删掉「只跳过 echarts」的补丁式守卫 |
| `test/export-mermaid-guard.test.cjs` | 新增 3 例：① 守卫只挑真 mermaid 容器（含历史无属性形态）；② `convertMermaidSources` 不得把 graphviz / dot / echarts / wavedrom / abc / abcjs / markmap 改写成 `language-mermaid`（且 plantuml 仍正常转换，能力不被误伤）；③ `collectDiagramBlocks` 对八种语言的原生类型映射 |
| `test/diagrams.test.cjs` | 新增 1 例（零依赖、可离线直接跑）：`classify()` 仅 plantuml / d2 归 Mermaid，其余一律 `null`；并直接断言 `MERMAID_ALIASES` / `SVG_ALIASES` 的键集合，防止白名单被放宽 |

> **教训（写给后来改这里的人）**：为复用样式而共享 `.mermaid-container` 类，等于把所有
> 「图表容器」暴露给任何以该类为选择子的代码 —— 灯箱（`misc-ui`）幸运地无害，导出侧则致命。
> 今后凡以该类选容器做**语义处理**（重渲染、替换、导出）的地方，都必须再按
> `data-diagram-type` 收窄；本仓库已把导出侧收敛到唯一入口 `_mermaidContainersForRerender`。

**重新打包后的验收判据（4 项全中才算修好）**

1. 导出 HTML 里出现 `data-diagram-type="graphviz" / "echarts" / "wavedrom" / "abcjs"` 容器，各自带 `<svg>`（ECharts 为快照 `<img>`）；
2. `Syntax error in text` 计数为 **0**；
3. 点击 / 滚轮 Markmap 不再抛 `SVGLength NotSupportedError`（§2.11）；
4. 导出 Word / PDF 后上述图表仍在（不是错误图）。

> 附带说明：用户旧的 `test0923.html` 里那 2 张「裂图」与本站无关 —— 其源域
> `via.placeholder.com` **已停运**（DNS 可解析、TLS 握手被直接断开、HTTP 403；同环境
> `placehold.co` / `unpkg.com` 均 200）。导出器按既有设计保留原 URL 并弹告警。
> 该测试稿（`test.md`）是**用户本地文件、未纳入版本库**，复查时已不在工作区，故本仓库未改动它；
> 若要彻底消除误报，把稿件里的占位图 URL 换成可用图床（如 `placehold.co`）或改成随文档的本地图片即可。

### 2.13 siunitx 支持现状盘点与补漏（2026-09-23）

**问题**：「siunitx 是否已全部完全支持？」—— **不是**。KaTeX 无 siunitx 包，这里是**常用子集
兼容层**。本次按真实写法逐条实测后，补掉了三类**疏漏**（是漏做，不是没打算做）：

| 问题（实测） | 原状 | 现状态 |
|------|------|------|
| `\square` / `\cubic` | 未实现 → `\si{\newton\per\square\meter}` 残留 `\squarem` → **KaTeX 红字** | 支持，且指数落到**单位之后**：`N/m^{2}`、`m^{3}` |
| 花括号嵌套 | 参数正则 `\{([^{}]*)\}` 遇嵌套即**整条不匹配** → `\si{\metre\tothe{3}}` 原样不展开 → 红字 | 改为**配对花括号扫描器**（`readBracedArg` / `skipSiOption`）：`\SI{1}{\metre\tothe{3}}` → `1\,\mathrm{m^{3}}`；选项里含 `{}` 也能跳过 |
| 单位宏漏登记 | `\kWh` / `\decibel` / `\kVA` 等残留 → 红字（与 `\coulomb` 同一类） | 补登记 `Wh kWh MWh GWh VA kVA dB Np` 等 |
| 相邻单位无间隔 | `\kilogram\metre` → `kgm`（错拼） | `kg\,m`（前缀+单位之间仍不插空格，`\kilo\meter` → `km`） |

**仍然不支持**（有意保留原样交给 KaTeX 降级，不静默丢弃）：`\sisetup`、`\numrange`、
`\complexnum`、`\qtyproduct`；选项**语义**（`per-mode=reciprocal` 仍输出 `m/s`；`round-mode` /
`round-precision` 不舍入；`list-*-separator` 被忽略）；不确定度 `\num{1.2(3)}`；siunitx 的表格
对齐与全局配置系统（这些属于"未实现特性"，不是本次的疏漏范围）。

> 若要把覆盖再推进一档，按收益/成本排序：① `\sisetup` **安全吞掉**（消除红字，不实现语义）；
> ② 补 `\numrange` / `\complexnum` / `\qtyproduct`；③ 选项白名单化（当前是无条件吞掉，
> 既不报错也不生效）。彻底"完全支持 siunitx"不在兼容层目标内 —— 那是把整个宏包搬过来。

**自查方式**（模块零依赖，未 npm install 也能跑）：

```bash
node -e "console.log(require('./src/unified-math.js').expandSiunitx('\\si{\\newton\\per\\square\\meter}'))"
```

测试：`test/unified-math.test.cjs` 32 → **37 例**（新增 5 例锁住上述补漏，含"参数不全原样保留"）。

#### 2.13.1 追加：①②⑤ 已实现，③④ 经用户决定不做（2026-09-23）

| 步 | 内容 | 状态 |
|---|---|---|
| ① | `\sisetup{…}` **安全吞掉**（`sisetup` / `SIsetup` 两种写法都吞，消除"未知命令"红字）。**语义不生效** —— 本兼容层是**无状态纯函数**（每个公式独立），跨公式的全局配置无法持久化 | ✅ 已做 |
| ② | 补命令：`\numrange`、`\numlist`、`\unitlist`、`\complexnum`、`\qtyproduct` | ✅ 已做 |
| ⑤ | 单位表批量补齐 —— 只登记**不可由「前缀 + 基本单位」组合得到**的符号：`\parsec` `\lightyear` `\barn` `\atmosphere` `\torr` `\mmHg` `\psi` `\dyne` `\erg` `\calorie` `\horsepower` `\curie` `\poise` `\stokes` `\gauss` `\molar` `\bit` `\byte` `\baud` `\fahrenheit` `\degreeCelsius`（`\kilo\calorie` → `kcal` 这类组合本就可用，故不重复登记） | ✅ 已做 |
| ③④ | 数字语义（不确定度 `1.2(3)`、区间短语、分隔符）与**选项白名单化**（`per-mode` / `round-mode` / `round-precision` / `list-*-separator` / `exponent-*`） | ⛔ **用户决定不做**（维持"不报错也不生效"现状） |

**有意不做的一件事**：未登记单位宏**不自动降级**成 `\mathrm{名字}` —— 那会把拼写错误伪装成"看起来正常"的输出，违背本仓库"不猜、缺失即可见"的原则。改为靠 ⑤ 补表 + 自查脚本收敛。

**仍未实现（原样保留 → KaTeX 可能标红）**：`\numproduct`、`\complexqty`、其它列表变体，以及 ③④ 涉及的一切选项语义。

测试：`test/unified-math.test.cjs` 37 → **43 例**（本地 43/43 通过，含"`\numproduct` 仍未实现必须原样保留"这类防猜断言）。

### 2.14 补自研：PlantUML 甘特图 + 「超出子集」提示精确化（2026-09-23）

范围由用户指定：**只做这两项**（不做 TikZ 相对定位/自定义样式，也不引入真引擎）。
实现**以语法面为准，不针对任何示例文档**（测试样例会变），验证全部用**合成语法**的纯函数单测。

#### ① `@startgantt` → Mermaid gantt（`src/modules/diagram-converters.js`）

| 支持的 PlantUML 语句 | 语义 |
|---|---|
| `Project starts <date>` | 基准起点。日期支持 ISO（`2024-01-01`、`2024/1/1`）与英文写法（`the 1st of January 2024`、`January 1, 2024`） |
| `[T] lasts N days\|weeks` | 工期（`takes` 同义） |
| `[T] starts <date>` / `starts at [U]'s end` / `starts at [U]'s start` / `starts N days after [U]'s end` | 起点（`before` 表负偏移） |
| `[T] ends <同上参照>` | 终点（并由工期反推起点） |
| `[T] happens at <date>` | 里程碑 → Mermaid `milestone` + `0d` |
| `[T] -> [U]` | 依赖：`U` 不得早于 `T` 结束 |
| `[T] is done` | 完成 → Mermaid `done` 标签 |
| `-- 分组 --` | 分组 → Mermaid `section` |
| `title …` | 标题 |

- **未给起点的任务按声明顺序接在前一任务之后** —— 这是 PlantUML gantt 的默认排布行为，不是我们的发明。
- 有意忽略（Mermaid 无对应语义，属表现层）：`skinparam` / `zoom` / `printscale` / `hide`、
  颜色（`is colored in …`）、星期开关（`saturday are closed`）。
- **推不出起点、或遇到子集外的任务语句 → 返回 `null`**（保留原代码块 + 提示），不猜、不静默丢弃。
- 顺带把 `@startjson` / `@startyaml` / `@startsalt` 明确判为 `unsupported`，避免它们落到某个图种
  分支里"被猜着转换"出看似成功却错误的结果。

#### ④ 「超出本地支持子集」→ 明确指出缺哪条语法

新增 `DiagramConverters.unsupportedHints(type, source)`：**只做关键字识别**，识别不到返回 `[]`
（不编造原因）。

| 使用点 | 变化 |
|---|---|
| `preview-post.js` 提示条 | `⚠ plantuml 未转换：超出本地支持的语法子集，已保留原始源码` → `⚠ plantuml 未转换：检测到未支持语法 @startjson，已保留原始源码` |
| `diagram-renderers.js` TikZ 报错 | 追加识别结果，如 `TikZ 解析失败：检测到未支持语法 自定义样式（.style=…）、相对定位（node distance / right of…）` |

特征表 —— plantuml：`@startjson` / `@startyaml` / `@startsalt`、活动图 `fork|split|repeat`、
时序图 `create|destroy`、`skinparam|!include|!define|!theme|!pragma`、`autonumber`；
tikz：`\begin{axis}`、`\matrix`、`\tikzset`、`.style=`、`\usetikzlibrary`、相对定位
（`node distance` / `right of…`）、弧线/贝塞尔/`to[…]`、`rotate|skew`、`\clip|\shade|\pattern|decorate`。
特征表集中在一处维护，避免"提示条"与"引擎报错"两处口径漂移。

**测试**：`test/diagrams.test.cjs` 31 → **41 例**（7 例甘特 + 3 例提示），含
「推不出起点 → null」「子集外语句 → null」「子集内不得乱报」这类**防猜断言**。本地 41/41 通过。

**仍未支持（本次有意不做）**：TikZ 相对定位（`node distance` / `right of`）与自定义样式
（`.style=` / `\tikzset`）—— 需要两阶段布局 pass，估 2–4 天，另行排期。

### 2.15 公式编号/引用增强（A 组：G1/G4/G5/G6）+ 导出侧引用实测（2026-09-23）

用户指定：先做 A 组，并把 G8 的三条实测一起出结论。实现仍按**语法面**（LaTeX 语义）为准，
验证用**合成语法**的纯函数单测。

#### A 组实现

| 项 | 内容 |
|---|---|
| **G1 自定义 `\tag` 的 label 可被引用** | 此前命中 `\tag{}` 就 `continue`，且在**注册 label 之前** → `\tag{3'}\label{eq:a}` 的 `\eqref{eq:a}` 只能得 `(?)`。现在：不占自动流水号，但**注册 label**（值为 tag 文本），引用显示 `(3')`。锚点分两个命名空间：自动编号 `eq-N`、自定义 tag `eql-<slug>`，避免 "3'" 与自动序号 3 撞 id |
| **G4 `\cref` / `\Cref` / `\autoref`** | `\cref{eq:a,eq:b,eq:c}` → `(1–3)`（连续 ≥3 压成 en dash；两个则 `(1, 2)`）；`\autoref` → `公式 (1)`（`opts.lang === 'en'` 时为 `Equation (1)`）；正文侧同样支持，且多标签**各自成链**、可分别点击 |
| **G5 引用诊断** | `assignEquationNumbers` 收集 `labels.warnings`：`undefined-ref` / `duplicate-label`（保留首次）/ `notag-label`（`\notag` 使 label 失效）/ `inline-label`（行内公式的 label 无意义），同 label 同类去重。`renderMarkdown` 完成时打一条控制台汇总；`unified-renderer` 另导出 `getEquationWarnings()` 供界面接入；正文里的未定义引用带 `title="未定义的标签：eq:x"` |
| **G6 点编号复制 `\eqref{label}`** | 新增 `data-eq-label`（label 名）与 `data-eq-anchor`（统一锚点）；预览给 KaTeX 的 `.tag` 绑点击 → 复制 `\eqref{eq:a}`（`navigator.clipboard`，失败退 `execCommand`，与代码块复制按钮同一套降级）。反馈为纯 CSS：`cursor: copy` + 悬停虚线框 + 复制后绿框（不注入文字，免 i18n） |

**测试**：`test/unified-math.test.cjs` 44 → **49 例**（G1 改写 1 例 + 新增 5 例：锚点与 label 名、
区间压缩、`\autoref` 中英、诊断去重、prose 多标签），本地 **49/49 通过**。

#### G8 三条实测结论

| 项 | 结论 | 依据 |
|---|---|---|
| ① **导出 HTML 的锚点** | **有，引用可跳转 —— 无需修补** | 导出走 `_clonePreviewForExport()`（= `this.preview.cloneNode(true)`），预览侧已把 `data-eq-anchor` 落成 `id`。实测两份导出产物：`href="#eq-` × 6、`class="eq-ref"` × 6、`<span class="math-display" … id="eq-1">`，且 `styles.css` 早有 `.math-display:target` 高亮规则 |
| ② **PDF 打印** | **理论保留**（同一份克隆 DOM，锚点 id 在），**内部链接能否点在 PDF 里由打印引擎决定 → 需真机点一次** | PDF 路径同用 `_clonePreviewForExport`；无 GUI 环境无法验证 |
| ③ **Word（.docx）** | **公式编号会丢、引用链接退化为纯文本 —— 真缺口（建议 B 组）** | `export-docx.js` 的 `elementToNode` 对 `.math-display` **只取 `.katex-mathml math`**（`runs: [{ mathml }]`），而 KaTeX 的 `\tag` 编号渲染在 **`.katex-html`** 侧的 `<span class="tag">` → 进不了 MathML → Word 里编号消失。修法：该分支在 `data-eq-number` / `data-eq-tag` 存在时追加一个文本 run（如 `(1)`） |

> ③ 的修法很小（一个分支内追加 run），但需真机导出一次看版式 —— 本次**先出结论、不动手**。

### 2.16 ③ Word 公式编号 + G10 表格引用 + C 组章节编号与设置（2026-09-23）

#### ③ Word 导出的公式编号（此前会整块丢失）

`export-docx.js` 的 `.math-display` 分支只取 `.katex-mathml` 的 `<math>`（Word 可编辑公式的来源），
而 KaTeX 的 `\tag` 编号渲染在 **`.katex-html`** 侧的 `<span class="tag">` → 编号进不了 MathML，
导出的 Word 里公式编号**整块消失**（预览 / 导出 HTML / PDF / PNG 都不受影响）。

| 文件 | 改动 |
|---|---|
| `src/modules/export-docx.js` | `elementToNode` 的 `.math-display` 分支：按 `data-eq-number` / `data-eq-tag` 追加一个文本 run（形如 ` (1)`）；`collectRuns` 补同规则分支，覆盖**表格单元格 / 提示块**里的公式块。没有编号属性的公式行为不变（KaTeX 未注入编号 → 不加任何东西） |
| `test/export-docx-nodes.test.cjs` | 新增 2 例：`math-display` 补编号（自动编号 / 自定义 `\tag` / 无编号三态）+ 表格单元格内的编号 |

> 引用链接在 Word 里仍是纯文本（docx 无文内锚点语义）—— 编号可见即可，链接不是 Word 的阅读方式。

#### G10 表格单元格里的 `\eqref`：**结论 = 本来就能用**，并补测试锁死

链路：`convertContainerTables → gfmTableToHtml → renderCellContent`（只做 `escapeHTML`，
**不动反斜杠**）→ 单元格里的 `\eqref{eq:a}` 以字面量进入最终 HTML → 第 7.3 步 `expandProseEqref`
统一展开（`<pre>`/`<code>` 仍跳过）。

`test/unified-math.test.cjs` 新增 2 例：单元格内的 `\eqref` 展开、`&amp;` 等实体不被改动、
单元格内的 `\cref` 多标签展开、`<code>` 内的命令原样保留。

#### C1 章节级编号（2.1）

| 位置 | 实现 |
|---|---|
| `unified-math.js` | `assignEquationNumbers(placeholders, { sectionAt })`：编号 = `节.序号`，**序号在节内重置**；`equationAnchor` 让章节号（`2.1`）也落在 `eq-` 命名空间 —— 锚点与引用链接由同一函数推导，永不失配 |
| `unified-math.js` | `buildSectionResolver(content)`：扫描标题（跳过围栏代码块），**以存在的最深章节级标题作前缀**（有 H2 用 H2，否则用 H1；H3+ 不参与，避免 (1.2.3.4)）；前缀取该级标题的**全局序号**（不随 H1 重置 —— 否则第 2 章第 1 节与第 1 章第 1 节会同号，引用歧义） |
| `unified-renderer.js` | `equationNumbering === 'section'` 时启用；扫描对象与 `guardMathBlocks` 是同一份文本，行号坐标系一致 |

#### C2 设置项

`设置 → 公式按章节编号（2.1）`（默认**关闭**，零破坏）：`settings.js` 默认值与面板读取/监听、
`index.html` 面板行、`i18n.js` 标签与提示、`i18n-data.js` 中英文案、
`preview-controller.js` 传 `equationNumbering: 'section' | 'global'`。

> **括号样式（`[1]`）不做**：公式右侧编号由 KaTeX 的 `\tag` 渲染，KaTeX 固定输出圆括号；
> 要支持方括号需自绘编号列（与 `align` 逐行编号同属 D 组那一档工作）。

**测试**：`test/unified-math.test.cjs` 51 → **55 例**（章节内重置、无章节回退全局、默认行为不变、
`buildSectionResolver` 的 H1/H2/围栏边界），本地 **55/55 通过**。

#### 范围决策（2026-09-23）：**D 组不做**

经确认，以下三项**不再列入待办**：

- `align` / `aligned` **逐行编号**（`(1a)(1b)`）；
- 顶层 `\begin{equation}` / `\begin{align}` / `\begin{gather}` 环境的预处理（KaTeX 不支持顶层 `align`）；
- 编号**括号样式**（`[1]`／靠左 `leqno`／起始值）—— 需自绘编号列，故放弃。

因此公式编号的**最终能力边界**为：全局连续编号 `(1)(2)(3)` 或章节级编号 `(2.1)`（设置项切换）、
自定义 `\tag{…}` 可用且其 label 可被引用、`\eqref` / `\ref` / `\cref` / `\Cref` / `\autoref`
交叉引用（正文与表格单元格内均可，含区间压缩 `(1–3)`）。

#### ② PDF 引用可点击 —— 真机验证清单（无 GUI 环境无法完成）

1. 打开含「由式 \eqref{eq:a} 可知」的文档，预览里点 `(1)` → 应高亮跳转到对应公式；
2. 导出 PDF（导出面板 → PDF）；
3. 用 PDF 阅读器（Edge / Adobe / Foxit）点正文里的 `(1)`：**能跳到公式所在页 = 通过**；
4. 若不能跳：属打印引擎未保留内部链接（不是本链路的问题），可在 D 组用「引用清单」兜底；
5. 顺带确认 Word 侧：公式右侧编号 `(1)` 已出现（③ 的修复），且公式仍可双击编辑。

### 2.17 修复：大文档（>5000 行 / >4 MB）导出残缺（2026-09-23）

**症状（用户报障）**：文档超过阈值后，预览只渲染当前位置附近约 1200 行（滑动窗口，预览本身没问题），
但导出的 HTML / PDF / PNG / Word **只包含那一段** —— 内容残缺、Word/PDF 版式错乱。

**根因**：四个导出路径全部基于 `preview.cloneNode(true)`（`export.js` 的 `_clonePreviewForExport`），
而大文档的预览 DOM 里**只有窗口那一段**（`PreviewController.render` 的 isLarge 分支把源码切成
`[win.start, win.end)` 再渲染）。导出侧此前**完全没有**对截断的处理 —— `_previewTruncated`
只被用来弹顶部横幅，等于「应用知道自己只渲染了一部分，却没告诉导出」。

| 文件 | 改动 |
|---|---|
| `src/controllers/preview-controller.js` | `isLarge` 增加 `!app._previewForceFull` 开关：导出可临时要求**全量渲染** |
| `src/modules/preview-window.js` | 新增纯函数 `shouldRenderFullForExport({ chars, lines, maxChars, maxLines, hasWindow })`（与预览同一套阈值，可零依赖单测） |
| `src/modules/export.js` | 新增 `_preparePreviewForExport()`：大文档时先询问（B）→ 置 `_previewForceFull` → 全量渲染 → 返回 `restore()`；`_clonePreviewForExport` 改为 **async**，克隆后**立即** `restore()`（克隆已脱离文档，恢复预览不影响后续处理）；四个导出入口补 `await` 与取消处理（Word 取消时一并 `clearTimeout(watchdog)`，否则 120s 后误报失败） |
| `src/modules/i18n-data.js` | 新增 4 个键（中英）：`exportLargeDocTitle / Message / Confirm / Cancelled` |

**B（确认框）**：首次遇到大文档导出时询问「直接导出只包含约 1200 行，是否先全量渲染？」
（确定 = 全量渲染并导出；取消 = **中止导出**，不会生成半截文件）；同一会话确认过之后不再追问。

| 测试 | 内容 |
|---|---|
| `test/preview-export-guard.test.cjs`（纯函数，本地可跑） | 窗口模式必定全量、行数/字符阈值、阈值注入、边界不算超、小文档直通 |
| `test/large-doc-export.test.cjs`（jsdom，CI） | ① 6000 行文档的导出克隆**必须包含文档末尾**（窗口模式不可能有），且导出后 `previewWindow` 恢复；② 取消 → 返回 `null` 且不开启全量渲染；③ 小文档直通、不弹框 |

> **已知取舍**：全量渲染大文档会明显卡顿（这正是滑动窗口存在的原因）—— 所以才有 B 的确认框，
> 而不是默默替用户渲染。若要彻底消除卡顿，需把「导出渲染」搬进离屏 DOM + 独立后处理链（成本高，
> 且容易与预览链漂移）。

### 2.18 修复：查看器跨文档残留 + 三处资源泄漏（「用久了卡、要重启才正常」）（2026-09-23）

用户报障两条：① 文档关闭后**五线谱仍浮在其他 md 的界面上**；② **偶发卡顿、重启才恢复**。
两条都属同一类问题：**该清理的没清理**。

#### ① 查看器（lightbox）跨文档残留

- **现象**：点图表（五线谱 / 任意图）放大后，关闭文档或切到别的 md，图形仍浮在最上层。
- **根因**：查看器挂在 `document.body` 上（`position:fixed; inset:0; z-index:9999`，见 `misc-ui.js`
  的 `showLightbox`），而
  1. 提示条上的 **× 只 `hint.remove()`，灯箱本身没关** —— 用户以为关掉了，其实还开着；
  2. 切标签 / 关标签 / 切视图模式**都不收**（全仓只有创建，没有"随文档切换关闭"）。
  又因为它持有的是图表的**克隆 SVG**（与预览 DOM 无关），所以关掉文档它也照样活着。
- **修法**：× 改为真正关闭；新增 `closeLightbox()`（登记 `_lightboxClose` 句柄、关闭后自清），
  在 `switchTab` / `closeTab` / `setViewMode` 三处调用；提示文案补上「或 × 关闭」。

| 文件 | 改动 |
|---|---|
| `src/modules/misc-ui.js` | × → 调 `closeRef()`；新增 `closeLightbox()`；`showLightbox` 登记/清理句柄；提示文案 |
| `src/modules/tabs.js` | `switchTab` / `closeTab` 开头调用 `closeLightbox()` |
| `src/modules/theme.js` | `setViewMode` 应用模式前调用 |

#### ② 三处资源泄漏（"越用越卡、重启才正常"）

| # | 泄漏 | 证据 | 修法 |
|---|---|---|---|
| 1 | **ECharts 实例注册表只增不减** | `chartRegistry`（`diagram-renderers.js`）只有"同容器重渲染时删自己"，**没有任何回收路径** → 每次重渲染产生的旧容器 + canvas + 实例被永久持有 | 新增 `diagramContainers` 登记所有渲染过的容器（含非 ECharts 引擎）；`disposeDetachedDiagrams(liveRoot)` 在**新内容写入 DOM 之后**调用，回收已脱离的那些 |
| 2 | **ResizeObserver 从不 disconnect** | `container._tizuResizeObserver = ro` 之后再无人调用 `disconnect()` → 一直持有已脱离 DOM 的容器 | 回收时 `disconnect()` + 句柄置空 |
| 3 | **远程图片 Blob URL 从不 revoke** | `image-processor.js` 兜底 fetch 分支 `img.src = URL.createObjectURL(blob)`；对比 `app.js` 的 `_imageURLCache` 有 LRU + revoke（这处是漏网的） | `trackInlineBlobUrl()`：超过 32 张回收最旧的（与 app.js 同策略） |

`disposeDetachedDiagrams` **只清不在当前预览 DOM 里的**容器（在 DOM 中的实例保持不动，避免每次
重渲染都重建、白卡一下）；回收时顺带清空容器内容，断开引擎内部（abcjs 的 responsive 监听、
markmap 的 d3-zoom、wavedrom 内部状态）对旧容器的引用链，使其可被 GC。

| 测试 | 内容 |
|---|---|
| `test/diagram-dispose.test.cjs`（纯 node，本地可跑） | 只回收脱离的、在 DOM 中的不动、ResizeObserver 必 disconnect、幂等、异常输入不抛错、渲染失败不登记 |
| `test/lightbox-close.test.cjs`（jsdom，CI） | × 真正关闭 + 还原 body 滚动、`closeLightbox()` 可用且句柄清空、三处接点守卫（防将来把调用删掉） |

> **仍未确诊的一类卡顿**：若真机表现为「**整窗冻住不动**」（而非逐渐变慢），属另一条路径
> （IPC / 后端请求挂起），需要 DevTools → Performance / Memory 抓一次现场才能定位。
> 本次修的是"逐渐变慢"这一类**确定成因**。

### 2.19 修复：Word 导出慢/假死 + 灯箱谱面尺寸 + 渲染期闪源码（2026-09-23）

用户报障：「Word 到处慢且无法导出」「**行数少的能导出、多了没反应**」「导出后界面假死、点 × 无效、
中文输入法打不进字」「五线谱浮在正文之上、压住标题与正文」。

#### ① Word 导出慢的真因：**已有的 SVG→PNG 快路被排在 html2canvas 之后**

`_prepareWordDOM` 的逐图循环里，SVG→PNG 的代码**早就存在**，但它挂在 `if (!dataUrl)` 下 ——
只有 html2canvas **失败**才轮到它。而 html2canvas 是整页样式重放，每张图 0.3–3 秒：
75 张图要跑几分钟，主线程全程被占（连 120s watchdog 都 fire 不了，所以连"导出失败"都不弹），
表现就是「没反应、只能任务管理器」。1 行文档没有图表，所以"能导出"。

| 改动 | 内容 |
|---|---|
| **换序** | 有 `<svg>` 就**先**走 `_svgToPngDataUrl`（毫秒级）；html2canvas 降为「无 SVG（ECharts canvas 等）或快路失败」的兜底 |
| **进度** | `_prepareWordDOM(clone, { control })` 每处理完一张图回调 `onProgress(done, total)`，提示层显示「正在处理图表 12/75（已用 8 秒）…」 |
| **预告** | 开工前显示「共 N 张图表，预计约 X 秒」 |
| **取消** | 提示层新增「取消导出」按钮：阶段之间（每张图一个 await 点）检查标志并中止，不再需要任务管理器 |

#### ② 灯箱里 abcjs 谱面"压住正文"（尺寸失配）

`prepareSvgForLightbox` 原判据是「有 width **或** height **或** viewBox 就算自带尺寸」→
abcjs 的 responsive 输出只有 viewBox（它把 width/height 删掉、并带 `preserveAspectRatio="xMinYMin"`）
也走了早返回 → 在查看器里占满视口、内容钉在左上角 —— 这正是「谱面浮在正文之上」的成因。
改为**只有 width+height 都具备**才早返回；只有 viewBox 的一类按实测尺寸补 width/height，
并把对齐改为 `xMidYMid meet`（居中、等比、不变形）。

#### ③ mermaid 渲染期"一会儿源码一会儿图"

`processMermaid` 命中缓存才直接出图；未命中时必须把源码写进容器（`mermaid.run` 依赖 textContent 解析），
渲染完成前用户看到的就是那段源码。现在渲染期加 `.diagram-pending`（文本透明 + 居中「图表渲染中…」占位），
渲染结束（成败均）摘掉 —— 失败时源码重新可见，便于排查语法。

**校验**：本地纯函数测试全绿（diagrams 41、unified-math 55、preview-export-guard 4、diagram-dispose 3）；
灯箱尺寸改动的既有用例（自带尺寸不动／靠 CSS 撑尺寸才补／量不到不猜）由 CI 跑。

---

## 3. 语法子集与已知偏差（审阅重点）

### 3.1 PlantUML / D2（→ Mermaid）
**支持**：PlantUML 类图（含 `as` 别名、构造型、成员可见性与类型重排、基数与关系标签、方向词）、
时序图（participant/actor、消息、`activate`、`alt/else/loop/opt/par/end`、单行与块注释）、
状态图（`[*]`、`state … as`、状态描述、转移标签）、活动图（`start/stop`、`:动作;`、
`if/elseif/else/endif`、`while/endwhile`）、思维导图（`*`/`+` 层级、`[#color]`）、组件与用例图、
**甘特图（见 §2.14）**；
D2：`direction`、`->` / `<-` / `<->` / `--`、`key: label`、`key.shape:`、嵌套块 → `subgraph`。

**不支持**（保留原代码块 + 顶部提示条，绝不静默丢弃）：PlantUML `@startwbs`（按思维导图近似）/
`@startjson` / `@startyaml` / salt、时序图 `create`/`destroy` 精确语义、活动图 `fork`/`split`/`repeat`；
D2 `style.*` / `class` / `icon` / `markdown` 块 / `vars` / `imports`。

**判定启发式**：`Idle --> Running : ev`（状态图）与时序图形态相近，故状态图优先用 `[*]` / `state`
关键字消歧；无消息文本的 `A -> B`（**单短横线**）判为时序图，`A --> B`（双短横线）保持类图关联。

### 3.2 TikZ
**支持**：`\draw` / `\fill` / `\filldraw` / `\node`、`--` 折线、`-- cycle`、`circle (r)`、
`rectangle (x,y)`、路径内联 `node[midway,above]{t}`、常用颜色与 `#rrggbb`、`thin/thick/very thick/
ultra thick`、`dashed/dotted/dash dot`、`->`/`<-`/`<->`、`fill=`/`draw=`/`opacity=`/`scale=`/
`line width=`；坐标裸数字按 cm 解析（与 TikZ 一致），支持 `pt/mm/cm/in` 后缀。
**不支持**：`\foreach`、`\matrix`、`\begin{axis}`（pgfplots）、弧线/贝塞尔参数、`rotate`/`skew`、
`\tikzset`、`\newcommand`、外部 `\usetikzlibrary`。
**已知限制**：` ```latex ` / ` ```tex ` 别名**未启用**（需按内容条件判定，会牵动
`diagramTypeFromLanguage` 的签名），普通 LaTeX 文档请勿用 ` ```tikz `。

### 3.3 plot
**支持**：`set title/xlabel/ylabel/xrange|yrange/grid/samples`、`plot <expr>[, <expr>…]`
（可带 `title "…"`、`with lines|points|linespoints`、`lc/color`）、`plot '-'` 后的数据行。
**表达式安全**：自研递归下降解析器，**不使用 `eval` / `new Function`**；支持
`+ - * / % ^`、一元正负、括号、隐式乘法（`2x`、`3(x+1)`）、`pi/e/tau` 与 sin/cos/…/`atan2`/`hypot`。

### 3.4 Admonition
1. **体后无空行时最多 +1 行**：结束标记需独占一行，实现会「借用」其后一个空行以保持总行数不变；
   无空行可借（块在文件末尾或紧跟非缩进文本）时 +1，其后内容的 `data-source-line` 整体偏移 1 行
   （影响跳转精度，不影响渲染正确性）。已有测试锁定该行为。
2. **`???` 折叠块默认收起** —— **已修复**（详见 §2.5）。原先会被 `preview-controller.js` 的
   「强制展开所有 `<details>`」逻辑拉平（`???` 与 `???+` 都展开）。修复后二者语义区分，
   且收起状态下图表尺寸仍正确（`withVisibleLayout` 临时展开祖先 `<details>`）。
   **导出侧按产物类型分区**（§2.6）：可交互的 **HTML 保持收起**，「默认收起」语义同样成立；
   固定版式的 **PDF / PNG / Word 一律展开**（遵循真实布局，收起即隐藏会丢内容）。

### 3.5 ECharts 3D —— **已决定放弃（2026-09-22 确认）**
`more-function` 用的是 **echarts `^6.1.0`**，而 `echarts-gl`（3D 系列）目前仍为 echarts 5 的
peer 依赖（`echarts ^5.1.2`）。强行加入 `echarts-gl` 会让 `npm ci` 因 peer 冲突失败 → CI 红。

**结论：不引入 `echarts-gl`，ECharts 保持 2D，主版本维持 v6。**
理由：为 3D 把 echarts 降到 `^5.6.0` 属于**主版本回退**，会牵动既有 2D 图表与导出快照
（`_snapshotEchartsForExport`）等已验证路径，风险与收益不匹配。

**后继注意**：若将来重启 3D，前置条件是 `echarts-gl` 发布支持 echarts v6 的版本；
在那之前**不要**往 `package.json` 加 `echarts-gl`，否则 `npm ci` 会直接失败。

---

## 4. 已完成的本地验证（无 npm 环境）

| 命令 | 结果 |
|------|------|
| `node --check`（13 个改动文件） | ✅ 全部通过 |
| `node scripts/check-globals.cjs` | ✅ 白名单含 `DiagramConverters` |
| `node scripts/check-version.mjs` | ✅ v1.2.3，8 处一致 |
| `node --test test/entry-scripts.test.cjs` | ✅ 5/5（脚本清单双向一致） |
| `node --test test/diagrams.test.cjs` | ✅ 23/23 |
| `node --test test/unified-math.test.cjs` | ✅ 26/26 |
| `node --test test/unified-admonitions.test.cjs` | ✅ 20/20 |
| **`node --test test/diagram-engines.test.cjs`（他们的既有测试）** | ✅ **9/9，未回归** |
| 菜单模板 ↔ 转换器联调（9 个模板） | ✅ 全部被正确认领 |

## 5. 需要在 CI（有 node_modules）确认的项

- [x] lock 与 package.json 不一致的问题已解决（`package-lock.json` 由 CI 的 `sync-lock` 回推，
      已含 `d3` / `markmap-lib` / `markmap-view` 及其传递依赖）
- [x] `npm ci` 实际安装成功 —— CI run `35734868590`（commit `bc67c72`）全绿；与 echarts v6 的
      peer 关系未触发冲突（lock 由 `npm install` 生成）
- [x] `npm run prepare` 成功，产出及 `src/lib/markmap/*` —— 由 `npm ci` 生命周期触发，CI 未报错
- [x] `npm run check`（全部门禁）全绿 —— 同上（`Coupling & global-export guards` 步骤）
- [x] `npm test` 全量全绿 —— 同上（`Run tests` 步骤）
- [ ] 手工冒烟（`npm run dev`）：依次插入并预览 PlantUML / D2 / TikZ / plot / Markmap / 编号公式 /
      siunitx / Admonition；确认 ECharts / Graphviz 等既有引擎仍正常
- [x] `??? note` 折叠块默认收起 —— 已修复并由 `test/admonition-collapse.test.cjs` 自动覆盖（§2.5）
