$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$outputDirectory = if ($WolfSetupOutputDirectory) { $WolfSetupOutputDirectory } else { (Get-Location).Path }
$setup = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('@@CONFIG@@')) | ConvertFrom-Json
$instance = [string]$setup.id
$SecondaryIP = [string]$setup.controller
$gamePort = [int]$setup.gamePort
$rconPort = [int]$setup.rconPort
$Folder = if ($setup.replicaFolder) { [string]$setup.replicaFolder } else { Join-Path ($env:SystemDrive + '\WolfMC\Servers') $instance }
$logName = 'Diagnostico-WolfMC-Windows.txt'
$logFile = Join-Path $outputDirectory $logName
try { [IO.File]::WriteAllText($logFile, '') }
catch {
    $logFile = Join-Path $env:TEMP $logName
    [IO.File]::WriteAllText($logFile, '')
}
$step = 'Comprobaciones iniciales'
function Write-SetupLog([string]$Message) {
    $timestamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
    [IO.File]::AppendAllText($logFile, "$timestamp $Message" + [Environment]::NewLine)
}
function Set-SetupStep([string]$Name) {
    $script:step = $Name
    Write-SetupLog $Name
    Write-Host $Name -ForegroundColor Cyan
}
trap {
    $failure = $_
    Write-SetupLog ("ERROR en {0}: {1}" -f $step, $failure.Exception.Message)
    Write-SetupLog ("Linea: {0}; codigo: {1}" -f $failure.InvocationInfo.ScriptLineNumber, $failure.FullyQualifiedErrorId)
    Write-Host "Fallo en $step. Diagnostico guardado en $logFile" -ForegroundColor Yellow
    break
}
Set-SetupStep 'Comprobaciones iniciales'

