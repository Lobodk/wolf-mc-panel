param([Parameter(Mandatory=$true)][ValidateSet('Create','List','Extract')][string]$Action,[Parameter(Mandatory=$true)][string]$Archive,[string]$SourceRoot,[string]$EntriesJson)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName System.IO.Compression,System.IO.Compression.FileSystem
if(-not ('WolfBackupZip' -as [type])){Add-Type -Path (Join-Path $PSScriptRoot 'tools/BackupZip.cs') -ReferencedAssemblies System.IO.Compression,System.IO.Compression.FileSystem}
switch($Action){
 'Create' {[WolfBackupZip]::Create($Archive,$SourceRoot,[string[]]($EntriesJson | ConvertFrom-Json))}
 'List' {ConvertTo-Json -InputObject @([WolfBackupZip]::List($Archive)) -Compress}
 'Extract' {[WolfBackupZip]::Extract($Archive,$SourceRoot)}
}
