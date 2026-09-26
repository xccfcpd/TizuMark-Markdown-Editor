# TizuMark 架构文档

> 本文记录 TizuMark 桌面 Markdown 编辑器的模块边界、架构决策（ADR-1~ADR-8）、
> IPC 收敛契约、构建链路与耦合护栏。它是「优化方案」（`docs/architecture-optimization-plan.md`）
> 执行后的权威落地说明，与代码现状保持一致。
>
> 最近一次架构优化：P0 全系列 + P1-1~P1-9 + P2-1~P2-4 + highlight.js 升级（见 `git log --oneline`）。

---

## 1. 技术栈与运行模型

- **Tauri v2** 桌面壳 + **原生 CodeMirror 5.65.x**（非 CM6）+ 原生 JS，主逻辑 `src/app.js`（~6500 行）。
- 预览渲染：`unified` + `remark-parse` + `remark-gfm` + `rehype-raw` + `rehype-sanitize`，
  经 `scripts/build-renderer.mjs`（esbuild）打包为 `src/lib/unified-bundle.js`（单一真相源 `src/unified-renderer.js`）。
- 前端为**经典 `<script>` 全局模式**：`src/app.js` 等以普通 `<script>` 加载，依赖
  `window.CodeMirror` / `window.hljs` / `window.katex` 等浏览器全局，**非 ESM 模块图**。
- 后端 Rust：`#[tauri::command]` 共 **20** 个，由 `generate_handler!` 注册（位于 `src-tauri/src/lib.rs`）。
- CSP：`script-src 'self' 'unsafe-inline' 'unsafe-eval'`，无 `script-src-elem` 限制（见 ADR-4）。

---

## 2. 源码边界

```
src/
├── app.js                  # 主程序（上帝对象，按 ADR-3 Strangler 渐进拆分中）
├── index.html              # 入口；模块脚本清单（硬约束：src/modules 每增一个文件须在此加 <script>）
├── unified-renderer.js     # 预览渲染单一真相源 → 打包为 lib/unified-bundle.js
├── modules/                # 纯模块（白名单全局，见 §6）
│   ├── tauri-api.js        # ★ 唯一 IPC 边界（ADR-1）
│   ├── image-processor.js  # processImages 纯函数 + DI（P1-1）
│   ├── preview-window.js   # _isBlockStart + _computePreviewWindow 两纯函数（ADR-2）
│   ├── code-block.js / dialogs.js / outline.js / word-count.js / find-replace.js / preview-post.js
├── controllers/            # Strangler 门面（ADR-3）
│   └── preview-controller.js  # 收编 updatePreview 编排 + 5 个虚拟窗口方法（P2-1）
└── lib/                    # 浏览器 vendor + 生成产物（见 §5）
src-tauri/
└── src/lib.rs             # Rust 命令（20 个）+ 已退役的僵尸渲染链（ADR-6）
```

### 2.1 `src/modules/` —— 纯模块（白名单全局）
每个模块**恰好一个**命名空间全局，且必须延迟挂在 `window` 上（双导出：
`if (window!==undefined && typeof module==='undefined') window.X = ...` +
`if (module && module.exports) module.exports = ...`）。
新增全局是 deliberate 动作，须同步更新 `scripts/check-globals.cjs` 的 `KNOWN_GLOBALS`
（见 §6）——护栏显式知情，而非默默放行。

### 2.2 `src/controllers/` —— Strangler 门面（ADR-3）
`PreviewController` 收编 `updatePreview` 编排与 N7 表遗留的 5 个虚拟窗口方法
（`_buildWindowLineTops` / `_focusPreviewToLine` / `_renderPreviewWindowBlock` /
`_updateVirtualScrollMetrics` / `_syncPreviewVirtualScroll`）。
app 侧字段/方法统一经 `this.app` 访问，控制器自有方法走 `this`，真·全局沿用 `window`。
整文件包 IIFE（避免与 app.js 同名顶层 `const` 在经典 `<script>` 全局词法环境撞车），
仅经 `window.PreviewController` 暴露。`app.js` 保留薄委托，调用点零改动（全迁后删除）。

