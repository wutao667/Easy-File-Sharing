// 密码存储模块：负责初始化、校验和更新 Web/MCP 共用访问密码。
// 密码只以 bcrypt hash 形式写入 password.json，并通过文件 mtime 做简单缓存。
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');

// ── 配置：密码文件路径、默认密码和 bcrypt 加盐轮数 ──
const PASSWORD_FILE = path.resolve(__dirname, 'password.json');
const DEFAULT_PASSWORD = '***';
const SALT_ROUNDS = 10;

// ── 内存缓存：减少每次校验时重复读取和解析 password.json ──
let _hashCache = null;
let _dataCache = null;
let _mtimeCache = 0;

// 更新内存缓存，并记录密码文件最后修改时间。
function _setCache(data) {
  const stat = fs.statSync(PASSWORD_FILE);
  _dataCache = data;
  _hashCache = data.hash;
  _mtimeCache = stat.mtimeMs;
}

// 读取密码数据；文件不存在时创建默认密码记录，文件未变化时复用缓存。
function _load(force) {
  if (!fs.existsSync(PASSWORD_FILE)) {
    const hash = bcrypt.hashSync(DEFAULT_PASSWORD, SALT_ROUNDS);
    const data = { hash, isDefault: true, updatedAt: null };
    fs.writeFileSync(PASSWORD_FILE, JSON.stringify(data, null, 2));
    _setCache(data);
    return data;
  }
  const stat = fs.statSync(PASSWORD_FILE);
  if (!force && _dataCache && _hashCache && stat.mtimeMs === _mtimeCache) {
    return _dataCache;
  }
  const raw = fs.readFileSync(PASSWORD_FILE, 'utf8');
  const data = JSON.parse(raw);
  _dataCache = data;
  _hashCache = data.hash;
  _mtimeCache = stat.mtimeMs;
  return data;
}

// 初始化密码存储，返回当前是否仍处于默认密码状态。
function init() {
  const data = _load(true);
  return { created: data.updatedAt === null, isDefault: data.isDefault };
}

// 校验明文密码是否与当前 bcrypt hash 匹配。
function verify(plaintext) {
  if (typeof plaintext !== 'string') return false;
  const data = _load();
  const result = bcrypt.compareSync(plaintext, data.hash);
  return result;
}

// 修改密码：先验证旧密码，再写入新密码 hash 并刷新缓存。
function change(oldPwd, newPwd) {
  if (!verify(oldPwd)) return { ok: false, msg: 'Old password is incorrect' };
  if (!newPwd || newPwd.length < 4) return { ok: false, msg: 'Password must be at least 4 characters' };
  const hash = bcrypt.hashSync(newPwd, SALT_ROUNDS);
  const data = { hash, isDefault: false, updatedAt: new Date().toISOString() };
  fs.writeFileSync(PASSWORD_FILE, JSON.stringify(data, null, 2));
  _setCache(data);
  return { ok: true };
}

// 返回当前是否仍在使用默认密码，用于页面提示和首次登录流程。
function isDefault() {
  const data = _load();
  return data.isDefault;
}

module.exports = { init, verify, change, isDefault };
