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
  const make = (options = {}) => createItemCatalog({ serverDir: dir, checkIntervalMs: 0, now: () => currentTime,
    languageLoader: async () => { calls.jar++; return translations; },
    vanillaLoader: async () => { calls.vanilla++; return { es_es: { 'item.minecraft.creeper_spawn_egg': 'Generar creeper', 'item.minecraft.villager_spawn_egg': 'Generar aldeano', 'item.minecraft.diamond': 'Diamante' } }; }, ...options });
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

test('Tooltip variants distinguish templates, banner patterns and music discs and remain searchable', async () => fixture(async ({ make, translations, save, snapshot }) => {
  const fresh = snapshot();
  for (const [suffix, name, detail, ending] of [
    ['netherite_upgrade_smithing_template', 'Molde de herrería', 'Mejora de netherita', '.new'],
    ['wild_armor_trim_smithing_template', 'Molde de herrería', 'Diseño de armadura salvaje', '.new'],
    ['creeper_banner_pattern', 'Diseño de estandarte', 'Estampado de creeper', '.desc'],
    ['music_disc_13', 'Disco de música', 'C418 - 13', '.desc'],
  ]) {
    const key = 'item.minecraft.' + suffix;
    translations.es_es[key] = name; translations.es_es[key + ending] = detail;
    fresh.items.push({ id: 'minecraft:' + suffix, translationKey: key, fallbackName: name });
  }
  save(fresh); const catalog = make();
  assert.equal((await catalog.search({ q: 'molde netherita' })).items[0].name, 'Molde de herrería — Mejora de netherita');
  assert.equal((await catalog.search({ q: 'molde salvaje' })).total, 1);
  assert.equal((await catalog.search({ q: 'estandarte creeper' })).total, 1);
  assert.equal((await catalog.search({ q: 'disco C418 13' })).total, 1);
  assert.equal((await catalog.search()).catalogTotal, 10);
}));

test('Duplicate translated names preserve every mod item, refresh automatically and have stable unique labels', async () => fixture(async ({ make, translations, save, snapshot, advance }) => {
  const fresh = snapshot();
  for (const id of ['example:pot_black', 'example:pot_white', 'example:a_b', 'example:a/b', 'other:pot']) {
    translations.es_es['item.' + id.replace(':', '.')] = 'Maceta';
    fresh.items.push({ id, translationKey: 'item.' + id.replace(':', '.') });
  }
  fresh.mods.push({ id: 'other', name: 'Example Furniture' }); // Same display name, different namespace.
  save(fresh); const catalog = make();
  const result = await catalog.search({ q: 'maceta' });
  assert.equal(result.total, 5);
  assert.equal(new Set(result.items.map(item => normalize(item.name))).size, 5);
  for (const item of result.items) {
    assert.equal(await catalog.hasItem(item.id), true);
    assert.equal((await catalog.search({ q: item.id })).items.some(found => found.id === item.id), true);
    assert.equal(item.name.startsWith('Maceta — '), true);
    assert.equal('_search' in item, false);
  }
  fresh.items.reverse(); advance(); save(fresh); await catalog.refresh();
  assert.deepEqual((await catalog.search({ q: 'maceta' })).items, result.items);
  fresh.items.push({ id: 'example:pot_new', translationKey: 'item.example.pot_new' });
  translations.es_es['item.example.pot_new'] = 'Maceta';
  // New registry entries are reflected without a panel restart, even with cached languages.
  advance(); save(fresh);
  assert.equal(await catalog.hasItem('example:pot_new'), true);
}));

