'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{promisify}=require('node:util');
const scrypt=promisify(crypto.scrypt),LIFETIME=12*60*60*1000;
const params={N:32768,r:8,p:1,maxmem:64*1024*1024};
function createAuth({dataDir,initialKey,now=Date.now,secureCookies=false,cookieName='wolf_session'}){
 const COOKIE=cookieName,secure=secureCookies?'; Secure':'';
 const file=path.join(dataDir,'auth.json'),sessions=new Map();let record=null,derivations=0,changing=false;
 if(fs.existsSync(file)){record=JSON.parse(fs.readFileSync(file,'utf8'));if(record.version!==1||!/^[a-f0-9]{32}$/.test(record.salt)||!/^[a-f0-9]{64}$/.test(record.hash))throw Error('El archivo de seguridad no es válido. Restaura una copia de tus datos.');}
 const equal=(a,b)=>{const x=Buffer.from(a),y=Buffer.from(b);return x.length===y.length&&crypto.timingSafeEqual(x,y);};
 const digest=t=>crypto.createHash('sha256').update(t).digest('hex');
 function cookie(req){const entry=(req.headers.cookie||'').split(';').map(v=>v.trim()).find(v=>v.startsWith(COOKIE+'='));return entry?.slice(COOKIE.length+1)||'';}
 function identify(req){const key=digest(cookie(req)),session=sessions.get(key);if(!session)return null;if(session.expires<=now()){sessions.delete(key);return null;}return key;}
 function issue(res){for(const [key,value]of sessions)if(value.expires<=now())sessions.delete(key);if(sessions.size>=20)sessions.delete(sessions.keys().next().value);const ticket=crypto.randomBytes(32).toString('hex');sessions.set(digest(ticket),{expires:now()+LIFETIME});res.setHeader('Set-Cookie',COOKIE+'='+ticket+'; Path=/; HttpOnly; SameSite=Strict'+secure);}
 function logout(req,res){const key=identify(req);if(key)sessions.delete(key);res.setHeader('Set-Cookie',COOKIE+'=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0'+secure);}
 async function verify(password){if(typeof password!=='string'||password.length>512)return false;if(!record)return equal(password,initialKey);if(derivations>=4)throw Object.assign(Error('Hay demasiados accesos simultáneos. Inténtalo de nuevo en unos segundos.'),{status:429});derivations++;try{const actual=await scrypt(password,record.salt,32,params);return crypto.timingSafeEqual(actual,Buffer.from(record.hash,'hex'));}finally{derivations--;}}
 async function change(current,next,res){
  if(changing)throw Object.assign(Error('Ya se está guardando una contraseña.'),{status:409});changing=true;try{
  if(typeof next!=='string'||next.length<12||next.length>128||/[\x00-\x1f]/.test(next)){const e=Error('Usa una contraseña de entre 12 y 128 caracteres, sin saltos de línea.');e.status=400;throw e;}
  if(!await verify(current)){const e=Error('La contraseña o clave actual no es correcta.');e.status=403;throw e;}
  const salt=crypto.randomBytes(16).toString('hex'),hash=(await scrypt(next,salt,32,params)).toString('hex'),nextRecord={version:1,algorithm:'scrypt',salt,hash};
  fs.writeFileSync(file+'.tmp',JSON.stringify(nextRecord,null,2),{mode:0o600});fs.renameSync(file+'.tmp',file);record=nextRecord;sessions.clear();issue(res);
  // This notice is informational; a locked text file must not report a saved password as failed.
  try{fs.writeFileSync(path.join(dataDir,'ACCESS-KEY.txt'),'La clave inicial ha sido desactivada. Usa tu contraseña personal para entrar al panel.\nLa contraseña se guarda localmente como un hash en auth.json.\n',{mode:0o600});}catch{}
 }finally{changing=false;}
 }
 return {identify,issue,logout,verify,change,configured:()=>Boolean(record)};
}
module.exports={createAuth};
