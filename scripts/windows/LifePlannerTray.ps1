param(
  [string]$PortableRoot = '',
  [int]$Port = 4177,
  [switch]$NoAutoOpen
)

$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

if ([string]::IsNullOrWhiteSpace($PortableRoot)) {
  $PortableRoot = $PSScriptRoot
}
$PortableRoot = [System.IO.Path]::GetFullPath($PortableRoot)
$appRoot = Join-Path $PortableRoot 'app'
$nodeExe = Join-Path $PortableRoot 'node\node.exe'
$serverEntry = Join-Path $appRoot 'server\index.js'
$nativeExe = Join-Path $PortableRoot 'native\LifePlanSystem.Native.exe'
$playwrightRoot = Join-Path $appRoot 'data\ms-playwright'
$playwrightInstaller = Join-Path $PortableRoot 'Install Playwright Chromium.cmd'
$logRoot = Join-Path $appRoot 'data\logs'
$stdoutLog = Join-Path $logRoot 'life-planner-server.log'
$stderrLog = Join-Path $logRoot 'life-planner-server-error.log'
$appUrl = "http://127.0.0.1:$Port/"
$healthUrl = "http://127.0.0.1:$Port/api/health"

foreach ($requiredPath in @($appRoot, $nodeExe, $serverEntry, $nativeExe)) {
  if (-not (Test-Path -LiteralPath $requiredPath)) {
    [System.Windows.Forms.MessageBox]::Show(
      "Life Planner could not start because a required file is missing:`r`n$requiredPath",
      'Life Planner',
      [System.Windows.Forms.MessageBoxButtons]::OK,
      [System.Windows.Forms.MessageBoxIcon]::Error
    ) | Out-Null
    exit 1
  }
}

New-Item -ItemType Directory -Force -Path $logRoot | Out-Null

$hashProvider = [System.Security.Cryptography.SHA256]::Create()
try {
  $identityBytes = [System.Text.Encoding]::UTF8.GetBytes("$($PortableRoot.ToLowerInvariant())|$Port")
  $identityHash = [System.BitConverter]::ToString($hashProvider.ComputeHash($identityBytes)).Replace('-', '')
}
finally {
  $hashProvider.Dispose()
}

$mutexName = "Local\LifePlannerTray-$($identityHash.Substring(0, 20))"
$createdNew = $false
$instanceMutex = [System.Threading.Mutex]::new($true, $mutexName, [ref]$createdNew)

function Test-ServerHealth {
  try {
    $response = Invoke-WebRequest -Uri $healthUrl -UseBasicParsing -TimeoutSec 2
    if ($response.StatusCode -ne 200) { return $false }
    $health = $response.Content | ConvertFrom-Json
    $runtime = $health.data.runtime
    $expectedBuild = Get-Content -LiteralPath (Join-Path $appRoot 'dist\build-info.json') -Raw | ConvertFrom-Json
    if (-not $health.ok -or $health.data.db -ne 'ready' -or $runtime.packageChanged -ne $false) { return $false }
    if ($expectedBuild.commit -notmatch '^[a-f0-9]{40}$' -or $expectedBuild.dirty -ne $false) { return $false }
    if ($runtime.build.commit -ne $expectedBuild.commit -or $runtime.build.buildTime -ne $expectedBuild.buildTime -or $runtime.build.dirty -ne $false) { return $false }
    if (-not (Test-SameRuntimePath $runtime.serverRoot $appRoot)) { return $false }
    if (-not (Test-SameRuntimePath $health.data.storage (Join-Path $appRoot 'data\life-planner.sqlite'))) { return $false }
    if (-not (Test-SameRuntimePath $runtime.process.executable $nodeExe)) { return $false }
    if ($runtime.process.pid -le 0 -or (Get-PortOwnerProcessId) -ne $runtime.process.pid) { return $false }
    if (-not (Test-IsBundledNodeProcess $runtime.process.pid)) { return $false }
    if ($script:launchId -and $runtime.process.launchId -ne $script:launchId) { return $false }
    if ($script:serverProcess -and $runtime.process.pid -ne $script:serverProcess.Id) { return $false }
    return $true
  }
  catch {
    return $false
  }
}

