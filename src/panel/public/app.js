'use strict';

const $ = (id) => document.getElementById(id);
sessionStorage.removeItem('my-world-panel-token');
const selectedServerId = new URLSearchParams(location.search).get('server') || '';
const modOperationStorageKey = 'lobodk-bulk-mod-operation:' + (selectedServerId || 'home');
let token = '';
window.panelSession = null;
let activeView = 'overview';
let lastLogText = '';
let rawConsoleText = '';
function privateLogText(text) {
  if (!document.body.classList.contains('hide-addresses')) return text;
  return text.replace(/\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?\b/g, '[IP oculta]')
    .replace(/\b(?:[a-z0-9-]+\.)+[a-z]{2,63}(?::\d{1,5})?\b/gi, '[dirección oculta]');
}
function syncAddressRevealButtons() {
  for (const button of document.querySelectorAll('[data-reveal-address]')) {
    const row = button.closest('.address-row, .server-address-line');
    if (!row) continue;
    const visible = !row.classList.contains('address-concealed') && (!document.body.classList.contains('hide-addresses') || row.classList.contains('address-revealed'));
    button.textContent = visible ? 'Ocultar' : 'Mostrar';
    button.setAttribute('aria-expanded', String(visible));
    button.setAttribute('aria-label', (visible ? 'Ocultar' : 'Mostrar') + ' dirección' + (button.dataset.addressName ? ' de ' + button.dataset.addressName : ''));
  }
}
for (const row of document.querySelectorAll('.address-row')) {
  const button = document.createElement('button');
  button.type = 'button'; button.className = 'button secondary small-button address-reveal'; button.dataset.revealAddress = '';
  button.dataset.addressName = row.querySelector('span')?.textContent.trim() || '';
  row.insertBefore(button, row.querySelector('.copy-button'));
}
document.addEventListener('click', event => {
  const button = event.target.closest('[data-reveal-address]'); if (!button) return;
  const row = button.closest('.address-row, .server-address-line'); if (!row) return;
  const wasVisible = button.getAttribute('aria-expanded') === 'true';
  row.classList.toggle('address-revealed', !wasVisible); row.classList.toggle('address-concealed', wasVisible);
  syncAddressRevealButtons();
});
syncAddressRevealButtons();
$('addressPrivacyButton').addEventListener('click', () => {
  const hidden = document.body.classList.toggle('hide-addresses');
  document.querySelectorAll('.address-revealed,.address-concealed').forEach(row => row.classList.remove('address-revealed','address-concealed'));
  syncAddressRevealButtons();
  $('addressPrivacyButton').textContent = hidden ? 'Mostrar direcciones' : 'Ocultar direcciones';
  $('addressPrivacyButton').setAttribute('aria-pressed', String(hidden));
  $('consoleOutput').textContent = privateLogText(rawConsoleText);
});
let statusTimer = null;
let autoModpackTimer = null;
let logTimer = null;
let performanceTimer = null;
let playerTimer = null;
let currentMods = [];
let knownModNames = null;
let curseForgeResultsCache = [];
let modUpdateResults = new Map();
let serverOnline = false;
let curseForgeMetadataAttempted = false;
let curseForgeMetadataLoadPromise = null;
const curseForgeMetadataByFileName = new Map();

function showToast(message, isError = false) {
  const toast = $('toast');
  toast.textContent = message;
  toast.classList.toggle('error', isError);
  toast.classList.add('visible');
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove('visible'), 3500);
}

const pendingApiReads = new Map();
function api(url, options = {}) {
  if (options.method && options.method.toUpperCase() !== 'GET') return performApiRequest(url, options);
  const key = selectedServerId + '|' + token + '|' + url;
  if (pendingApiReads.has(key)) return pendingApiReads.get(key);
  const pending = performApiRequest(url, options); pendingApiReads.set(key, pending);
  pending.finally(() => { if(pendingApiReads.get(key) === pending) pendingApiReads.delete(key); }).catch(() => {});
  return pending;
}
async function performApiRequest(url, options = {}) {
  const headers = new Headers(options.headers || {});
  // Authentication uses a same-origin HttpOnly session cookie.
  if (selectedServerId) headers.set('X-Server-Id', selectedServerId);
  if (options.body && !(options.body instanceof File) && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  const response = await fetch(url, { ...options, headers });
  let data = {};
  try {
    data = await response.json();
  } catch {}
  if (response.status === 401 && url !== '/api/login') {
    logout(false);
    throw new Error('La sesión ha caducado. Vuelve a entrar.');
  }
  if (!response.ok) throw new Error(data.error || `Causa: el panel no pudo completar la petición (HTTP ${response.status}). Acción: vuelve a intentarlo y revisa la conexión o el diagnóstico si persiste.`);
  return data;
}

function setLoggedIn(loggedIn) {
  window.LobodkNetwork?.setActive(loggedIn && activeView === 'performance');
  window.LobodkPlayerTools?.setActive(loggedIn && activeView === 'player-tools');
  $('loginView').classList.toggle('hidden', loggedIn);
  $('appView').classList.toggle('hidden', !loggedIn);
  window.dispatchEvent(new CustomEvent('panel-auth', {detail:{loggedIn,session:window.panelSession}}));
  if (loggedIn) {
    if (!selectedServerId) {
      stopPolling();
      if (window.LobodkManager) window.LobodkManager.beginHome();
      else window.addEventListener('manager-ready', () => window.LobodkManager.beginHome(), { once: true });
      return;
    }
    if (window.LobodkFeatures) window.LobodkFeatures.init();
    else window.addEventListener('features-ready',()=>window.LobodkFeatures.init(),{once:true});
    if (window.LobodkManager) window.LobodkManager.serverContext();
    else window.addEventListener('manager-ready', () => window.LobodkManager.serverContext(), { once: true });
    loadEverything();
    startPolling();
  } else {
    stopPolling();
    window.LobodkFeatures?.activate(null);
  }
}

function logout(revoke = true) {
  if (revoke) fetch('/api/logout', {method:'POST'}).catch(()=>{});
  token = '';
  window.panelSession = null;
  pendingApiReads.clear();
  setLoggedIn(false);
}

function stopPolling() {
  clearInterval(autoModpackTimer);
  clearInterval(statusTimer);
  clearInterval(logTimer);
  clearInterval(performanceTimer);
  clearInterval(playerTimer);
  performanceTimer = null;
  playerTimer = null;
}

const pollingTasks = new Set();
function pollTask(task) {
  if(document.hidden || !token || pollingTasks.has(task)) return;
  pollingTasks.add(task); Promise.resolve().then(task).catch(() => {}).finally(() => pollingTasks.delete(task));
}
function startPolling() {
  stopPolling();
  autoModpackTimer = setInterval(() => { if(activeView === 'overview') pollTask(loadAutoModpackFingerprint); }, 15000);
  statusTimer = setInterval(() => pollTask(loadStatus), 10000);
  logTimer = setInterval(() => { if(activeView === 'console') pollTask(loadLogs); }, 3000);
  playerTimer = setInterval(() => { if(activeView === 'players') pollTask(loadPlayers); }, 5000);
}

function setOverviewConnectionState(online) {
  const serverCard = document.querySelector('.server-stat');
  if (serverCard) serverCard.classList.toggle('offline', !online);
  for (const id of ['heroStatusBadge', 'controlStatusBadge']) {
    const badge = $(id);
    if (!badge) continue;
    badge.classList.toggle('online', online);
    badge.classList.toggle('offline', !online);
  }
  if ($('heroStatus')) $('heroStatus').textContent = online ? 'Servidor online' : 'Servidor apagado';
  if ($('controlStatus')) $('controlStatus').textContent = online ? 'En línea' : 'Apagado';
}

function renderOverviewPlayers(players, emptyMessage = 'No hay jugadores conectados ahora.', countLabel) {
  const target = $('overviewConnectedPlayers');
  if ($('overviewPlayersCount')) {
    $('overviewPlayersCount').textContent = countLabel || players.length + (players.length === 1 ? ' conectado' : ' conectados');
  }
  if (!target) return;
  target.replaceChildren();
  if (!players.length) {
    const empty = document.createElement('li');
    empty.className = 'empty-row';
    empty.textContent = emptyMessage;
    target.append(empty);
    return;
  }
  for (const playerName of players) {
    const row = document.createElement('li');
    row.className = 'overview-player';
    const avatar = document.createElement('span');
    avatar.className = 'overview-avatar';
    avatar.setAttribute('aria-hidden', 'true');
    avatar.textContent = playerName.slice(0, 2).toUpperCase();
    const hash = [...playerName].reduce((value, character) => ((value * 31) + character.charCodeAt(0)) >>> 0, 0);
    avatar.style.setProperty('--avatar-hue', String(hash % 360));
    const dot = document.createElement('span');
    dot.className = 'player-online-dot';
    dot.setAttribute('aria-hidden', 'true');
    const name = document.createElement('strong');
    name.textContent = playerName;
    row.append(avatar, dot, name);
    target.append(row);
  }
}

async function loadStatus() {
  try {
    const status = await api('/api/status');
    serverOnline = Boolean(status.serverOnline);
    const badge = $('serverBadge');
    badge.classList.toggle('online', status.serverOnline);
    badge.classList.toggle('offline', !status.serverOnline);
    badge.classList.remove('checking');
    $('serverStatus').textContent = status.serverOnline ? 'Servidor online' : 'Servidor apagado';
    $('overviewState').textContent = status.serverOnline ? 'En línea' : 'Apagado';
    setOverviewConnectionState(Boolean(status.serverOnline));
    $('overviewMods').textContent = String(status.modCount || 0);
    const match = (status.players || '').match(/There are (\d+) of a max of (\d+) players online(?::\s*(.*))?/i);
    const playerNames = status.serverOnline && match
      ? (match[3] || '').split(',').map((name) => name.trim()).filter(Boolean)
      : [];
    $('serverMessage').textContent = status.rconReady
      ? (match
        ? `Hay ${match[1]} de ${match[2]} jugadores online${playerNames.length ? ': ' + playerNames.join(', ') : ''}.`
        : 'Consola conectada.')
      : (status.message || 'RCON no está disponible.');
    $('rconNotice').classList.toggle('hidden', status.rconReady);
    $('startButton').disabled = status.serverOnline;
    $('restartButton').disabled = !status.serverOnline || !status.rconReady;
    $('stopButton').disabled = !status.serverOnline || !status.rconReady;
    $('commandInput').disabled = !status.rconReady;
    $('commandForm').querySelector('button').disabled = !status.rconReady;
    $('opForm').querySelector('input').disabled = !status.rconReady;
    $('opForm').querySelector('button').disabled = !status.rconReady;
    $('whitelistForm').querySelector('input').disabled = !status.rconReady;
    $('whitelistForm').querySelector('button').disabled = !status.rconReady;
    $('banPlayerForm').querySelectorAll('input, button').forEach((control) => {
      control.disabled = !status.rconReady;
    });
    $('overviewPlayers').textContent = match
      ? match[1] + ' / ' + match[2] + ' jugadores'
      : (status.serverOnline ? 'Servidor listo' : 'Sin conexión');
    renderOverviewPlayers(
      playerNames,
      status.serverOnline && !match ? 'No se pudo consultar la lista de jugadores.' : 'No hay jugadores conectados ahora.',
      status.serverOnline && !match ? 'Sin datos' : undefined,
    );
  } catch (error) {
    serverOnline = false;
    $('serverBadge').classList.remove('checking');
    $('serverBadge').classList.remove('online');
    $('serverBadge').classList.add('offline');
    $('serverStatus').textContent = 'Sin respuesta';
    $('overviewState').textContent = 'Sin respuesta';
    $('overviewPlayers').textContent = 'Sin conexión';
    setOverviewConnectionState(false);
    if ($('heroStatus')) $('heroStatus').textContent = 'Sin respuesta';
    if ($('controlStatus')) $('controlStatus').textContent = 'Sin respuesta';
    renderOverviewPlayers([], 'No se pudo consultar la lista de jugadores.', 'Sin datos');
    $('serverMessage').textContent = error.message;
  }
}

async function loadLogs() {
  try {
    const data = await api('/api/logs');
    const output = $('consoleOutput');
    const shouldStick = output.scrollHeight - output.scrollTop - output.clientHeight < 80;
    rawConsoleText = data.lines.join('\n');
    output.textContent = privateLogText(rawConsoleText);
    if (shouldStick) output.scrollTop = output.scrollHeight;
    lastLogText = output.textContent;
  } catch {}
}

function renderList(target, entries, kind) {
  target.replaceChildren();
  if (!entries.length) {
    const empty = document.createElement('li');
    empty.className = 'empty-row';
    empty.textContent = 'La lista está vacía.';
    target.append(empty);
    return;
  }
  for (const entry of entries) {
    const li = document.createElement('li');
    li.className = 'player-row';
    const info = document.createElement('div');
    info.className = 'player-info';
    const name = document.createElement('strong');
    name.textContent = entry.name || '(sin nombre)';
    const detail = document.createElement('span');
    detail.textContent = kind === 'ops' ? 'Operador · nivel ' + (entry.level ?? 4) : 'Permitido';
    info.append(name, detail);
    const button = document.createElement('button');
    button.className = 'button danger small-button';
    button.type = 'button';
    button.textContent = kind === 'ops' ? 'Quitar' : 'Eliminar';
    button.addEventListener('click', async () => {
      const action = kind === 'ops' ? 'quitar el operador a ' : 'quitar de la whitelist a ';
      if (!window.confirm('¿Quieres ' + action + (entry.name || '') + '?')) return;
      try {
        await api('/api/' + kind, {
          method: 'POST',
          body: JSON.stringify({ action: 'remove', name: entry.name }),
        });
        showToast(kind === 'ops' ? 'Operador eliminado.' : 'Jugador eliminado de la whitelist.');
        await loadPlayers();
      } catch (error) {
        showToast(error.message, true);
      }
    });
    li.append(info, button);
    target.append(li);
  }
}

async function loadPlayers() {
  try {
    const [ops, whitelist, players] = await Promise.all([
      api('/api/ops'),
      api('/api/whitelist'),
      api('/api/players'),
    ]);
    renderList($('opsList'), ops.entries, 'ops');
    renderList($('whitelistList'), whitelist.entries, 'whitelist');
    renderOnlinePlayers(players.online || [], players.rconReady !== false);
    renderBannedPlayers(players.bannedPlayers || [], players.rconReady !== false);
  } catch (error) {
    showToast(error.message, true);
  }
}

function renderOnlinePlayers(players, rconReady) {
  const target = $('onlinePlayersList');
  target.replaceChildren();
  $('onlinePlayersCount').textContent = players.length + (players.length === 1 ? ' conectado' : ' conectados');
  if (!players.length) {
    const empty = document.createElement('li');
    empty.className = 'empty-row';
    empty.textContent = 'No hay jugadores conectados ahora.';
    target.append(empty);
    return;
  }
  for (const playerName of players) {
    const row = document.createElement('li');
    row.className = 'player-row';
    const info = document.createElement('div');
    info.className = 'player-info';
    const name = document.createElement('strong');
    name.textContent = playerName;
    const detail = document.createElement('span');
    detail.textContent = 'Conectado';
    info.append(name, detail);
    const actions = document.createElement('div');
    actions.className = 'player-actions';
    for (const action of ['kick', 'ban']) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'button small-button ' + (action === 'ban' ? 'danger' : 'secondary');
      button.textContent = action === 'kick' ? 'Expulsar' : 'Banear';
      button.disabled = !rconReady;
      button.addEventListener('click', () => managePlayer(playerName, action));
      actions.append(button);
    }
    row.append(info, actions);
    target.append(row);
  }
}

