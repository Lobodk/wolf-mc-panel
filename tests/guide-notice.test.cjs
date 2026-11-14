const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const root=path.resolve(__dirname,'../src/panel/public'),settle=()=>new Promise(resolve=>setImmediate(resolve));
function page(remote={seen:false},help=false){
 const ids=new Map(),events={},nodes=[],requests=[];
 function element(){const classes=new Set(),attributes={};const node={textContent:'',href:'',src:'',style:{},append(){},prepend(){},addEventListener(){},reset(){},showModal(){},close(){},setAttribute:(k,v)=>attributes[k]=v,
  getAttribute:key=>key==='href'?node.href:key==='src'?node.src:attributes[key],closest:()=>node,
  classList:{add:v=>classes.add(v),remove:v=>classes.delete(v),contains:v=>classes.has(v),toggle:(v,flag)=>flag?classes.add(v):classes.delete(v)}};
  Object.defineProperty(node,'className',{get:()=>[...classes].join(' '),set:value=>{classes.clear();value.split(/\s+/).forEach(v=>classes.add(v));}});
  Object.defineProperty(node,'id',{get:()=>node._id,set:value=>{node._id=value;ids.set(value,node);}});nodes.push(node);return node;
 }
 const selectors=new Map(),get=id=>{if(!ids.has(id))ids.set(id,element());return ids.get(id);};
 const document={body:element(),getElementById:get,createElement:element,addEventListener:(name,fn)=>events[name]=fn,
  querySelector:selector=>{if(!selectors.has(selector))selectors.set(selector,element());return selectors.get(selector);},querySelectorAll:()=>[]};
 const fetch=async(url,options={})=>{requests.push({url,options});if(url==='/api/app/guide'){remote.seen=true;return {ok:true,json:async()=>({seen:true})};}assert.equal(url,'/api/app/info');return {ok:true,json:async()=>({name:'Test panel',icon:'',guideSeen:remote.seen})};};
 vm.runInNewContext(fs.readFileSync(path.join(root,help?'help-ui.js':'edition-ui.js'),'utf8'),{document,fetch,URL,URLSearchParams,location:{href:'http://panel.test/?server=main',origin:'http://panel.test',search:'?server=main'},MutationObserver:class{observe(){}}});
 return {remote,requests,notice:()=>get('guideNotice'),back:()=>document.querySelector('.help-page > a'),click(href='/help.html?server=main',button=0){const target=element();target.href=href;events[button===1?'auxclick':'click']({target,button});}};
}
test('Opening the guide hides its reminder immediately and keeps it hidden on a new page',async()=>{
 const first=page();await settle();assert.equal(first.notice().classList.contains('hidden'),false);
 first.click();assert.equal(first.notice().classList.contains('hidden'),true);await settle();assert.equal(first.remote.seen,true);
 assert.equal(first.requests.find(r=>r.url==='/api/app/guide').options.keepalive,true);
 const reload=page(first.remote);await settle();assert.equal(reload.notice().classList.contains('hidden'),true);
});
test('Middle-clicking the internal guide counts, while external guide links do not',async()=>{
 const browser=page();await settle();browser.click('https://unrelated.example/help.html');assert.equal(browser.remote.seen,false);
 browser.click('/help.html',1);await settle();assert.equal(browser.remote.seen,true);assert.equal(browser.notice().classList.contains('hidden'),true);
});
test('A direct guide visit acknowledges it without losing the selected server return address',async()=>{
 const remote={seen:false},guide=page(remote,true);await settle();assert.equal(remote.seen,true);assert.equal(guide.back().href,'/?server=main');
 const panel=page(remote);await settle();assert.equal(panel.notice().classList.contains('hidden'),true);
});