function Test-SameRuntimePath($Actual, $Expected) {
  if ([string]::IsNullOrWhiteSpace($Actual)) { return $false }
  return [System.IO.Path]::GetFullPath($Actual).Equals([System.IO.Path]::GetFullPath($Expected), [System.StringComparison]::OrdinalIgnoreCase)
}

$script:serverProcess = $null
$script:ownsServerProcess = $false
$script:serverStartTicks = $null
$script:launchId = $null
$script:trayState = 'starting'
$script:exiting = $false
$script:iconHandle = $null

function Get-PortOwnerProcessId {
  try {
    if (Get-Command Get-NetTCPConnection -ErrorAction SilentlyContinue) {
      $connection = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop |
        Where-Object { $_.LocalAddress -eq '127.0.0.1' -or $_.LocalAddress -eq '0.0.0.0' -or $_.LocalAddress -eq '::' } |
        Select-Object -First 1
      if ($connection) { return [int]$connection.OwningProcess }
    }
  }
  catch {
    # Fall through to netstat for systems where Get-NetTCPConnection is unavailable.
  }

  try {
    $pattern = ":$Port\s+.*LISTENING\s+(\d+)\s*$"
    foreach ($line in (& $env:SystemRoot\System32\netstat.exe -ano -p tcp 2>$null)) {
      if ($line -match $pattern) { return [int]$Matches[1] }
    }
  }
  catch {
    return 0
  }

  return 0
}

function Test-IsBundledNodeProcess([int]$ProcessId) {
  if ($ProcessId -le 0) { return $false }
  try {
    $process = Get-Process -Id $ProcessId -ErrorAction Stop
    if ([string]::IsNullOrWhiteSpace($process.Path)) { return $false }
    return [System.IO.Path]::GetFullPath($process.Path).Equals(
      [System.IO.Path]::GetFullPath($nodeExe),
      [System.StringComparison]::OrdinalIgnoreCase
    )
  }
  catch {
    return $false
  }
}

function Wait-ForServerHealth([int]$TimeoutSeconds = 30) {
  $watch = [System.Diagnostics.Stopwatch]::StartNew()
  while ($watch.Elapsed.TotalSeconds -lt $TimeoutSeconds) {
    if (Test-ServerHealth) { return $true }
    if ($script:serverProcess) {
      try {
        $script:serverProcess.Refresh()
        if ($script:serverProcess.HasExited) { return $false }
      }
      catch {
        return $false
      }
    }
    [System.Windows.Forms.Application]::DoEvents()
    Start-Sleep -Milliseconds 300
  }
  return $false
}

# All health dependencies are defined before the duplicate-instance path runs.
if (-not $createdNew) {
  if (Test-ServerHealth) {
    Start-Process -FilePath $nativeExe -WorkingDirectory (Split-Path -Parent $nativeExe) | Out-Null
  } else {
    [System.Windows.Forms.MessageBox]::Show('Life Planner is already open but its runtime identity is not ready or the environment is paused. Use the existing tray to resume, or Exit and reopen after an update.', 'Life Planner', 'OK', 'Information') | Out-Null
  }
  $instanceMutex.Dispose()
  exit 0
}

function Ensure-PlaywrightChromium {
  if ((Test-Path -LiteralPath $playwrightRoot) -and (Get-ChildItem -LiteralPath $playwrightRoot -Force -ErrorAction SilentlyContinue | Select-Object -First 1)) {
    return
  }
  if (-not (Test-Path -LiteralPath $playwrightInstaller)) {
    return
  }

  Set-TrayState 'preparing'
  $arguments = '/d /s /c ""{0}""' -f $playwrightInstaller
  $installProcess = Start-Process -FilePath $env:ComSpec -ArgumentList $arguments -WorkingDirectory $PortableRoot -WindowStyle Hidden -Wait -PassThru
  if ($installProcess.ExitCode -ne 0) {
    throw "Playwright Chromium installation failed with exit code $($installProcess.ExitCode)."
  }
}