function renderBannedPlayers(entries, rconReady) {
  const target = $('bannedPlayersList');
  target.replaceChildren();
  if (!entries.length) {
    const empty = document.createElement('li');
    empty.className = 'empty-row';
    empty.textContent = 'No hay jugadores baneados.';
    target.append(empty);
    return;
  }
  for (const entry of entries) {
    const row = document.createElement('li');
    row.className = 'player-row';
    const info = document.createElement('div');
    info.className = 'player-info';
    const name = document.createElement('strong');
    name.textContent = entry.name || '(sin nombre)';
    const detail = document.createElement('span');
    const reason = entry.reason && entry.reason !== 'Banned by an operator' ? entry.reason : 'Sin motivo indicado';
    const expiry = entry.expires && entry.expires !== 'forever' ? ' · Hasta ' + entry.expires : '';
    detail.textContent = reason + expiry;
    info.append(name, detail);
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'button secondary small-button';
    button.textContent = 'Desbanear';
    button.disabled = !rconReady;
    button.addEventListener('click', async () => {
      if (!window.confirm('¿Quieres desbanear a ' + (entry.name || 'este jugador') + '?')) return;
      try {
        const result = await api('/api/players/unban', {
          method: 'POST',
          body: JSON.stringify({ name: entry.name }),
        });
        showToast(result.result || 'Jugador desbaneado.');
        await loadPlayers();
      } catch (error) {
        showToast(error.message, true);
      }
    });
    row.append(info, button);
    target.append(row);
  }
}

async function managePlayer(name, action) {
  const verb = action === 'kick' ? 'expulsar' : 'banear';
  const defaultReason = action === 'kick' ? 'Expulsado por un administrador' : 'Baneado por un administrador';
  const reason = window.prompt('Motivo para ' + verb + ' a ' + name + ' (opcional):', defaultReason);
  if (reason === null || !window.confirm('¿Quieres ' + verb + ' a ' + name + '?')) return;
  try {
    const result = await api('/api/players/' + action, {
      method: 'POST',
      body: JSON.stringify({ name, reason }),
    });
    showToast(result.result || (action === 'kick' ? 'Jugador expulsado.' : 'Jugador baneado.'));
    await Promise.all([loadPlayers(), loadStatus(), loadLogs()]);
  } catch (error) {
    showToast(error.message, true);
  }
}

