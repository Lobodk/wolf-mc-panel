const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const script=fs.readFileSync(path.join(__dirname,'../src/panel/public/welcome-ui.js'),'utf8');
const settle=()=>new Promise(resolve=>setImmediate(resolve));
function page({storage=new Map(),remote={seen:false},blocked=false,viewport={width:1200,height:800},target={left:20,right:236,top:300,bottom:332,width:216,height:32},cardHeight=280}={}){
 const nodes=[],ids=new Map(),events={},timers=new Map();let serial=0;
 function element(tag='div'){
  const handlers={},classes=new Set(),children=[];
  const node={tag,children,style:{},open:false,showCount:0,textContent:'',
   classList:{contains:v=>classes.has(v),add:v=>classes.add(v),remove:v=>classes.delete(v),toggle:(v,active)=>active?classes.add(v):classes.delete(v)},
   append(...items){children.push(...items);},prepend(...items){children.unshift(...items);},
   attributes:{},setAttribute(name,value){node.attributes[name]=value;},addEventListener(type,fn){(handlers[type]??=[]).push(fn);},
   querySelector(selector){const child=element();if(selector==='.tour-card')child.getBoundingClientRect=()=>({height:cardHeight});return child;},getBoundingClientRect(){return target;},
   scrollIntoView(){},showModal(){node.open=true;node.showCount++;},close(){node.open=false;(handlers.close||[]).forEach(fn=>fn());},
   click(){(handlers.click||[]).forEach(fn=>fn());},reset(){}};
  nodes.push(node);return node;
 }
 const tools=element(),content=element(),guide=element('a');guide.href='/help.html';ids.set('editionHelp',guide);
 const get=id=>{if(!ids.has(id))ids.set(id,element());return ids.get(id);};
 const document={body:element('body'),createElement:element,getElementById:get,querySelector:selector=>selector==='.edition-tools'?tools:content,addEventListener(){}};
 const window={panelSession:null,addEventListener:(type,fn)=>{events[type]=fn;}};
 const api=async(route,options={})=>{assert.equal(route,'/api/app/onboarding');if(options.method==='POST')remote.seen=true;return {seen:remote.seen};};
 vm.runInNewContext(script,{document,window,api,URLSearchParams,location:{search:'',host:'panel.test'},innerWidth:viewport.width,innerHeight:viewport.height,
  localStorage:{getItem:key=>{if(blocked)throw Error('Storage unavailable');return storage.get(key)||null;},setItem:(key,value)=>{if(blocked)throw Error('Storage unavailable');storage.set(key,value);}},
  setTimeout:fn=>{const id=++serial;timers.set(id,fn);return id;},clearTimeout:id=>timers.delete(id)});
 const tour=nodes.find(node=>node.className==='welcome-tour');
 return {storage,remote,tour,path:()=>get('tourPath').attributes.d,async auth(loggedIn){get('appView').classList.toggle('hidden',!loggedIn);events['panel-auth']({detail:{loggedIn,session:{instanceId:'test-installation',passwordConfigured:true}}});await settle();},
  runTimers(){for(const [id,fn]of [...timers]){timers.delete(id);fn();}},click:text=>nodes.find(n=>n.textContent===text).click(),dismiss:()=>get('tourDismiss').click()};
}
test('An automatic tour is remembered when shown, even if the user logs out without dismissing it',async()=>{
 const first=page();await first.auth(true);first.runTimers();await settle();assert.equal(first.tour.showCount,1);assert.equal(first.remote.seen,true);
 await first.auth(false);await first.auth(true);first.runTimers();assert.equal(first.tour.showCount,1);
 const reload=page({storage:first.storage,remote:first.remote});await reload.auth(true);reload.runTimers();assert.equal(reload.tour.showCount,0);
});
test('A different browser honors completion on the panel and manual replay remains available',async()=>{
 const browser=page({remote:{seen:true}});await browser.auth(true);browser.runTimers();assert.equal(browser.tour.showCount,0);
 browser.click('Ver primeros pasos');assert.equal(browser.tour.showCount,1);browser.dismiss();
 await browser.auth(false);await browser.auth(true);browser.runTimers();assert.equal(browser.tour.showCount,1);
});
test('Repeated authentication events and signing out cancel pending automatic tours',async()=>{
 const browser=page();const a=browser.auth(true),b=browser.auth(true);await Promise.all([a,b]);
 await browser.auth(false);browser.runTimers();assert.equal(browser.tour.showCount,0);
 await browser.auth(true);browser.runTimers();assert.equal(browser.tour.showCount,1);
});
test('Panel-side completion survives reloads even when browser storage is blocked',async()=>{
 const first=page({blocked:true});await first.auth(true);first.runTimers();await settle();assert.equal(first.remote.seen,true);
 const reload=page({blocked:true,remote:first.remote});await reload.auth(true);reload.runTimers();assert.equal(reload.tour.showCount,0);
});

test('The tour arrow uses the nearest side and monotonic control points on desktop and narrow screens',async()=>{
 for(const options of [{},{viewport:{width:1200,height:800},target:{left:920,right:1136,top:300,bottom:332,width:216,height:32}},{viewport:{width:600,height:800},target:{left:20,right:236,top:80,bottom:112,width:216,height:32}},{viewport:{width:600,height:800},target:{left:20,right:236,top:680,bottom:712,width:216,height:32}}]){
  const browser=page(options);await browser.auth(true);browser.runTimers();
  const points=browser.path().match(/-?\d+(?:\.\d+)?/g).map(Number);assert.equal(points.length,8);
  const horizontal=points[1]===points[7],axis=horizontal?0:1,values=[points[axis],points[axis+2],points[axis+4],points[axis+6]],direction=Math.sign(values[3]-values[0]);
  for(let i=1;i<values.length;i++)assert.ok((values[i]-values[i-1])*direction>=0,'The arrow must not curl backwards');
 }
});
test('A cramped viewport omits the arrow rather than drawing through the tutorial card',async()=>{
 const browser=page({viewport:{width:400,height:300},target:{left:20,right:236,top:100,bottom:132,width:216,height:32},cardHeight:268});
 await browser.auth(true);browser.runTimers();assert.equal(browser.path(),'');
});
