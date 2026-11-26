'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');

const ITEM_ID = /^[a-z0-9_.-]+:[a-z0-9_./-]+$/;
const LOCALES = { es: 'es_es', en: 'en_us', de: 'de_de', fr: 'fr_fr', tr: 'tr_tr', pt: 'pt_br' };
const LANG_ENTRY = /^assets\/[a-z0-9_.-]+\/lang\/(es_es|es_mx|en_us|de_de|fr_fr|tr_tr|pt_br)\.json$/;
const OFFICIAL_HOSTS = new Set(['piston-meta.mojang.com', 'launchermeta.mojang.com', 'resources.download.minecraft.net']);
const MAX_LANGUAGE_BYTES = 16 * 1024 * 1024;

function normalize(value) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('es').replace(/[_:./-]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function dictionary(value) {
  const result = Object.create(null);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return result;
  for (const [key, text] of Object.entries(value)) {
    if (typeof text === 'string' && text.length > 0 && text.length <= 1000 && key.length <= 300) result[key] = text;
  }
  return result;
}

function readJsonText(text) { return dictionary(JSON.parse(String(text).replace(/^\uFEFF/, ''))); }

/** Read only selected entries, using ZIP directory offsets. No extraction, shell, or Java process per keystroke. */
async function readZipEntries(file, matches) {
  const handle = await fsp.open(file, 'r');
  try {
    const stat = await handle.stat();
    if (stat.size < 22) throw new Error('ZIP demasiado pequeño');
    const tail = Buffer.alloc(Math.min(stat.size, 65557));
    await handle.read(tail, 0, tail.length, stat.size - tail.length);
    let end = -1;
    for (let at = tail.length - 22; at >= 0; at--) {
      if (tail.readUInt32LE(at) === 0x06054b50 && at + 22 + tail.readUInt16LE(at + 20) === tail.length) { end = at; break; }
    }
    if (end < 0) throw new Error('Directorio ZIP no encontrado');
    const count = tail.readUInt16LE(end + 10);
    const directorySize = tail.readUInt32LE(end + 12);
    const directoryOffset = tail.readUInt32LE(end + 16);
    if (count === 65535 || directorySize > 32 * 1024 * 1024 || directoryOffset + directorySize > stat.size) throw new Error('Directorio ZIP no admitido');
    const directory = Buffer.alloc(directorySize);
    await handle.read(directory, 0, directory.length, directoryOffset);
    const output = new Map();
    let offset = 0, expanded = 0;
    for (let index = 0; index < count; index++) {
      if (offset + 46 > directory.length || directory.readUInt32LE(offset) !== 0x02014b50) throw new Error('Directorio ZIP incompleto');
      const flags = directory.readUInt16LE(offset + 8);
      const method = directory.readUInt16LE(offset + 10);
      const size = directory.readUInt32LE(offset + 20);
      const plainSize = directory.readUInt32LE(offset + 24);
      const nameLength = directory.readUInt16LE(offset + 28);
      const extraLength = directory.readUInt16LE(offset + 30);
      const commentLength = directory.readUInt16LE(offset + 32);
      const localOffset = directory.readUInt32LE(offset + 42);
      if (offset + 46 + nameLength + extraLength + commentLength > directory.length) throw new Error('Entrada ZIP incompleta');
      const name = directory.toString('utf8', offset + 46, offset + 46 + nameLength);
      offset += 46 + nameLength + extraLength + commentLength;
      if (!matches(name)) continue;
      if (flags & 1 || ![0, 8].includes(method) || plainSize > MAX_LANGUAGE_BYTES || size > MAX_LANGUAGE_BYTES || expanded + plainSize > 48 * 1024 * 1024) throw new Error('Recurso de idioma ZIP no admitido');
      const header = Buffer.alloc(30);
      await handle.read(header, 0, header.length, localOffset);
      if (header.readUInt32LE(0) !== 0x04034b50) throw new Error('Cabecera ZIP no válida');
      const start = localOffset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
      if (start + size > stat.size) throw new Error('Recurso ZIP truncado');
      const bytes = Buffer.alloc(size);
      await handle.read(bytes, 0, bytes.length, start);
      const plain = method === 0 ? bytes : zlib.inflateRawSync(bytes, { maxOutputLength: MAX_LANGUAGE_BYTES });
      if (plain.length !== plainSize) throw new Error('Tamaño ZIP incorrecto');
      expanded += plain.length;
      output.set(name, plain.toString('utf8'));
    }
    return output;
  } finally { await handle.close(); }
}

async function readJarLanguages(file) {
  const entries = await readZipEntries(file, name => LANG_ENTRY.test(name));
  const languages = Object.fromEntries([...Object.values(LOCALES), 'es_mx'].map(locale => [locale, Object.create(null)]));
  for (const [name, text] of entries) {
    const locale = LANG_ENTRY.exec(name)[1];
    try { Object.assign(languages[locale], readJsonText(text)); } catch { /* A malformed mod translation must not hide the rest of the catalog. */ }
  }
  return languages;
}

async function fetchOfficial(url, expectedHash = '', maxBytes = 20 * 1024 * 1024) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || !OFFICIAL_HOSTS.has(parsed.hostname)) throw new Error('Origen de idiomas no permitido');
  const response = await fetch(parsed, { signal: AbortSignal.timeout(12000), redirect: 'error' });
  if (!response.ok) throw new Error('Idioma oficial HTTP ' + response.status);
  const announced = Number(response.headers.get('content-length'));
  if (announced > maxBytes) throw new Error('Idioma oficial demasiado grande');
  const chunks = []; let length = 0;
  for await (const chunk of response.body) {
    length += chunk.length;
    if (length > maxBytes) throw new Error('Idioma oficial demasiado grande');
    chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks);
  if (expectedHash && crypto.createHash('sha1').update(bytes).digest('hex') !== expectedHash) throw new Error('La huella del idioma oficial no coincide');
  return bytes.toString('utf8');
}

