// 图片后处理：将预览 HTML 中的 <img> 解析为可在 Tauri WebView 直接显示的 src。
// 从 app.js 的 processImages 抽取（P1-1），改为纯函数 + 依赖注入，便于单测、
// 降低改动爆炸半径，并让「代际检查」这一关键并发护栏可被直接断言。
//
// 依赖通过 deps 注入，不隐式读取全局 this：
//   - preview: 预览容器元素（含 <img> 结构）
//   - deps.activeTab: 当前 tab（读 filePath / isBundled）
//   - deps.imageCache: base64 缓存 Map（对应原 app.js 的 this._imageBase64Cache）
//   - deps.tauri: 封装了 fetchImageAsBase64 / readBundledImageAsBase64 的对象（注入 TauriApi）
//   - deps.getCachedImageURL: (dataUri) => objectURL，对应原 app.js 的 getCachedImageURL
//   - deps.getRenderGeneration: () => number，对应原 app.js 的 this._renderGeneration
//
// ⚠️ 既有铁律（与 app.js 同源，抽取不得改写）：
//   仅 isBundled tab 在「本地 fetch_image_as_base64 失败」后才回退 read_bundled_image_as_base64；
//   普通本地文档（有 filePath 但非 isBundled）绝不回退，避免误加载打包资源里同名文件。
//
// ⚠️ 代际检查（共 7 处：2 次捕获 + 5 次校验）原样保留，全部经注入的 getRenderGeneration() 读取。
//   抽取后这些站点不再隐式依赖 this，单测可直接驱动 getRenderGeneration 使其「过期」验证提前返回。

function mimeOf(s) {
  const ext = s.split('.').pop().toLowerCase();
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'gif') return 'image/gif';
  if (ext === 'svg') return 'image/svg+xml';
  if (ext === 'webp') return 'image/webp';
  return 'image/png';
}

function fail(img) {
  // 清除有效 src → 浏览器才会渲染 alt 文本（有效 data URI 下 alt 不显示）。
  img.removeAttribute('src');
  img.style.border = '1px solid #d00';
  img.style.backgroundColor = 'rgba(208,0,0,0.06)';
  img.alt = (img.alt || '') + ' [加载失败]';
}