function Ensure-LocalModelRuntime {
  # Ask the live canonical model owner after backend startup. An absent API is
  # unknown state, not authority to replace settings or download a starter.
  $response = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/models/runtime" -TimeoutSec 5
  if (-not $response.ok) { throw 'MODEL_STATE_UNVERIFIED: backend model state could not be verified; no provisioning started.' }
  $decision = $response.data.startupProvisioning
  if ($decision -in @('none', 'configured-endpoint')) { return }
  if ($decision -eq 'repair-required') { throw 'MODEL_CONFIGURATION_NEEDS_REPAIR: the saved assignment is unavailable. No starter download or model replacement was started. Review its file path in Settings.' }
  if ($decision -notin @('starter', 'runtime-only')) { throw 'MODEL_STATE_UNVERIFIED: backend did not supply a supported provisioning decision; no download started.' }
  $installer = Join-Path $appRoot 'scripts\windows\Install-LlamaRuntime.ps1'
  if (-not (Test-Path -LiteralPath $installer)) { throw 'MODEL_PROVISIONER_MISSING: use Setup and Recovery to repair the installed package.' }

  Set-TrayState 'preparing-model'
  $correlationId = [Guid]::NewGuid().ToString('N')
  $diagnosticPath = Join-Path $logRoot "model-provisioning-$correlationId.json"
  $diagnosticStderr = Join-Path $logRoot "model-provisioning-$correlationId.stderr.log"
  $arguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{0}" -PortableRoot "{1}" -DiagnosticPath "{2}"' -f $installer, $PortableRoot, $diagnosticPath
  if ($decision -eq 'runtime-only') { $arguments += ' -RuntimeOnly' }
  $installProcess = Start-Process -FilePath powershell.exe -ArgumentList $arguments -WorkingDirectory $PortableRoot -WindowStyle Hidden -RedirectStandardError $diagnosticStderr -Wait -PassThru
  if ($installProcess.ExitCode -ne 0) {
    $stage = 'process-start-or-script-parse'
    if (Test-Path -LiteralPath $diagnosticPath) {
      try { $stage = (Get-Content -LiteralPath $diagnosticPath -Raw | ConvertFrom-Json).stage } catch { }
    }
    throw "MODEL_PROVISIONING_FAILED at $stage (exit $($installProcess.ExitCode), correlation $correlationId). Existing model settings were not changed by the tray. Diagnostic: $diagnosticPath; child stderr: $diagnosticStderr"
  }
  # The existing startup default owner imports a newly installed starter and
  # runtime paths. Restart only our backend, never rewrite model rows here.
  Stop-LifePlannerServer
  Start-LifePlannerServer
}