### 2.3 `src/lib/` —— vendor + 生成产物
- `unified-bundle.js`：由 `build:renderer` 生成，gitignore。
- `codemirror/` `katex/` `mermaid/` `html2canvas.min.js` `markdown-it.min.js`：
  由 `ensure-vendor` 从 `node_modules` 确定性再生，gitignore（ADR-8）。
- `highlight.js/`（整套）：由 `ensure-vendor` 从 node_modules 再生（esbuild 三路兼容打包
  11.11.1 + 样式/语言子目录），gitignore（2026-08-01 起，见 §8）。

### 2.4 `src-tauri/` —— Rust 后端
`generate_handler!` 注册 20 个命令。IPC 契约由 ADR-1 前端侧收敛 + Rust 侧反向锁定。

---

## 3. 架构决策记录（ADR）

### ADR-1：IPC 收敛到 `src/modules/tauri-api.js`，并用 Rust 侧反向锁定契约
- **Status**：Accepted
- **决策**：所有 `invoke` 调用唯一收敛于 `tauri-api.js`，语义**空操作**——
  `resolve` 原样返回、`reject` 原样抛出、不 `try/catch`、不包装、**不做会抛异常的参数校验**。
  唯一允许的守卫：`window.__TAURI__` 缺失时抛明确错误（此路径下本无 Rust 错误可保）。
  模块做了延迟 eval + `window.TauriApi` + `module.exports` 双导出（防 harness 全局污染）。
- **理由**：P0-2b 前 `tauri-api` 包装错误会让 `_mapReadFileError` 的 `JSON.parse` 失败，
  五类文件错误静默塌缩成 `E_IO`（见 §4）。
- **反向锁定**：Rust 侧解析 `generate_handler!` 块（非属性宏扫描，否则会多算僵尸命令），
  校验命令名集合；前端 46 处 `invoke` 全是字面量单引号命令名。

### ADR-2：虚拟窗口只抽两个纯函数，其余留待 Strangler
- **Status**：Accepted（纠正 R1）
- **决策**：`preview-window.js` 只搬 `_isBlockStart` + `_computePreviewWindow`（N7），常量参数注入；
  有状态的 `_renderPreviewWindowBlock` 等**不抽**，留待 ADR-3 Strangler。
- **理由**：避免抽取中途误搬有状态方法导致回滚风险。

### ADR-3：上帝对象拆分走 Strangler Fig，禁止 big-bang
- **Status**：Accepted
- **决策**：每 PR 迁一批到 `src/controllers/`，每批必跑竞态测试（`render-generation`）。
  首批（P2-1）只收编 `updatePreview` + 5 虚拟窗口方法，保留薄委托。

### ADR-4：ESM 仅用于 release 打包，dev 保持源码即运行
- **Status**：完整落地（2026-08-01）
- **决策**：`scripts/build-frontend.mjs` 把前端聚合到 `dist/`（release 产物目录，资源聚合拷贝）；
  `tauri.conf.json` 设 `devUrl = http://localhost:1420` + `beforeDevCommand` 起
  `scripts/dev-server.mjs`（静态 serve `src/`），`frontendDist = ../dist`。
  经典 `<script>` 全局模式在 dev server 下完全可用，**不需要 ESM 化**即可实现
  dev/release 分离；ESM 化/压缩属后续可选项，不做也不影响分离机制。
  注：CSP 的 `unsafe-eval` 未移除。2026-09-26 全树实测（在 `src/` 下搜 `new Function(` / `eval(`）：
  CodeMirror 5 与 mermaid **均未命中** —— 原记录把它们列为"待确认对象"，方向有误；真正命中的是
  `src/lib/wavedrom/wavedrom.min.js`、`src/lib/echarts.min.js`、`src/lib/docx.min.js`、
  `src/lib/highlight.js/languages/julia.js`。故移除该条目需先替换/隔离这几个引擎（或逐一实测
  命中点确属死分支/仅构建期），属独立改动。在此之前它是有明确责任方的已知偏差，而非"待查项"。