// 兜底 fetch 图片得到的 Blob URL 回收队列。
// 历史 bug：只 createObjectURL、从不 revoke → 每次重渲染（打字/切主题/切文件）都多留一份
// 图片数据在 WebView 里，长会话内存只增不减（用户报「用久了莫名卡顿、要重启才正常」）。
// 策略与 app.js 的 _imageURLCache 一致：超上限就回收最旧的（保留最近若干张，避免刚用完就被释放）。
const INLINE_BLOB_URL_MAX = 32;
const inlineBlobUrls = [];
// 该 Blob URL 是否仍被文档里的 <img> 引用 —— 被引用的**绝不回收**，
// 否则图片会当场裂开。历史 bug：只按数量裁剪，同一屏显示的图超过上限时最早的 URL 被撤销，
// 于是「原来正常的图片回归」（用户 2026-09-24 报障）。
function blobUrlInUse(url) {
  if (!url || typeof document === 'undefined' || !document.querySelector) return false;
  try {
    return !!document.querySelector('img[src="' + String(url).replace(/"/g, '\\"') + '"]');
  } catch (_e) {
    return false;
  }
}
function trackInlineBlobUrl(url) {
  if (!url) return url;
  inlineBlobUrls.push(url);
  // 超出上限才考虑回收，且只在"已不被任何 <img> 使用"时真回收；
  // 仍在用的放回队尾，等它从 DOM 消失后的下一轮再处理（guard 防死循环）。
  let guard = 0;
  while (inlineBlobUrls.length > INLINE_BLOB_URL_MAX && guard++ < inlineBlobUrls.length) {
    const old = inlineBlobUrls.shift();
    if (blobUrlInUse(old)) { inlineBlobUrls.push(old); continue; }
    try {
      if (typeof URL !== 'undefined' && URL.revokeObjectURL) URL.revokeObjectURL(old);
    } catch (_e) { /* 回收失败不影响显示 */ }
  }
  return url;
}

// 还原 unified 渲染器对非 ASCII 路径做的 percent-encode（如 图片/截图.png → %E5%9B%BE...）。
// 若不解码直接拿编码串去 Rust 读盘会找不到真实文件 → 裂图。纯 ASCII 路径解码为 no-op；
// 含非法转义序列（如字面量 % 非转义）时容错返回原串，避免抛错中断整张图处理。
function safeDecodeURI(s) {
  if (typeof s !== 'string' || s.indexOf('%') === -1) return s;
  try {
    return decodeURIComponent(s);
  } catch (e) {
    return s;
  }
}

// 已可显示的内联 / 远程资源，直接跳过（与原 app.js 一致）
const SKIP_PREFIXES = ['data:', 'http://', 'https://', 'blob:'];

// 1×1 透明像素：在异步读取磁盘图片之前，先同步把 img.src 替换为此占位，
// 阻止浏览器对相对路径（如 screenshots/*.png）发起 HTTP 请求到 dev server，
// 避免 dev 模式下大量 404 噪音（dev-server 仅 serve src/，不含 screenshots/）。
const TRANSPARENT_PIXEL = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

async function processImages(preview, deps) {
  const {
    activeTab,
    imageCache,
    tauri,
    getCachedImageURL,
    getRenderGeneration,
  } = deps;

  // 代际检查 #1（捕获）+ #2（校验）：进入即快照，若此刻已过期直接返回。
  const gen = getRenderGeneration();
  if (gen !== getRenderGeneration()) return;

  const filePath = activeTab ? activeTab.filePath : null;
  // Windows 长路径前缀（\\?\）清理：Rust resolve/canonicalize 返回的路径（如 read_bundled_file
  // 的 path 字段）带 \\?\ 前缀。若直接 dir + '/' + rawSrc 会拼出 \\?\D:\...\dir/file 的
  // 混合分隔符路径——Path::canonicalize 对 \\?\ 前缀路径要求全反斜杠，混入 '/' 即报
  // os error 123 语法不正确。去掉前缀后普通路径允许混合分隔符，读取恢复正常。
  const rawDir = filePath ? filePath.replace(/[/\\][^/\\]*$/, '') : '';
  const dir = rawDir.startsWith('\\\\?\\') ? rawDir.slice(4) : rawDir;

  // 按「绝对路径」缓存 base64 data URI：innerHTML 每次重渲染会把 img.src 重置为原始路径，
  // 无缓存时每次打字都要 invoke 跨 IPC 读磁盘。命中缓存后零磁盘 IO（实测省 ~100ms）。
  // reloadFile / 文件外部变更时由调用方清缓存。
  const loadBase64 = async (loadUrl, mime) => {
    let dataUri = imageCache.get(loadUrl);
    if (dataUri) return dataUri;
    const base64 = await tauri.fetchImageAsBase64({ url: loadUrl });
    dataUri = `data:${mime};base64,${base64}`;
    imageCache.set(loadUrl, dataUri);
    return dataUri;
  };

  const images = Array.from(preview.querySelectorAll('img'));
  // 有界并发（默认 6）：文档含上百张图片时不再一次性并发全部 fetch / IPC 读盘，
  // 避免主线程被请求峰值拖死（与导出内联同源的稳定性修复）。每个 img 仍独立做代际检查，
  // 中途若发生重渲染（代际过期），后续待处理项会在各自校验点短路返回。
  const processOne = async (img) => {
    let src = img.getAttribute('src');
    if (!src) return;
    // 已可显示的内联 / 远程资源直接跳过
    if (SKIP_PREFIXES.some((p) => src.startsWith(p))) return;

    // ★ 同步占位：在任何 await 之前立即替换 src，阻止浏览器对原始相对/绝对路径
    // 发起 HTTP 请求（dev 模式下 dev-server 仅 serve src/，screenshots/ 等会 404；
    // file:// 则被 CSP 拦截）。原始值已存入局部变量 src / rawSrc，后续不受影响。
    img.src = TRANSPARENT_PIXEL;

    // 代际检查 #3（重新捕获）：每个 img 处理前再快照，避免长列表下前序 IO 期间已被重渲染。
    const gen = getRenderGeneration();
    // file:// 协议：去掉前缀，当作绝对路径处理（demo.md 声明支持 file:// 写法）
    let rawSrc = src.startsWith('file://') ? src.replace(/^file:\/\//, '') : src;
    // 关键修复：中文/非 ASCII 路径被渲染器 percent-encode，必须解码还原成真实路径再读盘。
    rawSrc = safeDecodeURI(rawSrc);
    // 绝对路径（Unix /... 或 Windows D:/...）：直接走 Rust 读磁盘
    if (rawSrc.startsWith('/') || /^[a-zA-Z]:[/\\]/.test(rawSrc)) {
      try {
        const dataUri = await loadBase64(rawSrc, mimeOf(rawSrc));
        // 代际检查 #4（校验）
        if (gen !== getRenderGeneration()) return;
        img.src = getCachedImageURL(dataUri);
      } catch (e) {
        console.warn('[preview] Failed to load image:', rawSrc, e);
        fail(img);
      }
      return;
    }
    // 相对路径
    if (filePath) {
      // 普通文件：相对当前 .md 所在目录补全
      const absPath = dir + '/' + rawSrc;
      // 用绝对路径 key（dir/rawSrc）缓存，避免 absPath 重复 IO
      const cacheKey = absPath;
      try {
        const base64 = await tauri.fetchImageAsBase64({ url: absPath });
        // 代际检查 #5（校验）
        if (gen !== getRenderGeneration()) return;
        const dataUri = `data:${mimeOf(rawSrc)};base64,${base64}`;
        imageCache.set(cacheKey, dataUri);
        img.src = getCachedImageURL(dataUri);
      } catch (e) {
        // 仅打包资源 tab（使用说明/demo）回退到资源定位命令：dev 模式从项目根、
        // prod 模式从资源目录读。普通本地文档不回退——避免本地缺图时误加载
        // 打包资源里恰好同名的文件（如用户自己的 assets/icon.png）。
        if (activeTab && activeTab.isBundled) {
          try {
            const base64 = await tauri.readBundledImageAsBase64({ filename: rawSrc });
            // 代际检查 #6（校验）
            if (gen !== getRenderGeneration()) return;
            const dataUri = `data:${mimeOf(rawSrc)};base64,${base64}`;
            imageCache.set(cacheKey, dataUri);
            img.src = getCachedImageURL(dataUri);
            return;
          } catch (e2) { /* 落到统一失败处理 */ }
        }
        console.warn('[preview] Failed to load image:', rawSrc, e);
        fail(img);
      }
      return;
    }
    // 打包文档（使用说明 / demo，activeTab.isBundled=true）：相对资源由 _openBundledFile
    // 记录真实资源路径。优先走打包资源定位命令 read_bundled_image_as_base64（按 dev 项目根 /
    // prod 资源目录解析），避免页面相对 fetch（404 噪音且图片出不来）。
    if (activeTab && activeTab.isBundled) {
      try {
        const base64 = await tauri.readBundledImageAsBase64({ filename: rawSrc });
        // 代际检查 #6b（打包回退校验）
        if (gen !== getRenderGeneration()) return;
        const dataUri = `data:${mimeOf(rawSrc)};base64,${base64}`;
        imageCache.set(rawSrc, dataUri);
        img.src = getCachedImageURL(dataUri);
        return;
      } catch (e2) { /* 落到下面的兜底 fetch */ }
    }
    // 最后兜底：尝试页面相对 fetch（通常 404，仅作最后努力）
    try {
      const resp = await fetch(rawSrc);
      if (!resp.ok) { fail(img); return; }
      const blob = await resp.blob();
      // 代际检查 #7（校验）
      if (gen !== getRenderGeneration()) return;
      img.src = trackInlineBlobUrl(URL.createObjectURL(blob));
    } catch (e) {
      console.warn('[preview] Failed to load image:', rawSrc, e);
      fail(img);
    }
  };
  const CONCURRENCY = 6;
  let cursor = 0;
  const worker = async () => {
    while (cursor < images.length) {
      const i = cursor++;
      await processOne(images[i]);
    }
  };
  const pool = [];
  const n = Math.min(CONCURRENCY, images.length);
  for (let k = 0; k < n; k++) pool.push(worker());
  await Promise.all(pool);
}

// 浏览器：作为独立 <script> 加载，挂到全局 ImageProcessor（与 CodeBlock 一致）。
// 注意：模块加载顺序无关，仅依赖注入的 deps，不读任何全局状态。
if (typeof window !== 'undefined' && typeof module === 'undefined') {
  window.ImageProcessor = { processImages, mimeOf, fail, TRANSPARENT_PIXEL };
}
// Node（测试 / 构建）：CommonJS 导出
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { processImages, mimeOf, fail, TRANSPARENT_PIXEL };
}