function formatBytes(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function createProgressId() {
  return globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
}

function formatElapsed(milliseconds) {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  const minutes = Math.floor(seconds / 60);
  return minutes ? `${minutes} min ${seconds % 60} s` : `${seconds} s`;
}

function showOperationProgress(prefix, startedAt, label) {
  const box = $(`${prefix}Progress`);
  clearTimeout(box.hideTimer);
  box.classList.remove('hidden', 'failed');
  $(`${prefix}ProgressBar`).value = 0;
  $(`${prefix}ProgressLabel`).textContent = label;
  $(`${prefix}ProgressPercent`).textContent = '0%';
  $(`${prefix}ProgressDetail`).textContent = 'Tiempo transcurrido: ' + formatElapsed(Date.now() - startedAt);
}

function renderOperationProgress(prefix, progress, startedAt) {
  const bar = $(`${prefix}ProgressBar`);
  const label = $(`${prefix}ProgressLabel`);
  const percent = $(`${prefix}ProgressPercent`);
  const detail = $(`${prefix}ProgressDetail`);
  if (!progress?.found) {
    detail.textContent = 'Preparando la operación · Tiempo transcurrido: ' + formatElapsed(Date.now() - startedAt);
    return;
  }
  const value = Math.max(0, Math.min(100, Number(progress.percent) || 0));
  bar.value = value;
  percent.textContent = Math.round(value) + '%';
  label.textContent = progress.phase || 'En curso…';
  const parts = [];
  if (progress.currentItem && progress.totalItems) {
    parts.push(`Archivo ${progress.currentItem} de ${progress.totalItems}${progress.item ? ' · ' + progress.item : ''}`);
  } else if (progress.total > 0) {
    parts.push(`${progress.current || 0} de ${progress.total} mods${progress.item ? ' · ' + progress.item : ''}`);
  }
  if (progress.totalBytes > 0) {
    parts.push(`${formatBytes(progress.downloadedBytes || 0)} de ${formatBytes(progress.totalBytes)}`);
  } else if (progress.downloadedBytes > 0) {
    parts.push(`${formatBytes(progress.downloadedBytes)} descargados`);
  }
  if (progress.error) parts.push(progress.error);
  parts.push('Tiempo transcurrido: ' + formatElapsed(Date.now() - startedAt));
  detail.textContent = parts.join(' · ');
  if (prefix === 'modsBatch' && !progress.items && progress.item) {
    const row = document.createElement('li');
    row.textContent = progress.item + ' — ' + (progress.phase || 'Preparando');
    $('modsBatchProgressItems').replaceChildren(row);
  }
  $(`${prefix}Progress`).classList.toggle('failed', Boolean(progress.error));
}

function startOperationProgressMonitor(prefix, id, startedAt) {
  let inFlight = false;
  let active = true;
  const poll = async () => {
    if (!active || inFlight) return;
    inFlight = true;
    try {
      const progress = await api('/api/curseforge/progress?id=' + encodeURIComponent(id));
      if (active) renderOperationProgress(prefix, progress, startedAt);
    } catch (error) {
      if (active) $(`${prefix}ProgressDetail`).textContent = error.message + ' · Tiempo transcurrido: ' + formatElapsed(Date.now() - startedAt);
    } finally {
      inFlight = false;
    }
  };
  const timer = setInterval(poll, 350);
  poll();
  return () => {
    active = false;
    clearInterval(timer);
  };
}

function finishOperationProgress(prefix, startedAt, success, message) {
  const box = $(`${prefix}Progress`);
  const bar = $(`${prefix}ProgressBar`);
  bar.value = success ? 100 : bar.value;
  $(`${prefix}ProgressPercent`).textContent = Math.round(bar.value) + '%';
  $(`${prefix}ProgressLabel`).textContent = success ? 'Completado' : 'No se pudo completar';
  $(`${prefix}ProgressDetail`).textContent = `${message} · Tiempo total: ${formatElapsed(Date.now() - startedAt)}`;
  box.classList.toggle('failed', !success);
  clearTimeout(box.hideTimer);
  box.hideTimer = setTimeout(() => box.classList.add('hidden'), success ? 4500 : 8000);
}

function formatMemory(bytes) {
  if (bytes == null || bytes === '' || !Number.isFinite(Number(bytes)) || Number(bytes) < 0) return 'No disponible';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let value = Number(bytes);
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return value.toFixed(unit >= 2 ? 2 : 1) + ' ' + units[unit];
}

function formatDuration(seconds) {
  if (seconds == null || !Number.isFinite(Number(seconds))) return '—';
  let remaining = Math.max(0, Math.floor(Number(seconds)));
  const days = Math.floor(remaining / 86400);
  remaining %= 86400;
  const hours = Math.floor(remaining / 3600);
  remaining %= 3600;
  const minutes = Math.floor(remaining / 60);
  if (days) return `${days} d ${hours} h`;
  if (hours) return `${hours} h ${minutes} min`;
  return `${minutes} min`;
}

function setProgress(id, percent) {
  const value = Number(percent);
  $(id).value = Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 0;
}

async function loadPerformance() {
  try {
    const data = await api('/api/performance');
    $('perfUpdated').textContent = (data.hostLabel ? data.hostLabel+' · ' : '')+'Actualizado '+new Date(data.sampledAt).toLocaleTimeString('es-ES');
    $('perfError').textContent = data.telemetryError || '';

    const total = Number(data.totalMemoryBytes) || 0;
    const free = Number(data.freeMemoryBytes) || 0;
    const usedHostPercent = total > 0 ? ((total - free) / total) * 100 : 0;
    $('perfHostMemory').textContent = total > 0 ? formatMemory(free) : 'No disponible';
    $('perfHostMemoryDetail').textContent = total > 0
      ? `${formatMemory(total)} de RAM total · ${usedHostPercent.toFixed(1)} % en uso`
      : 'No se pudo leer la memoria del PC.';
    setProgress('perfHostMemoryProgress', usedHostPercent);
    $('perfJvmInitial').textContent = formatMemory(data.heapMinBytes);
    $('perfJvmMax').textContent = formatMemory(data.heapMaxBytes);
    $('perfViewDistance').textContent = data.viewDistance == null ? '—' : `${data.viewDistance} chunks`;
    $('perfSimulationDistance').textContent = data.simulationDistance == null ? '—' : `${data.simulationDistance} chunks`;
    if (data.viewDistance != null && document.activeElement !== $('viewDistanceSlider')) {
      $('viewDistanceSlider').value = String(data.viewDistance);
      $('viewDistanceValue').textContent = `${data.viewDistance} chunks`;
    }
    if (data.simulationDistance != null && document.activeElement !== $('simulationDistanceSlider')) {
      $('simulationDistanceSlider').max = String(data.viewDistance || 32);
      $('simulationDistanceSlider').value = String(data.simulationDistance);
      $('simulationDistanceValue').textContent = `${data.simulationDistance} chunks`;
    }

    if (!data.running) {
      $('perfHeapUsed').textContent = data.running===false?'Servidor apagado':'Estado no disponible';
      $('perfHeapDetail').textContent = data.running===false?'No hay una JVM del servidor activa.':'No se pudo confirmar el estado del servidor.';
      $('perfHeapPercent').textContent = '—';
      $('perfWorkingSet').textContent = '—';
      $('perfProcessPrivate').textContent = 'Memoria privada: —';
      $('perfProcessPercent').textContent = '—';
      $('perfCpu').textContent = '—';
      $('perfCpuDetail').textContent = data.running===false?'Servidor apagado':'Sin datos recientes';
      $('perfUptime').textContent = '—';
      $('perfUptimeDetail').textContent = 'Desde el último arranque';
      ['perfHeapProgress', 'perfProcessProgress', 'perfCpuProgress'].forEach((id) => setProgress(id, 0));
      return;
    }

    const heapUsed = data.heapUsedBytes == null ? NaN : Number(data.heapUsedBytes);
    const heapMax = data.heapMaxBytes == null ? NaN : Number(data.heapMaxBytes);
    const heapPercent = Number.isFinite(heapUsed) && heapMax > 0 ? (heapUsed / heapMax) * 100 : null;
    $('perfHeapUsed').textContent = Number.isFinite(heapUsed) ? formatMemory(heapUsed) : 'No disponible';
    $('perfHeapDetail').textContent = heapMax > 0 ? `de ${formatMemory(heapMax)} máximos` : 'Límite máximo no detectado';
    $('perfHeapPercent').textContent = heapPercent == null ? 'Heap JVM' : `${heapPercent.toFixed(1)} % del máximo`;
    setProgress('perfHeapProgress', heapPercent);

    const workingSet = data.workingSetBytes == null ? NaN : Number(data.workingSetBytes);
    const privateBytes = data.privateBytes == null ? NaN : Number(data.privateBytes);
    const processPercent = total > 0 && Number.isFinite(workingSet) ? (workingSet / total) * 100 : null;
    $('perfWorkingSet').textContent = Number.isFinite(workingSet) ? formatMemory(workingSet) : 'No disponible';
    $('perfProcessPrivate').textContent = Number.isFinite(privateBytes)
      ? 'Memoria privada: ' + formatMemory(privateBytes)
      : 'Memoria privada: no disponible';
    $('perfProcessPercent').textContent = processPercent == null ? 'RAM residente del PC' : `${processPercent.toFixed(1)} % de la RAM del PC`;
    setProgress('perfProcessProgress', processPercent);

    const cpuPercent = data.cpuPercent == null ? NaN : Number(data.cpuPercent);
    $('perfCpu').textContent = Number.isFinite(cpuPercent) ? `${cpuPercent.toFixed(1)} %` : 'Midiendo…';
    $('perfCpuDetail').textContent = `${data.logicalProcessors || '—'} procesadores lógicos`;
    setProgress('perfCpuProgress', cpuPercent);
    $('perfUptime').textContent = formatDuration(data.uptimeSeconds);
    $('perfUptimeDetail').textContent = data.startedAt
      ? 'Arrancó ' + new Date(data.startedAt).toLocaleString('es-ES')
      : 'Desde el último arranque';
  } catch (error) {
    $('perfError').textContent = error.message;
  }
}

function syncDistanceSliders() {
  const view = Number($('viewDistanceSlider').value);
  const simulation = $('simulationDistanceSlider');
  simulation.max = String(view);
  if (Number(simulation.value) > view) simulation.value = String(view);
  $('viewDistanceValue').textContent = `${view} chunks`;
  $('simulationDistanceValue').textContent = `${simulation.value} chunks`;
}

async function saveDistances() {
  const button = $('saveDistancesButton');
  const status = $('distanceSaveStatus');
  button.disabled = true;
  status.textContent = 'Guardando…';
  try {
    const result = await api('/api/config/distances', {
      method: 'PUT',
      body: JSON.stringify({
        viewDistance: Number($('viewDistanceSlider').value),
        simulationDistance: Number($('simulationDistanceSlider').value),
      }),
    });
    $('perfViewDistance').textContent = `${result.viewDistance} chunks`;
    $('perfSimulationDistance').textContent = `${result.simulationDistance} chunks`;
    status.textContent = 'Guardado; se aplica al próximo arranque.';
    showToast('Distancias guardadas.');
  } catch (error) {
    status.textContent = error.message;
    showToast(error.message, true);
  } finally {
    button.disabled = false;
  }
}

function formatBackupTime(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('es-ES');
}

function compareNeoForgeVersions(left, right) {
  const a = String(left || '').split('.').map(Number);
  const b = String(right || '').split('.').map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const difference = (a[i] || 0) - (b[i] || 0);
    if (difference) return difference;
  }
  return 0;
}

async function loadBackups() {
  try {
    const data = await api('/api/backups');
    $('autoBackupToggle').checked = data.automaticEnabled;
    $('backupDirectory').textContent = data.directory;
    $('backupDirectory').title = data.directory;
    $('backupNextRun').textContent = data.automaticEnabled ? formatBackupTime(data.nextAt) : 'Desactivada';
    $('backupError').textContent = data.lastError || '';
    $('backupStatus').textContent = data.running
      ? (data.running.kind === 'restauración'
        ? 'Restaurando el servidor…'
        : `Creando copia ${data.running.kind}…${data.queued ? ` · ${data.queued} en cola` : ''}`)
      : (data.lastBackup ? `Última copia: ${formatBackupTime(data.lastBackup.createdAt)} · ${formatBytes(data.lastBackup.bytes)}` : 'Todavía no hay copias guardadas.');
    const list = $('backupList');
    list.replaceChildren();
    if (!data.backups.length) {
      const empty = document.createElement('li');
      empty.className = 'empty-row';
      empty.textContent = 'Las copias aparecerán aquí cuando se cree la primera.';
      list.append(empty);
      return;
    }
    for (const backup of data.backups) {
      const item = document.createElement('li');
      const name = document.createElement('strong');
      name.textContent = backup.name;
      const detail = document.createElement('span');
      detail.textContent = `${formatBackupTime(backup.createdAt)} · ${formatBytes(backup.bytes)}`;
      const restoreButton = document.createElement('button');
      restoreButton.className = 'button secondary small-button restore-backup-button';
      restoreButton.type = 'button';
      restoreButton.textContent = 'Restaurar';
      restoreButton.setAttribute('aria-label', 'Restaurar copia ' + backup.name);
      restoreButton.addEventListener('click', () => restoreBackup(backup, restoreButton));
      item.append(name, detail, restoreButton);
      list.append(item);
    }
  } catch (error) {
    $('backupStatus').textContent = error.message;
  }
}

async function loadNeoForge() {
  if (selectedServerId && selectedServerId !== 'main') return;
  const button = $('updateNeoForgeButton');
  try {
    const data = await api('/api/neoforge');
    $('neoForgeCurrent').textContent = data.current || 'No detectada';
    const select = $('neoForgeVersion');
    select.replaceChildren();
    for (const version of data.versions || []) {
      const option = document.createElement('option');
      option.value = version;
      option.textContent = version + (version === data.latest ? ' · última estable' : '');
      select.append(option);
    }
    if (data.latest) select.value = data.latest;
    const updateAvailable = data.latest && data.latest !== data.current;
    button.disabled = !updateAvailable;
    $('neoForgeStatus').textContent = data.latest
      ? (updateAvailable ? `Última versión estable: ${data.latest}.` : 'Ya tienes la última versión estable publicada.')
      : 'No se encontró una versión estable disponible para Minecraft 26.3.';
  } catch (error) {
    $('neoForgeStatus').textContent = error.message;
    button.disabled = true;
  }
}

async function updateNeoForge() {
  const version = $('neoForgeVersion').value;
  if (!version || !window.confirm(`Actualizar NeoForge a ${version}? Se creará una copia antes de iniciar. El servidor debe estar apagado.`)) return;
  const button = $('updateNeoForgeButton');
  button.disabled = true;
  $('neoForgeStatus').textContent = 'Creando copia y ejecutando el instalador oficial; puede tardar varios minutos…';
  try {
    const result = await api('/api/neoforge/update', { method: 'POST', body: JSON.stringify({ version }) });
    $('neoForgeCurrent').textContent = result.version;
    $('neoForgeStatus').textContent = 'NeoForge actualizado. La copia previa está guardada en Documentos; inicia el servidor cuando quieras.';
    showToast('NeoForge actualizado.');
    await loadBackups();
    await loadNeoForge();
  } catch (error) {
    $('neoForgeStatus').textContent = error.message;
    showToast(error.message, true);
    button.disabled = false;
  }
}

