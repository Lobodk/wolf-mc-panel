'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');

// Read definitions shipped with this server, never a hardcoded list from a newer
// Minecraft version. Resource data supplies book variants on existing snapshots.
function createResourceLoader(readZipEntries) {
  const cache = new Map();
  async function read(file) {
    const stat = await fs.stat(file), signature = stat.size + ':' + stat.mtimeMs;
    if (cache.get(file)?.signature === signature) return cache.get(file).data;
    const data = { english: {}, enchantments: [] };
    const entries = await readZipEntries(file, name => name === 'assets/minecraft/lang/en_us.json' || /^data\/[a-z0-9_.-]+\/enchantment\/[a-z0-9_./-]+\.json$/.test(name));
    for (const [name, text] of entries) {
      try {
        const json = JSON.parse(text);
        if (name.startsWith('assets/')) { data.english = json; continue; }
        const match = /^data\/([^/]+)\/enchantment\/(.+)\.json$/.exec(name);
        const id = match[1] + ':' + match[2];
        if (Number.isInteger(json.max_level) && json.max_level >= 1 && json.max_level <= 255) {
          data.enchantments.push({ id, maxLevel: json.max_level, translationKey: json.description?.translate || 'enchantment.' + id.replace(':', '.').replaceAll('/', '.'), fallbackName: typeof json.description === 'string' ? json.description : '' });
        }
      } catch { /* A malformed mod definition must not remove the item catalog. */ }
    }
    cache.set(file, { signature, data }); return data;
  }
  return async function load({ serverDir, jars, snapshot }) {
    const candidates = [];
    async function walk(directory, depth = 0) {
      if (depth > 10) return;
      for (const entry of await fs.readdir(directory, { withFileTypes: true }).catch(() => [])) {
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) await walk(file, depth + 1);
        else if (entry.isFile() && /^(?:minecraft-server-patched-|server[-.]).*\.jar$/i.test(entry.name)) candidates.push(file);
      }
    }
    await walk(path.join(serverDir, 'libraries')); await walk(path.join(serverDir, 'versions'));
    let launch = ''; try { launch = await fs.readFile(path.join(serverDir, 'run.bat'), 'utf8'); } catch {}
    try { launch += JSON.stringify(JSON.parse(await fs.readFile(path.join(serverDir, 'panel/launch.json'), 'utf8'))); } catch {}
    const ranked = await Promise.all(candidates.map(async file => ({ file, stat: await fs.stat(file), preferred: launch.includes(path.basename(file).replace(/^minecraft-server-patched-|\.jar$/g, '')) })));
    ranked.sort((a, b) => Number(b.preferred) - Number(a.preferred) || b.stat.mtimeMs - a.stat.mtimeMs || a.file.localeCompare(b.file));
    let english = {}, enchantments = new Map();
    for (const { file } of ranked) {
      try { const data = await read(file); if (!Object.keys(data.english).length && !data.enchantments.length) continue; english = data.english; for (const e of data.enchantments) enchantments.set(e.id, e); break; } catch {}
    }
    const loadedFiles = new Set((snapshot.modFiles || []).map(file => file.name));
    const namespaces = new Set((snapshot.mods || []).map(mod => mod.id));
    for (const jar of jars) {
      if (snapshot.modFiles && !loadedFiles.has(jar.name)) continue;
      try { const data = await read(jar.file); for (const e of data.enchantments) if (namespaces.has(e.id.split(':')[0]) || e.id.startsWith('minecraft:')) enchantments.set(e.id, e); } catch {}
    }
    // An exported live registry, when available, is authoritative over resources.
    if (Array.isArray(snapshot.enchantments)) enchantments = new Map(snapshot.enchantments.map(e => [e.id, e]));
    return { english, enchantments: [...enchantments.values()] };
  };
}
module.exports = { createResourceLoader };