### ADR-5：构建产物「缺失即可见」，而非静默降级
- **Status**：Accepted
- **决策**：`ensure-vendor` 校验缺失即报错退出（fail-fast）；`unified-bundle.js` 缺失时
  `build-frontend` 明确报错提示先 `build:renderer`。

### ADR-6：Rust 侧僵尸渲染实现退役
- **Status**：Accepted
- **决策**：删除 `render_markdown` 及 11 个专属辅助链（sanitize_html / find_char / find_str /
  decode_numeric_entities / contains_dangerous_protocol / sanitize_tag_attributes /
  extract_abbreviations / embed_abbr_data / guard_math_blocks / restore_math_blocks /
  preprocess_markdown）+ ~44 个死测试。`#[tauri::command]` 21→20。
  XSS 净化责任完全前移到 `unified-renderer.js` 的 `sanitizeHTML`，
  由 `test/render.test.cjs` 的 7 个断言承接（C12）。

### ADR-7：护栏先落地为本地 npm script，CI 单列为显式工作项
- **Status**：Accepted
- **决策**：`check-globals` / `coupling-report` / `entry-scripts` / `tauri-api` 先作本地可执行脚本，
  聚合为 `npm run check`；CI 见 P1-8。**不引入 ESLint**（成本不成比例）。
  无 CI 前全量测试靠手动 `npm test`（N20）；`run-tests.cjs` 无 argv 过滤，日常「只跑相关」
  是绕过运行器直跑单文件（已建 P0-0f 给运行器加过滤，把入口拉回守护内）。

### ADR-8：vendor 锁定（沿用 `5f5b23e` 范式）
- **Status**：Accepted
- **决策**：`scripts/ensure-vendor.mjs` 从 `node_modules` 确定性再生 6 个库
  （codemirror / highlight.js / katex / mermaid / html2canvas / markdown-it），接入 `prepare`，
  对应子目录加 `.gitignore`。比「删 src/lib 改 npm 导入」更可逆。
  `highlight.js` 与其余 5 库同规再生（11.11.1，esbuild 三路兼容），不再例外（2026-08-01）。

---

## 4. IPC 收敛契约（铁律）

1. **唯一边界**：`src/app.js` 中不得出现裸 `invoke(`（耦合报告硬卡 == 0）；
   不得出现裸 `window.__TAURI__.*`（P1-5 后默认硬卡，仅 `tauri-api.js` 允许）。
2. **reject 原样透传**：`app.js` 调用 `tauriApi.xxx()` → `invoke(cmd, args)`，
   reject 值**必须原样**交给 `_mapReadFileError`（其 `JSON.parse` Rust 原始 JSON 取 `kind`）。
   任何包装（`new Error('[cmd] '+e)`）或会抛的参数校验都会让 parse 失败 → 五类错误静默塌缩成 `E_IO`。
   `error-handling.test.cjs` 直测 `_mapReadFileError`，故包装退化现有测试查不出，须靠 ADR-1 硬约束防住。
3. **命令名字面量**：前端 46 处 `invoke` 全为字面量单引号命令名（零动态构造）；
   Rust 侧 `generate_handler!` 注册 20 个，二者必须一一对应。
4. **plugin 收敛**：`plugin:*` 本质是 `core.invoke`，归 P0-2b 收敛为 `tauriApi.updater/dialog/webview.*`；
   P1-5 只收 `shell/event/app/window/path`。两条清单互斥。

---

## 5. 构建链路

