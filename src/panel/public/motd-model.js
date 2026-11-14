'use strict';
/* Safe, deliberately limited MiniMessage/legacy reader. Unknown formatting stays raw. */
((root, factory) => {
  const model = factory();
  if (typeof module === 'object' && module.exports) module.exports = model;
  else root.LobodkMotdModel = model;
})(typeof window === 'object' ? window : globalThis, () => {
  const palette = {black:'#000000',dark_blue:'#0000aa',dark_green:'#00aa00',dark_aqua:'#00aaaa',dark_red:'#aa0000',dark_purple:'#aa00aa',gold:'#ffaa00',gray:'#aaaaaa',dark_gray:'#555555',blue:'#5555ff',green:'#55ff55',aqua:'#55ffff',red:'#ff5555',light_purple:'#ff55ff',yellow:'#ffff55',white:'#ffffff'};
  const legacy = Object.entries(palette);
  const aliases = {b:'bold',i:'italic',em:'italic',u:'underlined',underline:'underlined',st:'strikethrough'};
  const decorations = ['bold','italic','underlined','strikethrough'];
  const letterStyles=[{id:'normal',name:'Minecraft clásica'},{id:'wide',name:'Ancha'},{id:'smallcaps',name:'Mayúsculas pequeñas'},{id:'rounded',name:'Redondeada'}];
  function stylize(text,id='normal'){
    if(!letterStyles.some(style=>style.id===id))throw Error('Tipo de letra no válido.');
    const caps=Array.from('ᴀʙᴄᴅᴇꜰɢʜɪᴊᴋʟᴍɴᴏᴘQʀꜱᴛᴜᴠᴡXʏᴢ');
    return Array.from(text,character=>{
      const code=character.codePointAt(0);
      if(id==='wide'&&code>=33&&code<=126)return String.fromCodePoint(code+0xfee0);
      if(id==='smallcaps'&&/[a-z]/i.test(character))return caps[character.toLowerCase().charCodeAt(0)-97];
      if(id==='rounded'){
        if(code>=65&&code<=90)return String.fromCodePoint(0x24b6+code-65);
        if(code>=97&&code<=122)return String.fromCodePoint(0x24d0+code-97);
        if(code>=49&&code<=57)return String.fromCodePoint(0x2460+code-49);
        if(character==='0')return '⓪';
      }
      return character;
    }).join('');
  }
  const rainbow = ['#ff5555','#ffff55','#55ff55','#55ffff','#5555ff','#ff55ff','#ff5555'];
  const blank = () => ({mode:'plain',colors:['#8bd3f5','#ffffff'],bold:false,italic:false,underlined:false,strikethrough:false});
  const color = value => palette[value.toLowerCase()] || (/^#[a-f0-9]{6}$/i.test(value) ? value.toLowerCase() : null);
  const same = (a,b) => a.mode === b.mode && (a.mode === 'plain' || JSON.stringify(a.colors) === JSON.stringify(b.colors)) && decorations.every(key => a[key] === b[key]);
  function read(raw, provider = 'MiniMOTD') {
    raw = String(raw); const mini = provider === 'MiniMOTD';
    let style = blank(), supported = true, stack = [], runs = [];
    function push(text) { if (!text) return; const last = runs.at(-1); if(last && same(last.style,style))last.text += text; else runs.push({text,style:{...style,colors:[...style.colors]}}); }
    for(let at=0;at<raw.length;) {
      if(mini && raw[at] === '\\' && ['\\','<'].includes(raw[at+1])) { push(raw[at+1]);at+=2;continue; }
      if(!mini && raw[at] === '§' && /[0-9a-fklmnor]/i.test(raw[at+1] || '')) {
        const code=raw[at+1].toLowerCase(), n=parseInt(code,16);at+=2;
        if(n>=0 && n<16)style={...blank(),mode:'solid',colors:[legacy[n][1]]};
        else if(code==='r')style=blank();
        else if(code==='k')supported=false;
        else style[{l:'bold',m:'strikethrough',n:'underlined',o:'italic'}[code]]=true;
        continue;
      }
      if(mini && raw[at] === '<') {
        const end=raw.indexOf('>',at+1);
        if(end !== -1) {
          const token=raw.slice(at+1,end).toLowerCase(); const close=token.startsWith('/');
          const parts=(close ? token.slice(1) : token).split(':'); let name=aliases[parts[0]] || parts[0];
          if(name==='reset' && !close){style=blank();stack=[];at=end+1;continue;}
          if(close) {
            const index=stack.map(s=>s.name).lastIndexOf(name);
            if(index<0)supported=false;else {style=stack[index].style;stack=stack.slice(0,index);}
          } else {
            let next={...style};
            if(decorations.includes(name) && (parts.length===1 || parts.length===2 && ['true','false'].includes(parts[1])))next[name]=parts[1]!=='false';
            else if((name==='color'||name==='colour') && parts.length===2 && color(parts[1]))next={...style,mode:'solid',colors:[color(parts[1])]};
            else if(color(name) && parts.length===1)next={...style,mode:'solid',colors:[color(name)]};
            else if(name==='gradient' && parts.length>=3 && parts.slice(1).every(color))next={...style,mode:'gradient',colors:parts.slice(1).map(color)};
            else if(name==='rainbow' && parts.length===1)next={...style,mode:'rainbow',colors:[...rainbow]};
            else supported=false;
            stack.push({name,style});style=next;
          }
          at=end+1;continue;
        }
      }
      const character=String.fromCodePoint(raw.codePointAt(at));push(character);at+=character.length;
    }
    const first=runs[0]?.style || blank();
    if(runs.some(run=>!same(run.style,first)))supported=false;
    return {...first,text:runs.map(run=>run.text).join(''),raw,supported,runs};
  }
  const escape = text => String(text).replace(/\\/g,'\\\\').replace(/</g,'\\<');
  function write(line, provider) {
    const text=stylize(String(line.text).replace(/[\r\n]/g,' '),line.letterStyle||'normal'); if(!text)return '';
    if(provider !== 'MiniMOTD') {
      // Section signs are control characters in legacy messages, not literal text.
      if(/§[0-9a-fklmnorx]/i.test(text))throw Error('Para escribir códigos § utiliza las opciones avanzadas.');
      let format='';
      for(const [key,code] of [['bold','l'],['italic','o'],['underlined','n'],['strikethrough','m']])if(line[key])format+='§'+code;
      if(line.mode==='plain')return '§r'+format+text+'§r';
      const colors=line.mode==='rainbow'?rainbow:line.colors;
      if(!Array.isArray(colors)||!colors.length||!colors.every(color))throw Error('Color no válido.');
      if(line.mode==='solid')return '§r§'+nearestColor(colors[0]).code+format+text+'§r';
      if(!['gradient','rainbow'].includes(line.mode)||colors.length<2)throw Error('Selecciona al menos dos colores válidos.');
      const characters=Array.from(text);let result='§r',previous='';
      characters.forEach((character,index)=>{
        const selected=nearestColor(atColor(colors,index/Math.max(1,characters.length-1))).code;
        // A legacy color resets decorations: repeat them at each color change.
        if(selected!==previous){result+='§'+selected+format;previous=selected;}
        result+=character;
      });
      return result+'§r';
    }
    let result=escape(text);
    for(const key of [...decorations].reverse())if(line[key])result='<'+key+'>'+result+'</'+key+'>';
    let tag='';
    if(line.mode==='solid'){if(!color(line.colors[0]))throw Error('Color no válido.');tag=line.colors[0];}
    if(line.mode==='gradient'){if(line.colors.length<2||!line.colors.every(color))throw Error('Selecciona al menos dos colores válidos.');tag='gradient:'+line.colors.join(':');}
    if(line.mode==='rainbow')tag='rainbow';
    return tag ? '<'+tag+'>'+result+'</'+tag.split(':')[0]+'>' : result;
  }
  function atColor(colors,ratio) {
    if(colors.length===1)return colors[0];
    const pos=Math.max(0,Math.min(1,ratio))*(colors.length-1),i=Math.min(colors.length-2,Math.floor(pos)),t=pos-i;
    const a=colors[i],b=colors[i+1];
    return '#'+[1,3,5].map(n=>Math.round(parseInt(a.slice(n,n+2),16)*(1-t)+parseInt(b.slice(n,n+2),16)*t).toString(16).padStart(2,'0')).join('');
  }
  function nearestColor(value){
    const hex=color(value);if(!hex)throw Error('Color no válido.');
    const rgb=s=>[1,3,5].map(at=>parseInt(s.slice(at,at+2),16));
    const target=rgb(hex);let best=0,distance=Infinity;
    legacy.forEach(([,candidate],index)=>{const d=rgb(candidate).reduce((sum,n,i)=>sum+(n-target[i])**2,0);if(d<distance){distance=d;best=index;}});
    return {code:best.toString(16),hex:legacy[best][1]};
  }
  function lineDefinition(line){
    if(!line?.supported)return null;
    return {text:line.text,letterStyle:line.letterStyle||'normal',mode:line.mode,colors:[...line.colors],...Object.fromEntries(decorations.map(key=>[key,Boolean(line[key])]))};
  }
  function restoreLine(raw,provider,definition){
    if(!definition||typeof definition.text!=='string'||definition.text.length>500||/[\r\n\x00-\x1f]/.test(definition.text)||!['plain','solid','gradient','rainbow'].includes(definition.mode)||!Array.isArray(definition.colors)||definition.colors.length<1||definition.colors.length>8||!definition.colors.every(v=>typeof v==='string'&&Boolean(color(v)))||decorations.some(key=>typeof definition[key]!=='boolean'))return null;
    if(!letterStyles.some(style=>style.id===(definition.letterStyle||'normal')))return null;
    const model={...blank(),text:definition.text,letterStyle:definition.letterStyle||'normal',mode:definition.mode,colors:definition.colors.map(color),...Object.fromEntries(decorations.map(key=>[key,definition[key]]))};
    try{if(write(model,provider)!==raw)return null;}catch{return null;}
    return {...model,raw,runs:read(raw,provider).runs,supported:true};
  }
  function definition(lines,provider){return {version:1,lines:lines.slice(0,2).map(line=>{const data=lineDefinition(line);return data&&provider&&typeof line.raw==='string'&&!restoreLine(line.raw,provider,data)?null:data;})};}
  function validateDefinition(raw,provider,data){
    if(!data||data.version!==1||!Array.isArray(data.lines)||data.lines.length!==2)return null;
    const lines=raw.split('\n');while(lines.length<2)lines.push('');if(lines.length>2)return null;
    const restored=data.lines.map((entry,index)=>entry===null?null:restoreLine(lines[index],provider,entry));
    if(data.lines.some((entry,index)=>entry!==null&&!restored[index]))return null;
    return {version:1,lines:restored.map(line=>line?lineDefinition(line):null)};
  }
  return {palette,decorations,blank,read,write,atColor,nearestColor,rainbow,lineDefinition,restoreLine,definition,validateDefinition,letterStyles,stylize};
});
