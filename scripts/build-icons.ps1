param([string]$Source = (Join-Path $PSScriptRoot '../assets/app-icon.png'))
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Drawing
$projectRoot=Split-Path -Parent $PSScriptRoot
$sourceImage=[System.Drawing.Image]::FromFile((Resolve-Path -LiteralPath $Source).Path)
$sizes=@(16,24,32,48,64,128,256)
$frames=[System.Collections.Generic.List[byte[]]]::new()
try {
 foreach($size in $sizes){
  $bitmap=[System.Drawing.Bitmap]::new($size,$size,[System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $graphics=[System.Drawing.Graphics]::FromImage($bitmap)
  $stream=[System.IO.MemoryStream]::new()
  try {
   $graphics.Clear([System.Drawing.Color]::Transparent)
   $graphics.InterpolationMode=[System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
   $graphics.CompositingQuality=[System.Drawing.Drawing2D.CompositingQuality]::HighQuality
   $graphics.PixelOffsetMode=[System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
   $graphics.DrawImage($sourceImage,0,0,$size,$size)
   $bitmap.Save($stream,[System.Drawing.Imaging.ImageFormat]::Png)
   $frames.Add($stream.ToArray())
  } finally {$graphics.Dispose();$bitmap.Dispose();$stream.Dispose()}
 }
 $iconPath=Join-Path $projectRoot 'assets/app-icon.ico'
 $output=[System.IO.File]::Create($iconPath);$writer=[System.IO.BinaryWriter]::new($output)
 try {
  $writer.Write([uint16]0);$writer.Write([uint16]1);$writer.Write([uint16]$sizes.Count)
  $offset=6+16*$sizes.Count
  for($i=0;$i -lt $sizes.Count;$i++){
   $dimension=if($sizes[$i] -eq 256){0}else{$sizes[$i]}
   $writer.Write([byte]$dimension);$writer.Write([byte]$dimension);$writer.Write([byte]0);$writer.Write([byte]0)
   $writer.Write([uint16]1);$writer.Write([uint16]32);$writer.Write([uint32]$frames[$i].Length);$writer.Write([uint32]$offset)
   $offset+=$frames[$i].Length
  }
  foreach($frame in $frames){$writer.Write([byte[]]$frame)}
 } finally {$writer.Dispose();$output.Dispose()}
 [System.IO.File]::WriteAllBytes((Join-Path $projectRoot 'src/panel/public/logo.png'),$frames[$frames.Count-1])
} finally {$sourceImage.Dispose()}
