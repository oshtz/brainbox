param(
  [switch]$SkipBuild,
  [switch]$StopExisting
)

$ErrorActionPreference = 'Stop'

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
Set-Location $repoRoot
$devServer = $null
$webView2ArgumentsKey = 'HKCU:\Software\Policies\Microsoft\Edge\WebView2\AdditionalBrowserArguments'
$webView2ArgumentsName = 'brainbox.exe'
$webView2ArgumentsKeyExisted = $false
$webView2ArgumentsValueExisted = $false
$webView2ArgumentsPreviousValue = $null
$webView2ArgumentsConfigured = $false

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
  $portListener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
  $portListener.Start()
  $env:BRAINBOX_WEBVIEW2_DEBUG_PORT = $portListener.LocalEndpoint.Port
  $portListener.Stop()

  $webView2ArgumentsKeyExisted = Test-Path $webView2ArgumentsKey
  if ($webView2ArgumentsKeyExisted) {
    $webView2ArgumentsPreviousValue = Get-ItemPropertyValue `
      -Path $webView2ArgumentsKey `
      -Name $webView2ArgumentsName `
      -ErrorAction SilentlyContinue
    $webView2ArgumentsValueExisted = $null -ne $webView2ArgumentsPreviousValue
  }

  New-Item -Path $webView2ArgumentsKey -Force | Out-Null
  New-ItemProperty `
    -Path $webView2ArgumentsKey `
    -Name $webView2ArgumentsName `
    -Value "--remote-debugging-port=$env:BRAINBOX_WEBVIEW2_DEBUG_PORT" `
    -PropertyType String `
    -Force | Out-Null
  $webView2ArgumentsConfigured = $true

  if (-not $SkipBuild) {
    Invoke-Pnpm tauri build --debug --no-bundle --ci
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

  if ($webView2ArgumentsConfigured) {
    if ($webView2ArgumentsValueExisted) {
      Set-ItemProperty `
        -Path $webView2ArgumentsKey `
        -Name $webView2ArgumentsName `
        -Value $webView2ArgumentsPreviousValue
    } else {
      Remove-ItemProperty `
        -Path $webView2ArgumentsKey `
        -Name $webView2ArgumentsName `
        -ErrorAction SilentlyContinue
    }

    if (-not $webView2ArgumentsKeyExisted) {
      $remainingValues = (Get-ItemProperty -Path $webView2ArgumentsKey).PSObject.Properties |
        Where-Object { $_.Name -notmatch '^PS(Path|ParentPath|ChildName|Drive|Provider)$' }
      if (-not $remainingValues) {
        Remove-Item -Path $webView2ArgumentsKey -ErrorAction SilentlyContinue
      }
    }
  }
}
