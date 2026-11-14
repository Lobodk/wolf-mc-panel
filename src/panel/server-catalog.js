'use strict';
const fs=require('node:fs'),fsp=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const {pipeline}=require('node:stream/promises');const {Transform}=require('node:stream');
const MC_MANIFEST='https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';
const cache=new Map();
async function cached(key,work,ttl=600000){const old=cache.get(key);if(old&&Date.now()-old.at<ttl)return old.value;const value=await work();cache.set(key,{at:Date.now(),value});return value;}
async function json(url){const r=await fetch(url,{signal:AbortSignal.timeout(25000)});if(!r.ok)throw Error('El proveedor respondió HTTP '+r.status);return r.json();}
async function xmlVersions(url){const r=await fetch(url,{signal:AbortSignal.timeout(25000)});if(!r.ok)throw Error('El proveedor respondió HTTP '+r.status);return [...(await r.text()).matchAll(/<version>([^<]+)<\/version>/g)].map(m=>m[1]);}
function safeVersion(v){if(typeof v!=='string'||v.length>100||! /^[a-zA-Z0-9_.+ -]+$/.test(v)||v.includes('..'))throw Error('Versión no válida.');return v;}
async function minecraftVersions(force=false){if(force)cache.delete('minecraft');return cached('minecraft',async()=>{const data=await json(MC_MANIFEST);return {latest:data.latest,updatedAt:Date.now(),versions:data.versions.filter(v=>['release','snapshot','old_beta','old_alpha'].includes(v.type)).map(({id,type,releaseTime,url})=>({id,type,releaseTime,url}))};});}
async function minecraftDetails(version){safeVersion(version);return cached('mc:'+version,async()=>{const catalog=await minecraftVersions(),entry=catalog.versions.find(v=>v.id===version);if(!entry)throw Error('Esa versión no figura en el catálogo oficial de Mojang.');const detail=await json(entry.url);if(!detail.downloads?.server)throw Error('Mojang no ofrece un servidor Java descargable para esta versión.');return detail;});}
function neoPrefix(mc){if(/^26\./.test(mc))return mc+'.';const m=/^1\.(\d+)(?:\.(\d+))?$/.exec(mc);return m?m[1]+'.'+(m[2]||'0')+'.':null;}
async function loaderVersions(mc,loader){safeVersion(mc);if(!['vanilla','neoforge','forge','fabric'].includes(loader))throw Error('Loader no válido.');if(loader==='vanilla')return {versions:[],loader};return cached(loader+':'+mc,async()=>{
 let versions=[];
 if(loader==='fabric'){const data=await json('https://meta.fabricmc.net/v2/versions/loader/'+encodeURIComponent(mc));versions=data.map(row=>({id:row.loader.version,stable:row.loader.stable!==false}));}
 if(loader==='forge'){const data=await xmlVersions('https://maven.minecraftforge.net/net/minecraftforge/forge/maven-metadata.xml');versions=data.filter(v=>v.startsWith(mc+'-')).reverse().map(id=>({id,stable:! /beta|alpha|rc/i.test(id)}));}
 if(loader==='neoforge'){const prefix=neoPrefix(mc);if(prefix){const data=await xmlVersions('https://maven.neoforged.net/releases/net/neoforged/neoforge/maven-metadata.xml');versions=data.filter(v=>v.startsWith(prefix)).reverse().map(id=>({id,stable:! /beta|alpha|rc/i.test(id)}));}}
 return {loader,versions,updatedAt:Date.now()};
 });}
async function download(url,file,{sha1='',sha256='',maxBytes=600*1024*1024,progress=()=>{}}={}){
 if(new URL(url).protocol!=='https:')throw Error('Solo se permiten descargas HTTPS.');
 const response=await fetch(url,{signal:AbortSignal.timeout(600000)});if(!response.ok||!response.body)throw Error('Descarga fallida, HTTP '+response.status);
 const total=Number(response.headers.get('content-length'))||0;if(total>maxBytes)throw Error('La descarga supera el tamaño permitido.');
 let bytes=0,last=0;const a=crypto.createHash('sha1'),b=crypto.createHash('sha256');
 const limiter=new Transform({transform(chunk,enc,done){bytes+=chunk.length;if(bytes>maxBytes)return done(Error('La descarga supera el tamaño permitido.'));a.update(chunk);b.update(chunk);if(Date.now()-last>250){last=Date.now();progress(bytes,total);}done(null,chunk);}});
 await fsp.mkdir(path.dirname(file),{recursive:true});
 try{await pipeline(response.body,limiter,fs.createWriteStream(file,{flags:'wx'}));if(sha1&&a.digest('hex')!==sha1)throw Error('La huella SHA-1 de la descarga no coincide.');if(sha256&&b.digest('hex')!==sha256)throw Error('La huella SHA-256 de la descarga no coincide.');progress(bytes,total||bytes);return bytes;}catch(e){await fsp.rm(file,{force:true}).catch(()=>{});throw e;}
}
async function fabricLauncher(mc,loader){const installers=await cached('fabric-installers',()=>json('https://meta.fabricmc.net/v2/versions/installer'));const installer=installers.find(x=>x.stable)?.version||installers[0]?.version;if(!installer)throw Error('No se encuentra el instalador de Fabric.');return 'https://meta.fabricmc.net/v2/versions/loader/'+encodeURIComponent(mc)+'/'+encodeURIComponent(loader)+'/'+encodeURIComponent(installer)+'/server/jar';}
module.exports={minecraftVersions,minecraftDetails,loaderVersions,download,fabricLauncher,safeVersion,neoPrefix};
