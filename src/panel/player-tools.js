'use strict';
const fs=require('node:fs');
const fsp=require('node:fs/promises');
const path=require('node:path');
const crypto=require('node:crypto');
const {execFile}=require('node:child_process');
const {promisify}=require('node:util');
const execFileAsync=promisify(execFile);
const validName=v=>typeof v==='string'&&/^[A-Za-z0-9_]{3,16}$/.test(v);
const validId=v=>typeof v==='string'&&/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(v);
function fail(message,status=400){const error=new Error(message);error.status=status;throw error;}
function integer(value,min,max,label){const n=Number(value);if(!Number.isInteger(n)||n<min||n>max)fail(`${label}: usa un número entero entre ${min} y ${max}.`);return n;}
const SOUND_IDS={explosion:'minecraft:entity.generic.explode',ghast:'minecraft:entity.ghast.scream',creeper:'minecraft:entity.creeper.primed',cave:'minecraft:ambient.cave'};
const ACTIONS=new Set(['give','xp-add','xp-set','heal','feed','kill','gamemode','teleport-player','teleport-position','teleport-death','jumpscare','herobrine','sound']);
function actionCommand(data,name,death){
 switch(data.action){
  case 'give':{if(typeof data.item!=='string'||!/^[a-z0-9_.-]+:[a-z0-9_./-]+$/.test(data.item)||data.item.length>160)fail('Usa un identificador como minecraft:creeper_spawn_egg.');return `give ${name} ${data.item} ${integer(data.amount,1,64,'Cantidad')}`;}
  case 'xp-add':case 'xp-set':return `experience ${data.action==='xp-add'?'add':'set'} ${name} ${integer(data.amount,0,10000,'Niveles')} levels`;
  case 'heal':return `effect give ${name} minecraft:instant_health 1 10 true`;
  case 'feed':return `effect give ${name} minecraft:saturation 1 5 true`;
  case 'kill':if(data.confirmTarget!==name)fail('Confirma el nombre antes de matar al jugador.');return `kill ${name}`;
  case 'gamemode':if(!['survival','creative','adventure','spectator'].includes(data.mode))fail('Modo de juego no válido.');return `gamemode ${data.mode} ${name}`;
  case 'teleport-player':if(!validName(data.destination))fail('Jugador de destino no válido.');return `tp ${name} ${data.destination}`;
  case 'teleport-position':case 'teleport-death':{
   const v=data.action==='teleport-death'?death:data;
   if(!v||typeof v.dimension!=='string'||!/^[a-z0-9_.-]+:[a-z0-9_./-]+$/.test(v.dimension))fail('Dimensión no válida.');
   const coords=['x','y','z'].map(k=>Number(v[k]));
   if(coords.some(n=>!Number.isFinite(n))||Math.abs(coords[0])>29999984||Math.abs(coords[2])>29999984||coords[1]<-128||coords[1]>1024)fail('Coordenadas fuera de rango.');
   return `execute in ${v.dimension} run tp ${name} ${coords.map(n=>Number(n.toFixed(3))).join(' ')}`;
  }
  case 'jumpscare':return `particleJumpScare ${name}`;
  case 'herobrine':return `spawnFakePlayer ${name} Herobrine ${integer(data.radius??8,4,64,'Distancia')} true`;
  case 'sound':if(!SOUND_IDS[data.sound])fail('Sonido no válido.');return `execute at ${name} run playsound ${SOUND_IDS[data.sound]} master ${name} ~ ~ ~ 1 1`;
  default:fail('Acción no válida.');
 }
}
function createPlayerTools({serverDir,rcon,onlineNames,canMutate=()=>true,canRestore=()=>true,graveReader=null,validateItemId=async()=>true,features=()=>({graves:true,horror:true}),modernCommands=true}){
 const stateFile=path.join(serverDir,'panel/player-tools-state.json');
 let state={history:[],jobs:[],graves:{},quietLease:false};
 if(fs.existsSync(stateFile)){const saved=JSON.parse(fs.readFileSync(stateFile,'utf8'));state={...state,...saved};}
 // Import only explicit, verified receipts from earlier manual recoveries.
 try{
  const users=JSON.parse(fs.readFileSync(path.join(serverDir,'usercache.json'),'utf8'));
  const base=path.join(serverDir,'backups/player-restores');
  for(const dir of fs.readdirSync(base,{withFileTypes:true}).filter(d=>d.isDirectory())){
   const receiptFile=path.join(base,dir.name,'receipt.json');if(!fs.existsSync(receiptFile))continue;
   const receipt=JSON.parse(fs.readFileSync(receiptFile,'utf8'));
   const p=users.find(p=>p.name.toLowerCase()===String(receipt.player).toLowerCase());
   if(!p||!validId(p.uuid)||!receipt.verifiedPickup||!Array.isArray(receipt.ids))continue;
   for(const id of receipt.ids)if(validId(id))state.graves[p.uuid+'/'+id]||={status:'delivered',at:receipt.restoredAt||receipt.at,source:'previous-receipt'};
  }
 }catch{}
 let chain=Promise.resolve(),active='',polling=false;
 const lastEffects=new Map();
 function save(){const temp=stateFile+'.tmp';fs.writeFileSync(temp,JSON.stringify(state,null,2));fs.renameSync(temp,stateFile);}
 function serial(label,work){const task=chain.then(async()=>{active=label;try{return await work();}finally{active='';}});chain=task.catch(()=>{});return task;}
 function audit(name,action,result,ok=true){state.history.unshift({at:new Date().toISOString(),name,action,result:String(result).slice(0,500),ok});state.history=state.history.slice(0,100);save();}
 async function quiet(enabled,work){
  const rule=modernCommands?'minecraft:send_command_feedback':'sendCommandFeedback';
  if(state.quietLease){await rcon('gamerule '+rule+' true');state.quietLease=false;save();}
  if(!enabled)return work();
  const feedback=await rcon('gamerule '+rule);
  const current=/\b(?:set to|is now|is)\s*:?\s*(true|false)\b/i.exec(feedback);
  if(!current)fail('No se pudo comprobar el aviso de comandos.',503);
  const restore=current[1].toLowerCase()==='true';
  if(restore){state.quietLease=true;save();await rcon('gamerule '+rule+' false');}
  try{return await work();}finally{if(restore){await rcon('gamerule '+rule+' true');state.quietLease=false;save();}}
 }
 async function players(){
  const known=new Map();
  for(const file of ['usercache.json','whitelist.json']){
   let entries=[];try{entries=JSON.parse(await fsp.readFile(path.join(serverDir,file),'utf8'));}catch{}
   for(const p of entries)if(validName(p.name)&&validId(p.uuid))known.set(p.name.toLowerCase(),{name:p.name,uuid:p.uuid.toLowerCase(),online:false});
  }
  let online=[],ready=true;try{online=await onlineNames();}catch{ready=false;}
  for(const name of online){const key=name.toLowerCase();known.set(key,{...(known.get(key)||{}),name,online:true});}
  return {players:[...known.values()].sort((a,b)=>Number(b.online)-Number(a.online)||a.name.localeCompare(b.name)),ready};
 }
 async function player(name,requireOnline=false){
  if(!validName(name))fail('Nombre Java no válido.');
  const data=await players();const p=data.players.find(v=>v.name.toLowerCase()===name.toLowerCase());
  if(!p)fail('No se conoce a ese jugador. Debe haber entrado o estar en la whitelist.',404);
  if(requireOnline&&!p.online)fail('El jugador no está conectado.',409);return p;
 }
 async function helper(mode,p,deathId){
  if(!validId(p.uuid))fail('No se ha encontrado el UUID de ese jugador.');
  const dir=path.join(serverDir,'world/deaths',p.uuid);
  if(deathId&&!validId(deathId))fail('Identificador de muerte no válido.');
  const input=deathId?path.join(dir,deathId+'.dat'):dir;
  if(deathId&&!fs.existsSync(input))fail('No se encuentra ese registro de muerte.',404);
  if(graveReader)return graveReader(mode,p,deathId);
  try{
   const {stdout}=await execFileAsync(path.join(serverDir,'runtime/bin/java.exe'),['@'+path.join(serverDir,'panel/tools/grave-java.args'),mode,p.name,input],{windowsHide:true,timeout:20000,maxBuffer:8*1024*1024});
   const result=JSON.parse(stdout);if(mode==='plan'&&(result.playerUuid!==p.uuid||result.id!==deathId))fail('La lápida no pertenece al jugador indicado.');return result;
  }catch(error){if(error.status)throw error;fail('No se pudo leer la lápida. El registro original no se ha modificado.',500);}
 }
 async function deaths(name){if(!features().graves)fail('Este servidor no utiliza el mod de lápidas.',409);const p=await player(name);if(!p.uuid)return [];const rows=await helper('list',p);return rows.map(d=>({...d,restoration:state.graves[p.uuid+'/'+d.id]?.status||null}));}
 async function executeAction(data){
  if(!canMutate())fail('Hay otra operación de mantenimiento en curso.',409);
  if(!ACTIONS.has(data.action))fail('Acción no válida.');
  const p=await player(data.name);
  const death=data.action==='teleport-death'?(await deaths(p.name)).find(d=>d.id===data.deathId):null;
  if(data.action==='teleport-death'&&!death)fail('No se encuentra esa muerte del jugador.',404);
  const command=actionCommand(data,p.name,death);
  if(data.action==='give'&&!await validateItemId(data.item))fail('Ese objeto no figura en el catálogo cargado por el servidor. Actualiza la búsqueda y selecciona un resultado válido.',409);
  if(['herobrine','jumpscare'].includes(data.action)&&!fs.readdirSync(path.join(serverDir,'mods')).some(n=>/^serversidehorror.*\.jar$/i.test(n)))fail('El mod de terror no está instalado.');
  if(!p.online){
   if(data.waitForJoin===true&&['sound','jumpscare','herobrine'].includes(data.action)){
    if(state.jobs.filter(j=>j.status==='pending').length>=20)fail('Ya hay demasiadas acciones pendientes.');
    const id=crypto.randomUUID();state.jobs.unshift({id,name:p.name,action:data.action,data:{...data,name:p.name,waitForJoin:false},status:'pending',createdAt:Date.now(),expiresAt:Date.now()+6*3600000});state.jobs=state.jobs.slice(0,50);save();
    audit(p.name,data.action,'Pendiente hasta que entre; caduca en 6 horas.');return {queued:true,id,message:'Queda pendiente para cuando entre, una sola vez. Caduca en 6 horas.'};
   }
   fail('El jugador no está conectado.',409);
  }
  if(data.action==='teleport-player')await player(data.destination,true);
  if(['sound','herobrine','jumpscare'].includes(data.action)){
   const key=p.name.toLowerCase()+'/'+data.action;
   if(Date.now()-(lastEffects.get(key)||0)<10000)fail('Espera 10 segundos antes de repetir este efecto.',429);
   lastEffects.set(key,Date.now());
  }
  try{
   const result=await quiet(data.quiet===true,()=>rcon(command,10000));
   if(!result||/Unknown |Incorrect argument|not found|No player|not a valid|Expected /i.test(result))fail(result||'El servidor no confirmó la acción.',409);
   audit(p.name,data.action,result);
   return {message:data.action==='jumpscare'?'Jumpscare en cola: se muestra cuando se queda quieto y depende de las partículas del cliente.':result.trim()};
  }catch(error){audit(p.name,data.action,error.message,false);throw error;}
 }
 async function freeSlots(name,needed){
  let free=0;
  for(let i=0;i<36&&free<needed;i++){const result=await rcon(`execute if data entity ${name} Inventory[{Slot:${i}b}]`);if(!/Test passed/.test(result))free++;}
  if(free<needed)fail(`Deja ${needed} hueco(s) libre(s) en el inventario para recibir las lápidas.`,409);
 }
 async function restoreGraves(data){
  if(!features().graves)fail('Este servidor no utiliza el mod de lápidas.',409);
  if(!canMutate()||!canRestore())fail('Espera a que terminen las copias o el mantenimiento.',409);
  const p=await player(data.name,true);
  if(!Array.isArray(data.ids)||data.ids.length<1||data.ids.length>2||new Set(data.ids).size!==data.ids.length||data.ids.some(id=>!validId(id)))fail('Selecciona una o dos lápidas distintas.');
  const plans=[];
  for(const id of data.ids){if(state.graves[p.uuid+'/'+id]?.status==='delivered')fail('Esa lápida ya fue entregada desde este panel. No se ha duplicado.',409);plans.push(await helper('plan',p,id));}
  await freeSlots(p.name,plans.length);
  let backup;
  try{
   return await quiet(data.quiet===true,async()=>{
    backup=path.join(serverDir,'backups/player-restores','panel-'+crypto.randomUUID());await fsp.mkdir(backup,{recursive:true});
    for(const plan of plans)await fsp.copyFile(path.join(serverDir,'world/deaths',p.uuid,plan.id+'.dat'),path.join(backup,plan.id+'.dat'));
    const playerData=path.join(serverDir,'world/players/data',p.uuid+'.dat');if(fs.existsSync(playerData))await fsp.copyFile(playerData,path.join(backup,'player-before.dat'));
    for(const plan of plans){
     const key=p.uuid+'/'+plan.id;
     const already=await rcon(`execute if data entity ${p.name} Inventory[{id:"gravestone:gravestone",components:{"minecraft:block_entity_data":{Death:{Id:[I;${plan.idArray.join(',')}]}}}}]`);
     if(/Test passed/.test(already)){state.graves[key]={status:'delivered',at:new Date().toISOString(),backup};save();continue;}
     const old=state.graves[key];
     const dimensionResult=await rcon(`data get entity ${p.name} Dimension`);
     const dimension=old?.dimension||dimensionResult.match(/"([a-z0-9_.-]+:[a-z0-9_./-]+)"/)?.[1];
     if(!dimension)fail('No se pudo localizar la dimensión del jugador.',409);
     state.graves[key]={status:'preparing',dimension,backup,at:new Date().toISOString()};save();
     const inDimension=`execute in ${dimension} run `;
     const existing=await rcon(inDimension+'execute if entity '+plan.selector);
     if(!/Test passed/.test(existing)){
      const result=await rcon(plan.commands[0]);if(!/Summoned new/.test(result))fail('No se pudo preparar la lápida: '+result,409);
     }
     for(const cmd of plan.commands.slice(1))await rcon(cmd.replace(`execute at ${p.name} run `,inDimension));
     for(const [field,count] of Object.entries(plan.counts)){
      await rcon(inDimension+`execute store result storage lobodk:panel_restore count int 1 run data get entity ${plan.selector} Item.components."minecraft:block_entity_data".Death.${field}`);
      const output=await rcon('data get storage lobodk:panel_restore count');
      if(Number(output.match(/:\s*(\d+)\s*$/)?.[1])!==count)fail('La verificación de contenido no coincide. No se ha entregado la lápida incompleta.',409);
     }
     await player(p.name,true);
     await rcon(inDimension+`tp ${plan.selector} ${p.name}`);
     await rcon(`execute at ${p.name} run data modify entity ${plan.selector} Age set value 0s`);
     await rcon(`execute at ${p.name} run data modify entity ${plan.selector} PickupDelay set value 0s`);
     await new Promise(r=>setTimeout(r,300));
     const picked=await rcon(`execute if data entity ${p.name} Inventory[{id:"gravestone:gravestone",components:{"minecraft:block_entity_data":{Death:{Id:[I;${plan.idArray.join(',')}]}}}}]`);
     if(!/Test passed/.test(picked))fail('La lápida está junto al jugador, pero todavía no se ha confirmado su recogida. Revisa el inventario antes de reintentar.',409);
     state.graves[key]={status:'delivered',at:new Date().toISOString(),backup};save();
    }
    const receipt={player:p.name,ids:data.ids,at:new Date().toISOString(),verifiedPickup:true};await fsp.writeFile(path.join(backup,'receipt.json'),JSON.stringify(receipt,null,2));
    audit(p.name,'restore-graves',`Entregadas ${plans.length} lápidas completas.`);
    return {message:`Entregadas ${plans.length} lápidas con contenido. Colócalas y rómpelas para recuperar los objetos.`};
   });
  }catch(error){audit(p.name,'restore-graves',error.message,false);throw error;}
 }
 async function snapshot(){const data=await players();return {...data,features:features(),busy:active,history:state.history.slice(0,20),jobs:state.jobs.slice(0,20)};}
 async function handle(req,res,url,{readJson,sendJson}){
  if(!url.pathname.startsWith('/api/player-tools'))return false;
  try{
   let result;
   if(req.method==='GET'&&url.pathname==='/api/player-tools')result=await snapshot();
   else if(req.method==='POST'&&url.pathname==='/api/player-tools/history/clear'){result=await serial('Limpiando registro',async()=>{if(!canMutate())fail('Espera a que termine el mantenimiento.',409);if(state.history.length){const dir=path.join(serverDir,'panel/history-archive');await fsp.mkdir(dir,{recursive:true});await fsp.writeFile(path.join(dir,crypto.randomUUID()+'.json'),JSON.stringify(state.history));}state.history=[];save();return {message:'Registro de acciones del panel limpiado.'};});}
   else if(req.method==='GET'&&url.pathname==='/api/player-tools/deaths')result={deaths:await deaths(url.searchParams.get('name'))};
   else if(req.method==='POST'&&url.pathname==='/api/player-tools/action'){const data=await readJson(req);result=await serial(data.action,()=>executeAction(data));}
   else if(req.method==='POST'&&url.pathname==='/api/player-tools/restore'){const data=await readJson(req);result=await serial('Restaurando lápidas',()=>restoreGraves(data));}
   else if(req.method==='POST'&&url.pathname==='/api/player-tools/cancel'){const data=await readJson(req);result=await serial('Cancelando',async()=>{const job=state.jobs.find(j=>j.id===data.id&&j.status==='pending');if(!job)fail('No se encuentra esa acción pendiente.',404);job.status='cancelled';save();return {message:'Acción pendiente cancelada.'};});}
   else fail('Ruta no encontrada.',404);
   sendJson(res,200,result);
  }catch(error){sendJson(res,error.status||500,{error:error.message||'No se pudo completar la acción.'});}
  return true;
 }
 const timer=setInterval(async()=>{
  if(polling||active||!canMutate())return;
  if(state.quietLease){polling=true;try{await serial('Recuperando avisos',async()=>{await rcon('gamerule '+(modernCommands?'minecraft:send_command_feedback':'sendCommandFeedback')+' true');state.quietLease=false;save();});}catch{}finally{polling=false;}return;}
  if(!state.jobs.some(j=>j.status==='pending'))return;
  polling=true;
  try{
   const online=await onlineNames();
   for(const job of state.jobs.filter(j=>j.status==='pending')){
    if(job.expiresAt<Date.now()){job.status='expired';save();continue;}
    if(!online.some(n=>n.toLowerCase()===job.name.toLowerCase()))continue;
    // Mark before execution: reconnects or a panel restart must not replay an effect.
    job.status='running';save();
    try{await serial(job.action,()=>executeAction(job.data));job.status='done';}catch(e){job.status='failed';job.error=e.message;}save();
   }
  }catch{}finally{polling=false;}
 },10000);timer.unref();
 return {handle,close:()=>clearInterval(timer),snapshot};
}
module.exports={createPlayerTools,actionCommand,validName,validId};
