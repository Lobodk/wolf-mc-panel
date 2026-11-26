'use strict';

const crypto = require('node:crypto');
const { createCurseForgeClient, httpFailure, networkFailure } = require('./curseforge-client');
const { createNetworkMonitor } = require('./network');
const { createPlayerTools } = require('./player-tools');
const { createItemCatalog } = require('./item-catalog');
const { createAutoModpackStatus } = require('./automodpack-status');
const { createServerFeatures } = require('./server-features');
const { createModStaging } = require('./mod-staging');
const { createStaticFiles } = require('./static-assets');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { spawn, execFile } = require('node:child_process');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { promisify } = require('node:util');
const execFileAsync = promisify(execFile);
const serveStaticFile = createStaticFiles(path.join(__dirname, 'public'));

function createPanelInstance(options = {}) {
const CODE_DIR = __dirname;
const SERVER_DIR = options.serverDir || path.resolve(CODE_DIR, '..');
const PANEL_DIR = options.panelDir || path.join(SERVER_DIR, 'panel');
fs.mkdirSync(PANEL_DIR, { recursive: true });
const RUNTIME_DIR = options.javaHome || path.join(SERVER_DIR, 'runtime');
const PUBLIC_DIR = path.join(CODE_DIR, 'public');
const MODS_DIR = path.join(SERVER_DIR, 'mods');
const autoModpackStatus = createAutoModpackStatus(SERVER_DIR);
const modStaging = createModStaging(SERVER_DIR,PANEL_DIR);
const bulkProgressContexts = new Map();
let activeBulkUpdate = '';
const LOG_FILE = path.join(SERVER_DIR, 'logs', 'latest.log');
const PROPERTIES_FILE = path.join(SERVER_DIR, 'server.properties');
const CONFIG_FILE = path.join(PANEL_DIR, 'panel-config.json');
const BACKUP_CONFIG_FILE = path.join(PANEL_DIR, 'backup-config.json');
const ACCESS_FILE = path.join(PANEL_DIR, 'panel-access.txt');
const JVM_ARGS_FILE = path.join(SERVER_DIR, 'user_jvm_args.txt');
const JVM_STATS_FILE = path.join(RUNTIME_DIR, 'bin', 'jstat.exe');
const POWERSHELL_EXE = path.join(
  process.env.WINDIR || 'C:\\Windows',
  'System32',
  'WindowsPowerShell',
  'v1.0',
  'powershell.exe',
);
const MAX_JSON_BYTES = 64 * 1024;
const MAX_MOD_BYTES = 300 * 1024 * 1024;
const BACKUP_DIR = path.join(options.appDataDir || os.homedir(), 'backups', ...(options.backupId ? [options.backupId] : []));
const MANUAL_BACKUP_DIR = path.join(BACKUP_DIR, 'Manuales');
const AUTOMATIC_BACKUP_DIR = path.join(BACKUP_DIR, 'Automáticas');
const NEOFORGE_BACKUP_DIR = path.join(BACKUP_DIR, 'NeoForge');
const RESTORE_BACKUP_DIR = path.join(BACKUP_DIR, 'Restauración');
const BACKUP_INTERVAL_MS = 4 * 60 * 60 * 1000;
const JAR_EXE = path.join(RUNTIME_DIR, 'bin', 'jar.exe');
let managedServerProcess = null;
let performanceCache = null;
let cpuSample = null;
let backupQueue = Promise.resolve();
let backupRunning = null;
let backupQueued = 0;
let autoBackupQueued = false;
let maintenanceLock = '';
const modDisplayCache = new Map();
const modOperationProgress = new Map();

function writePrivateFile(file, content) {
  fs.writeFileSync(file, content, { encoding: 'utf8', mode: 0o600 });
}

function readOrCreateConfig() {
  let config;
  if (fs.existsSync(CONFIG_FILE)) {
    config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } else {
    config = {};
  }

  if (options.panelToken) config.panelToken = options.panelToken;
  if (!config.panelToken) config.panelToken = crypto.randomBytes(32).toString('base64url');
  if (!config.rconPassword) config.rconPassword = crypto.randomBytes(32).toString('hex');
  if (!config.bindHost) config.bindHost = '0.0.0.0';
  if (!config.port) config.port = 8787;
  if (!config.rconHost) config.rconHost = '127.0.0.1';
  if (!config.rconPort) config.rconPort = 25575;
  if (!config.serverPort) config.serverPort = 25565;

  writePrivateFile(CONFIG_FILE, JSON.stringify(config, null, 2) + '\n');
  writePrivateFile(
    ACCESS_FILE,
    'Clave de acceso del panel local de Minecraft\n' +
      'No la compartas fuera de tu red.\n\n' +
      config.panelToken +
      '\n',
  );
  return config;
}

const config = readOrCreateConfig();
const gameOnline = () => options.remote?.isOnline() ?? tcpOpen(options.record?.bindAddress || '127.0.0.1', config.serverPort);
const networkMonitor = createNetworkMonitor({
  powershell: POWERSHELL_EXE,
  script: path.join(CODE_DIR, 'network-snapshot.ps1'),
  serverPort: config.serverPort,
  bridgeFile: path.join(PANEL_DIR, 'telemetry', 'network.json'),
  hostLabel: options.remote ? 'PC de destino' : 'PC del panel',
  readSample: options.remote ? async () => (await options.remote.metrics()).network : undefined,
});

function loadBackupConfig() {
  try {
    const stored = JSON.parse(fs.readFileSync(BACKUP_CONFIG_FILE, 'utf8'));
    return {
      automaticEnabled: stored.automaticEnabled === true,
      nextAt: stored.nextAt != null && Number.isFinite(Number(stored.nextAt)) ? Number(stored.nextAt) : null,
      lastBackup: stored.lastBackup && typeof stored.lastBackup === 'object' ? stored.lastBackup : null,
      lastError: typeof stored.lastError === 'string' ? stored.lastError : '',
    };
  } catch {
    return { automaticEnabled: false, nextAt: null, lastBackup: null, lastError: '' };
  }
}

const backupConfig = loadBackupConfig();
if (backupConfig.automaticEnabled && !backupConfig.nextAt) backupConfig.nextAt = Date.now() + BACKUP_INTERVAL_MS;

function persistBackupConfig() {
  const temp = BACKUP_CONFIG_FILE + '.tmp';
  writePrivateFile(temp, JSON.stringify(backupConfig, null, 2) + '\n');
  fs.renameSync(temp, BACKUP_CONFIG_FILE);
}

function setProperty(contents, key, value) {
  const lines = contents.split(/\r?\n/);
  const prefix = key + '=';
  let replaced = false;
  const next = lines.map((line) => {
    if (line.startsWith(prefix)) {
      if (!replaced) {
        replaced = true;
        return prefix + value;
      }
      return null;
    }
    return line;
  }).filter((line) => line !== null);
  if (!replaced) next.push(prefix + value);
  return next.join('\n').replace(/\n*$/, '\n');
}

function enableRconOnNextStart() {
  let contents = fs.readFileSync(PROPERTIES_FILE, 'utf8');
  const existing = new Map(contents.split(/\r?\n/).filter(line=>!/^\s*[#!]/.test(line)).map(line=>{const at=line.indexOf('=');return [line.slice(0,at),line.slice(at+1)];}));
  if(existing.get('enable-rcon')==='true' && existing.get('rcon.password')===config.rconPassword && existing.get('rcon.port')===String(config.rconPort))return;
  contents = setProperty(contents, 'enable-rcon', 'true');
  contents = setProperty(contents, 'rcon.password', config.rconPassword);
  contents = setProperty(contents, 'rcon.port', String(config.rconPort));
  const temp = PROPERTIES_FILE + '.panel-tmp';
  writePrivateFile(temp, contents);
  fs.renameSync(temp, PROPERTIES_FILE);
}

enableRconOnNextStart();

function ipToInt(ip) {
  const parts = ip.split('.');
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part) || Number(part) > 255)) {
    return null;
  }
  return parts.reduce((acc, part) => ((acc << 8n) | BigInt(part)), 0n);
}

function isLanAddress(remoteAddress) {
  if (!remoteAddress) return false;
  if (remoteAddress === '::1' || remoteAddress === '127.0.0.1') return true;
  let remote = remoteAddress.toLowerCase();
  if (remote.startsWith('::ffff:')) remote = remote.slice(7);
  const remoteInt = ipToInt(remote);
  if (remoteInt === null) return false;

  const interfaces = os.networkInterfaces();
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries || []) {
      if (entry.internal || entry.family !== 'IPv4') continue;
      const localInt = ipToInt(entry.address);
      const maskInt = ipToInt(entry.netmask);
      if (localInt === null || maskInt === null) continue;
      if ((remoteInt & maskInt) === (localInt & maskInt)) return true;
    }
  }
  return false;
}

function constantTimeTokenMatch(candidate) {
  if (typeof candidate !== 'string' || candidate.length > 512) return false;
  const expected = Buffer.from(config.panelToken, 'utf8');
  const supplied = Buffer.from(candidate, 'utf8');
  if (expected.length !== supplied.length) return false;
  return crypto.timingSafeEqual(expected, supplied);
}

function sendJson(res, status, body) {
  const data = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': data.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(data);
}

function validProgressId(value) {
  return typeof value === 'string' && /^[a-zA-Z0-9_-]{8,96}$/.test(value);
}

function updateModOperationProgress(id, fields) {
  if (!validProgressId(id)) return;
  const bulk = bulkProgressContexts.get(id);
  if (bulk) {
    fields = { ...fields, percent: Math.min(99, Math.round(10 + 90 * (bulk.index + (Number(fields.percent) || 0) / 100) / Math.max(bulk.items.length, 1))),
      done: false, items: bulk.items.map(item => ({ ...item })) };
  }
  modOperationProgress.set(id, {
    ...(modOperationProgress.get(id) || {}),
    ...fields,
    updatedAt: Date.now(),
    expiresAt: Date.now() + 10 * 60 * 1000,
  });
}

function readModOperationProgress(id) {
  if (!validProgressId(id)) return null;
  const progress = modOperationProgress.get(id);
  if (!progress) return null;
  if (progress.expiresAt < Date.now()) {
    modOperationProgress.delete(id);
    return null;
  }
  return progress;
}

function readJson(req, limit = MAX_JSON_BYTES) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('La petición es demasiado grande.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        reject(new Error('El JSON recibido no es válido.'));
      }
    });
    req.on('error', reject);
  });
}

function makeRconPacket(id, type, text) {
  const payload = Buffer.from(text, 'utf8');
  const packet = Buffer.alloc(payload.length + 14);
  packet.writeInt32LE(payload.length + 10, 0);
  packet.writeInt32LE(id, 4);
  packet.writeInt32LE(type, 8);
  payload.copy(packet, 12);
  packet[packet.length - 2] = 0;
  packet[packet.length - 1] = 0;
  return packet;
}

async function rconCommand(command, timeoutMs = 5000) {
  await options.remote?.ensure({files:false});
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: config.rconHost, port: options.remote?.rconPort || config.rconPort });
    const authId = crypto.randomInt(1, 0x3fffffff);
    const commandId = authId + 1;
    let stage = 'auth';
    let buffer = Buffer.alloc(0);
    let finished = false;

    const finish = (error, value) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(value);
    };

    const timer = setTimeout(() => finish(new Error('RCON no respondió a tiempo.')), timeoutMs);
    socket.setTimeout(timeoutMs, () => finish(new Error('RCON agotó el tiempo de espera.')));
    socket.on('error', (error) => finish(error));
    socket.on('end', () => finish(new Error('Minecraft cerró la conexión RCON.')));
    socket.on('connect', () => {
      socket.write(makeRconPacket(authId, 3, config.rconPassword));
    });
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4) {
        const length = buffer.readInt32LE(0);
        if (length < 10 || length > 1024 * 1024) {
          finish(new Error('RCON devolvió un paquete no válido.'));
          return;
        }
        if (buffer.length < length + 4) return;
        const id = buffer.readInt32LE(4);
        const type = buffer.readInt32LE(8);
        const body = buffer.subarray(12, length + 2).toString('utf8');
        buffer = buffer.subarray(length + 4);

        if (stage === 'auth') {
          if (id === -1) {
            finish(new Error('La autenticación RCON falló.'));
            return;
          }
          if (id === authId && type === 2) {
            stage = 'command';
            socket.write(makeRconPacket(commandId, 2, command));
          }
        } else if (id === commandId && type === 0) {
          finish(null, body);
          return;
        }
      }
    });
  });
}

