param(
  [string]$NodeVersion = "24.15.0",
  [string]$Configuration = "Release",
  [switch]$SkipDependencyInstall,
  [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$releaseRoot = Join-Path $repoRoot "release"
$portableRoot = Join-Path $releaseRoot "LifePlannerPortable"
$appRoot = Join-Path $portableRoot "app"
$nodeRoot = Join-Path $portableRoot "node"
$cacheRoot = Join-Path $repoRoot ".cache"
$nodeZip = Join-Path $cacheRoot "node-v$NodeVersion-win-x64.zip"
$nodeExtract = Join-Path $cacheRoot "node-v$NodeVersion-win-x64"
$nodeUrl = "https://nodejs.org/dist/v$NodeVersion/node-v$NodeVersion-win-x64.zip"
$bundledNodeRoot = [System.IO.Path]::GetFullPath((Join-Path $repoRoot "..\node"))
$nodeCommand = if (Test-Path -LiteralPath (Join-Path $bundledNodeRoot "node.exe")) {
  Join-Path $bundledNodeRoot "node.exe"
} else {
  "node"
}
$npmCommand = if (Test-Path -LiteralPath (Join-Path $bundledNodeRoot "npm.cmd")) {
  Join-Path $bundledNodeRoot "npm.cmd"
} else {
  "npm.cmd"
}
$trayScriptSource = Join-Path $repoRoot "scripts\windows\LifePlannerTray.ps1"
$llamaProvisionerSource = Join-Path $repoRoot "scripts\windows\Install-LlamaRuntime.ps1"
$trayIconSource = Join-Path $repoRoot "installer\assets\life-planner-app.ico"

Write-Host "Preparing Life Planner portable bundle ($Configuration)"
Write-Host "Repo: $repoRoot"

Push-Location $repoRoot
try {
  if (-not $SkipDependencyInstall) {
    & $npmCommand install --no-save --package-lock=false
    if ($LASTEXITCODE -ne 0) { throw "npm install failed with exit code $LASTEXITCODE" }
  }

  if (-not $SkipBuild) {
    & $npmCommand run build
    if ($LASTEXITCODE -ne 0) { throw "npm run build failed with exit code $LASTEXITCODE" }
  }
}
finally {
  Pop-Location
}

New-Item -ItemType Directory -Force -Path $cacheRoot | Out-Null

if (!(Test-Path $nodeExtract)) {
  if (!(Test-Path $nodeZip)) {
    Write-Host "Downloading Node.js $NodeVersion..."
    Invoke-WebRequest -Uri $nodeUrl -OutFile $nodeZip
  }
  Write-Host "Extracting Node.js..."
  Expand-Archive -Path $nodeZip -DestinationPath $cacheRoot -Force
}

if (Test-Path $portableRoot) {
  Remove-Item -LiteralPath $portableRoot -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $appRoot, $nodeRoot | Out-Null

Copy-Item -Path (Join-Path $nodeExtract "*") -Destination $nodeRoot -Recurse -Force

$itemsToCopy = @(
  "dist",
  "browser-extension",
  "installer",
  "scripts",
  "server",
  "src",
  "public",
  "node_modules",
  "index.html",
  "vite.config.js",
  "package.json",
  "package-lock.json",
  "README.md",
  ".gitignore",
  "LifePlanSystem_Public_Sanitized",
  "LifePlanSystem_Sanitised_UI_Scaffold_2026-06-29"
)

foreach ($item in $itemsToCopy) {
  $source = Join-Path $repoRoot $item
  if (Test-Path $source) {
    Copy-Item -Path $source -Destination $appRoot -Recurse -Force
  }
}

Get-ChildItem -Path (Join-Path $appRoot "node_modules") -Directory -Recurse -Force -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -eq ".local-browsers" } |
  Remove-Item -Recurse -Force -ErrorAction SilentlyContinue

$privateRoots = @(
  (Join-Path $appRoot "data"),
  (Join-Path $appRoot ".env"),
  (Join-Path $appRoot "browser-extension\lps-browser-agent\pairing-config.json")
)

foreach ($privateRoot in $privateRoots) {
  if (Test-Path -LiteralPath $privateRoot) {
    Remove-Item -LiteralPath $privateRoot -Recurse -Force
  }
}

$blockedPatterns = @(
  "*.sqlite",
  "*.sqlite3",
  "*.db",
  "*.gguf",
  "*.safetensors",
  "*.onnx",
  "*.log"
)

foreach ($pattern in $blockedPatterns) {
  Get-ChildItem -LiteralPath $appRoot -Recurse -Force -ErrorAction SilentlyContinue -Filter $pattern |
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
}

if (-not (Test-Path -LiteralPath $trayScriptSource)) {
  throw "Tray launcher source is missing: $trayScriptSource"
}
if (-not (Test-Path -LiteralPath $trayIconSource)) {
  throw "Tray icon is missing: $trayIconSource"
}
if (-not (Test-Path -LiteralPath $llamaProvisionerSource)) {
  throw "llama.cpp provisioner is missing: $llamaProvisionerSource"
}

$parseTokens = $null
$parseErrors = $null
[System.Management.Automation.Language.Parser]::ParseFile($trayScriptSource, [ref]$parseTokens, [ref]$parseErrors) | Out-Null
if ($parseErrors.Count -gt 0) {
  $details = ($parseErrors | ForEach-Object { $_.Message }) -join "; "
  throw "Tray launcher PowerShell syntax check failed: $details"
}

$parseTokens = $null
$parseErrors = $null
[System.Management.Automation.Language.Parser]::ParseFile($llamaProvisionerSource, [ref]$parseTokens, [ref]$parseErrors) | Out-Null
if ($parseErrors.Count -gt 0) {
  $details = ($parseErrors | ForEach-Object { $_.Message }) -join "; "
  throw "llama.cpp provisioner PowerShell syntax check failed: $details"
}

& $nodeCommand (Join-Path $PSScriptRoot "verify-tray-launcher.mjs")
if ($LASTEXITCODE -ne 0) { throw "Tray launcher static verification failed with exit code $LASTEXITCODE" }

Copy-Item -LiteralPath $trayScriptSource -Destination (Join-Path $portableRoot "LifePlannerTray.ps1") -Force
Copy-Item -LiteralPath $trayIconSource -Destination (Join-Path $portableRoot "life-planner-app.ico") -Force

# llama.cpp is a small runtime dependency and belongs in the bundle. The much
# larger starter model is fetched by Inno/first launch instead of inflating Git
# or the installer payload.
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $llamaProvisionerSource -PortableRoot $portableRoot -RuntimeOnly
if ($LASTEXITCODE -ne 0) { throw "llama.cpp runtime provisioning failed with exit code $LASTEXITCODE" }

Get-ChildItem -LiteralPath $appRoot -Recurse -File |
  ForEach-Object { $_.FullName.Substring($appRoot.Length + 1) -replace '\\', '/' } |
  Sort-Object |
  Set-Content -Path (Join-Path $portableRoot "PACKAGED_FILES.txt") -Encoding UTF8

@"
@echo off
setlocal
start "" wscript.exe "%~dp0Start Life Planner.vbs"
exit /b 0
"@ | Set-Content -Path (Join-Path $portableRoot "Start Life Planner.cmd") -Encoding ASCII

@'
Option Explicit
Dim shell, fso, root, scriptPath, command
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(WScript.ScriptFullName)
scriptPath = fso.BuildPath(root, "LifePlannerTray.ps1")
command = "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File " & Chr(34) & scriptPath & Chr(34)
shell.Run command, 0, False
'@ | Set-Content -Path (Join-Path $portableRoot "Start Life Planner.vbs") -Encoding ASCII

@"
@echo off
setlocal
set LIFE_PLANNER_PORT=4177
set PLAYWRIGHT_BROWSERS_PATH=%~dp0app\data\ms-playwright
if not exist "%PLAYWRIGHT_BROWSERS_PATH%\*" call "%~dp0Install Playwright Chromium.cmd"
cd /d "%~dp0app"
"%~dp0node\node.exe" server\index.js
"@ | Set-Content -Path (Join-Path $portableRoot "Run Server Console.cmd") -Encoding ASCII

@"
@echo off
setlocal
set "PORTABLE_ROOT=%~dp0"
set "APP_ROOT=%PORTABLE_ROOT%app"
set "PLAYWRIGHT_BROWSERS_PATH=%APP_ROOT%\data\ms-playwright"
if exist "%PLAYWRIGHT_BROWSERS_PATH%\*" exit /b 0
if not exist "%APP_ROOT%\data" mkdir "%APP_ROOT%\data" >nul 2>&1
pushd "%APP_ROOT%"
"%PORTABLE_ROOT%node\node.exe" node_modules\playwright\cli.js install chromium
set "EXIT_CODE=%ERRORLEVEL%"
popd
exit /b %EXIT_CODE%
"@ | Set-Content -Path (Join-Path $portableRoot "Install Playwright Chromium.cmd") -Encoding ASCII

@"
@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0app\scripts\windows\Install-LlamaRuntime.ps1" -PortableRoot "%~dp0"
exit /b %ERRORLEVEL%
"@ | Set-Content -Path (Join-Path $portableRoot "Install Local Model Runtime.cmd") -Encoding ASCII

@'
# Life Planner Portable

Run `Start Life Planner.vbs` (or the compatibility `Start Life Planner.cmd`).

Life Planner starts without a Node terminal and remains available from its app icon in the Windows notification area. The tray menu provides:

- Open Life Planner
- Pause environment
- Resume environment
- Exit environment

The app opens at:

http://127.0.0.1:4177/

Server output is written under:

app\data\logs\

Use `Run Server Console.cmd` only for manual debugging when you intentionally want to see the Node console.

Playwright Chromium is not bundled into the installer payload. The installer and first app launch silently install it into:

app\data\ms-playwright\

The verified llama.cpp CPU runtime is bundled under `llama\`. The installer
silently downloads a verified compact starter GGUF into `app\data\models\`.
Models selected later in Settings use the same bundled OpenAI-compatible server.

The browser connector extension is bundled at:

app\browser-extension\lps-browser-agent

Local runtime data is created under:

app\data\

Do not sync or publish `app\data` unless you intentionally want to move local private state.
'@ | Set-Content -Path (Join-Path $portableRoot "PORTABLE_README.md") -Encoding UTF8

& $nodeCommand (Join-Path $PSScriptRoot "verify-portable-package.mjs") $portableRoot
if ($LASTEXITCODE -ne 0) { throw "Portable package verification failed with exit code $LASTEXITCODE" }

Write-Host "Portable bundle ready:"
Write-Host $portableRoot
Write-Host ""
Write-Host "Compile installer with Inno Setup:"
Write-Host "ISCC.exe installer\LifePlannerPortable.iss"
