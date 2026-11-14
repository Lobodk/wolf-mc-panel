const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {createAuth}=require('../src/auth.cjs');
test('Session tickets are bounded, expire and cannot be reused after logout',()=>{
 const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'lobo-auth-'));let at=0;
 try{const auth=createAuth({dataDir,initialKey:'test key',now:()=>at});let cookie;const res={setHeader:(_name,value)=>cookie=value.split(';')[0]};auth.issue(res);const first={headers:{cookie}};assert.ok(auth.identify(first));
  for(let i=0;i<20;i++)auth.issue(res);assert.equal(auth.identify(first),null);
  const next={headers:{cookie}};assert.ok(auth.identify(next));at=12*60*60*1000;assert.equal(auth.identify(next),null);
  auth.issue(res);const final={headers:{cookie}};auth.logout(final,res);assert.equal(auth.identify(final),null);
 }finally{fs.rmSync(dataDir,{recursive:true,force:true});}
});