test('Same-mod collisions use readable identifiers and missing tooltip translations remain usable', async () => fixture(async ({ make, translations, save, snapshot }) => {
  const fresh = snapshot();
  for (const suffix of ['black_pot', 'white_pot']) {
    translations.es_es['item.example.' + suffix] = 'Maceta';
    fresh.items.push({ id: 'example:' + suffix, translationKey: 'item.example.' + suffix });
  }
  fresh.items.push({ id: 'minecraft:unknown_smithing_template', fallbackName: 'Smithing Template' });
  save(fresh); const catalog = make();
  assert.equal((await catalog.search({ q: 'maceta black' })).items[0].name, 'Maceta — Black pot');
  assert.equal((await catalog.search({ q: 'unknown_smithing_template' })).items[0].name, 'Smithing Template');
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

test('Enchanted books are localized in six languages, match exact levels and produce only catalog-approved components', async () => fixture(async ({ make, save, snapshot, translations }) => {
  const fresh = snapshot(); fresh.items.push({ id: 'minecraft:enchanted_book', translationKey: 'item.minecraft.enchanted_book', fallbackName: 'Enchanted Book' }); save(fresh);
  const names = { es_es: ['Libro encantado','Protección'], en_us: ['Enchanted Book','Protection'], de_de: ['Verzaubertes Buch','Schutz'], fr_fr: ['Livre enchanté','Protection'], tr_tr: ['Büyülü Kitap','Koruma'], pt_br: ['Livro Encantado','Proteção'] };
  for (const [locale, [book, protection]] of Object.entries(names)) translations[locale] = { ...translations[locale], 'item.minecraft.enchanted_book': book, 'enchantment.minecraft.protection': protection };
  const resourceLoader = async () => ({ enchantments: [{id:'minecraft:protection',maxLevel:4}], english: {} });
  const catalog = make({ resourceLoader });
  for (const [language, locale] of Object.entries({es:'es_es',en:'en_us',de:'de_de',fr:'fr_fr',tr:'tr_tr',pt:'pt_br'})) {
    const result = await catalog.search({language,q:names[locale][1]+' IV'});
    assert.equal(result.total,1); assert.equal(result.items[0].name,names[locale][0]+' — '+names[locale][1]+' IV');
    assert.equal(result.items[0].variant,'minecraft:protection@4');
    assert.equal((await catalog.search({language,q:names[locale][1]+' 4'})).total,1);
  }
  assert.equal((await catalog.search({language:'__proto__',q:'Protección IV'})).total,1);
  assert.equal(await catalog.giveArgument('minecraft:enchanted_book','minecraft:protection@4'),'minecraft:enchanted_book[minecraft:stored_enchantments={"minecraft:protection":4}]');
  for(const variant of ['minecraft:protection@5','minecraft:unknown@4','minecraft:protection@4]\nkill @a'])await assert.rejects(catalog.giveArgument('minecraft:enchanted_book',variant));
  await assert.rejects(catalog.giveArgument('minecraft:diamond','minecraft:protection@4'));
  assert.match(await make({resourceLoader,minecraftVersion:'1.21.1'}).giveArgument('minecraft:enchanted_book','minecraft:protection@4'),/stored_enchantments=\{levels:/);
  assert.match(await make({resourceLoader,minecraftVersion:'1.20.4'}).giveArgument('minecraft:enchanted_book','minecraft:protection@4'),/StoredEnchantments:\[\{id:"minecraft:protection",lvl:4s\}\]/);
}));

test('Book definitions come from server resources and loaded mods; a live registry overrides resource guesses', async () => fixture(async ({ dir, mods, snapshot }) => {
  const {createResourceLoader}=require('../src/panel/item-resources');
  const {readZipEntries}=require('../src/panel/item-catalog');
  const library=path.join(dir,'libraries/server-26.3.jar');fs.mkdirSync(path.dirname(library),{recursive:true});
  fs.writeFileSync(library,zip([['assets/minecraft/lang/en_us.json','{"enchantment.minecraft.protection":"Protection"}'],['data/minecraft/enchantment/protection.json','{"max_level":4}']]));
  const mod=path.join(mods,'example.jar');fs.writeFileSync(mod,zip([['data/example/enchantment/focus.json','{"max_level":3,"description":{"translate":"enchantment.example.focus"}}']]));
  const pending=path.join(mods,'pending.jar');fs.writeFileSync(pending,zip([['data/example/enchantment/pending.json','{"max_level":5}']]));
  const load=createResourceLoader(readZipEntries),fresh=snapshot();fresh.modFiles=fresh.modFiles.filter(f=>f.name!=='pending.jar');
  const jars=[{name:'example.jar',file:mod},{name:'pending.jar',file:pending}];
  const data=await load({serverDir:dir,jars,snapshot:fresh});
  assert.deepEqual(data.enchantments.map(e=>e.id).sort(),['example:focus','minecraft:protection']);
  assert.equal(data.english['enchantment.minecraft.protection'],'Protection');
  fresh.enchantments=[];
  assert.deepEqual((await load({serverDir:dir,jars,snapshot:fresh})).enchantments,[]);
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
