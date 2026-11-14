'use strict';
const fs=require('node:fs'),path=require('node:path');
function preconfiguredNetwork(codeDir,server,localAddresses){
 let data;try{data=JSON.parse(fs.readFileSync(path.join(codeDir,'network-preconfiguration.json'),'utf8'));}catch{return {firewall:false,router:false};}
 if(data.schema!==1)return {firewall:false,router:false};
 const validPort=n=>Number.isInteger(n)&&n>=1024&&n<=65535;
 const local=server.bindAddress||data.localAddress;
 if(!localAddresses.includes(local)||local!==data.localAddress)return {firewall:false,router:false};
 const firewall=(Array.isArray(data.firewall)?data.firewall:[]).some(rule=>rule&&rule.protocol==='TCP'&&rule.localAddress===local&&validPort(rule.from)&&validPort(rule.to)&&rule.from<=server.serverPort&&server.serverPort<=rule.to&&rule.verifiedAt);
 const router=(Array.isArray(data.router)?data.router:[]).some(rule=>rule&&rule.protocol==='TCP'&&rule.localAddress===local&&[rule.externalFrom,rule.externalTo,rule.localFrom,rule.localTo].every(validPort)&&rule.externalFrom<=server.externalPort&&server.externalPort<=rule.externalTo&&rule.localFrom<=server.serverPort&&server.serverPort<=rule.localTo&&server.externalPort-rule.externalFrom===server.serverPort-rule.localFrom&&rule.verifiedAt);
 return {firewall,router};
}
function currentWarnings(warnings,coverage){return (warnings||[]).filter(message=>!(coverage.firewall&&message.startsWith('Windows no permitió crear la regla.'))&&!(coverage.router&&message.startsWith('El router no permitió UPnP o el puerto está ocupado.')));}
module.exports={preconfiguredNetwork,currentWarnings};
