'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function createModStaging(serverDir, panelDir = path.join(serverDir,'panel')) {
  const mods = path.join(serverDir, 'mods');
  const root = path.join(panelDir, 'pending-mods');
  const manifest = path.join(root, 'manifest.json');
  const journal = path.join(root, 'applying.json');
  const safe = name => typeof name === 'string' && name.length <= 180 && !name.startsWith('.') && !/[\\/\x00-\x1f<>:"|?*]/.test(name) && name.endsWith('.jar');
  const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  function write(file, data) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file + '.tmp', JSON.stringify(data, null, 2));
    fs.renameSync(file + '.tmp', file);
  }
  function list() {
    if (!fs.existsSync(manifest)) return [];
    const entries = JSON.parse(fs.readFileSync(manifest, 'utf8'));
    if (!Array.isArray(entries) || entries.some(e => !safe(e.name) || (e.replaceName && !safe(e.replaceName)) || !/^[a-f0-9-]+\.jar$/.test(e.staged))) throw Error('La lista de mods pendientes no es válida.');
    return entries;
  }
  function cleanUnused() {
    const referenced = new Set(list().map(entry => entry.staged));
    if (!fs.existsSync(root)) return;
    for (const name of fs.readdirSync(root)) {
      if (/^[a-f0-9-]+\.jar$/.test(name) && !referenced.has(name)) fs.unlinkSync(path.join(root, name));
    }
  }
  function stage(temp, details) {
    if (!safe(details.name) || (details.replaceName && !safe(details.replaceName))) throw Error('Nombre de mod pendiente no válido.');
    const entries = list();
    const existing = entries.find(e => e.modId === details.modId);
    if (entries.some(e => e.modId !== details.modId && (e.name === details.name || (details.replaceName && (e.replaceName === details.replaceName || e.name === details.replaceName))))) throw Error('Otro mod pendiente utiliza ese archivo.');
    if (fs.existsSync(path.join(mods, details.name)) && details.name !== details.replaceName) throw Error('El archivo de destino ya está instalado.');
    const replaceName = existing?.replaceName || details.replaceName || '';
    const oldHash = replaceName ? hash(path.join(mods, replaceName)) : '';
    fs.mkdirSync(root, { recursive: true });
    const staged = crypto.randomUUID() + '.jar';
    fs.copyFileSync(temp, path.join(root, staged));
    const entry = { ...details, replaceName, oldHash, staged, hash: hash(temp), bytes: fs.statSync(temp).size, preparedAt: new Date().toISOString() };
    write(manifest, [...entries.filter(e => e.modId !== details.modId), entry]);
    return entry;
  }
  function recover() {
    if (!fs.existsSync(journal)) return;
    const tx = JSON.parse(fs.readFileSync(journal, 'utf8'));
    if (tx.committed) {
      write(manifest, []);
    } else {
      for (const entry of [...tx.entries].reverse()) {
        const target = path.join(mods, entry.name);
        const old = entry.replaceName && path.join(tx.backupDir, entry.replaceName);
        if (fs.existsSync(target) && hash(target) === entry.hash && (!entry.replaceName || (old && fs.existsSync(old)))) fs.unlinkSync(target);
        if (old && fs.existsSync(old)) fs.renameSync(old, path.join(mods, entry.replaceName));
      }
      write(manifest, tx.entries);
    }
    fs.unlinkSync(journal);
  }
  function apply() {
    recover();
    const entries = list();
    if (!entries.length) return { applied: 0 };
    for (const e of entries) {
      if (hash(path.join(root, e.staged)) !== e.hash) throw Error('Se ha alterado la descarga pendiente: ' + e.name);
      if (e.replaceName && hash(path.join(mods, e.replaceName)) !== e.oldHash) throw Error('El mod original ha cambiado; vuelve a preparar la actualización: ' + e.replaceName);
      if (fs.existsSync(path.join(mods, e.name)) && e.name !== e.replaceName) throw Error('Ya existe el mod de destino: ' + e.name);
    }
    const sameVolume = path.resolve(panelDir) === path.join(path.resolve(serverDir),'panel');
    const rollback = sameVolume ? path.join(panelDir,'mod-rollback') : path.join(serverDir,'.wolfmc-mod-rollback');
    const backupDir = path.join(rollback, 'batch-' + crypto.randomUUID());
    fs.mkdirSync(backupDir, { recursive: true });
    const tx = { entries, backupDir, committed: false };
    write(journal, tx);
    try {
      for (const e of entries) {
        if (e.replaceName) fs.renameSync(path.join(mods, e.replaceName), path.join(backupDir, e.replaceName));
        const temp = path.join(root, 'applying-' + e.staged);
        fs.copyFileSync(path.join(root, e.staged), temp);
        fs.renameSync(temp, path.join(mods, e.name));
      }
      tx.committed = true;
      write(journal, tx);
      write(manifest, []);
      fs.unlinkSync(journal);
      // Keep a small receipt next to the saved original JARs.
      write(path.join(backupDir, 'receipt.json'), tx);
      cleanUnused();
      return { applied: entries.length, backupDir };
    } catch (error) {
      recover();
      throw error;
    }
  }
  return { list, stage, apply, checkpoint: list, rollback: entries => { write(manifest, entries); cleanUnused(); } };
}
module.exports = { createModStaging };

if (require.main === module) {
  const net = require('node:net');
  const serverDir = path.resolve(__dirname, '..');
  const port = Number(/^server-port=(\d+)/m.exec(fs.readFileSync(path.join(serverDir, 'server.properties'), 'utf8'))?.[1] || 25565);
  const socket = net.connect(port, '127.0.0.1');
  socket.setTimeout(3000);
  socket.once('connect', () => { console.error('Minecraft sigue encendido; no se aplican mods pendientes.'); socket.destroy(); process.exitCode = 1; });
  socket.once('timeout', () => { console.error('No se pudo comprobar el estado de Minecraft.'); socket.destroy(); process.exitCode = 1; });
  socket.once('error', error => {
    if (error.code !== 'ECONNREFUSED') { console.error(error.message); process.exitCode = 1; return; }
    try { console.log(JSON.stringify(createModStaging(serverDir).apply())); } catch (error) { console.error(error.message); process.exitCode = 1; }
  });
}
