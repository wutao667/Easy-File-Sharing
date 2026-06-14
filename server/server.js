const express = require('express');
const session = require('express-session');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const passwordStore = require('./password-store');

// ── 配置：端口、上传目录、分享链接存储、上传限制与会话密钥 ──
const PORT = 3100;
const UPLOAD_DIR = path.resolve(__dirname, '../uploads');
const SHARE_LINKS_FILE = path.resolve(__dirname, 'share-links.json');
const MAX_FILE_SIZE = 500 * 1024 * 1024; // 500MB
const SESSION_SECRET = crypto.randomBytes(32).toString('hex');

// 初始化运行所需目录和密码存储，保证服务启动时基础文件可用。
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
passwordStore.init();

// ── Express 应用：创建 HTTP 应用实例并挂载基础解析能力 ──
const app = express();

// ── Session：使用内存会话记录登录状态，Cookie 有效期为 24 小时 ──
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000 }
}));

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// ── 工具函数：文件名编码、上传路径校验、分享链接读写 ──

// 修复部分浏览器/表单上传时中文文件名被按 latin1 读取的问题。
function fixEncoding(name) {
  return Buffer.from(name, 'latin1').toString('utf8');
}

// 将用户传入的文件名限制在上传目录内，避免目录穿越访问。
function getUploadPath(name) {
  const fp = path.resolve(UPLOAD_DIR, name);
  if (fp !== UPLOAD_DIR && fp.startsWith(UPLOAD_DIR + path.sep)) return fp;
  return null;
}

// 从本地 JSON 文件读取分享链接映射；读取失败时返回空对象以不中断页面。
function loadShareLinks() {
  try {
    if (!fs.existsSync(SHARE_LINKS_FILE)) return {};
    return JSON.parse(fs.readFileSync(SHARE_LINKS_FILE, 'utf8'));
  } catch (e) {
    return {};
  }
}

// 将分享链接映射持久化到本地文件。
function saveShareLinks(links) {
  fs.writeFileSync(SHARE_LINKS_FILE, JSON.stringify(links, null, 2));
}

// 根据分享 token 拼出对外访问 URL。
function getShareUrl(token) {
  return 'https://files.huaguo.site/s/' + token;
}

// ── 上传配置：Multer 存储位置、重名处理与文件大小限制 ──
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const name = fixEncoding(file.originalname);
    const fp = path.join(UPLOAD_DIR, name);
    if (fs.existsSync(fp)) {
      const ext = path.extname(name);
      const base = path.basename(name, ext);
      cb(null, `${base}_${Date.now()}${ext}`);
    } else {
      cb(null, name);
    }
  }
});
const upload = multer({ storage, limits: { fileSize: MAX_FILE_SIZE } });

// ── 鉴权中间件：保护后台页面和文件管理接口，放行登录与公开分享 ──
function requireAuth(req, res, next) {
  if (req.session.loggedIn) return next();
  if (req.path === '/login' || req.path.startsWith('/s/') || req.path === '/change-password' && req.method === 'POST') return next();
  res.redirect('/login');
}
app.use(requireAuth);

// ── 页面路由 ──

// ── 登录路由：展示登录页，并在密码正确后写入 session ──
app.get('/login', (req, res) => {
  if (req.session.loggedIn) return res.redirect('/');
  res.send(renderLogin(req.query.error, passwordStore.isDefault()));
});

app.post('/login', (req, res) => {
  if (passwordStore.verify(req.body.password)) {
    req.session.loggedIn = true;
    if (passwordStore.isDefault()) {
      return res.redirect('/change-password?first=1');
    }
    res.redirect('/');
  } else {
    res.redirect('/login?error=1');
  }
});

// ── 退出路由：销毁当前 session 后回到登录页 ──
app.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

// ── 首页路由：读取上传目录，按修改时间倒序渲染文件列表 ──
app.get('/', (req, res) => {
  let files = [];
  try {
    files = fs.readdirSync(UPLOAD_DIR)
      .filter(f => f !== '.gitkeep')
      .map(f => {
        const stat = fs.statSync(path.join(UPLOAD_DIR, f));
        return { name: f, size: stat.size, mtime: stat.mtime, isFile: stat.isFile() };
      })
      .filter(f => f.isFile)
      .sort((a, b) => b.mtime - a.mtime)
      .map(f => ({ ...f, sizeStr: formatSize(f.size), mtimeStr: formatTime(f.mtime) }));
  } catch (e) { /* ignore */ }
  res.send(renderIndex(files, req.query.msg));
});