function tcpOpen(host, port, timeoutMs = 900) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, timeoutMs);
    socket.once('connect', () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

async function readArrayJson(file) {
  try {
    const parsed = JSON.parse(await fsp.readFile(file, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function listMods({ includeCurseForgeMetadata = false, metadataStatus = null, metadataProgressId = '', onlyName = '', onlyNames = null } = {}) {
  const entries = await fsp.readdir(MODS_DIR, { withFileTypes: true });
  const mods = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.jar')) continue;
    const file = path.join(MODS_DIR, entry.name);
    const stat = await fsp.stat(file);
    mods.push({
      name: entry.name,
      displayName: await getJarDisplayName(file, entry.name, stat),
      curseForgeMatched: false,
      curseForgeLogo: '',
      curseForgeUrl: '',
      curseForgeSummary: '',
      bytes: stat.size,
      addedAt: stat.birthtime.toISOString(),
      modified: stat.mtime.toISOString(),
    });
  }
  const sortedAll = mods.sort((a, b) => a.name.localeCompare(b.name));
  const sorted = onlyNames
    ? sortedAll.filter((mod) => onlyNames.has(mod.name))
    : onlyName ? sortedAll.filter((mod) => mod.name === onlyName) : sortedAll;
  if (includeCurseForgeMetadata && getCurseForgeKey() && sorted.length) {
    try {
      const metadata = await getCurseForgeMetadataForMods(sorted, metadataProgressId);
      for (const mod of sorted) {
        const project = metadata.get(mod.name);
        if (!project) continue;
        mod.displayName = project.name || mod.displayName;
        mod.curseForgeMatched = true;
        mod.curseForgeLogo = project.logo;
        mod.curseForgeUrl = project.url;
        mod.curseForgeSummary = project.summary;
      }
      if (metadata.error && metadataStatus) metadataStatus.error = metadata.error;
    } catch (error) {
      console.error('No se pudieron cargar las fichas de CurseForge para los mods:', error.message);
      if (metadataStatus) metadataStatus.error = error.message;
    }
  }
  for (const mod of sorted) {
    if (!mod.curseForgeSummary) {
      mod.curseForgeSummary = await getJarDescription(path.join(MODS_DIR, mod.name), mod.name);
    }
  }
  return sorted;
}

function fallbackModName(fileName) {
  return path.basename(fileName, '.jar')
    .replace(/[-_.]+/g, ' ')
    .replace(/\b(mc|neoforge|forge)\b/ig, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/(^|\s)\S/g, (letter) => letter.toUpperCase()) || fileName;
}

async function readJarEntry(handle, localOffset, compressedSize, method, fileName) {
  const local = Buffer.alloc(30);
  const { bytesRead } = await handle.read(local, 0, local.length, localOffset);
  if (bytesRead !== local.length || local.readUInt32LE(0) !== 0x04034b50) return null;
  const nameLength = local.readUInt16LE(26);
  const extraLength = local.readUInt16LE(28);
  const start = localOffset + 30 + nameLength + extraLength;
  const compressed = Buffer.alloc(compressedSize);
  const result = await handle.read(compressed, 0, compressedSize, start);
  if (result.bytesRead !== compressedSize) return null;
  let contents;
  if (method === 0) contents = compressed;
  else if (method === 8) contents = zlib.inflateRawSync(compressed, { maxOutputLength: 1024 * 1024 });
  else return null;
  return contents.toString('utf8');
}

async function getJarDisplayName(file, fileName, stat) {
  const cacheKey = stat.size + ':' + stat.mtimeMs;
  const cached = modDisplayCache.get(fileName);
  if (cached?.key === cacheKey) return cached.value;
  let displayName = '';
  let handle;
  try {
    handle = await fsp.open(file, 'r');
    const tailLength = Math.min(stat.size, 0xffff + 22);
    const tail = Buffer.alloc(tailLength);
    await handle.read(tail, 0, tailLength, stat.size - tailLength);
    let eocd = -1;
    for (let i = tail.length - 22; i >= Math.max(0, tail.length - 0xffff - 22); i -= 1) {
      if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd >= 0) {
      const entryCount = tail.readUInt16LE(eocd + 10);
      const directorySize = tail.readUInt32LE(eocd + 12);
      const directoryOffset = tail.readUInt32LE(eocd + 16);
      if (directorySize <= 16 * 1024 * 1024 && directoryOffset + directorySize <= stat.size) {
        const directory = Buffer.alloc(directorySize);
        await handle.read(directory, 0, directorySize, directoryOffset);
        let cursor = 0;
        for (let i = 0; i < entryCount && cursor + 46 <= directory.length; i += 1) {
          if (directory.readUInt32LE(cursor) !== 0x02014b50) break;
          const method = directory.readUInt16LE(cursor + 10);
          const compressedSize = directory.readUInt32LE(cursor + 20);
          const uncompressedSize = directory.readUInt32LE(cursor + 24);
          const nameLength = directory.readUInt16LE(cursor + 28);
          const extraLength = directory.readUInt16LE(cursor + 30);
          const commentLength = directory.readUInt16LE(cursor + 32);
          const localOffset = directory.readUInt32LE(cursor + 42);
          const entryName = directory.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
          if ((entryName === 'META-INF/neoforge.mods.toml' || entryName === 'META-INF/mods.toml' || entryName === 'fabric.mod.json') &&
              compressedSize <= 1024 * 1024 && uncompressedSize <= 1024 * 1024) {
            const toml = await readJarEntry(handle, localOffset, compressedSize, method, entryName);
            if(entryName==='fabric.mod.json'){const metadata=JSON.parse(toml);displayName=typeof metadata.name==='string'?metadata.name:'';break;}
            const modsSection = toml?.split(/^\s*\[\[mods\]\]\s*$/m)[1] || toml || '';
            const match = /^\s*displayName\s*=\s*"((?:\\.|[^"\\])*)"/m.exec(modsSection);
            if (match && !match[1].includes('${')) displayName = match[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\');
            break;
          }
          cursor += 46 + nameLength + extraLength + commentLength;
        }
      }
    }
  } catch {} finally {
    await handle?.close().catch(() => {});
  }
  displayName = displayName.trim() || fallbackModName(fileName);
  modDisplayCache.set(fileName, { key: cacheKey, value: displayName });
  return displayName;
}

async function getJarDescription(file, fileName) {
  let handle;
  try {
    const stat = await fsp.stat(file);
    const cacheKey = stat.size + ':' + stat.mtimeMs;
    const cached = modDisplayCache.get(fileName);
    if (cached?.key === cacheKey && typeof cached.description === 'string') return cached.description;
    handle = await fsp.open(file, 'r');
    const tailLength = Math.min(stat.size, 0xffff + 22);
    const tail = Buffer.alloc(tailLength);
    await handle.read(tail, 0, tailLength, stat.size - tailLength);
    let eocd = -1;
    for (let i = tail.length - 22; i >= Math.max(0, tail.length - 0xffff - 22); i -= 1) {
      if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) return '';
    const entryCount = tail.readUInt16LE(eocd + 10);
    const directorySize = tail.readUInt32LE(eocd + 12);
    const directoryOffset = tail.readUInt32LE(eocd + 16);
    if (directorySize > 16 * 1024 * 1024 || directoryOffset + directorySize > stat.size) return '';
    const directory = Buffer.alloc(directorySize);
    await handle.read(directory, 0, directorySize, directoryOffset);
    let cursor = 0;
    for (let i = 0; i < entryCount && cursor + 46 <= directory.length; i += 1) {
      if (directory.readUInt32LE(cursor) !== 0x02014b50) break;
      const method = directory.readUInt16LE(cursor + 10);
      const compressedSize = directory.readUInt32LE(cursor + 20);
      const uncompressedSize = directory.readUInt32LE(cursor + 24);
      const nameLength = directory.readUInt16LE(cursor + 28);
      const extraLength = directory.readUInt16LE(cursor + 30);
      const commentLength = directory.readUInt16LE(cursor + 32);
      const localOffset = directory.readUInt32LE(cursor + 42);
      const entryName = directory.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
      if ((entryName === 'META-INF/neoforge.mods.toml' || entryName === 'META-INF/mods.toml') &&
          compressedSize <= 1024 * 1024 && uncompressedSize <= 1024 * 1024) {
        const toml = await readJarEntry(handle, localOffset, compressedSize, method, entryName);
        const match = /^\s*description\s*=\s*(?:"((?:\\.|[^"\\])*)"|'''([\s\S]*?)'''|"""([\s\S]*?)""")/im.exec(toml || '');
        const description = (match?.[1] ?? match?.[2] ?? match?.[3] ?? '')
          .replace(/\\"/g, '"')
          .replace(/\\\\/g, '\\')
          .trim();
        const current = modDisplayCache.get(fileName);
        modDisplayCache.set(fileName, {
          ...(current?.key === cacheKey ? current : {}),
          key: cacheKey,
          description,
        });
        return description;
      }
      cursor += 46 + nameLength + extraLength + commentLength;
    }
  } catch {} finally {
    await handle?.close().catch(() => {});
  }
  return '';
}

async function getJarCurseForgeSlug(file) {
  let handle;
  try {
    const stat = await fsp.stat(file);
    handle = await fsp.open(file, 'r');
    const tailLength = Math.min(stat.size, 0xffff + 22);
    const tail = Buffer.alloc(tailLength);
    await handle.read(tail, 0, tailLength, stat.size - tailLength);
    let eocd = -1;
    for (let i = tail.length - 22; i >= Math.max(0, tail.length - 0xffff - 22); i -= 1) {
      if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) return '';
    const entryCount = tail.readUInt16LE(eocd + 10);
    const directorySize = tail.readUInt32LE(eocd + 12);
    const directoryOffset = tail.readUInt32LE(eocd + 16);
    if (directorySize > 16 * 1024 * 1024 || directoryOffset + directorySize > stat.size) return '';
    const directory = Buffer.alloc(directorySize);
    await handle.read(directory, 0, directorySize, directoryOffset);
    let cursor = 0;
    for (let i = 0; i < entryCount && cursor + 46 <= directory.length; i += 1) {
      if (directory.readUInt32LE(cursor) !== 0x02014b50) break;
      const method = directory.readUInt16LE(cursor + 10);
      const compressedSize = directory.readUInt32LE(cursor + 20);
      const uncompressedSize = directory.readUInt32LE(cursor + 24);
      const nameLength = directory.readUInt16LE(cursor + 28);
      const extraLength = directory.readUInt16LE(cursor + 30);
      const commentLength = directory.readUInt16LE(cursor + 32);
      const localOffset = directory.readUInt32LE(cursor + 42);
      const entryName = directory.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
      if ((entryName === 'META-INF/neoforge.mods.toml' || entryName === 'META-INF/mods.toml') &&
          compressedSize <= 1024 * 1024 && uncompressedSize <= 1024 * 1024) {
        const toml = await readJarEntry(handle, localOffset, compressedSize, method, entryName);
        const match = /^\s*displayURL\s*=\s*"((?:\\.|[^"\\])*)"/im.exec(toml || '');
        if (!match) return '';
        try {
          const parsed = new URL(match[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\'));
          if (parsed.protocol !== 'https:' || !(parsed.hostname === 'curseforge.com' || parsed.hostname.endsWith('.curseforge.com'))) return '';
          return /^\/minecraft\/mc-mods\/([^/]+)/i.exec(parsed.pathname)?.[1] || '';
        } catch { return ''; }
      }
      cursor += 46 + nameLength + extraLength + commentLength;
    }
  } catch {} finally {
    await handle?.close().catch(() => {});
  }
  return '';
}

function backupStatus() {
  return {
    directory: BACKUP_DIR,
    automaticEnabled: backupConfig.automaticEnabled,
    intervalHours: 4,
    nextAt: backupConfig.nextAt,
    lastBackup: backupConfig.lastBackup,
    lastError: backupConfig.lastError,
    running: backupRunning,
    queued: backupQueued,
  };
}

async function listBackups() {
  const locations = [
    { directory: BACKUP_DIR, label: '' },
    { directory: MANUAL_BACKUP_DIR, label: 'Manuales' },
    { directory: AUTOMATIC_BACKUP_DIR, label: 'Automáticas' },
    { directory: NEOFORGE_BACKUP_DIR, label: 'NeoForge' },
    { directory: RESTORE_BACKUP_DIR, label: 'Restauración' },
  ];
  await Promise.all(locations.map(({ directory }) => fsp.mkdir(directory, { recursive: true })));
  const backups = [];
  for (const location of locations) {
    const entries = await fsp.readdir(location.directory, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !/^lobodk-servidor_.*\.zip$/i.test(entry.name)) continue;
      const fullPath = path.join(location.directory, entry.name);
      const stat = await fsp.stat(fullPath);
      const relativeName = path.relative(BACKUP_DIR, fullPath);
      backups.push({ name: relativeName, bytes: stat.size, createdAt: stat.mtime.toISOString() });
    }
  }
  return backups.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 8);
}

function timestampForFile() {
  const date = new Date();
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return local.toISOString().replace(/[:T.]/g, '-').replace(/Z$/, '');
}

async function createServerBackup(kind) {
  const label = kind === 'automatica'
    ? 'automatica'
    : kind === 'neoforge'
      ? 'neoforge'
      : kind === 'pre-restore'
        ? 'pre-restauracion'
        : 'manual';
  const outputDirectory = kind === 'manual'
    ? MANUAL_BACKUP_DIR
    : kind === 'automatica'
      ? AUTOMATIC_BACKUP_DIR
      : kind === 'neoforge'
        ? NEOFORGE_BACKUP_DIR
        : kind === 'pre-restore'
          ? RESTORE_BACKUP_DIR
          : BACKUP_DIR;
  await fsp.mkdir(outputDirectory, { recursive: true });
  const archiveName = kind === 'automatica'
    ? 'lobodk-servidor_automatica.zip'
    : kind === 'pre-restore'
      ? 'lobodk-servidor_pre-restauracion.zip'
      : 'lobodk-servidor_' + timestampForFile() + '_' + label + '.zip';
  const finalPath = path.join(outputDirectory, archiveName);
  const partialPath = path.join(outputDirectory, '.' + archiveName + '.partial.zip');
  await fsp.rm(partialPath, { force: true });
  const candidates = [
    'world', 'mods', 'config', 'defaultconfigs', 'datapacks', 'server.properties', 'user_jvm_args.txt',
    'ops.json', 'whitelist.json', 'banned-players.json', 'banned-ips.json', 'eula.txt', 'run.bat', 'run.sh', 'server-icon.png', 'server.jar', 'fabric-server-launch.jar',
  ];
  if (kind === 'neoforge' || kind === 'pre-restore') candidates.push('libraries');
  const include = [];
  for (const name of candidates) {
    try { await fsp.access(path.join(SERVER_DIR, name)); include.push(name); } catch {}
  }
  if (!include.includes('world') && kind !== 'platform') throw new Error('No existe la carpeta world del servidor; no se ha creado la copia.');
  let saveDisabled = false;
  if (await gameOnline()) {
    const announcement = kind === 'manual'
      ? 'Realizando copia manual del servidor'
      : kind === 'automatica'
        ? 'Realizando copia del servidor'
        : '';
    if (announcement) {
      await rconCommand('say ' + announcement, 8000).catch((error) => {
        console.error('No se pudo anunciar la copia en el chat:', error.message);
      });
    }
    try {
      await rconCommand('save-off', 8000);
      saveDisabled = true;
      await rconCommand('save-all flush', 20000);
    } catch (error) {
      if (saveDisabled) await rconCommand('save-on', 8000).catch(() => '');
      throw new Error('No se pudo congelar y guardar el mundo por RCON; no he creado la copia para evitar un ZIP inconsistente. ' + error.message);
    }
  }
  if (options.remote && !saveDisabled) await options.remote.confirmStopped();
  try {
    const zipArgs = ['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(CODE_DIR,'backup-zip.ps1'),'-Action','Create','-Archive',partialPath,'-SourceRoot',SERVER_DIR,'-EntriesJson',JSON.stringify(include)];
    await execFileAsync(POWERSHELL_EXE, zipArgs, {
      cwd: options.remote ? CODE_DIR : SERVER_DIR,
      timeout: 30 * 60 * 1000,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    });
    await fsp.rename(partialPath, finalPath);
    if (kind === 'automatica') await removeOlderAutomaticBackups(finalPath);
  } catch (error) {
    await fsp.rm(partialPath, { force: true }).catch(() => {});
    const details = String(error.stderr || error.stdout || error.message || 'error de compresión').trim();
    throw new Error('No se pudo completar el archivo ZIP de la copia: ' + details.slice(-1200));
  } finally {
    if (saveDisabled) await rconCommand('save-on', 8000).catch((error) => {
      console.error('No se pudo reactivar save-on después de la copia:', error.message);
    });
  }
  const stat = await fsp.stat(finalPath);
  return { name: path.relative(BACKUP_DIR, finalPath), bytes: stat.size, createdAt: stat.mtime.toISOString(), kind: label };
}

async function removeOlderAutomaticBackups(currentPath) {
  const automaticArchive = /^lobodk-servidor_(?:.*_)?automatica\.zip$/i;
  for (const directory of [BACKUP_DIR, AUTOMATIC_BACKUP_DIR]) {
    const entries = await fsp.readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isFile() || !automaticArchive.test(entry.name)) continue;
      const file = path.join(directory, entry.name);
      if (path.resolve(file) === path.resolve(currentPath)) continue;
      await fsp.rm(file, { force: true }).catch((error) => {
        console.error('No se pudo borrar una copia automática antigua:', error.message);
      });
    }
  }
}

function restoreRequestError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

async function resolveBackupArchive(name) {
  if (typeof name !== 'string' || name.length > 300) {
    throw restoreRequestError('Elige una copia de seguridad válida.');
  }
  const parts = name.replace(/\\/g, '/').split('/');
  if (parts.some((part) => !part || part === '.' || part === '..') || (parts.length !== 1 && parts.length !== 2)) {
    throw restoreRequestError('La ruta de la copia no es válida.');
  }
  const folderMap = new Map([
    ['manuales', MANUAL_BACKUP_DIR],
    ['automáticas', AUTOMATIC_BACKUP_DIR],
    ['neoforge', NEOFORGE_BACKUP_DIR],
    ['restauración', RESTORE_BACKUP_DIR],
  ]);
  let directory = BACKUP_DIR;
  let fileName = parts[0];
  if (parts.length === 2) {
    directory = folderMap.get(parts[0].toLocaleLowerCase('es-ES'));
    fileName = parts[1];
    if (!directory) throw restoreRequestError('La carpeta de la copia no está permitida.');
  }
  if (!/^lobodk-servidor_[a-z0-9_.-]+\.zip$/i.test(fileName)) {
    throw restoreRequestError('El archivo no es una copia ZIP reconocida.');
  }
  const archivePath = path.resolve(directory, fileName);
  const relative = path.relative(BACKUP_DIR, archivePath);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw restoreRequestError('La ruta de la copia queda fuera de Documentos.');
  }
  let stat;
  try {
    stat = await fsp.lstat(archivePath);
  } catch {
    throw restoreRequestError('No se encuentra esa copia. Actualiza la lista e inténtalo de nuevo.', 404);
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw restoreRequestError('La copia seleccionada no es un archivo normal.');
  }
  return archivePath;
}

async function readRestorableArchiveEntries(archivePath) {
  let stdout;
  try {
    ({ stdout } = await execFileAsync(POWERSHELL_EXE, ['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(CODE_DIR,'backup-zip.ps1'),'-Action','List','-Archive',archivePath], {
      timeout: 5 * 60 * 1000,
      windowsHide: true,
      maxBuffer: 64 * 1024 * 1024,
    }));
  } catch (error) {
    const details = String(error.stderr || error.stdout || error.message || '').trim();
    throw restoreRequestError('No se pudo leer el ZIP seleccionado. ' + details.slice(-800));
  }
  const allowedRoots = new Set([
    'world', 'mods', 'config', 'defaultconfigs', 'datapacks', 'server.properties', 'user_jvm_args.txt',
    'ops.json', 'whitelist.json', 'banned-players.json', 'banned-ips.json', 'eula.txt', 'run.bat', 'run.sh', 'server.jar', 'fabric-server-launch.jar',
    'server-icon.png', 'libraries',
  ]);
  const entries = new Set();
  const roots = new Set();
  for (const rawEntry of JSON.parse(stdout)) {
    let entry = rawEntry.trim().replace(/\\/g, '/');
    if (!entry) continue;
    if (entry.startsWith('/') || /^[a-z]:/i.test(entry)) {
      throw restoreRequestError('La copia contiene una ruta absoluta y no se puede restaurar.');
    }
    if (entry.endsWith('/')) entry = entry.slice(0, -1);
    const segments = entry.split('/');
    const hasUnsafeSegment = segments.some((segment) =>
      !segment || segment === '.' || segment === '..' || /[<>:"|?*\x00-\x1f]/.test(segment) || /[ .]$/.test(segment) ||
      /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(segment));
    if (hasUnsafeSegment) {
      throw restoreRequestError('La copia contiene una ruta no segura y no se puede restaurar.');
    }
    if (!allowedRoots.has(segments[0])) {
      throw restoreRequestError('La copia contiene contenido ajeno al servidor: ' + segments[0]);
    }
    const normalized = segments.join('/').toLowerCase();
    if (entries.has(normalized)) throw restoreRequestError('La copia contiene rutas duplicadas y no se puede restaurar.');
    entries.add(normalized);
    roots.add(segments[0]);
  }
  if (!roots.has('world')) throw restoreRequestError('La copia no contiene el mundo del servidor.');
  return [...roots];
}

async function assertNoSymlinks(directory) {
  const entries = await fsp.readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw restoreRequestError('La copia contiene un enlace simbólico y no se puede restaurar.');
    if (entry.isDirectory()) await assertNoSymlinks(fullPath);
  }
}

async function restoreServerBackup(name) {
  const archivePath = await resolveBackupArchive(name);
  const roots = await readRestorableArchiveEntries(archivePath);
  const restoreId = Date.now() + '-' + crypto.randomBytes(5).toString('hex');
  const stageDirectory = path.join(SERVER_DIR, '.restore-staging-' + restoreId);
  const rollbackDirectory = path.join(SERVER_DIR, '.restore-rollback-' + restoreId);
  const movedEntries = [];
  let serverWasRunning = false;
  let serverStopped = false;
  let restoreCommitted = false;
  let preserveRollback = false;
  await fsp.mkdir(stageDirectory, { recursive: true });
  try {
    const destination = stageDirectory.endsWith(path.sep) ? stageDirectory : stageDirectory + path.sep;
    try {
      await execFileAsync(POWERSHELL_EXE, ['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(CODE_DIR,'backup-zip.ps1'),'-Action','Extract','-Archive',archivePath,'-SourceRoot',destination], {
        timeout: 30 * 60 * 1000,
        windowsHide: true,
        maxBuffer: 1024 * 1024,
      });
    } catch (error) {
      const details = String(error.stderr || error.stdout || error.message || '').trim();
      throw restoreRequestError('No se pudo extraer la copia seleccionada. ' + details.slice(-800));
    }
    await assertNoSymlinks(stageDirectory);
    const stagedWorld = await fsp.stat(path.join(stageDirectory, 'world'));
    if (!stagedWorld.isDirectory()) throw restoreRequestError('La copia no contiene una carpeta world válida.');

    serverWasRunning = await tcpOpen(options.record?.bindAddress || '127.0.0.1', config.serverPort);
    let stoppingPid=0;
    for(const name of ['telemetry/network.json','managed-process.json']){try{const value=Number(JSON.parse(await fsp.readFile(path.join(PANEL_DIR,name),'utf8')).pid);if(Number.isSafeInteger(value)&&value>0){stoppingPid=value;break;}}catch{}}
    const stoppingProcessAlive=()=>{if(!stoppingPid)return false;try{process.kill(stoppingPid,0);return true;}catch(error){return error.code!=='ESRCH';}};
    if(!serverWasRunning && stoppingProcessAlive())throw restoreRequestError('Java sigue arrancando o apagando este servidor. Espera y revisa la consola.',409);
    if (serverWasRunning) {
      await rconCommand('save-all', 10000);
      await rconCommand('stop', 8000).catch(() => '');
      await waitUntil(
        async () => !(await tcpOpen(options.record?.bindAddress || '127.0.0.1', config.serverPort)) && !stoppingProcessAlive(),
        120000,
        'Minecraft no se apagó a tiempo. No se modificó ningún archivo del servidor.',
      );
      serverStopped = true;
    }

    const safetyBackup = await createServerBackup('pre-restore');
    backupConfig.lastBackup = safetyBackup;
    backupConfig.lastError = '';
    persistBackupConfig();

    await fsp.mkdir(rollbackDirectory, { recursive: true });
    for (const root of roots) {
      const stagedPath = path.join(stageDirectory, root);
      const currentPath = path.join(SERVER_DIR, root);
      const previousPath = path.join(rollbackDirectory, root);
      let hadPrevious = false;
      try {
        await fsp.lstat(currentPath);
        await fsp.rename(currentPath, previousPath);
        hadPrevious = true;
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      const move = { currentPath, previousPath, hadPrevious, installed: false };
      movedEntries.push(move);
      await fsp.rename(stagedPath, currentPath);
      move.installed = true;
    }

    if (backupConfig.automaticEnabled) backupConfig.nextAt = Date.now() + BACKUP_INTERVAL_MS;
    persistBackupConfig();
    restoreCommitted = true;
    await fsp.rm(rollbackDirectory, { recursive: true, force: true }).catch((error) => {
      console.error('No se pudo eliminar la carpeta temporal de reversión:', error.message);
    });
    return {
      restored: path.relative(BACKUP_DIR, archivePath),
      safetyBackup: safetyBackup.name,
      message: 'Copia restaurada. Minecraft está apagado; inícialo desde el panel cuando quieras.',
    };
  } catch (error) {
    let rollbackError = null;
    if (!restoreCommitted) {
      for (const entry of movedEntries.reverse()) {
        try {
          if (entry.installed) await fsp.rm(entry.currentPath, { recursive: true, force: true });
          if (entry.hadPrevious) await fsp.rename(entry.previousPath, entry.currentPath);
        } catch (restoreError) {
          rollbackError = restoreError;
          preserveRollback = true;
          break;
        }
      }
    }
    if (rollbackError) {
      throw new Error('La restauración falló y no se pudo reponer automáticamente el estado anterior. Los datos conservados están en ' + rollbackDirectory + '. ' + rollbackError.message);
    }
    if (serverWasRunning && serverStopped && !restoreCommitted && !preserveRollback) {
      await launchServer();
    }
    throw error;
  } finally {
    await fsp.rm(stageDirectory, { recursive: true, force: true }).catch(() => {});
    if (!preserveRollback) await fsp.rm(rollbackDirectory, { recursive: true, force: true }).catch(() => {});
  }
}

function enqueueBackup(kind) {
  if (options.externalBusy?.() && kind !== 'platform') return Promise.reject(new Error('Espera a que termine la instalación de este servidor.'));
  if (maintenanceLock && kind !== 'neoforge') return Promise.reject(new Error('Espera a que termine la actualización antes de crear otra copia.'));
  backupQueued += 1;
  const job = backupQueue.then(async () => {
    backupQueued = Math.max(0, backupQueued - 1);
    if (maintenanceLock && kind !== 'neoforge') {
      if (kind === 'automatica') autoBackupQueued = false;
      throw new Error('Espera a que termine la actualización antes de crear otra copia.');
    }
    if (kind === 'automatica' && !backupConfig.automaticEnabled) return { skipped: true };
    backupRunning = { kind, startedAt: new Date().toISOString() };
    try {
      const result = await createServerBackup(kind);
      backupConfig.lastBackup = result;
      backupConfig.lastError = '';
      if (kind === 'automatica' && backupConfig.automaticEnabled) backupConfig.nextAt = Date.now() + BACKUP_INTERVAL_MS;
      persistBackupConfig();
      return result;
    } catch (error) {
      backupConfig.lastError = error.message;
      if (kind === 'automatica' && backupConfig.automaticEnabled) backupConfig.nextAt = Date.now() + 15 * 60 * 1000;
      persistBackupConfig();
      throw error;
    } finally {
      backupRunning = null;
      if (kind === 'automatica') autoBackupQueued = false;
    }
  });
  backupQueue = job.catch(() => {});
  return job;
}

const backupScheduler = setInterval(() => {
  if (maintenanceLock || options.externalBusy?.() || !backupConfig.automaticEnabled || !backupConfig.nextAt || Date.now() < backupConfig.nextAt || autoBackupQueued) return;
  autoBackupQueued = true;
  enqueueBackup('automatica').catch((error) => console.error('Copia automática fallida:', error.message));
}, 30000);
backupScheduler.unref();

const CURSEFORGE_CONFIG_FILE = path.join(options.appDataDir || CODE_DIR, 'curseforge-config.json');
const CURSEFORGE_GAME_ID = 432;
const CURSEFORGE_MINECRAFT_CLASS_ID = 6;
const CURSEFORGE_MC_VERSION = options.record?.minecraftVersion || '26.3';
const CURSEFORGE_LOADER_ID = ({ neoforge: 6, forge: 1, fabric: 4 })[options.record?.loader || 'neoforge'] || 0;
const NEOFORGE_METADATA_URL = 'https://maven.neoforged.net/releases/net/neoforged/neoforge/maven-metadata.xml';

function getCurseForgeKey() {
  try {
    const stored = JSON.parse(fs.readFileSync(CURSEFORGE_CONFIG_FILE, 'utf8'));
    return typeof stored.apiKey === 'string' ? stored.apiKey : '';
  } catch { return ''; }
}

function saveCurseForgeKey(apiKey) {
  const temp = CURSEFORGE_CONFIG_FILE + '.tmp';
  writePrivateFile(temp, JSON.stringify({ apiKey }, null, 2) + '\n');
  fs.renameSync(temp, CURSEFORGE_CONFIG_FILE);
}

const { request: curseForgeFetch } = createCurseForgeClient({ getApiKey: getCurseForgeKey });

function normalizeCurseForgeName(value) {
  let normalized = String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\b(?:api|standalone|minecraft|neoforge|forge|fabric|mc)\b/g, ' ')
    .replace(/\bv?\d+(?:[._-]\d+)*(?:-[a-z0-9]+)?\b/g, ' ')
    .replace(/[^a-z0-9]+/g, '');
  if (normalized.endsWith('mc') && normalized.length > 2) normalized = normalized.slice(0, -2);
  return normalized;
}

function curseForgeSearchName(value) {
  return String(value || '')
    .replace(/\b(?:api|standalone|minecraft|neoforge|forge|fabric|mc)\b/ig, ' ')
    .replace(/\bv?\d+(?:[._-]\d+)*(?:-[a-z0-9]+)?\b/ig, ' ')
    .replace(/[-_.]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function searchCurseForgeProjectByInstalledName(displayName) {
  const query = curseForgeSearchName(displayName);
  const normalizedQuery = normalizeCurseForgeName(displayName);
  if (query.length < 2 || !normalizedQuery) return null;
  const params = new URLSearchParams({
    gameId: String(CURSEFORGE_GAME_ID),
    classId: String(CURSEFORGE_MINECRAFT_CLASS_ID),
    searchFilter: query,
    pageSize: '50',
  });
  const results = await curseForgeFetch('/mods/search?' + params.toString());
  const project = (results || [])
    .filter((candidate) => {
      const name = normalizeCurseForgeName(candidate.name);
      const slug = normalizeCurseForgeName(candidate.slug);
      return name === normalizedQuery || slug === normalizedQuery ||
        name.startsWith(normalizedQuery);
    })
    .sort((left, right) => Number(right.downloadCount || 0) - Number(left.downloadCount || 0))[0];
  if (!project) return null;
  const website = project.links?.websiteUrl || '';
  let url = '';
  try {
    const parsed = new URL(website);
    if (parsed.protocol === 'https:' && (parsed.hostname === 'curseforge.com' || parsed.hostname.endsWith('.curseforge.com'))) url = parsed.href;
  } catch {}
  return {
    id: project.id,
    slug: project.slug || '',
    name: project.name || '',
    summary: project.summary || '',
    logo: project.logo?.thumbnailUrl || project.logo?.url || '',
    url,
    downloads: project.downloadCount || 0,
  };
}

function curseForgeModSlugFromUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) {
    throw new Error('Pega una URL de CurseForge válida.');
  }
  const input = value.trim();
  let parsed;
  try {
    parsed = new URL(/^https?:\/\//i.test(input) ? input : 'https://' + input);
  } catch {
    throw new Error('No reconozco esa URL. Pega el enlace de la página del mod en CurseForge.');
  }
  if (parsed.protocol !== 'https:' ||
      !(parsed.hostname === 'curseforge.com' || parsed.hostname.endsWith('.curseforge.com'))) {
    throw new Error('La URL debe pertenecer a CurseForge.');
  }
  const parts = parsed.pathname.split('/').filter(Boolean);
  if (parts[0]?.toLowerCase() !== 'minecraft' || parts[1]?.toLowerCase() !== 'mc-mods' || !parts[2]) {
    throw new Error('Usa el enlace de un mod de Minecraft, por ejemplo curseforge.com/minecraft/mc-mods/nombre-del-mod.');
  }
  let slug;
  try { slug = decodeURIComponent(parts[2]).toLowerCase(); } catch {
    throw new Error('El enlace del mod no es válido.');
  }
  if (!/^[a-z0-9][a-z0-9-]{1,99}$/.test(slug)) {
    throw new Error('El enlace no contiene un identificador de mod válido.');
  }
  return slug;
}

async function searchCurseForgeProjectBySlug(slug) {
  const normalizedSlug = String(slug || '').trim().toLowerCase();
  if (!/^[a-z0-9-]{2,100}$/.test(normalizedSlug)) return null;
  const params = new URLSearchParams({
    gameId: String(CURSEFORGE_GAME_ID),
    classId: String(CURSEFORGE_MINECRAFT_CLASS_ID),
    slug: normalizedSlug,
    pageSize: '10',
  });
  const results = await curseForgeFetch('/mods/search?' + params.toString());
  const project = (results || []).find((candidate) => String(candidate.slug || '').toLowerCase() === normalizedSlug);
  if (!project) return null;
  const website = project.links?.websiteUrl || '';
  let url = '';
  try {
    const parsed = new URL(website);
    if (parsed.protocol === 'https:' && (parsed.hostname === 'curseforge.com' || parsed.hostname.endsWith('.curseforge.com'))) url = parsed.href;
  } catch {}
  return {
    id: project.id,
    slug: project.slug || normalizedSlug,
    name: project.name || '',
    summary: project.summary || '',
    logo: project.logo?.thumbnailUrl || project.logo?.url || '',
    url,
    downloads: project.downloadCount || 0,
  };
}

const CURSEFORGE_FINGERPRINT_MULTIPLIER = 0x5bd1e995;

async function curseForgeFingerprint(file) {
  let normalizedLength = 0;
  for await (const chunk of fs.createReadStream(file)) {
    for (const byte of chunk) {
      if (byte !== 0x09 && byte !== 0x0a && byte !== 0x0d && byte !== 0x20) normalizedLength += 1;
    }
  }

  let hash = (1 ^ normalizedLength) >>> 0;
  let word = 0;
  let wordBytes = 0;
  for await (const chunk of fs.createReadStream(file)) {
    for (const byte of chunk) {
      if (byte === 0x09 || byte === 0x0a || byte === 0x0d || byte === 0x20) continue;
      word = (word | (byte << (wordBytes * 8))) >>> 0;
      wordBytes += 1;
      if (wordBytes !== 4) continue;

      word = Math.imul(word, CURSEFORGE_FINGERPRINT_MULTIPLIER) >>> 0;
      word ^= word >>> 24;
      word = Math.imul(word, CURSEFORGE_FINGERPRINT_MULTIPLIER) >>> 0;
      hash = Math.imul(hash, CURSEFORGE_FINGERPRINT_MULTIPLIER) >>> 0;
      hash = (hash ^ word) >>> 0;
      word = 0;
      wordBytes = 0;
    }
  }

  if (wordBytes) {
    hash = (hash ^ word) >>> 0;
    hash = Math.imul(hash, CURSEFORGE_FINGERPRINT_MULTIPLIER) >>> 0;
  }
  hash = (hash ^ (hash >>> 13)) >>> 0;
  hash = Math.imul(hash, CURSEFORGE_FINGERPRINT_MULTIPLIER) >>> 0;
  return (hash ^ (hash >>> 15)) >>> 0;
}

async function getCurseForgeMetadataForMods(mods, progressId = '') {
  const report = (percent, phase, current = 0, total = mods.length, item = '') => {
    updateModOperationProgress(progressId, {
      phase,
      percent: Math.max(0, Math.min(99, Math.round(percent))),
      current,
      total,
      item,
      downloadedBytes: 0,
      totalBytes: 0,
    });
  };
  report(1, 'Analizando los archivos de mods');
  const modsByFingerprint = new Map();
  for (let index = 0; index < mods.length; index += 1) {
    const mod = mods[index];
    const fingerprint = await curseForgeFingerprint(path.join(MODS_DIR, mod.name));
    const key = String(fingerprint);
    if (!modsByFingerprint.has(key)) modsByFingerprint.set(key, []);
    modsByFingerprint.get(key).push(mod.name);
    report(2 + 22 * (index + 1) / Math.max(mods.length, 1), 'Analizando los archivos de mods', index + 1, mods.length, mod.displayName || mod.name);
  }
  const fingerprints = [...modsByFingerprint.keys()].map(Number);
  const projectByFileName = new Map();
  const modIdsByFileName = new Map();

  for (let index = 0; index < fingerprints.length; index += 100) {
    const batch = fingerprints.slice(index, index + 100);
    const matches = await curseForgeFetch('/fingerprints/' + CURSEFORGE_GAME_ID, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fingerprints: batch }),
    });
    for (const match of matches?.exactMatches || []) {
      const fingerprint = Number(match.file?.fileFingerprint ?? match.id) >>> 0;
      const fileNames = modsByFingerprint.get(String(fingerprint)) || [];
      const modId = Number(match.file?.modId);
      if (!Number.isSafeInteger(modId) || modId <= 0) continue;
      for (const fileName of fileNames) modIdsByFileName.set(fileName, modId);
    }
    report(25 + 12 * Math.min(index + batch.length, fingerprints.length) / Math.max(fingerprints.length, 1), 'Buscando coincidencias en CurseForge', Math.min(index + batch.length, fingerprints.length), fingerprints.length);
  }

  const uniqueModIds = [...new Set(modIdsByFileName.values())];
  const projectsById = new Map();
  for (let index = 0; index < uniqueModIds.length; index += 50) {
    const projects = await curseForgeFetch('/mods', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ modIds: uniqueModIds.slice(index, index + 50) }),
    });
    for (const project of projects || []) projectsById.set(project.id, project);
    report(40 + 13 * Math.min(index + 50, uniqueModIds.length) / Math.max(uniqueModIds.length, 1), 'Cargando nombres e imágenes', Math.min(index + 50, uniqueModIds.length), uniqueModIds.length);
  }

  for (const [fileName, modId] of modIdsByFileName) {
    const project = projectsById.get(modId);
    if (!project) continue;
    const website = project.links?.websiteUrl || '';
    let url = '';
    try {
      const parsed = new URL(website);
      if (parsed.protocol === 'https:' && (parsed.hostname === 'curseforge.com' || parsed.hostname.endsWith('.curseforge.com'))) url = parsed.href;
    } catch {}
    projectByFileName.set(fileName, {
      name: project.name || '',
      summary: project.summary || '',
      logo: project.logo?.thumbnailUrl || project.logo?.url || '',
      url,
    });
  }

  let fallbackRequests = 0;
  const fallbackMods = mods.filter((mod) => !projectByFileName.has(mod.name));
  report(55, 'Buscando los mods que no coincidieron por archivo', 0, fallbackMods.length);
  for (let index = 0; index < fallbackMods.length; index += 1) {
    const mod = fallbackMods[index];
    try {
      const file = path.join(MODS_DIR, mod.name);
      const slug = await getJarCurseForgeSlug(file);
      let project = null;
      if (slug) {
        if (fallbackRequests > 0) await new Promise((resolve) => setTimeout(resolve, 700));
        fallbackRequests += 1;
        project = await searchCurseForgeProjectBySlug(slug);
      }
      if (!project) {
        if (fallbackRequests > 0) await new Promise((resolve) => setTimeout(resolve, 700));
        fallbackRequests += 1;
        project = await searchCurseForgeProjectByInstalledName(mod.displayName);
      }
      if (project) projectByFileName.set(mod.name, project);
    } catch (error) {
      console.error('No se pudo buscar la ficha de CurseForge para ' + mod.name + ':', error.message);
      if (/HTTP (401|403|429)/.test(error.message)) {
        projectByFileName.error = error.message;
        break;
      }
    }
    report(55 + 40 * (index + 1) / Math.max(fallbackMods.length, 1), 'Buscando los mods que no coincidieron por archivo', index + 1, fallbackMods.length, mod.displayName || mod.name);
  }
  report(98, 'Terminando la actualización', mods.length, mods.length);
  return projectByFileName;
}

async function searchCurseForgeMods(query, sort = 'relevance') {
  const searchSort = ({
    relevance: ['13', 'desc'],
    'downloads-desc': ['6', 'desc'],
    'downloads-asc': ['6', 'asc'],
    'name-asc': ['4', 'asc'],
    'name-desc': ['4', 'desc'],
  })[sort] || ['13', 'desc'];
  if (!CURSEFORGE_LOADER_ID) throw new Error('Este servidor es Vanilla. Instala un mod loader para buscar mods compatibles.');
  const params = new URLSearchParams({
    gameId: String(CURSEFORGE_GAME_ID),
    classId: String(CURSEFORGE_MINECRAFT_CLASS_ID),
    gameVersion: CURSEFORGE_MC_VERSION,
    modLoaderType: String(CURSEFORGE_LOADER_ID),
    searchFilter: query,
    sortField: searchSort[0],
    sortOrder: searchSort[1],
    pageSize: '24',
  });
  const data = await curseForgeFetch('/mods/search?' + params.toString());
  return (data || []).map((mod) => ({
    id: mod.id,
    slug: mod.slug || '',
    name: mod.name,
    summary: mod.summary || '',
    logo: mod.logo?.thumbnailUrl || mod.logo?.url || '',
    url: mod.links?.websiteUrl || '',
    downloads: mod.downloadCount || 0,
  }));
}

async function curseForgeModFiles(modId) {
  if (!CURSEFORGE_LOADER_ID) throw new Error('Este servidor es Vanilla. Instala un mod loader antes de buscar o instalar mods.');
  const params = new URLSearchParams({ gameVersion: CURSEFORGE_MC_VERSION, modLoaderType: String(CURSEFORGE_LOADER_ID), pageSize: '50' });
  const data = await curseForgeFetch('/mods/' + modId + '/files?' + params.toString());
  return (data || []).filter((file) => file.isAvailable !== false &&
    (file.gameVersions || []).includes(CURSEFORGE_MC_VERSION) &&
    (file.gameVersions || []).some((version) => /neoforge/i.test(version) || version === CURSEFORGE_MC_VERSION))
    .map((file) => ({
      id: file.id,
      displayName: file.displayName,
      fileName: file.fileName,
      fileDate: file.fileDate,
      fileLength: file.fileLength,
      releaseType: file.releaseType,
      downloadUrl: file.downloadUrl || '',
      dependencies: file.dependencies || [],
      hashes: file.hashes || [],
    }));
}

async function getCurseForgeProjectsByIds(modIds) {
  const uniqueIds = [...new Set(modIds.map(Number).filter((id) => Number.isSafeInteger(id) && id > 0))];
  const projectsById = new Map();
  for (let index = 0; index < uniqueIds.length; index += 50) {
    const projects = await curseForgeFetch('/mods', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ modIds: uniqueIds.slice(index, index + 50) }),
    });
    for (const project of projects || []) {
      const website = project.links?.websiteUrl || '';
      let url = '';
      try {
        const parsed = new URL(website);
        if (parsed.protocol === 'https:' && (parsed.hostname === 'curseforge.com' || parsed.hostname.endsWith('.curseforge.com'))) url = parsed.href;
      } catch {}
      projectsById.set(Number(project.id), {
        id: Number(project.id),
        slug: project.slug || '',
        name: project.name || '',
        summary: project.summary || '',
        logo: project.logo?.thumbnailUrl || project.logo?.url || '',
        url,
      });
    }
  }
  return projectsById;
}

function getInstalledCurseForgeProjectFile(project, installedMods) {
  const prepared = modStaging.list().find(entry => entry.modId === Number(project.id));
  if (prepared) return prepared.name;
  const projectNames = [normalizeCurseForgeName(project.name), normalizeCurseForgeName(project.slug)].filter(Boolean);
  for (const mod of installedMods) {
    const localNames = [
      normalizeCurseForgeName(mod.displayName),
      normalizeCurseForgeName(path.basename(mod.name, '.jar')),
    ].filter(Boolean);
    if (projectNames.some((name) => localNames.includes(name))) return mod.name;
  }
  return '';
}

function latestCompatibleCurseForgeFile(files) {
  const releases = files.filter((file) => Number(file.releaseType) === 1);
  return [...(releases.length ? releases : files)].sort((a, b) => Date.parse(b.fileDate || '') - Date.parse(a.fileDate || ''))[0] || null;
}

async function resolveRequiredCurseForgeDependencies(dependencies, installedMods, rootModId, selectedOptionalIds = new Set()) {
  const requiredRelations = new Set([1, 3]);
  const nodesById = new Map();
  const visiting = new Set();
  const orderedIds = [];

  async function visit(dependency, depth = 1) {
    const modId = Number(dependency.modId);
    const relationType = Number(dependency.relationType);
    const selectedOptional = depth === 1 && relationType === 2 && selectedOptionalIds.has(modId);
    if ((!requiredRelations.has(relationType) && !selectedOptional) || !Number.isSafeInteger(modId) || modId <= 0 || modId === rootModId || nodesById.has(modId)) return;
    if (depth > 8) throw new Error('Las dependencias de este mod superan el límite de profundidad admitido.');
    if (nodesById.size >= 24) throw new Error('Este mod declara demasiadas dependencias para instalarlas de una vez.');
    if (visiting.has(modId)) return;
    visiting.add(modId);
    if (nodesById.size > 0) await new Promise((resolve) => setTimeout(resolve, 650));
    const files = await curseForgeModFiles(modId);
    const selected = latestCompatibleCurseForgeFile(files);
    if (!selected) throw new Error('La dependencia de CurseForge con ID ' + modId + ' no tiene un archivo compatible con Minecraft '+CURSEFORGE_MC_VERSION+' y el loader de este servidor.');
    const node = { modId, relationType, selected };
    nodesById.set(modId, node);
    for (const nested of selected.dependencies || []) await visit(nested, depth + 1);
    visiting.delete(modId);
    orderedIds.push(modId);
  }

  for (const dependency of dependencies || []) await visit(dependency);
  const projectsById = await getCurseForgeProjectsByIds(orderedIds);
  const plan = [];
  for (const modId of orderedIds) {
    const node = nodesById.get(modId);
    const project = projectsById.get(modId) || { id: modId, name: 'Mod de CurseForge ' + modId, slug: '', logo: '', summary: '', url: '' };
    const installedFileName = getInstalledCurseForgeProjectFile(project, installedMods);
    plan.push({
      modId,
      relationType: node.relationType,
      project,
      selected: node.selected,
      installedFileName,
    });
  }
  return plan;
}

async function getCurseForgeDependencyOverview(dependencies) {
  const direct = new Map();
  for (const dependency of dependencies || []) {
    const modId = Number(dependency.modId);
    const relationType = Number(dependency.relationType);
    if (![1, 2, 3].includes(relationType) || !Number.isSafeInteger(modId) || modId <= 0) continue;
    if (!direct.has(modId) || relationType === 3) direct.set(modId, relationType);
  }
  const projectsById = await getCurseForgeProjectsByIds([...direct.keys()]);
  const installedMods = await listMods();
  const required = [];
  const optional = [];
  for (const [modId, relationType] of direct) {
    const project = projectsById.get(modId) || { id: modId, name: 'Mod de CurseForge ' + modId, slug: '', logo: '', summary: '', url: '' };
    const item = { modId, relationType, ...project, installedFileName: getInstalledCurseForgeProjectFile(project, installedMods) };
    if (relationType === 2) optional.push(item);
    else required.push(item);
  }
  return { required, optional };
}

async function installedModsWithPending() {
  return [...await listMods(), ...modStaging.list().map(entry => ({ name: entry.name, displayName: entry.displayName }))];
}

async function runBulkModUpdates(id) {
  const failures = [];
  let items = [];
  try {
    updateModOperationProgress(id, { phase: 'Buscando actualizaciones compatibles en CurseForge…', percent: 1, done: false, items: [] });
    const checked = await checkCurseForgeModUpdates(progress => updateModOperationProgress(id, progress));
    if (checked.throttled) throw new Error('CurseForge ha limitado las solicitudes. Espera antes de volver a intentarlo.');
    items = checked.updates.map(mod => ({ name: mod.name, label: mod.displayName, status: 'Pendiente' }));
    failures.push(...checked.errors.map(error => ({ name: error.name, message: error.message })));
    const context = { index: 0, items };
    bulkProgressContexts.set(id, context);
    for (let index = 0; index < checked.updates.length; index++) {
      context.index = index;
      const mod = checked.updates[index];
      items[index].status = 'Descargando y preparando';
      updateModOperationProgress(id, { phase: 'Preparando ' + mod.displayName, percent: 0, error: '' });
      try {
        const prepared = modStaging.list().find(entry => entry.modId === mod.modId && entry.fileId === mod.latestFile.id);
        if (!prepared) await installCurseForgeSelection(mod.modId, mod.latestFile.id, mod.name, id);
        items[index].status = 'Listo para reiniciar';
      } catch (error) {
        items[index].status = 'Error: ' + error.message;
        failures.push({ name: mod.name, message: error.message });
      }
      updateModOperationProgress(id, { percent: 100, error: '' });
    }
    bulkProgressContexts.delete(id);
    const pending = modStaging.list();
    updateModOperationProgress(id, { phase: failures.length ? 'Finalizado con avisos' : pending.length ? 'Mods actualizados; pendientes de reinicio' : 'No hay actualizaciones pendientes', percent: 100,
      done: true, items, failures, restartRequired: pending.length > 0, pendingCount: pending.length, error: '', downloadedBytes: 0, totalBytes: 0 });
  } catch (error) {
    bulkProgressContexts.delete(id);
    updateModOperationProgress(id, { phase: 'No se pudo completar la actualización', done: true, error: error.message, items, failures, restartRequired: modStaging.list().length > 0 });
  } finally {
    activeBulkUpdate = '';
    maintenanceLock = '';
  }
}

async function installCurseForgeSelection(modId, fileId, replaceName, progressId = '', requestedOptionalIds = []) {
  const checkpoint = modStaging.checkpoint();
  updateModOperationProgress(progressId, {
    phase: 'Buscando la versión y sus dependencias', percent: 1, currentItem: 0,
    totalItems: 0, downloadedBytes: 0, totalBytes: 0, done: false,
  });
  const files = await curseForgeModFiles(modId);
  const selected = files.find((file) => file.id === fileId);
  if (!selected) throw new Error('El archivo ya no aparece como compatible con Minecraft '+CURSEFORGE_MC_VERSION+' y el loader de este servidor.');

  updateModOperationProgress(progressId, { phase: 'Comprobando dependencias', percent: 3 });
  const declaredOptionalIds = new Set((selected.dependencies || [])
    .filter(dependency => Number(dependency.relationType) === 2)
    .map(dependency => Number(dependency.modId))
    .filter(id => Number.isSafeInteger(id) && id > 0));
  const selectedOptionalIds = new Set(requestedOptionalIds.map(Number));
  if ([...selectedOptionalIds].some(id => !declaredOptionalIds.has(id))) throw new Error('La lista de dependencias opcionales ya no coincide con la versión seleccionada. Vuelve a abrir sus versiones compatibles.');
  const dependencyPlan = await resolveRequiredCurseForgeDependencies(selected.dependencies || [], await installedModsWithPending(), modId, selectedOptionalIds);
  const dependencyFileNames = new Map();
  for (const dependency of dependencyPlan) {
    let installedFileName = dependency.installedFileName;
    if (!installedFileName && dependency.selected.fileName &&
        await fsp.access(path.join(MODS_DIR, dependency.selected.fileName)).then(() => true).catch(() => false)) {
      installedFileName = dependency.selected.fileName;
    }
    dependencyFileNames.set(dependency.modId, installedFileName || '');
  }
  const dependenciesToInstall = dependencyPlan.filter((dependency) => !dependencyFileNames.get(dependency.modId));
  const installCount = dependenciesToInstall.length + 1;
  const byteSize = (file) => Math.max(0, Number(file?.fileLength) || 0);
  const totalBytes = dependenciesToInstall.reduce((sum, dependency) => sum + byteSize(dependency.selected), byteSize(selected));
  const installedDependencies = [];
  const newlyInstalledNames = [];
  let completedBytes = 0;
  let itemIndex = 0;
  updateModOperationProgress(progressId, {
    phase: installCount > 1 ? `Preparando ${installCount} descargas` : 'Preparando descarga',
    percent: 4, currentItem: 0, totalItems: installCount,
    downloadedBytes: 0, totalBytes, done: false,
  });
  try {
    for (const dependency of dependencyPlan) {
      const installedFileName = dependencyFileNames.get(dependency.modId) || '';
      if (installedFileName) {
        installedDependencies.push({
          modId: dependency.modId,
          projectName: dependency.project.name,
          fileName: installedFileName,
          installed: true,
          logo: dependency.project.logo,
          summary: dependency.project.summary,
          url: dependency.project.url,
        });
        continue;
      }
      itemIndex += 1;
      const result = await installSelectedCurseForgeFile(dependency.modId, dependency.selected, '', {
        progressId, index: itemIndex, count: installCount, totalBytes, completedBytes,
        label: dependency.project.name,
      });
      completedBytes += result.bytes;
      newlyInstalledNames.push(result.name);
      installedDependencies.push({
        modId: dependency.modId,
        projectName: dependency.project.name,
        fileName: result.name,
        installed: false,
        logo: dependency.project.logo,
        summary: dependency.project.summary,
        url: dependency.project.url,
      });
    }
    itemIndex += 1;
    const result = await installSelectedCurseForgeFile(modId, selected, replaceName || '', {
      progressId, index: itemIndex, count: installCount, totalBytes, completedBytes,
      label: selected.displayName || selected.fileName,
    });
    updateModOperationProgress(progressId, {
      phase: 'Instalación completada', percent: 99, currentItem: installCount,
      totalItems: installCount, downloadedBytes: totalBytes || completedBytes + result.bytes,
      totalBytes, done: false,
    });
    return { ...result, installedDependencies };
  } catch (error) {
    updateModOperationProgress(progressId, { phase: 'Revirtiendo cambios parciales', error: error.message });
    modStaging.rollback(checkpoint);
    throw error;
  }
}

async function getCurseForgeInstalledFileMatches(mods) {
  const filesByFingerprint = new Map();
  for (const mod of mods) {
    const fingerprint = await curseForgeFingerprint(path.join(MODS_DIR, mod.name));
    const key = String(fingerprint);
    if (!filesByFingerprint.has(key)) filesByFingerprint.set(key, []);
    filesByFingerprint.get(key).push(mod.name);
  }

  const fingerprints = [...filesByFingerprint.keys()].map(Number);
  const matchByFileName = new Map();
  for (let index = 0; index < fingerprints.length; index += 100) {
    const matches = await curseForgeFetch('/fingerprints/' + CURSEFORGE_GAME_ID, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fingerprints: fingerprints.slice(index, index + 100) }),
    });
    for (const match of matches?.exactMatches || []) {
      const fingerprint = Number(match.file?.fileFingerprint ?? match.id) >>> 0;
      const fileNames = filesByFingerprint.get(String(fingerprint)) || [];
      const modId = Number(match.file?.modId);
      const fileId = Number(match.file?.id);
      if (!Number.isSafeInteger(modId) || modId <= 0 || !Number.isSafeInteger(fileId) || fileId <= 0) continue;
      for (const fileName of fileNames) matchByFileName.set(fileName, { modId, fileId, fileDate: match.file?.fileDate || '' });
    }
  }
  return matchByFileName;
}

async function checkCurseForgeModUpdates(onProgress = null) {
  if (!getCurseForgeKey()) throw new Error('Añade primero tu clave API de CurseForge en la configuración del Buscador de Mods.');
  const mods = await listMods();
  if (!mods.length) return { checked: 0, updates: [], current: [], unsupported: [], errors: [], throttled: false, totalMatched: 0 };

  const installedMatches = await getCurseForgeInstalledFileMatches(mods);
  const modsById = new Map();
  const unsupported = [];
  for (const mod of mods) {
    if (modStaging.list().some(entry => entry.replaceName === mod.name || entry.name === mod.name)) continue;
    const match = installedMatches.get(mod.name);
    if (!match) {
      unsupported.push({ name: mod.name, displayName: mod.displayName });
      continue;
    }
    if (!modsById.has(match.modId)) modsById.set(match.modId, []);
    modsById.get(match.modId).push({ ...mod, currentFileId: match.fileId, currentFileDate: match.fileDate });
  }

  const updates = [];
  const current = [];
  const errors = [];
  let throttled = false;
  let checked = 0;
  for (const [modId, installedFiles] of modsById) {
    onProgress?.({ phase: 'Comprobando ' + installedFiles[0].displayName, item: installedFiles[0].displayName,
      percent: Math.round(2 + 7 * checked / Math.max(modsById.size, 1)), current: checked, total: modsById.size, done: false });
    if (checked > 0) await new Promise((resolve) => setTimeout(resolve, 650));
    try {
      const files = await curseForgeModFiles(modId);
      checked += 1;
      if (!files.length) {
        for (const installed of installedFiles) errors.push({ name: installed.name, message: 'CurseForge no devuelve versiones compatibles.' });
        continue;
      }
      const releases = files.filter((file) => Number(file.releaseType) === 1);
      const latest = [...(releases.length ? releases : files)].sort((a, b) => Date.parse(b.fileDate || '') - Date.parse(a.fileDate || ''))[0];
      for (const installed of installedFiles) {
        const installedDate = Date.parse(installed.currentFileDate || '');
        const latestDate = Date.parse(latest.fileDate || '');
        const alreadyNewer = Number.isFinite(installedDate) && Number.isFinite(latestDate)
          ? latestDate <= installedDate : latest.id < installed.currentFileId;
        if (latest.id === installed.currentFileId || alreadyNewer) {
          current.push({ name: installed.name, displayName: installed.displayName });
        } else {
          updates.push({
            name: installed.name,
            displayName: installed.displayName,
            modId,
            currentFileId: installed.currentFileId,
            latestFile: {
              id: latest.id,
              displayName: latest.displayName,
              fileName: latest.fileName,
              fileDate: latest.fileDate,
              releaseType: latest.releaseType,
            },
          });
        }
      }
    } catch (error) {
      if (/HTTP 429/.test(error.message)) {
        throttled = true;
        break;
      }
      for (const installed of installedFiles) errors.push({ name: installed.name, message: error.message });
      if (/HTTP (401|403)/.test(error.message)) break;
    }
  }
  return { checked, updates, current, unsupported, errors, throttled, totalMatched: modsById.size };
}

function currentNeoForgeVersion() {
  const run = fs.readFileSync(path.join(SERVER_DIR, 'run.bat'), 'utf8');
  return /neoforge[\\/]([^\\/\r\n]+)[\\/]win_args\.txt/i.exec(run)?.[1] || null;
}

function compareVersionParts(a, b) {
  const left = a.split(/[.-]/).map((part) => /^\d+$/.test(part) ? Number(part) : part);
  const right = b.split(/[.-]/).map((part) => /^\d+$/.test(part) ? Number(part) : part);
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const x = left[i] ?? 0;
    const y = right[i] ?? 0;
    if (x === y) continue;
    if (typeof x === 'number' && typeof y === 'number') return x - y;
    if (typeof x === 'number') return 1;
    if (typeof y === 'number') return -1;
    return String(x).localeCompare(String(y));
  }
  return 0;
}

async function getNeoForgeVersions() {
  const response = await fetch(NEOFORGE_METADATA_URL, { signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error('No se pudo consultar el catálogo oficial de NeoForge.');
  const xml = await response.text();
  const versions = [...xml.matchAll(/<version>([^<]+)<\/version>/g)].map((match) => match[1]);
  const compatible = versions.filter((version) => /^26\.3\.\d+(?:\.\d+)?(?:-[A-Za-z0-9.-]+)?$/.test(version));
  const stable = compatible.filter((version) => !version.includes('-')).sort(compareVersionParts);
  const current = currentNeoForgeVersion();
  return { minecraftVersion: '26.3', current, latest: stable.at(-1) || null, versions: stable.reverse().slice(0, 20) };
}

async function downloadToFile(url, file, maxBytes = 300 * 1024 * 1024, onProgress = null, expectedBytes = 0) {
  const parsed = new URL(url);
  const trustedHost = (hostname) => hostname === 'curseforge.com' || hostname.endsWith('.curseforge.com') ||
    hostname === 'forgecdn.net' || hostname.endsWith('.forgecdn.net') ||
    hostname === 'neoforged.net' || hostname.endsWith('.neoforged.net');
  if (parsed.protocol !== 'https:' || !trustedHost(parsed.hostname)) throw new Error('La URL de descarga no pertenece a CurseForge o NeoForged.');
  let response;
  const operation = 'descargar ' + path.basename(file).replace(/^\.curseforge-[^.]+/, 'el archivo del mod');
  try { response = await fetch(parsed, { redirect: 'follow', signal: AbortSignal.timeout(10 * 60 * 1000) }); }
  catch (error) { throw networkFailure(error, operation); }
  if (!response.ok) throw httpFailure(response.status, operation, { download: true, retryAfter: response.headers.get('retry-after') || '' });
  if (!response.body) throw new Error('Causa: la descarga llegó sin contenido. Acción: vuelve a intentarlo. Operación: ' + operation + '.');
  if (!trustedHost(new URL(response.url).hostname)) throw new Error('La descarga redirigió a un dominio no autorizado.');
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > maxBytes) throw new Error('El archivo supera el límite de descarga.');
  const totalBytes = declared || Number(expectedBytes) || 0;
  let size = 0;
  let lastProgressAt = 0;
  try { onProgress?.(0, totalBytes); } catch {}
  const limiter = new Transform({ transform(chunk, encoding, callback) {
    size += chunk.length;
    if (size > maxBytes) callback(new Error('El archivo supera el límite de descarga.'));
    else {
      const now = Date.now();
      if (now - lastProgressAt >= 120 || (totalBytes && size >= totalBytes)) {
        lastProgressAt = now;
        try { onProgress?.(size, totalBytes); } catch {}
      }
      callback(null, chunk);
    }
  } });
  await pipeline(response.body, limiter, fs.createWriteStream(file, { flags: 'wx' }));
  if (size < 4) throw new Error('La descarga está vacía o incompleta.');
  try { onProgress?.(size, totalBytes || size); } catch {}
  return size;
}

async function installSelectedCurseForgeFile(modId, selected, replaceName = '', progressContext = {}) {
  if (!selected.downloadUrl) {
    const result = await curseForgeFetch('/mods/' + modId + '/files/' + selected.id + '/download-url');
    selected.downloadUrl = typeof result === 'string' ? result : result?.url || '';
  }
  if (!selected.downloadUrl) throw new Error('CurseForge no proporcionó una URL de descarga para este archivo.');
  const safeName = path.basename(selected.fileName || '');
  if (!safeModName(safeName)) throw new Error('CurseForge devolvió un nombre de archivo no válido.');
  if (replaceName && (!safeModName(replaceName) || !(await fsp.stat(path.join(MODS_DIR, replaceName)).catch(() => null)))) {
    throw new Error('No se encontró el mod que quieres reemplazar.');
  }
  await fsp.mkdir(MODS_DIR, { recursive: true });
  const temp = path.join(MODS_DIR, '.curseforge-' + crypto.randomBytes(8).toString('hex') + '.tmp');
  const targetName = safeName;
  const downloaded = path.join(MODS_DIR, safeName);
  const targetExists = await fsp.access(downloaded).then(() => true).catch(() => false);
  if (targetExists && (!replaceName || replaceName !== safeName)) throw new Error('Ya existe ese archivo. Elige ese mod instalado para reemplazarlo.');
  try {
    const { progressId = '', index = 1, count = 1, totalBytes = 0, completedBytes = 0, label = safeName } = progressContext;
    const expectedFileBytes = Number(selected.fileLength) || 0;
    const updateProgress = (phase, currentBytes = 0, fileTotalBytes = expectedFileBytes) => {
      const fraction = fileTotalBytes > 0 ? Math.max(0, Math.min(1, currentBytes / fileTotalBytes)) : 0;
      const percent = Math.min(96, Math.round(((index - 1 + fraction) / Math.max(count, 1)) * 96));
      updateModOperationProgress(progressId, {
        phase,
        percent,
        item: label,
        currentItem: index,
        totalItems: count,
        downloadedBytes: completedBytes + currentBytes,
        totalBytes: totalBytes || completedBytes + fileTotalBytes,
        done: false,
      });
    };
    updateProgress('Descargando ' + label);
    const downloadedBytes = await downloadToFile(
      selected.downloadUrl,
      temp,
      300 * 1024 * 1024,
      (currentBytes, fileTotalBytes) => updateProgress('Descargando ' + label, currentBytes, fileTotalBytes),
      expectedFileBytes,
    );
    if (selected.fileLength && downloadedBytes !== selected.fileLength) throw new Error('El tamaño descargado no coincide con el publicado por CurseForge.');
    updateProgress('Instalando ' + label, downloadedBytes, selected.fileLength || downloadedBytes);
    const handle = await fsp.open(temp, 'r');
    const signature = Buffer.alloc(4);
    await handle.read(signature, 0, 4, 0);
    await handle.close();
    if (signature[0] !== 0x50 || signature[1] !== 0x4b) throw new Error('El archivo descargado no parece ser un .jar válido.');
    for (const published of selected.hashes || []) {
      const algorithm = Number(published.algo) === 1 ? 'sha1' : Number(published.algo) === 2 ? 'md5' : '';
      if (algorithm && crypto.createHash(algorithm).update(await fsp.readFile(temp)).digest('hex').toLowerCase() !== String(published.value).toLowerCase()) throw new Error('La descarga no coincide con la huella publicada por CurseForge.');
    }
    modStaging.stage(temp, { name: targetName, replaceName, modId, fileId: selected.id, displayName: label });
    await fsp.unlink(temp);
    updateProgress('Preparado para reiniciar: ' + label, downloadedBytes, selected.fileLength || downloadedBytes);
    return { name: targetName, downloadedName: safeName, bytes: downloadedBytes, rollbackSaved: false, pending: true };
  } catch (error) {
    await fsp.rm(temp, { force: true }).catch(() => {});
    throw error;
  }
}

async function updateNeoForge(version) {
  if (!/^26\.3\.\d+(?:\.\d+)?$/.test(version)) throw new Error('Elige una versión estable de NeoForge para Minecraft 26.3.');
  if (await tcpOpen(options.record?.bindAddress || '127.0.0.1', config.serverPort)) throw new Error('Apaga el servidor antes de actualizar NeoForge.');
  const catalog = await getNeoForgeVersions();
  if (!catalog.versions.includes(version) || version.includes('-')) throw new Error('La versión elegida no aparece en el catálogo estable de NeoForge 26.3.');
  const current = currentNeoForgeVersion();
  if (current === version) return { version, alreadyCurrent: true };
  if (current && compareVersionParts(version, current) <= 0) throw new Error('Solo se puede avanzar a una versión estable más reciente de NeoForge.');

  await enqueueBackup('neoforge');
  if (await tcpOpen(options.record?.bindAddress || '127.0.0.1', config.serverPort)) throw new Error('El servidor se ha vuelto a encender mientras se preparaba la copia; no he instalado NeoForge.');
  const installer = path.join(PANEL_DIR, 'neoforge-' + version + '-installer.jar');
  const downloadUrl = 'https://maven.neoforged.net/releases/net/neoforged/neoforge/' + version + '/neoforge-' + version + '-installer.jar';
  const originalScripts = new Map();
  for (const name of ['run.bat', 'start-minecraft-server.bat', 'run.sh']) {
    const file = path.join(SERVER_DIR, name);
    try { originalScripts.set(name, await fsp.readFile(file, 'utf8')); } catch {}
  }
  try {
    await downloadToFile(downloadUrl, installer, 100 * 1024 * 1024);
    const installerJava = path.join(RUNTIME_DIR, 'bin', 'java.exe');
    await execFileAsync(installerJava, ['-jar', installer, '--installServer'], {
      cwd: SERVER_DIR,
      timeout: 30 * 60 * 1000,
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
    });
    const expectedArgs = path.join(SERVER_DIR, 'libraries', 'net', 'neoforged', 'neoforge', version, 'win_args.txt');
    await fsp.access(expectedArgs);
    for (const [name, original] of originalScripts) {
      const updated = original.replace(/(neoforge[\\/])[^\\/\r\n]+([\\/]win_args\.txt)/gi, (_match, before, after) => before + version + after)
        .replace(/(neoforge[\\/])[^\\/\r\n]+([\\/]unix_args\.txt)/gi, (_match, before, after) => before + version + after);
      await fsp.writeFile(path.join(SERVER_DIR, name), updated, 'utf8');
    }
    return { version, backupCreated: true };
  } catch (error) {
    for (const [name, original] of originalScripts) {
      await fsp.writeFile(path.join(SERVER_DIR, name), original, 'utf8').catch(() => {});
    }
    throw error;
  } finally {
    await fsp.rm(installer, { force: true }).catch(() => {});
  }
}

function parseJvmMemory(argsText, flag) {
  const match = new RegExp(`(?:^|\\s)-${flag}(\\d+)([kKmMgGtT]?)\\b`, 'm').exec(argsText);
  if (!match) return null;
  const power = { k: 1, m: 2, g: 3, t: 4 }[match[2].toLowerCase()] || 0;
  return Number(match[1]) * (1024 ** power);
}

function parseJstatHeap(stdout) {
  const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return null;
  const headers = lines[0].trim().split(/\s+/);
  const values = lines[1].trim().split(/\s+/).map((value) => Number(value.replace(',', '.')));
  if (headers.length !== values.length || values.some((value) => !Number.isFinite(value))) return null;
  const stats = Object.fromEntries(headers.map((name, index) => [name, values[index]]));
  const heapUsedKb = ['S0U', 'S1U', 'EU', 'OU'].reduce((sum, name) => sum + (stats[name] || 0), 0);
  const heapCommittedKb = ['S0C', 'S1C', 'EC', 'OC'].reduce((sum, name) => sum + (stats[name] || 0), 0);
  return {
    heapUsedBytes: Math.round(heapUsedKb * 1024),
    heapCommittedBytes: Math.round(heapCommittedKb * 1024),
  };
}

async function getPerformanceSnapshot() {
  const now = Date.now();
  if (performanceCache && now - performanceCache.at < 1500) return performanceCache.data;

  const jvmArgs = await fsp.readFile(JVM_ARGS_FILE, 'utf8').catch(() => '');
  const properties = await fsp.readFile(PROPERTIES_FILE, 'utf8').catch(() => '');
  const propertyValue = (name) => {
    const match = new RegExp(`(?:^|\\n)${name}=([^\\r\\n]*)`).exec(properties);
    return match ? match[1] : '';
  };
  const heapMinBytes = parseJvmMemory(jvmArgs, 'Xms');
  const heapMaxBytes = parseJvmMemory(jvmArgs, 'Xmx');
  const escapedServerDir = SERVER_DIR.replace(/'/g, "''");
  const psCommand = `$serverDir = '${escapedServerDir}'; $os = Get-CimInstance Win32_OperatingSystem; $serverProcess = Get-CimInstance Win32_Process -Filter "Name='java.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($serverDir) } | Select-Object -First 1; if (-not $serverProcess) { [pscustomobject]@{ running=$false; totalMemoryBytes=[double]($os.TotalVisibleMemorySize * 1024); freeMemoryBytes=[double]($os.FreePhysicalMemory * 1024); logicalProcessors=[int][Environment]::ProcessorCount } | ConvertTo-Json -Compress; exit 0 }; $p = Get-Process -Id $serverProcess.ProcessId; [pscustomobject]@{ running=$true; pid=$p.Id; workingSetBytes=[double]$p.WorkingSet64; privateBytes=[double]$p.PrivateMemorySize64; cpuSeconds=[double]$p.CPU; startedAt=$p.StartTime.ToUniversalTime().ToString('o'); totalMemoryBytes=[double]($os.TotalVisibleMemorySize * 1024); freeMemoryBytes=[double]($os.FreePhysicalMemory * 1024); logicalProcessors=[int][Environment]::ProcessorCount } | ConvertTo-Json -Compress`;

  let processInfo, telemetryError='', needsTelemetryUpdate=false;
  if (options.remote) {
    try { processInfo=(await options.remote.metrics()).metrics; }
    catch(error) {
      telemetryError=error.message;
      needsTelemetryUpdate=Boolean(error.needsTelemetryUpdate);
      const state=await options.remote.gameState().catch(()=>null);
      processInfo={running:state?state.running:null};
    }
  } else {
    const { stdout } = await execFileAsync(
      POWERSHELL_EXE,
      ['-NoProfile', '-NonInteractive', '-Command', psCommand],
      { timeout: 5000, windowsHide: true, maxBuffer: 64 * 1024 },
    );
    processInfo=JSON.parse(stdout.trim());
  }
  const base = {
    running: processInfo.running==null?null:Boolean(processInfo.running),
    hostLabel: options.remote?'PC de destino':'PC del panel',
    telemetryError,
    needsTelemetryUpdate,
    heapMinBytes,
    heapMaxBytes,
    totalMemoryBytes: processInfo.totalMemoryBytes || 0,
    freeMemoryBytes: processInfo.freeMemoryBytes || 0,
    logicalProcessors: processInfo.logicalProcessors || 0,
    viewDistance: Number(propertyValue('view-distance')) || null,
    simulationDistance: Number(propertyValue('simulation-distance')) || null,
    sampledAt: new Date().toISOString(),
  };

  if (!processInfo.running || !processInfo.pid) {
    cpuSample = null;
    performanceCache = { at: now, data: base };
    return base;
  }

  const sampledAt=processInfo.sampledAt||now;
  let cpuPercent = null;
  const cpuSeconds = Number(processInfo.cpuSeconds);
  const processorCount = Math.max(1, Number(processInfo.logicalProcessors) || 1);
  if (cpuSample && cpuSample.pid === processInfo.pid && sampledAt===cpuSample.at) {
    cpuPercent=cpuSample.percent;
  } else if (cpuSample && cpuSample.pid === processInfo.pid && sampledAt>cpuSample.at && cpuSeconds>=cpuSample.cpuSeconds) {
    const elapsedSeconds = (sampledAt - cpuSample.at) / 1000;
    cpuPercent = Math.max(0, Math.min(100,
      ((cpuSeconds - cpuSample.cpuSeconds) / elapsedSeconds / processorCount) * 100,
    ));
  }
  cpuSample = { pid: processInfo.pid, cpuSeconds, at: sampledAt, percent:cpuPercent };

  let heap = null;
  try {
    const jstatOutput=options.remote?processInfo.jstat:
      (await execFileAsync(JVM_STATS_FILE,['-gc',String(processInfo.pid)],
        {timeout:4000,windowsHide:true,maxBuffer:64*1024})).stdout;
    if(typeof jstatOutput==='string')heap=parseJstatHeap(jstatOutput);
  } catch {}

  const startedAt = new Date(processInfo.startedAt);
  const data = {
    ...base,
    pid: processInfo.pid,
    workingSetBytes: processInfo.workingSetBytes,
    privateBytes: processInfo.privateBytes,
    cpuPercent,
    uptimeSeconds: Number.isNaN(startedAt.getTime()) ? null : Math.max(0, Math.floor((now - startedAt.getTime()) / 1000)),
    startedAt: Number.isNaN(startedAt.getTime()) ? null : startedAt.toISOString(),
    heapUsedBytes: heap?.heapUsedBytes ?? null,
    heapCommittedBytes: heap?.heapCommittedBytes ?? null,
  };
  performanceCache = { at: now, data };
  return data;
}

async function readLogs() {
  try {
    const candidates=options.remote?[LOG_FILE,path.join(SERVER_DIR,'logs','wolf-launch-error.log'),
      path.join(SERVER_DIR,'logs','wolf-launch.log'),path.join(SERVER_DIR,'.wolfmc-task-launch.log')]:
      [LOG_FILE,path.join(PANEL_DIR,'process.log')];
    const available=(await Promise.all(candidates.map(async file=>{
      try{const stat=await fsp.stat(file);return stat.size?{file,stat}:null;}catch{return null;}
    }))).filter(Boolean);
    if(!available.length)return [];
    if(options.remote)available.sort((a,b)=>b.stat.mtimeMs-a.stat.mtimeMs);
    const {file,stat}=available[0];
    const start = Math.max(0, stat.size - 1024 * 1024);
    const chunks = [];
    for await (const chunk of fs.createReadStream(file, { start })) chunks.push(chunk);
    return Buffer.concat(chunks).toString('utf8').split(/\r?\n/).filter(Boolean).slice(-300);
  } catch {
    return [];
  }
}

function validPlayerName(name) {
  return typeof name === 'string' && /^[A-Za-z0-9_]{3,16}$/.test(name);
}

function cleanPlayerReason(reason) {
  if (reason === undefined || reason === null || reason === '') return '';
  if (typeof reason !== 'string' || /[\x00-\x1f\x7f]/.test(reason)) return null;
  const cleaned = reason.trim();
  return cleaned.length <= 160 ? cleaned : null;
}

function parseOnlinePlayers(result) {
  const match = result.match(/There are \d+ of a max of \d+ players online(?::\s*(.*))?/i);
  if (!match || !match[1]) return [];
  return match[1].split(',').map((name) => name.trim()).filter(validPlayerName);
}

function safeModName(name) {
  if (typeof name !== 'string' || name.length < 5 || name.length > 180) return false;
  if (name !== path.basename(name) || name.includes('/') || name.includes('\\')) return false;
  if (/[\x00-\x1f<>:"|?*]/.test(name) || name.startsWith('.')) return false;
  return name.toLowerCase().endsWith('.jar');
}

async function waitUntil(predicate, timeoutMs, message) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 750));
  }
  throw new Error(message);
}

async function launchServer(handoff = false) {
  if (await gameOnline()) throw new Error('Minecraft sigue encendido.');
  await options.remote?.confirmStopped();
  modStaging.apply();
  if (options.launch) { managedServerProcess = await options.launch(handoff); return; }
  if (managedServerProcess && managedServerProcess.exitCode === null) {
    managedServerProcess.kill();
  }
  const commandProcessor = process.env.ComSpec || 'cmd.exe';
  managedServerProcess = spawn(commandProcessor, ['/c', 'run.bat'], {
    cwd: SERVER_DIR,
    windowsHide: true,
    detached: true,
    stdio: 'ignore',
  });
  const launchedProcess = managedServerProcess;
  launchedProcess.on('exit', () => {
    if (managedServerProcess === launchedProcess) managedServerProcess = null;
  });
  managedServerProcess.unref();
}

async function handleApi(req, res, url) {
  const pathname = url.pathname;
  if (req.method !== 'GET' && options.externalBusy?.()) return sendJson(res,409,{error:'Espera a que termine la instalación de este servidor.'});

  if (req.method === 'POST' && pathname === '/api/login') {
    const data = await readJson(req);
    if (!constantTimeTokenMatch(data.token)) return sendJson(res, 401, { error: 'Clave incorrecta.' });
    return sendJson(res, 200, { ok: true });
  }

  const auth = req.headers.authorization || '';
  const candidate = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!constantTimeTokenMatch(candidate)) return sendJson(res, 401, { error: 'Inicia sesión en el panel.' });

  if (req.method !== 'GET') {
    const origin = req.headers.origin;
    if (origin) {
      try {
        if (new URL(origin).host !== req.headers.host) {
          return sendJson(res, 403, { error: 'Origen no permitido.' });
        }
      } catch {
        return sendJson(res, 403, { error: 'Origen no permitido.' });
      }
    }
  }

  if (await serverFeatures.handle(req, res, url, { readJson, sendJson })) return;
  if (await playerTools.handle(req, res, url, { readJson, sendJson })) return;
  if (req.method === 'GET' && pathname === '/api/automodpack') return sendJson(res, 200, await autoModpackStatus.snapshot());
  if (req.method === 'GET' && pathname === '/api/context') return sendJson(res, 200, { id: options.record?.id || 'main', name: options.record?.name || "Lobodk's Server", minecraftVersion: CURSEFORGE_MC_VERSION, loader: options.record?.loader || 'neoforge', serverPort: config.serverPort });
  if (await itemCatalog.handle(req, res, url, { sendJson })) return;

  if (req.method === 'GET' && pathname === '/api/status') {
    const localPortOpen = await gameOnline();
    try {
      const players = await rconCommand('list');
      return sendJson(res, 200, {
        serverOnline: true,
        rconReady: true,
        players,
        modCount: (await listMods()).length,
      });
    } catch {
      return sendJson(res, 200, {
        serverOnline: localPortOpen,
        rconReady: false,
        players: '',
        modCount: (await listMods()).length,
        message: localPortOpen
          ? 'RCON quedará activo cuando reinicies el servidor una vez.'
          : 'El servidor está apagado o RCON aún no está disponible.',
      });
    }
  }

  if (req.method === 'GET' && pathname === '/api/players') {
    let online = [];
    let rconReady = true;
    try {
      online = parseOnlinePlayers(await rconCommand('list'));
    } catch {
      rconReady = false;
    }
    const bannedPlayers = await readArrayJson(path.join(SERVER_DIR, 'banned-players.json'));
    return sendJson(res, 200, { online, bannedPlayers, rconReady });
  }

  if (req.method === 'GET' && pathname === '/api/network') {
    return sendJson(res, 200, await networkMonitor.snapshot());
  }

  if (req.method === 'GET' && pathname === '/api/performance') {
    return sendJson(res, 200, await getPerformanceSnapshot());
  }

  if (req.method === 'PUT' && pathname === '/api/config/distances') {
    const data = await readJson(req);
    const viewDistance = Number(data.viewDistance);
    const simulationDistance = Number(data.simulationDistance);
    if (!Number.isInteger(viewDistance) || viewDistance < 2 || viewDistance > 32 ||
        !Number.isInteger(simulationDistance) || simulationDistance < 2 || simulationDistance > viewDistance) {
      return sendJson(res, 400, { error: 'La simulación debe ser de 2 a 32 chunks y no puede superar la distancia de visión.' });
    }
    let contents = await fsp.readFile(PROPERTIES_FILE, 'utf8');
    contents = setProperty(contents, 'view-distance', String(viewDistance));
    contents = setProperty(contents, 'simulation-distance', String(simulationDistance));
    const temp = PROPERTIES_FILE + '.panel-tmp';
    await fsp.writeFile(temp, contents, 'utf8');
    await fsp.rename(temp, PROPERTIES_FILE);
    performanceCache = null;
    return sendJson(res, 200, { ok: true, viewDistance, simulationDistance, restartRequired: true });
  }

  if (req.method === 'GET' && pathname === '/api/backups') {
    return sendJson(res, 200, { ...backupStatus(), backups: await listBackups() });
  }

  if (req.method === 'POST' && pathname === '/api/backups/restore') {
    if (options.remote) return sendJson(res,409,{error:'Devuelve el servidor al equipo del panel para restaurar un ZIP.'});
    if (maintenanceLock) return sendJson(res, 409, { error: 'Espera a que termine la operación actual antes de restaurar.' });
    if (backupRunning || backupQueued > 0) return sendJson(res, 409, { error: 'Espera a que terminen las copias en curso antes de restaurar.' });
    const data = await readJson(req);
    if (typeof data.name !== 'string') return sendJson(res, 400, { error: 'Selecciona una copia de seguridad.' });
    if (maintenanceLock || backupRunning || backupQueued > 0) {
      return sendJson(res, 409, { error: 'Hay otra operación en curso. Espera a que termine y vuelve a intentarlo.' });
    }
    maintenanceLock = 'restore';
    backupRunning = { kind: 'restauración', startedAt: new Date().toISOString() };
    try {
      const result = await restoreServerBackup(data.name);
      return sendJson(res, 200, { ok: true, ...result, ...backupStatus(), running: null, queued: 0 });
    } catch (error) {
      return sendJson(res, error.statusCode || 500, { error: error.message || 'No se pudo restaurar la copia.' });
    } finally {
      backupRunning = null;
      maintenanceLock = '';
    }
  }

  if (req.method === 'POST' && pathname === '/api/backups/manual') {
    if (maintenanceLock) return sendJson(res, 409, { error: 'Espera a que termine la actualización antes de crear una copia manual.' });
    const result = await enqueueBackup('manual');
    return sendJson(res, 201, { ok: true, backup: result, ...backupStatus() });
  }

  if (req.method === 'PUT' && pathname === '/api/backups/automatic') {
    if (maintenanceLock) return sendJson(res, 409, { error: 'No se puede cambiar la programación durante una restauración o actualización.' });
    const data = await readJson(req);
    if (typeof data.enabled !== 'boolean') return sendJson(res, 400, { error: 'Indica si las copias automáticas quedan activadas o desactivadas.' });
    backupConfig.automaticEnabled = data.enabled;
    backupConfig.nextAt = data.enabled ? Date.now() + BACKUP_INTERVAL_MS : null;
    backupConfig.lastError = '';
    persistBackupConfig();
    return sendJson(res, 200, { ok: true, ...backupStatus() });
  }

  if (req.method === 'GET' && pathname === '/api/curseforge/status') {
    return sendJson(res, 200, { configured: Boolean(getCurseForgeKey()), minecraftVersion: CURSEFORGE_MC_VERSION, loader: ({6:'NeoForge',1:'Forge',4:'Fabric'})[CURSEFORGE_LOADER_ID] || 'Vanilla' });
  }

  if (req.method === 'GET' && pathname === '/api/curseforge/progress') {
    const id = url.searchParams.get('id') || '';
    if (!validProgressId(id)) return sendJson(res, 400, { error: 'Identificador de progreso no válido.' });
    const progress = readModOperationProgress(id);
    return sendJson(res, 200, progress ? { found: true, ...progress } : { found: false });
  }

  if (req.method === 'POST' && pathname === '/api/curseforge/key') {
    const data = await readJson(req);
    const apiKey = typeof data.apiKey === 'string' ? data.apiKey.trim() : '';
    if (apiKey.length < 20 || apiKey.length > 512 || /[\r\n\0]/.test(apiKey)) {
      return sendJson(res, 400, { error: 'La clave API no parece válida.' });
    }
    saveCurseForgeKey(apiKey);
    return sendJson(res, 200, { ok: true, configured: true });
  }

  if (req.method === 'DELETE' && pathname === '/api/curseforge/key') {
    await fsp.rm(CURSEFORGE_CONFIG_FILE, { force: true });
    return sendJson(res, 200, { ok: true, configured: false });
  }

  if (req.method === 'GET' && pathname === '/api/curseforge/search') {
    const query = (url.searchParams.get('q') || '').trim();
    if (query.length < 2 || query.length > 100) return sendJson(res, 400, { error: 'Escribe entre 2 y 100 caracteres para buscar.' });
    return sendJson(res, 200, { mods: await searchCurseForgeMods(query, url.searchParams.get('sort') || 'relevance'), minecraftVersion: CURSEFORGE_MC_VERSION, loader: ({6:'NeoForge',1:'Forge',4:'Fabric'})[CURSEFORGE_LOADER_ID] || 'Vanilla' });
  }

  if (req.method === 'GET' && pathname === '/api/curseforge/lookup-url') {
    const slug = curseForgeModSlugFromUrl(url.searchParams.get('url') || '');
    const mod = await searchCurseForgeProjectBySlug(slug);
    return sendJson(res, 200, { mod, minecraftVersion: CURSEFORGE_MC_VERSION, loader: ({6:'NeoForge',1:'Forge',4:'Fabric'})[CURSEFORGE_LOADER_ID] || 'Vanilla' });
  }

  const curseForgeFilesMatch = /^\/api\/curseforge\/mods\/(\d+)\/files$/.exec(pathname);
  if (req.method === 'GET' && curseForgeFilesMatch) {
    const modId = Number(curseForgeFilesMatch[1]);
    if (!Number.isSafeInteger(modId) || modId <= 0) return sendJson(res, 400, { error: 'Mod de CurseForge no válido.' });
    return sendJson(res, 200, { files: await curseForgeModFiles(modId) });
  }

  if (req.method === 'POST' && pathname === '/api/curseforge/dependencies') {
    const data = await readJson(req);
    if (!Array.isArray(data.dependencies) || data.dependencies.length > 100) {
      return sendJson(res, 400, { error: 'La lista de dependencias no es válida.' });
    }
    const dependencies = data.dependencies.filter((dependency) =>
      dependency && Number.isSafeInteger(Number(dependency.modId)) && Number(dependency.modId) > 0 &&
      [1, 2, 3].includes(Number(dependency.relationType)))
      .map((dependency) => ({ modId: Number(dependency.modId), relationType: Number(dependency.relationType) }));
    return sendJson(res, 200, await getCurseForgeDependencyOverview(dependencies));
  }

  if (req.method === 'POST' && pathname === '/api/curseforge/install') {
    if (maintenanceLock) return sendJson(res, 409, { error: 'Ya hay una actualización en curso. Espera a que termine.' });
    const data = await readJson(req);
    const modId = Number(data.modId);
    const fileId = Number(data.fileId);
    const progressId = typeof data.progressId === 'string' ? data.progressId : '';
    const optionalDependencyIds = data.optionalDependencyIds === undefined ? [] : data.optionalDependencyIds;
    if (!Number.isSafeInteger(modId) || modId <= 0 || !Number.isSafeInteger(fileId) || fileId <= 0) {
      return sendJson(res, 400, { error: 'El mod o archivo de CurseForge no es válido.' });
    }
    if (!Array.isArray(optionalDependencyIds) || optionalDependencyIds.length > 100 || optionalDependencyIds.some(id => !Number.isSafeInteger(Number(id)) || Number(id) <= 0)) {
      return sendJson(res, 400, { error: 'La selección de dependencias opcionales no es válida.' });
    }
    if (progressId && !validProgressId(progressId)) return sendJson(res, 400, { error: 'Identificador de progreso no válido.' });
    maintenanceLock = 'curseforge';
    updateModOperationProgress(progressId, {
      phase: 'Iniciando descarga e instalación', percent: 0, currentItem: 0,
      totalItems: 0, downloadedBytes: 0, totalBytes: 0, done: false,
    });
    try {
      const result = await installCurseForgeSelection(modId, fileId, data.replaceName || '', progressId, optionalDependencyIds);
      const previous = readModOperationProgress(progressId) || {};
      const totalBytes = Number(previous.totalBytes) || result.bytes;
      updateModOperationProgress(progressId, {
        phase: 'Instalación completada', percent: 100, done: true,
        currentItem: previous.totalItems || 1, totalItems: previous.totalItems || 1,
        downloadedBytes: totalBytes, totalBytes,
      });
      return sendJson(res, 201, { ok: true, ...result, restartRequired: true });
    } catch (error) {
      updateModOperationProgress(progressId, {
        phase: 'No se pudo completar la instalación', done: true,
        error: error.message || 'Error durante la descarga o instalación.',
      });
      throw error;
    } finally {
      maintenanceLock = '';
    }
  }

  if (req.method === 'GET' && pathname === '/api/mods/pending') {
    return sendJson(res, 200, { pending: modStaging.list().map(({ name, replaceName, displayName, bytes, modId }) => ({ name, replaceName, displayName, bytes, modId })), activeBulkUpdate });
  }

  if (req.method === 'POST' && pathname === '/api/mods/update-all') {
    if (maintenanceLock) return sendJson(res, 409, { error: 'Ya hay una operación en curso. Espera a que termine.' });
    const data = await readJson(req);
    if (!validProgressId(data.progressId)) return sendJson(res, 400, { error: 'Identificador de progreso no válido.' });
    maintenanceLock = 'curseforge-bulk';
    activeBulkUpdate = data.progressId;
    updateModOperationProgress(data.progressId, { phase: 'Iniciando actualización', percent: 0, done: false, items: [] });
    void runBulkModUpdates(data.progressId);
    return sendJson(res, 202, { ok: true, progressId: data.progressId });
  }

  if (req.method === 'GET' && pathname === '/api/neoforge') {
    return sendJson(res, 200, await getNeoForgeVersions());
  }

  if (req.method === 'POST' && pathname === '/api/neoforge/update') {
    if (maintenanceLock) return sendJson(res, 409, { error: 'Ya hay una actualización en curso. Espera a que termine.' });
    const data = await readJson(req);
    if (typeof data.version !== 'string') return sendJson(res, 400, { error: 'Elige una versión de NeoForge.' });
    maintenanceLock = 'neoforge';
    try {
      const result = await updateNeoForge(data.version);
      return sendJson(res, 200, { ok: true, ...result, restartRequired: true });
    } finally {
      maintenanceLock = '';
    }
  }

  if (req.method === 'GET' && pathname === '/api/logs') {
    return sendJson(res, 200, { lines: await readLogs() });
  }

  if (req.method === 'GET' && pathname === '/api/ops') {
    return sendJson(res, 200, { entries: await readArrayJson(path.join(SERVER_DIR, 'ops.json')) });
  }

  if (req.method === 'POST' && pathname === '/api/ops') {
    const data = await readJson(req);
    if (!validPlayerName(data.name)) return sendJson(res, 400, { error: 'Nombre Java no válido.' });
    const action = data.action === 'remove' ? 'deop' : 'op';
    const result = await rconCommand(action + ' ' + data.name);
    return sendJson(res, 200, { result });
  }

  if (req.method === 'POST' && pathname === '/api/players/kick') {
    const data = await readJson(req);
    if (!validPlayerName(data.name)) return sendJson(res, 400, { error: 'Nombre Java no válido.' });
    const reason = cleanPlayerReason(data.reason);
    if (reason === null) return sendJson(res, 400, { error: 'El motivo debe tener hasta 160 caracteres y no incluir saltos de línea.' });
    const online = parseOnlinePlayers(await rconCommand('list'));
    if (!online.some((name) => name.toLowerCase() === data.name.toLowerCase())) {
      return sendJson(res, 409, { error: 'Ese jugador ya no está conectado.' });
    }
    const result = await rconCommand('kick ' + data.name + (reason ? ' ' + reason : ''));
    return sendJson(res, 200, { result });
  }

  if (req.method === 'POST' && pathname === '/api/players/ban') {
    const data = await readJson(req);
    if (!validPlayerName(data.name)) return sendJson(res, 400, { error: 'Nombre Java no válido.' });
    const reason = cleanPlayerReason(data.reason);
    if (reason === null) return sendJson(res, 400, { error: 'El motivo debe tener hasta 160 caracteres y no incluir saltos de línea.' });
    const result = await rconCommand('ban ' + data.name + (reason ? ' ' + reason : ''));
    return sendJson(res, 200, { result });
  }

  if (req.method === 'POST' && pathname === '/api/players/unban') {
    const data = await readJson(req);
    if (!validPlayerName(data.name)) return sendJson(res, 400, { error: 'Nombre Java no válido.' });
    const result = await rconCommand('pardon ' + data.name);
    return sendJson(res, 200, { result });
  }

  if (req.method === 'GET' && pathname === '/api/whitelist') {
    return sendJson(res, 200, { entries: await readArrayJson(path.join(SERVER_DIR, 'whitelist.json')) });
  }

  if (req.method === 'POST' && pathname === '/api/whitelist') {
    const data = await readJson(req);
    if (!validPlayerName(data.name)) return sendJson(res, 400, { error: 'Nombre Java no válido.' });
    const action = data.action === 'remove' ? 'whitelist remove' : 'whitelist add';
    const result = await rconCommand(action + ' ' + data.name);
    return sendJson(res, 200, { result });
  }

  if (req.method === 'GET' && pathname === '/api/mods/updates') {
    if (maintenanceLock) return sendJson(res, 409, { error: 'Espera a que termine la operación actual antes de comprobar actualizaciones.' });
    maintenanceLock = 'curseforge-check';
    try {
      return sendJson(res, 200, await checkCurseForgeModUpdates());
    } finally {
      maintenanceLock = '';
    }
  }

  if (req.method === 'GET' && pathname === '/api/mods') {
    const includeCurseForgeMetadata = url.searchParams.get('curseforge') === '1';
    const onlyName = url.searchParams.get('name') || '';
    if (onlyName && !safeModName(onlyName)) return sendJson(res, 400, { error: 'Nombre de mod no válido.' });
    const progressId = url.searchParams.get('progressId') || '';
    if (progressId && !validProgressId(progressId)) return sendJson(res, 400, { error: 'Identificador de progreso no válido.' });
    if (progressId) updateModOperationProgress(progressId, {
      phase: 'Preparando la actualización', percent: 0, current: 0, total: 0,
      downloadedBytes: 0, totalBytes: 0, done: false,
    });
    let onlyNames = null;
    const rawNames = url.searchParams.get('names');
    if (rawNames) {
      let parsedNames;
      try { parsedNames = JSON.parse(rawNames); } catch {
        return sendJson(res, 400, { error: 'La lista de archivos de mods no es válida.' });
      }
      if (!Array.isArray(parsedNames) || parsedNames.length > 100 ||
          parsedNames.some((name) => !safeModName(name))) {
        return sendJson(res, 400, { error: 'La lista de archivos de mods no es válida.' });
      }
      onlyNames = new Set(parsedNames);
    }
    const metadataStatus = {};
    const mods = await listMods({ includeCurseForgeMetadata, metadataStatus, metadataProgressId: progressId, onlyName, onlyNames });
    if (progressId) updateModOperationProgress(progressId, {
      phase: metadataStatus.error ? 'Actualización finalizada con avisos' : 'Imágenes actualizadas',
      percent: 100, current: mods.length, total: mods.length, done: true,
      error: metadataStatus.error || '',
    });
    return sendJson(res, 200, {
      mods,
      curseForgeMetadataLoaded: includeCurseForgeMetadata && Boolean(getCurseForgeKey()),
      curseForgeMetadataError: metadataStatus.error || '',
    });
  }

  if (req.method === 'PUT' && pathname === '/api/mods/upload') {
    if (maintenanceLock) return sendJson(res, 409, { error: 'Espera a que termine la actualización antes de cambiar los mods.' });
    const name = url.searchParams.get('name') || '';
    if (!safeModName(name)) return sendJson(res, 400, { error: 'Solo se permiten archivos .jar con nombre simple.' });
    const target = path.join(MODS_DIR, name);
    if (path.dirname(target) !== MODS_DIR) return sendJson(res, 400, { error: 'Ruta no válida.' });
    try {
      await fsp.access(target);
      req.resume();
      return sendJson(res, 409, { error: 'Ya existe un mod con ese nombre; elimínalo antes de reemplazarlo.' });
    } catch {}

    const temp = path.join(MODS_DIR, '.upload-' + crypto.randomBytes(8).toString('hex') + '.tmp');
    let byteCount = 0;
    const limiter = new Transform({
      transform(chunk, encoding, callback) {
        byteCount += chunk.length;
        if (byteCount > MAX_MOD_BYTES) callback(new Error('El archivo supera el límite de 300 MB.'));
        else callback(null, chunk);
      },
    });
    try {
      if (Number(req.headers['content-length'] || 0) > MAX_MOD_BYTES) {
        req.resume();
        return sendJson(res, 413, { error: 'El archivo supera el límite de 300 MB.' });
      }
      await pipeline(req, limiter, fs.createWriteStream(temp, { flags: 'wx' }));
      if (byteCount < 4) throw new Error('El archivo está vacío o incompleto.');
      const handle = await fsp.open(temp, 'r');
      const signature = Buffer.alloc(4);
      await handle.read(signature, 0, 4, 0);
      await handle.close();
      if (signature[0] !== 0x50 || signature[1] !== 0x4b) {
        throw new Error('El archivo no parece ser un .jar válido.');
      }
      await fsp.rename(temp, target);
      return sendJson(res, 201, { ok: true, name, restartRequired: true });
    } catch (error) {
      await fsp.rm(temp, { force: true }).catch(() => {});
      const status = error.message.includes('300 MB') ? 413 : 400;
      return sendJson(res, status, { error: error.message });
    }
  }

  if (req.method === 'DELETE' && pathname === '/api/mods') {
    if (maintenanceLock) return sendJson(res, 409, { error: 'Espera a que termine la actualización antes de cambiar los mods.' });
    const name = url.searchParams.get('name') || '';
    if (!safeModName(name)) return sendJson(res, 400, { error: 'Nombre de mod no válido.' });
    if (modStaging.list().some(entry => entry.name === name || entry.replaceName === name)) return sendJson(res, 409, { error: 'Este mod tiene una actualización preparada. Reinicia primero para aplicarla.' });
    await fsp.unlink(path.join(MODS_DIR, name));
    return sendJson(res, 200, { ok: true, restartRequired: true });
  }

  if (req.method === 'POST' && pathname === '/api/command') {
    const data = await readJson(req);
    if (typeof data.command !== 'string') return sendJson(res, 400, { error: 'Escribe una orden.' });
    const command = data.command.trim().replace(/^\/+/, '');
    if (!command || command.length > 2000 || /[\r\n\0]/.test(command)) {
      return sendJson(res, 400, { error: 'La orden está vacía o es demasiado larga.' });
    }
    const result = await rconCommand(command, 8000);
    return sendJson(res, 200, { result });
  }

  if (req.method === 'POST' && pathname === '/api/server/stop') {
    if (maintenanceLock) return sendJson(res, 409, { error: 'No se puede apagar el servidor durante una actualización del panel.' });
    await rconCommand('save-all', 10000);
    await rconCommand('stop', 5000).catch(() => '');
    return sendJson(res, 200, { ok: true, message: 'El servidor está guardando y apagándose.' });
  }

  if (req.method === 'POST' && pathname === '/api/server/restart') return sendJson(res, 200, await restartManagedServer());

  return sendJson(res, 404, { error: 'Ruta no encontrada.' });
}

async function restartManagedServer() {
if (maintenanceLock || backupRunning || backupQueued || options.externalBusy?.()) throw Object.assign(new Error('Espera a que termine el mantenimiento o la copia antes de iniciar o reiniciar Minecraft.'), {status:409});
    maintenanceLock = 'server-restart';
    try {
    if (!(await gameOnline())) {
      await launchServer();
    } else {
      let oldPid = 0;
      try { oldPid = Number(JSON.parse(await fsp.readFile(path.join(PANEL_DIR, 'telemetry', 'network.json'), 'utf8')).pid) || 0; } catch {}
      if (!oldPid) { try { oldPid = Number(JSON.parse(await fsp.readFile(path.join(PANEL_DIR, 'managed-process.json'), 'utf8')).pid) || 0; } catch {} }
      const oldProcessAlive = async () => {
        if(options.remote) { try { await options.remote.confirmStopped(); return false; } catch { return true; } }
        if (!oldPid) return false;
        try { process.kill(oldPid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
      };
      await rconCommand('save-all', 10000);
      await rconCommand('stop', 5000).catch(() => '');
      await waitUntil(
        async () => !(await gameOnline()) && !(await oldProcessAlive()),
        45000,
        'El servidor no terminó de apagarse en 45 segundos.',
      );
      await launchServer();
    }
    await waitUntil(
      async () => {
        try {
          await rconCommand('list', 1500);
          return true;
        } catch {
          return false;
        }
      },
      120000,
      'El servidor todavía no responde por RCON; revisa la consola y los logs.',
    );
    return { ok: true, message: 'Servidor listo.' };
    } finally {
      maintenanceLock = '';
    }
  
}

const staticFile = (res, pathname, req) => serveStaticFile(res, pathname, req, sendJson);

const itemCatalog = createItemCatalog({ serverDir: SERVER_DIR, panelDir:PANEL_DIR, minecraftVersion: CURSEFORGE_MC_VERSION });
const playerTools = createPlayerTools({
  serverDir: SERVER_DIR, panelDir:PANEL_DIR,
  rcon: rconCommand,
  onlineNames: async () => parseOnlinePlayers(await rconCommand('list')),
  canMutate: () => !maintenanceLock && !options.externalBusy?.(),
  canRestore: () => !backupRunning && backupQueued === 0,
  validateItemId: id => itemCatalog.hasItem(id),
  resolveItemArgument: (id, variant) => itemCatalog.giveArgument(id, variant),
  features: () => { if(options.record && !options.record.legacy)return {graves:false,horror:false};const names=fs.readdirSync(MODS_DIR);return {graves:names.some(n=>/^gravestone.*\.jar$/i.test(n)),horror:names.some(n=>/^serversidehorror.*\.jar$/i.test(n))}; },
  modernCommands: !options.record || /^26\./.test(CURSEFORGE_MC_VERSION),
});

const serverFeatures = createServerFeatures({serverDir: SERVER_DIR, panelDir:PANEL_DIR, rcon:rconCommand, restart:restartManagedServer, online:gameOnline, isBusy:()=>Boolean(maintenanceLock || backupRunning || backupQueued || options.externalBusy?.()), autoModpack:autoModpackStatus});

async function startIfStopped(handoff=false) {
  if(maintenanceLock||(options.externalBusy?.()&&!(handoff&&options.allowsHandoff?.())))throw new Error('Hay una operación activa.');
  maintenanceLock='server-start';
  try{
    if(await gameOnline())return false;
    await launchServer(handoff);
    return true;
  }finally{maintenanceLock='';}
}

return { config, handleApi, staticFile, sendJson, readJson, isLanAddress, constantTimeTokenMatch, startIfStopped,
  hostingCommand:rconCommand,applyHostingMods:()=>modStaging.apply(),
  isBusy: () => Boolean(maintenanceLock || backupRunning || backupQueued || serverFeatures.isBusy()), backup: () => enqueueBackup('platform'),
  close: () => { networkMonitor.stop(); playerTools.close(); serverFeatures.close(); clearInterval(backupScheduler); } };
}

module.exports = { createPanelInstance };
if (require.main === module) require('../main.cjs').start().then(app=>console.log('Wolf MC Panel escuchando en '+app.address.url)).catch(error=>{console.error(error.message);process.exitCode=1;});
