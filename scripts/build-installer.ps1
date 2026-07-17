param(
  [string]$NodeVersion = "24.15.0",
  [string]$Configuration = "Release",
  [switch]$SkipDependencyInstall,
  [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$packageScript = Join-Path $PSScriptRoot "package-portable.ps1"
$issPath = Join-Path $repoRoot "installer\LifePlannerPortable.iss"
$setupExe = Join-Path $repoRoot "release\LifePlannerPortableSetup.exe"

if (!(Test-Path -LiteralPath $packageScript)) {
  throw "Packaging script not found: $packageScript"
}
if (!(Test-Path -LiteralPath $issPath)) {
  throw "Inno Setup script not found: $issPath"
}

$packageArgs = @{
  NodeVersion = $NodeVersion
  Configuration = $Configuration
}
if ($SkipDependencyInstall) { $packageArgs.SkipDependencyInstall = $true }
if ($SkipBuild) { $packageArgs.SkipBuild = $true }

Write-Host "Packaging portable bundle..."
& $packageScript @packageArgs

$candidates = @(
  (Join-Path ${env:ProgramFiles(x86)} 'Inno Setup 6\ISCC.exe'),
  (Join-Path $env:ProgramFiles 'Inno Setup 6\ISCC.exe')
) | Where-Object { $_ -and (Test-Path -LiteralPath $_) }

$iscc = $candidates | Select-Object -First 1
if (-not $iscc) {
  throw 'ISCC.exe not found. Install Inno Setup 6 first.'
}

Write-Host "Compiling installer with: $iscc"
if (Test-Path -LiteralPath $setupExe) {
  Remove-Item -LiteralPath $setupExe -Force
}
$compiler = Start-Process -FilePath $iscc -ArgumentList @($issPath) -Wait -PassThru -WindowStyle Hidden
if ($compiler.ExitCode -ne 0) {
  throw "Inno Setup compiler failed with exit code $($compiler.ExitCode)"
}

if (!(Test-Path -LiteralPath $setupExe)) {
  throw "Expected installer was not created: $setupExe"
}

$installer = Get-Item -LiteralPath $setupExe
Write-Host "Installer ready:"
Write-Host $installer.FullName
Write-Host ("Size: {0} bytes" -f $installer.Length)
