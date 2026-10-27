# Checks that EFI programs carry an Authenticode signature by the given certificate: once with
# nvstraps-external-tool (structure, image digest, signer) and once with Windows, which also checks
# the RSA signature. Pull requests run it on a throwaway key, the Release workflow on the project key.
param(
  [Parameter(Mandatory)] [string] $Certificate,
  [Parameter(Mandatory)] [string[]] $Images,
  [string] $Tool = 'target/release/external/nvstraps-external-tool.exe'
)
$ErrorActionPreference = 'Stop'
$expected = [System.Security.Cryptography.X509Certificates.X509Certificate2]::new((Resolve-Path -LiteralPath $Certificate).Path)
foreach ($image in $Images) {
  & $Tool check-signed $image $Certificate
  if ($LASTEXITCODE -ne 0) { throw "${image} is not signed with ${Certificate}" }
  # A self-signed root is not trusted on the runner, so Windows reports UnknownError or NotTrusted
  # for a good signature; a changed image or signature gives HashMismatch or NotSigned.
  $signature = Get-AuthenticodeSignature -LiteralPath $image
  if ($signature.Status -notin 'Valid', 'UnknownError', 'NotTrusted' -or $signature.SignerCertificate.Thumbprint -ne $expected.Thumbprint) {
    throw "${image}: Windows reports $($signature.Status) ($($signature.StatusMessage)), signer $($signature.SignerCertificate.Thumbprint)"
  }
  "${image}: signed by $($expected.Subject); Windows reports $($signature.Status)"
}
