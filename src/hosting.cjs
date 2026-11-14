'use strict';
const fs=require('node:fs'),path=require('node:path'),net=require('node:net'),os=require('node:os');
const fail=message=>{throw Object.assign(Error(message),{status:400});};
const loopback=ip=>['127.0.0.1','::1','::ffff:127.0.0.1'].includes(ip);
function privateAddress(ip){ip=String(ip||'').replace(/^::ffff:/,'');if(loopback(ip))return true;const p=ip.split('.').map(Number);return net.isIPv4(ip)&&(p[0]===10||p[0]===192&&p[1]===168||p[0]===172&&p[1]>=16&&p[1]<=31);}
function normalize(data){
 if(!data||!['local','lan','domain'].includes(data.mode))fail('Selecciona acceso local, red local o dominio HTTPS.');
 const aliases=data.lanNames||[];if(!Array.isArray(aliases)||aliases.length>10||aliases.some(v=>typeof v!=='string'||v.length>253||! /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(v)))fail('Los nombres de red local no son válidos.');
 let origin='';if(data.mode==='domain'){let url;try{url=new URL(data.origin);}catch{fail('Escribe una dirección HTTPS completa para el panel.');}if(url.protocol!=='https:'||url.username||url.password||url.pathname!=='/'||url.search||url.hash||net.isIP(url.hostname)||! /^[a-z0-9.-]+$/i.test(url.hostname)||!url.hostname.includes('.')||url.hostname.includes('..'))fail('Usa un dominio HTTPS sin rutas, usuario ni contraseña.');origin=url.origin;}
 return {mode:data.mode,origin,managedProxy:data.managedProxy===true,lanNames:[...new Set(aliases.map(v=>v.toLowerCase()))]};
}
function createHosting({dataDir,defaults={mode:'local',lanNames:[]}}){
 const file=path.join(dataDir,'hosting.json'),current=normalize(fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):defaults);
 const interfaces=new Set(Object.values(os.networkInterfaces()).flat().filter(Boolean).map(v=>v.address));
 function request(req){
  const remote=req.socket.remoteAddress;if(current.mode==='lan'?!privateAddress(remote):!loopback(remote))return null;
  let host;try{host=new URL('http://'+req.headers.host);if(host.username||host.password||host.pathname!=='/')return null;}catch{return null;}
  const localHost=['127.0.0.1','localhost','[::1]'].includes(host.hostname);
  if(current.mode==='domain'){
   const internal=localHost&&!req.headers.origin&&['/api/app/health','/api/app/local-shutdown'].includes(req.url.split('?')[0]);
   if(internal)return {origin:'http://'+host.host,client:remote,internal:true};
   const publicUrl=new URL(current.origin);if(host.host!==publicUrl.host||req.headers['x-forwarded-proto']!=='https')return null;
   // Only the local proxy is trusted. Forwarded headers from LAN/Internet are never accepted.
   const forwarded=req.headers['x-forwarded-for'],client=typeof forwarded==='string'?forwarded.split(',').map(v=>v.trim()).at(-1):remote;
   if(!net.isIP(client))return null;return {origin:current.origin,client,internal:false};
  }
  if(!localHost&&!(current.mode==='lan'&&(interfaces.has(host.hostname)||current.lanNames.includes(host.hostname))))return null;
  return {origin:'http://'+host.host,client:remote,internal:false};
 }
 function save(data,passwordConfigured){const next=normalize(data);if(next.mode==='domain'&&!passwordConfigured)fail('Configura tu contraseña personal antes de habilitar un dominio público.');fs.writeFileSync(file+'.tmp',JSON.stringify(next,null,2),{mode:0o600});fs.renameSync(file+'.tmp',file);return next;}
 function caddy(config,port){const c=normalize(config);return c.mode==='domain'?`${new URL(c.origin).host} {\n    reverse_proxy 127.0.0.1:${port}\n}\n`:'';}
 return {current,request,save,caddy,bindHost:current.mode==='lan'?'0.0.0.0':'127.0.0.1',pending:()=>fs.existsSync(file)?normalize(JSON.parse(fs.readFileSync(file,'utf8'))):current};
}
module.exports={createHosting,normalize,loopback,privateAddress};
