param([string]$JavaHome=$env:JAVA_HOME)
$ErrorActionPreference='Stop'
$projectRoot=Split-Path -Parent $PSScriptRoot
if($JavaHome){$javac=Join-Path $JavaHome 'bin/javac.exe';$jar=Join-Path $JavaHome 'bin/jar.exe'}
else{$javac=(Get-Command javac.exe -ErrorAction Stop).Source;$jar=(Get-Command jar.exe -ErrorAction Stop).Source}
$classes=Join-Path $projectRoot 'build/registry-agent'
New-Item -ItemType Directory -Force -Path $classes | Out-Null
& $javac --release 17 -encoding UTF-8 -d $classes (Join-Path $projectRoot 'src/panel/tools/RegistryAgent.java')
if($LASTEXITCODE -ne 0){throw 'No se pudo compilar el puente de objetos.'}
$manifest=Join-Path $projectRoot 'build/registry-agent.mf'
[IO.File]::WriteAllText($manifest,"Manifest-Version: 1.0`nPremain-Class: RegistryAgent`n`n",[Text.Encoding]::ASCII)
& $jar --create --date=2026-01-01T00:00:00Z --file (Join-Path $projectRoot 'src/panel/tools/registry-agent.jar') --manifest $manifest -C $classes .
if($LASTEXITCODE -ne 0){throw 'No se pudo empaquetar el puente de objetos.'}