| 步骤 | 脚本 / 命令 | 产物 | 触发 |
|------|------------|------|------|
| 渲染 bundle | `npm run build:renderer` → `build-renderer.mjs` | `src/lib/unified-bundle.js` | `dev`/`build`/`pretest`/`prepare` |
| vendor 再生 | `npm run prepare` 串 `ensure-vendor.mjs` | `src/lib/{codemirror,katex,mermaid,highlight.js,...}` | `npm install`（prepare 钩子） |
| 前端聚合 | `npm run build-frontend` → `build-frontend.mjs` | `dist/`（release 产物目录） | `beforeBuildCommand`（tauri build 前） |
| dev server | `scripts/dev-server.mjs`（静态 serve `src/`） | — | `beforeDevCommand`（`tauri dev` 前，devUrl=localhost:1420） |
| 全量守护 | `npm run check` | — | 本地 + CI |
| 测试 | `npm test`（`pretest` 先 `build:renderer`）→ `run-tests.cjs` | — | 本地 + CI |

`package.json` 关键脚本：
```json
"build:renderer": "node scripts/build-renderer.mjs",
"prepare": "node scripts/build-renderer.mjs && node scripts/ensure-vendor.mjs",
"pretest": "node scripts/build-renderer.mjs",
"test": "node scripts/run-tests.cjs",
"check": "node scripts/check-globals.cjs && node scripts/coupling-report.cjs && node scripts/check-version.mjs && node test/entry-scripts.test.cjs && node test/tauri-api.test.cjs"
```
`tauri.conf.json`：`beforeDevCommand: "node scripts/dev-server.mjs"`，`devUrl: "http://localhost:1420"`，
`beforeBuildCommand: "npm run build:renderer && npm run build-frontend"`，`frontendDist: "../dist"`。

---

## 6. 耦合护栏（`npm run check`）

七个硬门，任一失败即非零退出：

1. **check-globals**：`src/modules/*.js` 的全局导出必须 ∈ 白名单 **且每模块恰好一个**命名空间。
   白名单（9）：`CodeBlock` `Dialogs` `Outline` `WordCount` `FindReplace` `PreviewPost`
   `PreviewWindow` `TauriApi` `ImageProcessor`。新增模块须同步更新 `KNOWN_GLOBALS`。
2. **coupling-report [2]**：`src/app.js` 中 `invoke(` 残留 **== 0**（硬卡）。
3. **coupling-report [3]**：`window.__TAURI__` 残留，P1-5 后默认 **硬卡**（仅 `tauri-api.js` 允许；
   `--no-strict` 可临时降级）。
4. **coupling-report [4]**：`updatePreview` fan-in（`this.` 引用数）作为趋势基线；
   P2-1 后收敛为 `PreviewController.render()` 薄委托，fan-in 显著下降，仍监控回归。
5. **entry-scripts**：`src/modules/` 与 `src/index.html` 脚本清单必须一致（每增模块须加 `<script>`）。
6. **tauri-api**：契约测试（命令名、双导出、reject 透传）。
7. **check-version**：`scripts/check-version.mjs` 以 `package.json` 为基准校验其余 8 处发布相关版本号
   （Cargo.toml / tauri.conf.json / app.js×2 / index.html / README×2 / release-notes.js / update json）。

> 信息项：`coupling-report --changed <file>` 列出单文件改动连坐的测试（>3 告警，不阻断）。

### 性能基线（关键优化）
- **N17**：`computePreviewWindow` 端扫描 O(n²)→O(n)（前缀和栅栏奇偶），单 call ≈ **0.92ms**
  （原 ~25ms 估），由 `test/preview-window.test.cjs` 行为锁定。
- **N16**：NaN 穿透陷阱——`Math.max(0, Math.min(x, n))` 对 NaN 透明，归一化放读取侧 +
  模块入口，用 `Number.isFinite`（非 `|| 0`，后者会误替换合法 0）。

---

## 7. 测试分层

- **纯模块单测**（不加载 app.js）：`image-processor` / `preview-window` 等独立验证。
- **集成 / headless harness**（`test/helpers/app-env.cjs`）：jsdom + 真实 CM5 + 从 `app.js`
  正则抽方法绑实例。`buildEnv` 必须 `await`；eval `app.js` 前先 eval `src/lib/md-links.js`
  与 `src/controllers/*` 与 `src/modules/*`（否则 `isMarkdownLink` / `TauriApi` 未定义）。
