[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$target = 'x86_64-pc-windows-msvc'

& cargo +nightly miri setup --target $target
if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
}

& cargo +nightly miri test `
    --package nvstraps-core `
    --package nvstraps-uefi `
    --lib `
    --target $target
exit $LASTEXITCODE
