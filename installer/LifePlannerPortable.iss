#define MyAppName "Life Planner"
#define MyAppVersion "1.0.0"
#define MyAppPublisher "Life Planner"
#define TrayLauncherName "Start Life Planner.vbs"
#define PortableSource "..\release\LifePlannerPortable"
#define InstallerAssets "assets"
#define InstalledIconName "life-planner-app.ico"

[Setup]
AppId={{72C8AF6A-1B42-4B0A-BDE1-5C8D190D8531}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
DefaultDirName={autopf}\Life Planner
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
OutputDir=..\release
OutputBaseFilename=LifePlannerPortableSetup
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
SetupIconFile={#InstallerAssets}\life-planner-setup.ico
WizardSmallImageFile={#InstallerAssets}\life-planner-wizard-small.bmp
PrivilegesRequired=lowest
ArchitecturesAllowed=x64
ArchitecturesInstallIn64BitMode=x64
Uninstallable=yes
UninstallDisplayIcon={app}\{#InstalledIconName}

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Files]
Source: "{#PortableSource}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs; Excludes: "app\data\*,app\.env,app\*.sqlite,app\*.sqlite3,app\*.db,app\*.gguf,app\*.safetensors,app\*.onnx,app\*.log"

; Vite emits content-hashed filenames. Clear old generated assets *before*
; Inno copies the new payload; [InstallDelete] executes too late and would
; otherwise remove the freshly copied bundles as well.
[Code]
procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssInstall then
    DelTree(ExpandConstant('{app}\app\dist\assets'), True, True, True);
end;

[Icons]
Name: "{group}\Life Planner"; Filename: "{sys}\wscript.exe"; Parameters: """{app}\{#TrayLauncherName}"""; WorkingDir: "{app}"; IconFilename: "{app}\{#InstalledIconName}"
Name: "{userdesktop}\Life Planner"; Filename: "{sys}\wscript.exe"; Parameters: """{app}\{#TrayLauncherName}"""; WorkingDir: "{app}"; IconFilename: "{app}\{#InstalledIconName}"; Tasks: desktopicon

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; GroupDescription: "Additional icons:"; Flags: unchecked

; Optional runtime downloads (llama.cpp model runtime, Playwright Chromium) are
; deliberately NOT executed here. Running network-downloading helper scripts
; during setup — especially elevated, when the user chose "Run as administrator"
; — triggers Microsoft Defender / SmartScreen reputation prompts for unsigned
; downloaded binaries. The scripts ship in the payload ({app}\Install *.cmd) and
; the app installs these optional components on demand from Tooling / Settings,
; under the user's normal token with clear opt-in and progress.
[Run]
; runasoriginaluser ensures the app launches under the standard user token even
; when the installer itself was run elevated, so the app never runs elevated.
Filename: "{sys}\wscript.exe"; Parameters: """{app}\{#TrayLauncherName}"""; Description: "Launch Life Planner"; Flags: postinstall nowait skipifsilent runasoriginaluser
