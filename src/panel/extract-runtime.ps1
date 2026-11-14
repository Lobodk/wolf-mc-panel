param([Parameter(Mandatory=$true)][string]$Archive,[Parameter(Mandatory=$true)][string]$Destination)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$target=[System.IO.Path]::GetFullPath($Destination).TrimEnd('\')+'\'
$zip=[System.IO.Compression.ZipFile]::OpenRead($Archive)
try {
  [long]$size=0
  foreach($entry in $zip.Entries){
    $resolved=[System.IO.Path]::GetFullPath((Join-Path $target $entry.FullName))
    if(-not $resolved.StartsWith($target,[StringComparison]::OrdinalIgnoreCase)){throw 'Ruta fuera del destino en ZIP'}
    $size+=$entry.Length
    if($size -gt 2147483648){throw 'Runtime demasiado grande'}
    if(($entry.ExternalAttributes -band 0xF0000000) -eq 0xA0000000){throw 'Enlaces no permitidos en runtime'}
  }
} finally {$zip.Dispose()}
[System.IO.Compression.ZipFile]::ExtractToDirectory($Archive,$Destination)
