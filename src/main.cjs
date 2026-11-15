'use strict';
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),crypto=require('node:crypto'),os=require('node:os');
const {createHosting,loopback}=require('./hosting.cjs');
const {executable,startProxy}=require('./proxy.cjs');
const {createAuth}=require('./auth.cjs');
const {defaultDataDir}=require('./paths.cjs');
const PRODUCT='Wolf MC Panel',VERSION='1.0.5';
async function start({dataDir=defaultDataDir(),port=Number(process.env.WOLF_PANEL_PORT||process.env.LOBO_PANEL_PORT)||8787,legacy=null}={}){
 if(process.platform!=='win32'&&!process.env.LOBO_PANEL_FIXTURE)throw Error('Esta versión requiere Windows x64.');
 dataDir=path.resolve(dataDir);fs.mkdirSync(dataDir,{recursive:true});
 const write=(file,data)=>{fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file+'.tmp',JSON.stringify(data,null,2),{mode:0o600});fs.renameSync(file+'.tmp',file);};
 const control=legacy?.serverDir||path.join(dataDir,'control');fs.mkdirSync(path.join(control,'mods'),{recursive:true});
 if(!fs.existsSync(path.join(control,'server.properties')))fs.writeFileSync(path.join(control,'server.properties'),'# Internal panel context; not a Minecraft server.\n');
 if(!fs.existsSync(path.join(control,'user_jvm_args.txt')))fs.writeFileSync(path.join(control,'user_jvm_args.txt'),'-Xmx1024M\n');
 const idFile=path.join(dataDir,'installation.json');if(!fs.existsSync(idFile))write(idFile,{id:crypto.randomUUID()});
 const instanceId=JSON.parse(fs.readFileSync(idFile)).id;
 const prefsFile=path.join(dataDir,'preferences.json');let prefs={name:PRODUCT,icon:'',...legacy?.preferences};
 if(fs.existsSync(prefsFile))Object.assign(prefs,JSON.parse(fs.readFileSync(prefsFile,'utf8')));
 const hosting=createHosting({dataDir,defaults:legacy?.hosting});
 const createPanelInstance=legacy?.createPanelInstance||require('./panel/server').createPanelInstance;
 const createServerManager=legacy?.createServerManager||require('./panel/server-manager').createServerManager;
 const validateIcon=legacy?.validateIcon||require('./panel/server-features').validateIcon;
 const main=legacy?createPanelInstance():createPanelInstance({serverDir:control,appDataDir:dataDir});
 const manager=legacy?createServerManager({main,factory:createPanelInstance,codeDir:legacy.codeDir}):createServerManager({main,factory:createPanelInstance,codeDir:path.join(__dirname,'panel'),dataDir,includeLegacy:false});
 let auth;try{auth=createAuth({dataDir,initialKey:main.config.panelToken,secureCookies:hosting.current.mode==='domain',cookieName:'wolf_session_'+instanceId.replaceAll('-','').slice(0,12)});}catch(error){manager.close();main.close();throw error;}
 const proxyFile=executable(legacy);let proxy=null;
 const attempts=new Map();let closed=false;
 function rateLimit(req){if(attempts.size>2048)attempts.delete(attempts.keys().next().value);const key=req.panelClient||req.socket.remoteAddress,record=attempts.get(key)||{count:0,until:Date.now()+60000};if(record.until<Date.now()){record.count=0;record.until=Date.now()+60000;}if(record.count>=10){const error=Error('Demasiados intentos. Espera un minuto.');error.status=429;throw error;}record.count++;attempts.set(key,record);}
 const server=http.createServer(async(req,res)=>{
  const send=main.sendJson;
  const access=hosting.request(req);if(!access)return send(res,403,{error:'La dirección o la red de acceso no está permitida por la configuración del panel.'});
  req.panelClient=access.client;
  let url;try{url=new URL(req.url,'http://127.0.0.1');}catch{return send(res,400,{error:'Petición no válida.'});}
  res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
  try{
   if(url.pathname==='/api/app/health'&&req.method==='GET')return send(res,200,{product:PRODUCT,version:VERSION,instanceId,mode:hosting.current.mode});
   if(url.pathname==='/api/app/info'&&req.method==='GET')return send(res,200,{...prefs,version:VERSION,supportUrl:'https://ko-fi.com/lobo97',sourceStatus:'source-build'});
   if(url.pathname.startsWith('/api/')&&req.method!=='GET'&&req.headers.origin){let origin;try{origin=new URL(req.headers.origin);}catch{return send(res,403,{error:'Origen no permitido.'});}if(origin.origin!==access.origin)return send(res,403,{error:'Origen no permitido.'});}
   if(url.pathname==='/api/login'){
    if(req.method!=='POST')return send(res,405,{error:'Método no permitido.'});
    rateLimit(req);const data=await main.readJson(req);
    if(hosting.current.mode==='domain'&&!auth.configured())return send(res,403,{error:'Configura primero una contraseña personal mediante acceso local.'});
    if(!await auth.verify(data.token))return send(res,401,{error:'La contraseña o clave no es correcta.'});
    auth.issue(res);return send(res,200,{ok:true,passwordConfigured:auth.configured(),instanceId});
   }
   if(url.pathname==='/api/logout'&&req.method==='POST'){auth.logout(req,res);return send(res,200,{ok:true});}
   if(url.pathname.startsWith('/api/')){
    const localShutdown=url.pathname==='/api/app/local-shutdown'&&req.method==='POST'&&!req.headers.origin&&loopback(req.socket.remoteAddress)&&main.constantTimeTokenMatch((req.headers.authorization||'').replace(/^Bearer /,''));
    if(!auth.identify(req)&&!localShutdown)return send(res,401,{error:'Inicia sesión en el panel.'});
    if(url.pathname==='/api/app/guide'&&req.method==='POST'){if(prefs.guideSeen!==true){const next={...prefs,guideSeen:true};write(prefsFile,next);prefs=next;}return send(res,200,{ok:true,seen:true});}
    if(url.pathname==='/api/app/onboarding'&&req.method==='GET')return send(res,200,{seen:prefs.onboardingSeen===true});
    if(url.pathname==='/api/app/onboarding'&&req.method==='POST'){if(prefs.onboardingSeen!==true){const next={...prefs,onboardingSeen:true};write(prefsFile,next);prefs=next;}return send(res,200,{ok:true,seen:true});}
    if(url.pathname==='/api/app/session'&&req.method==='GET')return send(res,200,{ok:true,passwordConfigured:auth.configured(),instanceId});
    if(url.pathname==='/api/app/password'&&req.method==='PUT'){rateLimit(req);const data=await main.readJson(req);await auth.change(data.current,data.password,res);return send(res,200,{ok:true,passwordConfigured:true,message:'Contraseña guardada localmente. La clave inicial ya no permite iniciar sesión.'});}
    // Child instances share the internal key; it never leaves the backend.
    req.headers.authorization='Bearer '+main.config.panelToken;
    if(url.pathname==='/api/app/hosting'&&req.method==='GET')return send(res,200,{current:hosting.current,pending:hosting.pending(),caddyfile:hosting.caddy(hosting.pending(),server.address().port),passwordConfigured:auth.configured(),managedProxyAvailable:fs.existsSync(proxyFile)});
    if(url.pathname==='/api/app/hosting'&&req.method==='PUT'){const data=await main.readJson(req);if(data.managedProxy&&!fs.existsSync(proxyFile))return send(res,400,{error:'Caddy no está instalado. Utiliza el instalador completo o un proxy propio.'});const next=hosting.save(data,auth.configured());return send(res,200,{ok:true,pending:next,restartRequired:true,caddyfile:hosting.caddy(next,server.address().port),message:'Conexión guardada. Reinicia el panel para aplicarla. El router y el dominio se configuran por separado.'});}
    if(url.pathname==='/api/app/preferences'&&req.method==='PUT'){
     const data=await main.readJson(req),name=String(data.name||'').trim();
     if(!name||name.length>60||/[\x00-\x1f]/.test(name))return send(res,400,{error:'El nombre debe tener entre 1 y 60 caracteres.'});
     if(typeof data.icon!=='string')return send(res,400,{error:'Icono no válido.'});
     if(data.icon){if(!/^data:image\/png;base64,[a-z0-9+/]+=*$/i.test(data.icon))return send(res,400,{error:'El icono debe ser PNG.'});validateIcon(Buffer.from(data.icon.split(',')[1],'base64'));}
     const next={...prefs,name,icon:data.icon};write(prefsFile,next);prefs=next;return send(res,200,{...prefs,message:'Personalización guardada.'});
    }
    if((url.pathname==='/api/app/shutdown'||url.pathname==='/api/app/local-shutdown')&&req.method==='POST'){
     const records=manager.records();
     if(records.some(r=>r.busy))return send(res,409,{error:'Hay una operación activa. Espera a que termine.'});
     // Preserve running Minecraft processes; shutting this panel never deletes worlds.
     send(res,200,{ok:true,message:'Cerrando el panel. Los servidores de Minecraft no se apagan con esta acción.'});setImmediate(()=>close());return;
    }
    if(await manager.handle(req,res,url))return;
    const id=req.headers['x-server-id']||(legacy?'main':'');if(typeof id!=='string'||!id||id==='main'&&!legacy)return send(res,400,{error:'Selecciona un servidor creado en esta instalación.'});
    return await manager.instance(id).handleApi(req,res,url);
   }
   if(req.method==='GET')return main.staticFile(res,url.pathname,req);
   return send(res,405,{error:'Método no permitido.'});
  }catch(error){if(!res.headersSent)send(res,error.status||500,{error:error.message||'No se pudo completar la operación.'});else res.destroy();}
 });
 async function close(){if(closed)return;closed=true;proxy?.close();manager.close();main.close();await new Promise(resolve=>server.close(resolve));}
 let lastError;
 for(let offset=0;offset<20;offset++){
  try{await new Promise((resolve,reject)=>{const failed=error=>{server.off('listening',ready);reject(error);},ready=()=>{server.off('error',failed);resolve();};server.once('error',failed);server.once('listening',ready);server.listen(port+offset,hosting.bindHost);});lastError=null;break;}
  catch(error){lastError=error;if(error.code!=='EADDRINUSE')break;}
 }
 if(lastError){manager.close();main.close();throw lastError;}
 if(hosting.current.mode==='domain'&&hosting.current.managedProxy){try{proxy=await startProxy({file:proxyFile,dataDir,caddyfile:hosting.caddy(hosting.current,server.address().port)});}catch(error){await close();throw error;}}
 const address={publicUrl:hosting.current.origin||'',port:server.address().port,url:'http://127.0.0.1:'+server.address().port+'/',instanceId,pid:process.pid,version:VERSION};
 write(path.join(dataDir,'address.json'),address);
 if(!auth.configured())fs.copyFileSync(path.join(control,'panel/panel-access.txt'),path.join(dataDir,'ACCESS-KEY.txt'));
 return {server,manager,main,address,dataDir,close};
}
module.exports={start};
if(require.main===module)start().then(app=>{
 console.log('Wolf MC Panel escuchando en '+app.address.url);
 for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>app.close().then(()=>process.exit(0)));
}).catch(error=>{console.error(error.message);process.exitCode=1;});
