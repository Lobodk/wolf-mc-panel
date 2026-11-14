const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {createModStaging}=require('../src/panel/mod-staging');
function fixture(fn){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'lobodk-stage-test-'));
 fs.mkdirSync(path.join(dir,'mods'));const store=createModStaging(dir);
 const write=(name,text)=>{const p=path.join(dir,name);fs.writeFileSync(p,text);return p;};
 try{return fn({dir,store,write,read:name=>fs.readFileSync(path.join(dir,name),'utf8')});}
 finally{fs.rmSync(dir,{recursive:true,force:true});}
}
test('Preparing updates never changes loaded JARs; restart applies replacements and dependencies with backups',()=>fixture(({dir,store,write,read})=>{
 write('mods/old.jar','old');
 store.stage(write('download','new'),{name:'new.jar',replaceName:'old.jar',modId:1});
 store.stage(write('dependency','dependency'),{name:'library.jar',modId:2});
 assert.equal(read('mods/old.jar'),'old');assert.equal(fs.existsSync(path.join(dir,'mods/new.jar')),false);
 const result=createModStaging(dir).apply();assert.equal(result.applied,2);assert.equal(read('mods/new.jar'),'new');
 assert.equal(read('mods/library.jar'),'dependency');assert.equal(fs.readFileSync(path.join(result.backupDir,'old.jar'),'utf8'),'old');
 assert.equal(store.list().length,0);assert.equal(store.apply().applied,0);
}));
test('Same filename replacement and pending version replacement keep the original until apply',()=>fixture(({store,write,read})=>{
 write('mods/mod.jar','old');store.stage(write('download','new'),{name:'mod.jar',replaceName:'mod.jar',modId:1});
 store.stage(write('download','newer'),{name:'mod.jar',replaceName:'mod.jar',modId:1});
 assert.equal(store.list().length,1);assert.equal(read('mods/mod.jar'),'old');store.apply();assert.equal(read('mods/mod.jar'),'newer');
}));
test('Corrupt downloads and manual changes prevent application before touching installed files',()=>fixture(({dir,store,write,read})=>{
 write('mods/a.jar','original');store.stage(write('download','new'),{name:'b.jar',replaceName:'a.jar',modId:1});
 const entry=store.list()[0];fs.writeFileSync(path.join(dir,'panel/pending-mods',entry.staged),'corrupt');
 assert.throws(()=>store.apply(),/alterado/);assert.equal(read('mods/a.jar'),'original');
 store.stage(write('download','new'),{name:'b.jar',replaceName:'a.jar',modId:1});write('mods/a.jar','manual');
 assert.throws(()=>store.apply(),/original ha cambiado/);assert.equal(read('mods/a.jar'),'manual');
}));
test('An interrupted batch rolls back already replaced JARs and remains retryable',()=>fixture(({dir,store,write,read})=>{
 write('mods/a.jar','a');write('mods/b.jar','b');
 store.stage(write('download','A'),{name:'aa.jar',replaceName:'a.jar',modId:1});
 store.stage(write('download','B'),{name:'bb.jar',replaceName:'b.jar',modId:2});
 const rename=fs.renameSync;fs.renameSync=function(from,to){if(from===path.join(dir,'mods/b.jar'))throw Error('simulated locked JAR');return rename(from,to);};
 try{assert.throws(()=>store.apply(),/locked/);}finally{fs.renameSync=rename;}
 assert.equal(read('mods/a.jar'),'a');assert.equal(read('mods/b.jar'),'b');assert.equal(fs.existsSync(path.join(dir,'mods/aa.jar')),false);
 assert.equal(store.list().length,2);assert.equal(store.apply().applied,2);
}));
test('A failed dependency download can restore the previous queue without deleting active mods',()=>fixture(({store,write,read})=>{
 write('mods/a.jar','a');store.stage(write('download','A'),{name:'aa.jar',replaceName:'a.jar',modId:1});
 const checkpoint=store.checkpoint();store.stage(write('download','dependency'),{name:'library.jar',modId:2});
 store.rollback(checkpoint);assert.equal(store.list().length,1);assert.equal(read('mods/a.jar'),'a');
 assert.throws(()=>store.stage(write('download','bad'),{name:'../escape.jar',modId:3}),/Nombre/);
}));
