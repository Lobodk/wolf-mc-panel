'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {createNativeHosting,launchArguments,privateIp,readWorldName} = require('./native-hosting.cjs');

function lanInterfaces() {
  return Object.entries(os.networkInterfaces()).flatMap(([name, addresses]) =>
    (addresses || []).filter(address=>address.family==='IPv4'&&!address.internal&&privateIp(address.address))
      .map(address=>({name,address:address.address})));
}

function createMigration(dataDir) {
  const file=path.join(dataDir,'migration-profile.json');
  let profile=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):null;
  let engine=profile?createNativeHosting(dataDir,profile):null;
  let manager;
  function attach(value) {
    manager=value;
    engine?.attach(value);
  }
  async function handle(req,res,url,main) {
    if (url.pathname==='/api/app/native-hosting/profile'&&req.method==='POST') {
      const data=await main.readJson(req,4096);
      if(profile) {
        if(profile.id!==data.id)return main.sendJson(res,409,{error:'Esta instalación tiene un perfil de traslado asociado a otro servidor.'});
        return main.sendJson(res,200,{profile});
      }
      const record=manager.hostingRecord(data.id);
      if(record.status!=='ready'||record.legacy||record.javaMajor<9||record.bindAddress) {
        return main.sendJson(res,409,{error:'Selecciona un servidor instalado con Java 9 o superior y escucha en todas las interfaces.'});
      }
      if(!lanInterfaces().some(item=>item.address===data.controller)) {
        return main.sendJson(res,400,{error:'Selecciona una IPv4 de este equipo en la red local.'});
      }
      const replicaFolder=String(data.replicaFolder||'').trim();
      if(replicaFolder && (!/^[A-Za-z]:\\[^<>:"|?*\x00-\x1f]+$/.test(replicaFolder) ||
          replicaFolder.slice(3).split('\\').some(segment=>!segment||/[ .]$/.test(segment)))) {
        return main.sendJson(res,400,{error:'Indica una carpeta Windows válida para la copia.'});
      }
      launchArguments(record);
      profile={id:record.id,controller:data.controller,gamePort:record.serverPort,rconPort:record.rconPort,
        worldName:readWorldName(record.directory),replicaFolder};
      const temp=file+'.tmp';
      fs.writeFileSync(temp,JSON.stringify(profile,null,2)+'\n',{mode:0o600,flush:true});
      fs.renameSync(temp,file);
      engine=createNativeHosting(dataDir,profile);
      engine.attach(manager);
      return main.sendJson(res,201,{profile});
    }
    if(url.pathname==='/api/app/native-hosting'&&req.method==='GET'){
      if(!engine)return main.sendJson(res,200,{profile:null,interfaces:lanInterfaces(),owner:'secondary',running:false,linked:false});
      const augmented={...main,sendJson:(response,status,data)=>main.sendJson(response,status,{...data,profile})};
      return engine.handle(req,res,url,augmented);
    }
    if(!engine) return main.sendJson(res,409,{error:'Selecciona un servidor y prepara el otro equipo.'});
    return engine.handle(req,res,url,main);
  }
  return {get id(){return profile?.id;},handle,attach,close:()=>engine?.close(),
    busy:()=>Boolean(engine?.busy()),blocked:()=>Boolean(engine?.blocked()),
    owner:()=>engine?.owner()||{owner:'secondary',target:null},context:()=>engine?.context(),
    allowsLocalHandoff:()=>Boolean(engine?.allowsLocalHandoff())};
}

module.exports={createMigration,lanInterfaces};
