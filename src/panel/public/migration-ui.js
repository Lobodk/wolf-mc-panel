'use strict';

(() => {
  const tools=document.querySelector('.edition-tools');
  if(!tools)return;
  const endpoint='/api/app/native-hosting';
  const button=document.createElement('button');
  button.type='button';
  button.className='edition-help';
  button.textContent='Cambiar PC del servidor';
  tools.append(button);
  const dialog=document.createElement('dialog');
  dialog.className='manager-dialog edition-dialog';
  dialog.setAttribute('aria-labelledby','migrationTitle');
  dialog.innerHTML=[
    '<div class="section-title"><h2 id="migrationTitle">Cambiar PC del servidor</h2><button class="button secondary" data-control="close" type="button">Cerrar</button></div>',
    '<p class="muted" role="status" data-control="owner"></p>',
    '<div data-control="pairing">',
    '<ol><li>Descarga la herramienta del servidor seleccionado. Ábrela en el PC de destino y acepta el aviso de administrador.</li>',
    '<li>En este panel, importa el archivo de vinculación que genera la herramienta.</li></ol>',
    '<div data-control="profileFields"><label class="feature-label">Red local del PC del panel<select data-control="address"></select></label>',
    '<label class="feature-label">Carpeta en el PC de destino (opcional)<input data-control="folder" type="text" maxlength="180" placeholder="D:\\Minecraft\\Servidor"></label></div>',
    '<div class="inline-actions"><button class="button primary" data-control="download" type="button">Descargar herramienta</button>',
    '<button class="button secondary" data-control="import" type="button" hidden>Importar vinculación</button>',
    '<input data-control="receipt" type="file" accept=".json,application/json" hidden></div></div>',
    '<div data-control="linked" hidden><p class="hint">Al cambiar de equipo, Minecraft guarda y apaga el mundo, copia los cambios y verifica el contenido antes de arrancar. Los jugadores se desconectan durante el traslado. El panel permanece en el equipo original.</p>',
    '<div class="inline-actions"><button class="button primary" data-control="move" type="button">Trasladar servidor</button>',
    '<button class="button primary" data-control="retry" type="button" hidden>Reintentar arranque</button>',
    '<button class="button secondary" data-control="check" type="button">Comprobar conexión</button>',
    '<button class="button secondary" data-control="wake" type="button">Encender equipo de destino</button></div></div>',
    '<progress data-control="progress" aria-label="Progreso del traslado" style="width:100%" max="100" hidden></progress>',
    '<p class="hint" role="status" data-control="stage"></p>',
    '<p class="hint" style="overflow-wrap:anywhere" data-control="file"></p>',
    '<p class="hint" role="status" data-control="message"></p>',
  ].join('');
  document.body.append(dialog);
  const control=key=>dialog.querySelector('[data-control="'+key+'"]');
  const number=new Intl.NumberFormat(undefined,{maximumFractionDigits:1});
  const size=bytes=>number.format(bytes/1048576)+' MiB';
  let state=null,poll=null,pending=false,reading=false;
  const keys=['download','import','move','retry','check','wake'];
  function disableActions(value){for(const key of keys)control(key).disabled=value;}
  async function refresh(){
    if(!dialog.open||reading)return;
    reading=true;
    try{
      state=await api(endpoint);
      const other=state.profile&&state.profile.id!==selectedServerId;
      control('pairing').hidden=Boolean(state.linked||other);
      control('linked').hidden=Boolean(!state.linked||other);
      control('profileFields').hidden=Boolean(state.profile);
      control('import').hidden=!state.profile;
      if(!state.profile&&!control('address').options.length){
        for(const item of state.interfaces||[])control('address').add(new Option(item.name+' · '+item.address,item.address));
      }
      const owner=state.owner==='primary'?'PC de destino':'PC del panel';
      control('owner').textContent=other?'El perfil de traslado pertenece a otro servidor. Selecciona ese servidor en Inicio.':
        state.linked?'Copia activa en el '+owner+(state.target?' · Arranques bloqueados durante la copia.':''):
        !selectedServerId?'Abre un servidor desde Inicio para preparar el traslado.':'Vincula un segundo PC Windows de la misma red local.';
      control('move').textContent=state.target?'Reanudar traslado':state.owner==='primary'?'Volver al PC del panel':'Trasladar al PC de destino';
      control('retry').hidden=!state.canRetryStart;
      disableActions(pending||state.running||Boolean(other));
      if(!state.profile)control('download').disabled=!selectedServerId||!control('address').value||pending;
      const job=state.job,bar=control('progress');
      bar.hidden=!job||(!job.running&&!job.ok);
      if(job?.ok)bar.value=100;
      else if(job?.total)bar.value=Math.min(100,100*job.bytes/job.total);
      else bar.removeAttribute('value');
      control('stage').textContent=job?[
        job.stage,job.total?size(job.bytes)+' / '+size(job.total):'',
        job.running&&job.mib>0?number.format(job.mib)+' MiB/s':'',job.error,
      ].filter(Boolean).join(' · '):state.target?'Reanuda el traslado para completar la verificación.':'';
      control('file').textContent=job?.running?job.file||'':'';
    }catch(error){control('message').textContent=error.message;}
    finally{reading=false;}
  }
  async function perform(work){
    if(pending)return;
    pending=true;
    disableActions(true);
    control('message').textContent='';
    try{
      const result=await work();
      if(result?.message)control('message').textContent=result.message;
    }catch(error){control('message').textContent=error.message;}
    finally{pending=false;refresh();}
  }
  function send(action,data={}){
    return api(endpoint+'/'+action,{method:'POST',body:JSON.stringify(data)});
  }
  control('download').addEventListener('click',()=>perform(async()=>{
    if(!state.profile)await send('profile',{id:selectedServerId,controller:control('address').value,replicaFolder:control('folder').value});
    const response=await fetch(endpoint+'/tool',{method:'POST'});
    if(!response.ok)throw Error((await response.json()).error);
    const link=document.createElement('a');
    link.href=URL.createObjectURL(await response.blob());
    link.download='Preparar-WolfMC.cmd';
    link.click();
    setTimeout(()=>URL.revokeObjectURL(link.href),1000);
    return {message:'Abre Preparar-WolfMC.cmd en el otro PC e importa la vinculación que genere.'};
  }));
  control('import').addEventListener('click',()=>control('receipt').click());
  control('receipt').addEventListener('change',()=>{
    const file=control('receipt').files[0];
    control('receipt').value='';
    if(!file)return;
    perform(async()=>{
      if(file.size>8192)throw Error('Selecciona el archivo de vinculación JSON generado por la herramienta.');
      return send('pair',JSON.parse((await file.text()).replace(/^\uFEFF/,'')));
    });
  });
  control('move').addEventListener('click',()=>perform(()=>send('move',{target:state.target||(state.owner==='primary'?'secondary':'primary')})));
  control('retry').addEventListener('click',()=>perform(()=>send('startup')));
  control('wake').addEventListener('click',()=>perform(()=>send('wake')));
  control('check').addEventListener('click',()=>perform(async()=>{
    const result=await send('check');
    return {message:result.computer+' conectado por SSH y SMB cifrado.'};
  }));
  button.addEventListener('click',()=>{disableActions(true);dialog.showModal();refresh();poll=setInterval(refresh,2000);});
  control('close').addEventListener('click',()=>dialog.close());
  dialog.addEventListener('close',()=>clearInterval(poll));
})();
