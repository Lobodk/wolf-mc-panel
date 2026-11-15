'use strict';
(() => {
 const el=id=>document.getElementById(id);
 let active=false,timer=null,loading=false,busy=false,lastState=null;
 const labels={give:'Dar objetos','xp-add':'Añadir niveles','xp-set':'Fijar niveles',heal:'Curar',feed:'Comida',kill:'Matar',gamemode:'Modo de juego','teleport-player':'TP a jugador','teleport-position':'TP a coordenadas','teleport-death':'TP a muerte',jumpscare:'Jumpscare',herobrine:'Herobrine',sound:'Sonido','restore-graves':'Lápidas'};
 function node(tag,text,cls){const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n;}
 function createItemPicker({input,list,status,selection,hidden,picker,request,onChange}){
  let matches=[],chosen=null,highlight=-1,requestVersion=0,controller=null,debounce=null,focused=false;
  const validItem=item=>item&&typeof item.name==='string'&&item.name.length>0&&typeof item.id==='string'&&/^[a-z0-9_.-]+:[a-z0-9_./-]+$/.test(item.id)&&item.id.length<=160;
  function selectedItem(){return chosen&&input.value===chosen.name?chosen:null;}
  function close(){list.hidden=true;input.setAttribute('aria-expanded','false');input.removeAttribute('aria-activedescendant');highlight=-1;}
  function notify(){hidden.value=selectedItem()?.id||'';onChange?.(selectedItem());}
  function invalidate(){chosen=null;hidden.value='';selection.textContent='Selecciona un objeto de los resultados.';notify();}
  function setHighlight(index){
   if(!matches.length)return;
   highlight=(index+matches.length)%matches.length;
   for(let i=0;i<list.children.length;i++)list.children[i].setAttribute('aria-selected',String(i===highlight));
   const row=list.children[highlight];input.setAttribute('aria-activedescendant',row.id);row.scrollIntoView?.({block:'nearest'});
  }
  function choose(index){
   const item=matches[index];if(!item)return;
   chosen={...item};input.value=item.name;selection.textContent=`Seleccionado: ${item.name} · ${item.id}`;close();notify();
  }
  function render(){
   list.replaceChildren();
   for(let index=0;index<matches.length;index++){
    const item=matches[index];const row=node('div',undefined,'tools-item-option');row.id='tools-item-option-'+index;row.setAttribute('role','option');row.setAttribute('aria-selected','false');
    const title=node('strong',item.name);const detail=node('span',item.modName||item.id.split(':')[0],'tools-item-mod');const id=node('small',item.id,'tools-item-id');
    row.append(title,detail,id);row.addEventListener('mousedown',e=>e.preventDefault());row.addEventListener('click',()=>choose(index));list.append(row);
   }
   list.hidden=!focused||matches.length===0;input.setAttribute('aria-expanded',String(!list.hidden));
   if(!list.hidden)setHighlight(0);
  }
  function describe(data,showResults){
   const total=Number(data.total)||0;
   let text=data.available===false?(data.message||'El catálogo todavía no está disponible. Reinicia el servidor para generarlo.')
    :showResults?(total?`${total.toLocaleString('es-ES')} coincidencia(s)${total>matches.length?' · mostrando '+matches.length+'; concreta la búsqueda':''}.`:'No hay objetos con ese nombre. Prueba otra palabra o el nombre del mod.')
    :'Busca por nombre, encantamiento, mod o identificador.';
   if(data.pendingRestart)text+=' Hay cambios de mods pendientes: el catálogo se renovará cuando reinicies Minecraft.';
   if(data.available!==false&&data.message&&!data.pendingRestart)text+=' '+data.message;
   status.textContent=text;
   status.classList.toggle('tools-item-warning',Boolean(data.pendingRestart)||data.available===false);
  }
  async function search(showResults=focused){
   clearTimeout(debounce);controller?.abort();controller=new AbortController();const version=++requestVersion;const query=input.value.trim();
   if(showResults)status.textContent='Buscando objetos del servidor…';
   try{
    const language=window.WolfI18n?.getLanguage?.()||document.documentElement.lang||'es';
    const data=await request('/api/items?q='+encodeURIComponent(query)+'&limit=40&language='+encodeURIComponent(language),{signal:controller.signal});
    if(version!==requestVersion)return;
    matches=(data.items||[]).filter(validItem);describe(data,showResults);
    if(showResults)render();else close();
   }catch(error){if(version!==requestVersion||error.name==='AbortError')return;matches=[];close();status.textContent=error.message||'No se pudo consultar el catálogo.';status.classList.add('tools-item-warning');}
  }
  input.addEventListener('input',()=>{
   invalidate();requestVersion++;controller?.abort();matches=[];close();clearTimeout(debounce);
   status.textContent='Buscando objetos del servidor…';debounce=setTimeout(()=>search(true),220);
  });
  input.addEventListener('focus',()=>{focused=true;search(true);});
  input.addEventListener('blur',()=>{focused=false;close();});
  input.addEventListener('keydown',e=>{
   if(e.key==='Escape'){e.preventDefault();close();return;}
   if(e.key==='ArrowDown'||e.key==='ArrowUp'){
    e.preventDefault();
    if(!matches.length){search(true);return;}
    const wasClosed=list.hidden;list.hidden=false;input.setAttribute('aria-expanded','true');
    setHighlight(wasClosed?(e.key==='ArrowDown'?0:matches.length-1):highlight+(e.key==='ArrowDown'?1:-1));return;
   }
   if(e.key==='Enter'&&!list.hidden&&matches.length){e.preventDefault();choose(highlight>=0?highlight:0);}
  });
  document.addEventListener('pointerdown',e=>{if(!picker.contains(e.target))close();});
  window.addEventListener('panel-language',()=>{invalidate();matches=[];close();search(focused);});
  return {selectedItem,refresh(){return search(focused);},close};
 }
 const itemPicker=createItemPicker({input:el('toolsItem'),list:el('toolsItemResults'),status:el('toolsItemCatalogStatus'),selection:el('toolsItemSelection'),hidden:el('toolsItemId'),picker:el('toolsItemPicker'),request:api,onChange:item=>{el('toolsGiveButton').disabled=busy||!item;}});
 function selected(){return el('toolsPlayer').value;}
 function result(text,error=false){el('toolsResult').textContent=typeof privateLogText==='function'?privateLogText(text):text;el('toolsResult').classList.toggle('error',error);}
 function refreshSelection(){
  const p=lastState?.players.find(p=>p.name===selected());
  el('toolsPlayerStatus').textContent=!p?'Selecciona un jugador para empezar.':!lastState.ready?'El servidor no responde por RCON.':p.online?'Conectado. Las acciones se aplican en el juego.':'Desconectado. Puedes ver sus muertes o dejar pendiente un efecto.';
 }
 function options(select,players,placeholder){
  const old=select.value;select.replaceChildren(node('option',placeholder));select.firstChild.value='';
  for(const p of players){const option=node('option',p.name+(p.online?' · conectado':' · desconectado'));option.value=p.name;select.append(option);}
  if(players.some(p=>p.name===old))select.value=old;
 }
 function render(data){
  const features=data.features||{graves:true,horror:true};
  el('toolsLoadDeaths').closest('.section-card').classList.toggle('hidden',!features.graves);
  el('toolsWait').closest('.section-card').classList.toggle('hidden',!features.horror);
  lastState=data;options(el('toolsPlayer'),data.players,'Selecciona un jugador…');options(el('toolsDestination'),data.players.filter(p=>p.online),'Jugador de destino…');refreshSelection();
  const jobs=el('toolsJobs');jobs.replaceChildren();
  for(const job of data.jobs.filter(j=>['pending','running','failed'].includes(j.status))){
   const row=node('li',undefined,'player-row');const info=node('div',undefined,'player-info');info.append(node('strong',job.name+' · '+(labels[job.action]||job.action)),node('span',job.status==='pending'?'Esperando conexión · hasta '+new Date(job.expiresAt).toLocaleTimeString('es-ES'):job.status==='failed'?'No se ejecutó: '+(job.error||'Error'):'En ejecución / revisión pendiente'));
   row.append(info);
   if(job.status==='pending'){const button=node('button','Cancelar','button secondary small-button');button.type='button';button.addEventListener('click',()=>perform('/api/player-tools/cancel',{id:job.id}));row.append(button);}
   jobs.append(row);
  }
  if(!jobs.children.length)jobs.append(node('li','No hay acciones pendientes.','empty-row'));
  const history=el('toolsHistory');history.replaceChildren();
  for(const item of data.history.slice(0,12)){const row=node('li',undefined,'player-row');const info=node('div',undefined,'player-info');info.append(node('strong',item.name+' · '+(labels[item.action]||item.action)),node('span',new Date(item.at).toLocaleString('es-ES')+' · '+(item.ok?'Registrada':'No completada')));row.append(info);history.append(row);}
  if(!history.children.length)history.append(node('li','Todavía no hay acciones registradas.','empty-row'));
 }
 async function load(){if(!active||loading||document.hidden)return;loading=true;try{render(await api('/api/player-tools'));}catch(e){result(e.message,true);}finally{loading=false;}}
 function setBusy(value){busy=value;el('view-player-tools').setAttribute('aria-busy',String(value));for(const button of el('view-player-tools').querySelectorAll('button'))button.disabled=value;el('toolsPlayer').disabled=value;el('toolsItem').disabled=value;el('toolsGiveButton').disabled=value||!itemPicker.selectedItem();if(!value)updateRestore();}
 async function perform(route,body){
  if(busy)return;
  setBusy(true);result('Procesando…');
  try{const response=await api(route,{method:'POST',body:JSON.stringify(body)});result(response.message||'Acción completada.');if(active)await load();if(route.endsWith('/restore'))await loadDeaths();}
  catch(e){result(e.message,true);}
  finally{setBusy(false);}
 }
 function action(action,extra={}){if(!selected()){result('Selecciona un jugador.',true);return;}return perform('/api/player-tools/action',{name:selected(),action,quiet:el('toolsQuiet').checked,waitForJoin:el('toolsWait').checked,...extra});}
 function updateRestore(){const count=el('toolsDeaths').querySelectorAll('input[type=checkbox]:checked').length;el('toolsRestore').disabled=busy||count<1||count>2;el('toolsRestore').textContent=count?'Entregar '+count+' lápida(s) seleccionada(s)':'Entregar lápidas seleccionadas';}
 async function loadDeaths(){
  const name=selected();if(!name){result('Selecciona un jugador.',true);return;}
  const area=el('toolsDeaths');area.replaceChildren(node('p','Leyendo las muertes…','muted'));
  try{
   const data=await api('/api/player-tools/deaths?name='+encodeURIComponent(name));
   if(selected()!==name)return;
   area.replaceChildren();
   for(const death of data.deaths){
    const row=node('div',undefined,'tools-death-row');const check=node('input');check.type='checkbox';check.value=death.id;check.id='tools-death-'+death.id;check.disabled=death.restoration==='delivered'||death.stacks===0;check.addEventListener('change',updateRestore);
    const info=node('label',undefined,'tools-death-info');info.htmlFor=check.id;
    info.append(node('strong',new Date(death.timestamp).toLocaleString('es-ES')),node('span',death.stacks+' grupos de objetos · '+death.levels+' niveles · '+(death.restoration==='delivered'?'Ya registrada como entregada':death.restoration==='preparing'?'Preparación pendiente; se puede reintentar':death.dimension)));
    const coords=node('code',`${Math.floor(death.x)}, ${Math.floor(death.y)}, ${Math.floor(death.z)}`,'tool-coordinates');info.append(coords);
    const actions=node('div',undefined,'tools-inline');const tp=node('button','TP a esta muerte…','button secondary small-button');tp.type='button';tp.addEventListener('click',()=>{if(window.confirm('¿Teletransportar a '+name+' a esta muerte? Puede haber lava, enemigos o caída.'))action('teleport-death',{deathId:death.id});});
    const xp=node('button','Recuperar '+death.levels+' niveles…','button secondary small-button');xp.type='button';xp.addEventListener('click',()=>{if(window.confirm('¿Fijar la experiencia de '+name+' en '+death.levels+' niveles? No se suman a los actuales.'))action('xp-set',{amount:death.levels});});
    actions.append(tp,xp);row.append(check,info,actions);area.append(row);
   }
   if(!data.deaths.length)area.append(node('p','No hay muertes guardadas para ese jugador.','muted'));
  }catch(e){area.replaceChildren(node('p',e.message,'error'));}
  updateRestore();
 }
 el('toolsPlayer').addEventListener('change',()=>{refreshSelection();el('toolsDeaths').replaceChildren(node('p','Pulsa «Ver muertes del jugador».','muted'));updateRestore();result('');});
 el('toolsRefresh').addEventListener('click',()=>{load();itemPicker.refresh();});
 el('toolsClearHistory').addEventListener('click',()=>{if(window.confirm('¿Limpiar la lista de últimas acciones de este servidor?'))perform('/api/player-tools/history/clear',{});});
 el('toolsLoadDeaths').addEventListener('click',loadDeaths);
 el('toolsRestore').addEventListener('click',()=>{
  const ids=[...el('toolsDeaths').querySelectorAll('input[type=checkbox]:checked')].map(n=>n.value);
  if(!window.confirm('¿Entregar '+ids.length+' lápida(s) con sus objetos a '+selected()+'? No recuperes también los objetos de las originales.'))return;
  perform('/api/player-tools/restore',{name:selected(),ids,quiet:el('toolsQuiet').checked});
 });
 el('toolsGiveForm').addEventListener('submit',e=>{e.preventDefault();const item=itemPicker.selectedItem();if(!item){result('Busca y selecciona un objeto de la lista antes de entregarlo.',true);el('toolsItem').focus();return;}action('give',{item:item.id,variant:item.variant||'',amount:Number(el('toolsItemAmount').value)});});
 el('toolsXpForm').addEventListener('submit',e=>{e.preventDefault();action('xp-add',{amount:Number(el('toolsXp').value)});});
 el('toolsXpSet').addEventListener('click',()=>{const amount=Number(el('toolsXp').value);if(window.confirm('¿Fijar el total de '+selected()+' en '+amount+' niveles?'))action('xp-set',{amount});});
 el('toolsModeForm').addEventListener('submit',e=>{e.preventDefault();action('gamemode',{mode:el('toolsMode').value});});
 el('toolsTpPlayerForm').addEventListener('submit',e=>{e.preventDefault();action('teleport-player',{destination:el('toolsDestination').value});});
 el('toolsTpPositionForm').addEventListener('submit',e=>{e.preventDefault();if(window.confirm('¿Mover a '+selected()+' a esas coordenadas? Comprueba que sean seguras.'))action('teleport-position',{dimension:el('toolsDimension').value,x:el('toolsX').value,y:el('toolsY').value,z:el('toolsZ').value});});
 el('toolsSoundForm').addEventListener('submit',e=>{e.preventDefault();action('sound',{sound:el('toolsSound').value});});
 el('toolsKill').addEventListener('click',()=>{if(selected()&&window.confirm('¿Matar a '+selected()+' dentro del juego? Perderá su inventario según las reglas normales.'))action('kill',{confirmTarget:selected()});});
 el('view-player-tools').querySelectorAll('[data-tool-action]').forEach(b=>b.addEventListener('click',()=>action(b.dataset.toolAction)));
 document.addEventListener('visibilitychange',()=>{if(!document.hidden&&active){load();itemPicker.refresh();}});
 window.LobodkPlayerTools={setActive(value){const entering=Boolean(value)&&!active;active=Boolean(value);clearInterval(timer);timer=null;if(active){load();if(entering)itemPicker.refresh();timer=setInterval(load,5000);}else itemPicker.close();},refresh:load};
})();