async function createManualBackup() {
  const button = $('createBackupButton');
  button.disabled = true;
  button.textContent = 'Creando copia…';
  $('backupStatus').textContent = 'Guardando mundo y comprimiendo archivos…';
  try {
    const result = await api('/api/backups/manual', { method: 'POST', body: '{}' });
    showToast('Copia creada: ' + result.backup.name);
    await loadBackups();
  } catch (error) {
    $('backupStatus').textContent = error.message;
    showToast(error.message, true);
  } finally {
    button.disabled = false;
    button.textContent = 'Crear copia manual';
  }
}

async function restoreBackup(backup, button) {
  const confirmation = `Vas a restaurar “${backup.name}”. Esto detendrá Minecraft y reemplazará el mundo y los demás archivos incluidos en esa copia. Antes se guardará el estado actual en Restauración. Al terminar, Minecraft quedará apagado y podrás iniciarlo desde el panel. ¿Continuar?`;
  if (!window.confirm(confirmation)) return;
  const controls = [
    $('createBackupButton'),
    $('autoBackupToggle'),
    ...document.querySelectorAll('.restore-backup-button'),
  ];
  controls.forEach((control) => { control.disabled = true; });
  button.textContent = 'Restaurando…';
  $('backupStatus').textContent = 'Deteniendo Minecraft, guardando el estado actual y restaurando la copia…';
  try {
    const result = await api('/api/backups/restore', {
      method: 'POST',
      body: JSON.stringify({ name: backup.name }),
    });
    showToast(result.message || 'Copia restaurada.');
    await Promise.all([loadBackups(), loadStatus(), loadLogs(), loadPlayers()]);
  } catch (error) {
    $('backupError').textContent = error.message;
    showToast(error.message, true);
    await Promise.all([loadBackups(), loadStatus()]);
  } finally {
    controls.forEach((control) => { control.disabled = false; });
    button.textContent = 'Restaurar';
  }
}

async function loadCurseForgeStatus() {
  try {
    const data = await api('/api/curseforge/status');
    $('curseForgeStatus').textContent = data.configured ? `Clave configurada · ${data.minecraftVersion} / ${data.loader}` : 'Falta la clave API';
    $('curseForgeSearchForm').querySelector('button').disabled = !data.configured;
  } catch (error) {
    $('curseForgeStatus').textContent = error.message;
  }
}

async function saveCurseForgeKey(event) {
  event.preventDefault();
  const input = $('curseForgeKey');
  const apiKey = input.value.trim();
  if (!apiKey) return showToast('Pega primero la clave API de CurseForge.', true);
  try {
    await api('/api/curseforge/key', { method: 'POST', body: JSON.stringify({ apiKey }) });
    input.value = '';
    showToast('Clave de CurseForge guardada en este PC.');
    await loadCurseForgeStatus();
    curseForgeMetadataAttempted = false;
    await loadMods({ forceCurseForgeMetadata: true });
  } catch (error) {
    showToast(error.message, true);
  }
}

async function removeCurseForgeKey() {
  if (!window.confirm('¿Quitar la clave guardada en este PC?')) return;
  try {
    await api('/api/curseforge/key', { method: 'DELETE' });
    $('curseForgeResults').replaceChildren();
    showToast('Clave de CurseForge eliminada del panel.');
    await loadCurseForgeStatus();
  } catch (error) {
    showToast(error.message, true);
  }
}

function normalizeModIdentity(value, fileName = false) {
  let text = String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  if (fileName) {
    text = text.replace(/\.jar$/i, '').replace(/[-_.](?:mc)?v?\d+(?:[._-][a-z0-9]+)*.*$/i, '');
    text = text.replace(/[-_.](?:neoforge|forge|fabric|quilt|api|standalone)(?:[-_.].*)?$/i, '');
  }
  return text.replace(/\b(?:minecraft|neoforge|forge|fabric|quilt|api|standalone)\b/gi, ' ').replace(/[^a-z0-9]+/g, '');
}

function findInstalledCurseForgeMod(mod) {
  const prepared = pendingModEntries.find(entry => entry.modId === Number(mod.id));
  if (prepared) return { name: prepared.replaceName || prepared.name, displayName: prepared.displayName, pending: true };
  const identities = [mod.slug, mod.name].map((value) => normalizeModIdentity(value)).filter((value) => value.length >= 4);
  for (const installed of currentMods) {
    const localIdentities = [
      normalizeModIdentity(installed.name, true),
      normalizeModIdentity(installed.displayName),
    ].filter((value) => value.length >= 4);
    if (identities.some((identity) => localIdentities.includes(identity))) return installed;
    const slug = normalizeModIdentity(mod.slug);
    if (slug.length >= 6 && localIdentities.some((identity) => identity.startsWith(slug) || slug.startsWith(identity))) return installed;
  }
  return null;
}

async function refreshInstalledModsForSearch() {
  await loadPendingMods();
  const data = await api('/api/mods');
  currentMods = mergeCurseForgeMetadata(data.mods || []);
}

function mergeCurseForgeMetadata(mods) {
  return mods.map((mod) => {
    if (mod.curseForgeMatched) {
      curseForgeMetadataByFileName.set(mod.name, {
        displayName: mod.displayName,
        curseForgeLogo: mod.curseForgeLogo,
        curseForgeUrl: mod.curseForgeUrl,
        curseForgeSummary: mod.curseForgeSummary,
      });
    }
    const known = curseForgeMetadataByFileName.get(mod.name);
    return known ? { ...mod, ...known } : mod;
  });
}

async function refreshCurseForgeMetadataForMod(fileName) {
  const data = await api('/api/mods?curseforge=1&name=' + encodeURIComponent(fileName));
  const updated = mergeCurseForgeMetadata(data.mods || []);
  if (knownModNames) knownModNames.add(fileName);
  return {
    matched: updated.some((mod) => mod.name === fileName && mod.curseForgeMatched),
    configured: Boolean(data.curseForgeMetadataLoaded),
    error: data.curseForgeMetadataError || '',
  };
}

function rememberCurseForgeMetadata(fileName, project) {
  if (!fileName || !project) return;
  curseForgeMetadataByFileName.set(fileName, {
    displayName: project.name || project.displayName || fileName,
    curseForgeLogo: project.logo || project.curseForgeLogo || '',
    curseForgeUrl: project.url || project.curseForgeUrl || '',
    curseForgeSummary: project.summary || project.curseForgeSummary || '',
  });
}

