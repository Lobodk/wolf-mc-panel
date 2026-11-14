'use strict';
(() => {
 const languages={es:'Español',en:'English',de:'Deutsch',fr:'Français',tr:'Türkçe',pt:'Português (Brasil)'},brand=new Set(['Minecraft','NeoForge','Forge','Fabric','CurseForge','Java','AutoModpack','RCON','CPU','RAM','TPS','MSPT','DDNS','Ko-fi','UPnP','PNG','TCP','IP','MOTD','LAN','Wolf MC Panel']);
 const key='wolf-panel-language';let language='es',catalog={},lookup={},patterns=[],scheduled=false,ready=false;
 try{const saved=localStorage.getItem(key);if(languages[saved])language=saved;}catch{}
 const textState=new WeakMap(),attributeState=new WeakMap(),controls=[];
 const excluded='script,style,pre,code,textarea,input,[data-no-i18n],.brand h1,.login-card h1,.motd-font-sample,.motd-preview-content,.mod-display-name,.mod-file-name,.server-card h3,.player-name';
 function translate(value){const normalized=String(value).replace(/\s+/g,' ').trim();if(language==='es'||brand.has(normalized))return value;const dictionary=catalog[language]||{};let result=dictionary[normalized];
  if(!result){const variant=lookup[language]?.get(normalized.toLocaleLowerCase('es'));if(variant)result=normalized===normalized.toLocaleUpperCase('es')?variant.toLocaleUpperCase(language==='pt'?'pt-BR':language):variant;}
  if(!result){for(const pattern of patterns){const match=normalized.match(pattern.regex);if(match&&dictionary[pattern.source]){result=dictionary[pattern.source];pattern.slots.forEach((slot,i)=>{result=result.replaceAll(slot,()=>match[i+1]);});break;}}}
  return result?(value.match(/^\s*/)[0]+result+value.match(/\s*$/)[0]):value;
 }
 function visit(root=document.body){if(!ready||!root)return;const nodes=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);let node;
  while((node=nodes.nextNode())){if(!node.parentElement||node.parentElement.closest(excluded)||!node.data.trim())continue;const old=textState.get(node),original=old&&node.data===old.rendered?old.original:node.data,rendered=translate(original);textState.set(node,{original,rendered});if(node.data!==rendered)node.data=rendered;}
  for(const element of root.querySelectorAll('[placeholder],[aria-label],[title],[alt]')){
   if(element.closest('[data-no-i18n]'))continue;let state=attributeState.get(element);if(!state){state={};attributeState.set(element,state);}
   for(const attr of ['placeholder','aria-label','title','alt']){const value=element.getAttribute(attr);if(!value)continue;const old=state[attr],original=old&&value===old.rendered?old.original:value,rendered=translate(original);state[attr]={original,rendered};if(value!==rendered)element.setAttribute(attr,rendered);}
  }
 }
 function queue(){if(scheduled)return;scheduled=true;requestAnimationFrame(()=>{scheduled=false;visit();});}
 function change(next){if(!languages[next])return;language=next;document.documentElement.lang=next;document.documentElement.style.setProperty('--hidden-address-label',JSON.stringify({es:'Dirección oculta',en:'Address hidden',de:'Adresse ausgeblendet',fr:'Adresse masquée',tr:'Adres gizli',pt:'Endereço oculto'}[next]));for(const control of controls)control.value=next;try{localStorage.setItem(key,next);}catch{}visit();window.dispatchEvent(new CustomEvent('panel-language',{detail:{language:next}}));}
 function picker(parent,before=null){if(!parent)return;const label=document.createElement('label');label.className='language-control';label.dataset.noI18n='';const caption=document.createElement('span');caption.textContent='🌐';caption.setAttribute('aria-hidden','true');const select=document.createElement('select');select.setAttribute('aria-label','Idioma / Language');
  for(const [code,name]of Object.entries(languages)){const option=document.createElement('option');option.value=code;option.textContent=name;select.append(option);}select.value=language;select.addEventListener('change',()=>change(select.value));label.append(caption,select);parent.insertBefore(label,before);controls.push(select);
 }
 const logout=document.getElementById('logoutButton');if(logout)picker(logout.parentElement,logout);
 picker(document.querySelector('.login-card'));const help=document.querySelector('.help-page');if(help)picker(help,help.querySelector('h1'));
 new MutationObserver(queue).observe(document.body,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:['placeholder','title','aria-label','alt']});
 fetch('/locales.json').then(r=>{if(!r.ok)throw Error('Translations unavailable');return r.json();}).then(data=>{catalog=data.languages;lookup=Object.fromEntries(Object.entries(catalog).map(([code,dictionary])=>[code,new Map(Object.entries(dictionary).map(([key,value])=>[key.toLocaleLowerCase('es'),value]))]));const sources=new Set([...Object.keys(catalog.en||{}),...(data.patterns||[])]);patterns=[...sources].filter(s=>/WOLFSLOT\d+/.test(s)&&s.replace(/WOLFSLOT\d+/g,'').trim().length>=8).map(source=>{const slots=[];const expression=source.split(/(WOLFSLOT\d+)/).map(part=>{if(/^WOLFSLOT\d+$/.test(part)){slots.push(part);return '(.*?)';}return part.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');}).join('');return {source,slots,regex:new RegExp('^'+expression+'$')};});ready=true;change(language);}).catch(()=>{ready=true;change('es');});
 window.WolfI18n={t:translate,getLanguage:()=>language,setLanguage:change};
})();
