param([Parameter(Mandatory=$true)][string]$Iscc,[Parameter(Mandatory=$true)][string]$NodeDirectory,[string]$JavaHome=$env:JAVA_HOME)
$ErrorActionPreference='Stop'
$projectRoot=Split-Path -Parent $PSScriptRoot
$compiler=(Resolve-Path -LiteralPath $Iscc).Path
$nodeSource=(Resolve-Path -LiteralPath $NodeDirectory).Path
New-Item -ItemType Directory -Force -Path (Join-Path $projectRoot 'runtime'),(Join-Path $projectRoot 'build') | Out-Null
$runtimeTarget=Join-Path $projectRoot 'runtime/node.exe'
$runtimeSource=Join-Path $nodeSource 'node.exe'
if(!(Test-Path -LiteralPath $runtimeTarget) -or (Get-FileHash -LiteralPath $runtimeTarget -Algorithm SHA256).Hash -ne (Get-FileHash -LiteralPath $runtimeSource -Algorithm SHA256).Hash){
 Copy-Item -LiteralPath $runtimeSource -Destination $runtimeTarget
}
Copy-Item -LiteralPath (Join-Path $nodeSource 'LICENSE') -Destination (Join-Path $projectRoot 'runtime/LICENSE.node.txt')
$node=Join-Path $projectRoot 'runtime/node.exe'
Push-Location $projectRoot
try {
 & (Join-Path $PSScriptRoot 'build-icons.ps1')
 & (Join-Path $PSScriptRoot 'build-registry-agent.ps1') -JavaHome $JavaHome
 & (Join-Path $PSScriptRoot 'fetch-caddy.ps1')
 & $node scripts/check-release.cjs
 if($LASTEXITCODE -ne 0){throw 'La comprobación de distribución falló.'}
 & $node --test tests/*.test.cjs
 if($LASTEXITCODE -ne 0){throw 'Las pruebas fallaron.'}
 $csc=Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
 & $csc /nologo /target:winexe /reference:System.Windows.Forms.dll (('/win32icon:')+(Join-Path $projectRoot 'assets/app-icon.ico')) (('/out:')+(Join-Path $projectRoot 'build/LoboServerPanel.exe')) (Join-Path $projectRoot 'installer/Launcher.cs')
 if($LASTEXITCODE -ne 0){throw 'No se pudo compilar el lanzador.'}
 & $compiler (Join-Path $projectRoot 'installer/windows.iss')
 if($LASTEXITCODE -ne 0){throw 'No se pudo compilar el instalador.'}
 Get-ChildItem -LiteralPath (Join-Path $projectRoot 'dist') -Filter '*.exe' | ForEach-Object {Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256} | ForEach-Object {$_.Hash.ToLower()+'  '+(Split-Path -Leaf $_.Path)} | Set-Content -LiteralPath (Join-Path $projectRoot 'dist/SHA256SUMS.txt') -Encoding ascii
} finally {Pop-Location}