function renderCurseForgeResult(mod) {
  const card = document.createElement('article');
  card.className = 'curseforge-result';
  const installed = findInstalledCurseForgeMod(mod);
  if (mod.logo) {
    const image = document.createElement('img');
    image.className = 'curseforge-logo';
    image.src = mod.logo;
    image.alt = '';
    image.loading = 'lazy';
    card.append(image);
  }
  const main = document.createElement('div');
  main.className = 'curseforge-result-main';
  const heading = document.createElement('div');
  heading.className = 'curseforge-result-heading';
  const name = document.createElement('strong');
  name.textContent = mod.name;
  const downloads = document.createElement('span');
  downloads.className = 'count-pill';
  downloads.textContent = `${Number(mod.downloads || 0).toLocaleString('es-ES')} descargas`;
  heading.append(name, downloads);
  if (installed) {
    const installedBadge = document.createElement('span');
    installedBadge.className = 'count-pill installed-badge';
    installedBadge.textContent = installed.pending ? 'Preparado · reinicio pendiente' : 'Instalado';
    heading.append(installedBadge);
  }
  const summary = document.createElement('p');
  summary.className = 'muted';
  summary.textContent = mod.summary || 'Sin descripción.';
  const tools = document.createElement('div');
  tools.className = 'curseforge-tools';
  const versionsButton = document.createElement('button');
  versionsButton.type = 'button';
  versionsButton.className = 'button secondary small-button';
  versionsButton.textContent = 'Ver versiones compatibles';
  if (installed?.pending) {
    versionsButton.disabled = true;
    versionsButton.textContent = 'Preparado para el próximo reinicio';
  }
  const versions = document.createElement('div');
  versions.className = 'curseforge-version-picker hidden';
  versionsButton.addEventListener('click', async () => {
    if (!versions.classList.contains('hidden')) {
      versions.classList.add('hidden');
      return;
    }
    versions.classList.remove('hidden');
    if (versions.dataset.loaded === 'true') return;
    versionsButton.disabled = true;
    versionsButton.textContent = 'Buscando versiones…';
    try {
      const data = await api(`/api/curseforge/mods/${mod.id}/files`);
      versions.dataset.loaded = 'true';
      if (!data.files.length) {
        const empty = document.createElement('p');
        empty.className = 'hint';
        empty.textContent = 'CurseForge no muestra archivos compatibles con la versión y el loader de este servidor.';
        versions.append(empty);
        return;
      }
      const fileLabel = document.createElement('label');
      fileLabel.textContent = 'Versión compatible';
      const fileSelect = document.createElement('select');
      fileSelect.className = 'cf-file-select';
      for (const file of data.files) {
        const option = document.createElement('option');
        option.value = String(file.id);
        const releaseDate = file.fileDate ? ` · ${new Date(file.fileDate).toLocaleDateString('es-ES')}` : '';
        const fileSize = Number(file.fileLength) > 0 ? ` · ${formatBytes(Number(file.fileLength))}` : '';
        option.textContent = `${file.displayName || file.fileName}${releaseDate}${fileSize}`;
        fileSelect.append(option);
      }
      fileLabel.append(fileSelect);
      const dependencyPanel = document.createElement('div');
      dependencyPanel.className = 'cf-dependencies';
      let dependencyOverview = { required: [], optional: [] };
      let dependenciesResolved = true;
      let dependencyRequestId = 0;
      const replaceLabel = document.createElement('label');
      replaceLabel.textContent = 'Reemplazar mod instalado (opcional)';
      const replaceSelect = document.createElement('select');
      replaceSelect.className = 'cf-replace-select';
      const addOption = document.createElement('option');
      addOption.value = '';
      addOption.textContent = 'Instalar como mod nuevo';
      replaceSelect.append(addOption);
      for (const installedMod of currentMods) {
        const option = document.createElement('option');
        option.value = installedMod.name;
        option.textContent = `${installedMod.displayName} · ${installedMod.name}`;
        if (installed && installed.name === installedMod.name) option.selected = true;
        replaceSelect.append(option);
      }
      replaceLabel.append(replaceSelect);
      const install = document.createElement('button');
      install.type = 'button';
      install.className = 'button primary small-button';
      install.textContent = 'Instalar';
      const updateInstallLabel = () => {
        const action = replaceSelect.value ? 'Actualizar' : 'Instalar';
        const requiredMissing = dependencyOverview.required.filter((dependency) => !dependency.installedFileName).length;
        const optionalSelected = [...dependencyPanel.querySelectorAll('.cf-dependency-row input:not(:disabled):checked')].length;
        const total = requiredMissing + optionalSelected;
        install.textContent = total ? `${action} + ${total} dependencia${total === 1 ? '' : 's'}` : action;
      };
      const renderDependencyOverview = () => {
        dependencyPanel.replaceChildren();
        const addGroup = (title, dependencies, required) => {
          if (!dependencies.length) return;
          const heading = document.createElement('strong');
          heading.className = 'cf-dependency-heading';
          heading.textContent = title;
          dependencyPanel.append(heading);
          for (const dependency of dependencies) {
            const row = document.createElement('label');
            row.className = 'cf-dependency-row';
            const marker = document.createElement('input');
            marker.type = 'checkbox';
            marker.checked = required || Boolean(dependency.installedFileName);
            marker.disabled = required || Boolean(dependency.installedFileName);
            row.classList.toggle('is-locked', marker.disabled);
            marker.dataset.modId = String(dependency.modId);
            marker.setAttribute('aria-label', `${required ? 'Dependencia necesaria' : 'Instalar dependencia opcional'}: ${dependency.name}`);
            const copy = document.createElement('span');
            copy.className = 'cf-dependency-copy';
            const name = document.createElement('strong');
            name.textContent = dependency.name;
            const detail = document.createElement('small');
            detail.textContent = required
              ? (dependency.installedFileName ? `Ya instalada: ${dependency.installedFileName}` : 'Se instalará también con este mod')
              : (dependency.installedFileName ? `Opcional · ya instalada: ${dependency.installedFileName}` : 'Opcional · no se instalará automáticamente');
            if (!required && !marker.disabled) marker.addEventListener('change', () => {
              detail.textContent = marker.checked ? 'Opcional · se instalará con este mod' : 'Opcional · no se instalará automáticamente';
              updateInstallLabel();
            });
            copy.append(name, detail);
            if (dependency.logo) {
              const image = document.createElement('img');
              image.className = 'cf-dependency-logo';
              image.src = dependency.logo;
              image.alt = '';
              image.loading = 'lazy';
              row.append(image);
            }
            row.append(marker, copy);
            dependencyPanel.append(row);
          }
        };
        addGroup('Dependencias necesarias', dependencyOverview.required, true);
        addGroup('Dependencias opcionales', dependencyOverview.optional, false);
        if (!dependencyOverview.required.length && !dependencyOverview.optional.length) {
          const empty = document.createElement('small');
          empty.textContent = 'No declara dependencias adicionales.';
          dependencyPanel.append(empty);
        }
        updateInstallLabel();
        install.disabled = !dependenciesResolved;
      };
      const loadDependenciesForSelectedFile = async () => {
        const requestId = ++dependencyRequestId;
        const selected = data.files.find((file) => file.id === Number(fileSelect.value));
        const declarations = (selected?.dependencies || []).filter((dependency) => [1, 2, 3].includes(Number(dependency.relationType)));
        if (!declarations.length) {
          dependencyOverview = { required: [], optional: [] };
          dependenciesResolved = true;
          renderDependencyOverview();
          return;
        }
        dependenciesResolved = false;
        install.disabled = true;
        dependencyPanel.replaceChildren();
        const loading = document.createElement('small');
        loading.textContent = 'Comprobando bibliotecas y dependencias…';
        dependencyPanel.append(loading);
        try {
          const overview = await api('/api/curseforge/dependencies', {
            method: 'POST',
            body: JSON.stringify({ dependencies: declarations }),
          });
          if (requestId !== dependencyRequestId) return;
          dependencyOverview = overview;
          dependenciesResolved = true;
          renderDependencyOverview();
        } catch (error) {
          if (requestId !== dependencyRequestId) return;
          dependencyPanel.replaceChildren();
          const message = document.createElement('small');
          message.className = 'error-text';
          message.textContent = 'No se pudieron comprobar las dependencias: ' + error.message;
          dependencyPanel.append(message);
          install.disabled = true;
        }
      };
      replaceSelect.addEventListener('change', updateInstallLabel);
      fileSelect.addEventListener('change', loadDependenciesForSelectedFile);
      install.addEventListener('click', async () => {
        if (!dependenciesResolved) return;
        const replaceName = replaceSelect.value;
        const selectedFile = fileSelect.value;
        const action = replaceName ? 'reemplazar ' + replaceName : 'instalar ' + mod.name;
        const dependenciesToInstall = dependencyOverview.required.filter((dependency) => !dependency.installedFileName);
        const optionalDependencyIds = [...dependencyPanel.querySelectorAll('.cf-dependency-row input:not(:disabled):checked')]
          .map((input) => Number(input.dataset.modId)).filter((id) => Number.isSafeInteger(id) && id > 0);
        const selectedOptional = dependencyOverview.optional.filter((dependency) => optionalDependencyIds.includes(Number(dependency.modId)) && !dependency.installedFileName);
        const dependenciesNotice = dependenciesToInstall.length
          ? ` También se instalarán las dependencias necesarias: ${dependenciesToInstall.map((dependency) => dependency.name).join(', ')} y las dependencias obligatorias de esas bibliotecas, si las hubiera.`
          : '';
        const optionalNotice = selectedOptional.length
          ? ` También se instalarán las dependencias opcionales seleccionadas: ${selectedOptional.map((dependency) => dependency.name).join(', ')} y sus dependencias obligatorias, si las hubiera.`
          : '';
        const installNotice = replaceName
          ? `¿Quieres ${action} con ${fileSelect.selectedOptions[0]?.textContent}?${dependenciesNotice}${optionalNotice} Se preparará con el servidor encendido y se aplicará al reiniciar.`
          : `¿Quieres ${action} con ${fileSelect.selectedOptions[0]?.textContent}?${dependenciesNotice}${optionalNotice} Se añadirá ahora y quedará listo al reiniciar el servidor; Los mods se activan al arrancar Minecraft.`;
        if (!window.confirm(installNotice)) return;
        install.disabled = true;
        install.textContent = 'Descargando e instalando…';
        const progressId = createProgressId();
        const startedAt = Date.now();
        showOperationProgress('curseForgeInstall', startedAt, 'Preparando la instalación…');
        const stopMonitoring = startOperationProgressMonitor('curseForgeInstall', progressId, startedAt);
        try {
          const result = await api('/api/curseforge/install', {
            method: 'POST',
            body: JSON.stringify({ modId: mod.id, fileId: Number(selectedFile), replaceName, progressId, optionalDependencyIds }),
          });
          rememberCurseForgeMetadata(result.name, mod);
          const addedDependencies = (result.installedDependencies || []).filter((dependency) => !dependency.installed);
          for (const dependency of result.installedDependencies || []) {
            rememberCurseForgeMetadata(dependency.fileName, {
              name: dependency.projectName,
              logo: dependency.logo,
              summary: dependency.summary,
              url: dependency.url,
            });
          }
          if (!result.pending && replaceName && replaceName !== result.name) curseForgeMetadataByFileName.delete(replaceName);
          if (replaceName) modUpdateResults.delete(replaceName);
          const dependencyMessage = addedDependencies.length
            ? ` También se instalaron ${addedDependencies.map((dependency) => dependency.projectName).join(', ')}.`
            : '';
          showToast((replaceName ? 'Mod actualizado; versión anterior guardada para recuperación.' : 'Mod añadido.') + dependencyMessage + ' Se aplicará al reiniciar el servidor.');
          await loadMods();
          renderSortedCurseForgeResults();
          if (result.restartRequired) await loadStatus();
          stopMonitoring();
          finishOperationProgress('curseForgeInstall', startedAt, true,
            `Descargado e instalado · ${formatBytes(result.bytes || 0)}${addedDependencies.length ? ` más ${addedDependencies.length} dependencia(s)` : ''}`);

        } catch (error) {
          stopMonitoring();
          finishOperationProgress('curseForgeInstall', startedAt, false, error.message);
          showToast(error.message, true);
          install.textContent = replaceName ? 'Actualizar mod' : 'Instalar';
          install.disabled = false;
        }
      });
      versions.append(fileLabel, dependencyPanel, replaceLabel, install);
      await loadDependenciesForSelectedFile();
    } catch (error) {
      const message = document.createElement('p');
      message.className = 'hint error-text';
      message.textContent = error.message;
      versions.append(message);
    } finally {
      versionsButton.disabled = false;
      versionsButton.textContent = 'Ver versiones compatibles';
    }
  });
  tools.append(versionsButton);
  if (installed) {
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'button danger small-button';
    remove.textContent = 'Desinstalar';
    if (installed.pending) { remove.disabled = true; remove.title = 'Aplica primero los mods preparados reiniciando el servidor.'; }
    remove.addEventListener('click', async () => {
      if (!window.confirm(`¿Desinstalar ${mod.name} (${installed.name}) del servidor? Tendrás que reiniciar Minecraft para aplicar el cambio.`)) return;
      remove.disabled = true;
      remove.textContent = 'Quitando…';
      try {
        await api('/api/mods?name=' + encodeURIComponent(installed.name), { method: 'DELETE' });
        modUpdateResults.delete(installed.name);
        await loadMods();
        renderSortedCurseForgeResults();
        showToast('Mod eliminado de la carpeta del servidor; reinícialo para aplicar el cambio.');
      } catch (error) {
        showToast(error.message, true);
        remove.disabled = false;
        remove.textContent = 'Desinstalar';
      }
    });
    tools.append(remove);
  }
  if (mod.url) {
    const link = document.createElement('a');
    link.className = 'button ghost small-button';
    link.href = mod.url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = 'Abrir CurseForge';
    tools.append(link);
  }
  main.append(heading, summary, tools, versions);
  card.append(main);
  return card;
}

async function searchCurseForge(event) {
  event.preventDefault();
  const query = $('curseForgeQuery').value.trim();
  const button = $('curseForgeSearchForm').querySelector('button');
  const results = $('curseForgeResults');
  const sortSelect = $('curseForgeSort');
  button.disabled = true;
  sortSelect.disabled = true;
  $('curseForgeSearchStatus').textContent = 'Buscando en CurseForge…';
  results.replaceChildren();
  try {
    await refreshInstalledModsForSearch();
    const data = await api('/api/curseforge/search?q=' + encodeURIComponent(query) + '&sort=' + encodeURIComponent(sortSelect.value || 'relevance'));
    curseForgeResultsCache = data.mods || [];
    $('curseForgeSearchStatus').textContent = curseForgeResultsCache.length
      ? `${curseForgeResultsCache.length} resultados compatibles · Minecraft ${data.minecraftVersion} / ${data.loader}`
      : 'No se encontraron mods compatibles con esos filtros.';
    renderSortedCurseForgeResults();
  } catch (error) {
    $('curseForgeSearchStatus').textContent = error.message;
    showToast(error.message, true);
  } finally {
    button.disabled = false;
    sortSelect.disabled = false;
  }
}

