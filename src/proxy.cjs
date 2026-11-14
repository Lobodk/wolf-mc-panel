'use strict';
const fs=require('node:fs'),path=require('node:path'),{spawn}=require('node:child_process');
function executable(legacy){return legacy?.proxyExecutable||process.env.WOLF_CADDY_EXE||path.resolve(__dirname,'../runtime/caddy.exe');}
async function startProxy({file,dataDir,caddyfile}){
 if(!fs.existsSync(file))throw Error('No se encuentra Caddy. Instala el paquete completo o indica WOLF_CADDY_EXE.');
 const folder=path.join(dataDir,'https');fs.mkdirSync(folder,{recursive:true});const config=path.join(folder,'Caddyfile');
 // The admin API is disabled. Only this process owns and stops its proxy child.
 fs.writeFileSync(config,'{\n    admin off\n}\n'+caddyfile,{mode:0o600});
 const log=fs.openSync(path.join(folder,'proxy.log'),'a');let child;
 try{child=spawn(file,['run','--config',config,'--adapter','caddyfile'],{windowsHide:true,env:{...process.env,XDG_DATA_HOME:folder,XDG_CONFIG_HOME:folder},stdio:['ignore',log,log]});await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});}
 finally{fs.closeSync(log);}
 child.on('error',()=>{});return {pid:child.pid,close:()=>{if(child.exitCode===null)child.kill();}};
}
module.exports={executable,startProxy};
