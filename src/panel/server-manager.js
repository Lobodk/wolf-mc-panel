'use strict';
const fs=require('node:fs'),fsp=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),net=require('node:net'),crypto=require('node:crypto'),dns=require('node:dns/promises');
const {spawn,execFile}=require('node:child_process');const {promisify}=require('node:util');const run=promisify(execFile);
const catalogs=require('./server-catalog');
const {validateIcon}=require('./server-features');
const {prepareClone,regenerateWorld}=require('./server-worlds');
const {prepareRegistryBridge}=require('./registry-bridge');
const {preconfiguredNetwork,currentWarnings}=require('./network-preconfiguration');
const validId=id=>typeof id==='string'&&(id==='main'||/^[0-9a-f-]{36}$/.test(id));
const fail=(message,status=400)=>{const e=Error(message);e.status=status;throw e;};
function write(file,data){fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file+'.tmp',JSON.stringify(data,null,2),{mode:0o600});fs.renameSync(file+'.tmp',file);}
function portNumber(v){const n=Number(v);if(!Number.isInteger(n)||n<1024||n>65535)fail('El puerto debe estar entre 1024 y 65535.');return n;}
function hostName(value){const v=String(value||'').trim().toLowerCase();if(v.length<1||v.length>253||! /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(v)||v.includes('..'))fail('Escribe un dominio o una IP sin http, rutas ni puerto.');return v;}
function localAddresses(){return Object.values(os.networkInterfaces()).flat().filter(a=>a&&!a.internal&&a.family==='IPv4').map(a=>a.address);}
async function portOpen(port){return (await Promise.all(['127.0.0.1',...localAddresses()].map(host=>new Promise(resolve=>{const s=net.connect(port,host);s.setTimeout(700);s.once('connect',()=>{s.destroy();resolve(true);});s.once('error',()=>resolve(false));s.once('timeout',()=>{s.destroy();resolve(false);});})))).some(Boolean);}
function prop(text,key,value){const lines=String(text).split(/\r?\n/),prefix=key+'=';return [...lines.filter(line=>!line.startsWith(prefix)&&line!==''),prefix+String(value).replace(/[\r\n]/g,'')].join('\n')+'\n';}
const samePath=(left,right)=>{const a=path.resolve(left),b=path.resolve(right);return process.platform==='win32'?a.toLowerCase()===b.toLowerCase():a===b;};
async function canonicalChild(directory,parent,name){const stat=await fsp.lstat(directory);return stat.isDirectory()&&!stat.isSymbolicLink()&&samePath(await fsp.realpath(directory),path.join(await fsp.realpath(parent),name));}
function createServerManager({main,factory,codeDir,catalogProvider=catalogs,probe=portOpen,commandRunner=run,bridgeProvider=prepareRegistryBridge,dataDir,includeLegacy=false,nativeHosting}){
 const run=commandRunner;
 const stateDir=dataDir||codeDir,registryFile=path.join(stateDir,'servers.json'),baseDir=path.join(stateDir,'servers'),runtimeBase=path.join(stateDir,'runtimes');
 const mainDir=path.resolve(codeDir,'..'),instances=new Map([['main',main]]),jobs=new Map(),busy=new Set(),runtimeJobs=new Map(),deleteIntents=new Map();let creating=false;
 let records=fs.existsSync(registryFile)?JSON.parse(fs.readFileSync(registryFile,'utf8')):[];
 if(!Array.isArray(records))throw Error('Registro de servidores inválido.');
 if(includeLegacy&&!records.some(r=>r.id==='main'))records.unshift({id:'main',name:"Lobodk's Server",directory:mainDir,minecraftVersion:'26.3',loader:'neoforge',loaderVersion:(/neoforge[\\/]([^\\/\r\n]+)[\\/]win_args/.exec(fs.readFileSync(path.join(mainDir,'run.bat'),'utf8'))||[])[1]||'',serverPort:main.config.serverPort,rconPort:main.config.rconPort,publicHost:localAddresses()[0]||'127.0.0.1',externalPort:main.config.serverPort,status:'ready',memoryMb:16384,createdAt:new Date().toISOString(),legacy:true});
 for(const r of records){if(!validId(r.id))throw Error('ID de servidor inválido.');if(r.id!=='main'&&path.resolve(r.directory)!==path.join(baseDir,r.id))throw Error('Carpeta de servidor fuera del directorio gestionado.');if(r.status==='installing'){r.status='failed';r.error='La instalación se interrumpió al cerrar el panel. Puedes reintentarla.';}}
 const save=()=>write(registryFile,records);save();
 let autoStartId=records.find(r=>r.autoStart===true&&!r.legacy&&r.status==='ready')?.id;
 function updateAutoStart(r,enabled){
  if(r.legacy||r.status!=='ready'||busy.has(r.id))fail('Servidor no disponible para configurar el arranque.',409);
  if(typeof enabled!=='boolean')fail('Preferencia de arranque no válida.');
  if(!enabled&&autoStartId!==r.id)return;
  const previous=records.map(entry=>entry.autoStart);
  const next=enabled?r.id:undefined;
  for(const entry of records)entry.autoStart=entry.id===next;
  try{save();autoStartId=next;}catch(error){records.forEach((entry,i)=>{entry.autoStart=previous[i];});throw error;}
 }
 async function startAutomatic(){
  const selected=records.find(r=>r.id===autoStartId&&r.status==='ready');
  if(!selected||travelling(selected.id)||busy.has(selected.id))return null;
  if(moved(selected))await nativeHosting.context().ensure();
  if(selected.id!==autoStartId||travelling(selected.id))return null;
  await instance(selected.id).startIfStopped();
  return selected.name;
 }
 function record(id){if(!validId(id))fail('Servidor no válido.',404);const r=records.find(r=>r.id===id);if(!r)fail('Servidor no encontrado.',404);return r;}
 function processAlive(r){try{const meta=JSON.parse(fs.readFileSync(path.join(r.directory,'panel/managed-process.json'),'utf8'));if(!Number.isInteger(meta.pid)||meta.pid<=0)return false;process.kill(meta.pid,0);return true;}catch{return false;}}
 function publicRecord(r){const local=localAddresses();let memoryMb=r.memoryMb;try{const match=/-Xmx(\d+)([gm])/i.exec(fs.readFileSync(path.join(r.directory,'user_jvm_args.txt'),'utf8'));if(match)memoryMb=Number(match[1])*(match[2].toLowerCase()==='g'?1024:1);}catch{}return {id:r.id,name:r.name,autoStart:r.id===autoStartId,hasIcon:fs.existsSync(path.join(r.directory,'server-icon.png')),minecraftVersion:r.minecraftVersion,loader:r.loader,loaderVersion:r.loaderVersion||'',serverPort:r.serverPort,externalPort:r.externalPort,publicHost:r.publicHost,localAddress:(r.bindAddress||local[0]||'127.0.0.1')+':'+r.serverPort,publicAddress:r.publicHost+(r.externalPort===25565?'':':'+r.externalPort),memoryMb,status:r.status,error:r.error||'',busy:busy.has(r.id),legacy:Boolean(r.legacy),eulaAccepted:Boolean(r.eulaAccepted||r.legacy),createdAt:r.createdAt,bindAddress:r.bindAddress||''};}
 function assertFree(port,id,field){for(const r of records){if(r.id===id)continue;if([r.serverPort,r.rconPort].includes(port))fail('Ese puerto ya está reservado por '+r.name+'.');if(field==='external'&&r.externalPort===port)fail('Ese puerto público ya pertenece a '+r.name+'.');}if(port===main.config.port)fail('Ese puerto pertenece al panel web.');}
 async function allocate(start,external=false){for(let p=start;p<=65535;p++){if(p===main.config.port||records.some(r=>[r.serverPort,r.rconPort,...(external?[r.externalPort]:[])].includes(p)))continue;if(!await probe(p))return p;}fail('No se encuentra un puerto libre.');}
 const moved = r => r.id===nativeHosting?.id && nativeHosting.owner().owner==='primary';
 const travelling = id => id===nativeHosting?.id && nativeHosting.blocked();
 const activeRequests=new Map(),worldLocks=new Set(),resetIntents=new Map();
 async function track(id,work){
  activeRequests.set(id,(activeRequests.get(id)||0)+1);
  try{return await work();}
  finally{const count=activeRequests.get(id)-1;if(count)activeRequests.set(id,count);else activeRequests.delete(id);}
 }
 function instance(id){const r=record(id);if(r.status!=='ready')fail(r.error||'El servidor todavía no está instalado.',409);if(instances.has(id))return instances.get(id);
  const remote=moved(r)?nativeHosting.context():null;
  const allowsHandoff=()=>r.id===nativeHosting?.id&&nativeHosting.allowsLocalHandoff();
  const obj=factory({serverDir:remote?.root||r.directory,panelDir:path.join(r.directory,'panel'),record:r,appDataDir:stateDir,panelToken:main.config.panelToken,backupId:(r.backupLabel||r.name).replace(/[^a-zA-Z0-9_-]+/g,'-')+'-'+r.id.slice(0,8),javaHome:r.javaHome,launch:remote?.start||(handoff=>launch(r,handoff)),remote,allowsHandoff,externalBusy:()=>busy.has(id)||travelling(id)});instances.set(id,obj);return obj;}
 async function route(id,req,res,url){
  const r=record(id);
  const work=async()=>{
   if(travelling(id) && req.method!=='GET')fail('Hay un traslado pendiente de Minecraft.',409);
   if(worldLocks.has(id)&&req.method!=='GET')fail('Hay una operación de mundo en curso.',409);
   if(moved(r))await nativeHosting.context().ensure();
   if(travelling(id)&&req.method!=='GET')fail('Hay un traslado pendiente de Minecraft.',409);
   return await instance(id).handleApi(req,res,url);
  };
  return req.method==='GET'?work():track(id,work);
 }
 async function launch(r,handoff=false){const fenced=()=>moved(r)||(travelling(r.id)&&!(handoff&&nativeHosting.allowsLocalHandoff()));if(fenced())fail('Esta copia no tiene el permiso de arranque.',409);if(busy.has(r.id))fail('Hay una instalación en curso.',409);if(processAlive(r))fail('Java sigue arrancando o apagando este servidor. Espera y revisa la consola.',409);if(!r.eulaAccepted)fail('Debes aceptar la EULA de Minecraft antes de iniciar.',409);const launch=JSON.parse(await fsp.readFile(path.join(r.directory,'panel/launch.json'),'utf8'));if(fenced())fail('Esta copia no tiene el permiso de arranque.',409);const output=fs.openSync(path.join(r.directory,'panel/process.log'),'a');
  const jvmFile=path.join(r.directory,'user_jvm_args.txt');const jvmArgs=r.javaMajor<9?fs.readFileSync(jvmFile,'utf8').split(/\r?\n/).filter(line=>line.trim()&&!line.trim().startsWith('#')).flatMap(line=>line.trim().split(/\s+/)):['@'+jvmFile];
  const child=spawn(path.join(r.javaHome,'bin/java.exe'),[...jvmArgs,'-Dterminal.jline=false','-Dterminal.ansi=false',...(launch.bridgeArg?[launch.bridgeArg]:[]),...launch.args],{cwd:r.directory,windowsHide:true,detached:true,stdio:['ignore',output,output]});fs.closeSync(output);await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});child.unref();write(path.join(r.directory,'panel/managed-process.json'),{pid:child.pid,startedAt:Date.now()});return child;}
 function updateJob(job,fields){Object.assign(job,fields,{updatedAt:Date.now()});}
 async function ensureJava(major,job){
  const primary=path.join(mainDir,'runtime');try{const rel=await fsp.readFile(path.join(primary,'release'),'utf8');if(Number(/JAVA_VERSION="(?:1\.)?(\d+)/.exec(rel)?.[1])===major)return primary;}catch{}
  const dest=path.join(runtimeBase,'java-'+major);if(fs.existsSync(path.join(dest,'bin/java.exe')))return dest;
  if(runtimeJobs.has(major))return runtimeJobs.get(major);
  const task=(async()=>{updateJob(job,{phase:'Instalando Java '+major,percent:8});const url='https://api.adoptium.net/v3/assets/latest/'+major+'/hotspot?architecture=x64&image_type=jdk&os=windows&jvm_impl=hotspot&vendor=eclipse';const response=await fetch(url,{signal:AbortSignal.timeout(30000)});if(!response.ok)throw Error('No se pudo obtener Java '+major+'.');const assets=await response.json();const pkg=assets[0]?.binary?.package;if(!pkg?.link||!pkg.checksum)throw Error('No hay runtime Java compatible para este Windows.');
   const stage=path.join(runtimeBase,'.install-'+crypto.randomUUID());await fsp.mkdir(stage,{recursive:true});const archive=path.join(stage,'runtime.zip'),unpacked=path.join(stage,'unpacked');await catalogProvider.download(pkg.link,archive,{sha256:pkg.checksum,maxBytes:450*1024*1024,progress:(bytes,total)=>updateJob(job,{phase:'Descargando Java '+major,percent:8+(total?Math.round(bytes/total*18):0),downloadedBytes:bytes,totalBytes:total})});
   await run('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(codeDir,'extract-runtime.ps1'),'-Archive',archive,'-Destination',unpacked],{windowsHide:true,timeout:120000,maxBuffer:1024*1024});const dirs=await fsp.readdir(unpacked,{withFileTypes:true});const jdk=dirs.find(d=>d.isDirectory()&&fs.existsSync(path.join(unpacked,d.name,'bin/java.exe')));if(!jdk)throw Error('El runtime descargado no contiene Java.');await fsp.rename(path.join(unpacked,jdk.name),dest);return dest;})();runtimeJobs.set(major,task);try{return await task;}finally{runtimeJobs.delete(major);}}
 function guessedJava(version){const m=/^1\.(\d+)(?:\.(\d+))?/.exec(version);if(!m)return /^26\./.test(version)?25:8;const minor=Number(m[1]);return minor<=16?8:minor<=20&&(minor<20||Number(m[2]||0)<=4)?17:21;}
 async function install(r,job,{updating=false}={}){
  if(await probe(r.serverPort)||processAlive(r))fail('Apaga este servidor antes de cambiar su versión o loader.',409);
  const detail=await catalogProvider.minecraftDetails(r.minecraftVersion);const major=Number(detail.javaVersion?.majorVersion)||guessedJava(r.minecraftVersion);
  let selected=null;if(r.loader!=='vanilla'){const available=await catalogProvider.loaderVersions(r.minecraftVersion,r.loader);selected=available.versions.find(v=>v.id===r.loaderVersion);if(!selected)throw Error('La versión de loader elegida no es compatible con ese Minecraft.');}
  const javaHome=await ensureJava(major,job);await fsp.mkdir(path.join(r.directory,'panel'),{recursive:true});await fsp.mkdir(path.join(r.directory,'mods'),{recursive:true});
  const serverJar=path.join(r.directory,'server.jar'),oldJar=path.join(r.directory,'panel','previous-server-'+job.id+'.jar');if(fs.existsSync(serverJar))await fsp.copyFile(serverJar,oldJar);
  const rollbackFiles=['panel/launch.json','panel/panel-config.json','panel/registry-agent.properties','server.properties','user_jvm_args.txt','eula.txt'];
  const previous=new Map();for(const name of rollbackFiles){try{previous.set(name,await fsp.readFile(path.join(r.directory,name)));}catch{previous.set(name,null);}}
  try{
   updateJob(job,{phase:'Descargando Minecraft '+r.minecraftVersion,percent:30,downloadedBytes:0,totalBytes:0});const temp=serverJar+'.'+job.id+'.tmp';await catalogProvider.download(detail.downloads.server.url,temp,{sha1:detail.downloads.server.sha1,progress:(bytes,total)=>updateJob(job,{phase:'Descargando Minecraft '+r.minecraftVersion,percent:30+(total?Math.round(bytes/total*35):0),downloadedBytes:bytes,totalBytes:total})});await fsp.rename(temp,serverJar);
   let args=['-jar',serverJar,'nogui'];
   if(r.loader==='fabric'){updateJob(job,{phase:'Preparando Fabric',percent:70});const url=await catalogProvider.fabricLauncher(r.minecraftVersion,r.loaderVersion),file=path.join(r.directory,'fabric-server-launch.jar'),tmp=file+'.'+job.id+'.tmp';await catalogProvider.download(url,tmp);await fsp.rename(tmp,file);args=['-jar',file,'nogui'];}
   if(['neoforge','forge'].includes(r.loader)){
    updateJob(job,{phase:'Instalando '+r.loader+' y sus bibliotecas',percent:70});const file=path.join(r.directory,'panel','loader-installer-'+job.id+'.jar');const url=r.loader==='neoforge'?'https://maven.neoforged.net/releases/net/neoforged/neoforge/'+r.loaderVersion+'/neoforge-'+r.loaderVersion+'-installer.jar':'https://maven.minecraftforge.net/net/minecraftforge/forge/'+r.loaderVersion+'/forge-'+r.loaderVersion+'-installer.jar';await catalogProvider.download(url,file);
    try{const out=await run(path.join(javaHome,'bin/java.exe'),['-jar',file,'--installServer'],{cwd:r.directory,windowsHide:true,timeout:15*60000,maxBuffer:12*1024*1024});await fsp.writeFile(path.join(r.directory,'panel/installer.log'),out.stdout+'\n'+out.stderr);}catch(error){await fsp.writeFile(path.join(r.directory,'panel/installer.log'),String(error.stdout||'')+'\n'+String(error.stderr||error.message));throw Error('Falló el instalador del loader. Se conserva la configuración anterior; revisa el registro de instalación.');}
    const winArgs=path.join(r.directory,'libraries',...(r.loader==='neoforge'?['net','neoforged','neoforge']:['net','minecraftforge','forge']),r.loaderVersion,'win_args.txt');
    if(fs.existsSync(winArgs))args=['@'+winArgs,'nogui'];else{const legacy=path.join(r.directory,'forge-'+r.loaderVersion+'.jar');if(!fs.existsSync(legacy))throw Error('Este instalador antiguo no ha producido un arranque compatible con el panel.');args=['-jar',legacy,'nogui'];}
   }
   r.javaHome=javaHome;r.javaMajor=major;
   let bridgeArg='';try{bridgeArg=await bridgeProvider({record:r,detail,codeDir});}catch{r.catalogNote='El catálogo completo se preparará cuando haya un puente compatible con esta versión.';}
   write(path.join(r.directory,'panel/launch.json'),{args,bridgeArg});
   // Vanilla data generation does not start a world or accept an EULA. It supplies an exact base-item registry.
   if(major>=17){
    updateJob(job,{phase:'Preparando el catálogo de objetos vanilla',percent:88});
    const generated=path.join(r.directory,'panel/registry-data');
    try{await run(path.join(javaHome,'bin/java.exe'),['-DbundlerMainClass=net.minecraft.data.Main','-jar',serverJar,'--reports','--output',generated],{cwd:r.directory,windowsHide:true,timeout:120000,maxBuffer:8*1024*1024});const reports=JSON.parse(await fsp.readFile(path.join(generated,'reports/registries.json'),'utf8'));const entries=reports['minecraft:item']?.entries;if(entries){const items=Object.keys(entries).filter(id=>id!=='minecraft:air').map(id=>({id,translationKey:'item.'+id.replace(':','.').replaceAll('/','.'),fallbackName:'',maxStackSize:64}));write(path.join(r.directory,'panel/telemetry/items.json'),{schema:1,generatedAt:Date.now(),minecraftVersion:r.minecraftVersion,catalogScope:r.loader==='vanilla'?'vanilla':'vanilla-base',mods:[{id:'minecraft',name:'Minecraft',version:r.minecraftVersion}],items});}}
    catch{r.catalogNote='No se pudo generar el catálogo base para esta versión. La consola y la gestión siguen disponibles.';}
   }
   const panelConfig=path.join(r.directory,'panel/panel-config.json');let cfg={};try{cfg=JSON.parse(await fsp.readFile(panelConfig,'utf8'));}catch{}
   Object.assign(cfg,{panelToken:main.config.panelToken,serverPort:r.serverPort,rconPort:r.rconPort,rconHost:r.bindAddress||'127.0.0.1',rconPassword:cfg.rconPassword||crypto.randomBytes(32).toString('hex'),bindHost:'127.0.0.1',port:main.config.port});write(panelConfig,cfg);
   let properties='';try{properties=await fsp.readFile(path.join(r.directory,'server.properties'),'utf8');}catch{}
   const values={'server-port':r.serverPort,'server-ip':r.bindAddress||'', 'enable-rcon':true,'rcon.port':r.rconPort,'rcon.password':cfg.rconPassword,'online-mode':true,'max-players':r.maxPlayers||20,'difficulty':r.difficulty||'normal','motd':r.name,'broadcast-rcon-to-ops':false,'broadcast-console-to-ops':false};
   if(!updating)Object.assign(values,{'view-distance':10,'simulation-distance':10,'white-list':false,'level-seed':r.seed||''});
   for(const [key,value] of Object.entries(values))properties=prop(properties,key,value);await fsp.writeFile(path.join(r.directory,'server.properties'),properties);await fsp.writeFile(path.join(r.directory,'user_jvm_args.txt'),'-Xms512M\n-Xmx'+r.memoryMb+'M\n');await fsp.writeFile(path.join(r.directory,'eula.txt'),'eula='+String(Boolean(r.eulaAccepted))+'\n');
   // New servers have no gameplay mods. The read-only JVM bridge exports their item registry.
   if(instances.has(r.id)){instances.get(r.id).close();instances.delete(r.id);}
   r.status='ready';r.error='';save();const warnings=[],coverage=preconfiguredNetwork(codeDir,r,localAddresses());
   if(r.configureFirewall&&!coverage.firewall){updateJob(job,{percent:96,phase:'Configurando el firewall de Windows'});try{await applyFirewall(r);}catch(error){warnings.push(error.message);}}
   if(!updating&&r.configureUpnp&&!coverage.router){updateJob(job,{percent:98,phase:'Configurando el puerto del router'});try{await upnp(r);}catch(error){warnings.push(error.message);}}
   r.networkWarnings=warnings;save();updateJob(job,{percent:100,phase:warnings.length?'Servidor preparado · revisar conexión':'Servidor preparado',done:true,ok:true,server:publicRecord(r),warnings,networkMessage:coverage.firewall&&coverage.router?'Este puerto ya está incluido en las reglas manuales de Windows y del router. No necesita UPnP.':'',restartRequired:updating});
  }catch(error){if(fs.existsSync(oldJar))await fsp.copyFile(oldJar,serverJar);for(const [name,content]of previous){const file=path.join(r.directory,name);if(content!==null)await fsp.writeFile(file,content);else await fsp.rm(file,{force:true});}throw error;}
 }
 function background(r,work){if(busy.has(r.id))fail('Ya hay una instalación en curso.',409);const job={id:crypto.randomUUID(),serverId:r.id,percent:0,phase:'Preparando instalación',done:false,createdAt:Date.now()};jobs.set(job.id,job);busy.add(r.id);Promise.resolve().then(()=>work(job)).catch(error=>{updateJob(job,{done:true,ok:false,error:error.message,phase:'No se pudo completar'});if(r.status!=='ready'){r.status='failed';r.error=error.message;}save();}).finally(()=>busy.delete(r.id));return job;}
 async function create(data){if(creating)fail('Hay otra creación en preparación. Espera unos segundos.',409);creating=true;try{
  if(records.length>=20)fail('El panel admite hasta 20 servidores registrados.');if(data.acceptEula!==true)fail('Debes leer y aceptar la EULA de Minecraft en el asistente.');
  const name=String(data.name||'').trim();if(!name||name.length>80||/[\r\n\x00-\x1f]/.test(name))fail('Nombre de servidor no válido.');
  if(!['vanilla','forge','neoforge','fabric'].includes(data.loader))fail('Loader no válido.');
  await catalogProvider.minecraftDetails(data.minecraftVersion);
  const memoryMb=Number(data.memoryMb||4096);if(!Number.isInteger(memoryMb)||memoryMb<1024||memoryMb>Math.floor(os.totalmem()/1048576))fail('La RAM debe estar entre 1 GB y la memoria del equipo.');
  const serverPort=data.serverPort?portNumber(data.serverPort):await allocate(25565);assertFree(serverPort);if(await probe(serverPort))fail('Ese puerto está ocupado por otro proceso.');
  const rconPort=await allocate(Math.max(26575,serverPort+1));if(rconPort===serverPort)fail('No se pudo reservar RCON.');
  const externalPort=data.externalPort?portNumber(data.externalPort):serverPort;assertFree(externalPort,null,'external');
  const bindAddress=String(data.bindAddress||'');if(bindAddress&&bindAddress!=='127.0.0.1'&&!localAddresses().includes(bindAddress))fail('La IP local no pertenece a este PC.');
  const maxPlayers=Number(data.maxPlayers||20);if(!Number.isInteger(maxPlayers)||maxPlayers<1||maxPlayers>1000)fail('Máximo de jugadores no válido.');
  if(!['peaceful','easy','normal','hard'].includes(data.difficulty||'normal'))fail('Dificultad no válida.');
  const id=crypto.randomUUID(),r={id,name,configureFirewall:data.configureFirewall===true,configureUpnp:data.configureUpnp===true,directory:path.join(baseDir,id),minecraftVersion:data.minecraftVersion,loader:data.loader,loaderVersion:data.loader==='vanilla'?'':catalogProvider.safeVersion(data.loaderVersion||''),serverPort,rconPort,externalPort,publicHost:hostName(data.publicHost||localAddresses()[0]||'127.0.0.1'),bindAddress,memoryMb,maxPlayers,difficulty:data.difficulty||'normal',seed:String(data.seed||'').slice(0,100),eulaAccepted:true,eulaAcceptedAt:new Date().toISOString(),status:'installing',createdAt:new Date().toISOString()};
  records.push(r);save();const job=background(r,j=>install(r,j));return {server:publicRecord(r),jobId:job.id};
 }finally{creating=false;}}
 async function changePlatform(r,data){if(r.legacy)fail('El servidor original conserva su instalación actual. Utiliza su actualizador existente.',409);if(await probe(r.serverPort))fail('Apaga este servidor antes de cambiar su versión o loader.',409);if(data.confirmBackup!==true)fail('Confirma la copia previa antes de cambiar la plataforma.');if(!['vanilla','forge','neoforge','fabric'].includes(data.loader))fail('Loader no válido.');
  if(instance(r.id).isBusy())fail('Espera a que termine la operación de este servidor.',409);
  const pendingFile=path.join(r.directory,'panel/pending-mods/manifest.json');if(fs.existsSync(pendingFile)&&JSON.parse(await fsp.readFile(pendingFile,'utf8')).length)fail('Aplica o cancela los mods pendientes antes de cambiar la plataforma.',409);
  const original={...r};const nextDetail=await catalogProvider.minecraftDetails(data.minecraftVersion),oldDetail=await catalogProvider.minecraftDetails(r.minecraftVersion);if(data.minecraftVersion!==r.minecraftVersion&&Date.parse(nextDetail.releaseTime)<Date.parse(oldDetail.releaseTime))fail('No se rebaja la versión de un mundo existente. Crea otro servidor para usar una versión anterior.');
  if(r.loader!=='vanilla'&&r.loader!==data.loader){const jars=(await fsp.readdir(path.join(r.directory,'mods'))).filter(name=>name.endsWith('.jar')&&!name.startsWith('lobodk-network-telemetry-'));if(jars.length)fail('Retira los mods de este servidor antes de cambiar de familia de loader. Los mods no se convierten entre loaders.');}
  const job=background(r,async j=>{updateJob(j,{phase:'Guardando copia antes de cambiar la plataforma',percent:2});await instance(r.id).backup();try{Object.assign(r,{minecraftVersion:catalogProvider.safeVersion(data.minecraftVersion),loader:data.loader,loaderVersion:data.loader==='vanilla'?'':catalogProvider.safeVersion(data.loaderVersion||'')});await install(r,j,{updating:true});}catch(error){Object.assign(r,original);save();throw error;}});return {jobId:job.id};}
 async function connection(r,data){if(busy.has(r.id)||await probe(r.serverPort))fail('Apaga este servidor antes de cambiar puertos o direcciones.',409);const serverPort=portNumber(data.serverPort),externalPort=portNumber(data.externalPort||serverPort);assertFree(serverPort,r.id);assertFree(externalPort,r.id,'external');if(serverPort===r.rconPort)fail('El puerto del juego no puede coincidir con RCON.');if(serverPort!==r.serverPort&&await probe(serverPort))fail('Puerto ocupado.');const publicHost=hostName(data.publicHost);const bindAddress=String(data.bindAddress||'');if(bindAddress&&bindAddress!=='127.0.0.1'&&!localAddresses().includes(bindAddress))fail('La IP local no pertenece a este PC.');
  if(r.legacy&&serverPort!==r.serverPort)fail('El puerto del servidor original se conserva.');
  const propertiesFile=path.join(r.directory,'server.properties');let contents=await fsp.readFile(propertiesFile,'utf8');contents=prop(prop(contents,'server-port',serverPort),'server-ip',bindAddress);await fsp.writeFile(propertiesFile,contents);Object.assign(r,{serverPort,externalPort,publicHost,bindAddress});
  const configFile=path.join(r.directory,'panel/panel-config.json'),cfg=JSON.parse(await fsp.readFile(configFile,'utf8'));cfg.serverPort=serverPort;cfg.rconHost=bindAddress||'127.0.0.1';write(configFile,cfg);const agentConfig=path.join(r.directory,'panel/registry-agent.properties');if(fs.existsSync(agentConfig))await fsp.writeFile(agentConfig,prop(await fsp.readFile(agentConfig,'utf8'),'host',cfg.rconHost));if(!r.legacy&&instances.has(r.id)){instances.get(r.id).close();instances.delete(r.id);}save();return {server:publicRecord(r)};
 }
 async function network(r){const info=publicRecord(r);let addresses=[];try{addresses=await dns.resolve4(r.publicHost);}catch{}const coverage=preconfiguredNetwork(codeDir,r,localAddresses());return {...info,preconfigured:coverage,networkMessage:coverage.firewall&&coverage.router?'Puerto cubierto por las reglas manuales registradas de Windows y del router; no necesita UPnP.':'',localAddresses:localAddresses(),dnsAddresses:addresses,localListening:await probe(r.serverPort),externalReachability:'not-verified',networkWarnings:currentWarnings(r.networkWarnings,coverage),routerRule:{protocol:'TCP',wanPort:r.externalPort,lanPort:r.serverPort,lanHost:r.bindAddress||localAddresses()[0]||''},message:'La asignación en el panel no abre por sí sola el puerto del router. La comprobación local no confirma el acceso desde Internet.'};}
 async function applyFirewall(r){
  if(preconfiguredNetwork(codeDir,r,localAddresses()).firewall)return {ok:true,message:'Este puerto ya está permitido por la regla manual de Windows.'};
  if(r.legacy)fail('La regla del servidor original se conserva.');
  const permits=[['Lobodk Minecraft '+r.id,path.join(r.javaHome,'bin/java.exe')],['Wolf MC Relay '+r.id,process.execPath]];
  const labels=permits.map(([name,program])=>{
   const escaped=program.replace(/'/g,"''");
   return `$rule=Get-NetFirewallRule -DisplayName '${name}' -ErrorAction SilentlyContinue; if ($rule) { $rule | Set-NetFirewallRule -Enabled True -Direction Inbound -Action Allow -Protocol TCP -LocalPort ${r.serverPort} -Program '${escaped}' -Profile Any | Out-Null } else { New-NetFirewallRule -DisplayName '${name}' -Direction Inbound -Action Allow -Protocol TCP -LocalPort ${r.serverPort} -Program '${escaped}' -Profile Any | Out-Null }`;
  });
  try {
   await run('powershell.exe',['-NoProfile','-NonInteractive','-Command',"$ErrorActionPreference='Stop'; "+labels.join(' ; ')],{windowsHide:true,timeout:20000,maxBuffer:1024*1024});
   return {ok:true,message:'Firewall configurado para Java y el reenvío TCP del puerto de juego.'};
  } catch {fail('Windows no permitió crear la regla. Abre el panel como administrador o revisa el firewall de Windows.',409);}
 }
 async function upnp(r){if(preconfiguredNetwork(codeDir,r,localAddresses()).router)return {ok:true,message:'Este puerto ya está incluido en la regla manual del router. No necesita UPnP.'};if(r.legacy)fail('La conexión del servidor original se conserva.');const ip=r.bindAddress||localAddresses()[0];if(!ip)fail('No hay una IP LAN disponible.');const script=`$ErrorActionPreference='Stop'; $nat=New-Object -ComObject HNetCfg.NATUPnP; $maps=$nat.StaticPortMappingCollection; if($null -eq $maps){throw 'UPnP no disponible'}; $old=$null;try{$old=$maps.Item(${r.externalPort},'TCP')}catch{};if($old -and ($old.InternalClient -ne '${ip}' -or $old.InternalPort -ne ${r.serverPort})){throw 'Puerto ocupado en router'};if(-not $old){$maps.Add(${r.externalPort},'TCP',${r.serverPort},'${ip}',$true,'Lobodk Minecraft')|Out-Null};'OK'`;try{await run('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{windowsHide:true,timeout:15000,maxBuffer:1024*1024});return {ok:true,message:'El router aceptó el mapeo UPnP. Comprueba la conexión desde fuera de tu red.'};}catch{fail('El router no permitió UPnP o el puerto está ocupado. Usa la regla TCP indicada en el configurador del router; no se cambió otro mapeo.',409);}}
 async function canDelete(r){
  if(r.legacy||r.id==='main')fail('El servidor original contiene el panel y no se puede eliminar desde aquí.',409);
  if(busy.has(r.id)||instances.get(r.id)?.isBusy())fail('Espera a que termine el mantenimiento de este servidor.',409);
  if(await probe(r.serverPort)||processAlive(r))fail('Apaga este servidor y espera a que Java termine antes de eliminarlo.',409);
 }
 async function managedWorld(r){
  if(r.legacy||r.status!=='ready')fail('Solo está disponible para servidores gestionados y preparados.',409);
  if(moved(r)||travelling(r.id))fail('Devuelve el servidor al PC secundario antes de continuar.',409);
  if(!await canonicalChild(r.directory,baseDir,r.id))fail('La carpeta del servidor no es válida.',409);
 }
 async function withWorldLock(r,work){
  if(busy.has(r.id)||instances.get(r.id)?.isBusy()||(activeRequests.get(r.id)||0)>1)
   fail('Espera a que termine el mantenimiento del servidor.',409);
  worldLocks.add(r.id);busy.add(r.id);
  try{await managedWorld(r);return await work();}
  finally{busy.delete(r.id);worldLocks.delete(r.id);}
 }
 const freshSeed=()=>crypto.randomBytes(8).readBigInt64BE().toString();
 async function cloneServer(r,data){
  if(creating||records.length>=20)fail('Espera a la creación actual o libera un espacio en el panel.',409);
  const name=String(data.name||'').trim();
  if(!name||name.length>80||/[\x00-\x1f\\]/.test(name))fail('Nombre de servidor no válido.');
  creating=true;
  try{return await withWorldLock(r,async()=>{
   const serverPort=await allocate(25565,true);
   const rconPort=await allocate(Math.max(26575,serverPort+1));
   assertFree(serverPort,null,'external');
   const id=crypto.randomUUID(),directory=path.join(baseDir,id),stage=path.join(baseDir,'.clone-'+id);
   const entry={...r,id,name,directory,serverPort,rconPort,externalPort:serverPort,seed:freshSeed(),
    memoryMb:Math.min(publicRecord(r).memoryMb,8192),configureFirewall:false,configureUpnp:false,
    networkWarnings:[],error:'',createdAt:new Date().toISOString()};
   delete entry.backupLabel;
   delete entry.autoStart;
   let published=false;
   try{
    await prepareClone(r.directory,stage,entry,rconPort);
    if(await probe(serverPort)||await probe(rconPort))fail('Uno de los puertos del clon ya está ocupado.',409);
    assertFree(serverPort,null,'external');assertFree(rconPort);
    await fsp.rename(stage,directory);published=true;
    records.push(entry);save();
   }catch(error){
    records=records.filter(item=>item.id!==id);
    const target=published?directory:stage;
    if(path.dirname(path.resolve(target))!==path.resolve(baseDir))throw Error('Ruta temporal no válida');
    await fsp.rm(target,{recursive:true,force:true});
    throw error;
   }
   return {server:publicRecord(entry),message:'Clon creado. Su mundo se generará al iniciar Minecraft.'};
  });}finally{creating=false;}
 }
 async function checkReset(r){
  await managedWorld(r);
  if(await probe(r.serverPort)||processAlive(r))fail('Apaga este servidor antes de regenerar el mundo.',409);
 }
 async function resetIntent(r){
  await checkReset(r);
  for(const [token,intent] of resetIntents)if(intent.expires<Date.now()||intent.id===r.id)resetIntents.delete(token);
  const token=crypto.randomBytes(24).toString('hex');
  resetIntents.set(token,{id:r.id,expires:Date.now()+180000});
  return {token,name:r.name};
 }
 async function resetWorld(r,data){
  const intent=resetIntents.get(data.token);
  if(!intent||intent.id!==r.id||intent.expires<Date.now())fail('La confirmación ha caducado. Vuelve a abrir Regenerar mundo.',409);
  if(data.name!==r.name)fail('El nombre del servidor no coincide.');
  resetIntents.delete(data.token);
  return withWorldLock(r,async()=>{
   await checkReset(r);
   const base=path.join(stateDir,'previous-worlds');
   await fsp.mkdir(base,{recursive:true});
   if(!await canonicalChild(base,path.dirname(base),path.basename(base)))fail('Carpeta de recuperación no válida.',409);
   const archive=path.join(base,r.id+'-'+Date.now()+'-'+crypto.randomUUID());
   await fsp.mkdir(archive);
   const seed=freshSeed();
   await regenerateWorld(r.directory,archive,seed);
   r.seed=seed;save();
   return {message:'Mundo preparado para el siguiente arranque. El anterior está en la carpeta previous-worlds de los datos del panel.',archive};
  });
 }
 async function deleteIntent(r){await canDelete(r);for(const [key,value]of deleteIntents)if(value.expiresAt<Date.now()||value.serverId===r.id)deleteIntents.delete(key);const token=crypto.randomBytes(32).toString('hex');deleteIntents.set(token,{serverId:r.id,expiresAt:Date.now()+120000});return {token,name:r.name,expiresInSeconds:120};}
 async function deleteServer(r,data){
  const intent=deleteIntents.get(data.token);if(!intent||intent.serverId!==r.id||intent.expiresAt<Date.now())fail('La confirmación ha caducado. Vuelve a pulsar Eliminar.',409);
  if(data.name!==r.name)fail('El nombre no coincide exactamente con el servidor.');
  await canDelete(r);if(busy.has(r.id))fail('El servidor ya tiene una operación en curso.',409);busy.add(r.id);deleteIntents.delete(data.token);
  let destination='',moved=false,originalRecords=records;
  try{
   const source=path.resolve(r.directory),expected=path.join(baseDir,r.id);if(source!==expected)fail('La carpeta no corresponde al servidor gestionado.',409);
   const stat=await fsp.lstat(source).catch(e=>{if(e.code==='ENOENT')return null;throw e;});
   if(stat){if(!stat.isDirectory()||stat.isSymbolicLink())fail('La carpeta del servidor no es un directorio gestionado normal.',409);
    const realBase=await fsp.realpath(baseDir),realSource=await fsp.realpath(source);if(!await canonicalChild(baseDir,stateDir,'servers')||!samePath(realSource,path.join(realBase,r.id)))fail('La carpeta apunta fuera de los servidores gestionados.',409);
    const archiveBase=path.resolve(stateDir,'deleted-servers');await fsp.mkdir(archiveBase,{recursive:true});const realArchive=await fsp.realpath(archiveBase);if(!await canonicalChild(archiveBase,stateDir,'deleted-servers'))fail('La carpeta de recuperación no puede ser un enlace.',409);
    destination=path.resolve(archiveBase,r.id+'-'+Date.now());if(path.dirname(destination)!==archiveBase)fail('Destino de recuperación no válido.',409);
    instances.get(r.id)?.close();instances.delete(r.id);await fsp.rename(source,destination);moved=true;
    write(path.join(destination,'panel/deleted-server-record.json'),{...r,deletedAt:new Date().toISOString(),originalDirectory:source});
   }
   records=records.filter(entry=>entry.id!==r.id);save();if(autoStartId===r.id)autoStartId=undefined;return {ok:true,message:'Servidor eliminado del panel. Sus archivos se conservan en la carpeta Servidores eliminados.',recoverable:moved};
  }catch(error){records=originalRecords;if(moved)await fsp.rename(destination,r.directory);throw error;}finally{busy.delete(r.id);}
 }
 let hostCache=null,hostPending=null,cpuBefore=null,processBefore=new Map();
 async function hostPerformance(){if(hostCache&&Date.now()-hostCache.at<5000)return hostCache.data;if(hostPending)return hostPending;hostPending=(async()=>{
  const at=Date.now(),cpu=os.cpus().map(c=>c.times).reduce((a,c)=>({idle:a.idle+c.idle,total:a.total+Object.values(c).reduce((s,v)=>s+v,0)}),{idle:0,total:0});const cpuPercent=cpuBefore&&cpu.total>cpuBefore.total?100*(1-(cpu.idle-cpuBefore.idle)/(cpu.total-cpuBefore.total)):null;cpuBefore=cpu;
  const available=records.filter(r=>r.status==='ready'),ports=available.map(r=>Number(r.serverPort)).filter(p=>Number.isInteger(p)&&p>=1024&&p<=65535);let rows=[],error='';
  try{const command=`$ports=@(${ports.join(',')});$listeners=@(Get-NetTCPConnection -State Listen -LocalPort $ports -ErrorAction SilentlyContinue);$rows=@(foreach($port in $ports){$listener=$listeners|Where-Object LocalPort -eq $port|Select-Object -First 1;if($listener){$proc=Get-Process -Id $listener.OwningProcess -ErrorAction SilentlyContinue;if($proc -and $proc.ProcessName -match '^javaw?$'){[pscustomobject]@{port=$port;pid=$proc.Id;workingSetBytes=[double]$proc.WorkingSet64;cpuSeconds=[double]$proc.CPU}}}});ConvertTo-Json -InputObject $rows -Compress`;const out=await run('powershell.exe',['-NoProfile','-NonInteractive','-Command',command],{windowsHide:true,timeout:10000,maxBuffer:256*1024});rows=JSON.parse(out.stdout.replace(/^\uFEFF/,'').trim()||'[]');if(!Array.isArray(rows))rows=[rows];}catch{error='No se pudo consultar el consumo de los procesos de Minecraft.';}
  const processNow=new Map(),unique=new Map();const servers=available.map(r=>{const p=rows.find(p=>p.port===r.serverPort),previous=p&&processBefore.get(p.pid);if(p){processNow.set(p.pid,{at,cpuSeconds:p.cpuSeconds});unique.set(p.pid,p);}const memory=publicRecord(r).memoryMb;return {id:r.id,name:r.name,running:Boolean(p),memoryLimitMb:memory,workingSetBytes:p?.workingSetBytes??null,cpuPercent:p&&previous&&at>previous.at?Math.max(0,Math.min(100,(p.cpuSeconds-previous.cpuSeconds)/((at-previous.at)/1000)/os.cpus().length*100)):null};});processBefore=processNow;
  const data={sampledAt:at,totalMemoryBytes:os.totalmem(),freeMemoryBytes:os.freemem(),cpuPercent,logicalProcessors:os.cpus().length,minecraftMemoryBytes:[...unique.values()].reduce((s,p)=>s+p.workingSetBytes,0),configuredMemoryMb:servers.reduce((s,r)=>s+r.memoryLimitMb,0),servers,error};hostCache={at:Date.now(),data};return data;
 })();try{return await hostPending;}finally{hostPending=null;}}
 const archiveBase=path.resolve(stateDir,'deleted-servers');
 async function archivedRecord(key){if(!/^[0-9a-f-]{36}-\d{13}$/.test(key))fail('Servidor eliminado no válido.');const dir=path.resolve(archiveBase,key);if(path.dirname(dir)!==archiveBase)fail('Ruta de recuperación no válida.');const stat=await fsp.lstat(dir);if(!await canonicalChild(archiveBase,stateDir,'deleted-servers')||!stat.isDirectory()||stat.isSymbolicLink()||!await canonicalChild(dir,archiveBase,key))fail('Carpeta de recuperación no válida.');const r=JSON.parse(await fsp.readFile(path.join(dir,'panel/deleted-server-record.json'),'utf8'));if(!validId(r.id)||r.id==='main'||r.legacy||!key.startsWith(r.id+'-'))fail('Registro de recuperación no válido.');return {r,dir,key};}
 async function deletedServers(){let entries;try{entries=await fsp.readdir(archiveBase,{withFileTypes:true});}catch{return [];}
  const result=[];for(const entry of entries){if(!entry.isDirectory()||! /^[0-9a-f-]{36}-\d{13}$/.test(entry.name))continue;try{const {r}=await archivedRecord(entry.name);result.push({key:entry.name,id:r.id,name:r.name,minecraftVersion:r.minecraftVersion,loader:r.loader,deletedAt:r.deletedAt,originalPort:r.serverPort});}catch{}}
  return result.sort((a,b)=>String(b.deletedAt).localeCompare(String(a.deletedAt)));
 }
 async function restoreDeleted(key,data){if(creating)fail('Hay otra creación o restauración en curso.',409);creating=true;let moved=false,source='',dest='',r;const previousFiles=new Map();try{
  if(records.length>=20)fail('El panel admite hasta 20 servidores registrados.');const archive=await archivedRecord(key);r={...archive.r};source=archive.dir;dest=path.resolve(baseDir,r.id);if(path.dirname(dest)!==baseDir||records.some(v=>v.id===r.id)||fs.existsSync(dest))fail('Ese servidor ya existe o su carpeta está ocupada.',409);
  const gamePort=data.serverPort?portNumber(data.serverPort):await allocate(25565);assertFree(gamePort);if(await probe(gamePort))fail('Ese puerto está ocupado.');const externalPort=data.externalPort?portNumber(data.externalPort):gamePort;assertFree(externalPort,null,'external');let rconPort=r.rconPort;try{portNumber(rconPort);assertFree(rconPort);if(rconPort===gamePort||await probe(rconPort))rconPort=0;}catch{rconPort=0;}if(!rconPort)rconPort=await allocate(Math.max(26575,gamePort+1));
  const publicHost=hostName(data.publicHost||r.publicHost||localAddresses()[0]||'127.0.0.1');for(const name of ['server.properties','panel/panel-config.json','panel/registry-agent.properties'])try{previousFiles.set(name,await fsp.readFile(path.join(source,name)));}catch{}
  await fsp.mkdir(baseDir,{recursive:true});const realBase=await fsp.realpath(baseDir);if(!await canonicalChild(baseDir,stateDir,'servers'))fail('La carpeta de servidores no puede ser un enlace.');await fsp.rename(source,dest);moved=true;
  const cfg=JSON.parse(await fsp.readFile(path.join(dest,'panel/panel-config.json'),'utf8'));cfg.serverPort=gamePort;cfg.rconPort=rconPort;cfg.panelToken=main.config.panelToken;cfg.rconHost=r.bindAddress&&localAddresses().includes(r.bindAddress)?r.bindAddress:'127.0.0.1';write(path.join(dest,'panel/panel-config.json'),cfg);
  let properties=await fsp.readFile(path.join(dest,'server.properties'),'utf8');for(const [key,value]of Object.entries({'server-port':gamePort,'rcon.port':rconPort,'rcon.password':cfg.rconPassword,'server-ip':cfg.rconHost==='127.0.0.1'?'':cfg.rconHost}))properties=prop(properties,key,value);await fsp.writeFile(path.join(dest,'server.properties'),properties);
  const agent=path.join(dest,'panel/registry-agent.properties');if(fs.existsSync(agent))await fsp.writeFile(agent,prop(prop(await fsp.readFile(agent,'utf8'),'port',rconPort),'host',cfg.rconHost));
  write(path.join(dest,'panel/managed-process.json'),{pid:0,restoredAt:Date.now()});
  Object.assign(r,{autoStart:false,directory:dest,serverPort:gamePort,rconPort,externalPort,publicHost,bindAddress:cfg.rconHost==='127.0.0.1'?'':cfg.rconHost,status:'ready',error:'',networkWarnings:[],restoredAt:new Date().toISOString()});delete r.deletedAt;delete r.originalDirectory;records.push(r);try{save();}catch(error){records=records.filter(v=>v.id!==r.id);throw error;}
  const coverage=preconfiguredNetwork(codeDir,r,localAddresses());return {ok:true,server:publicRecord(r),networkReviewRequired:!coverage.firewall||!coverage.router,message:'Servidor restaurado y apagado. Revisa la conexión antes de iniciarlo.'};
 }catch(error){if(moved){for(const [name,bytes]of previousFiles)await fsp.writeFile(path.join(dest,name),bytes);await fsp.rename(dest,source);}throw error;}finally{creating=false;}}

 async function handle(req,res,url){const p=url.pathname,send=main.sendJson;
  if(p==='/api/host-performance'&&req.method==='GET'){send(res,200,await hostPerformance());return true;}
  if(p==='/api/deleted-servers'&&req.method==='GET'){send(res,200,{servers:await deletedServers()});return true;}
  const restoreMatch=/^\/api\/deleted-servers\/([0-9a-f-]+)\/restore$/.exec(p);if(restoreMatch&&req.method==='POST'){send(res,200,await restoreDeleted(restoreMatch[1],await main.readJson(req)));return true;}
  if(p==='/api/catalog/minecraft'&&req.method==='GET'){const data=await catalogProvider.minecraftVersions(url.searchParams.get('refresh')==='1');send(res,200,{...data,versions:data.versions.map(({url,...entry})=>entry)});return true;}
  if(p==='/api/catalog/loaders'&&req.method==='GET'){send(res,200,await catalogProvider.loaderVersions(url.searchParams.get('version'),url.searchParams.get('loader')));return true;}
  if(p==='/api/catalog/details'&&req.method==='GET'){const d=await catalogProvider.minecraftDetails(url.searchParams.get('version'));send(res,200,{version:d.id,javaMajor:d.javaVersion?.majorVersion||guessedJava(d.id),serverAvailable:true});return true;}
  if(p==='/api/servers'&&req.method==='GET'){send(res,200,{servers:await Promise.all(records.map(async r=>({...publicRecord(r),online:moved(r)?await nativeHosting.context().isOnline().catch(()=>false):await probe(r.serverPort)}))),suggestedPort:await allocate(25565),localAddresses:localAddresses(),physicalMemoryMb:Math.floor(os.totalmem()/1048576)});return true;}
  if(p==='/api/servers'&&req.method==='POST'){send(res,202,await create(await main.readJson(req)));return true;}
  const jobMatch=/^\/api\/server-jobs\/([0-9a-f-]{36})$/.exec(p);if(jobMatch&&req.method==='GET'){const j=jobs.get(jobMatch[1]);if(!j)fail('No se encuentra esa operación. Revisa el estado del servidor.',404);const r=records.find(r=>r.id===j.serverId);if(j.done&&j.ok&&r){const coverage=preconfiguredNetwork(codeDir,r,localAddresses());send(res,200,{...j,warnings:currentWarnings(j.warnings,coverage),phase:currentWarnings(j.warnings,coverage).length?'Servidor preparado · revisar conexión':'Servidor preparado',networkMessage:coverage.firewall&&coverage.router?'Puerto cubierto por las reglas manuales de Windows y del router. No necesita UPnP.':j.networkMessage});}else send(res,200,j);return true;}
  const match=/^\/api\/servers\/([^/]+)(?:\/(connection|network|firewall|upnp|platform|retry|delete-intent|clone|reset-world-intent|reset-world|name|icon|autostart))?$/.exec(p);if(!match)return false;const r=record(match[1]),action=match[2];
  if(action==='autostart'&&req.method==='PUT'){
   const settings=await main.readJson(req);
   updateAutoStart(r,settings.enabled);
   send(res,200,{server:publicRecord(r),autoStartId:autoStartId||null});return true;
  }
  if(action==='name'&&req.method==='PUT'){
   if(r.legacy||busy.has(r.id))fail('Espera a que termine la operación del servidor.',409);
   const data=await main.readJson(req);
   const name=typeof data.name==='string'?data.name.trim():'';
   if(!name||name.length>80||/[\x00-\x1f\x7f]/.test(name))fail('Escribe un nombre válido de hasta 80 caracteres.');
   if(busy.has(r.id)||!records.includes(r))fail('El servidor ya no está disponible para editar.',409);
   const previous={name:r.name,backupLabel:r.backupLabel};
   if(name!==r.name){
    if(!r.backupLabel)r.backupLabel=r.name;
    r.name=name;
    try{save();}catch(error){Object.assign(r,previous);throw error;}
   }
   send(res,200,{server:publicRecord(r)});return true;
  }
  if(action==='icon'&&req.method==='GET'){
   const file=path.join(r.directory,'server-icon.png');
   let image;
   try{const stat=await fsp.stat(file);if(!stat.isFile()||stat.size>1024*1024)throw Error('Icono no válido');
    image=await fsp.readFile(file);validateIcon(image);}
   catch{fail('El servidor no tiene un icono disponible.',404);}
   res.writeHead(200,{'Content-Type':'image/png','Content-Length':image.length});
   res.end(image);return true;
  }
  if((moved(r)||travelling(r.id))&&req.method!=='GET')fail('Devuelve el servidor al equipo del panel para modificar su instalación.',409);
  if(r.id===nativeHosting?.id&&(req.method==='DELETE'||action==='delete-intent'||(action==='connection'&&req.method==='PUT'))) {
   fail('Este servidor está asociado a un perfil de traslado.',409);
  }
  if(!action&&req.method==='GET'){send(res,200,{server:publicRecord(r),localAddresses:localAddresses()});return true;}
  if(worldLocks.has(r.id)&&req.method!=='GET')fail('Hay una operación de mundo en curso.',409);
  if(action==='clone'&&req.method==='POST'){send(res,201,await cloneServer(r,await main.readJson(req)));return true;}
  if(action==='reset-world-intent'&&req.method==='POST'){send(res,200,await resetIntent(r));return true;}
  if(action==='reset-world'&&req.method==='POST'){
   if(!req.verifiedWorldReset)fail('Confirma la contraseña del panel.',403);
   send(res,200,await resetWorld(r,req.verifiedWorldReset));return true;
  }
  if(action==='delete-intent'&&req.method==='POST'){send(res,200,await deleteIntent(r));return true;}
  if(!action&&req.method==='DELETE'){send(res,200,await deleteServer(r,await main.readJson(req)));return true;}
  if(action==='network'&&req.method==='GET'){send(res,200,await network(r));return true;}
  if(action==='connection'&&req.method==='PUT'){send(res,200,await connection(r,await main.readJson(req)));return true;}
  if(action==='firewall'&&req.method==='POST'){send(res,200,await applyFirewall(r));return true;}
  if(action==='upnp'&&req.method==='POST'){send(res,200,await upnp(r));return true;}
  if(action==='platform'&&req.method==='POST'){send(res,202,await changePlatform(r,await main.readJson(req)));return true;}
  if(action==='retry'&&req.method==='POST'){if(r.legacy||r.status!=='failed')fail('Ese servidor no necesita reintento.');r.status='installing';r.error='';save();const j=background(r,job=>install(r,job));send(res,202,{jobId:j.id});return true;}
  fail('Operación de servidor no encontrada.',404);
 }
 for(const r of records)if(!r.legacy)r.networkWarnings=currentWarnings(r.networkWarnings,preconfiguredNetwork(codeDir,r,localAddresses()));save();
 for(const r of records)if(r.id!=='main'&&r.status==='ready')instance(r.id);
 async function routedHandle(req,res,url){
  const target=/^\/api\/servers\/([^/]+)/.exec(url.pathname)?.[1];
  if(target&&req.method!=='GET')return track(target,()=>handle(req,res,url));
  return handle(req,res,url);
 }
 return {handle:routedHandle,instance,route,create,startAutomatic,records:()=>records.map(publicRecord),hostingRecord:record,
  hostingBusy:id=>busy.has(id)||activeRequests.has(id),
  resetHostingInstance:id=>{instances.get(id)?.close();instances.delete(id);},
  close:()=>{for(const [id,i] of instances)if(id!=='main')i.close();}};
}
module.exports={createServerManager,portNumber,hostName,prop,validId};