/** Cache official, checksum-verified Minecraft language assets. No CurseForge API or credentials. */
async function loadVanillaSpanish({ serverDir, panelDir=path.join(serverDir,'panel'), minecraftVersion = '26.3' }) {
  if (!/^[0-9A-Za-z_.-]{1,50}$/.test(minecraftVersion)) throw new Error('Versión de idioma inválida');
  const cache = path.join(panelDir, 'cache', 'item-languages', minecraftVersion + '.json');
  try {
    const saved = JSON.parse(await fsp.readFile(cache, 'utf8'));
    if (saved.version !== minecraftVersion || !saved.assets?.es_es) throw new Error('Caché de idioma antigua');
    const languages = {};
    for (const [locale, asset] of Object.entries(saved.assets)) {
      if (![...Object.values(LOCALES), 'es_mx'].includes(locale) || crypto.createHash('sha1').update(asset.text).digest('hex') !== asset.hash) throw new Error('Caché de idioma alterada');
      languages[locale] = readJsonText(asset.text);
    }
    if (['es_es','es_mx','de_de','fr_fr','tr_tr','pt_br'].every(locale => languages[locale])) return languages;
  } catch {}

  const manifest = JSON.parse(await fetchOfficial('https://piston-meta.mojang.com/mc/game/version_manifest_v2.json', '', 8 * 1024 * 1024));
  const version = manifest.versions?.find(entry => entry.id === minecraftVersion);
  if (!version?.url || !/^[a-f0-9]{40}$/.test(version.sha1)) throw new Error('No se encuentra el idioma de Minecraft ' + minecraftVersion);
  const metadata = JSON.parse(await fetchOfficial(version.url, version.sha1));
  const index = JSON.parse(await fetchOfficial(metadata.assetIndex.url, metadata.assetIndex.sha1));
  const assets = {}, languages = {};
  for (const locale of ['es_es', 'es_mx', 'de_de', 'fr_fr', 'tr_tr', 'pt_br']) {
    const asset = index.objects?.['minecraft/lang/' + locale + '.json'];
    if (!asset || !/^[a-f0-9]{40}$/.test(asset.hash)) continue;
    const text = await fetchOfficial('https://resources.download.minecraft.net/' + asset.hash.slice(0, 2) + '/' + asset.hash, asset.hash, MAX_LANGUAGE_BYTES);
    assets[locale] = { hash: asset.hash, text };
    languages[locale] = readJsonText(text);
  }
  if (!languages.es_es) throw new Error('El índice oficial no contiene español');
  await fsp.mkdir(path.dirname(cache), { recursive: true });
  await fsp.writeFile(cache + '.tmp', JSON.stringify({ version: minecraftVersion, assets }));
  await fsp.rename(cache + '.tmp', cache);
  return languages;
}

