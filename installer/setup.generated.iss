; TubeVault Windows Installer (Inno Setup 6)
; Per-user install into %LocalAppData%\TubeVault (no Administrator UAC prompt required)

#define MyAppName "TubeVault"
#define MyAppVersion "1.0.0"
#define MyAppPublisher "TubeVault"
#define MyNativeHostName "com.tubevault.host"

[Setup]
AppId={{8D6B514E-6D2C-4E19-9F93-95AF497F41BA}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
DefaultDirName={localappdata}\{#MyAppName}
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir=output
OutputBaseFilename=TubeVault-Setup-{#MyAppVersion}
SetupIconFile=assets\tubevault.ico
UninstallDisplayIcon={app}\app\TubeVault.exe
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
CloseApplications=yes

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "Create a Desktop shortcut for TubeVault Web UI"; GroupDescription: "Additional icons:"; Flags: unchecked

[Files]
Source: "staging\runtime\*"; DestDir: "{app}\runtime"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "staging\app\*"; DestDir: "{app}\app"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "staging\extension\*"; DestDir: "{app}\extension"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "staging\install-guide.html"; DestDir: "{app}"; Flags: ignoreversion

[Registry]
; Register Chrome Native Messaging Host under HKCU (no admin required)
Root: HKCU; Subkey: "Software\Google\Chrome\NativeMessagingHosts\{#MyNativeHostName}"; ValueType: string; ValueName: ""; ValueData: "{app}\native-host\{#MyNativeHostName}.json"; Flags: uninsdeletekey

[Icons]
Name: "{autoprograms}\{#MyAppName}"; Filename: "{app}\app\TubeVault.exe"; Parameters: "--open-ui"
Name: "{autoprograms}\{#MyAppName} Extension Guide"; Filename: "{app}\install-guide.html"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\app\TubeVault.exe"; Parameters: "--open-ui"; Tasks: desktopicon

[Run]
Filename: "{app}\app\TubeVault.exe"; Parameters: "--open-ui"; Description: "Launch TubeVault System Tray & Web UI (auto-downloads yt-dlp & FFmpeg on first run)"; Flags: nowait postinstall skipifsilent
Filename: "{app}\install-guide.html"; Description: "Open 3-step Chrome Extension install guide"; Flags: shellexec nowait postinstall skipifsilent

[Code]
const
  FIXED_EXT_ID = 'dgppknmlkjmepepmnohngnjelgfiblml';

procedure CurStepChanged(CurStep: TSetupStep);
var
  NativeDir, ManifestPath, HostExeEscaped, ManifestJson: String;
  GuidePath, GuideHtml: String;
  GuideHtmlUtf8: AnsiString;
begin
  if CurStep = ssPostInstall then
  begin
    { Generate Chrome Native Messaging host manifest (UTF-8) pointing to installed ytdl-host.exe }
    NativeDir := ExpandConstant('{app}\native-host');
    ForceDirectories(NativeDir);
    ManifestPath := NativeDir + '\{#MyNativeHostName}.json';
    HostExeEscaped := ExpandConstant('{app}\app\ytdl-host.exe');
    StringChangeEx(HostExeEscaped, '\', '\\', True);

    ManifestJson :=
      '{' + #13#10 +
      '  "name": "{#MyNativeHostName}",' + #13#10 +
      '  "description": "TubeVault Local Companion Native Host",' + #13#10 +
      '  "path": "' + HostExeEscaped + '",' + #13#10 +
      '  "type": "stdio",' + #13#10 +
      '  "allowed_origins": [' + #13#10 +
      '    "chrome-extension://' + FIXED_EXT_ID + '/"' + #13#10 +
      '  ]' + #13#10 +
      '}' + #13#10;
    SaveStringToFile(ManifestPath, Utf8Encode(ManifestJson), False);

    { Inject exact installed extension path into install-guide.html while preserving UTF-8 Vietnamese text }
    GuidePath := ExpandConstant('{app}\install-guide.html');
    if LoadStringFromFile(GuidePath, GuideHtmlUtf8) then
    begin
      GuideHtml := Utf8Decode(GuideHtmlUtf8);
      StringChangeEx(GuideHtml, '__EXTENSION_DIR__', ExpandConstant('{app}\extension'), True);
      StringChangeEx(GuideHtml, '__EXTENSION_ID__', FIXED_EXT_ID, True);
      SaveStringToFile(GuidePath, Utf8Encode(GuideHtml), False);
    end;
  end;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  ResultCode: Integer;
begin
  if CurUninstallStep = usUninstall then
  begin
    { Cleanly stop TrayApp and background node.exe running engine.cjs from this install directory }
    Exec('powershell.exe',
      '-NoProfile -WindowStyle Hidden -Command "Get-Process -Name TubeVault -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue; Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like ''*TubeVault*engine.cjs*'' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"',
      '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  end;
end;

