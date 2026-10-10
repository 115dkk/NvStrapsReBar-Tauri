[CmdletBinding()]
param()

# Installs the pinned Inno Setup 7 on a CI runner and builds the installer from the release build
# in target/release, with the version from src-tauri/tauri.conf.json. Pull request validation and
# the release run the same steps, so the pinned hash lives here once.

$ErrorActionPreference = 'Stop'
$temp = $env:RUNNER_TEMP ?? [System.IO.Path]::GetTempPath()

$installer = Join-Path $temp 'innosetup-7.1.0-x64.exe'
Invoke-WebRequest https://github.com/jrsoftware/issrc/releases/download/is-7_1_0/innosetup-7.1.0-x64.exe -OutFile $installer
if ((Get-FileHash $installer -Algorithm SHA256).Hash -ne '0362A383ED217D4C4239B5933866DD96D3EB2102737DA92F80F6057A4B40DF2F') { throw 'Inno Setup installer hash mismatch' }
$innoSetup = Join-Path $temp 'InnoSetup7'
Start-Process $installer -ArgumentList '/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/SP-', '/CURRENTUSER', "/DIR=$innoSetup" -Wait
$iscc = Join-Path $innoSetup 'ISCC.exe'
if (-not (Test-Path $iscc)) { throw 'ISCC.exe was not installed' }

$version = (Get-Content src-tauri/tauri.conf.json -Raw | ConvertFrom-Json).version
& $iscc /Qp "/DAppVersion=$version" "/DOutputDir=..\target\release" installer/NvStrapsReBar.iss
if ($LASTEXITCODE -ne 0) { throw "ISCC failed with $LASTEXITCODE" }
