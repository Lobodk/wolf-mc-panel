#define ProductVersion "1.1.1"
[Setup]
AppId={{B1E3D826-BCC8-42C1-9982-E455A9F90974}
AppName=Wolf MC Panel
AppVersion={#ProductVersion}
AppPublisher=Lobodk
AppPublisherURL=https://github.com/Lobodk
DefaultDirName={localappdata}\Programs\WolfMCPanel
DefaultGroupName=Wolf MC Panel
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0
LicenseFile=..\LICENSE
InfoBeforeFile=..\docs\TEST-BUILD-NOTICE.txt
OutputDir=..\dist
OutputBaseFilename=WolfMCPanel-Setup-{#ProductVersion}-windows-x64
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
SetupIconFile=..\assets\app-icon.ico
DisableProgramGroupPage=yes
UninstallDisplayIcon={app}\WolfMCPanel.exe
CloseApplications=no
RestartApplications=no
[Languages]
Name: "spanish"; MessagesFile: "compiler:Languages\Spanish.isl"
Name: "english"; MessagesFile: "compiler:Default.isl"
Name: "german"; MessagesFile: "compiler:Languages\German.isl"
Name: "french"; MessagesFile: "compiler:Languages\French.isl"
Name: "turkish"; MessagesFile: "compiler:Languages\Turkish.isl"
Name: "brazilianportuguese"; MessagesFile: "compiler:Languages\BrazilianPortuguese.isl"
[Tasks]
Name: "desktopicon"; Description: "Crear un acceso directo en el escritorio"; Flags: unchecked
[InstallDelete]
; Remove only the obsolete program launcher when updating an early test build.
Type: files; Name: "{app}\LoboServerPanel.exe"
[Files]
Source: "..\build\WolfMCPanel.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\runtime\node.exe"; DestDir: "{app}\runtime"; Flags: ignoreversion
Source: "..\runtime\LICENSE.node.txt"; DestDir: "{app}\runtime"; Flags: ignoreversion
Source: "..\runtime\caddy.exe"; DestDir: "{app}\runtime"; Flags: ignoreversion
Source: "..\runtime\LICENSE.caddy.txt"; DestDir: "{app}\runtime"; Flags: ignoreversion
Source: "..\src\*"; DestDir: "{app}\src"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "..\docs\*"; DestDir: "{app}\docs"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "..\assets\*"; DestDir: "{app}\assets"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "..\scripts\*"; DestDir: "{app}\scripts"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "..\installer\*"; DestDir: "{app}\installer"; Flags: ignoreversion
Source: "..\tests\*"; DestDir: "{app}\tests"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "..\LICENSE"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\README.md"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\package.json"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\THIRD-PARTY-NOTICES.md"; DestDir: "{app}"; Flags: ignoreversion
[Icons]
Name: "{group}\Wolf MC Panel"; Filename: "{app}\WolfMCPanel.exe"
Name: "{group}\Detener panel"; Filename: "{app}\WolfMCPanel.exe"; Parameters: "--stop"
Name: "{group}\Recuperar acceso local"; Filename: "{app}\WolfMCPanel.exe"; Parameters: "--local"
Name: "{group}\Restablecer contraseña"; Filename: "{app}\WolfMCPanel.exe"; Parameters: "--reset-password"
Name: "{group}\Desinstalar"; Filename: "{uninstallexe}"
Name: "{userdesktop}\Wolf MC Panel"; Filename: "{app}\WolfMCPanel.exe"; Tasks: desktopicon
[Run]
Filename: "{app}\WolfMCPanel.exe"; Description: "Abrir Wolf MC Panel"; Flags: nowait postinstall skipifsilent
; User data is deliberately outside {app}. No UninstallDelete entry removes it.
