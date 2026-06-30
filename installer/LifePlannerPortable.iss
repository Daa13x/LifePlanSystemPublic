#define MyAppName "Life Planner"
#define MyAppVersion "0.1.0"
#define MyAppPublisher "Life Planner"
#define MyAppExeName "Start Life Planner.cmd"
#define PortableSource "..\release\LifePlannerPortable"

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
PrivilegesRequired=lowest
ArchitecturesAllowed=x64
ArchitecturesInstallIn64BitMode=x64
Uninstallable=yes

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Files]
Source: "{#PortableSource}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs; Excludes: "app\data\*,app\.env,app\*.sqlite,app\*.sqlite3,app\*.db,app\*.gguf,app\*.safetensors,app\*.onnx,app\*.log"

[Icons]
Name: "{group}\Life Planner"; Filename: "{app}\{#MyAppExeName}"; WorkingDir: "{app}"
Name: "{userdesktop}\Life Planner"; Filename: "{app}\{#MyAppExeName}"; WorkingDir: "{app}"; Tasks: desktopicon

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; GroupDescription: "Additional icons:"; Flags: unchecked

[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "Launch Life Planner"; Flags: postinstall nowait skipifsilent
