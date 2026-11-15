$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Windows.Forms
$answer=[System.Windows.Forms.MessageBox]::Show('Se cerrará el panel y se generará una clave temporal nueva. Minecraft seguirá encendido. Se conservará una copia de los datos de acceso y el panel quedará limitado a este PC. ¿Quieres continuar?','Wolf MC Panel · Recuperación local',[System.Windows.Forms.MessageBoxButtons]::YesNo,[System.Windows.Forms.MessageBoxIcon]::Warning,[System.Windows.Forms.MessageBoxDefaultButton]::Button2)
if($answer -ne [System.Windows.Forms.DialogResult]::Yes){exit}
$root=Split-Path -Parent $PSScriptRoot
$node=Join-Path $root 'runtime/node.exe'
if(!(Test-Path -LiteralPath $node)){$node=(Get-Command node -ErrorAction Stop).Source}
& $node (Join-Path $root 'src/desktop.cjs') --reset-password --confirm-local-reset
if($LASTEXITCODE -ne 0){[System.Windows.Forms.MessageBox]::Show('No se pudo completar la recuperación. Revisa errors.log en la carpeta de datos. La operación se detiene si hay tareas activas.','Wolf MC Panel')|Out-Null}
