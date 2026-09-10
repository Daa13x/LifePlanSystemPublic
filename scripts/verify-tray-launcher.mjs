import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

const root = path.resolve(process.cwd());
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

const tray = read('scripts/windows/LifePlannerTray.ps1');
const packaging = read('scripts/package-portable.ps1');
const installer = read('installer/LifePlannerPortable.iss');

assert.match(tray, /System\.Windows\.Forms\.NotifyIcon/);
assert.match(tray, /Pause environment/);
assert.match(tray, /Resume environment/);
assert.match(tray, /Exit environment/);
assert.match(tray, /life-planner-app\.ico/);
assert.match(tray, /System\.Threading\.Mutex/);
assert.match(tray, /CreateNoWindow|WindowStyle Hidden/);
assert.match(tray, /\/api\/health/);
assert.match(tray, /taskkill\.exe \/PID \$processId \/T \/F/);
assert.match(tray, /RedirectStandardOutput/);
assert.match(tray, /RedirectStandardError/);
assert.match(tray, /Stop-LifePlannerServer\s*\n\s*throw \$failureMessage/);
assert.match(tray, /Ensure-LocalModelRuntime/);
assert.match(tray, /Life Planner restarted/);
assert.match(tray, /Start-LifePlannerServer\s*\n\s*\$notifyIcon\.ShowBalloonTip/);
assert.match(tray, /LifePlanSystem\.Native\.exe/);
assert.match(tray, /Start-Process -FilePath \$nativeExe/, 'the normal tray open path starts the existing native shell');

assert.match(packaging, /LifePlannerTray\.ps1/);
assert.match(packaging, /Start Life Planner\.vbs/);
assert.match(packaging, /Start-NativeShell\.ps1/, 'the generated default VBS launcher enters the native shell lifecycle');
assert.match(packaging, /life-planner-app\.ico/);
assert.match(packaging, /Install-LlamaRuntime\.ps1/);
assert.doesNotMatch(packaging, /timeout\s+\/t\s+2/i);

assert.match(installer, /wscript\.exe/i);
assert.match(installer, /Start Life Planner\.vbs/);
assert.match(installer, /life-planner-app\.ico/);
// Optional runtime/browser downloads must NOT be executed during setup. Running
// elevated network-download scripts during install triggers Defender/SmartScreen
// prompts; the tray/app ensures the local model runtime on first launch under
// the user token (Ensure-LocalModelRuntime, above). See verify-installer-safety.mjs.
assert.doesNotMatch(installer, /Filename:[^\n]*Install Local Model Runtime\.cmd/i);
assert.doesNotMatch(installer, /Filename:[^\n]*Install Playwright Chromium\.cmd/i);
// The post-install app launch must drop to the original (non-elevated) user.
assert.match(installer, /postinstall[^\n]*runasoriginaluser/i);

