param([Parameter(Mandatory=$true)][string]$JwkFile,[Parameter(Mandatory=$true)][string]$CertificateFile)
$ErrorActionPreference='Stop'
$jwk=Get-Content -LiteralPath $JwkFile -Raw | ConvertFrom-Json
function Decode-UrlBase64([string]$Value){$normalized=$Value.Replace('-','+').Replace('_','/');$normalized=$normalized.PadRight($normalized.Length+((4-$normalized.Length%4)%4),'=');return [Convert]::FromBase64String($normalized)}
$parameters=[System.Security.Cryptography.RSAParameters]::new()
$parameters.Modulus=Decode-UrlBase64 $jwk.n
$parameters.Exponent=Decode-UrlBase64 $jwk.e
$parameters.D=Decode-UrlBase64 $jwk.d
$parameters.P=Decode-UrlBase64 $jwk.p
$parameters.Q=Decode-UrlBase64 $jwk.q
$parameters.DP=Decode-UrlBase64 $jwk.dp
$parameters.DQ=Decode-UrlBase64 $jwk.dq
$parameters.InverseQ=Decode-UrlBase64 $jwk.qi
$rsa=[System.Security.Cryptography.RSA]::Create()
try{
 $rsa.ImportParameters($parameters)
 $request=[System.Security.Cryptography.X509Certificates.CertificateRequest]::new('CN=panel.wolf.test',$rsa,[System.Security.Cryptography.HashAlgorithmName]::SHA256,[System.Security.Cryptography.RSASignaturePadding]::Pkcs1)
 $san=[System.Security.Cryptography.X509Certificates.SubjectAlternativeNameBuilder]::new()
 $san.AddDnsName('panel.wolf.test');$san.AddIpAddress([System.Net.IPAddress]::Parse('127.0.0.1'))
 $request.CertificateExtensions.Add($san.Build())
 $request.CertificateExtensions.Add([System.Security.Cryptography.X509Certificates.X509BasicConstraintsExtension]::new($true,$false,0,$true))
 $certificate=$request.CreateSelfSigned([DateTimeOffset]::UtcNow.AddMinutes(-1),[DateTimeOffset]::UtcNow.AddDays(1))
 try{[System.IO.File]::WriteAllBytes($CertificateFile,$certificate.Export([System.Security.Cryptography.X509Certificates.X509ContentType]::Cert))}finally{$certificate.Dispose()}
}finally{$rsa.Dispose()}
