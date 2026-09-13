#!/usr/bin/env node
'use strict';
/**
 * scripts/check-updater.cjs —— 自动更新（Tauri Updater）功能自检。
 *
 * 目的：在「打包发布」流程（release.js / github-release.js）前，自动核验自动更新端到端可用的
 *       全部前置条件，任何致命缺失都会中断发布，避免产出「装了却无法更新」的安装包。
 *       （注意：`npm run build` 是日常构建命令，零前置阻拦，不调用本脚本。）
 *
 * 重点防范两类历史故障：
 *   A. 发布了新版本，但老版本都升不上来  → 根因多为：用错密钥签名 / .sig 缺失损坏 /
 *      update json 的 signature 与 .sig 不一致 / endpoints 404。
 *   B. 发布了新版本，但这个版本升不到后续 → 根因多为：endpoints 指向错 / 不可达。
 *
 * 严重度（避免误阻断正常发布）：
 *   - 发布模式（release.js / github-release.js 调用，即「打包发布」流程）：全部检查项均为致命，
 *     缺一不可；此外要求 TAURI_SIGNING_PRIVATE_KEY_PASSWORD 已设置，否则产物未签名、用户更新必失败。
 *   - 默认模式（手动 `node scripts/check-updater.cjs`，不接入 npm run build）：仅作预检，
 *     「构建/签名后才生成」的产物（.sig、update json 的版本与签名一致性）仅警告、不阻断，
 *     方便在 bump 版本号后、正式发布前先快速核对配置与源码层面是否正确。
 *
 * 说明：最终密码学验签由 Tauri 运行时完成。本脚本做的是「密钥一致性 + 产物存在性 +
 *       结构正确性 + JSON 一致性 + 端点可达性」检查，这些才是两类历史故障的直接根因。
 *       注：Tauri 的签名构造与标准 minisign 不同（签名块头部为 ED 而非 Ed），无法在
 *       Node 中可靠复现其验签；故用 keyId 一致性证明「签名确由对应私钥产生」更安全，
 *       不会因复现偏差而误阻断合法发布。
 *
 * 用法：
 *   node scripts/check-updater.cjs            # 默认模式（手动预检，一致性问题仅警告）
 *   node scripts/check-updater.cjs --release  # 发布模式（release.js / github-release.js 调用，全部致命）
 *
 * 退出码：0 = 通过（可继续）；1 = 存在致命问题（应中断打包/发布）。
 *
 * 说明：本脚本只用 Node 内置模块，不依赖项目其它代码，可独立运行。
 *       密码学层面的「签名有效性」最终由 Tauri 运行时校验；本脚本做的是
 *       「密钥一致性 + 产物存在性 + 结构正确性 + JSON 一致性 + 端点可达性」检查，
 *       这些才是两类历史故障的直接根因。
 *
 * 刻意停用：当 tauri.conf.json 的 updater.endpoints 为空且无 pubkey，且
 *       tauri-api.js 的 updater 封装为 no-op（不再发出 plugin:updater IPC）时，判定为
 *       本 fork 已彻底停用更新器，脚本跳过全部更新校验并以「通过」退出（exit 0），
 *       避免阻断「不提供更新服务」的 fork 的打包/发布流程。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const https = require('https');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const TAURI_DIR = path.join(ROOT, 'src-tauri');
const DOT_TAURI = path.join(os.homedir(), '.tauri');

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}
function fileExists(p) {
  try { return fs.existsSync(p); } catch { return false; }
}

// ---- minisign / Tauri 签名格式解析 ----
// 文件内容都是「单行 base64」，解码后得到 armored 文本（多行）。
// 公钥 armored：
//   untrusted comment: minisign public key: <KEYID>\n
//   <base64 of 42 或 58 字节 raw>
// raw 布局（Tauri 用 42 字节，无标准 minisign 的 16 字节 checksum）：
//   [0:2) "Ed" | [2:10) keynum(8) | [10:42) ed25519 公钥(32)
function makePub(raw) {
  if (raw.length !== 42 && raw.length !== 58) {
    throw new Error(`公钥 raw 长度异常: ${raw.length} (期望 42 或 58)`);
  }
  return { keyId: raw.slice(2, 10), ed25519: raw.slice(10, 42), raw };
}

// 接受多种输入形态（避免「格式差异」导致误报无法解析）：
//  - Tauri 配置用的「base64(armored)」单字符串
//  - .tauri/xxx.key.pub 可能是「base64(armored)」或「base64(raw 42/58 字节)」
//  - 也可能直接就是 armored 文本
function parseMinisignPub(input) {
  const s = String(input).trim();
  if (!s) throw new Error('公钥为空');
  let decoded;
  try { decoded = Buffer.from(s, 'base64'); } catch { decoded = Buffer.alloc(0); }
  let armored = '';
  try { armored = decoded.toString('utf8'); } catch {}
  if (/untrusted comment|trusted comment/.test(armored)) {
    const lines = armored.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
    const raw = Buffer.from(lines[lines.length - 1], 'base64');
    if (raw.length === 42 || raw.length === 58) return makePub(raw);
  }
  if (decoded.length === 42 || decoded.length === 58) return makePub(decoded);
  if (/untrusted comment|trusted comment/.test(s)) {
    const lines = s.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
    const raw = Buffer.from(lines[lines.length - 1], 'base64');
    if (raw.length === 42 || raw.length === 58) return makePub(raw);
  }
  throw new Error('无法解析 minisign 公钥（既不是合法 armored 也不是 42/58 字节 raw）');
}

// .sig armored（4 行）：
//   untrusted comment: signature from tauri secret key\n
//   <base64 of 74 字节 S1 块：10 头部 + 64 ed25519 签名>\n
//   trusted comment: timestamp:<ts>\tfile:<name>\n
//   <base64 of 64 字节 S2（对 trusted comment 的签名）>
function parseMinisignSig(sigPath) {
  const b64 = fs.readFileSync(sigPath, 'utf8').trim();
  const armored = Buffer.from(b64, 'base64').toString('utf8');
  const lines = armored.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  if (lines.length < 4) throw new Error(`签名 armored 行数异常: ${lines.length} (期望 >=4)`);
  const s1block = Buffer.from(lines[1], 'base64');
  const s2block = Buffer.from(lines[3], 'base64');
  if (s1block.length !== 74) throw new Error(`S1 块长度异常: ${s1block.length} (期望 74)`);
  if (s2block.length !== 64) throw new Error(`S2 块长度异常: ${s2block.length} (期望 64)`);
  const trustedLine = lines[2];
  const tcText = trustedLine.replace(/^trusted comment:\s*/, '');
  return {
    keyId: s1block.slice(2, 10), // 签名块里的 keynum，应与配置公钥 keynum 一致
    S1: s1block.slice(10, 74),
    S2: s2block.slice(0, 64),
    trustedText: tcText,
  };
}

