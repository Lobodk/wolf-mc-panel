/* LAN panel network telemetry. Throughput belongs to the host adapter, not just Java. */
(() => {
  'use strict';
  const el=id=>document.getElementById(id);
  const finite=n=>typeof n==='number'&&Number.isFinite(n);
  const decimals=(n,d=1)=>finite(n)?n.toLocaleString('es-ES',{minimumFractionDigits:d,maximumFractionDigits:d}):'—';
  const ms=n=>!finite(n)?'—':n<1?'<1 ms':decimals(n,0)+' ms';
  const mbps=n=>finite(n)?decimals(n*8/1e6,2)+' Mbps':'Midiendo…';
  const bytes=n=>finite(n)?formatBytes(n):'—';
  let active=false,timer=null,busy=false;
  function text(id,value){el(id).textContent=value;}
  function state(label,type='neutral'){text('networkState',label);el('networkState').dataset.state=type;}
  function clearLive(message){
    ['netDownload','netUpload','netInternet','netPlayerAverage','netRouterPing','netInternetJitter','netProbeLoss','netLinkUsage','netTcpCount','netMspt','netTps'].forEach(id=>text(id,'—'));
    el('networkPlayers').replaceChildren();
    const tr=document.createElement('tr'),td=document.createElement('td');td.colSpan=5;td.className='network-empty';td.textContent=message;tr.append(td);el('networkPlayers').append(tr);
  }
  function drawChart(history){
    const valid=history.filter(s=>finite(s.downloadBytesPerSecond)||finite(s.uploadBytesPerSecond));
    const peak=Math.max(12500,...valid.flatMap(s=>[s.downloadBytesPerSecond||0,s.uploadBytesPerSecond||0]));
    const start=history[0]?.at??0,end=history.at(-1)?.at??start;
    const range=Math.max(5000,end-start);
    const pathFor=key=>{
      let d='',started=false;
      for(const s of history){if(!finite(s[key])){started=false;continue;}
        const x=15+(s.at-start)/range*770,y=160-Math.min(1,s[key]/peak)*140;
        d+=(started?'L':'M')+x.toFixed(1)+','+y.toFixed(1);started=true;}
      return d;
    };
    el('networkDownloadPath').setAttribute('d',pathFor('downloadBytesPerSecond'));
    el('networkUploadPath').setAttribute('d',pathFor('uploadBytesPerSecond'));
    text('networkChartMax',decimals(peak*8/1e6,2)+' Mbps');
    const seconds=Math.max(0,Math.round((end-start)/1000));
    text('networkHistoryLabel',seconds<60?`Registro de ${seconds} s · hasta 10 minutos`:`Registro de ${decimals(seconds/60,1)} min · hasta 10 minutos`);
    text('networkChartEmpty',valid.length<2?'Tomando muestras para la gráfica…':'');
  }
  function renderPlayers(game,online){
    el('networkPlayers').replaceChildren();
    const players=game?.players??[];
    const message=!online?'Minecraft está apagado.':!game?'Sin muestras recientes de Minecraft. Puede estar pausado si no hay jugadores.':!players.length?'No hay jugadores conectados.':null;
    if(message){const tr=document.createElement('tr'),td=document.createElement('td');td.colSpan=5;td.className='network-empty';td.textContent=message;tr.append(td);el('networkPlayers').append(tr);return;}
    for(const p of [...players].sort((a,b)=>b.pingMs-a.pingMs)){
      const tr=document.createElement('tr');
      for(const v of [p.name,ms(p.pingMs),ms(p.averageMs),ms(p.maxMs)]){const td=document.createElement('td');td.textContent=v;tr.append(td);}
      const td=document.createElement('td'),tag=document.createElement('span');tag.className='network-quality';
      tag.dataset.state=p.pingMs<80?'good':p.pingMs<150?'normal':p.pingMs<250?'warning':'bad';
      tag.textContent=p.pingMs<80?'Muy bueno':p.pingMs<150?'Correcto':p.pingMs<250?'Elevado':'Alto';td.append(tag);tr.append(td);el('networkPlayers').append(tr);
    }
  }
  function render(data,httpMs){
    const host=data.host;
    if(data.hostLabel)text('networkHostDescription','Tráfico total del '+data.hostLabel.toLowerCase()+', incluido Minecraft y otras aplicaciones.');
    drawChart(data.history||[]);
    if(!host||data.stale||!host.available){
      state(data.error?'Lectura no disponible':data.stale&&host?'Datos antiguos':'Midiendo…',data.error||host?'warning':'neutral');
      clearLive(host?.reason||data.error||'Esperando la primera muestra de red.');
      text('networkUpdated',host?'Última muestra: '+new Date(host.sampledAt).toLocaleTimeString('es-ES'):'Primera lectura en unos segundos');
      return;
    }
    state('Telemetría en vivo','good');
    text('networkUpdated','Actualizado '+new Date(host.sampledAt).toLocaleTimeString('es-ES')+' · cada 5 s');
    text('netDownload',mbps(host.rates?.downloadBytesPerSecond));
    text('netUpload',mbps(host.rates?.uploadBytesPerSecond));
    text('netDownloadDetail',bytes(host.sessionReceivedBytes)+' desde inicio del registro');
    text('netUploadDetail',bytes(host.sessionSentBytes)+' desde inicio del registro');
    text('netInternet',host.internetProbe?.success?ms(host.internetProbe.ms):'Sin respuesta ICMP');
    text('netRouterPing',host.gatewayProbe?.success?ms(host.gatewayProbe.ms):'Sin respuesta ICMP');
    text('netPanelRtt',ms(httpMs));
    text('netInternetJitter',ms(data.probes.internet.variationMs));
    text('netProbeLoss',data.probes.internet.samples?`${data.probes.internet.unanswered}/${data.probes.internet.samples} (${decimals(data.probes.internet.unansweredPercent,0)} %)`:'Midiendo…');
    const players=host.game?.players??[];
    text('netPlayerAverage',players.length?ms(players.reduce((sum,p)=>sum+p.pingMs,0)/players.length):'—');
    text('netPlayerDetail',!host.game?'Sin muestras recientes del juego':players.length?`${players.length} jugadores · RTT de Minecraft`:'Sin jugadores conectados');
    text('netTcpCount',String(host.gameConnections));
    text('netAdapterName',host.adapter.name+' · '+host.adapter.type);
    text('netLocalIp',host.adapter.addresses.join(' · '));text('netGateway',host.adapter.gateway);
    text('netLinkSpeed',host.adapter.linkBitsPerSecond>0?decimals(host.adapter.linkBitsPerSecond/1e6,0)+' Mbps':'No disponible');
    const usage=host.rates&&host.adapter.linkBitsPerSecond>0?100*8*Math.max(host.rates.downloadBytesPerSecond,host.rates.uploadBytesPerSecond)/host.adapter.linkBitsPerSecond:null;
    text('netLinkUsage',finite(usage)?decimals(usage,2)+' %':'Midiendo…');
    text('netAdapterTotals',bytes(host.counters.receivedBytes)+' ↓ / '+bytes(host.counters.sentBytes)+' ↑');
    text('netPackets',host.rates?`${decimals(host.rates.receivedPacketsPerSecond,0)} ↓ / ${decimals(host.rates.sentPacketsPerSecond,0)} ↑ paquetes/s`:'Midiendo…');
    text('netErrors',`${decimals(host.counters.receiveErrors,0)} entrada / ${decimals(host.counters.sendErrors,0)} salida`);
    text('netDiscards',`${decimals(host.counters.receiveDiscards,0)} entrada / ${decimals(host.counters.sendDiscards,0)} salida`);
    text('netRetransmits',`${decimals(host.counters.tcpRetransmitted,0)} acumulados · ${host.rates?decimals(host.rates.tcpRetransmitsPerSecond,2):'—'}/s`);
    text('netMspt',finite(host.game?.mspt)?decimals(host.game.mspt,1)+' ms':'—');
    text('netTps',finite(host.game?.observedTps)?decimals(host.game.observedTps,1)+' / 20':'—');
    renderPlayers(host.game,host.gameListening);
  }
  async function load(){
    if(!active||busy||document.hidden)return;
    busy=true;const started=performance.now();
    try{const data=await api('/api/network');if(active)render(data,performance.now()-started);}
    catch(e){if(active){state('Sin respuesta','bad');clearLive(e.message);}}
    finally{busy=false;}
  }
  function setActive(value){
    active=Boolean(value);clearInterval(timer);timer=null;
    if(active){load();timer=setInterval(load,5000);}
  }
  window.LobodkNetwork={setActive,refresh:load};
  el('refreshNetworkButton').addEventListener('click',load);
  document.addEventListener('visibilitychange',()=>{if(!document.hidden&&active)load();});
})();
