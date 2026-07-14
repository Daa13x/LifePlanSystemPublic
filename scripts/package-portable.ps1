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

Write-Host "Preparing Life Planner portable bundle ($Configuration)"
Write-Host "Repo: $repoRoot"

Push-Location $repoRoot
try {
  if (-not $SkipDependencyInstall) {
    npm.cmd install --no-save --package-lock=false
    if ($LASTEXITCODE -ne 0) { throw "npm install failed with exit code $LASTEXITCODE" }
  }

  if (-not $SkipBuild) {
    npm.cmd run build
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
  "server",
  "node_modules",
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

$blockedPatterns = @(
  "data",
  ".env",
  "*.sqlite",
  "*.sqlite3",
  "*.db",
  "*.gguf",
  "*.safetensors",
  "*.onnx",
  "*.log",
  ".win32-*",
  ".rollup-*"
)

foreach ($pattern in $blockedPatterns) {
  Get-ChildItem -LiteralPath $appRoot -Recurse -Force -ErrorAction SilentlyContinue -Filter $pattern |
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
}

Get-ChildItem -LiteralPath $appRoot -Recurse -File |
  ForEach-Object { $_.FullName.Substring($appRoot.Length + 1) -replace '\\', '/' } |
  Sort-Object |
  Set-Content -Path (Join-Path $portableRoot "PACKAGED_FILES.txt") -Encoding UTF8

@"
@echo off
setlocal
set LIFE_PLANNER_PORT=4177
set PLAYWRIGHT_BROWSERS_PATH=%~dp0app\data\ms-playwright
if not exist "%PLAYWRIGHT_BROWSERS_PATH%\*" call "%~dp0Install Playwright Chromium.cmd"
cd /d "%~dp0app"
start "Life Planner Server" /min "%~dp0node\node.exe" server\index.js
timeout /t 2 /nobreak >nul
start "" "http://127.0.0.1:%LIFE_PLANNER_PORT%/"
"@ | Set-Content -Path (Join-Path $portableRoot "Start Life Planner.cmd") -Encoding ASCII

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

@'
# Life Planner Portable

Run `Start Life Planner.cmd`.

The app opens at:

http://127.0.0.1:4177/

Playwright Chromium is not bundled into the installer payload. The installer and
first app launch silently install it into:

app\data\ms-playwright\

The browser connector extension is bundled at:

app\browser-extension\lps-browser-agent

Local runtime data is created under:

app\data\

Do not sync or publish `app\data` unless you intentionally want to move local private state.
'@ | Set-Content -Path (Join-Path $portableRoot "PORTABLE_README.md") -Encoding UTF8

Write-Host "Portable bundle ready:"
Write-Host $portableRoot
Write-Host ""
Write-Host "Compile installer with Inno Setup:"
Write-Host "ISCC.exe installer\LifePlannerPortable.iss"
