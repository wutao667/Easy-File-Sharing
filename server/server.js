const express = require('express');
const session = require('express-session');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const passwordStore = require('./password-store');

// ── 配置 ──
const PORT = 3100;
const UPLOAD_DIR = path.resolve(__dirname, '../uploads');
const MAX_FILE_SIZE = 500 * 1024 * 1024; // 500MB
const SESSION_SECRET = crypto.randomBytes(32).toString('hex');

fs.mkdirSync(UPLOAD_DIR, { recursive: true });
passwordStore.init();

// ── Express ──
const app = express();

// Session
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000 }
}));

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// ── 文件名编码修复 ──
function fixEncoding(name) {
  return Buffer.from(name, 'latin1').toString('utf8');
}

// ── Multer ──
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

// ── 中间件：登录检查 ──
function requireAuth(req, res, next) {
  if (req.session.loggedIn) return next();
  if (req.path === '/login' || req.path === '/change-password' && req.method === 'POST') return next();
  res.redirect('/login');
}
app.use(requireAuth);

// ── 页面路由 ──

// 登录页
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

// 退出
app.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

// 首页
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

// 修改密码
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

// 上传
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

// 删除
app.post('/delete/:name', (req, res) => {
  const name = decodeURIComponent(req.params.name);
  const fp = path.join(UPLOAD_DIR, name);
  if (!fp.startsWith(UPLOAD_DIR)) return res.status(403).end();
  try {
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
    res.redirect('/?msg=Deleted');
  } catch (e) {
    res.redirect('/?msg=Delete failed');
  }
});

// 下载
app.get('/d/:name', (req, res) => {
  const name = decodeURIComponent(req.params.name);
  const fp = path.join(UPLOAD_DIR, name);
  if (!fp.startsWith(UPLOAD_DIR)) return res.status(403).end();
  if (!fs.existsSync(fp)) return res.status(404).send('File not found');
  res.download(fp, name);
});

// ── 模板 ──

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
.file-item .name{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.file-item .name a{color:#1677ff;text-decoration:none}
.file-item .name a:hover{text-decoration:underline}
.file-item .meta{color:#999;font-size:13px;margin:0 16px;white-space:nowrap}
.file-item .del form{display:inline}
.file-item .del button{background:none;border:none;color:#ff4d4f;cursor:pointer;font-size:13px;padding:4px 8px;border-radius:4px}
.file-item .del button:hover{background:#fff1f0}
.empty{padding:40px;text-align:center;color:#999}
.msg{background:#f6ffed;border:1px solid #b7eb8f;color:#52c41a;padding:10px 20px;border-radius:8px;margin-bottom:16px;font-size:14px;display:${msg ? 'block' : 'none'}}
.msg.error{background:#fff2f0;border-color:#ffccc7;color:#ff4d4f}
.progress{display:none;margin-top:12px;align-items:center;gap:12px}
.progress-track{flex:1;height:6px;background:#f0f0f0;border-radius:3px;overflow:hidden}
.progress-bar{height:100%;background:linear-gradient(90deg,#1677ff,#4096ff);border-radius:3px;width:0%;transition:width .2s}
.progress-text{font-size:13px;color:#666;min-width:36px;text-align:right;font-variant-numeric:tabular-nums}
.file-icon{margin-right:10px;font-size:20px}
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

</script></body></html>`;
}

// ── 工具函数 ──

function escapeHtml(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + ' MB';
  return (bytes / 1024 / 1024 / 1024).toFixed(1) + ' GB';
}

function formatTime(d) {
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

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

app.listen(PORT, '127.0.0.1', () => {
  console.log('FileShare server running on http://127.0.0.1:' + PORT);
});