function renderSortedCurseForgeResults() {
  const results = $('curseForgeResults');
  results.replaceChildren();
  const sort = $('curseForgeSort')?.value || 'relevance';
  const mods = [...curseForgeResultsCache];
  if (!mods.length) {
    const empty = document.createElement('p');
    empty.className = 'empty-row';
    empty.textContent = 'Prueba otra búsqueda o vuelve a intentarlo cuando haya más mods para la versión y el loader de este servidor.';
    results.append(empty);
    return;
  }
  if (sort !== 'relevance') mods.sort((a, b) => {
    if (sort === 'downloads-asc') return Number(a.downloads || 0) - Number(b.downloads || 0);
    if (sort === 'name-asc') return String(a.name || '').localeCompare(String(b.name || ''), 'es');
    if (sort === 'name-desc') return String(b.name || '').localeCompare(String(a.name || ''), 'es');
    return Number(b.downloads || 0) - Number(a.downloads || 0);
  });
  for (const mod of mods) results.append(renderCurseForgeResult(mod));
}

async function searchCurseForgeByUrl(event) {
  event.preventDefault();
  const input = $('curseForgeUrl');
  const button = $('curseForgeUrlForm').querySelector('button');
  const results = $('curseForgeResults');
  button.disabled = true;
  $('curseForgeSearchStatus').textContent = 'Buscando esa ficha en CurseForge…';
  results.replaceChildren();
  try {
    await refreshInstalledModsForSearch();
    const data = await api('/api/curseforge/lookup-url?url=' + encodeURIComponent(input.value.trim()));
    if (!data.mod) {
      $('curseForgeSearchStatus').textContent = 'No encontré esa ficha de mod en CurseForge.';
      const empty = document.createElement('p');
      empty.className = 'empty-row';
      empty.textContent = 'Comprueba que el enlace sea de un mod de Minecraft publicado en CurseForge.';
      results.append(empty);
      return;
    }
    $('curseForgeSearchStatus').textContent = `Ficha encontrada. Comprueba sus versiones para Minecraft ${data.minecraftVersion} / ${data.loader}.`;
    results.append(renderCurseForgeResult(data.mod));
  } catch (error) {
    $('curseForgeSearchStatus').textContent = error.message;
    showToast(error.message, true);
  } finally {
    button.disabled = false;
  }
}

let pendingModEntries = [];
let watchingBulkMods = false;

async function offerModRestart(message = 'Mods actualizados, ¿reiniciar servidor?') {
  if (!window.confirm(message)) return;
  showToast('Guardando el mundo y reiniciando para aplicar los mods…');
  try {
  await api('/api/server/restart', { method: 'POST', body: '{}' });
  modUpdateResults.clear();
  await loadMods();
  await loadStatus();
  showToast('Servidor reiniciado; mods aplicados.');
  } catch (error) {
    showToast('No se pudo completar el reinicio: ' + error.message + ' Los archivos preparados quedan guardados.', true);
  }
}

async function loadPendingMods() {
  const data = await api('/api/mods/pending');
  pendingModEntries = data.pending || [];
  $('pendingModsNotice').classList.toggle('hidden', !pendingModEntries.length);
  $('pendingModsList').replaceChildren(...pendingModEntries.map(entry => {
    const row = document.createElement('li');
    row.textContent = `${entry.displayName || entry.name} · ${formatBytes(entry.bytes)} · pendiente de reinicio`;
    return row;
  }));
  $('applyPendingModsButton').disabled = Boolean(data.activeBulkUpdate);
  const id = data.activeBulkUpdate || localStorage.getItem(modOperationStorageKey);
  if (id && !watchingBulkMods) void watchBulkModUpdates(id);
}

async function watchBulkModUpdates(id) {
  if (watchingBulkMods) return;
  watchingBulkMods = true;
  const startedAt = Date.now();
  localStorage.setItem(modOperationStorageKey, id);
  $('updateAllModsButton').disabled = true;
  $('checkModUpdatesButton').disabled = true;
  showOperationProgress('modsBatch', startedAt, 'Buscando actualizaciones compatibles…');
  $('modsBatchProgressItems').replaceChildren();
  try {
    let result;
    while (true) {
      result = await api('/api/curseforge/progress?id=' + encodeURIComponent(id));
      if (!result.found) {
        localStorage.removeItem(modOperationStorageKey);
        throw new Error('La operación ya no está activa. Los mods preparados siguen guardados para reiniciar.');
      }
      renderOperationProgress('modsBatch', result, startedAt);
      const rows = (result.items || []).map(item => {
        const row = document.createElement('li');
        row.textContent = `${item.label || item.name} — ${item.status}`;
        return row;
      });
      for (const failure of result.failures || []) {
        if ((result.items || []).some(item => item.name === failure.name)) continue;
        const row = document.createElement('li');row.textContent = `${failure.name} — ${failure.message}`;rows.push(row);
      }
      $('modsBatchProgressItems').replaceChildren(...rows);
      if (result.done) break;
      await new Promise(resolve => setTimeout(resolve, 700));
    }
    localStorage.removeItem(modOperationStorageKey);
    modUpdateResults.clear();
    await loadMods();
    $('modUpdatesStatus').textContent = result.error || `${result.pendingCount || 0} archivos preparados para reiniciar${result.failures?.length ? ' · ' + result.failures.length + ' aviso(s); revisa el detalle.' : '.'}`;
    // Pending changes stay visible; restart only when the user chooses it.
  } catch (error) {
    showToast(error.message, true);
    $('modsBatchProgressDetail').textContent = error.message;
  } finally {
    watchingBulkMods = false;
    $('updateAllModsButton').disabled = false;
    $('checkModUpdatesButton').disabled = false;
  }
}

async function updateAllMods() {
  const progressId = createProgressId();
  $('updateAllModsButton').disabled = true;
  try {
    await api('/api/mods/update-all', { method: 'POST', body: JSON.stringify({ progressId }) });
    await watchBulkModUpdates(progressId);
  } catch (error) {
    showToast(error.message, true);
    $('updateAllModsButton').disabled = false;
  }
}

async function checkModUpdates() {
  const button = $('checkModUpdatesButton');
  const status = $('modUpdatesStatus');
  button.disabled = true;
  $('updateAllModsButton').disabled = true;
  button.textContent = 'Consultando CurseForge…';
  status.textContent = 'Comparando los JAR instalados con CurseForge. La consulta puede tardar un poco.';
  try {
    const data = await api('/api/mods/updates');
    modUpdateResults = new Map();
    for (const mod of data.updates || []) modUpdateResults.set(mod.name, { status: 'update', ...mod });
    for (const mod of data.current || []) modUpdateResults.set(mod.name, { status: 'current', ...mod });
    for (const mod of data.unsupported || []) modUpdateResults.set(mod.name, { status: 'unsupported', ...mod });
    for (const mod of data.errors || []) modUpdateResults.set(mod.name, { status: 'error', ...mod });
    await loadMods();

    const updateCount = (data.updates || []).length;
    const matchedCount = Number(data.totalMatched || 0);
    const pieces = [`Revisados ${Number(data.checked || 0)} mods compatibles; ${updateCount} actualización${updateCount === 1 ? '' : 'es'} disponible${updateCount === 1 ? '' : 's'}.`];
    if ((data.unsupported || []).length) pieces.push(`${data.unsupported.length} no se pudieron vincular a CurseForge`);
    if ((data.errors || []).length) pieces.push(`${data.errors.length} con errores`);
    if (data.throttled) pieces.push('CurseForge ha limitado las solicitudes; espera un poco antes de volver a consultar');
    if (!matchedCount && !data.throttled) pieces.push('No se reconocieron archivos de CurseForge entre los mods instalados');
    status.textContent = pieces.join(' · ');
    if (data.throttled) status.classList.add('error-text');
    else status.classList.remove('error-text');
  } catch (error) {
    status.textContent = error.message;
    status.classList.add('error-text');
    showToast(error.message, true);
  } finally {
    button.disabled = false;
    $('updateAllModsButton').disabled = watchingBulkMods;
    button.textContent = 'Buscar actualizaciones';
  }
}

