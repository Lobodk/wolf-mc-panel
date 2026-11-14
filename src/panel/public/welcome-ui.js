'use strict';
(() => {
 const make=(tag,text,cls)=>{const n=document.createElement(tag);if(text)n.textContent=text;if(cls)n.className=cls;return n;};
 const tools=document.querySelector('.edition-tools'),guide=document.getElementById('editionHelp');
 if(!tools||!guide)return;
 const server=new URLSearchParams(location.search).get('server');if(server)guide.href='/help.html?server='+encodeURIComponent(server);
 const security=make('button','Seguridad y contraseña','edition-help'),replay=make('button','Ver primeros pasos','edition-help');security.type=replay.type='button';tools.append(security,replay);
 const banner=make('div',undefined,'password-banner hidden');banner.append(make('span','Personaliza tu acceso: sustituye la clave inicial por tu propia contraseña.'));
 const setup=make('button','Crear mi contraseña','button secondary');setup.type='button';banner.append(setup);document.querySelector('.content').prepend(banner);
 const passwordDialog=make('dialog',undefined,'manager-dialog edition-dialog security-dialog');
 passwordDialog.setAttribute('aria-labelledby','passwordTitle');passwordDialog.innerHTML='<form id="passwordForm"><div class="section-title"><h2 id="passwordTitle">Seguridad y contraseña</h2><button id="passwordClose" type="button" class="button ghost">Cerrar</button></div><p class="muted">Elige tu contraseña para esta instalación. Se guarda protegida en este PC. La clave inicial dejará de servir para entrar.</p><label class="feature-label">Contraseña o clave actual<input id="passwordCurrent" type="password" autocomplete="current-password" required></label><label class="feature-label">Nueva contraseña<input id="passwordNew" type="password" autocomplete="new-password" minlength="12" maxlength="128" required aria-describedby="passwordHint"></label><p id="passwordHint" class="hint">Entre 12 y 128 caracteres. Puedes utilizar una frase fácil de recordar.</p><label class="feature-label">Repite la nueva contraseña<input id="passwordRepeat" type="password" autocomplete="new-password" minlength="12" maxlength="128" required></label><button id="passwordSave" class="button primary" type="submit">Guardar contraseña</button><p id="passwordMessage" role="status" class="hint"></p></form>';
 document.body.append(passwordDialog);const el=id=>document.getElementById(id);
 function openPassword(){el('passwordForm').reset();el('passwordMessage').textContent='';passwordDialog.showModal();}
 security.addEventListener('click',openPassword);setup.addEventListener('click',openPassword);
 el('passwordClose').addEventListener('click',()=>passwordDialog.close());passwordDialog.addEventListener('close',()=>el('passwordForm').reset());
 el('passwordForm').addEventListener('submit',async event=>{
  event.preventDefault();const button=el('passwordSave');el('passwordMessage').textContent='';
  if(el('passwordNew').value!==el('passwordRepeat').value){el('passwordMessage').textContent='Las contraseñas nuevas no coinciden.';return;}
  button.disabled=true;
  try{const result=await api('/api/app/password',{method:'PUT',body:JSON.stringify({current:el('passwordCurrent').value,password:el('passwordNew').value})});window.panelSession={...window.panelSession,passwordConfigured:true};banner.classList.add('hidden');el('passwordForm').reset();el('passwordMessage').textContent=result.message;}
  catch(error){el('passwordMessage').textContent=error.message;}finally{button.disabled=false;}
 });
 const tour=make('dialog',undefined,'welcome-tour');tour.setAttribute('aria-labelledby','tourTitle');tour.setAttribute('aria-describedby','tourDescription');
 tour.innerHTML='<svg class="tour-arrow" aria-hidden="true"><defs><marker id="tourArrowHead" markerWidth="10" markerHeight="10" refX="8" refY="5" orient="auto"><path d="M1,1 L9,5 L1,9" fill="none" stroke="currentColor" stroke-width="2"/></marker></defs><path id="tourPath" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" marker-end="url(#tourArrowHead)"/></svg><div class="tour-card"><span class="tour-step">BIENVENIDO · PRIMEROS PASOS</span><h2 id="tourTitle">Tu servidor empieza aquí</h2><p id="tourDescription">En <strong>Guía y preguntas frecuentes</strong> encontrarás cómo crear tu primer servidor, conectar a tus amigos, instalar mods y guardar copias.</p><div class="inline-actions"><a id="tourOpenGuide" class="button primary">Abrir la guía</a><button id="tourDismiss" type="button" class="button secondary">Explorar el panel</button></div><p class="hint">Puedes volver a ver este consejo desde «Ver primeros pasos».</p></div>';
 const spotlight=make('a','Guía y preguntas frecuentes','tour-spotlight');tour.append(spotlight);document.body.append(tour);
 let tourKey='',tourTimer=null,authGeneration=0,seenInMemory=false,remoteSeen=false,markPending=null;function seen(){if(seenInMemory)return true;try{return localStorage.getItem(tourKey)==='done';}catch{return false;}}
 function markSeen(){seenInMemory=true;try{localStorage.setItem(tourKey,'done');}catch{}if(remoteSeen||markPending)return;markPending=api('/api/app/onboarding',{method:'POST',body:'{}'}).then(()=>{remoteSeen=true;}).catch(()=>{}).finally(()=>{markPending=null;});}
 function position(){
  if(!tour.open)return;const r=guide.getBoundingClientRect(),card=tour.querySelector('.tour-card'),margin=16,gap=52;
  spotlight.style.left=r.left+'px';spotlight.style.top=r.top+'px';spotlight.style.width=r.width+'px';spotlight.style.height=r.height+'px';
  const width=Math.min(390,innerWidth-margin*2);card.style.width=width+'px';const height=card.getBoundingClientRect().height;
  const clamp=(value,low,high)=>Math.max(low,Math.min(Math.max(low,high),value));let x,y;
  if(r.right+gap+width<=innerWidth-margin){x=r.right+gap;y=clamp((r.top+r.bottom-height)/2,margin,innerHeight-height-margin);}
  else if(r.left-gap-width>=margin){x=r.left-gap-width;y=clamp((r.top+r.bottom-height)/2,margin,innerHeight-height-margin);}
  else{x=clamp((r.left+r.right-width)/2,margin,innerWidth-width-margin);y=r.bottom+gap+height<=innerHeight-margin?r.bottom+gap:r.top-gap-height;y=clamp(y,margin,innerHeight-height-margin);}
  card.style.left=x+'px';card.style.top=y+'px';let a,b,c,d;
  if(x>=r.right+24){a={x:x-8,y:clamp((r.top+r.bottom)/2,y+24,y+height-24)};b={x:r.right+10,y:(r.top+r.bottom)/2};const bend=(a.x-b.x)*.4;c={x:a.x-bend,y:a.y};d={x:b.x+bend,y:b.y};}
  else if(x+width<=r.left-24){a={x:x+width+8,y:clamp((r.top+r.bottom)/2,y+24,y+height-24)};b={x:r.left-10,y:(r.top+r.bottom)/2};const bend=(b.x-a.x)*.4;c={x:a.x+bend,y:a.y};d={x:b.x-bend,y:b.y};}
  else if(y>=r.bottom+24){a={x:clamp((r.left+r.right)/2,x+24,x+width-24),y:y-8};b={x:(r.left+r.right)/2,y:r.bottom+10};const bend=(a.y-b.y)*.4;c={x:a.x,y:a.y-bend};d={x:b.x,y:b.y+bend};}
  else if(y+height<=r.top-24){a={x:clamp((r.left+r.right)/2,x+24,x+width-24),y:y+height+8};b={x:(r.left+r.right)/2,y:r.top-10};const bend=(b.y-a.y)*.4;c={x:a.x,y:a.y+bend};d={x:b.x,y:b.y-bend};}
  el('tourPath').setAttribute('d',a?`M ${a.x} ${a.y} C ${c.x} ${c.y}, ${d.x} ${d.y}, ${b.x} ${b.y}`:'');
 }
 function showTour(){if(tour.open||passwordDialog.open)return;guide.scrollIntoView({block:'nearest'});spotlight.href=guide.href;el('tourOpenGuide').href=guide.href;tour.showModal();markSeen();position();}
 function closeTour(){markSeen();tour.close();}
 replay.addEventListener('click',showTour);el('tourDismiss').addEventListener('click',closeTour);for(const link of [spotlight,el('tourOpenGuide')])link.addEventListener('click',closeTour);
 tour.addEventListener('cancel',markSeen);window.addEventListener('resize',position);document.addEventListener('scroll',position,true);
 async function state(detail){const generation=++authGeneration;clearTimeout(tourTimer);tourTimer=null;const loggedIn=detail?.loggedIn;banner.classList.toggle('hidden',!loggedIn||Boolean(detail.session?.passwordConfigured));if(!loggedIn){if(tour.open)tour.close();if(passwordDialog.open)passwordDialog.close();return;}tourKey='lobo-first-steps-v1:'+(detail.session?.instanceId||location.host);if(seen()){markSeen();return;}try{const saved=await api('/api/app/onboarding');if(generation!==authGeneration)return;if(saved.seen){remoteSeen=true;markSeen();return;}}catch{}if(generation!==authGeneration||seen())return;tourTimer=setTimeout(()=>{tourTimer=null;if(generation===authGeneration&&!seen()&&!document.getElementById('appView').classList.contains('hidden'))showTour();},300);}
 window.addEventListener('panel-auth',event=>state(event.detail));if(window.panelSession)state({loggedIn:true,session:window.panelSession});
})();
