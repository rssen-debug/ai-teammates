; MAJIN — Windows installer (Inno Setup 6)
;
; Built by scripts/build-installer.mjs, which puts dist\majin-win-x64.exe and
; assets\majin.ico next to this file before calling iscc. The result is
; MAJIN-Setup.exe: one file, no admin required, nothing else needed by the user
; (no Node, no git, no terminal).
;
; Deliberate choices, all of them load-bearing:
;   * AppId is a fixed GUID, so "install over the top" is an upgrade and not a
;     second entry in Add/Remove programs.
;   * PrivilegesRequired=lowest with the dialog override: it installs into
;     %LOCALAPPDATA%\Programs on a locked-down machine and into Program Files
;     when the user does elevate. It never fails just because there is no admin.
;   * Config, api keys and memory live in %LOCALAPPDATA%\MAJIN (see
;     src/core/paths.js) -- NOT under {autopf} -- so updating or uninstalling
;     never touches them, and UninstallDelete below deliberately leaves them.
;   * Autostart is an opt-in task, unchecked by default.

#define MyAppName "MAJIN"
; the build passes /DMyAppVersion=<package.json version>; keep a fallback for hand runs
#ifndef MyAppVersion
  #define MyAppVersion "4.0.0-alpha.3"
#endif
#define MyAppPublisher "rssen-debug"
#define MyAppURL "https://github.com/rssen-debug/MAJINCLI"
#define MyAppExeName "majin-win-x64.exe"

[Setup]
AppId={{B6E3D7A2-1F0B-4F4E-9A7C-5C2E9B4D8A31}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppVerName={#MyAppName} {#MyAppVersion}
AppPublisher={#MyAppPublisher}
AppPublisherURL={#MyAppURL}
AppSupportURL={#MyAppURL}/issues
DefaultDirName={autopf}\MAJIN
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
DisableWelcomePage=no
AllowNoIcons=yes
UsePreviousTasks=no
OutputDir=..\dist\installer
OutputBaseFilename=MAJIN-Setup
SetupIconFile=majin.ico
UninstallDisplayIcon={app}\majin.ico
UninstallDisplayName={#MyAppName}
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
CloseApplications=yes
RestartApplications=no
ShowLanguageDialog=no

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "Shortcuts:"
Name: "autostart"; Description: "Start MAJIN when I sign in"; GroupDescription: "Startup:"; Flags: unchecked
Name: "cmdline"; Description: "Add the {#MyAppName} command to my user PATH"; GroupDescription: "Extra:"; Flags: unchecked

[Files]
Source: "majin-win-x64.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "majin.cmd"; DestDir: "{app}"; Flags: ignoreversion
Source: "MAJIN.vbs"; DestDir: "{app}"; Flags: ignoreversion
Source: "majin.ico"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\README.md"; DestDir: "{app}"; Flags: ignoreversion skipifsourcedoesntexist
Source: "..\LICENSE"; DestDir: "{app}"; Flags: ignoreversion skipifsourcedoesntexist

[Icons]
; The window itself is opened by the program (its own app window, not a browser
; tab), so the icon only has to start it.
Name: "{group}\{#MyAppName}"; Filename: "{sys}\wscript.exe"; Parameters: """{app}\MAJIN.vbs"""; WorkingDir: "{app}"; IconFilename: "{app}\majin.ico"; Comment: "MAJIN — your own agent, no console attached"
Name: "{group}\Uninstall {#MyAppName}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{sys}\wscript.exe"; Parameters: """{app}\MAJIN.vbs"""; WorkingDir: "{app}"; IconFilename: "{app}\majin.ico"; Tasks: desktopicon

[Registry]
; Only ever the per-user PATH, and only the bin folder: no file associations, no
; Run-key write by default (autostart below owns that, and only when asked for).
Root: HKCU; Subkey: "Environment"; ValueType: expandsz; ValueName: "Path"; ValueData: "{olddata};{app}"; Check: NeedsAddPath(ExpandConstant('{app}')); Tasks: cmdline

[Registry]
; The autostart task, and only that one: no Run-key write when it is not ticked.
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: string; ValueName: "MAJIN"; ValueData: """{sys}\wscript.exe"" ""{app}\MAJIN.vbs"""; Flags: uninsdeletevalue; Tasks: autostart

[Run]
Filename: "{app}\{#MyAppExeName}"; Parameters: "start --no-window"; Description: "Start {#MyAppName} now"; WorkingDir: "{app}"; Flags: nowait postinstall runhidden skipifsilent
; runhidden on the exe itself — NO wscript in this chain (a .vbs is not a Win32
; program, that was the user's CreateProcess 193). And skipifsilent STAYS:
; CI-proven twice in the v0.5.3 runs that a silent install which starts the
; app from postinstall hangs the setup process until the job timeout kills it
; (orphan majin-win-x64 + conhost in the job log). Silent-update relaunch is
; instead the updater's own PowerShell watchdog in src/core/update.js —
; our code, our log file at %LOCALAPPDATA%\MAJIN\update-relaunch.log,
; and testable on any OS.

; Windows caches shortcut/taskbar icons aggressively — after an update the user
; can sit with the OLD logo for days (this exact stale-icon case was reported
; 2026-10-18). Bust the cache silently; skipifdoesntexist keeps it harmless
; on systems without ie4uinit (Windows 11 renames but still ships it).
Filename: "{sys}\ie4uinit.exe"; Parameters: "-ClearIconCache"; Flags: runhidden skipifdoesntexist nowait

[UninstallRun]
; Stop the running program before its files go, instead of leaving an orphan
; port and a "file in use" dialog.
Filename: "{app}\{#MyAppExeName}"; Parameters: "stop"; Flags: runhidden skipifdoesntexist; RunOnceId: "StopMajin"

[Code]
function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  R: Integer;
begin
  { The running app holds its own exe and the port: replacing files under it
    leaves the user staring at the OLD version they just "upgraded" from.
    Close it first; install continues even if nothing was running. }
  Exec('taskkill.exe', '/F /IM {#MyAppExeName}', '', SW_HIDE, ewWaitUntilTerminated, R);
  Result := '';
end;

function NeedsAddPath(Param: string): boolean;
var
  OrigPath: string;
begin
  if not RegQueryStringValue(HKEY_CURRENT_USER, 'Environment', 'Path', OrigPath) then
    OrigPath := '';
  Result := Pos(Lowercase(Param), Lowercase(OrigPath)) = 0;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  DataDir: string;
begin
  if CurUninstallStep <> usPostUninstall then Exit;
  { The program keeps its config, api keys and memory in %LOCALAPPDATA%\MAJIN.
    Deleting it silently would throw away someone's month of notes and keys, so
    the uninstaller keeps it and says exactly where it is. }
  DataDir := ExpandConstant('{localappdata}\MAJIN');
  if DirExists(DataDir) then
    Log('MAJIN data left in place: ' + DataDir);
end;
