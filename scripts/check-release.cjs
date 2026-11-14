'use strict';
const fs=require('node:fs'),path=require('node:path'),{execFileSync}=require('node:child_process');
const root=path.resolve(__dirname,'..'),directories=['src','scripts','installer','tests','docs','assets','.github'];
const forbiddenNames=/^(?:auth|hosting|preferences|installation|address|panel-config|curseforge-config|curseforge-mods|servers|backup-config|network-preconfiguration|managed-process|player-tools-state)\.json$|^(?:panel-access|ACCESS-KEY)\.txt$|\.(?:pem|pfx|key|log)$/i;
let files=0;const errors=[];
function inspect(directory){if(!fs.existsSync(directory))return;for(const entry of fs.readdirSync(directory,{withFileTypes:true})){
 const file=path.join(directory,entry.name),relative=path.relative(root,file);
 if(entry.isSymbolicLink()){errors.push(relative+': symbolic link');continue;}if(entry.isDirectory()){inspect(file);continue;}files++;
 if(forbiddenNames.test(entry.name))errors.push(relative+': private or generated state');
 if(/\.(?:js|cjs)$/.test(file))try{execFileSync(process.execPath,['--check',file],{stdio:'pipe'});}catch{errors.push(relative+': syntax check failed');}
 if(/\.(?:js|cjs|html|css|md|txt|json|yml|yaml|ps1|iss|cs|java)$/.test(file)){
  const text=fs.readFileSync(file,'utf8');
  if(/[a-z]:[\\/]Users[\\/][^\\/\s'"<>]+[\\/]/i.test(text))errors.push(relative+': local user-profile path');
  if(/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(text))errors.push(relative+': private key');
 }
}}
for(const name of directories)inspect(path.join(root,name));
if(!fs.existsSync(path.join(root,'LICENSE')))errors.push('Missing license');
if(errors.length){console.error(errors.join('\n'));process.exitCode=1;}else console.log(JSON.stringify({checkedFiles:files,sourceSyntax:true,privateStateExcluded:true,scope:'source distribution; not a security certification'}));
