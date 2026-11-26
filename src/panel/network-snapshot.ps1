param([int]$MinecraftPort = 25565, [string]$AdapterAddress = '')
$ErrorActionPreference = 'Stop'
function Get-PingSample([string]$Address) {
    $probe = [System.Net.NetworkInformation.Ping]::new()
    try {
        $reply = $probe.Send($Address, 800)
        return @{ target=$Address; success=($reply.Status -eq 'Success'); status=$reply.Status.ToString(); ms=$(if ($reply.Status -eq 'Success') { [double]$reply.RoundtripTime } else { $null }) }
    } catch { return @{ target=$Address; success=$false; status='Unavailable'; ms=$null } }
    finally { $probe.Dispose() }
}
$interfaces = @([System.Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces() | Where-Object {
    $_.OperationalStatus -eq 'Up' -and $_.NetworkInterfaceType -ne 'Loopback' -and
    @($_.GetIPProperties().GatewayAddresses | Where-Object { $_.Address.AddressFamily -eq 'InterNetwork' -and $_.Address.ToString() -ne '0.0.0.0' }).Count -gt 0
})
$nic = if ($AdapterAddress) {
    $interfaces | Where-Object { @($_.GetIPProperties().UnicastAddresses | ForEach-Object {$_.Address.ToString()}) -contains $AdapterAddress } | Select-Object -First 1
} else {
    $interfaces | Sort-Object Speed -Descending | Select-Object -First 1
}
$global = [System.Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties()
$tcp = $global.GetTcpIPv4Statistics()
$connections = @($global.GetActiveTcpConnections() | Where-Object { $_.LocalEndPoint.Port -eq $MinecraftPort -and $_.State -eq 'Established' }).Count
$listening = @($global.GetActiveTcpListeners() | Where-Object Port -eq $MinecraftPort).Count -gt 0
if (-not $nic) {
    [pscustomobject]@{ sampledAt=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); available=$false; reason='No se detecta un adaptador activo con puerta de enlace IPv4.'; gameConnections=$connections; gameListening=$listening } | ConvertTo-Json -Compress
    exit 0
}
$properties = $nic.GetIPProperties()
$gateway = ($properties.GatewayAddresses | Where-Object { $_.Address.AddressFamily -eq 'InterNetwork' -and $_.Address.ToString() -ne '0.0.0.0' } | Select-Object -First 1).Address.ToString()
$ipv4 = @($properties.UnicastAddresses | Where-Object { $_.Address.AddressFamily -eq 'InterNetwork' } | ForEach-Object {$_.Address.ToString()})
$stats = $nic.GetIPv4Statistics()
[pscustomobject]@{
    sampledAt=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    available=$true
    adapter=@{ id=$nic.Id; name=$nic.Name; type=$nic.NetworkInterfaceType.ToString(); addresses=$ipv4; gateway=$gateway; linkBitsPerSecond=[double]$nic.Speed }
    counters=@{ receivedBytes=[double]$stats.BytesReceived; sentBytes=[double]$stats.BytesSent; receivedPackets=[double]($stats.UnicastPacketsReceived+$stats.NonUnicastPacketsReceived); sentPackets=[double]($stats.UnicastPacketsSent+$stats.NonUnicastPacketsSent); receiveErrors=[double]$stats.IncomingPacketsWithErrors; sendErrors=[double]$stats.OutgoingPacketsWithErrors; receiveDiscards=[double]$stats.IncomingPacketsDiscarded; sendDiscards=[double]$stats.OutgoingPacketsDiscarded; tcpRetransmitted=[double]$tcp.SegmentsResent }
    gameConnections=$connections
    gameListening=$listening
    gatewayProbe=(Get-PingSample $gateway)
    internetProbe=(Get-PingSample '1.1.1.1')
} | ConvertTo-Json -Depth 5 -Compress
