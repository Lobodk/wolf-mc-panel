const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const zlib = require('node:zlib');
const { createItemCatalog, readJarLanguages, normalize } = require('../src/panel/item-catalog');

async function fixture(run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lobodk-item-catalog-'));
  const mods = path.join(dir, 'mods'), telemetry = path.join(dir, 'panel/telemetry');
  fs.mkdirSync(mods); fs.mkdirSync(telemetry, { recursive: true });
  const jar = path.join(mods, 'example.jar'); fs.writeFileSync(jar, 'fake-jar');
  let currentTime = Date.now();
  const calls = { jar: 0, vanilla: 0 };
  const translations = { en_us: { 'item.example.chair': 'Oak Chair' }, es_es: { 'item.example.chair': 'Silla de roble', 'item.example.barrel': 'Barril de diamante%2$s%1$s' } };
  const snapshot = () => ({ schema: 1, generatedAt: currentTime, mods: [{ id: 'example', name: 'Example Furniture' }], modFiles: fs.readdirSync(mods).map(name => { const stat = fs.statSync(path.join(mods, name)); return { name, size: stat.size, modifiedAt: Math.floor(stat.mtimeMs) }; }), items: [
    { id: 'minecraft:air', translationKey: 'block.minecraft.air', fallbackName: 'Air' },
    { id: 'minecraft:creeper_spawn_egg', translationKey: 'item.minecraft.creeper_spawn_egg', fallbackName: 'Creeper Spawn Egg', maxStackSize: 64 },
    { id: 'minecraft:villager_spawn_egg', translationKey: 'item.minecraft.villager_spawn_egg', fallbackName: 'Villager Spawn Egg', maxStackSize: 64 },
    { id: 'minecraft:diamond', translationKey: 'item.minecraft.diamond', fallbackName: 'Diamond' },
    { id: 'example:chair', translationKey: 'item.example.chair', fallbackName: 'Oak Chair' },
    { id: 'example:barrel', translationKey: 'item.example.barrel', fallbackName: 'Diamond Barrel' },
    { id: 'example:untranslated', translationKey: 'item.example.untranslated', fallbackName: 'Untranslated Widget' },
    { id: 'example:command\nkill @a', translationKey: 'invalid', fallbackName: 'Invalid' },
  ] });
  const file = path.join(telemetry, 'items.json');
  const save = data => { fs.writeFileSync(file + '.tmp', JSON.stringify(data)); fs.renameSync(file + '.tmp', file); };
  save(snapshot());
  const make = () => createItemCatalog({ serverDir: dir, checkIntervalMs: 0, now: () => currentTime,
    languageLoader: async () => { calls.jar++; return translations; },
    vanillaLoader: async () => { calls.vanilla++; return { es_es: { 'item.minecraft.creeper_spawn_egg': 'Generar creeper', 'item.minecraft.villager_spawn_egg': 'Generar aldeano', 'item.minecraft.diamond': 'Diamante' } }; } });
  try { await run({ dir, mods, jar, file, make, calls, translations, snapshot, save, advance: () => { currentTime += 5000; } }); }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

test('Spanish names, accent-insensitive terms, spawn-egg aliases and IDs search only actual registry entries', async () => fixture(async ({ make }) => {
  const catalog = make();
  const eggs = await catalog.search({ q: 'huevo' });
  assert.equal(eggs.available, true); assert.equal(eggs.total, 2); assert.equal(eggs.pendingRestart, false);
  assert.equal(eggs.items.find(item => item.id === 'minecraft:creeper_spawn_egg').name, 'Huevo generador de creeper');
  assert.equal((await catalog.search({ q: 'HÚEVO ALDEÁNO' })).items[0].id, 'minecraft:villager_spawn_egg');
  assert.equal((await catalog.search({ q: 'minecraft:diamond' })).items[0].name, 'Diamante');
  assert.equal((await catalog.search({ q: 'example furniture silla' })).items[0].name, 'Silla de roble');
  assert.equal((await catalog.search({ q: 'barril' })).items[0].name, 'Barril de diamante');
  assert.equal((await catalog.search({ q: 'untranslated' })).items[0].name, 'Untranslated Widget');
  assert.equal((await catalog.search()).catalogTotal, 6);
  assert.equal(await catalog.hasItem('minecraft:diamond'), true);
  assert.equal(await catalog.hasItem('example:invented'), false);
  assert.equal(await catalog.hasItem('minecraft:diamond\nkill @a'), false);
}));

test('Cached translations are not rescanned for every keystroke, and registry contents refresh atomically', async () => fixture(async ({ make, calls, save, snapshot, advance }) => {
  const catalog = make(); await catalog.search({ q: 'h' }); await catalog.search({ q: 'hu' }); await catalog.search({ q: 'hue' });
  assert.deepEqual(calls, { jar: 1, vanilla: 1 });
  const fresh = snapshot(); fresh.items.push({ id: 'example:new_item', fallbackName: 'New Item' }); advance(); fresh.generatedAt += 5000; save(fresh);
  assert.equal(await catalog.hasItem('example:new_item'), true);
  assert.deepEqual(calls, { jar: 1, vanilla: 1 });
}));

test('Adding or deleting mod JARs reports pending restart; removed mod languages are invalidated', async () => fixture(async ({ make, mods, jar, snapshot, save, advance }) => {
  const catalog = make(); await catalog.search();
  fs.writeFileSync(path.join(mods, 'new-mod.jar'), 'new'); advance();
  assert.equal((await catalog.search()).pendingRestart, true);
  save(snapshot()); advance(); assert.equal((await catalog.search()).pendingRestart, false);
  fs.unlinkSync(jar); advance();
  const removed = await catalog.search({ q: 'chair' });
  assert.equal(removed.pendingRestart, true);
  // Last server registry remains authoritative until its next restart, even after disk files change.
  assert.equal(await catalog.hasItem('example:chair'), true);
  const latest = snapshot(); latest.items = latest.items.filter(item => !item.id.startsWith('example:')); save(latest); advance();
  assert.equal(await catalog.hasItem('example:chair'), false);
}));

test('Missing or partially rewritten registry never produces invented results and preserves last valid snapshot', async () => fixture(async ({ make, file }) => {
  const catalog = make(); await catalog.search();
  fs.writeFileSync(file, '{bad');
  const stale = await catalog.search(); assert.equal(stale.available, true); assert.equal(stale.catalogTotal, 6); assert.match(stale.message, /última lista válida/);
  fs.unlinkSync(file);
  const initial = await make().search(); assert.equal(initial.available, false); assert.deepEqual(initial.items, []);
}));

test('Search limits and backend validation bound the result; endpoint does not return local paths', async () => fixture(async ({ make }) => {
  const catalog = make(); const result = await catalog.search({ limit: 2 }); assert.equal(result.items.length, 2); assert.equal(result.hasMore, true); assert.equal(result.total, 6);
  await assert.rejects(catalog.search({ q: 'a'.repeat(151) }), /150/);
  let reply; const sendJson = (res, status, body) => { reply = { status, body }; };
  assert.equal(await catalog.handle({ method: 'GET' }, {}, new URL('http://localhost/api/items?q=huevo&limit=1'), { sendJson }), true);
  assert.equal(reply.status, 200); assert.equal(reply.body.items.length, 1); assert.equal(reply.body.total, 2);
  assert.equal(JSON.stringify(reply).includes('lobodk-item-catalog-'), false);
  assert.equal(await catalog.handle({ method: 'POST' }, {}, new URL('http://localhost/api/items'), { sendJson }), false);
}));

function zip(entries) {
  const locals = [], central = []; let offset = 0;
  for (const [name, text, method = 8] of entries) {
    const nameBytes = Buffer.from(name), plain = Buffer.from(text), compressed = method === 8 ? zlib.deflateRawSync(plain) : plain;
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(method, 8); local.writeUInt32LE(compressed.length, 18); local.writeUInt32LE(plain.length, 22); local.writeUInt16LE(nameBytes.length, 26);
    const dir = Buffer.alloc(46); dir.writeUInt32LE(0x02014b50, 0); dir.writeUInt16LE(method, 10); dir.writeUInt32LE(compressed.length, 20); dir.writeUInt32LE(plain.length, 24); dir.writeUInt16LE(nameBytes.length, 28); dir.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, compressed); central.push(dir, nameBytes); offset += 30 + nameBytes.length + compressed.length;
  }
  const body = Buffer.concat(locals), directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(body.length, 16);
  return Buffer.concat([body, directory, end]);
}

test('ZIP language reader handles compressed/stored JSON, ignores unrelated/private entries and tolerates malformed locale', async () => fixture(async ({ jar }) => {
  fs.writeFileSync(jar, zip([
    ['assets/example/lang/es_es.json', JSON.stringify({ 'item.example.a': 'Árbol', wrongType: 4 }), 8],
    ['assets/example/lang/en_us.json', JSON.stringify({ 'item.example.a': 'Tree' }), 0],
    ['assets/example/lang/es_mx.json', '{bad'],
    ['panel-config.json', 'PRIVATE'], ['assets/../../lang/es_es.json', JSON.stringify({ evil: 'ignored' })],
  ]));
  const result = await readJarLanguages(jar);
  assert.equal(result.es_es['item.example.a'], 'Árbol'); assert.equal(result.en_us['item.example.a'], 'Tree'); assert.equal(result.es_es.wrongType, undefined); assert.equal(result.es_es.evil, undefined); assert.deepEqual(Object.keys(result.es_mx), []);
  assert.equal(normalize('  HÚEVO_minecraft:CREÉPER  '), 'huevo minecraft creeper');
}));
