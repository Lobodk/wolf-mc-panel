const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../src/panel/server.js'),'utf8');
test('CurseForge searches apply relevance or explicit sorting before the page limit, preserving compatibility filters',async()=>{
  const fn=source.slice(source.indexOf('async function searchCurseForgeMods('),source.indexOf('async function curseForgeModFiles('));
  let request;
  const context={URLSearchParams,CURSEFORGE_LOADER_ID:6,CURSEFORGE_GAME_ID:432,CURSEFORGE_MINECRAFT_CLASS_ID:6,CURSEFORGE_MC_VERSION:'26.3',curseForgeFetch:async url=>{request=new URL(url,'https://api.curseforge.com');return [{id:1,name:'Just Enough Items (JEI)',downloadCount:4},{id:2,name:'Other',downloadCount:400}];}};
  vm.createContext(context);vm.runInContext(fn,context);
  for(const [sort,field,order]of [[undefined,'13','desc'],['downloads-desc','6','desc'],['downloads-asc','6','asc'],['name-asc','4','asc'],['name-desc','4','desc'],['invalid','13','desc']]){
    const result=await context.searchCurseForgeMods('JEI',sort);
    assert.equal(request.searchParams.get('sortField'),field);
    assert.equal(request.searchParams.get('sortOrder'),order);
    assert.equal(request.searchParams.get('searchFilter'),'JEI');
    assert.equal(request.searchParams.get('gameVersion'),'26.3');
    assert.equal(request.searchParams.get('modLoaderType'),'6');
    assert.equal(request.searchParams.get('pageSize'),'24');
    assert.equal(result[0].name,'Just Enough Items (JEI)');
  }
});
test('The browser preserves relevance ranking even when another result has more downloads',()=>{
  const app=fs.readFileSync(path.join(__dirname,'../src/panel/public/app.js'),'utf8');
  const fn=app.slice(app.indexOf('function renderSortedCurseForgeResults()'),app.indexOf('async function searchCurseForgeByUrl('));
  const displayed=[],select={value:'relevance'},results={replaceChildren(){displayed.length=0;},append(x){displayed.push(x);}};
  const context={$:id=>id==='curseForgeSort'?select:results,curseForgeResultsCache:[{name:'Just Enough Items (JEI)',downloads:4},{name:'Other',downloads:400}],renderCurseForgeResult:x=>x};
  vm.createContext(context);vm.runInContext(fn,context);
  context.renderSortedCurseForgeResults();assert.equal(displayed[0].name,'Just Enough Items (JEI)');
  select.value='downloads-desc';context.renderSortedCurseForgeResults();assert.equal(displayed[0].name,'Other');
});
