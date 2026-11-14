const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createHosting,normalize,privateAddress}=require('../src/hosting.cjs');
const req=(host,ip='127.0.0.1',headers={})=>({url:'/api/app/session',headers:{host,...headers},socket:{remoteAddress:ip}});
test('Local and LAN modes reject DNS rebinding, public source addresses and forged proxy headers',()=>{
 const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'wolf-host-'));
 try{let h=createHosting({dataDir});assert.ok(h.request(req('localhost:8787')));assert.equal(h.request(req('evil.example:8787')),null);assert.equal(h.request(req('localhost:8787','8.8.8.8')),null);
  h.save({mode:'lan',lanNames:['wolf-panel']},false);h=createHosting({dataDir});assert.equal(h.bindHost,'0.0.0.0');assert.ok(h.request(req('wolf-panel:8787','192.168.1.4')));assert.equal(h.request(req('evil.example:8787','192.168.1.4')),null);assert.equal(h.request(req('wolf-panel:8787','8.8.8.8',{'x-forwarded-for':'192.168.1.4'})),null);assert.equal(h.request(req('wolf-panel:8787','192.168.1.4',{'x-forwarded-for':'1.1.1.1'})).client,'192.168.1.4');
  assert.equal(privateAddress('172.31.1.2'),true);assert.equal(privateAddress('172.32.1.2'),false);
 }finally{fs.rmSync(dataDir,{recursive:true,force:true});}
});
test('HTTPS domain requires a configured password and a local proxy using the configured host',()=>{
 const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'wolf-domain-'));
 try{let h=createHosting({dataDir});assert.throws(()=>h.save({mode:'domain',origin:'https://panel.example.org'},false),/contraseña/);h.save({mode:'domain',origin:'https://panel.example.org'},true);assert.equal(h.current.mode,'local','Saved mode applies only after restart');h=createHosting({dataDir});assert.equal(h.bindHost,'127.0.0.1');
  assert.equal(h.request(req('panel.example.org')),null);assert.equal(h.request(req('panel.example.org','192.168.1.1',{'x-forwarded-proto':'https'})),null);assert.equal(h.request(req('other.example.org','127.0.0.1',{'x-forwarded-proto':'https'})),null);
  const access=h.request(req('panel.example.org','127.0.0.1',{'x-forwarded-proto':'https','x-forwarded-for':'8.8.8.8'}));assert.equal(access.origin,'https://panel.example.org');assert.equal(access.client,'8.8.8.8');assert.equal(h.request(req('localhost:8787')),null);
  const health=req('localhost:8787');health.url='/api/app/health';assert.ok(h.request(health).internal);assert.match(h.caddy(h.current,8787),/reverse_proxy 127\.0\.0\.1:8787/);
  for(const origin of ['http://panel.example.org','https://panel.example.org/path','https://user:pass@panel.example.org','https://127.0.0.1','https://panel.example.org/#fragment'])assert.throws(()=>normalize({mode:'domain',origin}));
 }finally{fs.rmSync(dataDir,{recursive:true,force:true});}
});
