'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {resetLocalPassword,stopOwnedPanel}=require('../src/recovery.cjs');
const {createAuth}=require('../src/auth.cjs');
const {start}=require('../src/main.cjs');
const initial='test-bootstrap-key-that-will-be-rotated';
const response=()=>({setHeader(){}});
async function fixture(run){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'wolf-recovery-'));fs.mkdirSync(path.join(dir,'control/panel'),{recursive:true});fs.writeFileSync(path.join(dir,'control/panel/panel-config.json'),JSON.stringify({panelToken:initial,serverPort:25941,rconPort:26941,rconPassword:'test-rcon-retained',rconHost:'127.0.0.1'}));const auth=createAuth({dataDir:dir,initialKey:initial});await auth.change(initial,'Test password before reset!',response());try{await run(dir);}finally{fs.rmSync(dir,{recursive:true,force:true});}}

test('Local recovery rotates temporary keys, preserves worlds and RCON, and requires a new personal password',()=>fixture(async dir=>{
 const control=path.join(dir,'control'),world=path.join(control,'world');fs.mkdirSync(world);fs.writeFileSync(path.join(world,'sentinel.dat'),'world remains exactly intact');fs.writeFileSync(path.join(dir,'hosting.json'),JSON.stringify({mode:'domain',origin:'https://panel.example.org',managedProxy:true}));
 const oldAuth=fs.readFileSync(path.join(dir,'auth.json'));
 const result=resetLocalPassword({dataDir:dir,confirmed:true});
 const config=JSON.parse(fs.readFileSync(path.join(control,'panel/panel-config.json')));
 assert.notEqual(config.panelToken,initial);assert.equal(config.rconPassword,'test-rcon-retained');
 assert.equal(fs.readFileSync(path.join(world,'sentinel.dat'),'utf8'),'world remains exactly intact');
 assert.equal(fs.existsSync(path.join(dir,'auth.json')),false);assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'hosting.json'))).mode,'local');
 assert.ok(fs.readdirSync(result.backupDir).some(f=>f.endsWith('auth.json')&&fs.readFileSync(path.join(result.backupDir,f)).equals(oldAuth)));
 const recovered=createAuth({dataDir:dir,initialKey:config.panelToken});
 assert.equal(await recovered.verify(initial),false);assert.equal(await recovered.verify('Test password before reset!'),false);assert.equal(await recovered.verify(config.panelToken),true);
 await recovered.change(config.panelToken,'New test password after reset!',response());
 assert.equal(await recovered.verify(config.panelToken),false);assert.equal(await recovered.verify('New test password after reset!'),true);
}));

test('Cancelling confirmation preserves existing credentials and does not create a recovery backup',()=>fixture(async dir=>{
 const before=fs.readFileSync(path.join(dir,'auth.json'));
 assert.throws(()=>resetLocalPassword({dataDir:dir}),/Confirma/);
 assert.ok(fs.readFileSync(path.join(dir,'auth.json')).equals(before));assert.equal(fs.existsSync(path.join(dir,'recovery-backups')),false);
}));

test('Recovery rotates managed child keys together and rejects records outside the managed root before mutation',()=>fixture(async dir=>{
 const id='11111111-2222-4333-8444-555555555555',server=path.join(dir,'servers',id);fs.mkdirSync(path.join(server,'panel'),{recursive:true});fs.writeFileSync(path.join(server,'panel/panel-config.json'),JSON.stringify({panelToken:initial,rconPassword:'child-rcon-unchanged'}));fs.writeFileSync(path.join(dir,'servers.json'),JSON.stringify([{id,directory:server}]));
 resetLocalPassword({dataDir:dir,confirmed:true});const main=JSON.parse(fs.readFileSync(path.join(dir,'control/panel/panel-config.json'))),child=JSON.parse(fs.readFileSync(path.join(server,'panel/panel-config.json')));
 assert.equal(child.panelToken,main.panelToken);assert.equal(child.rconPassword,'child-rcon-unchanged');
 fs.writeFileSync(path.join(dir,'auth.json'),'preserve-this-auth-record');fs.writeFileSync(path.join(dir,'servers.json'),JSON.stringify([{id,directory:path.join(dir,'outside')}])) ;
 assert.throws(()=>resetLocalPassword({dataDir:dir,confirmed:true}),/fuera/);assert.equal(fs.readFileSync(path.join(dir,'auth.json'),'utf8'),'preserve-this-auth-record');assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'control/panel/panel-config.json'))).panelToken,main.panelToken);
}));

