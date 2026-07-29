param(
  [switch]$SmokeTest
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$project = Join-Path $repoRoot 'native\LifePlanSystem.Native\LifePlanSystem.Native.csproj'
$sdkRoot = 'C:\Users\alexl\AppData\Local\LifePlanSystem\dotnet-sdk-9'
$dotnet = Join-Path $sdkRoot 'dotnet.exe'
$publishRoot = Join-Path $repoRoot 'release\LifePlannerNative'

if (-not (Test-Path -LiteralPath $dotnet)) {
  throw "Native .NET SDK is missing: $dotnet. Install the documented SDK before publishing."
}

& $dotnet publish $project --configuration Release --runtime win-x64 --self-contained false --output $publishRoot
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
