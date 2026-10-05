; Inno Setup 7 script for the Windows installer. The portable ZIP stays the primary release;
; this installs the same two files side by side, because the app resolves NvStrapsReBar.ffs
; from its own directory.
;
;   iscc /DAppVersion=0.1.0 installer\NvStrapsReBar.iss
;
; AppVersion defaults to the Tauri version; SourceDir defaults to target\release.

#ifndef AppVersion
  #define AppVersion "0.1.0"
#endif
#ifndef SourceDir
  #define SourceDir "..\target\release"
#endif
#ifndef OutputDir
  #define OutputDir "..\target\installer"
#endif

#define AppName "NvStrapsReBar"
#define AppExe "NvStrapsReBar.exe"

[Setup]
AppId={{6F1C7B52-3E4D-4B8A-9C61-2D5E8A0F4B17}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher=115dkk
AppPublisherURL=https://github.com/115dkk/nvstrapsrebar-tauri
DefaultDirName={autopf}\{#AppName}
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
LicenseFile=..\LICENSE
SetupIconFile=..\src-tauri\icons\icon.ico
UninstallDisplayIcon={app}\{#AppExe}
OutputDir={#OutputDir}
OutputBaseFilename=NvStrapsReBar-windows-x64-setup
SetupArchitecture=x64
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
PrivilegesRequired=admin
PrivilegesRequiredOverridesAllowed=commandline
Compression=lzma2
SolidCompression=yes
WizardStyle=modern

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"
Name: "korean"; MessagesFile: "compiler:Languages\Korean.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"

[Files]
Source: "{#SourceDir}\{#AppExe}"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#SourceDir}\NvStrapsReBar.ffs"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\LICENSE"; DestDir: "{app}"; DestName: "LICENSE.txt"; Flags: ignoreversion
Source: "..\THIRD_PARTY_NOTICES.md"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{autoprograms}\{#AppName}"; Filename: "{app}\{#AppExe}"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\{#AppExe}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#AppExe}"; Description: "{cm:LaunchProgram,{#AppName}}"; Flags: nowait postinstall skipifsilent runasoriginaluser
