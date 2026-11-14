$ErrorActionPreference='Stop'
$projectRoot=Split-Path -Parent $PSScriptRoot
$cache=Join-Path $projectRoot 'build/caddy'
New-Item -ItemType Directory -Force -Path $cache,(Join-Path $projectRoot 'runtime') | Out-Null
$archive=Join-Path $cache 'caddy_2.11.9_windows_amd64.zip'
$expected='ad93112d335ee687100c4c9f11bced16ca590377976b7fe7883882b9e797e472'
if(!(Test-Path -LiteralPath $archive)){
 Invoke-WebRequest -Uri 'https://github.com/caddyserver/caddy/releases/download/v2.11.9/caddy_2.11.9_windows_amd64.zip' -OutFile $archive
}
if((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLower() -ne $expected){throw 'La descarga de Caddy no supera la comprobación de integridad.'}
Expand-Archive -LiteralPath $archive -DestinationPath (Join-Path $cache 'unpacked') -Force
Copy-Item -LiteralPath (Join-Path $cache 'unpacked/caddy.exe') -Destination (Join-Path $projectRoot 'runtime/caddy.exe')
Copy-Item -LiteralPath (Join-Path $cache 'unpacked/LICENSE') -Destination (Join-Path $projectRoot 'runtime/LICENSE.caddy.txt')
