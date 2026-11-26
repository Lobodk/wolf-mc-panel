param(
    [Parameter(Mandatory=$true)][string]$DataDirectory,
    [switch]$ImportSecret,
    [switch]$Connect
)
$ErrorActionPreference = 'Stop'
$peerFile = Join-Path $DataDirectory $(if ($ImportSecret) {'pairing.json'} else {'peer.json'})
$credentialFile = Join-Path $DataDirectory 'smb-credential.xml'
$peer = Get-Content -LiteralPath $peerFile -Raw | ConvertFrom-Json
if ($peer.instance -notmatch '^[a-f0-9-]{36}$' -or $peer.host -notmatch '^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.)[\d.]+$' -or
    $peer.share -cne 'WolfMCReplica$' -or $peer.computer -notmatch '^[a-zA-Z0-9-]{1,15}$') {
    throw 'La vinculacion SMB no es valida.'
}
$unc = "\\$($peer.host)\$($peer.share)"
$user = "$($peer.computer)\wolfmc_host"
if ($ImportSecret) {
    $secret = [Console]::In.ReadToEnd()
    if ($secret -cnotmatch '^Wm9-[A-Za-z0-9+/]{32}$') { throw 'Credencial SMB no valida.' }
    $protected = [Security.SecureString]::new()
    foreach ($character in $secret.ToCharArray()) { $protected.AppendChar($character) }
    $protected.MakeReadOnly()
    $secret = $null
    $credential = [System.Management.Automation.PSCredential]::new($user,$protected)
} elseif ($Connect) {
    $credential = Import-Clixml -LiteralPath $credentialFile
    if ($credential.UserName -ne $user) { throw 'La credencial SMB guardada no corresponde al equipo.' }
} else {
    throw 'No se selecciono un modo SMB.'
}
$options = @{RemotePath=$unc;Persistent=$false;ErrorAction='Stop'}
$parameters = (Get-Command New-SmbMapping).Parameters
if ($parameters.ContainsKey('RequirePrivacy')) { $options.RequirePrivacy = $true }
if (!(Get-SmbMapping -RemotePath $unc -ErrorAction SilentlyContinue | Where-Object Status -eq 'OK')) {
    try {
        if ($parameters.ContainsKey('Credential')) { $options.Credential = $credential }
        else { $options.UserName = $user; $options.Password = $credential.GetNetworkCredential().Password }
        New-SmbMapping @options | Out-Null
    } finally { $options.Clear() }
}
$marker = Get-Content -LiteralPath (Join-Path $unc '.wolfmc-native.json') -Raw | ConvertFrom-Json
if ($marker.instance -ne $peer.instance -or $marker.computer -ne $peer.computer) {
    throw 'La ruta SMB no coincide con el servidor.'
}
if ($ImportSecret) {
    $credential | Export-Clixml -LiteralPath ($credentialFile+'.tmp')
    Move-Item -LiteralPath ($credentialFile+'.tmp') -Destination $credentialFile -Force
}
