#define MyAppName "Life Planner"
#define MyAppVersion "1.0.1"
#define MyAppPublisher "Life Planner"
#define MyAppExeName "Start Life Planner.cmd"
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
Source: "{#PortableSource}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs; Excludes: "app\data\*,app\.env*,app\*.sqlite,app\*.sqlite3,app\*.db,app\*.gguf,app\*.safetensors,app\*.onnx,app\*.log"
Source: "{#InstallerAssets}\{#InstalledIconName}"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{group}\Life Planner"; Filename: "{app}\{#MyAppExeName}"; WorkingDir: "{app}"; IconFilename: "{app}\{#InstalledIconName}"
Name: "{userdesktop}\Life Planner"; Filename: "{app}\{#MyAppExeName}"; WorkingDir: "{app}"; IconFilename: "{app}\{#InstalledIconName}"; Tasks: desktopicon

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; GroupDescription: "Additional icons:"; Flags: unchecked

[Run]
Filename: "{sys}\cmd.exe"; Parameters: "/c """"{app}\Install Playwright Chromium.cmd"""""; Flags: runhidden waituntilterminated
Filename: "{app}\{#MyAppExeName}"; Description: "Launch Life Planner"; Flags: postinstall nowait skipifsilent
