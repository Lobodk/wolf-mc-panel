'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{spawn}=require('node:child_process');
const dataDir=require('./paths.cjs').defaultDataDir();
fs.mkdirSync(dataDir,{recursive:true});
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function running(){try{const a=JSON.parse(fs.readFileSync(path.join(dataDir,'address.json'))),id=JSON.parse(fs.readFileSync(path.join(dataDir,'installation.json'))).id;if(!Number.isInteger(a.port)||a.port<1024||a.port>65535)return null;const r=await fetch('http://127.0.0.1:'+a.port+'/api/app/health',{signal:AbortSignal.timeout(1500)}),d=await r.json();return ['Wolf MC Panel','Lobo Server Panel'].includes(d.product)&&d.instanceId===id?{...a,url:'http://127.0.0.1:'+a.port+'/'}:null;}catch{return null;}}
function open(file){const child=spawn('rundll32.exe',['url.dll,FileProtocolHandler',file],{detached:true,windowsHide:true,stdio:'ignore'});child.on('error',()=>{});child.unref();}
(async()=>{
 let app=await running();
 async function stopApp(){
  if(!app)return;const cfg=JSON.parse(fs.readFileSync(path.join(dataDir,'control/panel/panel-config.json')));
  const r=await fetch(app.url+'api/app/local-shutdown',{method:'POST',headers:{Authorization:'Bearer '+cfg.panelToken}});if(!r.ok)throw Error((await r.json()).error);for(let i=0;i<40&&await running();i++)await delay(250);
 }
 if(process.argv.includes('--stop')){await stopApp();return;}
 if(process.argv.includes('--reset-password')){
  if(!process.argv.includes('--confirm-local-reset'))throw Error('Utiliza Restablecer contraseña desde el menú Inicio y confirma la operación en este equipo.');
  const recovery=require('./recovery.cjs'),controlDir=path.join(dataDir,'control');
  await recovery.stopOwnedPanel({dataDir,controlDir});
  recovery.resetLocalPassword({dataDir,controlDir,confirmed:true});app=null;
 }
 if(process.argv.includes('--local')){await stopApp();fs.writeFileSync(path.join(dataDir,'hosting.json'),JSON.stringify({mode:'local',lanNames:[]}));app=null;}
 if(!app){
  const stdout=fs.openSync(path.join(dataDir,'app.log'),'a'),stderr=fs.openSync(path.join(dataDir,'errors.log'),'a');
  const child=spawn(process.execPath,[path.join(__dirname,'main.cjs')],{env:{...process.env,LOBO_PANEL_DATA:dataDir},cwd:path.dirname(__dirname),detached:true,windowsHide:true,stdio:['ignore',stdout,stderr]});child.unref();fs.closeSync(stdout);fs.closeSync(stderr);
  for(let i=0;i<60&&!app;i++){await delay(500);app=await running();}if(!app)throw Error('No se pudo iniciar el panel. Revisa errors.log en la carpeta de datos.');
 }
 if(!process.argv.includes('--no-browser')){
  open(app.publicUrl||app.url);
  const marker=path.join(dataDir,'access-shown');if(!fs.existsSync(marker)){open(path.join(dataDir,'ACCESS-KEY.txt'));fs.writeFileSync(marker,'The access file was opened on first launch.');}
 }
})().catch(error=>{const file=path.join(dataDir,'errors.log');fs.appendFileSync(file,new Date().toISOString()+' '+error.message+'\n');if(process.argv.includes('--reset-password')&&!process.argv.includes('--no-browser'))open(file);process.exitCode=1;});
