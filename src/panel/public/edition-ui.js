'use strict';
(() => {
 const make=(tag,text,cls)=>{const el=document.createElement(tag);if(text!==undefined)el.textContent=text;if(cls)el.className=cls;return el;};
 let settings={name:'Wolf MC Panel',icon:''},image='',ready=false;
 function apply(){for(const el of document.querySelectorAll('.brand h1,.login-card h1'))if(el.textContent!==settings.name)el.textContent=settings.name;for(const img of document.querySelectorAll('.brand-mark img'))if(img.getAttribute('src')!==(settings.icon||'/logo.png'))img.src=settings.icon||'/logo.png';document.title=settings.name+' · Panel';}
 const footer=document.querySelector('.sidebar-footer'),tools=make('div',undefined,'edition-tools');
 const help=make('a','Guía y preguntas frecuentes','edition-help');help.href='/help.html';help.id='editionHelp';
 const prefs=make('button','Personalizar el panel','edition-help');prefs.type='button';
 tools.append(help,prefs);footer.prepend(tools);
 const dialog=make('dialog',undefined,'manager-dialog edition-dialog');
 dialog.innerHTML='<div class="section-title"><h2>Personalizar el panel</h2><button id="editionClose" type="button" class="button ghost">Cerrar</button></div><p class="muted">Este nombre y logo identifican el panel. Cada servidor conserva sus propios ajustes.</p><label class="feature-label">Nombre del panel<input id="editionName" type="text" maxlength="60" required></label><label class="feature-label">Logo del panel<input id="editionIconFile" type="file" accept="image/png,image/jpeg,image/webp"></label><p class="hint">La imagen se recorta al centro y se ajusta a 64 × 64 píxeles.</p><img id="editionIconPreview" width="64" height="64" alt="Vista previa del logo"><div class="inline-actions"><button id="editionResetIcon" type="button" class="button secondary">Usar icono predeterminado</button><button id="editionSave" type="button" class="button primary">Guardar personalización</button></div><p id="editionMessage" class="hint" role="status"></p>';
 document.body.append(dialog);const el=id=>document.getElementById(id);
 prefs.addEventListener('click',()=>{el('editionName').value=settings.name;image=settings.icon;el('editionIconPreview').src=image||'/logo.png';el('editionMessage').textContent='';dialog.showModal();});
 el('editionClose').addEventListener('click',()=>dialog.close());
 el('editionResetIcon').addEventListener('click',()=>{image='';el('editionIconPreview').src='/logo.png';});
 el('editionIconFile').addEventListener('change',async()=>{
  const file=el('editionIconFile').files[0];if(!file)return;if(file.size>10*1024*1024){el('editionMessage').textContent='La imagen supera 10 MB.';return;}
  const url=URL.createObjectURL(file);try{const img=new Image();await new Promise((resolve,reject)=>{img.onload=resolve;img.onerror=()=>reject(Error('No se pudo leer la imagen.'));img.src=url;});const canvas=document.createElement('canvas');canvas.width=canvas.height=64;const size=Math.min(img.width,img.height);canvas.getContext('2d').drawImage(img,(img.width-size)/2,(img.height-size)/2,size,size,0,0,64,64);image=canvas.toDataURL('image/png');el('editionIconPreview').src=image;el('editionMessage').textContent='Vista previa preparada. Guarda para aplicarla.';}catch(error){el('editionMessage').textContent=error.message;}finally{URL.revokeObjectURL(url);}
 });
 el('editionSave').addEventListener('click',async()=>{const button=el('editionSave');button.disabled=true;try{settings=await api('/api/app/preferences',{method:'PUT',body:JSON.stringify({name:el('editionName').value,icon:image})});apply();el('editionMessage').textContent=settings.message;}catch(error){el('editionMessage').textContent=error.message;}finally{button.disabled=false;}});
 const heading=document.querySelector('.topbar .brand h1');new MutationObserver(()=>{if(ready)apply();}).observe(heading,{childList:true});
 fetch('/api/app/info').then(r=>{if(!r.ok)throw Error();return r.json();}).then(data=>{settings=data;ready=true;apply();}).catch(()=>{});
 const notice=make('p','Consulta la guía para crear servidores y configurar el acceso al panel.','edition-notice');document.querySelector('.content').prepend(notice);
 document.querySelector('#accessKey').placeholder='Tu contraseña o la clave inicial';document.querySelector('label[for=accessKey]').textContent='Contraseña del panel';document.querySelector('.login-card .muted').textContent='Administra tus servidores de Minecraft desde este equipo.';document.querySelector('.login-card .hint').textContent='La primera vez se abre el archivo de acceso. También está en la carpeta de datos de Wolf MC Panel.';
})();
