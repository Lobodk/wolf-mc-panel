'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { gunzipSync } = require('node:zlib');
const { createNativeHosting, launchArguments } = require('../src/panel/native-hosting.cjs');
const { syncTree } = require('../src/panel/native-host-transfer.cjs');

const id = '3cee1dc8-3a60-42da-b726-187eb09bc2c5';

async function withTemp(t, callback) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(),'wolf-migration-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  return callback(root);
}

test('accepts managed launch layouts and refuses arguments outside the server directory', t=>withTemp(t,async directory=>{
  const panel=path.join(directory,'panel');
  const file=path.join(panel,'launch.json');
  await fs.mkdir(panel);
  const argPath=path.join(directory,'libraries','net','minecraftforge','forge','test','win_args.txt');
  await fs.writeFile(file,JSON.stringify({args:['@'+argPath,'nogui']}));
  assert.deepEqual(launchArguments({directory}),['@libraries/net/minecraftforge/forge/test/win_args.txt','nogui']);
  await fs.writeFile(file,JSON.stringify({args:['-jar',path.join(directory,'fabric-server-launch.jar'),'nogui']}));
  assert.deepEqual(launchArguments({directory}),['-jar','fabric-server-launch.jar','nogui']);
  await fs.writeFile(file,JSON.stringify({args:['-jar',path.resolve(directory,'../unrelated.jar'),'nogui']}));
  assert.throws(()=>launchArguments({directory}),/fuera del servidor/);
}));

