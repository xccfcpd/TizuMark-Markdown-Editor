/**
 * runtime.js —— 运行时环境探测与诊断辅助（唯一真相源）
 *
 * 存在意义：本应用同时跑在两种宿主下 —— 生产（Tauri WebView，有真实布局与帧调度）与
 * 测试（node + jsdom，不做布局、无 rAF）。业务代码不该各自去猜宿主能力：
 *   ① jsdom 不做布局：documentElement 宽度恒为 0、offsetParent 恒为 null。
 *      若直接拿 offsetParent 当"元素是否可见"的判据，会把"预览可见"一律判成"已隐藏"
 *      （2026-09-26 实测：状态栏预览字数永不更新，word-count 用例直接变红）。
 *   ② jsdom 无 requestAnimationFrame（或与浏览器语义不一致）："等一帧再跑重活"的
 *      写法若只依赖 rAF，Promise 会永远 pending。
 * 此前这两类判断散落在 notify.js / settings.js 等处，各带一份解释性注释；现统一收口到
 * 本模块 —— 业务侧只表达意图（"是否真的可见" / "等一帧"），宿主差异与降级理由集中在此，
 * 避免同一个坑被反复踩、也避免"生产代码里到处 if (测试环境)"的隐性耦合。
 *
 * 设计约束（与 ARCHITECTURE.md §2.1 一致）：
 *   - 纯模块，恰好一个全局命名空间 RuntimeEnv，延迟挂载；
 *   - 顶层不触碰 document / window，harness 里 require / eval 均不抛错；
 *   - 所有函数对缺失的宿主能力做**降级**，绝不抛异常。
 *
 * UMD：浏览器挂 window.RuntimeEnv，node 走 module.exports（供 test 引用）。
 */
(function () {
  'use strict';

  // 宿主是否真的在做布局。判据：documentElement 的布局宽度 > 0。
  // jsdom / 纯 node 下 getBoundingClientRect() 恒返回 0，故为 false。
  // 注意：本函数只回答"宿主是否提供布局信息"，**不**代表页面当前可见
  //（生产环境窗口最小化时 documentElement 宽度也可能为 0，但那与"有没有布局能力"无关）。
  function hasLayout(doc) {
    const d = doc || (typeof document !== 'undefined' ? document : null);
    const docEl = d && d.documentElement;
    if (!docEl || typeof docEl.getBoundingClientRect !== 'function') return false;
    try {
      return docEl.getBoundingClientRect().width > 0;
    } catch (_) {
      return false;
    }
  }

  // 「元素在真实布局下是否可见」。
  // 有布局能力：按 offsetParent 判断（与浏览器一致，display:none / 祖先隐藏时为 null）；
  // 无布局能力（jsdom）：**一律视为可见** —— 那种环境不存在"元素被隐藏但 DOM 很大"的浪费
  // 场景，而误判为隐藏会让功能静默失效（见文件头 ①）。
  function isVisibleInLayout(el) {
    if (!el) return false;
    if (!hasLayout(el.ownerDocument)) return true;
    return el.offsetParent !== null;
  }

  // 等一帧 paint，供"先画 spinner、再跑重活"这类需要让出主线程的场景。
  // 有 rAF：rAF 回调在 paint **之前**执行，故再 await 一个宏任务 setTimeout(0)（排在其后），
  //   保证重活一定发生在首帧 paint 之后 —— spinner 才真的能被用户看到（原 settings.js 注释所述问题：
  //   spinner 的 innerHTML 写完后紧接同步重活，会把首帧 paint 推迟到重活之后，loading 只闪一帧）。
  // 无 rAF（jsdom）：退化为固定 ~16ms，保证 Promise 一定 resolve，不依赖宿主的帧调度。
  function whenPainted() {
    return new Promise((resolve) => {
      if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(() => setTimeout(resolve, 0));
      } else {
        // 宿主没有 requestAnimationFrame：按约一帧时长降级，语义不变（仍让出主线程）。
        setTimeout(resolve, 16);
      }
    });
  }

  // 诊断：同一标签只告警一次（防热路径刷屏），但**不无声**。
  // 用于"尽力而为、失败可接受"的分支：这类分支此前多写成 `catch (_) {}`，
  // 出错后既无 UI 提示也无日志，排查时只剩"功能没反应"；保留一次 console.warn 作为唯一线索。
  // 注意：仅用于确实可忽略的失败（如需让用户感知，仍应走 reportError / showToast）。
  const warned = new Set();
  function warnOnce(tag, err) {
    if (warned.has(tag)) return;
    warned.add(tag);
    if (typeof console !== 'undefined' && console && typeof console.warn === 'function') {
      console.warn('[TizuMark] ' + tag + ' 失败（同一标签仅提示一次）:', err);
    }
  }

  const api = { hasLayout, isVisibleInLayout, whenPainted, warnOnce };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.RuntimeEnv = api;
})();
