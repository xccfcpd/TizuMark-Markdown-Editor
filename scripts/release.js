// 发布前先自检自动更新功能（致命问题中断发布）
const { run: runUpdaterCheck } = require('./check-updater.cjs');
if (!runUpdaterCheck(['--release'])) process.exit(1);

const https = require('https');
const fs = require('fs');
const path = require('path');
const { VERSION, notesLines, writeNotes } = require('./release-notes');
// 打包发布流程：生成（落盘）发布说明，作为本次 Release 的内容来源
writeNotes();

const TOKEN = process.env.GITEE_TOKEN;
if (!TOKEN) {
  console.error('缺少 GITEE_TOKEN 环境变量：请先设置（PowerShell: $env:GITEE_TOKEN="xxx"）');
  process.exit(1);
}

const releaseBody = {
  tag_name: 'v' + VERSION,
  name: 'v' + VERSION,
  target_commitish: 'master',
  body: notesLines.join('\n'),
  prerelease: false,
};

// === 通用 API 请求函数 ===
function apiRequest(method, p, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const options = {
      hostname: 'gitee.com',
      path: `/api/v5/repos/tizu/TizuMark-Markdown-Editor/releases${p}`,
      method,
      headers: { 'Authorization': `Bearer ${TOKEN}`, 'Content-Type': 'application/json; charset=utf-8' },
    };
    if (payload) options.headers['Content-Length'] = Buffer.byteLength(payload, 'utf-8');
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(data)); } catch { resolve(data); }
        } else { reject(new Error(`HTTP ${res.statusCode}: ${data}`)); }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// === 上传附件函数（multipart/form-data）===
function uploadFile(releaseId, filePath) {
  return new Promise((resolve, reject) => {
    const fileName = path.basename(filePath);
    const boundary = '----' + Date.now();
    const header = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: application/octet-stream\r\n\r\n`;
    const footer = `\r\n--${boundary}--\r\n`;
    const fileContent = fs.readFileSync(filePath);
    const body = Buffer.concat([Buffer.from(header, 'utf-8'), fileContent, Buffer.from(footer, 'utf-8')]);
    const options = {
      hostname: 'gitee.com',
      path: `/api/v5/repos/tizu/TizuMark-Markdown-Editor/releases/${releaseId}/attach_files`,
      method: 'POST',
      headers: { 'Authorization': `Bearer ${TOKEN}`, 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': body.length },
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        // 校验 HTTP 状态码：Gitee 返回 4xx/5xx 时同样会走到 end，旧实现照样 resolve，
        // 于是脚本打印 "Uploaded" 且 exit 0 —— Release 缺包却无人察觉（审计发现，2026-09-24）。
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error('HTTP ' + res.statusCode + '：' + String(data).slice(0, 200)));
          return;
        }
        try { resolve(JSON.parse(data)); } catch { resolve(data); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// === 主流程 ===
(async () => {
  const release = await apiRequest('POST', '', releaseBody);
  console.log('Created release #' + release.id);
  // 附件路径基于脚本位置解析（历史：硬编码 D:/project/... 绝对路径，换机器即坏）
  const releaseDir = path.resolve(__dirname, '..', 'release');
  const files = [
    path.join(releaseDir, `TizuMark_${VERSION}_x64-setup.exe`),
    path.join(releaseDir, `TizuMark_${VERSION}_x64_en-US.msi`),
    path.join(releaseDir, `TizuMark_${VERSION}_x64.exe`),
    path.join(releaseDir, 'update-windows-x86_64.json'),
  ];
  let failed = 0;
  for (const f of files) {
    if (!fs.existsSync(f)) { console.error('MISSING FILE: ' + f); failed++; continue; }
    try {
      await uploadFile(release.id, f);
      console.log('Uploaded: ' + path.basename(f));
    } catch (e) {
      console.error('UPLOAD FAILED: ' + path.basename(f) + ' —— ' + e.message);
      failed++;
    }
  }
  // 任一附件缺失/失败都以非零退出：否则 CI 会认为发布成功（审计发现，2026-09-24）
  if (failed) { console.error('有 ' + failed + ' 个附件未成功上传'); process.exitCode = 1; }
  console.log('All done!');
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