// ── 修改密码路由：首次登录或手动进入时更新访问密码 ──
app.get('/change-password', (req, res) => {
  if (!req.session.loggedIn) return res.redirect('/login');
  res.send(renderChangePassword(req.query.first !== undefined, req.query.msg, req.query.error));
});

app.post('/change-password', (req, res) => {
  if (!req.session.loggedIn) return res.redirect('/login');
  const result = passwordStore.change(req.body.oldPassword, req.body.newPassword);
  if (result.ok) {
    if (!req.session.passwordChanged) req.session.passwordChanged = true;
    return res.redirect('/?msg=Password changed successfully');
  }
  res.redirect('/change-password?error=' + encodeURIComponent(result.msg));
});

// ── 上传路由：接收单文件上传，并针对普通表单与 AJAX 返回不同响应 ──
app.post('/upload', (req, res, next) => {
  upload.single('file')(req, res, (err) => {
    if (err) {
      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          const msg = 'File too large, max 500MB';
          if (req.xhr || req.headers.accept?.includes('json')) return res.json({ ok: false, msg });
          return res.redirect('/?msg=' + encodeURIComponent(msg));
        }
        const msg = 'Upload error: ' + err.message;
        if (req.xhr || req.headers.accept?.includes('json')) return res.json({ ok: false, msg });
        return res.redirect('/?msg=' + encodeURIComponent(msg));
      }
      return next(err);
    }
    if (!req.file) {
      const msg = 'Please select a file';
      if (req.xhr || req.headers.accept?.includes('json')) return res.json({ ok: false, msg });
      return res.redirect('/?msg=' + encodeURIComponent(msg));
    }
    if (req.xhr || req.headers.accept?.includes('json')) {
      return res.json({ ok: true, msg: 'Upload successful', name: req.file.originalname });
    }
    res.redirect('/?msg=Upload successful');
  });
});

// ── 删除路由：删除指定上传文件，路径会先经过安全校验 ──
app.post('/delete/:name', (req, res) => {
  const name = decodeURIComponent(req.params.name);
  const fp = getUploadPath(name);
  if (!fp) return res.status(403).end();
  try {
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
    res.redirect('/?msg=Deleted');
  } catch (e) {
    res.redirect('/?msg=Delete failed');
  }
});

// ── 下载路由：登录用户下载指定文件 ──
app.get('/d/:name', (req, res) => {
  const name = decodeURIComponent(req.params.name);
  const fp = getUploadPath(name);
  if (!fp) return res.status(403).end();
  if (!fs.existsSync(fp)) return res.status(404).send('File not found');
  res.download(fp, name);
});

// ── 公开分享下载路由：通过 token 查找文件，无需登录即可下载 ──
app.get('/s/:token', (req, res) => {
  const links = loadShareLinks();
  const name = links[req.params.token];
  if (!name) return res.status(404).send('Share link not found');
  const fp = getUploadPath(name);
  if (!fp || !fs.existsSync(fp)) return res.status(404).send('File not found');
  res.download(fp, name);
});

// ── API 路由：为文件创建或复用公开分享链接 ──
app.post('/api/share/:name', (req, res) => {
  const name = decodeURIComponent(req.params.name);
  const fp = getUploadPath(name);
  if (!fp) return res.status(403).json({ ok: false, msg: 'Invalid file name' });
  if (!fs.existsSync(fp)) return res.status(404).json({ ok: false, msg: 'File not found' });

  const links = loadShareLinks();
  const existing = Object.entries(links).find(([, fileName]) => fileName === name);
  if (existing) return res.json({ ok: true, url: getShareUrl(existing[0]) });

  let token;
  do {
    token = crypto.randomBytes(16).toString('hex');
  } while (links[token]);

  links[token] = name;
  saveShareLinks(links);
  res.json({ ok: true, url: getShareUrl(token) });
});

// ── 模板函数：直接返回登录页、改密页和文件列表页的 HTML ──

