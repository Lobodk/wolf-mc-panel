'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const fail=message=>{throw Error(message);};
function regular(file){const stat=fs.lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink())fail('La recuperación requiere archivos locales normales.');return fs.readFileSync(file);}
function atomic(file,bytes){const temp=file+'.recovery-'+crypto.randomUUID();try{fs.writeFileSync(temp,bytes,{mode:0o600,flag:'wx'});fs.renameSync(temp,file);}finally{if(fs.existsSync(temp))fs.unlinkSync(temp);}}

/** No HTTP reset endpoint: the caller must be a locally launched desktop tool. */
async function stopOwnedPanel({dataDir,controlDir,fetcher=fetch}){
 const addressFile=path.join(dataDir,'address.json');if(!fs.existsSync(addressFile))return;
 const address=JSON.parse(regular(addressFile)),identity=JSON.parse(regular(path.join(dataDir,'installation.json')));
 if(!Number.isInteger(address.port)||address.port<1024||address.port>65535||address.instanceId!==identity.id)fail('No se pudo identificar el panel local. Cierra el panel y vuelve a intentarlo.');
 const url='http://127.0.0.1:'+address.port+'/';
 async function health(){try{const response=await fetcher(url+'api/app/health',{signal:AbortSignal.timeout(2000)});if(!response.ok)fail('El puerto local pertenece a otro servicio.');const data=await response.json();if(data.instanceId!==identity.id||data.product!=='Wolf MC Panel')fail('El puerto local pertenece a otra instalación.');return true;}catch(error){if(error.cause?.code==='ECONNREFUSED')return false;throw error;}}
 if(!await health())return;
 const config=JSON.parse(regular(path.join(controlDir,'panel/panel-config.json')));
 const response=await fetcher(url+'api/app/local-shutdown',{method:'POST',headers:{Authorization:'Bearer '+config.panelToken},signal:AbortSignal.timeout(5000)});
 if(!response.ok)fail('No se pudo cerrar el panel: '+String((await response.json()).error||response.status));
 for(let i=0;i<60;i++){await delay(250);if(!await health())return;}
 fail('El panel sigue abierto. No se ha restablecido la contraseña.');
}

function resetLocalPassword({dataDir,controlDir=path.join(dataDir,'control'),registryFile=path.join(dataDir,'servers.json'),managedRoot=path.join(dataDir,'servers'),confirmed=false}){
 if(confirmed!==true)fail('Confirma el restablecimiento desde el equipo del servidor.');
 dataDir=path.resolve(dataDir);controlDir=path.resolve(controlDir);
 const lock=path.join(dataDir,'.password-recovery.lock');let fd;
 try{fd=fs.openSync(lock,'wx',0o600);}catch{fail('Ya hay una recuperación en curso.');}
 try{
  const authFile=path.join(dataDir,'auth.json');if(!fs.existsSync(authFile))fail('Todavía se utiliza la clave inicial. Consulta ACCESS-KEY.txt; no hay contraseña personal que restablecer.');
  const files=new Map(),remember=file=>{if(!files.has(file))files.set(file,fs.existsSync(file)?regular(file):null);};
  remember(authFile);remember(path.join(dataDir,'hosting.json'));remember(path.join(dataDir,'ACCESS-KEY.txt'));remember(path.join(dataDir,'access-shown'));
  const configs=[path.join(controlDir,'panel/panel-config.json')];
  const registry=registryFile;
  if(fs.existsSync(registry))for(const record of JSON.parse(regular(registry))){
   if(record.id==='main')continue;
   if(!/^[0-9a-f-]{36}$/.test(record.id))fail('Registro de servidores inválido.');
   const expected=path.resolve(managedRoot,record.id);
   if(path.resolve(record.directory).toLowerCase()!==expected.toLowerCase())fail('Un servidor apunta fuera de su carpeta administrada.');
   if(fs.realpathSync(expected).toLowerCase()!==expected.toLowerCase())fail('No se recuperan servidores mediante enlaces de carpetas.');
   const file=path.join(expected,'panel/panel-config.json');if(fs.existsSync(file))configs.push(file);
  }
  const next=[];
  const key=crypto.randomBytes(32).toString('base64url');
  for(const file of configs){remember(file);const config=JSON.parse(files.get(file));config.panelToken=key;next.push([file,JSON.stringify(config,null,2)]);const access=path.join(path.dirname(file),'panel-access.txt');remember(access);next.push([access,'Clave temporal del panel: '+key+'\n']);}
  const backup=path.join(dataDir,'recovery-backups',new Date().toISOString().replace(/[:.]/g,'-')+'-'+crypto.randomBytes(3).toString('hex'));
  fs.mkdirSync(backup,{recursive:true,mode:0o700});let index=0;
  for(const [file,bytes]of files)if(bytes!==null)fs.writeFileSync(path.join(backup,String(index++)+'-'+path.basename(file)),bytes,{mode:0o600,flag:'wx'});
  const changed=[];
  try{
   for(const [file,bytes]of next){atomic(file,bytes);changed.push(file);}
   const hosting=path.join(dataDir,'hosting.json');atomic(hosting,JSON.stringify({mode:'local',lanNames:[]}));changed.push(hosting);
   const access=path.join(dataDir,'ACCESS-KEY.txt');atomic(access,'Recuperación local de Wolf MC Panel\n\nClave temporal: '+key+'\n\nEntra desde este PC y crea una contraseña nueva en Seguridad y contraseña.\nLas sesiones anteriores se han cerrado. El panel permanece limitado a este PC.\nLos servidores de Minecraft y sus mundos no se han modificado.\n');changed.push(access);
   // Removing the hash is last. The running panel must already have been stopped.
   fs.unlinkSync(authFile);changed.push(authFile);
   const marker=path.join(dataDir,'access-shown');if(fs.existsSync(marker)){fs.unlinkSync(marker);changed.push(marker);}
  }catch(error){for(const file of [...new Set(changed)].reverse()){const bytes=files.get(file);if(bytes===null){if(fs.existsSync(file))fs.unlinkSync(file);}else atomic(file,bytes);}throw error;}
  return {accessFile:path.join(dataDir,'ACCESS-KEY.txt'),backupDir:backup};
 }finally{if(fd!==undefined)fs.closeSync(fd);fs.unlinkSync(lock);}
}
module.exports={stopOwnedPanel,resetLocalPassword};