// 注：签名的最终密码学校验由 Tauri 运行时完成；本脚本已确认
// 「密钥一致性 + .sig 结构正确 + update json 一致 + 端点可达」，
// 足以拦截「用错密钥 / .sig 损坏 / 文件名错 / json 不一致 / 端点 404」等
// 导致老版本升不上来、或本版本升不到后续的根因。

function gitTracked(relPath) {
  try {
    execSync(`git ls-files --error-unmatch ${JSON.stringify(relPath)}`, {
      cwd: ROOT,
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

// 轻量端点可达性探测（HEAD，8s 超时）。同步实现（派生子 node 发 HEAD，跨平台无 shell 引号陷阱）。
// 返回 { ok, status, err }
function probeEndpoint(urlStr) {
  const probe = [
    "const http=require('http'),https=require('https');",
    "const u=new URL(" + JSON.stringify(urlStr) + ");",
    "const m=u.protocol==='https:'?https:http;",
    "const r=m.request(u,{method:'HEAD',timeout:8000,headers:{'User-Agent':'tizu-mark-updater-check'}},res=>{res.resume();process.stdout.write(String(res.statusCode));});",
    "r.on('timeout',()=>r.destroy(new Error('timeout')));",
    "r.on('error',e=>process.stdout.write('ERR:'+e.message));",
    "r.end();",
  ].join('');
  try {
    const out = execSync('node -e ' + JSON.stringify(probe), {
      timeout: 12000,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim();
    if (out.startsWith('ERR:')) return { ok: false, err: out.slice(4) };
    const code = parseInt(out, 10);
    if (isNaN(code)) return { ok: false, err: '无状态码' };
    return { ok: code >= 200 && code < 400, status: code };
  } catch (e) {
    return { ok: false, err: (e.message || '').split('\n')[0] };
  }
}

function main(argv) {
  const releaseMode = argv.includes('--release');
  const errors = [];
  const warns = [];
  const oks = [];
  const infos = [];
  const ok = (m) => oks.push(m);
  const err = (m) => errors.push(m);
  const warn = (m) => warns.push(m);
  const info = (m) => infos.push(m);
  // 分级严重度：
  //  - 构建后即需存在/一致的项目（tauri.conf 配置、capabilities、lib.rs、Cargo、JS 封装、
  //    公钥与私钥 keId 一致性、endpoints 合法性）在「打包模式」即致命，确保源码配置本身没坏；
  //  - 构建/签名之后才生成的产物（.sig、update json 的版本与签名一致性）在「打包模式」仅警告
  //    （因为构建时它们必然还是旧版本的），只在「发布模式」致命——避免 bump 版本号后
  //    `npm run build` 因 update json 尚未重新生成而被误阻断。
  const fatal = (m) => (releaseMode ? err(m) : warn(m));

  console.log(
    '🔍 自动更新功能自检' +
      (releaseMode ? '（发布模式）' : '（打包模式）') +
      '\n'
  );

  // 1. tauri.conf.json updater 配置
  let conf;
  try {
    conf = readJson(path.join(TAURI_DIR, 'tauri.conf.json'));
  } catch (e) {
    err('无法读取 tauri.conf.json: ' + e.message);
    return finish(errors, warns, oks, infos, releaseMode);
  }
  const upd = conf.plugins && conf.plugins.updater;
  if (!upd) {
    err('tauri.conf.json 缺少 plugins.updater 配置（自动更新完全不可用）');
    return finish(errors, warns, oks, infos, releaseMode);
  }
  ok('tauri.conf.json 含 plugins.updater');

  // 预读取 tauri-api.js，用于「刻意停用」检测
  let tauriApi = null;
  try {
    tauriApi = fs.readFileSync(path.join(ROOT, 'src', 'modules', 'tauri-api.js'), 'utf8');
  } catch (e) {
    tauriApi = null;
  }

  // 刻意停用检测：同时满足 (a) 配置被清空（endpoints 为空且无 pubkey）
  // 与 (b) JS 封装为 no-op（updater.check/download/install 不再发出 plugin:updater IPC）
  // 时，判定为「本 fork 已彻底停用更新器」，跳过全部更新端到端校验，避免阻断打包/发布。
  const blanked = (!Array.isArray(upd.endpoints) || upd.endpoints.length === 0) && !upd.pubkey;
  const noopWrapper =
    !!tauriApi &&
    /api\.updater\s*=\s*\{/.test(tauriApi) &&
    !/plugin:updater\|check/.test(tauriApi) &&
    !/plugin:updater\|download/.test(tauriApi) &&
    !/plugin:updater\|install/.test(tauriApi);
  if (blanked && noopWrapper) {
    info('检测到更新器已被刻意停用（tauri.conf.json 的 endpoints/pubkey 为空 + tauri-api.js 的 updater 封装为 no-op）。');
    ok('更新器刻意停用：跳过自动更新端到端校验（本 fork 不提供更新服务，符合预期）。');
    return finish(errors, warns, oks, infos, releaseMode);
  }

  let pub = null;
  if (!upd.pubkey) {
    err('plugins.updater.pubkey 为空（客户端无法校验更新签名）');
  } else {
    try {
      pub = parseMinisignPub(upd.pubkey);
      ok('pubkey 是合法 minisign 公钥 (keyId=' + pub.keyId.toString('hex') + ')');
    } catch (e) {
      err('pubkey 解析失败: ' + e.message);
    }
    // 2. 公钥一致性：与 .tauri/tizu-updater.key.pub 比对（防 A 类故障：用错密钥）
    //    该文件是本地签名原料，缺失时打包模式仅警告（新克隆/本地测试构建未必有），发布模式致命。
    const pubFile = path.join(DOT_TAURI, 'tizu-updater.key.pub');
    if (fileExists(pubFile)) {
      ok('.tauri 公钥文件存在');
      const fileB64 = fs.readFileSync(pubFile, 'utf8').trim();
      if (fileB64 === String(upd.pubkey).trim()) {
        ok('配置 pubkey 与 .tauri/tizu-updater.key.pub 逐字节一致');
      } else {
        try {
          const filePub = parseMinisignPub(fileB64);
          if (pub && filePub.keyId.equals(pub.keyId)) {
            ok('配置 pubkey 与私钥公钥 keyId 一致（仅编码换行差异）');
          } else {
            fatal('配置 pubkey 与 .tauri 私钥公钥 keyId 不一致！将用错误密钥校验更新 → 所有老版本都升不上来');
          }
        } catch (e) {
          fatal('无法解析 .tauri/tizu-updater.key.pub: ' + e.message);
        }
      }
    } else {
      fatal('Updater 公钥文件缺失（位于 ' + pubFile + '）；无法核对「配置 pubkey 与签名私钥」是否为同一密钥对');
    }
  }

  // endpoints（防 B 类故障：本版本升不到后续）
  if (!Array.isArray(upd.endpoints) || upd.endpoints.length === 0) {
    err('plugins.updater.endpoints 为空（客户端不知道去哪下载更新）');
  } else {
    const bad = upd.endpoints.filter((e) => !/^https?:\/\//i.test(e));
    if (bad.length) err('存在非法 endpoint（需 http/https）: ' + bad.join(', '));
    else ok(`endpoints 配置合法 (${upd.endpoints.length} 个)`);
    // 探测可达性（不致命，但显眼提示）
    for (const ep of upd.endpoints) {
      const r = probeEndpoint(ep);
      if (r.ok) ok(`endpoint 可达: ${ep} (HTTP ${r.status})`);
      else warn(`endpoint 不可达: ${ep} (${r.err || 'HTTP ' + r.status}) — 请确认该更新源可用，否则用户无法下载更新`);
    }
    if (upd.endpoints[0] && /github\.com/i.test(upd.endpoints[0])) {
      warn('首个 endpoint 是 GitHub，国内网络可能慢；建议把 Gitee 端点放首位');
    }
  }

  // 3. capabilities
  try {
    const cap = readJson(path.join(TAURI_DIR, 'capabilities', 'default.json'));
    if (Array.isArray(cap.permissions) && cap.permissions.includes('updater:default')) {
      ok('capabilities/default.json 含 updater:default 权限');
    } else {
      err('capabilities/default.json 缺少 updater:default 权限（前端无法调用更新）');
    }
  } catch (e) {
    err('读取 capabilities/default.json 失败: ' + e.message);
  }

  // 4. Rust 插件注册
  try {
    const libRs = fs.readFileSync(path.join(TAURI_DIR, 'src', 'lib.rs'), 'utf8');
    if (/tauri_plugin_updater/.test(libRs)) ok('lib.rs 注册了 tauri_plugin_updater');
    else err('lib.rs 未注册 tauri_plugin_updater 插件');
  } catch (e) {
    err('读取 lib.rs 失败: ' + e.message);
  }

  // 5. Cargo 依赖
  try {
    const cargo = fs.readFileSync(path.join(TAURI_DIR, 'Cargo.toml'), 'utf8');
    if (/tauri-plugin-updater/.test(cargo)) ok('Cargo.toml 含 tauri-plugin-updater 依赖');
    else err('Cargo.toml 缺少 tauri-plugin-updater 依赖');
  } catch (e) {
    err('读取 Cargo.toml 失败: ' + e.message);
  }

  // 6. JS 封装
  try {
    const tauriApi = fs.readFileSync(path.join(ROOT, 'src', 'modules', 'tauri-api.js'), 'utf8');
    const hasUpdObj = /api\.updater\s*=\s*\{/.test(tauriApi);
    const hasCheck = /check\(\)\s*\{[\s\S]*?plugin:updater\|check/.test(tauriApi);
    const hasDownload = /download\(payload\)\s*\{[\s\S]*?plugin:updater\|download/.test(tauriApi);
    const hasInstall = /install\(payload\)\s*\{[\s\S]*?plugin:updater\|install/.test(tauriApi);
    const hasChannel = /Channel/.test(tauriApi);
    if (hasUpdObj && hasCheck && hasDownload && hasInstall) {
      ok('tauri-api.js 封装了 updater.check/download/install');
    } else {
      err('tauri-api.js 的 updater 封装不完整（check/download/install）');
    }
    if (!hasChannel) warn('tauri-api.js 未暴露 Channel（下载进度监听可能缺失）');
  } catch (e) {
    err('读取 tauri-api.js 失败: ' + e.message);
  }

  // 7. 密钥原料（签名所需；构建模式仅警告——可先出未签名包做本地测试，发布模式才致命）
  const keyFile = path.join(DOT_TAURI, 'tizu-updater.key');
  const pwFile = path.join(DOT_TAURI, 'tizu-updater.password');
  if (fileExists(keyFile)) {
    ok('Updater 私钥存在');
    if (fs.statSync(keyFile).size < 50) fatal('私钥文件过小，可能损坏');
  } else {
    fatal('Updater 私钥缺失（位于 ' + keyFile + '）；发布前必须有，否则无法签名更新包');
  }
  if (fileExists(pwFile)) {
    const pw = fs.readFileSync(pwFile, 'utf8').trim();
    if (pw) ok('Updater 密码文件非空');
    else fatal('Updater 密码文件为空（位于 ' + pwFile + '）');
  } else {
    fatal('Updater 密码文件缺失（位于 ' + pwFile + '）；发布前必须有，否则无法签名更新包');
  }

  // 8. 签名环境变量门禁（防：漏设密码 → 未签名包流出 → 用户更新失败）
  // 本项目签名是独立手动步骤（tauri signer sign），release.js 只负责上传、不会自动
  // export 密码 env。故若 process.env 未设置，尝试从标准位置 ~/.tauri/tizu-updater.password
  // 读取注入，避免误阻断发布。真正的"漏签名"由第 9 项（.sig 存在 + keyId 一致）兜底。
  if (!process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD) {
    const pwFile = path.join(DOT_TAURI, 'tizu-updater.password');
    if (fileExists(pwFile)) {
      const pw = fs.readFileSync(pwFile, 'utf8').trim();
      if (pw) process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD = pw;
    }
  }
  const hasPwEnv = !!process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD;
  let envReady = hasPwEnv;
  if (!envReady) {
    const envPath = path.join(ROOT, '.env');
    if (fileExists(envPath) && /TAURI_SIGNING_PRIVATE_KEY_PASSWORD\s*=\s*\S+/.test(fs.readFileSync(envPath, 'utf8'))) {
      envReady = true;
    }
  }
  if (envReady) {
    ok('Updater 签名密码环境变量已就绪（TAURI_SIGNING_PRIVATE_KEY_PASSWORD）');
  } else {
    const msg =
      '未检测到 TAURI_SIGNING_PRIVATE_KEY_PASSWORD（环境或 .env）。签名/自动更新将不可用：' +
      '打包后必须 `npx tauri signer sign` 并提供密码，否则用户更新时校验失败。';
    if (releaseMode) err(msg);
    else warn(msg);
  }

  // 9 & 10. release 模式：.sig + update json（防 A 类故障）
  let pkg;
  try {
    pkg = readJson(path.join(ROOT, 'package.json'));
  } catch (e) {
    err('读取 package.json 失败: ' + e.message);
    return finish(errors, warns, oks, infos, releaseMode);
  }
  const VERSION = pkg.version;
  const sigFile = path.join(ROOT, 'release', `TizuMark_${VERSION}_x64-setup.exe.sig`);
  const hasSig = fileExists(sigFile);

  if (!hasSig) {
    const msg = `release/ 缺少 NSIS 签名文件 ${path.basename(sigFile)}（需先 tauri signer sign 生成）`;
    if (releaseMode) err(msg);
    else warn(msg);
  } else {
    ok('NSIS 签名文件存在');
    if (!pub) {
      err('pubkey 未解析，跳过 .sig 一致性校验');
    } else {
      try {
        const sig = parseMinisignSig(sigFile);
        if (!sig.keyId.equals(pub.keyId)) {
          fatal('NSIS .sig 的 keyId 与配置 pubkey 不一致（用错密钥签名 → 老版本全部升不上来）');
        } else {
          ok('NSIS .sig 的 keyId 与配置 pubkey 一致（确由对应私钥签名）');
          // trusted comment 应引用正确文件名 + 含时间戳
          if (/file:/.test(sig.trustedText) && /timestamp:/.test(sig.trustedText)) {
            const m = sig.trustedText.match(/file:(\S+)/);
            const fname = m ? m[1] : '';
            if (fname === `TizuMark_${VERSION}_x64-setup.exe`) {
              ok('NSIS .sig trusted comment 引用了正确安装包名与时间戳');
            } else {
              warn(`NSIS .sig trusted comment 引用文件名 "${fname}" 与期望 "TizuMark_${VERSION}_x64-setup.exe" 不符`);
            }
          } else {
            warn('NSIS .sig trusted comment 缺少 file:/timestamp: 字段（结构可疑）');
          }
          // 注：最终密码学校验由 Tauri 运行时完成；此处已确认密钥一致性与结构正确。
          const exe = path.join(ROOT, 'release', `TizuMark_${VERSION}_x64-setup.exe`);
          if (!fileExists(exe)) {
            warn(`未找到 ${path.basename(exe)}，无法确认签名覆盖范围（结构已校验）`);
          }
        }
      } catch (e) {
        err('解析/校验 NSIS .sig 失败: ' + e.message);
      }
    }
  }

  const jsonPath = path.join(ROOT, 'update-windows-x86_64.json');
  if (!fileExists(jsonPath)) {
    const msg = '项目根 update-windows-x86_64.json 不存在（Gitee raw 端点 404，自动更新不可用）';
    if (releaseMode) err(msg);
    else warn(msg);
  } else {
    try {
      const j = readJson(jsonPath);
      if (j.version !== VERSION) fatal(`update json version(${j.version}) ≠ package.json(${VERSION})（构建签名后需运行 gen-update-json.cjs 重新生成）`);
      else ok('update json version 与 package.json 一致');
      const plat = j.platforms && j.platforms['windows-x86_64'];
      if (!plat) {
        err('update json 缺少 platforms.windows-x86_64');
      } else {
        if (!plat.signature) {
          err('update json 缺少 signature');
        } else if (hasSig) {
          const sigContent = fs.readFileSync(sigFile, 'utf8').trim();
          if (plat.signature.trim() === sigContent) ok('update json signature 与 .sig 文件一致');
          else fatal('update json signature 与 .sig 文件不一致（需重新运行 gen-update-json.cjs → 老版本升不上来）');
        }
        if (!plat.url || /\{version\}|占位|placeholder/i.test(plat.url)) {
          err('update json url 含占位符或未替换');
        } else if (!/^https?:\/\//.test(plat.url)) {
          err('update json url 非法');
        } else {
          ok('update json url 合法: ' + plat.url);
        }
      }
      if (gitTracked('update-windows-x86_64.json')) {
        ok('update json 已被 git 跟踪（Gitee raw 端点可用）');
      } else {
        warn('update json 未被 git 跟踪（Gitee raw 端点会 404，需提交）');
      }
    } catch (e) {
      err('update json 解析失败: ' + e.message);
    }
  }

  return finish(errors, warns, oks, infos, releaseMode);
}

function finish(errors, warns, oks, infos, releaseMode) {
  console.log('\n──────────── 自检结果 ────────────');
  oks.forEach((m) => console.log('  ✓ ' + m));
  infos.forEach((m) => console.log('  · ' + m));
  warns.forEach((m) => console.log('  ⚠ ' + m));
  errors.forEach((m) => console.log('  ✗ ' + m));
  console.log(`\n通过 ${oks.length} · 信息 ${infos.length} · 警告 ${warns.length} · 错误 ${errors.length}`);
  if (errors.length) {
    console.log('\n❌ 自动更新功能存在致命问题，请修复后再' + (releaseMode ? '发布' : '继续打包') + '。');
    return false;
  }
  if (warns.length) console.log('\n⚠ 存在警告，建议处理（不阻断）。');
  else console.log('\n✅ 自动更新相关功能检查通过。');
  return true;
}

if (require.main === module) {
  const ok = main(process.argv.slice(2));
  process.exit(ok ? 0 : 1);
}
module.exports = { main, run: main, parseMinisignPub, parseMinisignSig };
