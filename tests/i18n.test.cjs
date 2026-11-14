const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const catalog=require('../src/panel/public/locales.json');
const slots=text=>[...text.matchAll(/WOLFSLOT\d+/g)].map(m=>m[0]).sort();
test('All five translated catalogs cover the same UI and retain dynamic values exactly',()=>{
 assert.deepEqual(Object.keys(catalog.languages).sort(),['de','en','fr','pt','tr']);
 const reference=Object.keys(catalog.languages.en).sort();assert.ok(reference.length>1500);
 for(const [language,dictionary]of Object.entries(catalog.languages)){
  assert.deepEqual(Object.keys(dictionary).sort(),reference,language+' coverage');
  for(const [source,value]of Object.entries(dictionary)){
   assert.equal(typeof value,'string');assert.ok(value.trim(),language+': '+source);
   assert.deepEqual(slots(value),slots(source),language+': '+source);
   assert.doesNotMatch(value,/\.{6}|\uFFFD|undefined|null null/i,language+': '+source);
  }
 }
 assert.equal(catalog.languages.tr['Crear Servidor'],'Sunucu oluştur');
 assert.equal(catalog.languages.pt['Seguridad y contraseña'],'Segurança e senha');
});
test('The guide and panel both include the language control and static catalog',()=>{
 const root=path.resolve(__dirname,'../src/panel/public');
 for(const name of ['index.html','help.html'])assert.match(fs.readFileSync(path.join(root,name),'utf8'),/\/i18n\.js/);
 const script=fs.readFileSync(path.join(root,'i18n.js'),'utf8');
 assert.match(script,/data-no-i18n/);assert.match(script,/locales\.json/);assert.match(script,/Português \(Brasil\)/);
});
