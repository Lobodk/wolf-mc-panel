'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const {readZipEntries}=require('./item-catalog');
function createAutoModpackStatus(serverDir){
 const cache=new Map();
 async function installed(){
  const directory=path.join(serverDir,'mods');let entries;try{entries=await fs.readdir(directory,{withFileTypes:true});}catch{return false;}
  const files=entries.filter(e=>e.isFile()&&e.name.toLowerCase().endsWith('.jar')).sort((a,b)=>Number(/^automodpack/i.test(b.name))-Number(/^automodpack/i.test(a.name)));
  for(const entry of files){const file=path.join(directory,entry.name);try{
   const stat=await fs.stat(file),key=stat.size+':'+stat.mtimeMs;let item=cache.get(entry.name);
   if(!item||item.key!==key){const metadata=await readZipEntries(file,name=>['fabric.mod.json','META-INF/mods.toml','META-INF/neoforge.mods.toml'].includes(name));let found=false;
    for(const [name,text]of metadata){if(name==='fabric.mod.json'){try{found||=['automodpack','automodpack_mod'].includes(JSON.parse(text).id);}catch{}}else found||=/^\s*modId\s*=\s*["']automodpack(?:_mod)?["']/m.test(text);}
    item={key,found};cache.set(entry.name,item);
   }if(item.found)return true;
  }catch{cache.delete(entry.name);}}
  const names=new Set(files.map(e=>e.name));for(const name of cache.keys())if(!names.has(name))cache.delete(name);return false;
 }
 async function snapshot(){
  if(!await installed())return {installed:false};
  try{const file=path.join(serverDir,'automodpack/credentials/certificate.crt');const stat=await fs.stat(file);if(!stat.isFile()||stat.size>1024*1024)throw Error('Invalid certificate');
   const root=await fs.realpath(serverDir),real=await fs.realpath(file);if(!real.startsWith(root+path.sep))throw Error('Certificate outside server');
   const certificate=new crypto.X509Certificate(await fs.readFile(file));return {installed:true,available:true,fingerprint:crypto.createHash('sha256').update(certificate.raw).digest('hex'),algorithm:'SHA-256'};
  }catch{return {installed:true,available:false,message:'La huella aún no está disponible. Arranca este servidor con AutoModpack para que genere su certificado.'};}
 }
 return {snapshot};
}
module.exports={createAutoModpackStatus};
