'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const ignoredDirectory = name => name === 'panel' || name.startsWith('.wolfmc-');
const ignoredFile = name => name === 'session.lock' || name.startsWith('.wolfmc-');

async function inventory(root, update, { game = true, compare } = {}) {
  const files = new Map();
  const dirs = new Map();
  const pending = [];
  const rootStat = await fsp.lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw Error('La raíz de la copia no es una carpeta normal.');
  async function walk(relative) {
    for (const entry of await fsp.readdir(path.join(root, relative), { withFileTypes: true })) {
      const name = entry.name.toLowerCase();
      if ((game && !relative && ignoredDirectory(name)) || (game && ignoredFile(name))) continue;
      const child = path.join(relative, entry.name);
      const file = path.join(root, child);
      const stat = await fsp.lstat(file);
      const key = child.toLowerCase();
      if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) {
        throw Error('La sincronización se detuvo por un enlace o archivo no regular: ' + child);
      }
      if (files.has(key) || dirs.has(key)) throw Error('Hay rutas duplicadas en Windows: ' + child);
      if (stat.isDirectory()) {
        dirs.set(key, child);
        await walk(child);
        continue;
      }
      files.set(key, { relative: child, bytes: stat.size });
      // A different size already proves the destination file must be replaced.
      if (!compare || compare.get(key)?.bytes===stat.size) pending.push({key,file,stat});
    }
  }
  await walk('');
  let next=0;
  const hashes=Array.from({length:Math.min(4,pending.length)},async()=>{
    while(next<pending.length) {
      const {key,file,stat}=pending[next++];
      const digest=crypto.createHash('sha256');
      for await(const block of fs.createReadStream(file))digest.update(block);
      const value=files.get(key);
      const after=await fsp.lstat(file);
      if(!after.isFile()||stat.size!==after.size||stat.mtimeMs!==after.mtimeMs) {
        throw Error('Un archivo cambió durante la lectura: '+value.relative);
      }
      value.hash=digest.digest('hex');
      update?.(stat.size,value.relative);
    }
  });
  const results=await Promise.allSettled(hashes);
  const failure=results.find(result=>result.status==='rejected');
  if(failure)throw failure.reason;
  return { files, dirs };
}

function sameFile(source, destination) {
  return source?.hash && destination && source.bytes === destination.bytes && source.hash === destination.hash;
}

async function preserveDifferences(source, destination, target, recovery) {
  const parked = [];
  async function park(relative) {
    if (parked.some(parent => relative.startsWith(parent + path.sep))) return;
    const preserved = path.join(recovery, relative);
    await fsp.mkdir(path.dirname(preserved), { recursive: true });
    await fsp.rename(path.join(target, relative), preserved);
    parked.push(relative);
  }
  for (const [key, relative] of destination.dirs) {
    if (!source.dirs.has(key)) await park(relative);
  }
  for (const [key, file] of destination.files) {
    if (!sameFile(source.files.get(key), file)) await park(file.relative);
  }
}

function copyWithRobocopy(from, to, exclusions, update) {
  return new Promise((resolve, reject) => {
    const exe = path.join(process.env.WINDIR || 'C:\\Windows', 'System32', 'robocopy.exe');
    const child = spawn(exe, [
      from, to, '/E', '/COPY:DAT', '/DCOPY:DAT', '/XJ', '/XC', '/XN', '/XO', '/R:2', '/W:3',
      '/MT:8', '/Z', '/BYTES', '/NP', '/NDL', '/NJH', '/NJS', '/FP', ...exclusions,
    ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let detail = '', remaining = '';
    const timer = setTimeout(() => child.kill(), 2 * 60 * 60 * 1000);
    child.stdout.on('data', chunk => {
      detail = (detail + chunk).slice(-2500);
      const lines = (remaining + chunk).split(/\r?\n/);
      remaining = lines.pop();
      for (const line of lines) {
        const fields = line.trim().split(/\t+/).map(field => field.trim());
        const file = fields.at(-1);
        const bytes = fields.at(-2);
        if (file && /^\d+$/.test(bytes || '')) update(Number(bytes), file);
      }
    });
    child.stderr.on('data', chunk => { detail = (detail + chunk).slice(-2500); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => {
      clearTimeout(timer);
      if (code === null || code >= 8) reject(Error('Robocopy no terminó correctamente (' + (code ?? 'interrumpido') + '). ' + detail.trim().slice(-700)));
      else resolve();
    });
  });
}

async function syncTree({ from, to, recovery, game = true, progress, confirm }) {
  if (path.resolve(from).toLowerCase() === path.resolve(to).toLowerCase()) throw Error('El origen y el destino son iguales.');
  await fsp.mkdir(to, { recursive: true });
  const describe = phase => {
    let bytes = 0;
    const started = Date.now();
    return (added, file, total = 0) => {
      bytes += added;
      progress({phase, bytes, file, total, mib:bytes / Math.max(0.05, (Date.now() - started) / 1000) / 1048576});
    };
  };
  const source = await inventory(from, describe(game ? 'Leyendo origen' : 'Comprobando Java de origen'), { game });
  const previous = await inventory(to, describe(game ? 'Comparando destino' : 'Comprobando Java de destino'), { game, compare:source.files });
  const pending = new Map([...source.files].filter(([key, file]) => !sameFile(file, previous.files.get(key))));
  const total = [...pending.values()].reduce((size, file) => size + file.bytes, 0);
  const capacity = await fsp.statfs(to).catch(() => null);
  if (capacity && capacity.bavail * capacity.bsize < total) {
    throw Error('El destino no tiene espacio suficiente para conservar los archivos anteriores y escribir los cambios.');
  }
  await confirm();
  await preserveDifferences(source, previous, to, recovery);
  const copy = describe(game ? 'Copiando mundo y mods' : 'Copiando Java');
  const observed = new Set();
  copy(0, '', total);
  const exclusions = game ? ['/XD', path.join(from,'panel'), path.join(to,'panel'), '.wolfmc-*', '/XF','session.lock','.wolfmc-*'] : [];
  await copyWithRobocopy(from, to, exclusions, (_, file) => {
    const key = path.relative(from, file).toLowerCase();
    const copied = pending.get(key);
    if (copied && !observed.has(key)) {
      observed.add(key);
      copy(copied.bytes, copied.relative, total);
    }
  });
  const verify = describe(game ? 'Verificando copia SHA-256' : 'Verificando Java SHA-256');
  const expectedBytes = [...source.files.values()].reduce((size, file) => size + file.bytes, 0);
  const final = await inventory(to, (bytes,file) => verify(bytes,file,expectedBytes), { game });
  for (const [key, file] of source.files) {
    if (!sameFile(file, final.files.get(key))) throw Error('La verificación SHA-256 falló en ' + file.relative);
  }
  if (final.files.size !== source.files.size || final.dirs.size !== source.dirs.size ||
      [...source.dirs.keys()].some(key => !final.dirs.has(key))) throw Error('El contenido final no coincide con el origen.');
  await confirm();
}

module.exports = { syncTree };
