'use strict';
(() => {
 const el=id=>document.getElementById(id),make=(tag,text,cls)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n;};
 const tr=text=>window.WolfI18n?.t(text)||text;
 let cardsSignature='',homeTimer=null,loading=false,inventory=null,versions=null,step=1,editing=null,connectionId=null,compatible=false,compatGeneration=0,watching=false;
 const loaderName=l=>({vanilla:'Vanilla',neoforge:'NeoForge',forge:'Forge',fabric:'Fabric'})[l]||l;
 function home(){location.assign('/');}
 function openServer(id){location.assign('/?server='+encodeURIComponent(id));}
 function textError(id,error){el(id).textContent=typeof error==='string'?error:error.message;}
 function options(target,values,selected){target.replaceChildren(...values.map(v=>{const o=make('option',v.label);o.value=v.value;return o;}));if(selected&&values.some(v=>v.value===selected))target.value=selected;}
 async function removeServer(server){
  if(server.online){showToast('Apaga el servidor antes de eliminarlo.',true);return;}
  if(!window.confirm(`Primera confirmación: ¿eliminar «${server.name}» del panel? Sus archivos se guardarán en «Servidores eliminados» para poder recuperarlos.`))return;
  try{
   const intent=await api('/api/servers/'+server.id+'/delete-intent',{method:'POST',body:'{}'});
   const name=window.prompt(`Segunda confirmación: escribe exactamente el nombre del servidor para eliminarlo:\n${server.name}`);
   if(name===null)return;if(name!==server.name)throw Error('El nombre no coincide. No se ha eliminado ningún servidor.');
   const result=await api('/api/servers/'+server.id,{method:'DELETE',body:JSON.stringify({token:intent.token,name})});
   cardsSignature='';await loadHome();showToast(result.message);
  }catch(error){showToast(error.message,true);}
 }
 function showRename(server){
  const dialog=el('renameServerDialog'),form=el('renameServerForm'),name=el('renameServerName');
  const error=el('renameServerError'),submit=el('renameServerSubmit'),cancel=el('renameServerCancel');
  name.value=server.name;error.textContent='';
  cancel.onclick=()=>dialog.close();
  dialog.oncancel=event=>{if(submit.disabled)event.preventDefault();};
  form.onsubmit=async event=>{
   event.preventDefault();submit.disabled=true;cancel.disabled=true;error.textContent='';
   try{
    await api('/api/servers/'+encodeURIComponent(server.id)+'/name',{method:'PUT',body:JSON.stringify({name:name.value})});
    dialog.close();cardsSignature='';await loadHome();showToast('Nombre actualizado.');
   }catch(e){error.textContent=e.message;}finally{submit.disabled=false;cancel.disabled=false;}
  };
  dialog.showModal();name.select();
 }
 async function toggleAutoStart(server,button){
  button.disabled=true;
  try{
   await api('/api/servers/'+encodeURIComponent(server.id)+'/autostart',{method:'PUT',body:JSON.stringify({enabled:!server.autoStart})});
   cardsSignature='';await loadHome();
   showToast(server.autoStart?'Arranque automático desactivado.':'Arranque automático asignado a '+server.name+'.');
  }catch(error){showToast(error.message,true);}finally{button.disabled=false;}
 }
 async function cloneServer(server,button){
  const name=window.prompt(tr('Nombre del clon. Se copiarán los mods y ajustes y se generará un mundo nuevo.'),(server.name+' - Nuevo comienzo').slice(0,80));
  if(!name?.trim())return;
  button.disabled=true;
  try{
   showToast('Copiando la instalación del servidor…');
   const result=await api('/api/servers/'+server.id+'/clone',{method:'POST',body:JSON.stringify({name})});
   cardsSignature='';showToast(result.message);await loadHome();
  }catch(error){showToast(error.message,true);}finally{button.disabled=false;}
 }
 async function regenerate(server){
  if(!window.confirm(tr('¿Regenerar el mundo de «'+server.name+'»? El terreno, los inventarios y el progreso de misiones empezarán desde cero. El mundo actual se archivará.')))return;
  const base='/api/servers/'+server.id+'/reset-world';
  try{
   const intent=await api(base+'-intent',{method:'POST',body:'{}'});
   const dialog=el('resetWorldDialog'),form=el('resetWorldForm'),name=el('resetWorldName');
   const password=el('resetWorldPassword'),error=el('resetWorldError'),submit=el('resetWorldSubmit');
   form.reset();error.textContent='';el('resetWorldExpected').textContent=intent.name;
   form.onsubmit=async event=>{
    event.preventDefault();
    if(name.value!==intent.name){error.textContent='Escribe el nombre exacto del servidor.';return;}
    submit.disabled=true;el('resetWorldCancel').disabled=true;error.textContent='';
    try{
     const result=await api(base,{method:'POST',body:JSON.stringify({token:intent.token,name:name.value,password:password.value})});
     dialog.close();showToast(result.message);
    }catch(e){error.textContent=e.message;}finally{password.value='';submit.disabled=false;el('resetWorldCancel').disabled=false;}
   };
   el('resetWorldCancel').onclick=()=>dialog.close();
   dialog.oncancel=event=>{if(submit.disabled)event.preventDefault();};
   dialog.onclose=()=>{form.reset();form.onsubmit=null;};
   dialog.showModal();
  }catch(error){showToast(error.message,true);}
 }
 async function loadHome(){
  if(loading||document.hidden)return;loading=true;
  try{
   inventory=await api('/api/servers');const cards=el('serverCards');const signature=JSON.stringify(inventory.servers);if(signature!==cardsSignature){cardsSignature=signature;cards.replaceChildren();
   for(const server of inventory.servers){
    const card=make('article',undefined,'section-card server-card');const heading=make('div',undefined,'section-title');const title=make('h3',server.name);const badge=make('span',server.busy?'Instalando…':server.online?'En línea':server.status==='failed'?'Instalación fallida':'Apagado','count-pill'+(server.online?' online':''));const nameGroup=make('div',undefined,'server-card-name');
    if(server.hasIcon){const image=make('img',undefined,'server-card-icon');image.width=38;image.height=38;image.alt='';image.src='/api/servers/'+encodeURIComponent(server.id)+'/icon';image.addEventListener('error',()=>image.remove(),{once:true});nameGroup.append(image);}
    nameGroup.append(title);
    if(!server.legacy){
     const pencil=make('button',undefined,'button ghost server-name-edit');pencil.type='button';pencil.disabled=server.busy;
     pencil.title='Editar nombre';pencil.setAttribute('aria-label','Editar nombre de '+server.name);
     pencil.innerHTML='<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m15 5 4 4M4 20l4-.8L20 7l-4-4L4.8 15z"/></svg>';
     pencil.addEventListener('click',()=>showRename(server));nameGroup.append(pencil);
    }
    heading.append(nameGroup,badge);
    const meta=make('p',`${loaderName(server.loader)} · Minecraft ${server.minecraftVersion}${server.loaderVersion?' · '+server.loaderVersion:''}`,'muted');const address=make('code',server.publicAddress,'server-card-address');
    const addressLine=make('div',undefined,'server-address-line');const reveal=make('button',document.body.classList.contains('hide-addresses')?'Mostrar':'Ocultar','button secondary small-button address-reveal');reveal.type='button';reveal.dataset.revealAddress='';reveal.dataset.addressName=server.name;reveal.setAttribute('aria-label','Mostrar dirección de '+server.name);addressLine.append(address,reveal);
    const stats=make('p',`${server.memoryMb/1024} GB RAM máxima${server.legacy?' · Servidor original':''}`,'hint');const buttons=make('div',undefined,'inline-actions');
    const manage=make('button','Administrar','button primary');manage.type='button';manage.disabled=server.status!=='ready'||server.busy;manage.addEventListener('click',()=>openServer(server.id));
    const network=make('button','Conexión','button secondary');network.type='button';network.disabled=server.status!=='ready';network.addEventListener('click',()=>openConnection(server));buttons.append(manage,network);
    if(!server.legacy){const clone=make('button','Clonar servidor','button secondary');clone.type='button';clone.disabled=server.busy||server.status!=='ready';clone.addEventListener('click',()=>cloneServer(server,clone));buttons.append(clone);}
    if(!server.legacy){const platform=make('button','Versión y loader','button ghost');platform.type='button';platform.disabled=server.busy||server.status!=='ready';platform.addEventListener('click',()=>openWizard(server));buttons.append(platform);}
    if(!server.legacy&&server.status==='ready'){
     const auto=make('button',server.autoStart?'Arranque automático · Activo':'Arranque automático','button '+(server.autoStart?'primary':'secondary'));
     auto.type='button';auto.disabled=server.busy;auto.setAttribute('aria-pressed',String(server.autoStart));
     auto.title=server.autoStart?'Desactivar arranque automático':'Activar y sustituir la selección anterior';
     auto.addEventListener('click',()=>toggleAutoStart(server,auto));buttons.append(auto);
    }
    if(server.status==='failed'){const retry=make('button','Reintentar instalación','button secondary');retry.type='button';retry.addEventListener('click',async()=>{try{const data=await api('/api/servers/'+server.id+'/retry',{method:'POST',body:'{}'});watch(data.jobId);}catch(e){showToast(e.message,true);}});buttons.append(retry);}
    const remove=make('button','Eliminar','button danger');remove.type='button';remove.disabled=server.legacy||server.busy;remove.title=server.legacy?'El servidor original contiene el panel y está protegido.':server.online?'Apaga el servidor antes de eliminarlo.':'Eliminar con dos confirmaciones';remove.setAttribute('aria-label','Eliminar '+server.name);remove.addEventListener('click',()=>removeServer(server));buttons.append(remove);
    card.append(heading,meta,addressLine,stats);if(server.error)card.append(make('p',server.error,'error-text'));card.append(buttons);cards.append(card);
   }
   }
   syncAddressRevealButtons();
   el('homeMessage').textContent=`${inventory.servers.length} servidor(es) · ${Math.round(inventory.physicalMemoryMb/1024)} GB de RAM física compartida. Cada servidor utiliza su propio puerto.`;
  }catch(e){textError('homeMessage',e);}finally{loading=false;}
 }
 function beginHome(){stopPolling();if(window.LobodkFeatures)window.LobodkFeatures.activate('home');else window.addEventListener('features-ready',()=>window.LobodkFeatures.activate('home'),{once:true});window.LobodkNetwork?.setActive(false);window.LobodkPlayerTools?.setActive(false);activeView='home';document.body.classList.add('manager-home');document.querySelectorAll('.view').forEach(n=>n.classList.toggle('active',n.id==='view-home'));document.querySelector('.topbar .brand h1').textContent="Wolf MC Panel";document.querySelector('.topbar .brand .eyebrow').textContent='CENTRO DE SERVIDORES';el('breadcrumbCurrent').textContent='Servidores';el('serverStatus').textContent='Panel local';el('serverBadge').classList.remove('checking','online','offline');el('rconNotice').classList.add('hidden');loadHome();clearInterval(homeTimer);homeTimer=setInterval(()=>{if((window.LobodkNavigation?.homeTab()||'servers')==='servers')loadHome();},10000);const saved=sessionStorage.getItem('manager-active-job');if(saved)watch(saved);}
 async function serverContext(){
  try{const data=await api('/api/servers/'+encodeURIComponent(selectedServerId));const s=data.server;el('overviewServerName').textContent=s.name;document.querySelector('.topbar .brand h1').textContent=s.name;document.querySelector('.topbar .brand .eyebrow').textContent=loaderName(s.loader).toUpperCase()+' · '+s.minecraftVersion;document.title=s.name+' · Panel';
   for(const selector of ['.hero-status-strip','.hero-server-badge']){const node=document.querySelector(selector);if(node)node.textContent=loaderName(s.loader)+' · '+s.minecraftVersion;}
   const hero=document.querySelector('.hero-badge');if(hero){const child=hero.querySelector('strong');if(child)child.textContent=loaderName(s.loader)+' · '+s.minecraftVersion;}
   const addresses=document.querySelectorAll('.addresses-card .address-row');for(const [index,address] of [s.localAddress,s.publicAddress].entries()){const row=addresses[index];if(row){row.querySelector('code').textContent=address;row.querySelector('[data-copy]').dataset.copy=address;}}
   el('overviewPort').textContent=String(s.serverPort);
   const platformBadge=document.querySelector('.hero-meta>strong');if(platformBadge)platformBadge.textContent=loaderName(s.loader)+' · '+s.minecraftVersion;
   const reset=el('resetWorldButton');
   reset.hidden=s.legacy;
   reset.classList.toggle('hidden',s.legacy);
   reset.onclick=()=>regenerate(s);
   if(!s.legacy)el('neoForgeCurrent').closest('.section-card').classList.add('hidden');
   if(s.loader==='vanilla'){document.body.classList.add('vanilla-server');el('checkModUpdatesButton').disabled=true;el('updateAllModsButton').disabled=true;el('uploadForm').classList.add('hidden');}
  }catch(e){showToast(e.message,true);}
 }
 function setStep(next){step=next;for(let i=1;i<=3;i++)el('wizardStep'+i).classList.toggle('hidden',i!==step);el('wizardStepLabel').textContent=step===1?'1 · VERSIÓN Y TIPO':step===2?'2 · CONFIGURACIÓN Y CONEXIÓN':'3 · RESUMEN';el('wizardPrevious').disabled=step===1;el('wizardNext').classList.toggle('hidden',step===3);el('wizardSubmit').classList.toggle('hidden',step!==3);el('wizardError').textContent='';}
 function fillVersions(selected){const old=selected||el('wizardVersion').value;let entries=versions.versions.filter(v=>el('wizardSnapshots').checked||v.type==='release');options(el('wizardVersion'),entries.map(v=>({value:v.id,label:v.id+(v.type!=='release'?' · '+v.type:'')})),old||versions.latest.release);}
 async function loadVersions(force=false,selected){el('wizardNext').disabled=true;el('wizardCompatibility').textContent='Consultando el catálogo oficial…';versions=await api('/api/catalog/minecraft'+(force?'?refresh=1':''));fillVersions(selected);await checkCompatibility();}
 async function checkCompatibility(){const generation=++compatGeneration;compatible=false;el('wizardNext').disabled=true;el('wizardCompatibility').textContent='Comprobando compatibilidad…';const version=el('wizardVersion').value,loader=el('wizardLoader').value;el('wizardLoaderVersionLabel').classList.toggle('hidden',loader==='vanilla');
  try{const details=await api('/api/catalog/details?version='+encodeURIComponent(version));let count=0;if(loader!=='vanilla'){const data=await api('/api/catalog/loaders?version='+encodeURIComponent(version)+'&loader='+loader);if(generation!==compatGeneration)return;const rows=[...data.versions.filter(v=>v.stable),...data.versions.filter(v=>!v.stable)];count=rows.length;options(el('wizardLoaderVersion'),rows.map(v=>({value:v.id,label:v.id+(v.stable?'':' · experimental')})),editing?.loader===loader&&editing.minecraftVersion===version?editing.loaderVersion:'');if(!count)throw Error('Este loader no tiene una versión compatible con ese Minecraft. Selecciona otra combinación.');}
   if(generation!==compatGeneration)return;compatible=true;el('wizardCompatibility').textContent=`Minecraft ${version} · Java ${details.javaMajor}${loader==='vanilla'?' · sin mods':` · ${count} versión(es) de ${loaderName(loader)}`}. El catálogo se actualiza desde los proveedores oficiales.`;
  }catch(e){if(generation===compatGeneration)el('wizardCompatibility').textContent=e.message;}finally{if(generation===compatGeneration)el('wizardNext').disabled=!compatible;}}
 async function openWizard(server=null){editing=server;el('wizardTitle').textContent=server?'Versión y loader · '+server.name:'Crear Servidor';el('wizardSubmit').textContent=server?'Preparar cambio con copia':'Crear servidor';el('wizardLoader').value=server?.loader||'vanilla';el('wizardSnapshots').checked=false;el('wizardEula').checked=false;el('wizardBackup').checked=false;el('wizardEulaRow').classList.toggle('hidden',Boolean(server));el('wizardBackupRow').classList.toggle('hidden',!server);setStep(1);el('serverWizard').showModal();
  try{if(!inventory)inventory=await api('/api/servers');for(const option of el('wizardMemory').options)option.disabled=Number(option.value)>inventory.physicalMemoryMb;const port=inventory.suggestedPort||25566;el('wizardPort').value=port;el('wizardExternalPort').value=port;options(el('wizardBind'),[{value:'',label:'Todas las interfaces locales'},{value:'127.0.0.1',label:'Solo este PC · 127.0.0.1'},...inventory.localAddresses.map(ip=>({value:ip,label:ip}))]);await loadVersions(false,server?.minecraftVersion);}catch(e){textError('wizardError',e);}}
 function summary(){const rows=editing?[['Servidor',editing.name],['Nueva versión',el('wizardVersion').value],['Tipo',loaderName(el('wizardLoader').value)],['Loader',el('wizardLoaderVersion').value||'No necesario'],['Copia previa','Se guardará en las copias de este servidor. El servidor debe estar apagado. Los mods existentes deben ser compatibles con la nueva versión.']]:[['Nombre',el('wizardName').value],['Minecraft',el('wizardVersion').value],['Tipo',loaderName(el('wizardLoader').value)],['RAM máxima',Number(el('wizardMemory').value)/1024+' GB'],['Conexión para amigos',el('wizardHost').value+':'+el('wizardExternalPort').value],['Puerto local',el('wizardPort').value]];el('wizardSummary').replaceChildren(...rows.map(([label,value])=>{const row=make('p');row.append(make('strong',label+': '),document.createTextNode(value));return row;}));if(!editing)el('wizardSummary').append(make('p','La regla TCP del router debe reenviar el puerto público al puerto del juego en este PC. Podrás configurarla desde Conexión.','hint'));}
 async function watch(id){if(watching)return;watching=true;sessionStorage.setItem('manager-active-job',id);el('serverInstallProgress').classList.remove('hidden');try{let data;do{data=await api('/api/server-jobs/'+id);el('serverInstallPhase').textContent=data.phase;el('serverInstallBar').value=data.percent||0;el('serverInstallPercent').textContent=Math.round(data.percent||0)+'%';el('serverInstallDetail').textContent=data.error||(data.totalBytes?`${formatBytes(data.downloadedBytes||0)} de ${formatBytes(data.totalBytes)}`:'Preparando archivos y configuración…');if(!data.done)await new Promise(r=>setTimeout(r,1000));}while(!data.done);sessionStorage.removeItem('manager-active-job');await loadHome();if(!data.ok)throw Error(data.error||'No se completó la instalación.');if(data.warnings?.length)el('serverInstallDetail').textContent=data.warnings.join(' · ');else el('serverInstallDetail').textContent=(data.networkMessage?data.networkMessage+' ':'')+'Instalación terminada. El servidor queda apagado hasta que lo inicies.';showToast('Servidor preparado. Puedes configurarlo y arrancarlo desde su administración.');}catch(e){textError('serverInstallDetail',e);sessionStorage.removeItem('manager-active-job');}finally{watching=false;}}
 async function submit(e){e.preventDefault();if(step!==3||!compatible)return;const button=el('wizardSubmit');button.disabled=true;try{let data;if(editing){if(!el('wizardBackup').checked)throw Error('Confirma la copia previa.');data=await api('/api/servers/'+editing.id+'/platform',{method:'POST',body:JSON.stringify({minecraftVersion:el('wizardVersion').value,loader:el('wizardLoader').value,loaderVersion:el('wizardLoaderVersion').value,confirmBackup:true})});}else{if(!el('wizardEula').checked)throw Error('Debes leer y aceptar la EULA antes de crear el servidor.');data=await api('/api/servers',{method:'POST',body:JSON.stringify({name:el('wizardName').value,minecraftVersion:el('wizardVersion').value,loader:el('wizardLoader').value,loaderVersion:el('wizardLoaderVersion').value,memoryMb:Number(el('wizardMemory').value),maxPlayers:Number(el('wizardPlayers').value),difficulty:el('wizardDifficulty').value,seed:el('wizardSeed').value,publicHost:el('wizardHost').value,serverPort:Number(el('wizardPort').value),externalPort:Number(el('wizardExternalPort').value),bindAddress:el('wizardBind').value,configureFirewall:el('wizardFirewall').checked,configureUpnp:el('wizardUpnp').checked,acceptEula:el('wizardEula').checked})});}el('serverWizard').close();watch(data.jobId);}catch(error){textError('wizardError',error);}finally{button.disabled=false;}}
 async function loadConnection(){const data=await api('/api/servers/'+connectionId+'/network');el('connectionName').textContent=data.name;el('connectionHost').value=data.publicHost;el('connectionPort').value=data.serverPort;el('connectionExternalPort').value=data.externalPort;options(el('connectionBind'),[{value:'',label:'Todas las interfaces locales'},{value:'127.0.0.1',label:'Solo este PC · 127.0.0.1'},...data.localAddresses.map(ip=>({value:ip,label:ip}))],data.bindAddress);el('connectionRule').textContent=`TCP público ${data.routerRule.wanPort} → ${data.routerRule.lanHost}:${data.routerRule.lanPort}\nDirección para amigos: ${data.publicAddress}`;el('connectionChecks').textContent=`Juego local: ${data.localListening?'escuchando':'apagado o sin escucha'} · DNS: ${data.dnsAddresses.length?'resuelve correctamente':'no resuelve'}. ${data.networkMessage?data.networkMessage+' ':''}${data.message}${data.networkWarnings?.length?' '+data.networkWarnings.join(' '):''}`;el('connectionSave').disabled=data.localListening||data.legacy;el('connectionPort').disabled=data.legacy;el('connectionFirewall').classList.toggle('hidden',data.legacy);el('connectionUpnp').classList.toggle('hidden',data.legacy);}
 async function openConnection(server){connectionId=server.id;el('connectionError').textContent='';el('connectionDialog').showModal();try{await loadConnection();}catch(e){textError('connectionError',e);}}
 el('homeBreadcrumb').addEventListener('click',home);el('homeSidebar').addEventListener('click',home);el('homeRefresh').addEventListener('click',loadHome);el('createServerButton').addEventListener('click',()=>openWizard());el('wizardClose').addEventListener('click',()=>el('serverWizard').close());el('wizardPrevious').addEventListener('click',()=>setStep(editing?1:step-1));
 el('wizardNext').addEventListener('click',()=>{if(step===1&&!compatible)return;if(step===2){for(const id of ['wizardName','wizardPort','wizardExternalPort','wizardHost','wizardPlayers'])if(!el(id).reportValidity())return;}const next=editing?3:step+1;if(next===3)summary();setStep(next);});el('wizardVersion').addEventListener('change',checkCompatibility);el('wizardLoader').addEventListener('change',checkCompatibility);el('wizardSnapshots').addEventListener('change',()=>{fillVersions();checkCompatibility();});el('wizardRefreshVersions').addEventListener('click',()=>loadVersions(true).catch(e=>textError('wizardError',e)));el('serverWizardForm').addEventListener('submit',submit);el('wizardPort').addEventListener('input',()=>{el('wizardExternalPort').value=el('wizardPort').value;});
 el('connectionClose').addEventListener('click',()=>el('connectionDialog').close());el('connectionRefresh').addEventListener('click',()=>loadConnection().catch(e=>textError('connectionError',e)));el('connectionForm').addEventListener('submit',async e=>{e.preventDefault();try{await api('/api/servers/'+connectionId+'/connection',{method:'PUT',body:JSON.stringify({publicHost:el('connectionHost').value,serverPort:Number(el('connectionPort').value),externalPort:Number(el('connectionExternalPort').value),bindAddress:el('connectionBind').value})});await loadConnection();await loadHome();textError('connectionError','Configuración guardada.');}catch(error){textError('connectionError',error);}});
 for(const [id,action] of [['connectionFirewall','firewall'],['connectionUpnp','upnp']])el(id).addEventListener('click',async()=>{el(id).disabled=true;try{const data=await api('/api/servers/'+connectionId+'/'+action,{method:'POST',body:'{}'});textError('connectionError',data.message);}catch(e){textError('connectionError',e);}finally{el(id).disabled=false;}});
 window.LobodkManager={beginHome,serverContext};window.dispatchEvent(new Event('manager-ready'));
})();
