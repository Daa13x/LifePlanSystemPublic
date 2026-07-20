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
$playwrightRoot = Join-Path $appRoot 'data\ms-playwright'
$playwrightInstaller = Join-Path $PortableRoot 'Install Playwright Chromium.cmd'
$logRoot = Join-Path $appRoot 'data\logs'
$stdoutLog = Join-Path $logRoot 'life-planner-server.log'
$stderrLog = Join-Path $logRoot 'life-planner-server-error.log'
$appUrl = "http://127.0.0.1:$Port/"
$healthUrl = "http://127.0.0.1:$Port/api/health"

foreach ($requiredPath in @($appRoot, $nodeExe, $serverEntry)) {
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
  $identityBytes = [System.Text.Encoding]::UTF8.GetBytes("$PortableRoot|$Port")
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
    return $response.StatusCode -ge 200 -and $response.StatusCode -lt 300
  }
  catch {
    return $false
  }
}

if (-not $createdNew) {
  if (Test-ServerHealth) {
    Start-Process $appUrl | Out-Null
  }
  else {
    [System.Windows.Forms.MessageBox]::Show(
      'Life Planner is already open but the environment is paused or still starting. Use the Life Planner tray icon to resume it.',
      'Life Planner',
      [System.Windows.Forms.MessageBoxButtons]::OK,
      [System.Windows.Forms.MessageBoxIcon]::Information
    ) | Out-Null
  }
  $instanceMutex.Dispose()
  exit 0
}

$script:serverProcess = $null
$script:ownsServerProcess = $false
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
    if ((Test-IsBundledNodeProcess $existingProcessId) -and (Test-ServerHealth)) {
      $script:serverProcess = Get-Process -Id $existingProcessId -ErrorAction Stop
      $script:ownsServerProcess = $true
      Set-TrayState 'running'
      return
    }
    throw "Port $Port is already in use by another process. Close that process or change LIFE_PLANNER_PORT before starting Life Planner."
  }

  Set-TrayState 'starting'
  $env:LIFE_PLANNER_PORT = [string]$Port
  $env:PLAYWRIGHT_BROWSERS_PATH = $playwrightRoot

  $script:serverProcess = Start-Process `
    -FilePath $nodeExe `
    -ArgumentList @('server\index.js') `
    -WorkingDirectory $appRoot `
    -WindowStyle Hidden `
    -RedirectStandardOutput $stdoutLog `
    -RedirectStandardError $stderrLog `
    -PassThru
  $script:ownsServerProcess = $true

  if (-not (Wait-ForServerHealth 30)) {
    $exitDetail = ''
    try {
      $script:serverProcess.Refresh()
      if ($script:serverProcess.HasExited) { $exitDetail = " Server exit code: $($script:serverProcess.ExitCode)." }
    }
    catch {}
    $failureMessage = "Life Planner did not become healthy within 30 seconds.$exitDetail Check $stderrLog"
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

  if ($processId -le 0) {
    $candidate = Get-PortOwnerProcessId
    if (Test-IsBundledNodeProcess $candidate) { $processId = $candidate }
  }

  if ($processId -gt 0 -and $script:ownsServerProcess) {
    & $env:SystemRoot\System32\taskkill.exe /PID $processId /T /F *> $null
    Start-Sleep -Milliseconds 250
  }

  $script:serverProcess = $null
  $script:ownsServerProcess = $false
}

function Open-LifePlanner {
  if (Test-ServerHealth) {
    Start-Process $appUrl | Out-Null
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
$healthTimer.Interval = 2000
$healthTimer.Add_Tick({
  if ($script:exiting -or $script:trayState -ne 'running') { return }
  if ($script:serverProcess) {
    try {
      $script:serverProcess.Refresh()
      if ($script:serverProcess.HasExited) {
        $script:serverProcess = $null
        $script:ownsServerProcess = $false
        Show-StartupError "The local server stopped unexpectedly. Check $stderrLog"
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