// Exercise the generated launcher through a real Windows PowerShell child.
// The stub tray parses real argv. Native opening is owned solely by the tray.
if (process.platform === 'win32') {
  const generated = packaging.match(/@'\r?\n(param\(\)[\s\S]*?)\r?\n'@ \| Set-Content -Path \(Join-Path \$portableRoot "Start-NativeShell\.ps1"\)/)?.[1];
  assert.ok(generated, 'find the actual packaged native launcher');
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'lps-launcher-'));
  try {
    const installRoot = path.join(fixture, "Life Planner's [test] & café");
    fs.mkdirSync(path.join(installRoot, 'native'), { recursive: true });
    fs.writeFileSync(path.join(installRoot, 'native', 'LifePlanSystem.Native.exe'), 'fixture only');
    fs.writeFileSync(path.join(installRoot, 'LifePlannerTray.ps1'), `param([string]$PortableRoot, [switch]$NoAutoOpen)
@{ root = $PortableRoot; noAutoOpen = [bool]$NoAutoOpen } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $PSScriptRoot 'argv.json') -Encoding UTF8
`);
    const prelude = `function Start-Process {
  param($FilePath, $ArgumentList, $WindowStyle, $WorkingDirectory)
  if ($FilePath -like '*LifePlanSystem.Native.exe') { return }
  Microsoft.PowerShell.Management\\Start-Process -FilePath $FilePath -ArgumentList $ArgumentList -WindowStyle $WindowStyle -Wait
}
`;
    const script = path.join(installRoot, 'Start-NativeShell.ps1');
    fs.writeFileSync(script, '\ufeff' + generated.replace('param()', 'param()\n' + prelude));
    const result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], { encoding: 'utf8', windowsHide: true, timeout: 40000 });
    assert.equal(result.status, 0, `generated launcher exits successfully: ${result.error || result.stderr}`);
    const observed = JSON.parse(fs.readFileSync(path.join(installRoot, 'argv.json'), 'utf8').replace(/^\ufeff/, ''));
    assert.equal(observed.root, installRoot, 'the complete install root reaches the tray unchanged');
    assert.equal(observed.noAutoOpen, false, 'the tray owns opening after validated readiness');

    // Exercise actual tray health/open/stop functions without starting the UI,
    // downloading models, touching installed data or using the production port.
    const healthProbe = path.join(fixture, 'health-probe.ps1');
    fs.writeFileSync(healthProbe, `param([string]$SourcePath, [string]$FixtureRoot)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
$tokens = $null; $parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($SourcePath, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count) { throw 'Tray parse failed' }
$names = @('Test-ServerHealth', 'Test-SameRuntimePath', 'Open-LifePlanner', 'Stop-LifePlannerServer')
foreach ($fn in $ast.FindAll({param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst]}, $true)) {
  if ($fn.Name -in $names) { Invoke-Expression $fn.Extent.Text }
}
$appRoot = Join-Path $FixtureRoot 'app'
$nodeExe = Join-Path $FixtureRoot 'node\\node.exe'
$healthUrl = 'fixture-only'
$nativeExe = Join-Path $FixtureRoot 'native\\LifePlanSystem.Native.exe'
$script:opened = 0; $script:ownerLookups = 0
function Get-PortOwnerProcessId { $script:ownerLookups++; return $PID }
function Test-IsBundledNodeProcess($ProcessId) { return $ProcessId -eq $PID }
function Start-Process { $script:opened++ }
function Invoke-WebRequest { return @{ StatusCode=200; Content=($script:health | ConvertTo-Json -Depth 8) } }
$notifyIcon = [pscustomobject]@{}
$notifyIcon | Add-Member -MemberType ScriptMethod -Name ShowBalloonTip -Value { }
$expected = Get-Content -LiteralPath (Join-Path $appRoot 'dist\\build-info.json') -Raw | ConvertFrom-Json
$script:health = @{ ok=$true; data=@{ db='ready'; storage=(Join-Path $appRoot 'data\\life-planner.sqlite'); runtime=@{
  packageChanged=$false; build=$expected; serverRoot=$appRoot; process=@{ pid=$PID; executable=$nodeExe; launchId='owned-nonce' }
} } }
$script:launchId = 'owned-nonce'
if (-not (Test-ServerHealth)) { throw 'Matching identity rejected' }
Open-LifePlanner
if ($script:opened -ne 1) { throw 'Matching runtime did not open' }
$baseline = $script:health | ConvertTo-Json -Depth 8
foreach ($change in @(
  { $script:health.ok = $false },
  { $script:health.data.runtime = $null },
  { $script:health.data.runtime.packageChanged = $true },
  { $script:health.data.runtime.build.commit = 'unknown' },
  { $script:health.data.runtime.build.dirty = $true },
  { $script:health.data.runtime.serverRoot = $FixtureRoot },
  { $script:health.data.storage = (Join-Path $FixtureRoot 'wrong.sqlite') },
  { $script:health.data.runtime.process.pid = 0 },
  { $script:health.data.runtime.process.executable = 'C:\\wrong\\node.exe' },
  { $script:health.data.runtime.process.launchId = 'other-nonce' }
)) {
  $script:health = $baseline | ConvertFrom-Json
  & $change
  if (Test-ServerHealth) { throw 'Mismatched runtime was accepted' }
  Open-LifePlanner
  if ($script:opened -ne 1) { throw 'Mismatched runtime opened native shell' }
}
$script:serverProcess = $null; $script:ownsServerProcess = $true; $script:ownerLookups = 0
Stop-LifePlannerServer
if ($script:ownerLookups -ne 0) { throw 'Shutdown acquired an unrelated port owner' }
$script:serverProcess = [pscustomobject]@{ HasExited=$false; Id=$PID }
$script:serverProcess | Add-Member -MemberType ScriptMethod -Name Refresh -Value { }
$script:serverStartTicks = 1; $script:ownsServerProcess = $true
function Get-Process { return [pscustomobject]@{ StartTime=[DateTime]::new(2) } }
Stop-LifePlannerServer
Write-Output 'HEALTH_AND_OWNERSHIP_PASSED'
`, 'utf8');
    fs.mkdirSync(path.join(installRoot, 'app', 'dist'), { recursive: true });
    fs.writeFileSync(path.join(installRoot, 'app', 'dist', 'build-info.json'), JSON.stringify({ commit: 'a'.repeat(40), buildTime: 'fixture', dirty: false }));
    const healthResult = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', healthProbe, '-SourcePath', path.join(root, 'scripts/windows/LifePlannerTray.ps1'), '-FixtureRoot', installRoot], { encoding: 'utf8', windowsHide: true, timeout: 20000 });
    assert.equal(healthResult.status, 0, healthResult.stderr);
    assert.match(healthResult.stdout, /HEALTH_AND_OWNERSHIP_PASSED/);

    const provisioningProbe = path.join(fixture, 'provisioning-probe.ps1');
    const diagnostic = path.join(installRoot, 'model-provisioning-fixture.json');
    fs.writeFileSync(provisioningProbe, `param([string]$Installer, [string]$FixtureRoot, [string]$Diagnostic)
function Invoke-WebRequest { throw 'PUBLIC_SYNTHETIC_SECRET_DO_NOT_RETAIN' }
function Start-Sleep { }
& $Installer -PortableRoot $FixtureRoot -RuntimeOnly -DiagnosticPath $Diagnostic
exit $LASTEXITCODE
`, 'utf8');
    const provisioningResult = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', provisioningProbe, '-Installer', path.join(root, 'scripts/windows/Install-LlamaRuntime.ps1'), '-FixtureRoot', installRoot, '-Diagnostic', diagnostic], { encoding: 'utf8', windowsHide: true, timeout: 20000 });
    assert.equal(provisioningResult.status, 1, 'forced network failure is not success');
    const diagnosticText = fs.readFileSync(diagnostic, 'utf8').replace(/^\ufeff/, '');
    const failure = JSON.parse(diagnosticText);
    assert.equal(failure.errorCode, 'MODEL_PROVISIONING_FAILED');
    assert.equal(failure.stage, 'runtime.download');
    assert.equal(failure.correlationId, 'fixture');
    assert.doesNotMatch(diagnosticText, /PUBLIC_SYNTHETIC_SECRET/);
    assert.equal(fs.existsSync(path.join(installRoot, 'app', 'data', 'models')), false, 'runtime-only failure never starts the starter download');

    const stageProbe = path.join(fixture, 'stage-probe.ps1');
    fs.writeFileSync(stageProbe, `param([string]$Installer, [string]$FixtureRoot)
$ErrorActionPreference = 'Stop'
$tokens = $null; $parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($Installer, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count) { throw 'Provisioner parse failed' }
foreach ($fn in $ast.FindAll({param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst]}, $true)) { Invoke-Expression $fn.Extent.Text }
$good = Join-Path $FixtureRoot 'good.fixture'
[IO.File]::WriteAllText($good, 'good')
$starterSize = 4; $starterSha256 = Get-Sha256 $good
$modelRoot = Join-Path $FixtureRoot 'starter-fixture'
New-Item -ItemType Directory -Path $modelRoot | Out-Null
$modelPath = Join-Path $modelRoot 'model.gguf'
$modelManifestPath = "$modelPath.manifest.json"
[IO.File]::WriteAllText($modelPath, 'evil')
@{ sha256=$starterSha256 } | ConvertTo-Json | Set-Content -LiteralPath $modelManifestPath
$script:downloads = 0
function Download-VerifiedFile { $script:downloads++; throw 'FIXTURE_DOWNLOAD_REFUSED' }
try { Install-StarterModel; throw 'Corrupted same-size starter was accepted' } catch { if ($_.Exception.Message -ne 'FIXTURE_DOWNLOAD_REFUSED') { throw } }
if ($script:downloads -ne 1) { throw 'Corrupt starter did not reach integrity repair' }
[IO.File]::WriteAllText($modelPath, 'good')
Install-StarterModel
if ($script:downloads -ne 1) { throw 'Verified starter unnecessarily downloaded' }

function Download-VerifiedFile { }
function Expand-Archive {
  param($LiteralPath, $DestinationPath, [switch]$Force)
  if ($script:scenario -eq 'extract') { throw 'FIXTURE_FAILURE' }
  if ($script:scenario -eq 'payload') { return }
  Copy-Item -LiteralPath $good -Destination (Join-Path $DestinationPath 'llama-server.exe')
  Copy-Item -LiteralPath $good -Destination (Join-Path $DestinationPath 'ggml-base.dll')
}
function Move-Item {
  param($LiteralPath, $Destination, [switch]$Force)
  if ($Destination -eq $runtimeRoot) { throw 'FIXTURE_FAILURE' }
  Microsoft.PowerShell.Management\\Move-Item @PSBoundParameters
}
$runtimeVersion = 'fixture'; $runtimeServerSha256 = $starterSha256; $runtimeBaseDllSha256 = $starterSha256
$persistentCache = $false
foreach ($case in @(@('extract','runtime.extract'), @('payload','runtime.validate-payload'), @('promotion','runtime.promote-runtime'))) {
  $script:scenario = $case[0]
  $portableRootPath = Join-Path $FixtureRoot $script:scenario
  New-Item -ItemType Directory -Path $portableRootPath | Out-Null
  $runtimeRoot = Join-Path $portableRootPath 'llama'
  $downloadRoot = Join-Path $portableRootPath '.runtime-downloads'
  $script:provisioningStage = 'runtime.install'; $script:provisioningPhase = 'runtime'
  $failed = $false
  try { Install-LlamaRuntime } catch { $failed = $true }
  if (-not $failed -or $script:provisioningStage -ne $case[1]) { throw "Incorrect failure stage: $script:provisioningStage" }
}
Write-Output 'STARTER_INTEGRITY_AND_STAGES_PASSED'
`, 'utf8');
    const stageResult = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', stageProbe, '-Installer', path.join(root, 'scripts/windows/Install-LlamaRuntime.ps1'), '-FixtureRoot', installRoot], { encoding: 'utf8', windowsHide: true, timeout: 20000 });
    assert.equal(stageResult.status, 0, stageResult.stderr);
    assert.match(stageResult.stdout, /STARTER_INTEGRITY_AND_STAGES_PASSED/);
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
}

console.log('Tray launcher static and Windows argv verification passed.');
