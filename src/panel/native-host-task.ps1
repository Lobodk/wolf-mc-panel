param([switch]$RunMinecraft)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$root = $PSScriptRoot
$config = Get-Content -LiteralPath (Join-Path $root 'settings.json') -Raw | ConvertFrom-Json
$gate = Join-Path $root 'state\enabled'
$lockFile = Join-Path $root 'state\command.lock'
$preflight = Join-Path $root 'state\preflight-request'
$taskName = $config.taskName

function Write-LaunchDiagnostic([string]$Message) {
    $logPath = Join-Path $config.folder '.wolfmc-task-launch.log'
    [IO.File]::AppendAllText($logPath, ('{0:o} {1}{2}' -f [DateTimeOffset]::Now,$Message,[Environment]::NewLine))
}

function Get-WolfTask {
    $scheduler = New-Object -ComObject 'Schedule.Service'
    $scheduler.Connect()
    $scheduler.GetFolder('\').GetTask($taskName)
}

function Get-ServerState {
    $task = Get-WolfTask
    $listeners = @([Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners() |
        Where-Object { $_.Port -in @($config.gamePort,$config.rconPort) })
    $result = [ordered]@{
        instance = $config.instance
        root = $config.folder
        computer = $env:COMPUTERNAME
        armed = Test-Path -LiteralPath $gate
        taskEnabled = $task.Enabled
        demandStart = $task.Definition.Settings.AllowDemandStart
        taskRunning = [int]$task.State -in @(2,4)
        lastTaskResult = [int64]$task.LastTaskResult
        lastTaskRun = ([datetime]$task.LastRunTime).ToString('o')
        listening = $listeners.Count -gt 0
        gameListening = @($listeners | Where-Object Port -eq $config.gamePort).Count -gt 0
    }
    $result.running = $result.taskRunning -or $result.listening
    $session = Join-Path (Join-Path $config.folder $config.worldName) 'session.lock'
    if (Test-Path -LiteralPath $session) {
        try { [IO.File]::Open($session,'Open','ReadWrite','None').Dispose() }
        catch [IO.IOException] { $result.running = $true }
    }
    $result
}

function Get-JavaStatistics($process) {
    $exe = Join-Path $config.folder '.wolfmc-runtime\bin\jstat.exe'
    if (!(Test-Path -LiteralPath $exe)) { return $null }
    $details = [Diagnostics.ProcessStartInfo]::new($exe,('-gc '+$process.Id))
    $details.UseShellExecute = $false
    $details.CreateNoWindow = $true
    $details.RedirectStandardOutput = $true
    $details.RedirectStandardError = $true
    $query = [Diagnostics.Process]::Start($details)
    try {
        $output = $query.StandardOutput.ReadToEndAsync()
        $errors = $query.StandardError.ReadToEndAsync()
        if (!$query.WaitForExit(2500)) { $query.Kill(); return $null }
        if ($query.ExitCode -eq 0) { return $output.GetAwaiter().GetResult() }
    } finally { $query.Dispose() }
    return $null
}

function Get-HostMetrics {
    $snapshot = Get-ServerState
    $process = $null
    $logPath = Join-Path $config.folder '.wolfmc-task-launch.log'
    if ($snapshot.running -and (Test-Path -LiteralPath $logPath)) {
        $launch = Get-Content -LiteralPath $logPath -Tail 20 | Select-String '^(?<when>\S+) Proceso Java: (?<pid>\d+)$' | Select-Object -Last 1
        if ($launch) {
            $values = $launch.Matches[0].Groups
            $candidate = Get-Process -Id ([int]$values['pid'].Value) -ErrorAction SilentlyContinue
            $javaPath = Join-Path $config.folder '.wolfmc-runtime\bin\java.exe'
            if ($candidate -and $candidate.Path -eq $javaPath -and
                [Math]::Abs(((Get-Date $values['when'].Value)-$candidate.StartTime).TotalSeconds) -lt 30) {
                $process = $candidate
            }
        }
    }
    $metrics = [ordered]@{
        running = $snapshot.running
        logicalProcessors = [Environment]::ProcessorCount
        sampledAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    }
    try {
        Add-Type -AssemblyName Microsoft.VisualBasic
        $memory = [Microsoft.VisualBasic.Devices.ComputerInfo]::new()
        $metrics.totalMemoryBytes = [double]$memory.TotalPhysicalMemory
        $metrics.freeMemoryBytes = [double]$memory.AvailablePhysicalMemory
    } catch {}
    if ($process) {
        $metrics.pid = $process.Id
        $metrics.workingSetBytes = [double]$process.WorkingSet64
        $metrics.privateBytes = [double]$process.PrivateMemorySize64
        $metrics.cpuSeconds = [double]$process.TotalProcessorTime.TotalSeconds
        $metrics.startedAt = $process.StartTime.ToUniversalTime().ToString('o')
        try { $metrics.jstat = Get-JavaStatistics $process } catch {}
    }
    try {
        $source = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('@@NETWORK@@'))
        $addresses = @($env:SSH_CONNECTION -split ' ')
        $adapter = if ($addresses.Count -ge 3) { $addresses[2] } else { '' }
        $network = & ([scriptblock]::Create($source)) -MinecraftPort $config.gamePort -AdapterAddress $adapter | ConvertFrom-Json
        $snapshot.network = $network
    } catch {}
    $snapshot.metrics = $metrics
    $snapshot
}

try {
    if (!$RunMinecraft -and $env:SSH_ORIGINAL_COMMAND -ceq 'metrics') {
        Get-HostMetrics | ConvertTo-Json -Depth 8 -Compress
        return
    }
    if ($RunMinecraft) { Write-LaunchDiagnostic 'Windows inicio el lanzador de Minecraft.' }
    $mutex = $null
    for ($i = 0; $i -lt 30 -and !$mutex; $i++) {
        try { $mutex = [IO.File]::Open($lockFile,'Open','ReadWrite','None') }
        catch [IO.IOException] { Start-Sleep -Milliseconds 100 }
    }
    if (!$mutex) { throw 'Hay otra orden de alojamiento en ejecución.' }
    try {
        if ($RunMinecraft) {
            if (!(Test-Path -LiteralPath $gate) -and (Test-Path -LiteralPath $preflight)) {
                $nonce = [IO.File]::ReadAllText($preflight)
                if ($nonce -notmatch '^[a-f0-9]{32}$') { throw 'La prueba de la tarea no es valida.' }
                [IO.File]::WriteAllText((Join-Path $root 'state\preflight-response'),$nonce)
                exit 0
            }
            if (!(Test-Path -LiteralPath $gate)) { throw 'Este PC no tiene permiso para arrancar el mundo.' }
            $java = Join-Path $config.folder '.wolfmc-runtime\bin\java.exe'
            $launch = Get-Content -LiteralPath (Join-Path $config.folder '.wolfmc-launch.json') -Raw | ConvertFrom-Json
            $arguments = @($launch.args)
            $loader = '^@libraries/(net/neoforged/neoforge|net/minecraftforge/forge)/[A-Za-z0-9_.+-]+/win_args\.txt$'
            $isLoader = $arguments.Count -eq 2 -and $arguments[0] -cmatch $loader -and $arguments[1] -ceq 'nogui'
            $isJar = $arguments.Count -eq 3 -and $arguments[0] -ceq '-jar' -and
                $arguments[1] -cmatch '^[A-Za-z0-9_.+-]+\.jar$' -and $arguments[2] -ceq 'nogui'
            if ($launch.instance -ne $config.instance -or !($isLoader -or $isJar)) { throw 'Parametros de arranque invalidos.' }
            $log = Join-Path $config.folder 'logs'
            [void][IO.Directory]::CreateDirectory($log)
            $commandLine = @('@user_jvm_args.txt','-Dterminal.jline=false','-Dterminal.ansi=false') + $arguments
            $process = Start-Process -FilePath $java -WorkingDirectory $config.folder -PassThru -WindowStyle Hidden `
                -ArgumentList $commandLine `
                -RedirectStandardOutput (Join-Path $log 'wolf-launch.log') -RedirectStandardError (Join-Path $log 'wolf-launch-error.log')
            Write-LaunchDiagnostic "Proceso Java: $($process.Id)"
        } else {
            switch -Exact ($env:SSH_ORIGINAL_COMMAND) {
                'status' {}
                'disarm' { [IO.File]::Delete($gate) }
                'arm' {
                    if ((Get-ServerState).running) { throw 'Minecraft ya está activo en este equipo.' }
                    if (!(Test-Path -LiteralPath (Join-Path $config.folder '.wolfmc-launch.json'))) { throw 'Faltan los archivos de arranque verificados.' }
                    [IO.File]::WriteAllText($gate,$config.instance)
                }
                'start' {
                    if (!(Test-Path -LiteralPath $gate)) { throw 'Este PC no tiene permiso para arrancar el mundo.' }
                    if (!(Get-ServerState).running) {
                        $task = Get-WolfTask
                        if (!$task.Enabled -or !$task.Definition.Settings.AllowDemandStart) {
                            throw 'La tarea de Minecraft esta deshabilitada o no admite arranques manuales.'
                        }
                        [void]$task.Run($null)
                    }
                }
                default { throw 'Orden SSH no permitida.' }
            }
            Get-ServerState | ConvertTo-Json -Compress
        }
    } finally { $mutex.Dispose() }
    if ($RunMinecraft) {
        $process.WaitForExit()
        $process.Refresh()
        $exitCode = $process.ExitCode
        Write-LaunchDiagnostic "Java termino con codigo $exitCode."
        exit $exitCode
    }
} catch {
    if ($RunMinecraft) { try { Write-LaunchDiagnostic $_.Exception.Message } catch {} }
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
}
