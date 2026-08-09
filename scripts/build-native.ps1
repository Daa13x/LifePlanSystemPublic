param(
  [switch]$SmokeTest,
  [string]$DotNetPath = $env:LIFE_PLANNER_DOTNET
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$project = Join-Path $repoRoot 'native\LifePlanSystem.Native\LifePlanSystem.Native.csproj'
$publishRoot = Join-Path $repoRoot 'release\LifePlannerNative'

if (-not $DotNetPath) {
  $candidates = @(
    $(if ($env:DOTNET_ROOT) { Join-Path $env:DOTNET_ROOT 'dotnet.exe' }),
    $(if ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA 'LifePlanSystem\dotnet-sdk-9\dotnet.exe' }),
    $(Get-Command dotnet.exe -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source -First 1)
  ) | Where-Object { $_ -and (Test-Path -LiteralPath $_) }
  $DotNetPath = $candidates | Select-Object -First 1
}

if (-not $DotNetPath -or -not (Test-Path -LiteralPath $DotNetPath)) {
  throw 'A .NET 9 SDK was not found. Set LIFE_PLANNER_DOTNET to dotnet.exe or install the documented SDK.'
}

$sdkVersion = (& $DotNetPath --version).Trim()
$sdkExit = $LASTEXITCODE
# The native app targets net9.0-windows, which a .NET 9 OR NEWER SDK can build
# (a newer SDK restores the net9.0 targeting/runtime packs from NuGet). CI
# runners now ship .NET 10, so require major >= 9 rather than exactly 9.
$sdkMajor = 0
[void][int]::TryParse((($sdkVersion -split '[.\-]')[0]), [ref]$sdkMajor)
if ($sdkExit -ne 0 -or $sdkMajor -lt 9) {
  throw "Native publishing requires a .NET 9 or newer SDK; resolved '$DotNetPath' reported '$sdkVersion'."
}

Write-Host "Using .NET SDK $sdkVersion from $DotNetPath"
& $DotNetPath publish $project --configuration Release --runtime win-x64 --self-contained false --output $publishRoot
if ($LASTEXITCODE -ne 0) { throw "Native publish failed with exit code $LASTEXITCODE." }

$nativeExe = Join-Path $publishRoot 'LifePlanSystem.Native.exe'
if (-not (Test-Path -LiteralPath $nativeExe)) {
  throw "Native publish did not produce: $nativeExe"
}

if ($SmokeTest) {
  $process = Start-Process -FilePath $nativeExe -ArgumentList '--health-smoke' -PassThru -WindowStyle Hidden
  try {
    $deadline = (Get-Date).AddSeconds(8)
    $health = $null
    while ((Get-Date) -lt $deadline -and -not $health) {
      try { $health = Invoke-RestMethod -Uri 'http://127.0.0.1:4178/native/health' -TimeoutSec 1 } catch { Start-Sleep -Milliseconds 200 }
    }
    if (-not $health -or -not $health.ok -or $health.data.runtime.runtimeMode -ne 'native-shell-compatibility') {
      throw 'Native health smoke test did not return the expected native runtime identity.'
    }
  }
  finally {
    if (-not $process.HasExited) {
      $process.WaitForExit(15000) | Out-Null
    }
  }
}

Write-Host "Native artifact ready: $publishRoot"