test('A corrupt child config aborts recovery without changing the main key or personal password',()=>fixture(async dir=>{
 const id='11111111-2222-4333-8444-555555555555',server=path.join(dir,'servers',id);fs.mkdirSync(path.join(server,'panel'),{recursive:true});fs.writeFileSync(path.join(server,'panel/panel-config.json'),'{bad');fs.writeFileSync(path.join(dir,'servers.json'),JSON.stringify([{id,directory:server}]));
 const before=fs.readFileSync(path.join(dir,'auth.json'));assert.throws(()=>resetLocalPassword({dataDir:dir,confirmed:true}));assert.ok(fs.readFileSync(path.join(dir,'auth.json')).equals(before));assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'control/panel/panel-config.json'))).panelToken,initial);
}));

test('A personal-panel layout rotates only its explicitly managed child installations',()=>fixture(async dir=>{
 const managed=path.join(dir,'personal-managed'),registry=path.join(dir,'personal-servers.json'),id='11111111-2222-4333-8444-555555555555',server=path.join(managed,id);
 fs.mkdirSync(path.join(server,'panel'),{recursive:true});fs.writeFileSync(path.join(server,'panel/panel-config.json'),JSON.stringify({panelToken:initial,rconPassword:'preserve-personal-child'}));fs.writeFileSync(registry,JSON.stringify([{id:'main',directory:path.join(dir,'control')},{id,directory:server}]));
 resetLocalPassword({dataDir:dir,registryFile:registry,managedRoot:managed,confirmed:true});
 const main=JSON.parse(fs.readFileSync(path.join(dir,'control/panel/panel-config.json'))),child=JSON.parse(fs.readFileSync(path.join(server,'panel/panel-config.json')));assert.equal(child.panelToken,main.panelToken);assert.equal(child.rconPassword,'preserve-personal-child');
}));

test('Source desktop reset without explicit local confirmation does not change authentication',()=>fixture(async dir=>{
 const before=fs.readFileSync(path.join(dir,'auth.json'));const child=require('node:child_process').spawnSync(process.execPath,[path.resolve(__dirname,'../src/desktop.cjs'),'--reset-password','--no-browser'],{env:{...process.env,WOLF_PANEL_DATA:dir},windowsHide:true,encoding:'utf8',timeout:10000});assert.equal(child.status,1);assert.ok(fs.readFileSync(path.join(dir,'auth.json')).equals(before));assert.equal(fs.existsSync(path.join(dir,'recovery-backups')),false);
}));

test('A busy panel refuses local recovery shutdown and an unexpected local service is never stopped',()=>fixture(async dir=>{
 fs.writeFileSync(path.join(dir,'installation.json'),JSON.stringify({id:'test-installation'}));fs.writeFileSync(path.join(dir,'address.json'),JSON.stringify({instanceId:'test-installation',port:25940}));let calls=0;
 await assert.rejects(stopOwnedPanel({dataDir:dir,controlDir:path.join(dir,'control'),fetcher:async(url,options)=>{calls++;return options.method==='POST'?{ok:false,status:409,json:async()=>({error:'Hay una operación activa.'})}:{ok:true,json:async()=>({product:'Wolf MC Panel',instanceId:'test-installation'})};}}),/operación activa/);assert.equal(calls,2);
 calls=0;await assert.rejects(stopOwnedPanel({dataDir:dir,controlDir:path.join(dir,'control'),fetcher:async()=>{calls++;return {ok:true,json:async()=>({product:'Other service',instanceId:'someone-else'})};}}),/otra instalación/);assert.equal(calls,1);
}));

test('End-to-end recovery stops only the panel, revokes old sessions and has no unauthenticated web reset route',()=>fixture(async dir=>{
 let app=await start({dataDir:dir,port:0});try{
  const recoveryScript=await fetch(app.address.url+'recovery-ui.js');assert.equal(recoveryScript.status,200);assert.match(await recoveryScript.text(),/forgotPasswordButton/);assert.match(await (await fetch(app.address.url)).text(),/recovery-ui\.js/);
  const login=await fetch(app.address.url+'api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:'Test password before reset!'})});assert.equal(login.status,200);const cookie=login.headers.get('set-cookie').split(';')[0];
  assert.equal((await fetch(app.address.url+'api/app/reset-password',{method:'POST'})).status,401);
  await stopOwnedPanel({dataDir:dir,controlDir:path.join(dir,'control')});await app.close();
  resetLocalPassword({dataDir:dir,confirmed:true});app=await start({dataDir:dir,port:0});
  assert.equal((await fetch(app.address.url+'api/app/session',{headers:{Cookie:cookie}})).status,401);
  assert.equal((await fetch(app.address.url+'api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:'Test password before reset!'})})).status,401);
  const key=JSON.parse(fs.readFileSync(path.join(dir,'control/panel/panel-config.json'))).panelToken;
  assert.equal((await fetch(app.address.url+'api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:key})})).status,200);
 }finally{await app.close();}
}));
