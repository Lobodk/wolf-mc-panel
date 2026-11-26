'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const net = require('node:net');
const os = require('node:os');
const dgram = require('node:dgram');
const crypto = require('node:crypto');
const { execFile, spawn } = require('node:child_process');
const { promisify } = require('node:util');
const { gzipSync } = require('node:zlib');
const { syncTree } = require('./native-host-transfer.cjs');

const run = promisify(execFile);
const account = 'wolfmc_host';
const share = 'WolfMCReplica$';
const ps = path.join(process.env.WINDIR || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const ssh = path.join(process.env.WINDIR || 'C:\\Windows', 'System32', 'OpenSSH', 'ssh.exe');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const problem = (message, status = 409) => Object.assign(Error(message), { status });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const privateIp = value => net.isIPv4(value) && /^(?:10\.|192\.168\.|172\.(?:1[6-9]|2[0-9]|3[01])\.)/.test(value);

function launchArguments(record) {
  const {args}=read(path.join(record.directory,'panel','launch.json'));
  const relative=file=>{
    if(typeof file!=='string'||!path.isAbsolute(file))throw problem('No se pudo preparar el arranque para el otro equipo.');
    const result=path.relative(record.directory,file).replaceAll(path.sep,'/');
    if(!result || !/^[a-zA-Z0-9_.+/-]+$/.test(result) || result.split('/').some(part=>part==='..'||!part))throw problem('El arranque usa archivos fuera del servidor.');
    return result;
  };
  if(Array.isArray(args)&&args[0]==='-jar'&&args.length>=2){
    const jar=relative(args[1]);
    if(!/^[a-zA-Z0-9_.+-]+\.jar$/i.test(jar))throw problem('El JAR de arranque no es compatible con el traslado.');
    return ['-jar',jar,'nogui'];
  }
  if(Array.isArray(args)&&typeof args[0]==='string'&&args[0].startsWith('@')){
    const file=relative(args[0].slice(1));
    if(!/^libraries\/(?:net\/neoforged\/neoforge|net\/minecraftforge\/forge)\/[A-Za-z0-9_.+-]+\/win_args\.txt$/.test(file))throw problem('El cargador tiene una ruta de arranque no compatible.');
    return ['@'+file,'nogui'];
  }
  throw problem('Este formato de arranque no es compatible con el traslado.');
}

const script = filename => path.join(__dirname, filename);
const powershellArgs = ['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass'];

function write(file, data) {
  const temporary = file + '.tmp';
  fs.writeFileSync(temporary, JSON.stringify(data, null, 2) + '\n', { mode: 0o600, flush: true });
  fs.renameSync(temporary, file);
}

function taskSource() {
  return fs.readFileSync(script('native-host-task.ps1'),'utf8')
    .replace('@@NETWORK@@',()=>fs.readFileSync(script('network-snapshot.ps1')).toString('base64'));
}

function windowsLauncher(source, message) {
  const zipped = gzipSync(source).toString('base64');
  const bootstrap = "$data=[Convert]::FromBase64String('"+zipped+"');"+
    '$stream=[IO.Compression.GZipStream]::new([IO.MemoryStream]::new($data),[IO.Compression.CompressionMode]::Decompress);'+
    '$reader=[IO.StreamReader]::new($stream);try { & ([scriptblock]::Create($reader.ReadToEnd())) } finally { $reader.Dispose() }';
  const encoded = Buffer.from(bootstrap,'utf16le').toString('base64');
  const marker = ':WOLFMC_PAYLOAD';
  const checksum = crypto.createHash('sha256').update(encoded,'ascii').digest('base64');
  const runner = "$ErrorActionPreference='Stop'; $body=[IO.File]::ReadAllText($WolfLauncherFile);"+
    " $marker='"+marker+"'; $payload=$body.Substring($body.LastIndexOf($marker)+$marker.Length) -replace '\\s','';"+
    ' $sha=[Security.Cryptography.SHA256]::Create();'+
    ' $hash=[Convert]::ToBase64String($sha.ComputeHash([Text.Encoding]::ASCII.GetBytes($payload))); $sha.Dispose();'+
    " if($hash -cne '"+checksum+"'){throw 'El archivo de preparacion cambio. Descargalo de nuevo.'};"+
    ' $WolfSetupOutputDirectory=[IO.Path]::GetDirectoryName($WolfLauncherFile);'+
    ' & ([scriptblock]::Create([Text.Encoding]::Unicode.GetString([Convert]::FromBase64String($payload))))';
  const packedRunner=Buffer.from(runner,'utf16le').toString('base64');
  const command = "$ErrorActionPreference='Stop'; $file=$env:WOLFMC_COMMAND; $dir=[IO.Path]::GetDirectoryName($file); $q=[string][char]39;"+
    " $prefix='$WolfLauncherFile='+$q+$file.Replace($q,$q+$q)+$q+[Environment]::NewLine;"+
    " $source=$prefix+[Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('"+packedRunner+"'));"+
    " $command=[Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($source));"+
    " Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') -WorkingDirectory $dir -Verb RunAs -ArgumentList ('-NoLogo -NoProfile -NoExit -EncodedCommand '+$command)";
  return [
    '@echo off','setlocal DisableDelayedExpansion','set "WOLFMC_COMMAND=%~f0"','echo '+message,
    '"%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -NoLogo -NoProfile -Command "'+command+'"',
    'if errorlevel 1 pause','exit /b',marker,...encoded.match(/.{1,120}/g),'',
  ].join('\r\n');
}

function createNativeHosting(dataDir,profile,{runCommand=run,spawnProcess=spawn}={}) {
  const {id,controller:here,gamePort,rconPort,worldName}=profile;
  let gameTunnel=0,rconTunnel=0;
  let invitation=null;
  let pairing=false;

  const data = path.join(dataDir, 'native-hosting');
  fs.mkdirSync(data, { recursive: true });
  const receiptFile = path.join(data, 'peer.json');
  const stateFile = path.join(data, 'ownership.json');
  const journalFile = path.join(data, 'last-job.json');
  const identity = path.join(data, 'id_ed25519');
  const emptyConfig = path.join(data, 'ssh_config');
  if (!fs.existsSync(emptyConfig)) fs.writeFileSync(emptyConfig, '');
  if (!fs.existsSync(stateFile) && !fs.existsSync(receiptFile)) write(stateFile,{owner:'secondary',target:null});
  function owner() {
    const state = read(stateFile);
    if (!['secondary','primary'].includes(state.owner) ||
        (state.target && (!['secondary','primary'].includes(state.target) || state.target===state.owner ||
          !/^[a-f0-9-]{36}$/.test(state.moveId)))) throw Error('El registro de propiedad del mundo no es válido.');
    return state;
  }
  function peer() {
    if (!fs.existsSync(receiptFile)) throw problem('Ejecuta la preparación en el PC principal e importa su vinculación en este equipo.');
    const entry = read(receiptFile);
    if (entry.instance !== id || !privateIp(entry.host) || entry.host === here || entry.controller !== here ||
        entry.share !== share || !/^[A-Za-z0-9-]{1,15}$/.test(entry.computer) ||
        !validFolder(entry.folder)) throw problem('Vinculación de Windows no válida.');
    return { ...entry, unc: '\\\\' + entry.host + '\\' + share };
  }
  let manager;
  let job = null;
  if (fs.existsSync(journalFile)) {
    try {
      job = read(journalFile);
      if (job.running) job = {...job,running:false,done:true,ok:false,error:'El panel se cerró durante la operación.'};
    } catch {}
  }
  let checking = null;
  let checked = null;
  let metricsPending = null;
  let metricsCache = null;
  let sshTunnel = null;
  let startingTunnel = null;
  let relay = null;
  let connecting = null;
  let smbCheckedAt = 0;
  let smbPending = null;
  let preparing = null;
  let closing = false;
  const sockets = new Set();

  function sshOptions(entry) {
    return [
      '-F', emptyConfig, '-T', '-x', '-i', identity, '-o','IdentitiesOnly=yes',
      '-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','HostKeyAlgorithms=ssh-ed25519',
      '-o','UserKnownHostsFile=' + '"' + path.join(data,'known_hosts') + '"',
      '-o','ConnectTimeout=5','-o','ServerAliveInterval=10','-o','ServerAliveCountMax=2',
    ];
  }

  async function remote(verb, entry = peer()) {
    try {
      const { stdout } = await runCommand(ssh,[...sshOptions(entry),account+'@'+entry.host,verb],
        { timeout:15000,windowsHide:true,maxBuffer:32768 });
      const result = JSON.parse(stdout.trim());
      if (result.instance !== id || result.root?.toLowerCase() !== entry.folder.toLowerCase() ||
          result.computer?.toLowerCase() !== entry.computer.toLowerCase() ||
          typeof result.running !== 'boolean' || typeof result.armed !== 'boolean') {
        throw Error('La tarea no confirmó la identidad y el estado del servidor.');
      }
      return result;
    } catch (error) {
      const code = String(error.stderr || error.message).split(/\r?\n/).filter(Boolean).at(-1);
      throw problem('Falló OpenSSH (' + verb + '): ' + (code || 'sin respuesta').slice(0,260),502);
    }
  }

  async function ensureSmb(entry = peer(), verify = false) {
    if (smbPending) return smbPending;
    if (!verify && Date.now()-smbCheckedAt<15000) return;
    smbPending = (async () => {
      try {
        await runCommand(ps,[...powershellArgs,'-File',script('native-host-smb.ps1'),'-DataDirectory',data,'-Connect'],
          { timeout:20000,windowsHide:true,maxBuffer:65536 });
      } catch (error) {
        smbCheckedAt = 0;
        const detail = String(error.stderr || '').split(/\r?\n/).filter(Boolean)[0]?.slice(0,250);
        throw problem('Falló el acceso a la carpeta por SMB cifrado.' + (detail ? ' '+detail : ''),502);
      }
      smbCheckedAt = Date.now();
    })();
    try { await smbPending; } finally { smbPending = null; }
  }

  async function verifyStorage(entry) {
    await ensureSmb(entry,true);
    const file = path.join(entry.unc,'.wolfmc-check-'+crypto.randomUUID());
    const sample = crypto.randomBytes(32768);
    try {
      await fsp.writeFile(file,sample,{flag:'wx'});
      if (!sample.equals(await fsp.readFile(file))) throw Error('La lectura no coincide con la escritura.');
    } catch (error) {
      throw problem('No se pudo leer y escribir en la carpeta de Minecraft del PC principal. '+error.message,502);
    } finally {
      await fsp.rm(file,{force:true}).catch(() => {});
    }
  }

  function closeTunnels() {
    for (const socket of sockets) socket.destroy();
    sockets.clear();
    relay?.close();
    relay = null;
    startingTunnel?.kill();
    startingTunnel = null;
    sshTunnel?.kill();
    sshTunnel = null;
  }

  async function ensureTunnel(entry = peer(), game = false) {
    if (closing) throw problem('El panel se está cerrando.');
    if (!sshTunnel && !connecting) connecting = openTunnel(entry);
    if (connecting) await connecting;
    if (game && !relay) {
      const listener = net.createServer(client => {
        const upstream = net.createConnection(gameTunnel,'127.0.0.1');
        for (const socket of [upstream,client]) {
          sockets.add(socket);
          socket.on('error', () => { client.destroy(); upstream.destroy(); });
          socket.once('close', () => { sockets.delete(socket); client.destroy(); upstream.destroy(); });
        }
        client.pipe(upstream).pipe(client);
      });
      const started = new Promise((resolve,reject) => {
        listener.once('error',reject);
        listener.listen(gamePort,'0.0.0.0',() => { listener.removeListener('error',reject); resolve(); });
      });
      relay = listener;
      try { await started; } catch(error) { if(relay===listener)relay=null; throw error; }
      listener.on('error', () => { if (relay === listener) closeTunnels(); });
    }
  }

  async function openTunnel(entry) {
    try {
      if(!gameTunnel){
        [gameTunnel,rconTunnel]=await freeTunnelPorts();
      }
      if (await portOpen(rconTunnel) || await portOpen(gameTunnel)) {
        [gameTunnel,rconTunnel]=await freeTunnelPorts();
      }
      if (closing) throw problem('El panel se está cerrando.');
      const child = spawnProcess(ssh,[...sshOptions(entry),'-N','-o','ExitOnForwardFailure=yes',
        '-L','127.0.0.1:'+gameTunnel+':127.0.0.1:'+gamePort,
        '-L','127.0.0.1:'+rconTunnel+':127.0.0.1:'+rconPort,account+'@'+entry.host],
        {windowsHide:true,stdio:['ignore','ignore','pipe']});
      startingTunnel = child;
      let detail = '';
      child.stderr.on('data', bytes => { detail = (detail + bytes).slice(-500); });
      child.on('error', () => {});
      child.once('close', () => { if (sshTunnel === child) closeTunnels(); });
      for (let n = 0; n < 35; n++) {
        if (closing || child.exitCode !== null || !child.pid || child.killed) break;
        if (await portOpen(rconTunnel) && await portOpen(gameTunnel)) {
          await delay(200);
          if (!closing && child.exitCode === null && !child.killed) {
            sshTunnel = child;
            return;
          }
        }
        await delay(200);
      }
      child.kill();
      throw problem('No se pudo abrir el túnel SSH. '+detail.trim(),502);
    } finally { startingTunnel=null; connecting=null; }
  }

  function portOpen(port) {
    return new Promise(resolve => {
      const socket = net.createConnection(port,'127.0.0.1');
      socket.setTimeout(300);
      const finish = value => { socket.destroy(); resolve(value); };
      socket.on('connect',() => finish(true)).on('error',() => finish(false)).on('timeout',() => finish(false));
    });
  }

  async function freeTunnelPorts() {
    const servers=[net.createServer(),net.createServer()];
    try {
      return await Promise.all(servers.map(server=>new Promise((resolve,reject)=>{
        server.once('error',reject);
        server.listen(0,'127.0.0.1',()=>resolve(server.address().port));
      })));
    } finally { for(const server of servers)server.close(); }
  }

  async function localState(record) {
    const folder = "'" + record.directory.replaceAll("'","''") + "'";
    const command = "$ErrorActionPreference='Stop';$root="+folder+";$listeners=@(Get-NetTCPConnection -State Listen | Where-Object {$_.LocalPort -in @("+gamePort+","+rconPort+") -and $_.OwningProcess -ne "+process.pid+"});"+
      "$lock=Join-Path $root '"+worldName+"\\session.lock';$locked=$false;if(Test-Path -LiteralPath $lock){try{[IO.File]::Open($lock,'Open','ReadWrite','None').Dispose()}catch [IO.IOException]{$locked=$true}};"+
      "$java=@(Get-CimInstance Win32_Process -Filter \"Name='java.exe' OR Name='javaw.exe'\" | Where-Object {$_.CommandLine -and $_.CommandLine.IndexOf($root,[StringComparison]::OrdinalIgnoreCase) -ge 0});"+
      "[bool]($listeners.Count -gt 0 -or $java.Count -gt 0 -or $locked)";
    const {stdout} = await runCommand(ps,[...powershellArgs,'-Command',command],{timeout:15000,windowsHide:true,maxBuffer:65536});
    const running = stdout.trim().toLowerCase();
    if (!['true','false'].includes(running)) throw problem('No se pudo verificar si el Minecraft del secundario está detenido.');
    return {running:running === 'true'};
  }

  async function probe(force = false) {
    if (checking) return checking;
    if (!force && checked && Date.now()-checked.time<2500) {
      if (checked.error) throw problem(checked.error,502);
      return checked.value;
    }
    checking = (async () => {
      try {
        const value = await remote('status');
        checked = {time:Date.now(),value};
        return value;
      } catch (error) {
        checked = {time:Date.now(),error:error.message};
        throw error;
      }
    })();
    try { return await checking; } finally { checking = null; }
  }

  async function remoteMetrics() {
    if (metricsPending) return metricsPending;
    if (metricsCache && Date.now()-metricsCache.at<(metricsCache.error?8000:4500)) {
      if (metricsCache.error) throw metricsCache.error;
      return metricsCache.value;
    }
    metricsPending = (async () => {
      try {
        const value=await remote('metrics');
        if (!value.metrics||typeof value.metrics.running!=='boolean') throw problem('El PC principal no devolvió métricas válidas.',502);
        checked={time:Date.now(),value};
        metricsCache={at:Date.now(),value};
        return value;
      } catch(error) {
        if (/Orden SSH no permitida/i.test(error.message)) {
          error=Object.assign(problem('Actualiza la telemetría del PC principal para mostrar el consumo de Java.',409),{needsTelemetryUpdate:true});
        }
        metricsCache={at:Date.now(),error};
        throw error;
      }
    })();
    try { return await metricsPending; } finally { metricsPending=null; }
  }
  function mark(stage, fields = {}) {
    const save = stage!==job?.stage || fields.done || fields.committed;
    job = { ...job, stage, ...fields, updatedAt:Date.now() };
    if (save) {
      try { write(journalFile,job); } catch (error) { console.error('Registro del traslado:',error.message); }
    }
  }

  function taskAvailable(status) {
    if (status.taskEnabled===false || status.demandStart===false) {
      throw problem('La tarea de Minecraft está deshabilitada o no admite arranques desde el panel.');
    }
  }

  async function launchFailure(entry, status, after) {
    const code = Number.isInteger(status.lastTaskResult)
      ? ' (0x'+(status.lastTaskResult>>>0).toString(16).toUpperCase().padStart(8,'0')+')' : '';
    for (const file of ['logs/wolf-launch-error.log','.wolfmc-task-launch.log']) {
      let handle;
      try {
        handle = await fsp.open(path.join(entry.unc,file),'r');
        const stat = await handle.stat();
        if (!stat.size || stat.mtimeMs<after-2000) continue;
        const buffer = Buffer.alloc(Math.min(4096,stat.size));
        const {bytesRead} = await handle.read(buffer,0,buffer.length,stat.size-buffer.length);
        const detail = buffer.toString('utf8',0,bytesRead).split(/\r?\n/).filter(Boolean).at(-1);
        if (detail) return 'Falló el arranque de Minecraft'+code+'. '+detail.slice(0,300);
      } catch {} finally { await handle?.close().catch(()=>{}); }
    }
    return 'Windows rechazó o interrumpió el arranque de Minecraft'+code+'. Revisa la tarea programada en el PC principal.';
  }

  async function confirmStartup(target, request) {
    const active = manager.instance(id);
    const started = Date.now();
    const entry = target==='primary'?peer():null;
    let seenRunning = false;
    let retried = false;
    let lostStatus = 0;
    while (Date.now()-started<240000) {
      let status;
      if (entry) {
        try { status=await probe(true); lostStatus=0; }
        catch(error) { if(++lostStatus>=3)throw error; await delay(1700); continue; }
      }
      if (status?.running) seenRunning = true;
      const ready = (!entry || status.gameListening) &&
        await active.hostingCommand('list',1500).then(()=>true,()=>false);
      if (ready) return;
      if (entry) {
        const elapsed = Date.now()-started;
        if (seenRunning && !status.running && elapsed>7000) throw problem(await launchFailure(entry,status,started));
        if (!status.running && status.lastTaskRun && request?.lastTaskRun &&
            status.lastTaskRun!==request.lastTaskRun &&
            status.lastTaskResult!==0x41301 && status.lastTaskResult!==0x41303) {
          throw problem(await launchFailure(entry,status,started));
        }
        if (!seenRunning && elapsed>24000 && !retried) {
          retried=true;
          await remote('start',entry);
        }
        if (!seenRunning && elapsed>55000) {
          throw problem('La tarea recibió la orden pero Windows todavía no la ejecuta. Puedes reintentar el arranque sin volver a copiar.');
        }
        mark(status.gameListening?'Esperando respuesta de Minecraft':status.running?'Java está cargando el servidor':'Esperando la tarea de Windows');
      }
      await delay(1700);
    }
    throw problem('La copia quedó verificada, pero Minecraft aún no responde. Revisa la consola y reintenta el arranque si se detuvo.');
  }

  async function finishStartup(target) {
    mark('Solicitando arranque',{committed:true,bytes:0,total:0,mib:0,file:''});
    const request = target==='primary' ? await startPrimary() : await manager.instance(id).startIfStopped(true);
    await confirmStartup(target,request);
    mark('Minecraft listo',{running:false,done:true,ok:true,error:''});
  }

  async function stopped(host, record, entry) {
    const status = host === 'primary' ? await remote('status',entry) : await localState(record);
    if (status.running || status.armed) throw problem('No se pudo confirmar que ambos servidores están detenidos y bloqueados.');
  }

  async function stopSource(current, record, entry) {
    const remoteSource = current === 'primary';
    const status = () => remoteSource ? remote('status',entry) : localState(record);
    const initial = await status();
    if (!initial.running) return;
    if (remoteSource) await ensureTunnel(entry);
    const instance = manager.instance(id);
    const result = await instance.hostingCommand('save-all flush',30000);
    if (!/saved the game|saved the world/i.test(result)) throw problem('Minecraft no confirmó el guardado completo.');
    await instance.hostingCommand('stop',8000).catch(() => {});
    for (let attempt=0;attempt<60;attempt++) {
      await delay(1500);
      if (!(await status()).running) return;
    }
    throw problem('Minecraft sigue activo después de pedir el apagado. Se conserva el origen.');
  }

  function validateInstance(record) {
    if(record.serverPort!==gamePort || record.rconPort!==rconPort || record.bindAddress || record.javaMajor<9 || record.status!=='ready'||!record.eulaAccepted){
      throw problem('El traslado necesita un servidor instalado, Java 9 o superior y Minecraft escuchando en todas las interfaces.');
    }
    if (readWorldName(record.directory)!==worldName) throw problem('El nombre del mundo cambió después de vincular los equipos. Vuelve a usar el nombre original antes del traslado.');
    const local = Object.values(os.networkInterfaces()).flat().find(address => address?.address === here);
    if (!local) throw problem('La IP del PC secundario ha cambiado. Revisa su reserva DHCP antes de trasladar datos.');
  }

  async function move(target) {
    const before = owner();
    if (!['primary','secondary'].includes(target) || target === before.owner ||
        (before.target && before.target !== target)) throw problem('Reanuda el traslado pendiente hacia el destino indicado.');
    if (job?.running || manager.hostingBusy(id)) throw problem('Espera a que termine la operación o copia de seguridad activa.');
    const record = manager.hostingRecord(id);
    validateInstance(record);
    const entry = peer();
    const old = manager.instance(id);
    if (old.isBusy()) throw problem('Hay cambios o copias de seguridad en curso.');
    const moveId = before.moveId || crypto.randomUUID();
    job = {running:true,target,startedAt:Date.now()};
    mark('Comprobando SSH y SMB',{bytes:0,total:0});
    try {
      const status = await remote('status',entry);
      if (target==='primary') {
        taskAvailable(status);
        if (status.running) throw problem('Minecraft ya está activo en el PC principal.');
        await ensureTunnel(entry);
      }
      await verifyStorage(entry);
      if (old.isBusy() || manager.hostingBusy(id)) throw problem('Se inició otra operación. Espera y reintenta.');
      write(stateFile,{ owner:before.owner,target,moveId });
      await remote('disarm',entry);
      mark('Guardando y apagando Minecraft');
      await stopSource(before.owner,record,entry);
      const confirm = async () => { await stopped('secondary',record,entry); await stopped('primary',record,entry); };
      await confirm();
      const root = record.directory;
      const marker = read(path.join(entry.unc,'.wolfmc-native.json'));
      if (marker.instance !== id || marker.computer !== entry.computer) throw problem('El destino SMB no coincide con el perfil.');
      const progress = info => mark(info.phase,info);
      const targetRoot = target === 'primary' ? entry.unc : root;
      // A retry uses a new recovery folder so earlier preserved files stay intact.
      const recovery = path.join(targetRoot,'.wolfmc-recovery',moveId+'-'+crypto.randomUUID());
      // Finish or recover the existing mod transaction on its original volume.
      old.applyHostingMods();
      if (target === 'primary') {
        const args=launchArguments(record);
        await syncTree({from:record.javaHome,to:path.join(entry.unc,'.wolfmc-runtime'),
          recovery:path.join(recovery,'runtime'),game:false,progress,confirm});
        write(path.join(entry.unc,'.wolfmc-launch.json'),{instance:id,args});
      }
      await syncTree({from:target === 'primary' ? root : entry.unc,to:targetRoot,
        recovery:path.join(recovery,'game'),progress,confirm});
      mark('Confirmando el equipo activo',{bytes:0,total:0,file:'',mib:0});
      if (target === 'secondary') closeTunnels();
      write(stateFile,{ owner:target,target:null,moveId:null });
      manager.resetHostingInstance(id);
      await finishStartup(target);
    } catch(error) {
      mark(job.committed?'Arranque pendiente':'Traslado detenido',{running:false,done:true,ok:false,error:error.message});
    }
  }

  async function startPrimary() {
    const current = owner();
    if (current.owner !== 'primary' || current.target) throw problem('El PC principal aún no es el dueño de la copia verificada.');
    const record = manager.hostingRecord(id);
    if ((await localState(record)).running) throw problem('Minecraft sigue activo en el PC secundario.');
    checked = null;
    const result = await remote('status');
    taskAvailable(result);
    if (result.running) { await ensureTunnel(peer(),true); return result; }
    if (!result.armed) await remote('arm');
    await ensureTunnel(peer(),true);
    await remote('start');
    checked = null;
    return result;
  }

  async function issueTool() {
    if (preparing) return preparing;
    if (owner().target || owner().owner!=='secondary' || job?.running || pairing) throw problem('Devuelve el servidor al equipo del panel antes de vincularlo.');
    preparing=(async()=>{
      const record=manager.hostingRecord(id);
      validateInstance(record);
      launchArguments(record);
      if (!fs.existsSync(identity)) {
        const keygen=path.join(path.dirname(ssh),'ssh-keygen.exe');
        await runCommand(keygen,['-q','-t','ed25519','-N','','-C','WolfMC-migration','-f',identity],{windowsHide:true,timeout:15000});
        const user=(await runCommand('whoami.exe',['/user','/fo','csv','/nh'],{windowsHide:true})).stdout.match(/S-1-5-[\d-]+/)?.[0];
        if(!user)throw Error('No se pudo determinar la cuenta propietaria de la clave.');
        await runCommand('icacls.exe',[identity,'/inheritance:r','/grant:r','*'+user+':F'],{windowsHide:true});
      }
      const publicKey=fs.readFileSync(identity+'.pub','utf8').trim().split(/\s+/).slice(0,2).join(' ');
      if (!/^ssh-ed25519 [A-Za-z0-9+/]{68}$/.test(publicKey)) throw problem('La clave pública del panel no es válida.');
      const {privateKey,publicKey:encryptionKey}=await promisify(crypto.generateKeyPair)('rsa',{modulusLength:2048});
      invitation={nonce:crypto.randomBytes(24).toString('hex'),privateKey,expiresAt:Date.now()+3600000};
      const config={...profile,publicKey,share,nonce:invitation.nonce,encryptionKey:encryptionKey.export({format:'jwk'})};
      const source=fs.readFileSync(script('native-host-setup.ps1'),'utf8')
        .replace('@@CONFIG@@',()=>Buffer.from(JSON.stringify(config)).toString('base64'))
        .replace('@@POLICY@@',()=>fs.readFileSync(script('native-host-task-policy.ps1')).toString('base64'))
        .replace('@@HELPER@@',()=>Buffer.from(taskSource()).toString('base64'));
      return windowsLauncher(source,'Acepta el aviso de Windows para preparar el equipo de destino.');
    })();
    try{return await preparing;}finally{preparing=null;}
  }

  async function importReceipt(receipt) {
    if(owner().target||owner().owner!=='secondary'||job?.running||pairing)throw problem('Hay un traslado o una vinculación en curso.');
    if(!invitation||Date.now()>invitation.expiresAt||receipt?.nonce!==invitation.nonce)throw problem('La vinculación caducó. Descarga una herramienta nueva.');
    if(receipt.instance!==id||receipt.controller!==here||!privateIp(receipt.host)||receipt.host===here||
      receipt.share!==share||!validFolder(receipt.folder)||!/^[a-zA-Z0-9-]{1,15}$/.test(receipt.computer||'')||
      !/^ssh-ed25519 [A-Za-z0-9+/]{68}$/.test(receipt.hostKey||'')||!/^[A-Za-z0-9+/]{342}==$/.test(receipt.encryptedPassword||'')){
      throw problem('El archivo de vinculación no corresponde a este servidor.',400);
    }
    pairing=true;
    let plain;
    const knownHosts=path.join(data,'known_hosts'), candidate=path.join(data,'pairing.json');
    const savedKey=fs.existsSync(knownHosts)?fs.readFileSync(knownHosts):null;
    try {
      plain=crypto.privateDecrypt({key:invitation.privateKey,oaepHash:'sha256'},Buffer.from(receipt.encryptedPassword,'base64'));
      if (!/^Wm9-[A-Za-z0-9+/]{32}$/.test(plain.toString('ascii')))throw problem('El identificador SMB cifrado no es válido.',400);
      const {host,controller,folder,computer,hostKey,mac,instance}=receipt;
      const entry={host,controller,folder,computer,hostKey,mac,instance,share,unc:'\\\\'+host+'\\'+share};
      if(fs.existsSync(receiptFile)){
        const previous=peer();
        if(previous.host!==entry.host||previous.folder.toLowerCase()!==entry.folder.toLowerCase()){
          throw problem('Esta instalación ya tiene un equipo vinculado para este servidor.');
        }
      }
      // Validate the pinned host before sending the SMB password to it.
      fs.writeFileSync(knownHosts,host+' '+hostKey+'\n','ascii');
      const state=await remote('status',entry);
      taskAvailable(state);
      if(state.running||state.armed)throw problem('El equipo de destino ya tiene un mundo armado o en ejecución.');
      write(candidate,{host,controller,folder,computer,hostKey,mac,instance,share});
      await installCredential(plain);
      fs.renameSync(candidate,receiptFile);
      invitation=null;
      checked={time:Date.now(),value:state};
      return {ok:true,message:'Equipos vinculados. El servidor se puede trasladar desde el panel.'};
    } catch(error) {
      if(savedKey)fs.writeFileSync(knownHosts,savedKey);
      else await fsp.rm(knownHosts,{force:true}).catch(()=>{});
      throw error;
    } finally {
      plain?.fill(0);
      await fsp.rm(candidate,{force:true}).catch(()=>{});
      pairing=false;
    }
  }

  function installCredential(plain) {
    return new Promise((resolve,reject)=>{
      const child=spawnProcess(ps,[...powershellArgs,'-File',script('native-host-smb.ps1'),'-DataDirectory',data,'-ImportSecret'],
        {windowsHide:true,stdio:['pipe','ignore','pipe']});
      const timer=setTimeout(()=>child.kill(),20000);
      let detail='';
      child.stderr.on('data',chunk=>{detail=(detail+chunk).slice(0,1200);});
      child.stdin.on('error',()=>{});
      child.once('error',error=>{clearTimeout(timer);reject(error);});
      child.once('close',code=>{
        clearTimeout(timer);
        if(code===0)resolve();
        else reject(problem('La vinculación por SMB cifrado no se pudo completar. '+(detail.trim().split(/\r?\n/)[0]||'El equipo no respondió.'),502));
      });
      child.stdin.end(plain);
    });
  }

  async function wake() {
    const entry = peer();
    const mac = entry.mac?.replace(/[:-]/g,'') || '';
    if (!/^[A-Fa-f0-9]{12}$/.test(mac)) throw problem('El adaptador del PC principal no informó de una MAC válida.');
    const packet = Buffer.concat([Buffer.alloc(6,255),...Array(16).fill(Buffer.from(mac,'hex'))]);
    const socket = dgram.createSocket('udp4');
    try {
      await new Promise((resolve,reject) => {
        socket.once('error',reject);
        socket.bind(0,here,() => {
          try {
            socket.setBroadcast(true);
            socket.send(packet,9,'255.255.255.255',error => error ? reject(error) : resolve());
          } catch(error) { reject(error); }
        });
      });
    } finally { socket.close(); }
  }

  function context() {
    if (owner().owner !== 'primary') return null;
    try {
      const entry = peer();
      return { root:entry.unc, get rconPort(){return rconTunnel}, start:startPrimary,
        metrics:remoteMetrics,
        gameState:probe,
        ensure:async ({files=true}={}) => {
          if (files) await ensureSmb(entry);
          await ensureTunnel(entry,!owner().target);
        },
        isOnline:async () => (await probe()).gameListening,
        confirmStopped:async () => { if ((await probe(true)).running) throw problem('Minecraft sigue arrancando o apagándose en el PC principal.'); } };
    } catch { throw problem('El servidor está asignado al PC principal, pero falta su vinculación.'); }
  }

  const reconnect = setInterval(() => {
    if (closing || job?.running || relay) return;
    try {
      const state = owner();
      if (state.owner === 'primary' && !state.target) ensureTunnel(peer(),true).catch(() => {});
    } catch {}
  },10000);
  reconnect.unref();

  async function handle(req,res,url,main) {
    if (!url.pathname.startsWith('/api/app/native-hosting')) return false;
    const send = main.sendJson;
    const route = url.pathname.split('/').at(-1);
    if (req.method === 'GET' && route === 'native-hosting') {
      const state=owner(), linked=fs.existsSync(receiptFile);
      if (linked && !job?.running && state.owner==='primary') probe().catch(()=>{});
      const snapshot=checked?.value;
      const primary=checked?{reachable:Boolean(snapshot),running:snapshot?.running===true,
        listening:snapshot?.gameListening===true,taskRunning:snapshot?.taskRunning===true,error:checked.error||''}:null;
      if (primary?.listening && job?.committed && job.done && !job.ok && !state.target && state.owner==='primary') {
        const ready=await manager.instance(id).hostingCommand('list',1200).then(()=>true,()=>false);
        if (ready) mark('Minecraft listo',{ok:true,error:''});
      }
      const canRetryStart=!state.target&&!job?.running&&(
        (state.owner==='primary'&&primary?.reachable&&!primary.running)||
        (job?.committed&&job.done&&!job.ok&&(!primary?.running||state.owner==='secondary')));
      return send(res,200,{...state,job,primary,canRetryStart,linked,setupLauncher:true,running:job?.running===true}),true;
    }
    if(req.method==='POST'&&route==='tool'){
      const content=await issueTool();
      res.writeHead(200,{'Content-Type':'application/octet-stream','Content-Disposition':'attachment; filename="Preparar-WolfMC.cmd"'});
      res.end(content);
      return true;
    }
    if(req.method==='POST'&&route==='pair'){
      send(res,200,await importReceipt(await main.readJson(req,8192)));
      return true;
    }
    if (req.method === 'POST' && route === 'check') {
      const entry = peer();
      const status = await probe(true);
      taskAvailable(status);
      await verifyStorage(entry);
      return send(res,200,{computer:status.computer,folder:status.root,running:status.running,armed:status.armed}),true;
    }
    if (req.method === 'POST' && route === 'startup') {
      const state=owner();
      if (state.target||job?.running||manager.hostingBusy(id)||manager.instance(id).isBusy()) throw problem('Espera a que termine la operación activa.');
      job={running:true,target:state.owner,committed:true,startedAt:Date.now()};
      finishStartup(state.owner).catch(error=>mark('Arranque pendiente',{running:false,done:true,ok:false,error:error.message}));
      return send(res,202,{message:'Se ha pedido el arranque de la copia verificada.'}),true;
    }
    if (req.method === 'POST' && route === 'move') {
      const { target } = await main.readJson(req);
      if (job?.running) throw problem('Ya hay un traslado en curso.');
      const task = move(target);
      if (!job?.running) await task;
      else task.catch(() => {});
      return send(res,202,{ok:true}),true;
    }
    if (req.method === 'POST' && route === 'wake') {
      await wake();
      return send(res,200,{message:'Señal Wake-on-LAN enviada. Comprueba la conexión al terminar el arranque.'}),true;
    }
    return send(res,404,{error:'Operación de alojamiento desconocida.'}),true;
  }

  return {id, data, handle, context, owner, attach:value => { manager=value; }, busy:() => job?.running===true||pairing,
    blocked:() => Boolean(job?.running || owner().target),
    allowsLocalHandoff:() => job?.running===true&&job.committed===true&&job.target==='secondary'&&owner().owner==='secondary'&&!owner().target,
    close:() => { closing=true; clearInterval(reconnect); closeTunnels(); }};
}

function validFolder(value){
  return typeof value==='string'&&/^[a-zA-Z]:\\[^<>:"|?*\x00-\x1F]+$/.test(value)&&value.split('\\').slice(1).every(part=>part && !/[ .]$/.test(part));
}

function readWorldName(directory){
  const name=/^level-name=(.*)$/m.exec(fs.readFileSync(path.join(directory,'server.properties'),'utf8'))?.[1]?.trim()||'world';
  if(!/^[a-zA-Z0-9_. -]{1,80}$/.test(name)||name.startsWith('.')||/[. ]$/.test(name))throw problem('El nombre de la carpeta del mundo no es compatible.');
  return name;
}

module.exports = {createNativeHosting,windowsLauncher,taskSource,launchArguments,readWorldName,privateIp};