// 渲染登录页面；默认密码状态会显示改密提醒。
function renderLogin(error, isDefault) {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>File Sharing · Login</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#f0f2f5;display:flex;height:100vh;align-items:center;justify-content:center}
.card{background:#fff;border-radius:12px;padding:40px;box-shadow:0 2px 16px rgba(0,0,0,.08);width:360px;text-align:center}
h1{font-size:22px;margin-bottom:24px;color:#333}
input{width:100%;padding:12px 16px;border:1px solid #d9d9d9;border-radius:8px;font-size:16px;outline:none;margin-bottom:16px;transition:border-color .2s}
input:focus{border-color:#1677ff}
button{width:100%;padding:12px;background:#1677ff;color:#fff;border:none;border-radius:8px;font-size:16px;cursor:pointer;transition:background .2s}
button:hover{background:#4096ff}
.error{color:#ff4d4f;margin-bottom:16px;font-size:14px}
.notice{background:#fff7e6;border:1px solid #ffd591;color:#d46b08;padding:10px 16px;border-radius:8px;margin-bottom:16px;font-size:14px;text-align:left}
</style></head><body>
<div class="card">
<h1>🔐 File Sharing</h1>
${error ? '<div class="error">Incorrect password</div>' : ''}
${isDefault ? '<div class="notice">Default password is 123456. You will be redirected to change your password after login.</div>' : ''}
<form method="post">
<input type="password" name="password" placeholder="Enter password (default: 123456)" autofocus>
<button type="submit">Sign In</button>
</form>
</div></body></html>`;
}

// 渲染修改密码页面；前端只做确认密码一致性校验，后端仍负责真正更新。
function renderChangePassword(isFirst, msg, error) {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>Change Password</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#f0f2f5;display:flex;height:100vh;align-items:center;justify-content:center}
.card{background:#fff;border-radius:12px;padding:40px;box-shadow:0 2px 16px rgba(0,0,0,.08);width:400px;text-align:center}
h1{font-size:22px;margin-bottom:8px;color:#333}
p.desc{color:#666;font-size:14px;margin-bottom:24px}
.notice{background:#fff7e6;border:1px solid #ffd591;color:#d46b08;padding:10px 16px;border-radius:8px;margin-bottom:20px;font-size:14px;text-align:left}
input{width:100%;padding:12px 16px;border:1px solid #d9d9d9;border-radius:8px;font-size:16px;outline:none;margin-bottom:14px;transition:border-color .2s}
input:focus{border-color:#1677ff}
button{width:100%;padding:12px;background:#1677ff;color:#fff;border:none;border-radius:8px;font-size:16px;cursor:pointer;transition:background .2s}
button:hover{background:#4096ff}
.error{color:#ff4d4f;margin-bottom:14px;font-size:14px}
.success{color:#52c41a;margin-bottom:14px;font-size:14px}
.back{display:inline-block;margin-top:16px;color:#999;font-size:13px;text-decoration:none}
.back:hover{color:#1677ff}
</style></head><body>
<div class="card">
<h1>🔑 Change Password</h1>
${isFirst ? '<div class="notice">⚠️ You are currently using the default password. Please set a new password.</div>' : ''}
<p class="desc">Enter your current password and a new password.</p>
${error ? '<div class="error">' + escapeHtml(error) + '</div>' : ''}
${msg ? '<div class="success">' + escapeHtml(msg) + '</div>' : ''}
<form method="post">
<input type="password" name="oldPassword" placeholder="Current password" autofocus>
<input type="password" name="newPassword" placeholder="New password (min 4 characters)">
<input type="password" name="confirmPassword" placeholder="Confirm new password">
<button type="submit">Update Password</button>
</form>
<a class="back" href="/">← Back to files</a>
</div>
<script>
document.querySelector('form').addEventListener('submit', function(e) {
  var newPwd = document.querySelectorAll('input[type=password]')[1].value;
  var confirmPwd = document.querySelectorAll('input[type=password]')[2].value;
  if (newPwd !== confirmPwd) {
    e.preventDefault();
    alert('Passwords do not match');
  }
});
</script></body></html>`;
}

// 渲染文件管理首页，包含拖拽上传、文件列表、删除和分享按钮。
function renderIndex(files, msg) {
  const isDefault = passwordStore.isDefault();
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>File Sharing</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#f0f2f5;color:#333}
.header{background:#fff;padding:16px 24px;border-bottom:1px solid #e8e8e8;display:flex;justify-content:space-between;align-items:center}
.header h1{font-size:20px}
.header .actions{display:flex;align-items:center;gap:16px}
.header .actions a{color:#999;text-decoration:none;font-size:14px}
.header .actions a:hover{color:#1677ff}
.container{max-width:800px;margin:24px auto;padding:0 16px}
.default-banner{background:#fff7e6;border:1px solid #ffd591;color:#d46b08;padding:12px 20px;border-radius:8px;margin-bottom:16px;font-size:14px;display:flex;justify-content:space-between;align-items:center}
.default-banner a{color:#1677ff;text-decoration:underline;font-size:13px}
.default-banner a:hover{color:#4096ff}
.upload-card{background:#fff;border-radius:12px;padding:32px;box-shadow:0 2px 8px rgba(0,0,0,.06);margin-bottom:24px;text-align:center}
.upload-card .drop-zone{border:2px dashed #d9d9d9;border-radius:8px;padding:40px 20px;cursor:pointer;transition:all .2s;position:relative}
.upload-card .drop-zone:hover{border-color:#1677ff;background:#f6f9ff}
.upload-card .drop-zone.dragover{border-color:#1677ff;background:#e6f4ff}
.upload-card .drop-zone p{color:#999;font-size:14px;margin-top:8px}
.upload-card .drop-zone .icon{font-size:36px}
.upload-card input[type=file]{display:none}
.upload-card button{display:none;margin-top:16px;padding:10px 32px;background:#1677ff;color:#fff;border:none;border-radius:6px;font-size:15px;cursor:pointer}
.upload-card button:hover{background:#4096ff}
.file-list{background:#fff;border-radius:12px;box-shadow:0 2px 8px rgba(0,0,0,.06);overflow:hidden}
.file-item{display:flex;align-items:center;padding:14px 20px;border-bottom:1px solid #f0f0f0;transition:background .15s}
.file-item:last-child{border-bottom:none}
.file-item:hover{background:#fafafa}
.file-item .name{flex:1;overflow:hidden;text-overflow:ellipsis}
.file-item .name a{color:#1677ff;text-decoration:none}
.file-item .name a:hover{text-decoration:underline}
.file-item .meta{color:#999;font-size:13px;margin:0 16px;white-space:nowrap}
.file-item .del form{display:inline}
.file-item .del button{background:none;border:none;color:#ff4d4f;cursor:pointer;font-size:13px;padding:4px 8px;border-radius:4px}
.file-item .del button:hover{background:#fff1f0}
.file-item .share button{background:none;border:none;color:#52c41a;cursor:pointer;font-size:16px;padding:4px 8px;border-radius:4px}
.file-item .share button:hover{background:#f6ffed}
.empty{padding:40px;text-align:center;color:#999}
.msg{background:#f6ffed;border:1px solid #b7eb8f;color:#52c41a;padding:10px 20px;border-radius:8px;margin-bottom:16px;font-size:14px;display:${msg ? 'block' : 'none'}}
.msg.error{background:#fff2f0;border-color:#ffccc7;color:#ff4d4f}
.progress{display:none;margin-top:12px;align-items:center;gap:12px}
.progress-track{flex:1;height:6px;background:#f0f0f0;border-radius:3px;overflow:hidden}
.progress-bar{height:100%;background:linear-gradient(90deg,#1677ff,#4096ff);border-radius:3px;width:0%;transition:width .2s}
.progress-text{font-size:13px;color:#666;min-width:36px;text-align:right;font-variant-numeric:tabular-nums}
.file-icon{margin-right:10px;font-size:20px}
@media (max-width:600px){
  .header{padding:12px 16px;align-items:flex-start;gap:10px}
  .header h1{font-size:18px}
  .header .actions{gap:10px;flex-wrap:wrap;justify-content:flex-end}
  .container{margin:16px auto;padding:0 10px}
  .default-banner{padding:10px 12px;align-items:flex-start;gap:8px;flex-direction:column}
  .upload-card{padding:16px;margin-bottom:16px}
  .upload-card .drop-zone{padding:28px 12px}
  .file-item{align-items:flex-start;flex-direction:column;padding:14px 16px;gap:6px}
  .file-icon{margin-right:0}
  .file-item .name{width:100%;overflow:visible;text-overflow:clip;overflow-wrap:anywhere;word-break:break-word;font-size:15px}
  .file-item .meta{margin:0;white-space:normal;font-size:12px}
  .file-item .del,.file-item .share{align-self:flex-end}
  .file-item .del button,.file-item .share button{padding:6px 10px}
}
</style></head><body>
<div class="header">
<h1>📁 File Sharing</h1>
<div class="actions">
<a href="/change-password">Change Password</a>
<form method="post" action="/logout" style="display:inline"><a href="#" onclick="this.parentElement.submit();return false">Logout</a></form>
</div>
</div>
<div class="container">
${isDefault ? '<div class="default-banner">⚠️ Currently using default password. <a href="/change-password?first=1">Change password →</a></div>' : ''}
${msg ? `<div class="msg${msg.includes('failed') || msg.includes('error') ? ' error' : ''}">${escapeHtml(msg)}</div>` : ''}
<div class="upload-card">
<div class="drop-zone" id="dropZone">
<div class="icon" id="dropIcon">📤</div>
<p id="dropText">Drag files here, or <a href="#" id="clickLink" style="color:#1677ff">choose file</a></p>
<div id="fileInfo" style="display:none;color:#999;font-size:13px;margin-top:8px"></div>
<div class="progress" id="progressWrap">
<div class="progress-track"><div class="progress-bar" id="progressBar"></div></div>
<span class="progress-text" id="progressText">0%</span>
</div>
</div>
<input type="file" name="file" id="fileInput" style="display:none">
</div>
<div class="file-list">
${files.length === 0 ? '<div class="empty">No files yet</div>' : files.map(f => `
<div class="file-item">
<span class="file-icon">${getFileIcon(f.name)}</span>
<span class="name"><a href="/d/${encodeURIComponent(f.name)}" download>${escapeHtml(f.name)}</a></span>
<span class="meta">${f.sizeStr}</span>
<span class="meta">${f.mtimeStr}</span>
<span class="del">
<form method="post" action="/delete/${encodeURIComponent(f.name)}" onsubmit="return confirm('Delete ${escapeHtml(f.name)}?')">
<button type="submit">🗑</button>
</form>
</span>
<span class="share">
<button class="share-btn" data-file="${escapeHtml(f.name)}" title="Copy share link">🔗</button>
</span>
</div>`).join('')}
</div>
</div>
<script>
const dropZone = document.getElementById('dropZone');
const fileInput = document.getElementById('fileInput');
const clickLink = document.getElementById('clickLink');
const dropIcon = document.getElementById('dropIcon');
const dropText = document.getElementById('dropText');
const fileInfo = document.getElementById('fileInfo');
const progressWrap = document.getElementById('progressWrap');
const progressBar = document.getElementById('progressBar');
const progressText = document.getElementById('progressText');
let uploading = false;

function resetDropZone() {
  dropIcon.textContent = '📤';
  dropText.textContent = 'Drag files here, or ';
  const link = document.createElement('a');
  link.href = '#';
  link.style.cssText = 'color:#1677ff';
  link.textContent = 'choose file';
  link.addEventListener('click', e => { e.preventDefault(); fileInput.click(); });
  dropText.appendChild(link);
  fileInfo.style.display = 'none';
  progressWrap.style.display = 'none';
  progressBar.style.width = '0%';
  progressText.textContent = '0%';
  uploading = false;
}

clickLink.addEventListener('click', e => { e.preventDefault(); fileInput.click(); });
dropZone.addEventListener('click', e => {
  if (e.target === clickLink || clickLink.contains(e.target)) return;
  if (!uploading) fileInput.click();
});
dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('dragover'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
dropZone.addEventListener('drop', e => {
  e.preventDefault(); dropZone.classList.remove('dragover');
  if (uploading) return;
  if (e.dataTransfer.files.length) { fileInput.files = e.dataTransfer.files; startUpload(e.dataTransfer.files[0]); }
});
fileInput.addEventListener('change', () => { if (fileInput.files.length) startUpload(fileInput.files[0]); });

function startUpload(file) {
  uploading = true;
  dropIcon.textContent = '⏳';
  dropText.innerHTML = 'Uploading <strong>' + escapeHtml(file.name) + '</strong>';
  fileInfo.style.display = 'block';
  fileInfo.textContent = formatSize(file.size);
  progressWrap.style.display = 'flex';
  const formData = new FormData(); formData.append('file', file);
  const xhr = new XMLHttpRequest();
  xhr.open('POST', '/upload', true);
  xhr.setRequestHeader('Accept', 'application/json');
  xhr.upload.onprogress = function(e) {
    if (e.lengthComputable) { var pct = Math.round(e.loaded/e.total*100); progressBar.style.width=pct+'%'; progressText.textContent=pct+'%'; }
  };
  xhr.onload = function() {
    try {
      var resp = JSON.parse(xhr.responseText);
      if (resp.ok) {
        dropIcon.textContent = '✅';
        dropText.innerHTML = '<strong>' + escapeHtml(resp.name||file.name) + '</strong> uploaded successfully';
        progressBar.style.width = '100%'; progressText.textContent = '100%';
        setTimeout(function(){ location.reload(); }, 1200);
      } else {
        dropIcon.textContent = '❌';
        dropText.innerHTML = 'Upload failed: ' + escapeHtml(resp.msg||'Unknown error');
        setTimeout(resetDropZone, 3000);
      }
    } catch(e) {
      dropIcon.textContent = '❌';
      dropText.innerHTML = 'Upload failed, please try again';
      setTimeout(resetDropZone, 3000);
    }
  };
  xhr.onerror = function() {
    dropIcon.textContent = '❌';
    dropText.innerHTML = 'Network error, upload failed';
    setTimeout(resetDropZone, 3000);
  };
  xhr.send(formData);
}

document.querySelectorAll('.share-btn').forEach(btn => {
  btn.addEventListener('click', async function() {
    const name = this.dataset.file;
    try {
      const resp = await fetch('/api/share/' + encodeURIComponent(name), { method: 'POST' });
      const data = await resp.json();
      if (data.ok) {
        await navigator.clipboard.writeText(data.url);
        const orig = this.textContent;
        this.textContent = '✅';
        setTimeout(() => { this.textContent = orig; }, 2000);
      }
    } catch(e) { /* ignore */ }
  });
});

</script></body></html>`;
}

// ── 工具函数 ──

// 转义 HTML 特殊字符，避免文件名或消息内容破坏页面结构。
function escapeHtml(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

// 将字节数格式化为适合页面展示的单位。
function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + ' MB';
  return (bytes / 1024 / 1024 / 1024).toFixed(1) + ' GB';
}

// 将文件修改时间格式化为本地日期时间字符串。
function formatTime(d) {
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// 根据扩展名选择页面上展示的文件类型图标。
function getFileIcon(name) {
  const ext = path.extname(name).toLowerCase();
  const icons = {
    '.jpg':'🖼','.jpeg':'🖼','.png':'🖼','.gif':'🖼','.webp':'🖼','.svg':'🖼',
    '.mp4':'🎬','.mov':'🎬','.avi':'🎬','.mkv':'🎬',
    '.mp3':'🎵','.wav':'🎵','.flac':'🎵',
    '.pdf':'📄','.doc':'📝','.docx':'📝','.xls':'📊','.xlsx':'📊','.ppt':'📽','.pptx':'📽',
    '.zip':'📦','.rar':'📦','.7z':'📦','.tar':'📦','.gz':'📦',
    '.apk':'📱','.ipa':'📱',
    '.js':'⚡','.py':'🐍','.go':'🔷','.rs':'🦀','.ts':'🔷',
    '.txt':'📃','.md':'📝','.json':'📋','.yaml':'📋','.yml':'📋',
    '.html':'🌐','.css':'🎨'
  };
  return icons[ext] || '📄';
}

// ── 服务启动：仅监听本机地址，由外层反向代理负责对外暴露 ──
app.listen(PORT, '127.0.0.1', () => {
  console.log('FileShare server running on http://127.0.0.1:' + PORT);
});
