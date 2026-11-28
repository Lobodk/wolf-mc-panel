'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomBytes, randomUUID } = require('node:crypto');

const ignored = new Set(['config/chunky/tasks', 'config/chunkyborder/borders.json']);
const clonePaths = [
  'mods', 'config', 'defaultconfigs', 'libraries', 'versions', 'moonlight-global-datapacks',
  'server.jar', 'server-icon.png', 'run.bat', 'run.sh', 'eula.txt', 'whitelist.json',
  'ops.json', 'banned-players.json', 'banned-ips.json', 'automodpack/server.conf',
  'automodpack/host-modpack',
];

async function copyTree(source, target, relative) {
  const from = path.join(source, relative);
  const to = path.join(target, relative);
  if (ignored.has(relative.replaceAll('\\', '/'))) return;
  const stat = await fs.lstat(from).catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!stat) return;
  if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) {
    throw Error('No se puede copiar una carpeta enlazada o un archivo especial: ' + relative);
  }
  if (stat.isDirectory()) {
    await fs.mkdir(to, { recursive: true });
    for (const name of await fs.readdir(from)) await copyTree(source, target, path.join(relative, name));
  } else {
    await fs.mkdir(path.dirname(to), { recursive: true });
    await fs.copyFile(from, to);
  }
}

function properties(text, changes) {
  const keys = new Set(Object.keys(changes));
  const lines = text.trimEnd().split(/\r?\n/).filter(line => {
    const key = /^\s*([\w.-]+)\s*[=:]/.exec(line)?.[1];
    return !keys.has(key);
  });
  return [...lines, ...Object.entries(changes).map(([key, value]) => key + '=' + value), ''].join('\n');
}

function worldName(text) {
  const value = /^\s*level-name\s*[=:]\s*(.*?)\s*$/m.exec(text)?.[1] || 'world';
  const reserved = ['mods','config','panel','libraries','versions','logs','backups','automodpack','data','defaultconfigs'];
  if (!/^[\p{L}\p{N}_-][\p{L}\p{N}_ -]{0,79}$/u.test(value) || reserved.includes(value.toLowerCase())) {
    throw Error('La carpeta del mundo debe tener un nombre simple y estar dentro del servidor.');
  }
  return value;
}

async function copyWorldSettings(source, target, world) {
  // Copy the settings directories themselves, never game or player data.
  const sourceWorld = path.join(source, world);
  const stat = await fs.lstat(sourceWorld).catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!stat) return;
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error('La carpeta del mundo no es un directorio normal.');
  for (const rel of ['datapacks','serverconfig']) await copyTree(sourceWorld, path.join(target, world), rel);
}

async function prepareClone(source, target, record, udpPort) {
  const read = rel => fs.readFile(path.join(source,rel),'utf8');
  const json = async rel => JSON.parse(await read(rel));
  const write = (rel,text) => fs.writeFile(path.join(target,rel),text);
  const writeJson = (rel,value) => write(rel,JSON.stringify(value,null,2));
  const props = await read('server.properties');
  await fs.mkdir(target);
  for (const rel of clonePaths) await copyTree(source,target,rel);
  await copyWorldSettings(source,target,worldName(props));
  await fs.mkdir(path.join(target,'panel'),{recursive:true});
  const password = randomBytes(24).toString('base64url');
  await write('server.properties',properties(props,{
    'server-port':record.serverPort,'query.port':record.serverPort,'rcon.port':record.rconPort,
    'rcon.password':password,'level-seed':record.seed,motd:record.name,
  }));
  const jvm = await read('user_jvm_args.txt');
  await write('user_jvm_args.txt',jvm.replace(/^-Xmx[^\r\n]+/m,'-Xmx'+record.memoryMb+'M'));
  const voice = 'config/voicechat/voicechat-server.properties';
  const voiceConfig = await read(voice).catch(error=>{if(error.code!=='ENOENT') throw error; return null;});
  if (voiceConfig) await write(voice,properties(voiceConfig,{port:udpPort,voice_host:''}));
  const launch = await json('panel/launch.json');
  const remap = value => value.replaceAll(source,record.directory);
  launch.args = launch.args.map(remap);
  if (launch.bridgeArg) launch.bridgeArg = remap(launch.bridgeArg);
  await writeJson('panel/launch.json',launch);
  const cfg = await json('panel/panel-config.json');
  await writeJson('panel/panel-config.json',{...cfg,serverPort:record.serverPort,rconPort:record.rconPort,rconPassword:password});
  const bridge = 'panel/registry-agent.properties';
  if (launch.bridgeArg) {
    const escaped = value => value.replaceAll('\\','\\\\');
    await write(bridge,properties((await read(bridge)).replaceAll(escaped(source),escaped(record.directory)),{port:record.rconPort}));
    for (const name of await fs.readdir(path.join(source,'panel'))) {
      if (/^server-mappings-[\w.-]+\.txt$/.test(name)) await copyTree(source,target,path.join('panel',name));
    }
  }
  const features = await json('panel/server-features.json').catch(error=>{if(error.code!=='ENOENT') throw error;return {};});
  if (features.timeCycle) await writeJson('panel/server-features.json',{timeCycle:features.timeCycle});
}

