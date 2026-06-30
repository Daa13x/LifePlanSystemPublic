param(
  [string]$NodeVersion = "24.15.0",
  [string]$Configuration = "Release"
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
  npm.cmd install
  if ($LASTEXITCODE -ne 0) { throw "npm install failed with exit code $LASTEXITCODE" }
  $env:PLAYWRIGHT_BROWSERS_PATH = "0"
  npx.cmd playwright install chromium
  if ($LASTEXITCODE -ne 0) { throw "playwright chromium install failed with exit code $LASTEXITCODE" }
  npm.cmd run build
  if ($LASTEXITCODE -ne 0) { throw "npm run build failed with exit code $LASTEXITCODE" }
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

$blockedPatterns = @(
  "data",
  ".env",
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

Get-ChildItem -LiteralPath $appRoot -Recurse -File |
  ForEach-Object { $_.FullName.Substring($appRoot.Length + 1) -replace '\\', '/' } |
  Sort-Object |
  Set-Content -Path (Join-Path $portableRoot "PACKAGED_FILES.txt") -Encoding UTF8

@"
@echo off
setlocal
set LIFE_PLANNER_PORT=4177
set PLAYWRIGHT_BROWSERS_PATH=0
cd /d "%~dp0app"
start "Life Planner Server" /min "%~dp0node\node.exe" server\index.js
timeout /t 2 /nobreak >nul
start "" "http://127.0.0.1:%LIFE_PLANNER_PORT%/"
"@ | Set-Content -Path (Join-Path $portableRoot "Start Life Planner.cmd") -Encoding ASCII

@"
@echo off
setlocal
set LIFE_PLANNER_PORT=4177
set PLAYWRIGHT_BROWSERS_PATH=0
cd /d "%~dp0app"
"%~dp0node\node.exe" server\index.js
"@ | Set-Content -Path (Join-Path $portableRoot "Run Server Console.cmd") -Encoding ASCII

@"
# Life Planner Portable

Run `Start Life Planner.cmd`.

The app opens at:

http://127.0.0.1:4177/

Playwright Chromium is installed into the bundled app dependencies, so Browser consultation can run without a separate browser-cache setup.

Local runtime data is created under:

app\data\

Do not sync or publish `app\data` unless you intentionally want to move local private state.
"@ | Set-Content -Path (Join-Path $portableRoot "PORTABLE_README.md") -Encoding UTF8

Write-Host "Portable bundle ready:"
Write-Host $portableRoot
Write-Host ""
Write-Host "Compile installer with Inno Setup:"
Write-Host "ISCC.exe installer\LifePlannerPortable.iss"
