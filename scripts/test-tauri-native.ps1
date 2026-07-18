param(
  [switch]$SkipBuild,
  [switch]$StopExisting
)

$ErrorActionPreference = 'Stop'

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
Set-Location $repoRoot
$devServer = $null
$webView2DebugPort = 9222
$qaConfigPath = Join-Path ([System.IO.Path]::GetTempPath()) "brainbox-tauri-native-qa-$PID.json"

function Invoke-Pnpm {
  param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments)

  if (Get-Command pnpm -ErrorAction SilentlyContinue) {
    & pnpm @Arguments
  } else {
    & corepack pnpm @Arguments
  }

  if ($LASTEXITCODE -ne 0) {
    throw "pnpm command failed with exit code $LASTEXITCODE"
  }
}

function Get-PnpmLaunch {
  param([string[]]$Arguments)

  $command = [string]::Join(' ', $Arguments)
  if (Get-Command pnpm -ErrorAction SilentlyContinue) {
    return @{ FilePath = 'cmd.exe'; ArgumentList = @('/c', "pnpm $command") }
  }
  return @{ FilePath = 'cmd.exe'; ArgumentList = @('/c', "corepack pnpm $command") }
}

function Wait-ForUrl {
  param([string]$Url, [int]$TimeoutSeconds = 45)

  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    try {
      $response = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 2
      if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 500) { return }
    } catch {
      Start-Sleep -Milliseconds 500
    }
  }
  throw "Timed out waiting for $Url"
}

function Stop-ProcessTree {
  param([int]$ProcessId)

  $children = Get-CimInstance Win32_Process -Filter "ParentProcessId = $ProcessId" -ErrorAction SilentlyContinue
  foreach ($child in $children) {
    Stop-ProcessTree -ProcessId $child.ProcessId
  }
  Stop-Process -Id $ProcessId -Force -ErrorAction SilentlyContinue
}

$existingBrainbox = Get-Process brainbox,brainbox-portable -ErrorAction SilentlyContinue
if ($existingBrainbox) {
  if ($StopExisting) {
    $existingBrainbox | Stop-Process -Force -ErrorAction SilentlyContinue
  } else {
    throw "brainbox is already running. Close brainbox/brainbox-portable first, or rerun with -StopExisting for an isolated native QA run."
  }
}

try {
  $portListener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $webView2DebugPort)
  $portListener.Start()
  $portListener.Stop()
  $env:BRAINBOX_WEBVIEW2_DEBUG_PORT = $webView2DebugPort

  if (-not $SkipBuild) {
    $qaConfig = Get-Content (Join-Path $repoRoot 'src-tauri\tauri.conf.json') -Raw | ConvertFrom-Json
    $qaConfig.app.windows[0] | Add-Member `
      -NotePropertyName additionalBrowserArgs `
      -NotePropertyValue "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --remote-debugging-port=$webView2DebugPort" `
      -Force
    [System.IO.File]::WriteAllText($qaConfigPath, ($qaConfig | ConvertTo-Json -Depth 100))
    Invoke-Pnpm tauri build --debug --no-bundle --ci --config $qaConfigPath
  }

  $devLaunch = Get-PnpmLaunch @('run', 'dev', '--', '--host', '127.0.0.1')
  $devServer = Start-Process `
    -FilePath $devLaunch.FilePath `
    -ArgumentList $devLaunch.ArgumentList `
    -WorkingDirectory $repoRoot `
    -WindowStyle Hidden `
    -PassThru
  Wait-ForUrl 'http://127.0.0.1:17341'

  Invoke-Pnpm exec playwright test --config=playwright.tauri.config.ts
} finally {
  if ($devServer -and -not $devServer.HasExited) {
    Stop-ProcessTree -ProcessId $devServer.Id
    $devServer.WaitForExit(5000) | Out-Null
  }

  Remove-Item -Path $qaConfigPath -Force -ErrorAction SilentlyContinue
}
