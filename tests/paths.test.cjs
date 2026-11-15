'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{execFileSync}=require('node:child_process');
const moduleFile=path.resolve(__dirname,'../src/paths.cjs');
function resolve(env){return execFileSync(process.execPath,['-e','process.stdout.write(require(process.argv[1]).defaultDataDir())',moduleFile],{encoding:'utf8',windowsHide:true,env:{...process.env,WOLF_PANEL_DATA:'',LOBO_PANEL_DATA:'',...env}});}
test('The default data folder always uses WolfMCPanel and leaves unrelated early test folders untouched',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'wolf-paths-'));
 try{const older=path.join(root,'LoboServerPanel/data');fs.mkdirSync(older,{recursive:true});fs.writeFileSync(path.join(older,'sentinel.txt'),'preserve test data');assert.equal(resolve({LOCALAPPDATA:root}),path.join(root,'WolfMCPanel/data'));assert.equal(fs.readFileSync(path.join(older,'sentinel.txt'),'utf8'),'preserve test data');}
 finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('Explicit data-folder overrides still preserve their priority and existing test profiles',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'wolf-override-'));
 try{const preferred=path.join(root,'explicit'),fallback=path.join(root,'previous-test');assert.equal(resolve({LOCALAPPDATA:root,WOLF_PANEL_DATA:preferred,LOBO_PANEL_DATA:fallback}),preferred);assert.equal(resolve({LOCALAPPDATA:root,LOBO_PANEL_DATA:fallback}),fallback);}
 finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('The README, guide and every language describe only the current product and data folder',()=>{
 const root=path.resolve(__dirname,'..');for(const name of ['README.md','docs/README.es.md','assets/README.md','src/panel/public/help.html','src/panel/public/locales.json']){const text=fs.readFileSync(path.join(root,name),'utf8');assert.doesNotMatch(text,/LoboServerPanel|Lobo Server Panel/i,name);if(name!=='assets/README.md')assert.match(text,/WolfMCPanel\/data/,name);}
 const build=fs.readFileSync(path.join(root,'scripts/build-windows.ps1'),'utf8'),installer=fs.readFileSync(path.join(root,'installer/windows.iss'),'utf8');assert.match(build,/build\/WolfMCPanel\.exe/);assert.match(installer,/Source: "\.\.\\build\\WolfMCPanel\.exe"/);
});