function Start-LifePlannerServer {
  if ($script:serverProcess) {
    try {
      $script:serverProcess.Refresh()
      if (-not $script:serverProcess.HasExited -and (Test-ServerHealth)) {
        Set-TrayState 'running'
        return
      }
    }
    catch {
      $script:serverProcess = $null
      $script:ownsServerProcess = $false
    }
  }

  $existingProcessId = Get-PortOwnerProcessId
  if ($existingProcessId -gt 0) {
    throw "RUNTIME_PORT_OWNED: port $Port already has a process not launched by this tray. It was left running. Exit the existing Life Planner environment, or inspect that process before retrying."
  }

  Set-TrayState 'starting'
  $env:LIFE_PLANNER_PORT = [string]$Port
  $env:PLAYWRIGHT_BROWSERS_PATH = $playwrightRoot
  $script:launchId = [Guid]::NewGuid().ToString('N')
  $env:LPS_LAUNCH_ID = $script:launchId

  $script:serverProcess = Start-Process `
    -FilePath $nodeExe `
    -ArgumentList @('server\index.js') `
    -WorkingDirectory $appRoot `
    -WindowStyle Hidden `
    -RedirectStandardOutput $stdoutLog `
    -RedirectStandardError $stderrLog `
    -PassThru
  $script:ownsServerProcess = $true
  $script:serverStartTicks = $script:serverProcess.StartTime.Ticks

  if (-not (Wait-ForServerHealth 30)) {
    $exitDetail = ''
    try {
      $script:serverProcess.Refresh()
      if ($script:serverProcess.HasExited) { $exitDetail = " Server exit code: $($script:serverProcess.ExitCode)." }
    }
    catch {}
    $failureMessage = "RUNTIME_IDENTITY_UNVERIFIED: Life Planner did not establish matching package, process and database identity within 30 seconds.$exitDetail Check $stderrLog"
    Stop-LifePlannerServer
    throw $failureMessage
  }

  Set-TrayState 'running'
}

function Stop-LifePlannerServer {
  $processId = 0
  if ($script:serverProcess) {
    try {
      $script:serverProcess.Refresh()
      if (-not $script:serverProcess.HasExited) { $processId = $script:serverProcess.Id }
    }
    catch {}
  }

  if ($processId -gt 0 -and $script:ownsServerProcess) {
    # Revalidate the actual child, including creation time, before termination.
    # Never acquire ownership from a port lookup or kill a reused PID.
    $current = Get-Process -Id $processId -ErrorAction SilentlyContinue
    if ($current -and $current.StartTime.Ticks -eq $script:serverStartTicks -and (Test-IsBundledNodeProcess $processId)) {
      & $env:SystemRoot\System32\taskkill.exe /PID $processId /T /F *> $null
      Start-Sleep -Milliseconds 250
    }
  }

  $script:serverProcess = $null
  $script:ownsServerProcess = $false
  $script:serverStartTicks = $null
  $script:launchId = $null
}

function Open-LifePlanner {
  if (Test-ServerHealth) {
    Start-Process -FilePath $nativeExe -WorkingDirectory (Split-Path -Parent $nativeExe) | Out-Null
    return
  }
  $notifyIcon.ShowBalloonTip(
    3500,
    'Life Planner is paused',
    'Choose Resume environment from the tray menu before opening the app.',
    [System.Windows.Forms.ToolTipIcon]::Info
  )
}

function Set-TrayState([string]$State) {
  $script:trayState = $State
  switch ($State) {
    'running' {
      $statusItem.Text = 'Status: Running'
      $notifyIcon.Text = 'Life Planner - Running'
      $pauseItem.Enabled = $true
      $resumeItem.Enabled = $false
    }
    'paused' {
      $statusItem.Text = 'Status: Paused'
      $notifyIcon.Text = 'Life Planner - Paused'
      $pauseItem.Enabled = $false
      $resumeItem.Enabled = $true
    }
    'preparing' {
      $statusItem.Text = 'Status: Preparing browser tools'
      $notifyIcon.Text = 'Life Planner - Preparing'
      $pauseItem.Enabled = $false
      $resumeItem.Enabled = $false
    }
    'preparing-model' {
      $statusItem.Text = 'Status: Preparing local model'
      $notifyIcon.Text = 'Life Planner - Preparing model'
      $pauseItem.Enabled = $false
      $resumeItem.Enabled = $false
    }
    'starting' {
      $statusItem.Text = 'Status: Starting'
      $notifyIcon.Text = 'Life Planner - Starting'
      $pauseItem.Enabled = $false
      $resumeItem.Enabled = $false
    }
    default {
      $statusItem.Text = 'Status: Stopped - attention needed'
      $notifyIcon.Text = 'Life Planner - Stopped'
      $pauseItem.Enabled = $false
      $resumeItem.Enabled = $true
    }
  }
}

function Show-StartupError([string]$Message) {
  Set-TrayState 'error'
  $notifyIcon.ShowBalloonTip(
    8000,
    'Life Planner could not start',
    "$Message`r`nLogs: $logRoot",
    [System.Windows.Forms.ToolTipIcon]::Error
  )
}

$notifyIcon = New-Object System.Windows.Forms.NotifyIcon
$contextMenu = New-Object System.Windows.Forms.ContextMenuStrip
$statusItem = New-Object System.Windows.Forms.ToolStripMenuItem
$statusItem.Enabled = $false
$openItem = New-Object System.Windows.Forms.ToolStripMenuItem 'Open Life Planner'
$pauseItem = New-Object System.Windows.Forms.ToolStripMenuItem 'Pause environment'
$resumeItem = New-Object System.Windows.Forms.ToolStripMenuItem 'Resume environment'
$exitItem = New-Object System.Windows.Forms.ToolStripMenuItem 'Exit environment'

$iconCandidates = @(
  (Join-Path $PortableRoot 'life-planner-app.ico'),
  (Join-Path $appRoot 'installer\assets\life-planner-app.ico')
)
$iconPath = $iconCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if ($iconPath) {
  $script:iconHandle = [System.Drawing.Icon]::new($iconPath)
  $notifyIcon.Icon = $script:iconHandle
}
else {
  $notifyIcon.Icon = [System.Drawing.SystemIcons]::Application
}

[void]$contextMenu.Items.Add($statusItem)
[void]$contextMenu.Items.Add($openItem)
[void]$contextMenu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
[void]$contextMenu.Items.Add($pauseItem)
[void]$contextMenu.Items.Add($resumeItem)
[void]$contextMenu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
[void]$contextMenu.Items.Add($exitItem)

$notifyIcon.ContextMenuStrip = $contextMenu
$notifyIcon.Text = 'Life Planner - Starting'
$notifyIcon.Visible = $true

$openItem.Add_Click({ Open-LifePlanner })
$notifyIcon.Add_DoubleClick({ Open-LifePlanner })
$pauseItem.Add_Click({
  try {
    Stop-LifePlannerServer
    Set-TrayState 'paused'
    $notifyIcon.ShowBalloonTip(2500, 'Life Planner paused', 'The local environment is stopped. Choose Resume environment to start it again.', [System.Windows.Forms.ToolTipIcon]::Info)
  }
  catch {
    Show-StartupError $_.Exception.Message
  }
})
$resumeItem.Add_Click({
  try {
    Ensure-PlaywrightChromium
    Start-LifePlannerServer
    $notifyIcon.ShowBalloonTip(2500, 'Life Planner resumed', 'The local environment is running again.', [System.Windows.Forms.ToolTipIcon]::Info)
    Open-LifePlanner
  }
  catch {
    Show-StartupError $_.Exception.Message
  }
})
$exitItem.Add_Click({
  $script:exiting = $true
  $healthTimer.Stop()
  Stop-LifePlannerServer
  $notifyIcon.Visible = $false
  $notifyIcon.Dispose()
  if ($script:iconHandle) { $script:iconHandle.Dispose() }
  try { $instanceMutex.ReleaseMutex() } catch {}
  $instanceMutex.Dispose()
  [System.Windows.Forms.Application]::Exit()
})

$healthTimer = New-Object System.Windows.Forms.Timer
$healthTimer.Interval = 5000
$healthTimer.Add_Tick({
  if ($script:exiting -or $script:trayState -ne 'running') { return }
  if ($script:serverProcess) {
    try {
      $script:serverProcess.Refresh()
      if ($script:serverProcess.HasExited) {
        $script:serverProcess = $null
        $script:ownsServerProcess = $false
        # An installer update can replace the bundled Node process while this
        # tray host remains alive. Recover through the same owned-process path
        # before reporting an outage, so an update never leaves a stale tray
        # icon claiming the environment is available with no local server.
        try {
          Start-LifePlannerServer
          $notifyIcon.ShowBalloonTip(2500, 'Life Planner restarted', 'The local server restarted after an update or unexpected exit.', [System.Windows.Forms.ToolTipIcon]::Info)
        }
        catch {
          Show-StartupError "The local server stopped unexpectedly and could not restart. $($_.Exception.Message) Check $stderrLog"
        }
      }
      elseif (-not (Test-ServerHealth)) {
        Show-StartupError 'RUNTIME_IDENTITY_UNVERIFIED: the running environment no longer matches its package, process or database identity. Exit the environment and reopen the normal shortcut.'
      }
    }
    catch {
      Show-StartupError $_.Exception.Message
    }
  }
})
$healthTimer.Start()

Set-TrayState 'starting'
[System.Windows.Forms.Application]::DoEvents()

try {
  Ensure-PlaywrightChromium
  Start-LifePlannerServer
  try {
    Ensure-LocalModelRuntime
  }
  catch {
    $notifyIcon.ShowBalloonTip(5000, 'Local model setup needs attention', $_.Exception.Message, [System.Windows.Forms.ToolTipIcon]::Warning)
  }
  if (-not (Test-ServerHealth)) { throw 'BACKEND_UNAVAILABLE: local model setup ended without a healthy backend.' }
  Set-TrayState 'running'
  $notifyIcon.ShowBalloonTip(2200, 'Life Planner is running', 'Use the tray icon to open, pause, resume, or exit the local environment.', [System.Windows.Forms.ToolTipIcon]::Info)
  if (-not $NoAutoOpen) { Open-LifePlanner }
}
catch {
  Show-StartupError $_.Exception.Message
}

try {
  [System.Windows.Forms.Application]::Run()
}
finally {
  if (-not $script:exiting) {
    Stop-LifePlannerServer
    $notifyIcon.Visible = $false
    $notifyIcon.Dispose()
    if ($script:iconHandle) { $script:iconHandle.Dispose() }
    try { $instanceMutex.ReleaseMutex() } catch {}
    $instanceMutex.Dispose()
  }
}
