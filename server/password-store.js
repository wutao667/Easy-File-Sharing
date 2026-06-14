const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');

const PASSWORD_FILE = path.resolve(__dirname, 'password.json');
const DEFAULT_PASSWORD = '***';
const SALT_ROUNDS = 10;

let _hashCache = null;
let _dataCache = null;
let _mtimeCache = 0;

function _setCache(data) {
  const stat = fs.statSync(PASSWORD_FILE);
  _dataCache = data;
  _hashCache = data.hash;
  _mtimeCache = stat.mtimeMs;
}

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

function init() {
  const data = _load(true);
  return { created: data.updatedAt === null, isDefault: data.isDefault };
}

function verify(plaintext) {
  if (typeof plaintext !== 'string') return false;
  const data = _load();
  const result = bcrypt.compareSync(plaintext, data.hash);
  return result;
}

function change(oldPwd, newPwd) {
  if (!verify(oldPwd)) return { ok: false, msg: 'Old password is incorrect' };
  if (!newPwd || newPwd.length < 4) return { ok: false, msg: 'Password must be at least 4 characters' };
  const hash = bcrypt.hashSync(newPwd, SALT_ROUNDS);
  const data = { hash, isDefault: false, updatedAt: new Date().toISOString() };
  fs.writeFileSync(PASSWORD_FILE, JSON.stringify(data, null, 2));
  _setCache(data);
  return { ok: true };
}

function isDefault() {
  const data = _load();
  return data.isDefault;
}

module.exports = { init, verify, change, isDefault };