async function loadMods(options = {}) {
  const forceCurseForgeMetadata = Boolean(options.forceCurseForgeMetadata);
  const includeCurseForgeMetadata = forceCurseForgeMetadata || (!curseForgeMetadataAttempted && !curseForgeMetadataLoadPromise);
  const endpoint = includeCurseForgeMetadata ? '/api/mods?curseforge=1' : '/api/mods';
  if (includeCurseForgeMetadata) curseForgeMetadataAttempted = true;
  const request = api(endpoint);
  if (includeCurseForgeMetadata) curseForgeMetadataLoadPromise = request;
  try {
    const data = await request;
    if (data.curseForgeMetadataLoaded) curseForgeMetadataAttempted = true;
    if (includeCurseForgeMetadata && data.curseForgeMetadataError) {
      showToast('No se pudieron cargar algunas imágenes de CurseForge: ' + data.curseForgeMetadataError, true);
    }
    const responseMods = data.mods || [];
    const responseNames = new Set(responseMods.map((mod) => mod.name));
    const newlyAddedMods = knownModNames
      ? responseMods.filter((mod) => !knownModNames.has(mod.name))
      : [];
    knownModNames = responseNames;

    // Files copied into /mods outside CurseForge search need a targeted metadata
    // lookup once they appear in the installed list.
    if (newlyAddedMods.length && !includeCurseForgeMetadata) {
      try {
        const params = new URLSearchParams({
          curseforge: '1',
          names: JSON.stringify(newlyAddedMods.map((mod) => mod.name)),
        });
        const metadata = await api('/api/mods?' + params.toString());
        if (metadata.curseForgeMetadataLoaded) curseForgeMetadataAttempted = true;
        for (const mod of metadata.mods || []) {
          if (mod.curseForgeMatched) {
            rememberCurseForgeMetadata(mod.name, {
              name: mod.displayName,
              logo: mod.curseForgeLogo,
              url: mod.curseForgeUrl,
              summary: mod.curseForgeSummary,
            });
          }
        }
        if (metadata.curseForgeMetadataError) {
          showToast('No se pudieron actualizar algunas imágenes de CurseForge: ' + metadata.curseForgeMetadataError, true);
        }
      } catch (error) {
        showToast('No se pudieron actualizar las imágenes de los mods nuevos: ' + error.message, true);
      }
    }
    const mods = mergeCurseForgeMetadata(data.mods || []);
    await loadPendingMods();
    currentMods = mods;
    $('modCount').textContent = String(mods.length);
    const table = $('modsTable');
    table.replaceChildren();
    if (!mods.length) {
      const row = document.createElement('tr');
      const cell = document.createElement('td');
      cell.colSpan = 3;
      cell.className = 'empty-row';
      cell.textContent = 'No hay archivos .jar instalados.';
      row.append(cell);
      table.append(row);
      return;
    }
    const sortMode = $('modsSort')?.value || 'name-asc';
    const sortedMods = [...mods].sort((a, b) => {
      if (sortMode === 'added-desc') {
        const aDate = Date.parse(a.addedAt || a.modified || '') || 0;
        const bDate = Date.parse(b.addedAt || b.modified || '') || 0;
        return bDate - aDate || String(a.displayName || a.name).localeCompare(String(b.displayName || b.name), 'es');
      }
      return String(a.displayName || a.name).localeCompare(String(b.displayName || b.name), 'es');
    });
    for (const mod of sortedMods) {
      const row = document.createElement('tr');
      const name = document.createElement('td');
      name.className = 'file-name';
      const displayName = document.createElement('strong');
      displayName.className = 'mod-display-name';
      displayName.textContent = mod.displayName || mod.name;
      const fileName = document.createElement('small');
      fileName.className = 'mod-file-name';
      fileName.textContent = mod.name;
      const modInfo = document.createElement('div');
      modInfo.className = 'mod-info';
      modInfo.append(displayName, fileName);
      if (mod.curseForgeSummary) {
        const description = document.createElement('small');
        description.className = 'mod-description';
        description.textContent = mod.curseForgeSummary;
        modInfo.append(description);
      }
      const updateInfo = modUpdateResults.get(mod.name);
      const preparedUpdate = pendingModEntries.find(entry => entry.replaceName === mod.name || entry.name === mod.name);
      if (preparedUpdate) {
        const pendingStatus = document.createElement('small');
        pendingStatus.className = 'mod-update-status';
        pendingStatus.textContent = 'Actualización preparada: ' + preparedUpdate.name + ' · pendiente de reinicio';
        modInfo.append(pendingStatus);
      }
      if (updateInfo) {
        const updateStatus = document.createElement('small');
        updateStatus.className = 'mod-update-status';
        if (updateInfo.status === 'update') {
          updateStatus.textContent = 'Nueva versión: ' + (updateInfo.latestFile.displayName || updateInfo.latestFile.fileName);
        } else if (updateInfo.status === 'current') {
          updateStatus.textContent = 'Al día según CurseForge';
        } else if (updateInfo.status === 'unsupported') {
          updateStatus.textContent = 'Archivo sin coincidencia exacta en CurseForge; requiere revisión manual (por ejemplo, un mod personalizado).';
        } else {
          updateStatus.textContent = updateInfo.message || 'No se pudo comprobar';
        }
        modInfo.append(updateStatus);
      }
      if (mod.curseForgeLogo) {
        const logo = document.createElement('img');
        logo.className = 'mod-logo';
        logo.src = mod.curseForgeLogo;
        logo.alt = '';
        logo.loading = 'lazy';
        name.append(logo);
      }
      name.append(modInfo);
      const size = document.createElement('td');
      size.textContent = formatBytes(mod.bytes);
      const action = document.createElement('td');
      action.className = 'table-action';
      const actions = document.createElement('div');
      actions.className = 'mod-row-actions';
      if (updateInfo?.status === 'update' && !preparedUpdate) {
        const update = document.createElement('button');
        update.className = 'button primary small-button';
        update.type = 'button';
        update.textContent = 'Actualizar';
        update.addEventListener('click', async () => {
          const versionName = updateInfo.latestFile.displayName || updateInfo.latestFile.fileName;
          if (!window.confirm(`¿Actualizar ${mod.displayName} a ${versionName}? Se preparará ahora y se aplicará al reiniciar, guardando la versión anterior.`)) return;
          update.disabled = true;
          update.textContent = 'Actualizando…';
          const progressId = createProgressId();
          const startedAt = Date.now();
          showOperationProgress('modsBatch', startedAt, 'Preparando ' + mod.displayName);
          $('modsBatchProgressItems').replaceChildren();
          const stopMonitoring = startOperationProgressMonitor('modsBatch', progressId, startedAt);
          try {
            const result = await api('/api/curseforge/install', {
              method: 'POST',
              body: JSON.stringify({ modId: updateInfo.modId, fileId: Number(updateInfo.latestFile.id), replaceName: mod.name, progressId }),
            });
          for (const dependency of result.installedDependencies || []) {
            rememberCurseForgeMetadata(dependency.fileName, {
              name: dependency.projectName,
              logo: dependency.logo,
              summary: dependency.summary,
              url: dependency.url,
            });
          }
            rememberCurseForgeMetadata(result.name, curseForgeMetadataByFileName.get(mod.name) || {
              displayName: mod.displayName,
              curseForgeLogo: mod.curseForgeLogo,
              curseForgeUrl: mod.curseForgeUrl,
              curseForgeSummary: mod.curseForgeSummary,
            });
            if (!result.pending && result.name !== mod.name) curseForgeMetadataByFileName.delete(mod.name);
            modUpdateResults.delete(mod.name);
            await loadMods();
            const addedDependencies = (result.installedDependencies || []).filter((dependency) => !dependency.installed);
            const dependencyMessage = addedDependencies.length
              ? ` También se instalaron ${addedDependencies.map((dependency) => dependency.projectName).join(', ')}.`
              : '';
            showToast(mod.displayName + ' actualizado.' + dependencyMessage + ' Reinicia el servidor para cargar los cambios.');
            stopMonitoring();
            finishOperationProgress('modsBatch', startedAt, true, 'Actualización preparada. Se aplicará al reiniciar.');

          } catch (error) {
            stopMonitoring();
            finishOperationProgress('modsBatch', startedAt, false, error.message);
            showToast(error.message, true);
            update.disabled = false;
            update.textContent = 'Actualizar';
          }
        });
        actions.append(update);
      }
      const remove = document.createElement('button');
      remove.className = 'button danger small-button';
      remove.type = 'button';
      remove.textContent = 'Quitar';
      remove.addEventListener('click', async () => {
        if (!window.confirm('¿Quitar ' + mod.name + '? Tendrás que reiniciar el servidor.')) return;
        try {
          await api('/api/mods?name=' + encodeURIComponent(mod.name), { method: 'DELETE' });
          modUpdateResults.delete(mod.name);
          showToast('Mod eliminado de la carpeta del servidor.');
          await loadMods();
        } catch (error) {
          showToast(error.message, true);
        }
      });
      actions.append(remove);
      action.append(actions);
      row.append(name, size, action);
      table.append(row);
    }
  } catch (error) {
    showToast(error.message, true);
  } finally {
    if (includeCurseForgeMetadata && curseForgeMetadataLoadPromise === request) curseForgeMetadataLoadPromise = null;
  }
}

async function refreshModsFromCurseForge() {
  if (curseForgeMetadataLoadPromise) return;
  const button = $('refreshModsButton');
  button.disabled = true;
  const oldText = button.textContent;
  button.textContent = 'Actualizando imágenes…';
  const progressId = createProgressId();
  const startedAt = Date.now();
  showOperationProgress('modsRefresh', startedAt, 'Actualizando la lista de mods…');
  const stopMonitoring = startOperationProgressMonitor('modsRefresh', progressId, startedAt);
  try {
    const namesBeforeRefresh = new Set(currentMods.map((mod) => mod.name));
    await loadMods();
    const missingImages = currentMods
      .filter((mod) => !mod.curseForgeLogo && namesBeforeRefresh.has(mod.name))
      .map((mod) => mod.name);
    if (!missingImages.length) {
      stopMonitoring();
      finishOperationProgress('modsRefresh', startedAt, true, 'No había imágenes pendientes; lista actualizada');
      showToast('Lista actualizada; todos los mods vinculados tienen su imagen.');
      return;
    }
    const params = new URLSearchParams({
      curseforge: '1',
      names: JSON.stringify(missingImages),
      progressId,
    });
    const data = await api('/api/mods?' + params.toString());
    if (data.curseForgeMetadataLoaded) curseForgeMetadataAttempted = true;
    let updatedCount = 0;
    for (const mod of data.mods || []) {
      if (!mod.curseForgeMatched) continue;
      rememberCurseForgeMetadata(mod.name, {
        name: mod.displayName,
        logo: mod.curseForgeLogo,
        url: mod.curseForgeUrl,
        summary: mod.curseForgeSummary,
      });
      if (mod.curseForgeLogo) updatedCount += 1;
    }
    await loadMods();
    stopMonitoring();
    if (data.curseForgeMetadataError) {
      finishOperationProgress('modsRefresh', startedAt, false, data.curseForgeMetadataError);
      showToast('No se pudieron actualizar algunas imágenes: ' + data.curseForgeMetadataError, true);
    } else if (!data.curseForgeMetadataLoaded) {
      finishOperationProgress('modsRefresh', startedAt, false, 'Configura la clave de CurseForge');
      showToast('Configura la clave de CurseForge para cargar las imágenes.', true);
    } else if (updatedCount) {
      finishOperationProgress('modsRefresh', startedAt, true, `Imágenes actualizadas: ${updatedCount}`);
      showToast(`Imágenes de ${updatedCount} mod${updatedCount === 1 ? '' : 's'} actualizadas.`);
    } else {
      finishOperationProgress('modsRefresh', startedAt, false, 'CurseForge no devolvió imágenes para los mods pendientes');
      showToast('No encontré una imagen de CurseForge para los mods pendientes.', true);
    }
  } catch (error) {
    stopMonitoring();
    finishOperationProgress('modsRefresh', startedAt, false, error.message);
    showToast('No se pudieron actualizar las imágenes: ' + error.message, true);
  } finally {
    button.disabled = false;
    button.textContent = oldText;
  }
}

async function loadAutoModpackFingerprint() {
  const section = $('autoModpackFingerprintSection');
  try {
    const data = await api('/api/automodpack');
    section.classList.toggle('hidden', !data.installed);
    const fingerprint = data.available && /^[a-f0-9]{64}$/.test(data.fingerprint) ? data.fingerprint : '';
    $('autoModpackFingerprint').textContent = fingerprint || 'Pendiente de generar';
    $('copyAutoModpackFingerprint').dataset.copy = fingerprint;
    $('copyAutoModpackFingerprint').disabled = !fingerprint;
    $('overviewTrustHelp').disabled = !fingerprint;
    $('autoModpackFingerprintHint').textContent = fingerprint ? 'AutoModpack · SHA-256. Comparte esta huella para verificar la identidad de este servidor.' : (data.message || 'Arranca este servidor con AutoModpack para generar su huella.');
    syncAddressRevealButtons();
  } catch {
    section.classList.add('hidden');
    $('autoModpackFingerprint').textContent = '';
    $('copyAutoModpackFingerprint').dataset.copy = '';
    $('overviewTrustHelp').disabled = true;
  }
}
async function loadEverything() {
  const tasks=[loadStatus()];
  if(activeView==='overview') tasks.push(loadAutoModpackFingerprint());
  if(activeView==='console') tasks.push(loadLogs());
  if(activeView==='players') tasks.push(loadPlayers());
  if(activeView==='mods') tasks.push(loadMods());
  await Promise.all(tasks);
}

