param(
  [Parameter(Mandatory = $true)]
  [string]$PortableRoot,
  [string]$CacheRoot = '',
  [switch]$RuntimeOnly
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$runtimeVersion = 'b8354'
$runtimeUrl = 'https://github.com/ggml-org/llama.cpp/releases/download/b8354/llama-b8354-bin-win-cpu-x64.zip'
$runtimeSha256 = '6deafbf1f065e02d5aba723ff015cfef642501264c1e30b31c89b70085dd1721'
$runtimeServerSha256 = '3cc2ad3dbd5f2212e78024f21b9052b40a6872959d3cbb13a3ad38391eafbd6f'
$runtimeBaseDllSha256 = '5ae4c85183a1426828615daf354fcc36bd71b281deb0fc41b69fc4c3ae76b6e3'
$starterRepo = 'bartowski/Qwen2.5-1.5B-Instruct-GGUF'
$starterFile = 'Qwen2.5-1.5B-Instruct-Q4_K_M.gguf'
$starterUrl = "https://huggingface.co/$starterRepo/resolve/main/$starterFile"
$starterSha256 = '1adf0b11065d8ad2e8123ea110d1ec956dab4ab038eab665614adba04b6c3370'
$starterSize = 986048768

$portableRootPath = [System.IO.Path]::GetFullPath($PortableRoot)
$runtimeRoot = Join-Path $portableRootPath 'llama'
$persistentCache = -not [string]::IsNullOrWhiteSpace($CacheRoot)
$downloadRoot = if ($persistentCache) { [System.IO.Path]::GetFullPath($CacheRoot) } else { Join-Path $portableRootPath '.runtime-downloads' }
$modelRoot = Join-Path $portableRootPath 'app\data\models'
$modelPath = Join-Path $modelRoot $starterFile
$modelManifestPath = "$modelPath.manifest.json"

function Assert-ContainedPath([string]$Candidate) {
  $full = [System.IO.Path]::GetFullPath($Candidate)
  $prefix = $portableRootPath.TrimEnd('\') + '\'
  if (-not $full.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Provisioning path escapes the portable root: $full"
  }
  return $full
}

function Assert-ProvisioningPath([string]$Candidate) {
  $full = [System.IO.Path]::GetFullPath($Candidate)
  foreach ($root in @($portableRootPath, $downloadRoot)) {
    $rootFull = [System.IO.Path]::GetFullPath($root)
    if ($full -eq $rootFull -or $full.StartsWith($rootFull.TrimEnd('\') + '\', [System.StringComparison]::OrdinalIgnoreCase)) {
      return $full
    }
  }
  throw "Provisioning path escapes the portable/cache roots: $full"
}

function Get-Sha256([string]$Path) {
  return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Test-LlamaRuntimePayload([string]$Root) {
  $serverPath = Join-Path $Root 'llama-server.exe'
  $baseDllPath = Join-Path $Root 'ggml-base.dll'
  $manifestPath = Join-Path $Root 'runtime-manifest.json'
  if (-not (Test-Path -LiteralPath $serverPath) -or -not (Test-Path -LiteralPath $baseDllPath) -or -not (Test-Path -LiteralPath $manifestPath)) {
    return $false
  }
  try {
    $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    return $manifest.version -eq $runtimeVersion -and
      $manifest.archiveSha256 -eq $runtimeSha256 -and
      $manifest.serverSha256 -eq $runtimeServerSha256 -and
      $manifest.baseDllSha256 -eq $runtimeBaseDllSha256 -and
      (Get-Sha256 $serverPath) -eq $runtimeServerSha256 -and
      (Get-Sha256 $baseDllPath) -eq $runtimeBaseDllSha256
  }
  catch {
    return $false
  }
}

function Download-VerifiedFile(
  [string]$Url,
  [string]$Target,
  [string]$ExpectedSha256,
  [long]$ExpectedSize = 0
) {
  $targetPath = Assert-ProvisioningPath $Target
  $partialPath = Assert-ProvisioningPath "$targetPath.partial"
  New-Item -ItemType Directory -Path (Split-Path -Parent $targetPath) -Force | Out-Null

  if (Test-Path -LiteralPath $targetPath) {
    $cachedSize = (Get-Item -LiteralPath $targetPath).Length
    $cachedHash = Get-Sha256 $targetPath
    if (($ExpectedSize -le 0 -or $cachedSize -eq $ExpectedSize) -and $cachedHash -eq $ExpectedSha256.ToLowerInvariant()) { return }
    Remove-Item -LiteralPath $targetPath -Force
  }

  for ($attempt = 1; $attempt -le 3; $attempt += 1) {
    if (Test-Path -LiteralPath $partialPath) { Remove-Item -LiteralPath $partialPath -Force }
    try {
      Invoke-WebRequest -Uri $Url -OutFile $partialPath -UseBasicParsing
      $size = (Get-Item -LiteralPath $partialPath).Length
      if ($ExpectedSize -gt 0 -and $size -ne $ExpectedSize) {
        throw "Downloaded size $size does not match the published size $ExpectedSize."
      }
      $actualSha256 = Get-Sha256 $partialPath
      if ($actualSha256 -ne $ExpectedSha256.ToLowerInvariant()) {
        throw "Downloaded SHA-256 $actualSha256 does not match the pinned digest."
      }
      Move-Item -LiteralPath $partialPath -Destination $targetPath -Force
      return
    }
    catch {
      if (Test-Path -LiteralPath $partialPath) { Remove-Item -LiteralPath $partialPath -Force }
      if ($attempt -eq 3) { throw }
      Write-Warning "Verified download attempt $attempt failed; retrying in $($attempt * 2) seconds. $($_.Exception.Message)"
      Start-Sleep -Seconds ($attempt * 2)
    }
  }
}

function Install-LlamaRuntime {
  if (Test-LlamaRuntimePayload $runtimeRoot) { return }

  $runtimeCache = if ($persistentCache) { Assert-ProvisioningPath (Join-Path $downloadRoot "runtime-$runtimeVersion") } else { '' }
  if ($persistentCache -and (Test-LlamaRuntimePayload $runtimeCache)) {
    $cachedStaging = Assert-ContainedPath (Join-Path $portableRootPath "llama.ready.$PID")
    if (Test-Path -LiteralPath $cachedStaging) { Remove-Item -LiteralPath $cachedStaging -Recurse -Force }
    Copy-Item -LiteralPath $runtimeCache -Destination $cachedStaging -Recurse -Force
    if (Test-Path -LiteralPath $runtimeRoot) { Remove-Item -LiteralPath $runtimeRoot -Recurse -Force }
    Move-Item -LiteralPath $cachedStaging -Destination $runtimeRoot
    return
  }

  New-Item -ItemType Directory -Path $downloadRoot -Force | Out-Null
  $archivePath = Join-Path $downloadRoot "llama-$runtimeVersion-win-cpu-x64.zip"
  Download-VerifiedFile $runtimeUrl $archivePath $runtimeSha256

  $stagingRoot = Assert-ContainedPath (Join-Path $portableRootPath "llama.pending.$PID")
  if (Test-Path -LiteralPath $stagingRoot) { Remove-Item -LiteralPath $stagingRoot -Recurse -Force }
  New-Item -ItemType Directory -Path $stagingRoot -Force | Out-Null
  try {
    Expand-Archive -LiteralPath $archivePath -DestinationPath $stagingRoot -Force
    $server = Get-ChildItem -LiteralPath $stagingRoot -Filter 'llama-server.exe' -File -Recurse | Select-Object -First 1
    if (-not $server) { throw 'Pinned llama.cpp archive did not contain llama-server.exe.' }
    $payloadRoot = $server.Directory.FullName
    if (-not (Test-Path -LiteralPath (Join-Path $payloadRoot 'ggml-base.dll'))) {
      throw 'Pinned llama.cpp archive did not contain ggml-base.dll beside llama-server.exe.'
    }
    if ((Get-Sha256 (Join-Path $payloadRoot 'llama-server.exe')) -ne $runtimeServerSha256) {
      throw 'Pinned llama.cpp archive contained an unexpected llama-server.exe digest.'
    }
    if ((Get-Sha256 (Join-Path $payloadRoot 'ggml-base.dll')) -ne $runtimeBaseDllSha256) {
      throw 'Pinned llama.cpp archive contained an unexpected ggml-base.dll digest.'
    }
    $finalStaging = Assert-ContainedPath (Join-Path $portableRootPath "llama.ready.$PID")
    if (Test-Path -LiteralPath $finalStaging) { Remove-Item -LiteralPath $finalStaging -Recurse -Force }
    Copy-Item -LiteralPath $payloadRoot -Destination $finalStaging -Recurse -Force
    @{
      version = $runtimeVersion
      source = $runtimeUrl
      archiveSha256 = $runtimeSha256
      serverSha256 = $runtimeServerSha256
      baseDllSha256 = $runtimeBaseDllSha256
      installedAt = (Get-Date).ToUniversalTime().ToString('o')
    } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $finalStaging 'runtime-manifest.json') -Encoding UTF8
    if ($persistentCache) {
      $cacheStaging = Assert-ProvisioningPath (Join-Path $downloadRoot "runtime-$runtimeVersion.pending.$PID")
      if (Test-Path -LiteralPath $cacheStaging) { Remove-Item -LiteralPath $cacheStaging -Recurse -Force }
      Copy-Item -LiteralPath $finalStaging -Destination $cacheStaging -Recurse -Force
      if (Test-Path -LiteralPath $runtimeCache) { Remove-Item -LiteralPath $runtimeCache -Recurse -Force }
      Move-Item -LiteralPath $cacheStaging -Destination $runtimeCache
    }
    if (Test-Path -LiteralPath $runtimeRoot) { Remove-Item -LiteralPath $runtimeRoot -Recurse -Force }
    Move-Item -LiteralPath $finalStaging -Destination $runtimeRoot
  }
  finally {
    if (Test-Path -LiteralPath $stagingRoot) { Remove-Item -LiteralPath $stagingRoot -Recurse -Force }
    if (-not $persistentCache -and (Test-Path -LiteralPath $archivePath)) { Remove-Item -LiteralPath $archivePath -Force }
    if (-not $persistentCache -and (Test-Path -LiteralPath $downloadRoot) -and -not (Get-ChildItem -LiteralPath $downloadRoot -Force | Select-Object -First 1)) {
      Remove-Item -LiteralPath $downloadRoot -Force
    }
  }
}

function Install-StarterModel {
  if ((Test-Path -LiteralPath $modelPath) -and (Test-Path -LiteralPath $modelManifestPath)) {
    $manifest = Get-Content -LiteralPath $modelManifestPath -Raw | ConvertFrom-Json
    $actualSize = (Get-Item -LiteralPath $modelPath).Length
    if ($actualSize -eq $starterSize -and $manifest.sha256 -eq $starterSha256) { return }
  }

  New-Item -ItemType Directory -Path $modelRoot -Force | Out-Null
  Download-VerifiedFile $starterUrl $modelPath $starterSha256 $starterSize
  @{
    repo = $starterRepo
    file = $starterFile
    sha256 = $starterSha256
    size = $starterSize
    installedAt = (Get-Date).ToUniversalTime().ToString('o')
  } | ConvertTo-Json | Set-Content -LiteralPath $modelManifestPath -Encoding UTF8
}

Install-LlamaRuntime
if (-not $RuntimeOnly) { Install-StarterModel }
