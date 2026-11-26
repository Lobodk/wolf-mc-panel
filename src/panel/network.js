'use strict';
const fs = require('node:fs/promises');
const {execFile} = require('node:child_process');
const {promisify} = require('node:util');
const run = promisify(execFile);
const WINDOW_MS = 10 * 60 * 1000;

function deltaCounters(previous, next) {
  if (!previous?.available || !next?.available || previous.adapter.id !== next.adapter.id) return null;
  const seconds = (next.sampledAt - previous.sampledAt) / 1000;
  if (seconds <= 0 || seconds > 30) return null;
  const keys = ['receivedBytes','sentBytes','receivedPackets','sentPackets','receiveErrors','sendErrors','receiveDiscards','sendDiscards','tcpRetransmitted'];
  if (keys.some(k => !Number.isFinite(next.counters[k]) || next.counters[k] < previous.counters[k])) return null;
  const change = Object.fromEntries(keys.map(k=>[k,next.counters[k]-previous.counters[k]]));
  return {seconds,downloadBytesPerSecond:change.receivedBytes/seconds,uploadBytesPerSecond:change.sentBytes/seconds,
    receivedPacketsPerSecond:change.receivedPackets/seconds,sentPacketsPerSecond:change.sentPackets/seconds,
    tcpRetransmitsPerSecond:change.tcpRetransmitted/seconds,
    errors:change.receiveErrors+change.sendErrors,discards:change.receiveDiscards+change.sendDiscards};
}
function probeSummary(history, key) {
  const samples=history.slice(-20).map(s=>s[key]).filter(Boolean);
  const ok=samples.filter(s=>s.success && Number.isFinite(s.ms));
  let variation=0, pairs=0;
  for(let i=1;i<samples.length;i++)if(samples[i-1].success&&samples[i].success){variation+=Math.abs(samples[i].ms-samples[i-1].ms);pairs++;}
  return {samples:samples.length,unanswered:samples.filter(s=>!s.success).length,
    unansweredPercent:samples.length?100*samples.filter(s=>!s.success).length/samples.length:null,
    averageMs:ok.length?ok.reduce((sum,s)=>sum+s.ms,0)/ok.length:null,
    variationMs:pairs?variation/pairs:null};
}
function validateBridge(value, now=Date.now()) {
  if(value?.schema!==1 || !Number.isFinite(value.sampledAt) || value.sampledAt>now+5000 || now-value.sampledAt>20000 || !Array.isArray(value.players)) return null;
  const players=value.players.filter(p=>typeof p.name==='string'&&/^[A-Za-z0-9_]{1,16}$/.test(p.name)&&Number.isFinite(p.pingMs)&&p.pingMs>=0).map(p=>({name:p.name,pingMs:Math.round(p.pingMs)}));
  return {sampledAt:value.sampledAt,pid:value.pid,players,mspt:Number.isFinite(value.mspt)?value.mspt:null,
    observedTps:Number.isFinite(value.observedTps)?value.observedTps:null};
}
function createNetworkMonitor({powershell,script,serverPort,bridgeFile,intervalMs=5000,readSample,hostLabel='PC del panel'}) {
  let previous=null,baseline=null,history=[],latest=null,error='',busy=false;
  let playerHistory=new Map(),bridgePid=null;
  const startedAt=Date.now();
  async function sample(){
    if(busy)return;
    busy=true;
    try {
      let raw;
      if(readSample)raw=await readSample();
      else {
        const {stdout}=await run(powershell,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',script,'-MinecraftPort',String(serverPort)],{timeout:10000,windowsHide:true,maxBuffer:65536});
        raw=JSON.parse(stdout.replace(/^\uFEFF/,'').trim());
      }
      if(!raw||!Number.isFinite(raw.sampledAt))throw Error('El equipo no devolvió datos de red.');
      const rates=deltaCounters(previous,raw);
      if(raw.available&&(!baseline||baseline.adapter.id!==raw.adapter.id||raw.counters.receivedBytes<baseline.counters.receivedBytes||raw.counters.sentBytes<baseline.counters.sentBytes))baseline=raw;
      const game=raw.gameListening?await fs.readFile(bridgeFile,'utf8').then(s=>validateBridge(JSON.parse(s))).catch(()=>null):null;
      if(!game||bridgePid!==game.pid){playerHistory.clear();bridgePid=game?.pid??null;}
      if(game){
        const names=new Set(game.players.map(p=>p.name));
        for(const name of playerHistory.keys())if(!names.has(name))playerHistory.delete(name);
        game.players=game.players.map(p=>{
          const readings=playerHistory.get(p.name)||[];
          if(readings.at(-1)?.at!==game.sampledAt)readings.push({at:game.sampledAt,ping:p.pingMs});
          const recent=readings.filter(r=>r.at>raw.sampledAt-300000).slice(-60);
          playerHistory.set(p.name,recent);
          return {...p,averageMs:recent.reduce((a,r)=>a+r.ping,0)/recent.length,maxMs:Math.max(...recent.map(r=>r.ping)),samples:recent.length};
        });
      }
      latest={...raw,rates,game,sessionReceivedBytes:raw.available&&baseline?raw.counters.receivedBytes-baseline.counters.receivedBytes:null,
        sessionSentBytes:raw.available&&baseline?raw.counters.sentBytes-baseline.counters.sentBytes:null,sessionStartedAt:baseline?.sampledAt??null};
      history.push({at:raw.sampledAt,downloadBytesPerSecond:rates?.downloadBytesPerSecond??null,uploadBytesPerSecond:rates?.uploadBytesPerSecond??null,
        gatewayProbe:raw.gatewayProbe??null,internetProbe:raw.internetProbe??null});
      history=history.filter(s=>s.at>raw.sampledAt-WINDOW_MS).slice(-120);
      previous=raw;error='';
    }catch(e){error=readSample?e.message:'No se pudo leer la telemetría de red de Windows.';}
    finally{busy=false;}
  }
  let samplePromise=null,stopped=false;
  return {async snapshot(){if(!stopped&&(!latest||Date.now()-latest.sampledAt>=intervalMs)&&!samplePromise)samplePromise=sample().finally(()=>{samplePromise=null;});if(samplePromise)await samplePromise;return {startedAt,intervalMs,windowMs:WINDOW_MS,sampledAt:latest?.sampledAt??null,
    stale:Boolean(error)||!latest||Date.now()-latest.sampledAt>20000,error,host:latest,hostLabel,
    probes:{gateway:probeSummary(history,'gatewayProbe'),internet:probeSummary(history,'internetProbe')},
    history:history.map(({gatewayProbe,internetProbe,...s})=>s)};},stop(){stopped=true;}};
}
module.exports={createNetworkMonitor,deltaCounters,probeSummary,validateBridge};