- **渲染/事件委托测试**必须真实 eval `unified-bundle.js` + 真实 click 事件，禁游离 fakeCheckbox 直调。
- **jsdom realm 注意**：jsdom `window.eval` 创建对象的 `Object.prototype` 与主 realm 不同，
  用字段级断言而非 `deepStrictEqual`；JSON 往返 key 序会变，亦用字段级断言。
- **本地只跑改动相关文件**（绕过 `run-tests.cjs` 直跑单文件=绕过前置守护，故 P0-0f 已补 argv 过滤）。

---

## 8. 已知偏差与待办

1. ~~ADR-4 未完整切换~~ **已完整落地（2026-08-01）**：dev server（`scripts/dev-server.mjs` + `devUrl`）
   + `frontendDist = ../dist` 已生效。经典 `<script>` 全局模式在 dev server 下无需 ESM 化即可分离；
   CSP 的 `unsafe-eval` 未移除 —— 阻塞方已实测为 wavedrom / echarts / docx / highlight.js(julia)；
  CodeMirror 5 与 mermaid 实测干净（原记录方向有误），详见 ADR-4 注。
2. **highlight.js 已升级 11.11.1（2026-08-01）**：纳入 `ensure-vendor` 再生（esbuild 三路兼容
   window/globalThis/module.exports），A/B 验证 10 种语言 9 种输出完全一致、typescript 为增强、
   语言覆盖 +8；历史「4 例退化」根因是打包形状与 loadHljs 不兼容而非版本差异（详见 git log）。
3. ~~Rust 侧 4 个 dead_code 警告~~ **已清理（2026-08-01）**：`count_backtick_prefix` /
   `contains_html_tag` / `process_inline_markdown` / `parse_alert` 为 P1-7 退役僵尸渲染时
   漏删的辅助链，已从 `lib.rs` 移除（1472→1114 行），`cargo check --no-default-features` 零警告。
4. **全量测试策略**：无 CI 前的全量靠手动 `npm test`；P1-8 CI 已建，可在 push/PR 时自动门禁。
5. **安全与可用性收口（2026-08-01 全工程审查）**：12 项修复全部落地并补测试（+11 用例）：
   - 脚注 XSS：`renderFootnotes` 改走 `unifiedToHtml` 最小管线（sanitize 后不再拼 raw 定义；
     顺带修复脚注定义内 markdown 显示为字面量的缺陷）；mermaid `securityLevel` loose→strict；
     确认框 message innerHTML→textContent（4 调用方去 `<b>`/`<p>`，index.html 加 pre-line）。
   - capabilities 移除未使用的 5 项 fs 插件权限（`fs:default/allow-read-file/write-file/read-all/write-all`，
     前端零调用 plugin:fs，文件读写全走自定义命令），新增 `test/capabilities.test.cjs` 契约锁定。
   - 健壮性：查找高亮 `range.setEnd` 越界钳制；空标题 id 点击守卫；`_imageURLCache` Blob URL
     改 LRU（上限 64 + beforeunload 全量 revoke）。
   - 性能：find-prev 改用 `cm.indexFromPos/posFromIndex`（原全文 split O(n²)）；
     `_computedPosition` 加 `_scrollSyncDirty` 守卫（滚动热路径仅在内容/布局变化时重建，
     权威调用点传 `force=true`）。
   - 工程：`check-version` 版本一致性校验接入 `npm run check`；release.js 去硬编码路径 +
     GITEE_TOKEN 缺失检查；CI 增加 build-frontend 冒烟。
   - 遗留低风险（非本次范围）：`formatShortcutDisplay` 的 `<kbd>${k}</kbd>` 未转义——
     k 为用户自录 KeyboardEvent.key，不含 `<`，无实际攻击面。

---

## 9. 提交策略（本次优化）
分阶段自动提交（用户授权，本次不 push）：P0 → P1-1~P1-9 → P2-1/P2-2/P2-3，每阶段独立 commit，
push 待用户确认。历史曾因 `git stash` 损坏 refs，已从完好工作树重建提交（见 `git log`）。