$publicKey = $setup.publicKey
$helper = '@@HELPER@@'
$policy = '@@POLICY@@'
$account = 'wolfmc_host'
$share = $setup.share
$control = 'C:\ProgramData\WolfMC-Native'
$taskName = 'WolfMC-Replica'
$ssh = Join-Path $env:WINDIR 'System32\OpenSSH'
$settings = Join-Path $control 'settings.json'
$sshdConfig = Join-Path $env:ProgramData 'ssh\sshd_config'
$admins = 'S-1-5-32-544'
$system = 'S-1-5-18'
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
if (!(New-Object Security.Principal.WindowsPrincipal($identity)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Abre PowerShell como administrador y vuelve a ejecutar este archivo.'
}
function Set-FileAccess([string]$Path,[string[]]$Grants) {
    & icacls.exe $Path '/inheritance:r' '/grant:r' @Grants | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "No se pudieron proteger los permisos de $Path." }
}
function Protect-OpenSshPath([string]$Path, [switch]$Directory) {
    $item = Get-Item -LiteralPath $Path -Force
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or
        ($item.PSIsContainer -ne $Directory.IsPresent)) {
        throw "Ruta inesperada de OpenSSH: $Path"
    }
    $acl = Get-Acl -LiteralPath $Path
    $acl.SetAccessRuleProtection($true,$false)
    foreach ($rule in $acl.GetAccessRules($true,$false,[Security.Principal.SecurityIdentifier])) {
        $acl.RemoveAccessRuleSpecific($rule)
    }
    $inherit = if ($Directory) { [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit' }
        else { [Security.AccessControl.InheritanceFlags]::None }
    foreach ($id in @($admins,$system)) {
        $principal = [Security.Principal.SecurityIdentifier]::new($id)
        $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
            $principal,'FullControl',$inherit,'None','Allow'))
    }
    if ($Directory) {
        $readers = [Security.Principal.SecurityIdentifier]::new('S-1-5-11')
        $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
            $readers,'ReadAndExecute','None','None','Allow'))
    }
    $acl.SetOwner([Security.Principal.SecurityIdentifier]::new($admins))
    Set-Acl -LiteralPath $Path -AclObject $acl
}
function Read-SshStartupEvents([datetime]$Since) {
    foreach ($channel in @('OpenSSH/Admin','OpenSSH/Operational','System')) {
        $filter = @{LogName=$channel;StartTime=$Since}
        if ($channel -eq 'System') { $filter.ProviderName='Service Control Manager' }
        foreach ($event in @(Get-WinEvent -FilterHashtable $filter -MaxEvents 20 -ErrorAction SilentlyContinue)) {
            if ($channel -eq 'System' -and $event.Message -notmatch '(?i)openssh|sshd') { continue }
            Write-SetupLog ("{0} ID {1}: {2}" -f $channel,$event.Id,($event.Message -replace '[\r\n]+',' '))
        }
    }
}
function Start-WolfSshService {
    $config = Get-Content -LiteralPath $sshdConfig -Raw
    if (!$config.StartsWith('# Wolf MC Panel: dedicated instance')) {
        throw 'La configuracion SSH no pertenece a Wolf MC Panel.'
    }
    $service = Get-CimInstance Win32_Service -Filter "Name='sshd'"
    $binary = Join-Path $ssh 'sshd.exe'
    if (!$service -or ([Environment]::ExpandEnvironmentVariables($service.PathName) -notmatch ('^"?' + [regex]::Escape($binary) + '(?:"|$|\s)'))) {
        throw 'El servicio sshd no apunta al OpenSSH nativo de Windows.'
    }
    $sshData = Split-Path -Parent $sshdConfig
    $hostKeyPath = Join-Path $sshData 'ssh_host_ed25519_key'
    $sshLogs = Join-Path $sshData 'logs'
    # Check the root before creating a child, and protect the key without broad read inheritance.
    Protect-OpenSshPath $sshData -Directory
    if (!(Test-Path -LiteralPath $sshLogs)) { New-Item -ItemType Directory -Path $sshLogs | Out-Null }
    Protect-OpenSshPath $sshLogs -Directory
    Protect-OpenSshPath $hostKeyPath
    Protect-OpenSshPath $sshdConfig
    & $binary -t -E $logFile -f $sshdConfig
    if ($LASTEXITCODE -ne 0) { throw 'OpenSSH rechazo su configuracion. El motivo esta en el diagnostico.' }
    Set-Service sshd -StartupType Automatic
    $startTime = (Get-Date).AddSeconds(-3)
    try {
        if ((Get-Service sshd).Status -eq 'Running') { Restart-Service sshd } else { Start-Service sshd }
    } catch {
        $startupFailure = $_
        foreach ($line in (& sc.exe queryex sshd)) { Write-SetupLog $line }
        Write-SetupLog ('OpenSSH version: ' + (Get-Item -LiteralPath $binary).VersionInfo.FileVersion)
        Read-SshStartupEvents $startTime
        throw $startupFailure
    }
    $listener = @(Get-NetTCPConnection -State Listen -LocalPort 22 -ErrorAction SilentlyContinue |
        Where-Object { $_.LocalAddress -eq $PrimaryIP })
    if (!$listener.Count) {
        Read-SshStartupEvents $startTime
        throw "El servicio se inicio pero no escucha en la IP $PrimaryIP."
    }
}
function Test-LanIP([string]$Address) {
    $Address -match '^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)\d'
}
$secondary = [Net.IPAddress]::Parse($SecondaryIP)
if (Get-NetIPAddress -AddressFamily IPv4 -IPAddress $SecondaryIP -ErrorAction SilentlyContinue) {
    throw 'Abre esta herramienta en el segundo PC, el que recibira la copia.'
}
$route = @(Find-NetRoute -RemoteIPAddress $SecondaryIP | Where-Object {$_.IPAddress -and $_.AddressFamily -eq 'IPv4'})
if ($route.Count -ne 1) { throw 'No se pudo encontrar la interfaz IPv4 hacia el PC del panel.' }
$adapter = $route[0]
$PrimaryIP = $adapter.IPAddress
if (!(Test-LanIP $PrimaryIP) -or !(Test-LanIP $SecondaryIP)) { throw 'Utiliza direcciones IPv4 privadas y conecta ambos equipos a la misma red.' }
$nic = Get-NetAdapter -InterfaceIndex $adapter.InterfaceIndex
if ($Folder -notmatch '^[A-Za-z]:\\[^\\]+\\[^\\]+') { throw 'Selecciona una carpeta de servidor dentro de un disco local.' }
$Folder = [IO.Path]::GetFullPath($Folder)
if ($Folder -match '^[A-Z]:\\(Windows|Program Files( \(x86\))?|ProgramData|Users|System Volume Information|\$Recycle\.Bin)(\\|$)') {
    throw 'Selecciona una carpeta exclusiva de Minecraft fuera del sistema y de otros perfiles.'
}
if ((Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='$($Folder.Substring(0,2))'").DriveType -ne 3) { throw 'El destino debe ser un disco local fijo.' }
for ($parent = $Folder; $parent; $parent = Split-Path -Parent $parent) {
    if ((Test-Path -LiteralPath $parent) -and ((Get-Item -LiteralPath $parent -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        throw 'La carpeta seleccionada usa un enlace o punto de montaje.'
    }
}
$managed = Test-Path -LiteralPath $settings
if ($managed) {
    $old = Get-Content -LiteralPath $settings -Raw | ConvertFrom-Json
    if ($old.instance -ne $instance -or $old.folder -ne $Folder -or (Test-Path -LiteralPath (Join-Path $control 'state\enabled'))) {
        throw 'Devuelve primero Minecraft al PC secundario antes de cambiar esta instalacion.'
    }
}
if (!$managed -and (Test-Path -LiteralPath $Folder) -and @(Get-ChildItem -LiteralPath $Folder -Force | Where-Object Name -ne '.wolfmc-storage.json').Count) {
    throw 'La carpeta ya contiene archivos. Elige una carpeta nueva para la replica.'
}
$description = 'Wolf MC Panel dedicated server'
$localAccount = Get-LocalUser -Name $account -ErrorAction SilentlyContinue
if (!$managed -and $localAccount -and $localAccount.Description -cne $description) {
    throw 'La cuenta wolfmc_host ya existe y no pertenece a esta instalacion.'
}
if (Test-Path -LiteralPath $sshdConfig) {
    $previous = Get-Content -LiteralPath $sshdConfig -Raw
    if (!$previous.StartsWith('# Wolf MC Panel: dedicated instance') -and
        @($previous -split '\r?\n' | Where-Object { $_ -match '^\s*[^#\s]' -and $_ -notmatch '^\s*(Subsystem\s+sftp\s+sftp-server\.exe|Match\s+Group\s+administrators|AuthorizedKeysFile\s+__PROGRAMDATA__/ssh/administrators_authorized_keys)\s*$' }).Count) {
        throw 'OpenSSH ya tiene una configuracion propia. Se ha conservado.'
    }
    if (!$previous.StartsWith('# Wolf MC Panel: dedicated instance') -and (Get-Service sshd -ErrorAction SilentlyContinue).Status -eq 'Running') {
        throw 'OpenSSH ya esta en uso. Se ha conservado su configuracion.'
    }
}
$existing = Get-SmbShare -Name $share -ErrorAction SilentlyContinue
if ($existing -and (!$managed -or $existing.Path -ne $Folder)) { throw 'Ya existe un recurso SMB con ese nombre.' }

function Complete-WolfSetup {
    Set-SetupStep 'Permisos y arranque de OpenSSH'
    Start-WolfSshService
    $wake = 'Requiere comprobar BIOS/UEFI y el adaptador Ethernet.'
    try {
        $power = Get-NetAdapterPowerManagement -Name $nic.Name
        if ($power.WakeOnMagicPacket -in @('Enabled','Disabled')) {
            if ($power.WakeOnMagicPacket -eq 'Disabled') { Set-NetAdapterPowerManagement -Name $nic.Name -WakeOnMagicPacket Enabled -NoRestart }
            $wake = 'Magic Packet habilitado en Windows. Prueba el encendido desde el panel.'
        }
    } catch {}
    Set-SetupStep 'Guardando la vinculacion'
    $hostPublicKey = ((Get-Content -LiteralPath (Join-Path $env:ProgramData 'ssh\ssh_host_ed25519_key.pub')) -split '\s+')[0..1] -join ' '
    $receipt = Join-Path $outputDirectory 'Vinculacion-WolfMC-Windows.json'
    $key = [Security.Cryptography.RSAParameters]::new()
    function Decode-PublicPart([string]$value) {
        $base = $value.Replace('-','+').Replace('_','/')
        return ,([Convert]::FromBase64String($base.PadRight($base.Length+((4-$base.Length%4)%4),'=')))
    }
    $key.Modulus = Decode-PublicPart $setup.encryptionKey.n
    $key.Exponent = Decode-PublicPart $setup.encryptionKey.e
    $rsa = [Security.Cryptography.RSACng]::new()
    $bytes = [Text.Encoding]::UTF8.GetBytes($temporaryPassword)
    try {
        $rsa.ImportParameters($key)
        $encrypted = [Convert]::ToBase64String($rsa.Encrypt($bytes,[Security.Cryptography.RSAEncryptionPadding]::OaepSHA256))
    } finally { [Array]::Clear($bytes,0,$bytes.Length); $rsa.Dispose() }
    @{instance=$instance;host=$PrimaryIP;controller=$SecondaryIP;computer=$env:COMPUTERNAME;share=$share;folder=$Folder;hostKey=$hostPublicKey;mac=$nic.MacAddress;nonce=$setup.nonce;encryptedPassword=$encrypted} |
        ConvertTo-Json | Set-Content -LiteralPath $receipt -Encoding UTF8
    Write-Host "Preparacion terminada. En el panel, selecciona Importar vinculacion y elige este archivo:"
    Write-Host $receipt
    Write-SetupLog 'Preparacion terminada.'
    Write-Host "Wake-on-LAN: $wake"
}
function Test-WolfTask {
    $pending = Join-Path $control 'state\preflight-request'
    $reply = Join-Path $control 'state\preflight-response'
    $nonce = [guid]::NewGuid().ToString('N')
    if (Test-Path -LiteralPath (Join-Path $control 'state\enabled')) { throw 'Esta copia tiene el permiso de arranque del mundo.' }
    try {
        [IO.File]::WriteAllText($pending,$nonce)
        Start-ScheduledTask -TaskName $taskName
        for ($i=0; $i -lt 25; $i++) {
            Start-Sleep -Seconds 1
            if ((Test-Path -LiteralPath $reply) -and [IO.File]::ReadAllText($reply) -eq $nonce) {
                Write-SetupLog 'La tarea de Windows arranco con la cuenta restringida.'
                return
            }
        }
        $info = Get-ScheduledTaskInfo -TaskName $taskName
        Write-SetupLog ('Resultado de la tarea de Windows: 0x{0:X8}' -f $info.LastTaskResult)
        throw 'Windows no pudo ejecutar la tarea de Minecraft. La vinculacion queda pendiente.'
    } finally {
        [IO.File]::Delete($pending)
        [IO.File]::Delete($reply)
    }
}
function Install-WolfTaskHelper {
    . ([scriptblock]::Create([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($policy))))
    Grant-WolfBatchLogon (Get-LocalUser -Name $account).SID
    $taskFile = Join-Path $control 'host-task.ps1'
    $temporary = $taskFile+'.tmp'
    [IO.File]::WriteAllBytes($temporary,[Convert]::FromBase64String($helper))
    Move-Item -LiteralPath $temporary -Destination $taskFile -Force
}
Set-SetupStep 'Cuenta SMB y permisos de la carpeta'
$random = [byte[]]::new(24)
$generator = [Security.Cryptography.RandomNumberGenerator]::Create()
try { $generator.GetBytes($random) } finally { $generator.Dispose() }
$temporaryPassword = 'Wm9-' + [Convert]::ToBase64String($random)
[Array]::Clear($random,0,$random.Length)
$secure = [Security.SecureString]::new()
foreach ($character in $temporaryPassword.ToCharArray()) { $secure.AppendChar($character) }
$secure.MakeReadOnly()
if (!$localAccount) { New-LocalUser -Name $account -Password $secure -PasswordNeverExpires -Description $description | Out-Null }
else { Set-LocalUser -Name $account -Password $secure }
$sid = (Get-LocalUser -Name $account).SID.Value
$user = "$env:COMPUTERNAME\$account"
$owner = $identity.User.Value
New-Item -ItemType Directory -Path $Folder,$control -Force | Out-Null
Set-FileAccess $Folder @("*${admins}:(OI)(CI)F","*${system}:(OI)(CI)F","*${owner}:(OI)(CI)F","*${sid}:(OI)(CI)M")
Set-FileAccess $control @("*${admins}:(OI)(CI)F","*${system}:(OI)(CI)F","*${sid}:(OI)(CI)RX")
@{instance=$instance;folder=$Folder;gamePort=$gamePort;rconPort=$rconPort;worldName=$setup.worldName;taskName=$taskName} | ConvertTo-Json | Set-Content -LiteralPath $settings -Encoding UTF8
New-Item -ItemType Directory -Path (Join-Path $control 'state') -Force | Out-Null
Set-FileAccess (Join-Path $control 'state') @("*${admins}:(OI)(CI)F","*${system}:(OI)(CI)F","*${sid}:(OI)(CI)M")
New-Item -ItemType File -Path (Join-Path $control 'state\command.lock') -Force | Out-Null
$keyFile = Join-Path $control 'authorized_keys'
Set-Content -LiteralPath $keyFile -Encoding Ascii -Value "from=`"$SecondaryIP`",no-agent-forwarding,no-X11-forwarding,no-pty $publicKey"
Set-FileAccess $keyFile @("*${admins}:F","*${system}:F","*${sid}:R")
& icacls.exe $keyFile /setowner $user | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'No se pudo asignar el propietario de la clave SSH.' }

Set-SetupStep 'Instalacion y configuracion de OpenSSH'
$feature = Get-WindowsCapability -Online -Name 'OpenSSH.Server~~~~0.0.1.0'
if ($feature.State -ne 'Installed') { Add-WindowsCapability -Online -Name $feature.Name | Out-Null }
if (!(Test-Path -LiteralPath (Join-Path $ssh 'sshd.exe'))) { throw 'Windows no ha instalado OpenSSH Server.' }
New-Item -ItemType Directory -Path (Split-Path $sshdConfig) -Force | Out-Null
& (Join-Path $ssh 'ssh-keygen.exe') -A
if ($LASTEXITCODE -ne 0) { throw 'No se pudieron crear las claves de host SSH.' }
$psExe = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
$rules = @"
# Wolf MC Panel: dedicated instance
Port 22
AddressFamily inet
ListenAddress $PrimaryIP
HostKey __PROGRAMDATA__/ssh/ssh_host_ed25519_key
AllowUsers $account@$SecondaryIP
AuthenticationMethods publickey
PubkeyAuthentication yes
PasswordAuthentication no
KbdInteractiveAuthentication no
AuthorizedKeysFile C:/ProgramData/WolfMC-Native/authorized_keys
AllowAgentForwarding no
X11Forwarding no
PermitTTY no
AllowTcpForwarding local
PermitOpen 127.0.0.1:$gamePort 127.0.0.1:$rconPort
ForceCommand $psExe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File C:\ProgramData\WolfMC-Native\host-task.ps1
"@
$temp = $sshdConfig + '.wolfmc.tmp'
Set-Content -LiteralPath $temp -Value $rules -Encoding Ascii
& (Join-Path $ssh 'sshd.exe') -t -E $logFile -f $temp
if ($LASTEXITCODE -ne 0) { throw 'La version instalada de OpenSSH rechazo la configuracion restringida.' }
if ((Test-Path -LiteralPath $sshdConfig) -and !(Test-Path -LiteralPath ($sshdConfig+'.wolfmc-original'))) {
    Copy-Item -LiteralPath $sshdConfig -Destination ($sshdConfig+'.wolfmc-original')
}
Move-Item -LiteralPath $temp -Destination $sshdConfig -Force

Set-SetupStep 'Recurso SMB cifrado'
Set-Service LanmanServer -StartupType Automatic
Start-Service LanmanServer
if (!$existing) {
    New-SmbShare -Name $share -Path $Folder -ChangeAccess $user -EncryptData $true -CachingMode None -FolderEnumerationMode AccessBased | Out-Null
}
Set-SmbShare -Name $share -EncryptData $true -CachingMode None -Force | Out-Null
$other = @(Get-SmbShareAccess -Name $share | Where-Object { $_.AccountName -ne $user -and $_.AccessControlType -eq 'Allow' })
if ($other.Count) { throw 'El recurso WolfMC tiene permisos adicionales que impiden continuar.' }
if (!(Get-SmbShare -Name $share).EncryptData) { throw 'Windows no confirmo el cifrado obligatorio del recurso.' }

Set-SetupStep 'Tarea programada de Minecraft'
Install-WolfTaskHelper
$action = New-ScheduledTaskAction -Execute $psExe -Argument '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File C:\ProgramData\WolfMC-Native\host-task.ps1 -RunMinecraft' -WorkingDirectory $Folder
$taskSettings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
$plain = (New-Object PSCredential($user,$secure)).GetNetworkCredential().Password
try {
    Register-ScheduledTask -TaskName $taskName -Action $action -Settings $taskSettings -RunLevel Limited -User $user -Password $plain -Force | Out-Null
} finally { $plain = $null }
$schedule = New-Object -ComObject 'Schedule.Service'
$schedule.Connect()
$schedule.GetFolder('\').GetTask($taskName).SetSecurityDescriptor("D:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;GRGX;;;$sid)",16)
Test-WolfTask
@{instance=$instance; computer=$env:COMPUTERNAME} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $Folder '.wolfmc-native.json') -Encoding UTF8

Set-SetupStep 'Firewall de red local y arranque de OpenSSH'
foreach ($entry in @(@{Name='WolfMC-SSH-LAN';Port=22},@{Name='WolfMC-SMB-LAN';Port=445})) {
    if (Get-NetFirewallRule -Name $entry.Name -ErrorAction SilentlyContinue) {
        Set-NetFirewallRule -Name $entry.Name -LocalAddress $PrimaryIP -RemoteAddress $SecondaryIP -LocalPort $entry.Port -Enabled True
    } else {
        New-NetFirewallRule -Name $entry.Name -DisplayName $entry.Name -Direction Inbound -Action Allow -Protocol TCP -LocalPort $entry.Port -LocalAddress $PrimaryIP -RemoteAddress $SecondaryIP | Out-Null
    }
}
if (Get-NetFirewallRule -Name 'WolfMC-Game-OnlyViaSecondary' -ErrorAction SilentlyContinue) {
    Set-NetFirewallRule -Name 'WolfMC-Game-OnlyViaSecondary' -InterfaceAlias $nic.Name -Enabled True
} else {
    New-NetFirewallRule -Name 'WolfMC-Game-OnlyViaSecondary' -DisplayName 'WolfMC only via SSH tunnel' -Direction Inbound -Action Block -Protocol TCP -LocalPort $gamePort,$rconPort -InterfaceAlias $nic.Name | Out-Null
}
Disable-NetFirewallRule -Name 'OpenSSH-Server-In-TCP' -ErrorAction SilentlyContinue | Out-Null
Complete-WolfSetup
$temporaryPassword = $null
