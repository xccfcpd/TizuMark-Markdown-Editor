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
| `test/diagrams.test.cjs` | ~230 | 23 例：PlantUML(6 图种) / D2 / TikZ / plot / 表达式解析器安全 / 语言路由 |
| `test/unified-math.test.cjs` | ~250 | 26 例：siunitx 展开 / 编号 / `\eqref` / `\tag` 注入 |
| `test/unified-admonitions.test.cjs` | ~250 | 20 例：语法解析 / 反缩进 / 行数中立 / 嵌套 / 防注入 |
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

---

## 3. 语法子集与已知偏差（审阅重点）

### 3.1 PlantUML / D2（→ Mermaid）
**支持**：PlantUML 类图（含 `as` 别名、构造型、成员可见性与类型重排、基数与关系标签、方向词）、
时序图（participant/actor、消息、`activate`、`alt/else/loop/opt/par/end`、单行与块注释）、
状态图（`[*]`、`state … as`、状态描述、转移标签）、活动图（`start/stop`、`:动作;`、
`if/elseif/else/endif`、`while/endwhile`）、思维导图（`*`/`+` 层级、`[#color]`）、组件与用例图；
D2：`direction`、`->` / `<-` / `<->` / `--`、`key: label`、`key.shape:`、嵌套块 → `subgraph`。

**不支持**（保留原代码块 + 顶部提示条，绝不静默丢弃）：PlantUML `@startgantt` / `@startwbs` /
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
2. **`???` 折叠块默认收起**：`more-function` 的 `preview-controller.js` 中「强制展开所有
   `<details>`」的逻辑**未改动** —— 若该逻辑存在且未排除 admonition，折叠块会被强制展开。
   **待 CI/手工确认**：若发现 `???` 一进来就是展开的，需要把该选择器加上
   `:not([data-admonition])`（本次未改，避免与他们的 `<details>` 相关修复冲突）。

### 3.5 ECharts 3D —— **未实现（需要你决策）**
`more-function` 用的是 **echarts `^6.1.0`**，而 `echarts-gl`（3D 系列）目前仍为 echarts 5 的
peer 依赖（`echarts ^5.1.2`）。强行加入 `echarts-gl` 会让 `npm ci` 因 peer 冲突失败 → CI 红。
因此**本次未加入 echarts-gl**，ECharts 仅 2D。
可选方案（需你定）：① 将 echarts 降到 `^5.6.0` 再加 `echarts-gl`；② 等 echarts-gl 支持 v6；
③ 放弃 3D。**在未确认前不建议动依赖版本**。

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
- [ ] `npm ci` 实际安装成功（**注意与 echarts v6 的 peer 关系**：lock 由 `npm install` 生成，
      若存在 peer 冲突会在此处暴露）
- [ ] `npm run prepare` 成功，产出 `src/lib/markmap/markmap.min.js`
- [ ] `npm run check`（全部门禁）全绿
- [ ] `npm test` 全量：重点观察 `render.test.cjs`、`unified-renderer.test.cjs`、`mhchem.test.cjs`、
      `demo-features.test.cjs`（alert 与 admonition 共存）、`preview-post-math*.test.cjs`、
      `export-*.test.cjs`、`slash-order.test.cjs`、`slash-command.test.cjs`、`i18n.test.cjs`、
      `diagram-engines.test.cjs`
- [ ] 手工冒烟（`npm run dev`）：依次插入并预览 PlantUML / D2 / TikZ / plot / Markmap / 编号公式 /
      siunitx / Admonition；确认 ECharts / Graphviz 等既有引擎仍正常
- [ ] 手工确认 `??? note` 折叠块默认是否收起（见 §3.4 第 2 点）