function niceId(id) {
  const words = id.split(':')[1].replace(/[_/.-]+/g, ' ');
  return words.charAt(0).toLocaleUpperCase('es') + words.slice(1);
}

function displayName(text) {
  // Some mods use optional color/wood-name printf slots in their default item labels.
  // No stack-specific arguments are available for a plain /give item, so omit those slots.
  return String(text).replace(/%%/g, '\u0001').replace(/%(?:\d+\$)?[-+#0 ,(]*\d*(?:\.\d+)?[a-z]/gi, '')
    .replace(/\u0001/g, '%').replace(/\u00a7[0-9a-fk-or]/gi, '').replace(/[\x00-\x1f]/g, ' ').replace(/\s+/g, ' ').trim();
}

function variantLabel(id, key, languages, locales) {
  // These items deliberately share their base translation; Minecraft shows the
  // distinguishing line as a tooltip rather than part of the registered name.
  const keys = [];
  if (id.endsWith('_smithing_template')) keys.push(key + '.new');
  if (id.endsWith('_banner_pattern')) keys.push(key + '.new', key + '.desc');
  const disc = /^minecraft:music_disc_(.+)$/.exec(id);
  if (disc) keys.push(key + '.desc', 'jukebox_song.minecraft.' + disc[1]);
  for (const locale of locales) {
    for (const candidate of keys) {
      const text = languages[locale][candidate];
      if (text && !/%(?:\d+\$)?[-+#0 ,(]*\d*(?:\.\d+)?[a-z]/i.test(text.replace(/%%/g, ''))) return displayName(text);
    }
  }
  return '';
}

function distinguishNames(items) {
  const groups = new Map();
  for (const item of items) {
    const key = normalize(item.name);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const namespaces = new Set(group.map(item => item.id.split(':')[0]));
    for (const item of group) item.name += ' — ' + (namespaces.size > 1 ? item.modName : niceId(item.id));
  }
  // A translated mod name or humanized identifier can itself collide. Keep every
  // registry entry and guarantee a stable, distinct label even in that case.
  const used = new Set();
  for (const item of [...items].sort((a, b) => a.id.localeCompare(b.id) || String(a.variant || '').localeCompare(String(b.variant || '')))) {
    while (used.has(normalize(item.name))) item.name += ' [' + item.id + ']';
    used.add(normalize(item.name));
    item._name = normalize(item.name);
    item._search += ' ' + item._name;
  }
  return items;
}

function createLocalizedCatalog({ serverDir, panelDir, minecraftVersion = '26.3', language = 'es', resourceLoader = require('./item-resources').createResourceLoader(readZipEntries), languageLoader = readJarLanguages, vanillaLoader = loadVanillaSpanish,
    now = Date.now, checkIntervalMs = 3000 } = {}) {
  if (!serverDir) throw new Error('serverDir requerido');
  const localPanel = panelDir || path.join(serverDir,'panel');
  const snapshotFile = path.join(localPanel, 'telemetry', 'items.json');
  const modsDir = path.join(serverDir, 'mods');
  const jarCache = new Map();
  let lastChecked = -Infinity, inFlight = null, currentSignature = '', registrySignature = '', vanilla = null, nextVanillaAttempt = 0;
  let status = { available: false, generatedAt: null, pendingRestart: false, message: 'El catálogo se generará al iniciar Minecraft con el módulo actualizado.', items: [] };

  async function rebuild(force) {
    if (!force && now() - lastChecked < checkIntervalMs) return;
    lastChecked = now();
    const snapshotStat = await fsp.stat(snapshotFile).catch(() => null);
    if (!snapshotStat) {
      if (!status.available) status = { ...status, message: 'El catálogo se generará al iniciar Minecraft con el módulo actualizado.' };
      return;
    }
    if (snapshotStat.size > 32 * 1024 * 1024) throw new Error('El catálogo del servidor es demasiado grande');
    const entries = await fsp.readdir(modsDir, { withFileTypes: true }).catch(() => []);
    const jars = (await Promise.all(entries.filter(entry => entry.isFile() && entry.name.toLowerCase().endsWith('.jar')).map(async entry => {
      const fullPath = path.join(modsDir, entry.name), stat = await fsp.stat(fullPath);
      return { name: entry.name, file: fullPath, size: stat.size, modifiedAt: Math.floor(stat.mtimeMs) };
    }))).sort((a, b) => a.name.localeCompare(b.name));
    const jarSignature = JSON.stringify(jars.map(({ name, size, modifiedAt }) => ({ name, size, modifiedAt })));
    const snapshotSignature = snapshotStat.size + ':' + snapshotStat.mtimeMs;
    if (!force && jarSignature === currentSignature && snapshotSignature === registrySignature && (vanilla || now() < nextVanillaAttempt)) return;
    const snapshot = JSON.parse(await fsp.readFile(snapshotFile, 'utf8'));
    if (snapshot.schema !== 1 || !Array.isArray(snapshot.items) || snapshot.items.length > 100000 || !Number.isFinite(Number(snapshot.generatedAt))) throw new Error('El catálogo del servidor no es válido');
    const warnings = [];
    if (!vanilla && now() >= nextVanillaAttempt) {
      try { vanilla = await vanillaLoader({ serverDir, panelDir:localPanel, minecraftVersion }); }
      catch { nextVanillaAttempt = now() + 5 * 60 * 1000; warnings.push('No se pudo cargar todavía el idioma español de Minecraft.'); }
    }
    const resources = await resourceLoader({ serverDir, jars, snapshot });
    const languages = Object.fromEntries([...Object.values(LOCALES), 'es_mx'].map(locale => [locale, { ...dictionary(vanilla?.[locale]) }]));
    Object.assign(languages.en_us, dictionary(resources.english));
    const locales = language === 'es' ? ['es_es', 'es_mx', 'en_us'] : [LOCALES[language], 'en_us'];
    const translated = key => locales.map(locale => languages[locale][key]).find(Boolean);
    const currentJarNames = new Set(jars.map(jar => jar.name));
    for (const name of jarCache.keys()) if (!currentJarNames.has(name)) jarCache.delete(name);
    for (const jar of jars) {
      const key = jar.size + ':' + jar.modifiedAt;
      let cached = jarCache.get(jar.name);
      if (!cached || cached.key !== key) {
        try { cached = { key, languages: await languageLoader(jar.file) }; }
        catch { cached = { key, languages: {}, failed: true }; }
        jarCache.set(jar.name, cached);
      }
      if (cached.failed) warnings.push('No se pudieron leer algunas traducciones de mods.');
      for (const locale of [...Object.values(LOCALES), 'es_mx']) Object.assign(languages[locale], dictionary(cached.languages[locale]));
    }
    const mods = new Map((Array.isArray(snapshot.mods) ? snapshot.mods : []).map(mod => [mod.id, mod.name || mod.id]));
    const resolved = new Map();
    for (const item of snapshot.items) {
      if (!ITEM_ID.test(item.id) || item.id === 'minecraft:air' || item.id.length > 200) continue;
      const key = typeof item.translationKey === 'string' ? item.translationKey : '';
      const blockKey=key.replace(/^item\./,'block.');
      const spanish = translated(key) || translated(blockKey);
      const english = languages.en_us[key] || languages.en_us[blockKey];
      const fallback = typeof item.fallbackName === 'string' && item.fallbackName !== key ? item.fallbackName : '';
      let name = displayName(spanish || english || fallback || niceId(item.id)) || niceId(item.id);
      const detail = variantLabel(item.id, key, languages, locales);
      if (detail && normalize(detail) !== normalize(name)) name += ' — ' + detail;
      const spawnEgg = /(?:_|:)spawn_egg$|_spawn_egg$/.test(item.id);
      if (spawnEgg && /^Generar\s+/i.test(name)) name = name.replace(/^Generar\s+/i, 'Huevo generador de ');
      const namespace = item.id.split(':')[0], modName = mods.get(namespace) || (namespace === 'minecraft' ? 'Minecraft' : namespace);
      const data = { id: item.id, name, modName, maxStackSize: Math.max(1, Math.min(999, Number(item.maxStackSize) || 64)), translationSource: languages[LOCALES[language]][key] || languages[LOCALES[language]][blockKey] ? language : english ? 'en' : spanish ? 'es' : fallback ? 'server' : 'id' };
      resolved.set(item.id, { ...data, _name: normalize(name), _search: normalize([name, english, fallback, item.id, modName,
        spawnEgg ? 'huevo generador huevo de generacion spawn egg' : ''].filter(Boolean).join(' ')) });
    }
    if (resolved.has('minecraft:enchanted_book')) {
      const base = resolved.get('minecraft:enchanted_book');
      for (const enchantment of (resources.enchantments || []).slice(0, 10000)) {
        if (!ITEM_ID.test(enchantment.id) || !Number.isInteger(enchantment.maxLevel) || enchantment.maxLevel < 1 || enchantment.maxLevel > 255) continue;
        const key = enchantment.translationKey || 'enchantment.' + enchantment.id.replace(':', '.').replaceAll('/', '.');
        const title = displayName(translated(key) || enchantment.fallbackName || niceId(enchantment.id));
        for (let level = 1; level <= enchantment.maxLevel; level++) {
          if (resolved.size >= 100000) break;
          const number = translated('enchantment.level.' + level) || ['', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'][level] || String(level);
          const name = base.name + ' — ' + title + ' ' + number;
          const variant = enchantment.id + '@' + level;
          resolved.set('book#' + variant, { ...base, name, variant, enchantment: enchantment.id, level,
            _name: normalize(name), _search: normalize([base._search, name, key, enchantment.id, title + ' ' + level, title + ' ' + number].join(' ')) });
        }
      }
    }
    const items = distinguishNames([...resolved.values()]).sort((a, b) => a.name.localeCompare(b.name, 'es', { sensitivity: 'base', numeric: true }) || a.id.localeCompare(b.id));
    let pendingRestart = false;
    if (Array.isArray(snapshot.modFiles)) {
      const previous = [...snapshot.modFiles].sort((a, b) => a.name.localeCompare(b.name));
      pendingRestart = previous.length !== jars.length || previous.some((jar, index) => !jars[index] || jar.name !== jars[index].name || Number(jar.size) !== jars[index].size || Math.abs(Number(jar.modifiedAt) - jars[index].modifiedAt) > 1);
    } else pendingRestart = jars.some(jar => jar.modifiedAt > Number(snapshot.generatedAt) + 1000);
    if(snapshot.catalogScope==='vanilla-base')warnings.push('Catálogo base de Minecraft. Los objetos de mods requieren el puente compatible con este loader y versión.');
    status = { available: true, generatedAt: Number(snapshot.generatedAt), pendingRestart,
      message: pendingRestart ? 'Hay cambios en los mods. Reinicia Minecraft para incorporar los objetos nuevos o retirados.' : warnings.length ? [...new Set(warnings)].join(' ') : '',
      items, translated: items.filter(item => item.translationSource === 'es').length };
    currentSignature = jarSignature;
    registrySignature = snapshotSignature;
  }

  async function ensure(force = false) {
    if (inFlight) return inFlight;
    inFlight = rebuild(force).catch(() => {
      status = { ...status, message: status.available ? 'No se pudo actualizar el catálogo; se conserva la última lista válida.' : 'No se pudo leer el catálogo. Reinicia Minecraft para generarlo.' };
    }).finally(() => { inFlight = null; });
    return inFlight;
  }

  async function search({ q = '', limit = 40, offset = 0 } = {}) {
    if (typeof q !== 'string' || q.length > 150) { const e = new Error('Escribe una búsqueda de hasta 150 caracteres.'); e.status = 400; throw e; }
    const count = Math.max(1, Math.min(100, Math.floor(Number(limit) || 40)));
    const start = Math.max(0, Math.min(100000, Math.floor(Number(offset) || 0)));
    await ensure();
    const query = normalize(q), tokens = query.split(' ').filter(Boolean);
    let matched = status.items.filter(item => tokens.every(token => {
      if (item.variant && /^(?:i|ii|iii|iv|v|vi|vii|viii|ix|x|\d+)$/.test(token)) {
        const roman = ['', 'i', 'ii', 'iii', 'iv', 'v', 'vi', 'vii', 'viii', 'ix', 'x'][item.level];
        return token === String(item.level) || token === roman;
      }
      return item._search.includes(token);
    }));
    if (query) matched = [...matched].sort((a, b) => {
      const rank = item => item._name === query || (item.variant && normalize(item.name.split(' — ').slice(1).join(' — ')) === query) ? 0 : item._name.startsWith(query) ? 1 : item._name.includes(query) ? 2 : 3;
      return rank(a) - rank(b) || a.name.localeCompare(b.name, 'es', { sensitivity: 'base', numeric: true });
    });
    const items = matched.slice(start, start + count).map(({ _name, _search, ...item }) => item);
    return { items, total: matched.length, catalogTotal: status.items.length, generatedAt: status.generatedAt, available: status.available,
      pendingRestart: status.pendingRestart, message: status.message, translated: status.translated || 0, hasMore: start + items.length < matched.length };
  }

  async function giveArgument(id, variant = '') {
    await ensure();
    if (!await hasItem(id)) throw new Error('Objeto no disponible en el catálogo del servidor.');
    if (!variant) return id;
    const item = status.items.find(item => item.id === id && item.variant === variant);
    if (!item || !ITEM_ID.test(item.enchantment) || !Number.isInteger(item.level)) throw new Error('Variante de libro no disponible en el catálogo del servidor.');
    const [major, minor, patch = 0] = minecraftVersion.split('.').map(Number);
    if (major >= 26 || (major === 1 && (minor > 21 || (minor === 21 && patch >= 5)))) return id + '[minecraft:stored_enchantments={' + JSON.stringify(item.enchantment) + ':' + item.level + '}]';
    if (major === 1 && (minor >= 21 || (minor === 20 && patch >= 5))) return id + '[minecraft:stored_enchantments={levels:{' + JSON.stringify(item.enchantment) + ':' + item.level + '}}]';
    return id + '{StoredEnchantments:[{id:' + JSON.stringify(item.enchantment) + ',lvl:' + item.level + 's}]}';
  }

  async function hasItem(id) {
    if (typeof id !== 'string' || !ITEM_ID.test(id) || id.length > 200) return false;
    await ensure();
    return status.available && status.items.some(item => item.id === id);
  }

  async function handle(req, res, url, { sendJson }) {
    if (req.method !== 'GET' || url.pathname !== '/api/items') return false;
    try { sendJson(res, 200, await search({ q: url.searchParams.get('q') || '', limit: url.searchParams.get('limit'), offset: url.searchParams.get('offset') })); }
    catch (error) { sendJson(res, error.status || 500, { error: error.message }); }
    return true;
  }

  return { search, hasItem, giveArgument, handle, refresh: () => ensure(true) };
}

function createItemCatalog(options = {}) {
  const catalogs = new Map();
  const resources = options.resourceLoader || require('./item-resources').createResourceLoader(readZipEntries);
  function get(language = 'es') {
    if (!Object.hasOwn(LOCALES, language)) language = 'es';
    if (!catalogs.has(language)) catalogs.set(language, createLocalizedCatalog({ ...options, resourceLoader: resources, language }));
    return catalogs.get(language);
  }
  return {
    search: (query = {}) => get(query.language).search(query),
    hasItem: id => get().hasItem(id),
    giveArgument: (id, variant) => get().giveArgument(id, variant),
    refresh: async () => { for (const catalog of catalogs.values()) await catalog.refresh(); },
    async handle(req, res, url, { sendJson }) {
      if (req.method !== 'GET' || url.pathname !== '/api/items') return false;
      try { sendJson(res, 200, await get(url.searchParams.get('language')).search({ q: url.searchParams.get('q') || '', limit: url.searchParams.get('limit'), offset: url.searchParams.get('offset') })); }
      catch (error) { sendJson(res, error.status || 500, { error: error.message }); }
      return true;
    }
  };
}

module.exports = { createItemCatalog, normalize, readJarLanguages, readZipEntries, loadVanillaSpanish };
