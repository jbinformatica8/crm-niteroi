const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = __dirname;
const DATA_DIR = path.resolve(process.env.CRM_DATA_DIR || path.join(ROOT, 'data'));
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const NEW_PASSWORD = '123456';

if (!fs.existsSync(USERS_FILE)) {
  console.error('Arquivo users.json não encontrado em: ' + USERS_FILE);
  console.error('Inicie o CRM uma vez para criar o usuário administrador ou informe CRM_DATA_DIR corretamente.');
  process.exit(1);
}
let data;
try { data = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')); }
catch (e) { console.error('Não foi possível ler users.json: ' + e.message); process.exit(1); }
if (!data || !Array.isArray(data.users)) {
  console.error('Formato de users.json inválido. Nenhuma alteração foi feita.');
  process.exit(1);
}
const admin = data.users.find(u => String(u.username).toLowerCase() === ADMIN_USER.toLowerCase());
if (!admin) {
  console.error('Administrador "' + ADMIN_USER + '" não encontrado. Nenhuma alteração foi feita.');
  process.exit(1);
}
const salt = crypto.randomBytes(16).toString('hex');
admin.salt = salt;
admin.hash = crypto.scryptSync(NEW_PASSWORD, salt, 64).toString('hex');
admin.mustChangePassword = false;
admin.active = true;
const tmp = USERS_FILE + '.tmp';
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
try { fs.chmodSync(tmp, 0o600); } catch {}
fs.renameSync(tmp, USERS_FILE);
console.log('Senha do administrador "' + admin.username + '" alterada para 123456.');
console.log('As demais contas foram preservadas.');
