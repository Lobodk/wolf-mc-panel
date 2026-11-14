const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto'),https=require('node:https'),net=require('node:net'),{spawn,execFileSync}=require('node:child_process');
const {start}=require('../src/main.cjs');
const caddy=path.resolve('runtime/caddy.exe');
const wait=ms=>new Promise(r=>setTimeout(r,ms));
test('Real HTTPS proxy preserves authentication, Secure cookies and origin checks without disabling TLS verification',{skip:process.platform!=='win32'||!fs.existsSync(caddy)},async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'wolf-https-'));let app,child;
 try{
  const probe=net.createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const tlsPort=probe.address().port;await new Promise(r=>probe.close(r));const origin='https://panel.wolf.test:'+tlsPort;
  const cert=path.join(root,'cert.pem'),key=path.join(root,'key.pem'),jwk=path.join(root,'key.jwk.json'),der=path.join(root,'cert.der');const pair=crypto.generateKeyPairSync('rsa',{modulusLength:2048});fs.writeFileSync(key,pair.privateKey.export({format:'pem',type:'pkcs8'}),{mode:0o600});fs.writeFileSync(jwk,JSON.stringify(pair.privateKey.export({format:'jwk'})),{mode:0o600});execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.resolve('tests/create-test-certificate.ps1'),'-JwkFile',jwk,'-CertificateFile',der],{windowsHide:true,stdio:'pipe'});const base64=fs.readFileSync(der).toString('base64');fs.writeFileSync(cert,'-----BEGIN CERTIFICATE-----\n'+base64.match(/.{1,64}/g).join('\n')+'\n-----END CERTIFICATE-----\n');
  app=await start({dataDir:root,port:0});const initial=app.main.config.panelToken,login=await fetch(app.address.url+'api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:initial})}),headers={Cookie:login.headers.get('set-cookie').split(';')[0],'Content-Type':'application/json'};
  const changed=await fetch(app.address.url+'api/app/password',{method:'PUT',headers,body:JSON.stringify({current:initial,password:'HTTPS test only password 2026'})});assert.equal(changed.status,200);headers.Cookie=changed.headers.get('set-cookie').split(';')[0];
  assert.equal((await fetch(app.address.url+'api/app/hosting',{method:'PUT',headers,body:JSON.stringify({mode:'domain',origin,managedProxy:false})})).status,200);await app.close();app=await start({dataDir:root,port:0});
  assert.equal((await fetch(app.address.url+'api/app/session')).status,403,'Raw backend access does not masquerade as HTTPS');
  const normalize=value=>value.replaceAll('\\','/'),configuration=path.join(root,'Caddyfile');fs.writeFileSync(configuration,`{\n admin off\n auto_https off\n}\n${origin} {\n bind 127.0.0.1\n tls "${normalize(cert)}" "${normalize(key)}"\n reverse_proxy 127.0.0.1:${app.address.port}\n}\n`);
  child=spawn(caddy,['run','--config',configuration,'--adapter','caddyfile'],{windowsHide:true,stdio:'ignore',env:{...process.env,XDG_DATA_HOME:root,XDG_CONFIG_HOME:root}});child.on('error',()=>{});
  const ca=fs.readFileSync(cert);
  function request(route,method='GET',body,extra={}){return new Promise((resolve,reject)=>{const req=https.request({hostname:'127.0.0.1',servername:'panel.wolf.test',port:tlsPort,path:route,method,ca,headers:{Host:'panel.wolf.test:'+tlsPort,'Content-Type':'application/json',...extra}},res=>{let text='';res.on('data',b=>text+=b);res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,data:JSON.parse(text)}));});req.on('error',reject);req.setTimeout(5000,()=>req.destroy(Error('HTTPS timeout')));if(body)req.write(JSON.stringify(body));req.end();});}
  let connected=false;for(let i=0;i<40;i++){try{await request('/api/app/health');connected=true;break;}catch{await wait(250);}}assert.ok(connected,'Caddy starts with a verified local test certificate');
  assert.equal((await request('/api/app/session')).status,401);
  assert.equal((await request('/api/login','POST',{token:initial},{Origin:origin})).status,401);
  const authenticated=await request('/api/login','POST',{token:'HTTPS test only password 2026'},{Origin:origin});assert.equal(authenticated.status,200);assert.match(authenticated.headers['set-cookie'][0],/HttpOnly; SameSite=Strict; Secure/);const cookie=authenticated.headers['set-cookie'][0].split(';')[0];
  assert.equal((await request('/api/app/session','GET',null,{Cookie:cookie})).status,200);
  assert.equal((await request('/api/app/preferences','PUT',{name:'Test',icon:''},{Cookie:cookie,Origin:'https://unrelated.example'})).status,403);
  assert.equal((await request('/api/app/preferences','PUT',{name:'HTTPS verified',icon:''},{Cookie:cookie,Origin:origin})).status,200);
 }finally{if(child&&child.exitCode===null)child.kill();if(app)await app.close();assert.ok(root.startsWith(path.join(os.tmpdir(),'wolf-https-')));for(let i=0;i<20&&child&&child.exitCode===null;i++)await wait(100);fs.rmSync(root,{recursive:true,force:true});}
});
