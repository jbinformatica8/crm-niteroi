const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = __dirname;
const PORT = Number(process.env.PORT || 3000);
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '123456';
// Defina CRM_DATA_DIR para um volume/pasta persistente e gravável no servidor.
// Sem essa variável, mantém o comportamento local: <projeto>/data.
const DATA_DIR = path.resolve(process.env.CRM_DATA_DIR || path.join(ROOT, 'data'));
const DB_FILE = path.join(DATA_DIR, 'crm.json');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const BACKUP_RETENTION_DAYS = 30;
const sessions = new Map();
const attempts = new Map();

function loadDB() {
  try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); }
  catch { return { clients: [], demands: [], events: [] }; }
}
let db = loadDB();
function saveDB() {
  fs.mkdirSync(path.dirname(DB_FILE), {recursive:true});
  const tmp=DB_FILE+'.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB_FILE);
}
function backupName(date=new Date()) {
  const stamp=date.toISOString().replace(/[:.]/g,'-');
  return `crm-niteroi-${stamp}.json`;
}
function createBackup(reason='automatico') {
  fs.mkdirSync(BACKUP_DIR,{recursive:true});
  if(!fs.existsSync(DB_FILE)) saveDB();
  const name=backupName();
  const target=path.join(BACKUP_DIR,name);
  fs.copyFileSync(DB_FILE,target);
  fs.writeFileSync(target+'.meta.json',JSON.stringify({file:name,reason,createdAt:new Date().toISOString(),clients:db.clients.length,demands:db.demands.length},null,2));
  pruneBackups();
  return name;
}
function pruneBackups() {
  fs.mkdirSync(BACKUP_DIR,{recursive:true});
  const cutoff=Date.now()-BACKUP_RETENTION_DAYS*24*60*60*1000;
  for(const name of fs.readdirSync(BACKUP_DIR)) {
    const full=path.join(BACKUP_DIR,name);
    try { if(fs.statSync(full).mtimeMs<cutoff) fs.unlinkSync(full); } catch {}
  }
}
function backupList() {
  fs.mkdirSync(BACKUP_DIR,{recursive:true});
  return fs.readdirSync(BACKUP_DIR).filter(n=>n.endsWith('.json')&&!n.endsWith('.meta.json')).map(file=>{
    let meta={file,createdAt:fs.statSync(path.join(BACKUP_DIR,file)).mtime.toISOString(),reason:'backup'};
    try { meta={...meta,...JSON.parse(fs.readFileSync(path.join(BACKUP_DIR,file+'.meta.json'),'utf8'))}; } catch {}
    return meta;
  }).sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
}
function ensureDailyBackup() {
  const today=new Date().toISOString().slice(0,10);
  const exists=backupList().some(x=>x.createdAt.slice(0,10)===today);
  if(!exists) createBackup('automatico-diario');
}
function id() { return crypto.randomUUID(); }
function clean(v, max=3000) { return String(v ?? '').trim().slice(0, max); }
function json(res, status, obj) { res.writeHead(status, {'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}); res.end(JSON.stringify(obj)); }
function cookie(req, name) { const s=req.headers.cookie||''; const m=s.match(new RegExp('(?:^|; )'+name+'=([^;]*)')); return m ? decodeURIComponent(m[1]) : ''; }
function loadUsers() {
  try {
    const parsed=JSON.parse(fs.readFileSync(USERS_FILE,'utf8'));
    if(Array.isArray(parsed.users) && parsed.users.length) return parsed.users;
  } catch {}
  const initialPassword=ADMIN_PASSWORD;
  const salt=crypto.randomBytes(16).toString('hex');
  const hash=crypto.scryptSync(initialPassword,salt,64).toString('hex');
  const initial=[{id:id(),username:ADMIN_USER,role:'admin',active:true,salt,hash,mustChangePassword:true,createdAt:new Date().toISOString()}];
  saveUsers(initial);
  return initial;
}
function saveUsers(users) {
  fs.mkdirSync(path.dirname(USERS_FILE),{recursive:true});
  const tmp=USERS_FILE+'.tmp';
  fs.writeFileSync(tmp,JSON.stringify({users},null,2),{mode:0o600});
  try { fs.chmodSync(tmp,0o600); } catch {}
  fs.renameSync(tmp,USERS_FILE);
}
let users=loadUsers();
function passwordHash(password,salt) { return crypto.scryptSync(password,salt,64).toString('hex'); }
function validPassword(password) { return typeof password==='string' && password.length>=6 && password.length<=200; }
function findUser(username) { return users.find(u=>u.username.toLowerCase()===String(username||'').trim().toLowerCase()); }
function sessionUser(req) {
  const token=cookie(req,'crm_session');
  const session=token && sessions.get(token);
  if(!session) return null;
  const user=users.find(u=>u.id===session.userId && u.active);
  if(!user) { sessions.delete(token); return null; }
  return {user,token};
}
function requireAuth(req,res) {
  const current=sessionUser(req);
  if(!current) { json(res,401,{error:'Acesso não autorizado.'}); return null; }
  return current;
}
function requireAdmin(req,res) {
  const current=requireAuth(req,res);
  if(!current) return null;
  if(current.user.role!=='admin') { json(res,403,{error:'Apenas administradores podem gerenciar usuários.'}); return null; }
  return current;
}
function invalidateUserSessions(userId) {
  for(const [token,session] of sessions) if(session.userId===userId) sessions.delete(token);
}
function publicUser(user) {
  return {id:user.id,username:user.username,role:user.role,active:user.active,mustChangePassword:!!user.mustChangePassword,createdAt:user.createdAt};
}
function readBody(req) { return new Promise((resolve,reject)=>{let raw=''; req.on('data',c=>{raw+=c; if(raw.length>100000) {reject(new Error('Corpo muito grande')); req.destroy();}}); req.on('end',()=>{try{resolve(JSON.parse(raw||'{}'));}catch{reject(new Error('JSON inválido'));}});}); }
function safeEqual(a,b) { const aa=Buffer.from(String(a)), bb=Buffer.from(String(b)); return aa.length===bb.length && crypto.timingSafeEqual(aa,bb); }
function logEvent(type, demandId, message) { db.events.unshift({id:id(),type,demandId,message,at:new Date().toISOString()}); }
function clientByPhone(phone) { const p=String(phone||'').replace(/\D/g,''); return db.clients.find(c=>c.phone.replace(/\D/g,'')===p); }
function createPublicSubmission(body) {
  const name=clean(body.name,140), phone=clean(body.phone,40), category=clean(body.category,100), description=clean(body.description,3000);
  if(!name || !phone || !category || !description || body.consent!==true) throw new Error('Preencha nome, telefone, categoria, descrição e aceite o aviso de privacidade.');
  let client=clientByPhone(phone);
  if(!client) {
    client={id:id(),name,phone,email:clean(body.email,160),neighborhood:clean(body.neighborhood,100),address:clean(body.address,220),addressNumber:clean(body.addressNumber,30),cep:clean(body.cep,12),institution:clean(body.institution,180),createdAt:new Date().toISOString(),source:'Formulário público'};
    db.clients.push(client);
  } else {
    if(!client.email && body.email) client.email=clean(body.email,160);
    if(!client.neighborhood && body.neighborhood) client.neighborhood=clean(body.neighborhood,100);
    if(!client.address && body.address) client.address=clean(body.address,220);
    if(!client.addressNumber && body.addressNumber) client.addressNumber=clean(body.addressNumber,30);
    if(!client.cep && body.cep) client.cep=clean(body.cep,12);
    if(!client.institution && body.institution) client.institution=clean(body.institution,180);
  }
  const demand={id:id(),number:'NIT-'+new Date().getFullYear()+'-'+String(db.demands.length+1).padStart(5,'0'),clientId:client.id,category,description,location:clean(body.location,220),locationNumber:clean(body.locationNumber,30),neighborhood:clean(body.demandNeighborhood,100)||clean(body.neighborhood,100),department:clean(body.requestingDepartment,160)||'A definir',requestingDepartment:clean(body.requestingDepartment,160),protocol:'',colabTicket:clean(body.colabTicket,100),ecigaTicket:clean(body.ecigaTicket,100),priority:'Média',status:'Aberta',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),source:'Formulário público'};
  db.demands.unshift(demand); logEvent('Criação',demand.id,'Demanda recebida pelo formulário público.'); saveDB();
  return {number:demand.number};
}

const server=http.createServer(async(req,res)=>{
  res.setHeader('X-Content-Type-Options','nosniff'); res.setHeader('Referrer-Policy','strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options','DENY');
  const url=new URL(req.url,'http://localhost');
  if(req.method==='GET' && (url.pathname==='/' || url.pathname==='/index.html')) return serve(res,'admin.html');
  if(req.method==='GET' && url.pathname==='/cadastro') return serve(res,'cadastro.html');
  if(req.method==='GET' && url.pathname.startsWith('/assets/')) return serve(res,url.pathname.slice(1));
  try {
    if(req.method==='POST' && url.pathname==='/api/login') {
      const ip=req.socket.remoteAddress||'unknown', now=Date.now(), rec=attempts.get(ip)||{n:0,t:now};
      if(now-rec.t>10*60*1000) {rec.n=0;rec.t=now;}
      if(rec.n>=10) return json(res,429,{error:'Muitas tentativas. Aguarde alguns minutos.'});
      const b=await readBody(req);
      const user=findUser(b.username);
      const supplied=String(b.password||'');
      const valid=user && user.active && safeEqual(passwordHash(supplied,user.salt),user.hash);
      if(!valid) {rec.n++;attempts.set(ip,rec);return json(res,401,{error:'Usuário ou senha incorretos.'});}
      rec.n=0;attempts.set(ip,rec);
      const token=crypto.randomBytes(32).toString('hex'); sessions.set(token,{userId:user.id,createdAt:now});
      const secure=(req.headers['x-forwarded-proto']==='https')?'; Secure':'';
      res.writeHead(200,{'Content-Type':'application/json','Set-Cookie':`crm_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=28800${secure}`,'Cache-Control':'no-store'}); return res.end(JSON.stringify({ok:true,user:publicUser(user)}));
    }
    if(req.method==='POST' && url.pathname==='/api/logout') { const token=cookie(req,'crm_session'); sessions.delete(token); res.writeHead(200,{'Content-Type':'application/json','Set-Cookie':'crm_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0'}); return res.end('{"ok":true}'); }
    if(req.method==='POST' && url.pathname==='/api/public-submission') {
      const b=await readBody(req); const result=createPublicSubmission(b); return json(res,201,{ok:true,...result});
    }
    if(url.pathname.startsWith('/api/')) {
      if(req.method==='GET' && url.pathname==='/api/me') {
        const current=requireAuth(req,res); if(!current) return;
        return json(res,200,{user:publicUser(current.user)});
      }
      if(req.method==='POST' && url.pathname==='/api/change-password') {
        const current=requireAuth(req,res); if(!current) return;
        const b=await readBody(req);
        if(!safeEqual(passwordHash(String(b.currentPassword||''),current.user.salt),current.user.hash)) return json(res,400,{error:'Senha atual incorreta.'});
        if(!validPassword(b.newPassword)) return json(res,400,{error:'A nova senha deve ter entre 6 e 200 caracteres.'});
        if(b.newPassword!==b.confirmPassword) return json(res,400,{error:'A confirmação da senha não confere.'});
        const salt=crypto.randomBytes(16).toString('hex');
        current.user.salt=salt; current.user.hash=passwordHash(b.newPassword,salt); current.user.mustChangePassword=false;
        saveUsers(users);
        invalidateUserSessions(current.user.id);
        const token=crypto.randomBytes(32).toString('hex'); sessions.set(token,{userId:current.user.id,createdAt:Date.now()});
        const secure=(req.headers['x-forwarded-proto']==='https')?'; Secure':'';
        res.writeHead(200,{'Content-Type':'application/json','Set-Cookie':`crm_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=28800${secure}`,'Cache-Control':'no-store'});
        return res.end(JSON.stringify({ok:true,user:publicUser(current.user)}));
      }
      if(!requireAuth(req,res)) return;
      if(req.method==='GET' && url.pathname==='/api/data') return json(res,200,db);
      if(url.pathname.startsWith('/api/users')) {
        const admin=requireAdmin(req,res); if(!admin) return;
        if(req.method==='GET' && url.pathname==='/api/users') return json(res,200,{users:users.map(publicUser)});
        if(req.method==='POST' && url.pathname==='/api/users') {
          const b=await readBody(req), username=clean(b.username,60), password=String(b.password||''), role=b.role==='admin'?'admin':'operator';
          if(!/^[A-Za-z0-9._-]{3,60}$/.test(username)) return json(res,400,{error:'O usuário deve ter de 3 a 60 caracteres: letras, números, ponto, hífen ou sublinhado.'});
          if(findUser(username)) return json(res,409,{error:'Já existe um usuário com esse nome.'});
          if(!validPassword(password)) return json(res,400,{error:'A senha deve ter pelo menos 6 caracteres.'});
          const salt=crypto.randomBytes(16).toString('hex');
          const user={id:id(),username,role,active:true,salt,hash:passwordHash(password,salt),mustChangePassword:true,createdAt:new Date().toISOString()};
          users.push(user); saveUsers(users);
          return json(res,201,{ok:true,user:publicUser(user)});
        }
        const parts=url.pathname.split('/');
        if(parts.length===4 && req.method==='DELETE') {
          const uid=parts[3], target=users.find(u=>u.id===uid);
          if(!target) return json(res,404,{error:'Usuário não encontrado.'});
          if(target.id===admin.user.id) return json(res,400,{error:'Você não pode excluir sua própria conta.'});
          if(target.role==='admin' && target.active && users.filter(u=>u.role==='admin'&&u.active).length<=1)
            return json(res,400,{error:'Não é possível excluir o último administrador ativo.'});
          invalidateUserSessions(target.id);
          users=users.filter(u=>u.id!==uid);
          saveUsers(users);
          logEvent('Exclusão de usuário',null,'Usuário removido: '+target.username);
          return json(res,200,{ok:true});
        }
        if(parts.length===4 && req.method==='PATCH') {
          const uid=parts[3], target=users.find(u=>u.id===uid);
          if(!target) return json(res,404,{error:'Usuário não encontrado.'});
          const b=await readBody(req);
          if(b.active!==undefined) {
            if(target.id===admin.user.id && b.active===false) return json(res,400,{error:'Você não pode desativar sua própria conta.'});
            if(typeof b.active!=='boolean') return json(res,400,{error:'Estado de ativação inválido.'});
            target.active=b.active;
            if(!target.active) invalidateUserSessions(target.id);
          }
          if(b.password!==undefined) {
            if(!validPassword(b.password)) return json(res,400,{error:'A nova senha deve ter pelo menos 6 caracteres.'});
            const salt=crypto.randomBytes(16).toString('hex');
            target.salt=salt; target.hash=passwordHash(b.password,salt); target.mustChangePassword=true;
            invalidateUserSessions(target.id);
          }
          if(b.role!==undefined) {
            if(!['admin','operator'].includes(b.role)) return json(res,400,{error:'Perfil inválido.'});
            if(target.id===admin.user.id && b.role!=='admin') return json(res,400,{error:'Você não pode remover seu próprio perfil de administrador.'});
            if(target.role==='admin' && b.role!=='admin' && users.filter(u=>u.role==='admin'&&u.active).length<=1) return json(res,400,{error:'Mantenha pelo menos um administrador ativo.'});
            target.role=b.role;
          }
          saveUsers(users);
          return json(res,200,{ok:true,user:publicUser(target)});
        }
        return json(res,405,{error:'Método não permitido.'});
      }
      if(req.method==='GET' && url.pathname==='/api/backups') return json(res,200,{backups:backupList(),retentionDays:BACKUP_RETENTION_DAYS});
      if(req.method==='POST' && url.pathname==='/api/backups') {
        const name=createBackup('manual');
        return json(res,201,{ok:true,file:name,backups:backupList()});
      }
      if(req.method==='GET' && url.pathname==='/api/backups/download') {
        const name=createBackup('download-manual');
        const file=path.join(BACKUP_DIR,name);
        res.writeHead(200,{'Content-Type':'application/json; charset=utf-8','Content-Disposition':`attachment; filename="${name}"`,'Cache-Control':'no-store'});
        return fs.createReadStream(file).pipe(res);
      }
      if(req.method==='POST' && url.pathname==='/api/backups/restore') {
        const b=await readBody(req,25*1024*1024);
        const candidate=b.data;
        if(!candidate || !Array.isArray(candidate.clients) || !Array.isArray(candidate.demands) || !Array.isArray(candidate.events)) return json(res,400,{error:'Arquivo inválido. O backup precisa conter clientes, demandas e eventos.'});
        createBackup('antes-da-restauracao');
        db={clients:candidate.clients,demands:candidate.demands,events:candidate.events};
        saveDB();
        return json(res,200,{ok:true,clients:db.clients.length,demands:db.demands.length});
      }
      if(req.method==='POST' && url.pathname==='/api/import') {
        const b=await readBody(req); const rows=Array.isArray(b.rows)?b.rows:[];
        if(!rows.length) return json(res,400,{error:'A planilha não contém linhas para importar.'});
        if(rows.length>5000) return json(res,400,{error:'Limite de 5.000 linhas por importação.'});
        const norm=v=>String(v??'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]/g,'');
        const pick=(r,names)=>{for(const n of names){const v=r[norm(n)];if(v!==undefined&&String(v).trim()!=='')return String(v).trim();}return '';};
        let clientsCreated=0, demandsCreated=0, skipped=0, errors=[];
        for(let i=0;i<rows.length;i++){
          const r={}; for(const [k,v] of Object.entries(rows[i]||{})) r[norm(k)]=v;
          const name=clean(pick(r,['Nome','Nome do cliente','Cliente','Nome completo','Razao social']),140);
          const phone=clean(pick(r,['Telefone','Celular','WhatsApp','Telefone celular','Telefone/WhatsApp']),40);
          const email=clean(pick(r,['Email','E-mail']),160);
          const neighborhood=clean(pick(r,['Bairro']),100);
          const address=clean(pick(r,['Endereco','Endereço']),220);
          const addressNumber=clean(pick(r,['Numero do endereco','Número do endereço','Nº do endereço','Nº','Numero']),30);
          const cep=clean(pick(r,['CEP']),12);
          const institution=clean(pick(r,['Instituicao ou Organizacao Social','Instituição ou Organização Social','Instituicao','Organizacao Social']),180);
          const category=clean(pick(r,['Categoria da demanda','Categoria','Assunto','Assunto da solicitação']),100);
          const description=clean(pick(r,['Descricao da demanda','Descricao','Descrição','Demanda','Solicitacao','Solicitação','Descreva sua solicitação']),3000);
          if(!name||!phone){skipped++;errors.push({row:i+2,message:'Nome e telefone são obrigatórios.'});continue;}
          let c=clientByPhone(phone);
          if(!c){c={id:id(),name,phone,email,neighborhood,address,addressNumber,cep,institution,createdAt:new Date().toISOString(),source:'Importação CSV'};db.clients.push(c);clientsCreated++;}
          else {if(!c.email&&email)c.email=email;if(!c.neighborhood&&neighborhood)c.neighborhood=neighborhood;if(!c.address&&address)c.address=address;if(!c.addressNumber&&addressNumber)c.addressNumber=addressNumber;if(!c.cep&&cep)c.cep=cep;if(!c.institution&&institution)c.institution=institution;}
          if(category&&description){
            const d={id:id(),number:'NIT-'+new Date().getFullYear()+'-'+String(db.demands.length+1).padStart(5,'0'),clientId:c.id,category,description,location:clean(pick(r,['Local da ocorrência','Local','Endereco da ocorrencia']),220),locationNumber:clean(pick(r,['Numero do local','Número do local','Numero da ocorrencia']),30),neighborhood:clean(pick(r,['Bairro da ocorrencia','Bairro da demanda']),100)||neighborhood||c.neighborhood||'',department:clean(pick(r,['Secretaria responsável','Orgao','Órgão','Secretaria','Orgao ou Departamento Solicitante']),160)||'A definir',requestingDepartment:clean(pick(r,['Orgao ou Departamento Solicitante','Órgão ou Departamento Solicitante']),160),colabTicket:clean(pick(r,['Chamado COLAB N.','Chamado COLAB','COLAB']),100),ecigaTicket:clean(pick(r,['Chamado eCiga','eCiga']),100),protocol:clean(pick(r,['Protocolo oficial','Protocolo']),100),priority:clean(pick(r,['Prioridade']),20)||'Média',status:clean(pick(r,['Status','Situacao','Situação']),40)||'Aberta',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),source:'Importação CSV'};
            db.demands.unshift(d);logEvent('Importação',d.id,'Demanda importada de planilha.');demandsCreated++;
          }
        }
        saveDB(); return json(res,200,{ok:true,clientsCreated,demandsCreated,skipped,errors:errors.slice(0,30)});
      }
      if(req.method==='POST' && url.pathname==='/api/clients') {
        const b=await readBody(req); const name=clean(b.name,140), phone=clean(b.phone,40);
        if(!name||!phone) return json(res,400,{error:'Nome e telefone são obrigatórios.'});
        if(clientByPhone(phone)) return json(res,409,{error:'Já existe cliente com este telefone.'});
        const c={id:id(),name,phone,email:clean(b.email,160),neighborhood:clean(b.neighborhood,100),address:clean(b.address,220),addressNumber:clean(b.addressNumber,30),cep:clean(b.cep,12),institution:clean(b.institution,180),createdAt:new Date().toISOString(),source:'Cadastro interno'}; db.clients.unshift(c); saveDB(); return json(res,201,c);
      }
      if(req.method==='PATCH' && url.pathname.startsWith('/api/clients/')) {
        const cid=url.pathname.split('/').pop(), c=db.clients.find(x=>x.id===cid);
        if(!c) return json(res,404,{error:'Cliente não encontrado.'});
        const b=await readBody(req);
        const fields={name:140,phone:40,email:160,address:220,addressNumber:30,neighborhood:100,cep:12,institution:180};
        for(const [k,max] of Object.entries(fields)) if(b[k]!==undefined) c[k]=clean(b[k],max);
        if(!c.name||!c.phone) return json(res,400,{error:'Nome e telefone são obrigatórios.'});
        const normalized=c.phone.replace(/\\D/g,'');
        const duplicate=db.clients.find(x=>x.id!==cid && String(x.phone||'').replace(/\\D/g,'')===normalized);
        if(duplicate) return json(res,409,{error:'Já existe outro cliente com este telefone.'});
        c.updatedAt=new Date().toISOString();
        logEvent('Atualização de cliente',null,'Cadastro do cliente atualizado: '+c.name);
        saveDB();
        return json(res,200,c);
      }
      if(req.method==='POST' && url.pathname==='/api/demands') {
        const b=await readBody(req); const client=db.clients.find(c=>c.id===b.clientId);
        if(!client) return json(res,400,{error:'Selecione um cliente válido.'});
        if(!clean(b.category,100)||!clean(b.description,3000)) return json(res,400,{error:'Categoria e descrição são obrigatórias.'});
        const d={id:id(),number:'NIT-'+new Date().getFullYear()+'-'+String(db.demands.length+1).padStart(5,'0'),clientId:client.id,category:clean(b.category,100),description:clean(b.description,3000),location:clean(b.location,220),locationNumber:clean(b.locationNumber,30),neighborhood:clean(b.locationNeighborhood,100)||clean(b.neighborhood,100),department:clean(b.department,160)||'A definir',requestingDepartment:clean(b.requestingDepartment,160),colabTicket:clean(b.colabTicket,100),ecigaTicket:clean(b.ecigaTicket,100),protocol:clean(b.protocol,100),priority:clean(b.priority,20)||'Média',status:clean(b.status,40)||'Aberta',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),source:'Cadastro interno'}; db.demands.unshift(d); logEvent('Criação',d.id,'Demanda cadastrada por usuário interno.'); saveDB(); return json(res,201,d);
      }
      if(req.method==='PATCH' && url.pathname.startsWith('/api/demands/')) {
        const did=url.pathname.split('/').pop(), d=db.demands.find(x=>x.id===did); if(!d) return json(res,404,{error:'Demanda não encontrada.'});
        const b=await readBody(req);
        const limits={category:100,description:3000,location:220,locationNumber:30,neighborhood:100,department:160,requestingDepartment:160,colabTicket:100,ecigaTicket:100,protocol:100,priority:20,status:40};
        if(b.clientId!==undefined){const linkedClient=db.clients.find(c=>c.id===b.clientId);if(!linkedClient)return json(res,400,{error:'Selecione um cliente válido.'});d.clientId=linkedClient.id;}
        for(const [k,max] of Object.entries(limits)) if(b[k]!==undefined) d[k]=clean(b[k],max);
        if(b.category!==undefined&&!d.category) return json(res,400,{error:'O assunto da solicitação é obrigatório.'});
        if(b.description!==undefined&&!d.description) return json(res,400,{error:'A descrição da demanda é obrigatória.'});
        d.updatedAt=new Date().toISOString();
        logEvent('Atualização',d.id,'Demanda atualizada: '+Object.keys(limits).filter(k=>b[k]!==undefined).map(k=>k+'='+d[k]).join(', ')+(b.clientId!==undefined?' e cliente vinculado atualizado':''));
        saveDB(); return json(res,200,d);
      }
      return json(res,404,{error:'Rota não encontrada.'});
    }
    return json(res,404,{error:'Página não encontrada.'});
  } catch(e) { return json(res,400,{error:e.message||'Erro ao processar solicitação.'}); }
});
function serve(res,file) { const p=path.join(ROOT,'public',file); if(!p.startsWith(path.join(ROOT,'public'))) {res.writeHead(403);return res.end();} fs.readFile(p,(e,data)=>{if(e){res.writeHead(404);return res.end('Arquivo não encontrado');} const ext=path.extname(p); res.writeHead(200,{'Content-Type':ext==='.html'?'text/html; charset=utf-8':ext==='.css'?'text/css': 'text/javascript; charset=utf-8','Cache-Control':'no-cache'});res.end(data);}); }
server.listen(PORT,()=>{
  try { ensureDailyBackup(); } catch(e) { console.error('Falha ao criar backup diário:',e.message); }
  setInterval(()=>{ try { ensureDailyBackup(); } catch(e) { console.error('Falha no backup automático:',e.message); } },6*60*60*1000);
  console.log(`CRM Niterói disponível em http://localhost:${PORT} | formulário público: /cadastro`);
});