async function regenerateWorld(directory, archive, seed) {
  const config = path.join(directory,'server.properties');
  const stat = await fs.lstat(config);
  if (!stat.isFile() || stat.isSymbolicLink()) throw Error('server.properties debe ser un archivo normal.');
  const original = await fs.readFile(config,'utf8');
  const name = worldName(original);
  const world = path.join(directory,name);
  const statWorld = await fs.lstat(world).catch(error=>{if(error.code!=='ENOENT')throw error;return null;});
  if (!statWorld?.isDirectory() || statWorld.isSymbolicLink()) throw Error('Este servidor todavía no tiene un mundo que se pueda regenerar.');
  const level = await fs.lstat(path.join(world,'level.dat')).catch(error=>{
    if(error.code!=='ENOENT')throw error;
    return null;
  });
  if(!level?.isFile()||level.isSymbolicLink())throw Error('No se encontró el archivo level.dat del mundo.');
  const staged = path.join(directory,'.world-reset-'+randomUUID());
  await fs.mkdir(staged);
  let moved = false, configUpdated = false;
  const movedSettings = [];
  try {
    await copyWorldSettings(directory,staged,name);
    await fs.mkdir(path.join(staged,name),{recursive:true});
    await fs.writeFile(path.join(archive,'server.properties'),original,{flag:'wx'});
    await fs.writeFile(path.join(staged,'server.properties'),properties(original,{'level-seed':seed}),{flag:'wx'});
    for (const rel of ignored) {
      const existing=path.join(directory,rel),saved=path.join(archive,rel);
      await fs.mkdir(path.dirname(saved),{recursive:true});
      try {await fs.rename(existing,saved);movedSettings.push([saved,existing]);}
      catch(error){if(error.code!=='ENOENT')throw error;}
    }
    await fs.rename(world,path.join(archive,'world'));
    moved = true;
    await fs.rename(path.join(staged,'server.properties'),config);
    configUpdated = true;
    await fs.rename(path.join(staged,name),world);
  } catch (error) {
    if (configUpdated) {
      const temporary = path.join(staged,'original.properties');
      await fs.writeFile(temporary,original,{flag:'wx'});
      await fs.rename(temporary,config);
    }
    if (moved) await fs.rename(path.join(archive,'world'),world);
    for (const [saved,existing] of movedSettings.reverse()) await fs.rename(saved,existing);
    throw error;
  } finally {
    if(path.dirname(path.resolve(staged))!==path.resolve(directory))throw Error('Ruta temporal no válida');
    await fs.rm(staged,{recursive:true,force:true}).catch(()=>{});
  }
}
module.exports = {prepareClone,regenerateWorld};