test('one downloaded tool pairs a pinned Windows host without a plaintext credential in the receipt or arguments', t=>withTemp(t,async directory=>{
  const controller=require('../src/panel/migration.cjs').lanInterfaces()[0]?.address;
  if(!controller){t.skip('No private IPv4 on this test runner');return;}
  const profile={id,controller,gamePort:25442,rconPort:25443,worldName:'world',replicaFolder:'E:\\Wolf\\Games'};
  const record={id,serverPort:profile.gamePort,rconPort:profile.rconPort,directory,javaMajor:21,status:'ready',eulaAccepted:true};
  await fs.mkdir(path.join(directory,'panel'));
  await fs.writeFile(path.join(directory,'server.properties'),'level-name=world\n');
  await fs.writeFile(path.join(directory,'panel','launch.json'),JSON.stringify({args:['-jar',path.join(directory,'server.jar'),'nogui']}));
  const publicSSH='ssh-ed25519 '+Buffer.alloc(51,2).toString('base64');
  let passwordReceived, pinnedChecked=false;
  const peer='10.42.18.12'===controller?'10.42.18.13':'10.42.18.12';
  const host=createNativeHosting(directory,profile,{
    async runCommand(file,args) {
      if(file.endsWith('ssh-keygen.exe')) {
        const privateFile=args.at(-1);
        await fs.writeFile(privateFile,'private-test-marker');
        await fs.writeFile(privateFile+'.pub',publicSSH);
        return {stdout:''};
      }
      if(file==='whoami.exe')return {stdout:'S-1-5-21-1-2-3-1001'};
      if(file==='icacls.exe')return {stdout:''};
      assert.ok(file.endsWith('ssh.exe'));
      assert.ok(args.includes('StrictHostKeyChecking=yes'));
      assert.equal(args.at(-1),'status');
      pinnedChecked=true;
      return {stdout:JSON.stringify({instance:id,root:profile.replicaFolder,computer:'PEER-PC',armed:false,running:false})};
    },
    spawnProcess(file,args) {
      assert.ok(pinnedChecked);
      assert.equal(args.at(-1),'-ImportSecret');
      assert.ok(!args.some(arg=>arg.includes('Wm9-')));
      const child=new EventEmitter();
      child.stdin=new PassThrough();
      child.stderr=new PassThrough();
      child.stdin.on('data',bytes=>{passwordReceived=bytes.toString();});
      child.stdin.on('end',()=>child.emit('close',0));
      return child;
    },
  });
  t.after(()=>host.close());
  host.attach({hostingRecord:()=>record});
  const action=async(method,route,data)=>{
    let result;
    const response={writeHead:(status,headers)=>{result={status,headers}},end:body=>{result.body=body}};
    await host.handle({method},response,new URL('http://localhost/api/app/native-hosting'+route),
      {sendJson:(res,status,body)=>{result={status,body}},readJson:async()=>data});
    return result;
  };
  const tool=await action('POST','/tool');
  assert.match(tool.headers['Content-Disposition'],/Preparar-WolfMC\.cmd/);
  const payload=tool.body.split('\r\n:WOLFMC_PAYLOAD\r\n')[1].replace(/\s/g,'');
  const bootstrap=Buffer.from(payload,'base64').toString('utf16le');
  const script=gunzipSync(Buffer.from(/FromBase64String\('([^']+)'\)/.exec(bootstrap)[1],'base64')).toString();
  assert.ok(!script.includes('private-test-marker'));
  assert.ok(!script.includes('@@CONFIG@@'));
  const invite=JSON.parse(Buffer.from(/FromBase64String\('([^']+)'\)/.exec(script)[1],'base64').toString());
  const secret='Wm9-'+Buffer.alloc(24,7).toString('base64');
  const encryptedPassword=crypto.publicEncrypt({key:crypto.createPublicKey({key:invite.encryptionKey,format:'jwk'}),oaepHash:'sha256'},Buffer.from(secret)).toString('base64');
  const receipt={instance:id,host:peer,controller,computer:'PEER-PC',share:invite.share,
    folder:profile.replicaFolder,hostKey:publicSSH,nonce:invite.nonce,encryptedPassword};
  await assert.rejects(action('POST','/pair',{...receipt,nonce:'invalid'}),/caducó/);
  assert.equal((await action('POST','/pair',receipt)).status,200);
  assert.equal(passwordReceived,secret);
  const stored=await fs.readFile(path.join(host.data,'peer.json'),'utf8');
  assert.ok(!stored.includes(secret));
  assert.ok(!stored.includes(encryptedPassword));
  assert.ok((await action('GET','')).body.linked);
  await assert.rejects(action('POST','/pair',receipt),/caducó/);
}));

test('Robocopy preserves the previous replica and excludes panel credentials and world locks', {skip:process.platform!=='win32'}, t=>withTemp(t,async directory=>{
  const from=path.join(directory,'origin with spaces');
  const to=path.join(directory,'destination with spaces');
  const recovery=path.join(to,'.wolfmc-recovery','previous');
  for(const root of [from,to])await fs.mkdir(path.join(root,'world'),{recursive:true});
  await fs.mkdir(path.join(from,'panel'));
  await fs.writeFile(path.join(from,'panel','panel-config.json'),'LOCAL');
  await fs.writeFile(path.join(from,'world','session.lock'),'LOCK');
  await fs.writeFile(path.join(from,'world','changes'),'NEW');
  await fs.writeFile(path.join(to,'world','changes'),'OLD');
  const options={from,to,recovery,progress:()=>{},confirm:async()=>{}};
  await syncTree(options);
  assert.equal(await fs.readFile(path.join(to,'world','changes'),'utf8'),'NEW');
  assert.equal(await fs.readFile(path.join(recovery,'world','changes'),'utf8'),'OLD');
  await assert.rejects(fs.stat(path.join(to,'panel')),{code:'ENOENT'});
  await assert.rejects(fs.stat(path.join(to,'world','session.lock')),{code:'ENOENT'});
  await fs.writeFile(path.join(from,'world','changes'),'LATER');
  await assert.rejects(syncTree({...options,confirm:async()=>{throw Error('unfenced');}}),/unfenced/);
  assert.equal(await fs.readFile(path.join(to,'world','changes'),'utf8'),'NEW');
}));