function activateView(viewName) {
  activeView = viewName;
  window.LobodkNavigation?.sync(viewName);
  window.LobodkNetwork?.setActive(viewName === 'performance');
  window.LobodkPlayerTools?.setActive(viewName === 'player-tools');
  window.scrollTo(0, 0);
  const viewLabels = {
    appearance:'Apariencia',backups:'Copias de seguridad',schedule:'Reinicios programados',configuration:'Configuración',diagnostics:'Diagnóstico',automodpack:'AutoModpack',
    overview: 'Resumen',
    performance: 'Rendimiento y red',
    console: 'Consola',
    players: 'Jugadores',
    'player-tools': 'Acciones de jugadores',
    mods: 'Mods',
    'mod-search': 'Buscador de Mods',
  };
  if ($('breadcrumbCurrent')) $('breadcrumbCurrent').textContent = viewLabels[viewName] || 'Resumen';
  document.querySelectorAll('.nav-button').forEach((button) => {
    button.classList.toggle('active', button.dataset.view === viewName);
  });
  document.querySelectorAll('.view').forEach((view) => {
    view.classList.toggle('active', view.id === 'view-' + viewName);
  });
  window.LobodkFeatures?.activate(viewName);
  if (viewName === 'console') loadLogs();
  if (viewName === 'players') loadPlayers();
  if (viewName === 'mods') loadMods();
  if (viewName === 'mod-search') loadCurseForgeStatus();
  clearInterval(performanceTimer);
  performanceTimer = null;
  if(viewName==='configuration'){loadPerformance();loadNeoForge();}
  if(viewName==='backups'){loadBackups();performanceTimer=setInterval(()=>pollTask(loadBackups),10000);}
  if (viewName === 'performance') {
    loadPerformance();
    performanceTimer = setInterval(() => pollTask(loadPerformance), 5000);
  }
}

async function copyPanelText(text) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {}
  }
  // LAN HTTP pages may not expose the Clipboard API.
  const previousFocus = document.activeElement;
  const input = document.createElement('textarea');
  input.value = text;
  input.setAttribute('readonly', '');
  input.setAttribute('aria-hidden', 'true');
  input.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
  document.body.append(input);
  input.select();
  input.setSelectionRange(0, text.length);
  let copied = false;
  try {
    copied = document.execCommand('copy');
  } finally {
    input.remove();
    previousFocus?.focus();
  }
  if (!copied) throw new Error('No se pudo copiar. Selecciona la dirección y cópiala manualmente.');
}

document.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-copy]');
  if (!button) return;
  const text = button.dataset.copy || button.closest('.address-row')?.querySelector('code')?.textContent.trim();
  if (!text) return;
  try {
    await copyPanelText(text);
    showToast('Dirección copiada al portapapeles.');
    if (!button.hasAttribute('data-copy-label')) button.dataset.copyLabel = button.getAttribute('aria-label') || '';
    const label = button.dataset.copyLabel;
    button.setAttribute('aria-label', 'Dirección copiada');
    button.classList.add('copied');
    clearTimeout(button.copyFeedbackTimer);
    button.copyFeedbackTimer = setTimeout(() => {
      if (label) button.setAttribute('aria-label', label);
      else button.removeAttribute('aria-label');
      button.classList.remove('copied');
    }, 1800);
  } catch (error) {
    showToast(error.message, true);
  }
});

$('loginForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const key = $('accessKey').value;
  $('loginError').textContent = '';
  try {
    const session = await api('/api/login', { method: 'POST', body: JSON.stringify({ token: key }) });
    token = 'cookie-session';
    window.panelSession = session;
    $('accessKey').value = '';
    setLoggedIn(true);
  } catch (error) {
    $('loginError').textContent = error.message;
  }
});

$('logoutButton').addEventListener('click', () => logout());
$('refreshButton').addEventListener('click', loadEverything);
$('refreshPlayersButton').addEventListener('click', loadPlayers);
$('refreshModsButton').addEventListener('click', refreshModsFromCurseForge);
$('checkModUpdatesButton').addEventListener('click', checkModUpdates);
$('updateAllModsButton').addEventListener('click', updateAllMods);
$('applyPendingModsButton').addEventListener('click', () => offerModRestart().catch(error => showToast(error.message, true)));
$('modsSort').addEventListener('change', loadMods);
$('refreshPerformanceButton').addEventListener('click', loadPerformance);
$('viewDistanceSlider').addEventListener('input', syncDistanceSliders);
$('simulationDistanceSlider').addEventListener('input', syncDistanceSliders);
$('saveDistancesButton').addEventListener('click', saveDistances);
$('createBackupButton').addEventListener('click', createManualBackup);
$('autoBackupToggle').addEventListener('change', async (event) => {
  const toggle = event.currentTarget;
  toggle.disabled = true;
  try {
    const data = await api('/api/backups/automatic', {
      method: 'PUT',
      body: JSON.stringify({ enabled: toggle.checked }),
    });
    $('backupStatus').textContent = data.automaticEnabled
      ? 'Copias automáticas activadas; la primera será dentro de 4 horas.'
      : 'Copias automáticas desactivadas.';
    await loadBackups();
  } catch (error) {
    toggle.checked = !toggle.checked;
    showToast(error.message, true);
  } finally {
    toggle.disabled = false;
  }
});
$('checkNeoForgeButton').addEventListener('click', loadNeoForge);
$('updateNeoForgeButton').addEventListener('click', updateNeoForge);
$('neoForgeVersion').addEventListener('change', () => {
  const isNewer = compareNeoForgeVersions($('neoForgeVersion').value, $('neoForgeCurrent').textContent) > 0;
  $('updateNeoForgeButton').disabled = !isNewer;
});
$('curseForgeKeyForm').addEventListener('submit', saveCurseForgeKey);
$('removeCurseForgeKey').addEventListener('click', removeCurseForgeKey);
$('curseForgeSearchForm').addEventListener('submit', searchCurseForge);
$('curseForgeSort').addEventListener('change', () => {
  const query = $('curseForgeQuery').value.trim();
  if (query.length >= 2 && query.length <= 100) {
    searchCurseForge({ preventDefault() {} }).catch(error => showToast(error.message, true));
  }
});
$('curseForgeUrlForm').addEventListener('submit', searchCurseForgeByUrl);
$('clearConsoleButton').addEventListener('click', () => {
  $('consoleOutput').textContent = '';
  rawConsoleText = '';
  lastLogText = '';
});

document.querySelectorAll('.nav-button').forEach((button) => {
  button.addEventListener('click', () => activateView(button.dataset.view));
});

$('commandForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const input = $('commandInput');
  const command = input.value.trim();
  if (!command) return;
  input.value = '';
  $('commandResult').textContent = 'Ejecutando: ' + command;
  try {
    const result = await api('/api/command', {
      method: 'POST',
      body: JSON.stringify({ command }),
    });
    $('commandResult').textContent = result.result || 'Orden enviada.';
    await loadLogs();
  } catch (error) {
    $('commandResult').textContent = error.message;
  }
});

$('opForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const input = $('opName');
  const name = input.value.trim();
  try {
    const result = await api('/api/ops', {
      method: 'POST',
      body: JSON.stringify({ action: 'add', name }),
    });
    input.value = '';
    showToast(result.result || 'Operador añadido.');
    await loadPlayers();
  } catch (error) {
    showToast(error.message, true);
  }
});

$('whitelistForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const input = $('whitelistName');
  const name = input.value.trim();
  try {
    const result = await api('/api/whitelist', {
      method: 'POST',
      body: JSON.stringify({ action: 'add', name }),
    });
    input.value = '';
    showToast(result.result || 'Jugador añadido a la whitelist.');
    await loadPlayers();
  } catch (error) {
    showToast(error.message, true);
  }
});

$('banPlayerForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const nameInput = $('banPlayerName');
  const reasonInput = $('banPlayerReason');
  const name = nameInput.value.trim();
  const reason = reasonInput.value.trim();
  if (!window.confirm('¿Quieres banear a ' + name + (reason ? ' por: ' + reason : '') + '?')) return;
  try {
    const result = await api('/api/players/ban', {
      method: 'POST',
      body: JSON.stringify({ name, reason }),
    });
    nameInput.value = '';
    reasonInput.value = '';
    showToast(result.result || 'Jugador baneado.');
    await Promise.all([loadPlayers(), loadStatus(), loadLogs()]);
  } catch (error) {
    showToast(error.message, true);
  }
});

$('uploadForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const file = $('modFile').files[0];
  if (!file) return;
  if (!file.name.toLowerCase().endsWith('.jar')) {
    $('uploadResult').textContent = 'Elige un archivo .jar.';
    return;
  }
  const button = $('uploadForm').querySelector('button');
  button.disabled = true;
  $('uploadResult').textContent = 'Subiendo ' + file.name + '…';
  try {
    await api('/api/mods/upload?name=' + encodeURIComponent(file.name), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/java-archive' },
      body: file,
    });
    let metadataStatus = { matched: false, configured: false, error: '' };
    try {
      metadataStatus = await refreshCurseForgeMetadataForMod(file.name);
    } catch (error) {
      metadataStatus.error = error.message;
    }
    $('uploadResult').textContent = metadataStatus.matched
      ? 'Mod añadido y ficha de CurseForge actualizada. Reinicia el servidor para cargarlo.'
      : 'Mod añadido. Reinicia el servidor para cargarlo; ' + (metadataStatus.error
        ? 'no pude actualizar su ficha: ' + metadataStatus.error
        : metadataStatus.configured
          ? 'no encontré una ficha de CurseForge para este archivo.'
          : 'configura la clave de CurseForge para buscar su imagen.');
    $('modFile').value = '';
    showToast(metadataStatus.matched
      ? 'Mod subido y su imagen de CurseForge actualizada.'
      : metadataStatus.error
        ? 'Mod subido, pero no pude actualizar su ficha de CurseForge.'
        : 'Mod subido; no encontré una ficha de CurseForge para este archivo.', Boolean(metadataStatus.error));
    await loadMods();
  } catch (error) {
    $('uploadResult').textContent = error.message;
    showToast(error.message, true);
  } finally {
    button.disabled = false;
  }
});

$('restartButton').addEventListener('click', async () => {
  if (!window.confirm('El reinicio desconectará a los jugadores y volverá a cargar el mundo. ¿Continuar?')) return;
  $('serverMessage').textContent = 'Guardando y reiniciando…';
  $('restartButton').disabled = true;
  try {
    const result = await api('/api/server/restart', { method: 'POST', body: '{}' });
    showToast(result.message || 'Servidor listo.');
    await loadEverything();
  } catch (error) {
    showToast(error.message, true);
    $('serverMessage').textContent = error.message;
  } finally {
    $('restartButton').disabled = false;
  }
});

$('startButton').addEventListener('click', async () => {
  $('serverMessage').textContent = 'Iniciando el servidor…';
  $('startButton').disabled = true;
  showToast('Iniciando el servidor…');
  try {
    // The server control endpoint starts Minecraft when it is offline and
    // performs a graceful restart when it is already running.
    const result = await api('/api/server/restart', { method: 'POST', body: '{}' });
    showToast(result.message || 'Servidor listo.');
    await loadEverything();
  } catch (error) {
    showToast(error.message, true);
    $('serverMessage').textContent = error.message;
  } finally {
    $('startButton').disabled = false;
    await loadStatus();
  }
});

$('stopButton').addEventListener('click', async () => {
  if (!window.confirm('Esto guardará y apagará el servidor. ¿Continuar?')) return;
  try {
    const result = await api('/api/server/stop', { method: 'POST', body: '{}' });
    showToast(result.message);
  } catch (error) {
    showToast(error.message, true);
  }
});

api('/api/app/session').then(session => {
  token = 'cookie-session'; window.panelSession = session; setLoggedIn(true);
}).catch(() => setLoggedIn(false));
