'use strict';
(() => {
  const M=window.LobodkMotdModel, el=id=>document.getElementById(id);
  const raw=el('featureMotd'); if(!raw || !M)return;
  const fonts=M.letterStyles;
  const palettes=[{name:'Azul claro',colors:['#69c6f0','#d5f4ff']},{name:'Aurora',colors:['#68f2b1','#7ecdf7','#c8a4ff']},{name:'Fuego',colors:['#ff7657','#ffd66b']},{name:'Bosque',colors:['#228b22','#b9ef72']}];
  let provider='Minecraft',loaded=false,original='',originalEditor=null,active=0,lines=[],saving=false,icon='',draftError='';
  const make=(tag,text,cls)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n;};
  function decode(definition){const previous=lines;draftError='';lines=raw.value.split('\n').map((line,i)=>M.restoreLine(line,provider,definition?.lines?.[i])||M.restoreLine(line,provider,M.lineDefinition(previous[i]))||M.read(line,provider));while(lines.length<2){const i=lines.length;lines.push(M.restoreLine('',provider,definition?.lines?.[i])||M.read('',provider));}}
  function textStatus(text,error=false){el('motdSaveStatus').textContent=text;el('motdSaveStatus').classList.toggle('error-text',error);}
  function dirty(){return loaded&&raw.value!==original;}
  function updateState(){
    const tooLong=raw.value.length>500,tooMany=raw.value.split('\n').length>2;
    const invalid=tooLong||tooMany||Boolean(draftError);
    el('motdCodeCount').textContent=raw.value.length+' / 500 caracteres de formato';
    el('motdCodeCount').classList.toggle('error-text',invalid);
    el('motdSave').disabled=!loaded||saving||!dirty()||invalid;
    el('motdUndo').disabled=!loaded||saving||!dirty();
    el('motdDraftState').textContent=draftError|| (invalid?(tooMany?'Usa como máximo dos líneas.':'El diseño supera el límite de 500 caracteres.') : dirty()?'Cambios sin guardar':'Diseño guardado');
    el('motdDraftState').classList.toggle('error-text',invalid);
  }
  function preview(){
    for(let i=0;i<2;i++){
      const target=el('motdPreviewLine'+i);target.replaceChildren();
      for(const run of lines[i]?.runs || []) {
        const chars=Array.from(run.text);
        chars.forEach((c,j)=>{
          const n=make('span',c),s=run.style;
          if(s.mode!=='plain')n.style.color=M.atColor(s.colors,chars.length>1?j/(chars.length-1):0);
          n.style.fontWeight=s.bold?'700':'400';n.style.fontStyle=s.italic?'italic':'normal';
          n.style.textDecoration=[s.underlined?'underline':'',s.strikethrough?'line-through':''].filter(Boolean).join(' ')||'none';
          target.append(n);
        });
      }
      if(!target.textContent)target.append(make('span',i===0?'Nombre del servidor':'Segunda línea opcional','motd-preview-placeholder'));
    }
    el('motdPreviewIcon').src=icon||'/logo.png';
    el('motdPreviewNote').textContent=lines.some(l=>!l.supported)?'Vista aproximada. Algunos efectos avanzados se conservan en los códigos.':'Vista aproximada de la lista de Minecraft. La tipografía depende del cliente.';
    updateState();
  }
  function colorControls(){
    const list=el('motdColors');list.replaceChildren();const line=lines[active],mini=provider==='MiniMOTD';
    el('motdColorSection').hidden=!['solid','gradient'].includes(line.mode);
    el('motdAddColor').hidden=line.mode!=='gradient';
    el('motdAddColor').disabled=line.colors.length>=8;
    if(line.mode==='solid'&&!mini){
      const select=make('select');select.setAttribute('aria-label','Color de la línea');
      const names=['Negro','Azul oscuro','Verde oscuro','Turquesa oscuro','Rojo oscuro','Morado','Dorado','Gris','Gris oscuro','Azul','Verde','Turquesa','Rojo','Rosa','Amarillo','Blanco'];
      Object.values(M.palette).forEach((hex,i)=>{const option=make('option',names[i]);option.value=hex;select.append(option);});
      select.value=M.nearestColor(line.colors[0]).hex;select.addEventListener('change',()=>{line.colors=[select.value];commit();});list.append(select);return;
    }
    const colors=line.mode==='solid'?line.colors.slice(0,1):line.colors;
    colors.forEach((hex,i)=>{
      const chip=make('div',undefined,'motd-color-chip'),label=make('label'),input=make('input');
      input.type='color';input.value=hex;input.setAttribute('aria-label','Color '+(i+1));
      label.append(input,make('span',hex.toUpperCase()));
      input.addEventListener('input',()=>{line.colors[i]=input.value;label.lastChild.textContent=input.value.toUpperCase();commit();});chip.append(label);
      if(line.mode==='gradient'&&colors.length>2){const remove=make('button','×','motd-remove-color');remove.type='button';remove.setAttribute('aria-label','Quitar color '+(i+1));remove.addEventListener('click',()=>{line.colors.splice(i,1);commit();colorControls();});chip.append(remove);}
      list.append(chip);
    });
  }
  function controls(){
    const line=lines[active];if(!line)return;
    for(let i=0;i<2;i++){el('motdLineTab'+i).setAttribute('aria-selected',String(active===i));el('motdLineTab'+i).tabIndex=active===i?0:-1;el('motdLineTab'+i).classList.toggle('active',active===i);}
    el('motdLineText').value=line.text;
    el('motdLineTextLabel').textContent=active===0?'Nombre que aparecerá en Minecraft':'Descripción de la segunda línea';
    el('motdVisualFields').disabled=!loaded||!line.supported||saving;
    el('motdUnsupported').hidden=line.supported;
    el('motdStyleMode').value=line.mode;
    for(const button of document.querySelectorAll('[data-motd-format]'))button.setAttribute('aria-pressed',String(line[button.dataset.motdFormat]));
    for(const button of document.querySelectorAll('[data-motd-font]')){const font=fonts[Number(button.dataset.motdFont)];button.setAttribute('aria-pressed',String((line.letterStyle||'normal')===font.id));}
    el('motdPaletteSection').hidden=!['solid','gradient'].includes(line.mode);
    for(const button of document.querySelectorAll('[data-motd-palette]'))button.setAttribute('aria-pressed',String(line.colors.join(':')===palettes[Number(button.dataset.motdPalette)].colors.join(':')));
    for(const option of el('motdStyleMode').options)option.disabled=false;
    colorControls();preview();
  }
  function commit(){
    if(!lines[active].supported)return;
    try{
      const next=M.write(lines[active],provider);
      Object.assign(lines[active],{raw:next,runs:M.read(next,provider).runs,supported:true});
      raw.value=lines.map(l=>l.raw).join('\n');
      draftError='';textStatus('');preview();
    }catch(error){draftError=error.message;textStatus(error.message,true);updateState();}
  }
  function load(data){
    provider=data.provider||'Minecraft';original=data.motd;originalEditor=data.editor||null;icon=data.icon||'';loaded=true;raw.value=original;active=0;lines=[];decode(data.editor);
    el('motdProvider').textContent=provider==='MiniMOTD'?'Colores RGB · MiniMOTD':'Colores clásicos · Minecraft';
    el('featureMotdHint').textContent=provider==='MiniMOTD'?'MiniMOTD: admite etiquetas de color, degradados y formato. Si tiene varias variantes, guardar aplica estas dos líneas a todas, con copia previa.':'Minecraft vanilla: el editor genera códigos de sus 16 colores. Arcoíris y degradados se adaptan a esa paleta.';
    el('motdCompatibility').textContent=provider==='MiniMOTD'?'Elige un color, combina un degradado o aplica un arcoíris a esta línea.':'Todas las opciones funcionan en vanilla. Los degradados y el arcoíris se aproximan a sus 16 colores disponibles.';
    el('motdAdvanced').open=lines.some(l=>!l.supported)||lines.length>2;controls();textStatus('');
  }
  for(const [i,font]of fonts.entries()){
    const b=make('button',undefined,'motd-font');b.type='button';b.dataset.motdFont=String(i);b.setAttribute('aria-pressed','false');
    const sample=make('span',M.stylize('Lobo',font.id),'motd-font-sample');b.append(sample,make('span',font.name));
    b.addEventListener('click',()=>{lines[active].letterStyle=font.id;commit();controls();});el('motdFonts').append(b);
  }
  for(const [i,palette]of palettes.entries()){
    const b=make('button',undefined,'motd-palette');b.type='button';b.dataset.motdPalette=String(i);b.setAttribute('aria-pressed','false');
    const swatch=make('span',undefined,'motd-palette-swatch');swatch.style.backgroundImage='linear-gradient(110deg,'+palette.colors.join(',')+')';b.append(swatch,make('span',palette.name));
    b.addEventListener('click',()=>{const line=lines[active];line.colors=line.mode==='solid'?[palette.colors[0]]:[...palette.colors];commit();controls();});el('motdPalettes').append(b);
  }
  for(let i=0;i<2;i++){
    el('motdLineTab'+i).addEventListener('click',()=>{active=i;controls();});
    el('motdLineTab'+i).addEventListener('keydown',event=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;event.preventDefault();active=event.key==='Home'?0:event.key==='End'?1:1-active;controls();el('motdLineTab'+active).focus();});
  }
  el('motdLineText').addEventListener('input',()=>{lines[active].text=el('motdLineText').value;commit();});
  el('motdStyleMode').addEventListener('change',()=>{const line=lines[active];line.mode=el('motdStyleMode').value;if(line.mode==='gradient'&&line.colors.length<2)line.colors.push('#ffffff');if(line.mode==='solid')line.colors=[provider==='MiniMOTD'?line.colors[0]:M.nearestColor(line.colors[0]).hex];commit();controls();});
  for(const button of document.querySelectorAll('[data-motd-format]'))button.addEventListener('click',()=>{const key=button.dataset.motdFormat;lines[active][key]=!lines[active][key];commit();controls();});
  el('motdAddColor').addEventListener('click',()=>{if(lines[active].colors.length>=8)return;lines[active].colors.push('#ffffff');commit();colorControls();});
  el('motdClearFormat').addEventListener('click',()=>{for(const key of M.decorations)lines[active][key]=false;lines[active].letterStyle='normal';commit();controls();});
  raw.addEventListener('input',()=>{decode();controls();textStatus('');});
  el('motdUndo').addEventListener('click',()=>{raw.value=original;decode(originalEditor);controls();textStatus('Se han descartado los cambios sin guardar.');});
  el('motdSave').addEventListener('click',async()=>{
    if(!loaded||saving||draftError||!dirty()||raw.value.length>500||raw.value.split('\n').length>2)return;
    const sent=raw.value;saving=true;raw.disabled=true;controls();textStatus('Guardando diseño…');
    try{const result=await api('/api/features/motd',{method:'PUT',body:JSON.stringify({motd:sent,editor:M.definition(lines,provider)})});original=sent;originalEditor=M.definition(lines,provider);window.LobodkFeatures?.motdSaved(sent);textStatus(result.message);}
    catch(error){textStatus(error.message,true);}
    finally{saving=false;raw.disabled=false;controls();}
  });
  new MutationObserver(()=>{const image=el('featureIconPreview');if(image?.getAttribute('src')){icon=image.src;el('motdPreviewIcon').src=icon;}}).observe(el('featureIconPreview'),{attributes:true,attributeFilter:['src']});
  window.LobodkMotdEditor={load,error:error=>{el('motdProvider').textContent='No se pudo cargar';textStatus(error.message+' Vuelve a cargar la página para intentarlo de nuevo.',true);}};
  el('motdVisualFields').disabled=true;updateState();
})();
