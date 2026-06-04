$ErrorActionPreference = 'Stop'

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
Set-Location $repoRoot

$smokeDir = Join-Path ([System.IO.Path]::GetTempPath()) ("brainbox-tauri-smoke-" + [guid]::NewGuid().ToString("N"))
$process = $null
$devServer = $null

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
    return @{
      FilePath = 'cmd.exe'
      ArgumentList = @('/c', "pnpm $command")
    }
  }

  return @{
    FilePath = 'cmd.exe'
    ArgumentList = @('/c', "corepack pnpm $command")
  }
}

function Wait-ForUrl {
  param(
    [string]$Url,
    [int]$TimeoutSeconds = 45
  )

  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)

  while ((Get-Date) -lt $deadline) {
    try {
      $response = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 2
      if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 500) {
        return
      }
    } catch {
      Start-Sleep -Milliseconds 500
    }
  }

  throw "Timed out waiting for $Url"
}

try {
  New-Item -ItemType Directory -Force -Path $smokeDir | Out-Null
  $env:BRAINBOX_DATA_DIR = $smokeDir

  Invoke-Pnpm tauri build --debug --no-bundle --ci

  $devOut = Join-Path $smokeDir 'vite.stdout.log'
  $devErr = Join-Path $smokeDir 'vite.stderr.log'
  $devLaunch = Get-PnpmLaunch @('run', 'dev', '--', '--host', '127.0.0.1')
  $devServer = Start-Process `
    -FilePath $devLaunch.FilePath `
    -ArgumentList $devLaunch.ArgumentList `
    -WorkingDirectory $repoRoot `
    -WindowStyle Hidden `
    -RedirectStandardOutput $devOut `
    -RedirectStandardError $devErr `
    -PassThru

  Wait-ForUrl 'http://127.0.0.1:1420'

  $exeCandidates = @(
    (Join-Path $repoRoot 'src-tauri\target\debug\brainbox.exe'),
    (Join-Path $repoRoot 'src-tauri\target\debug\brainbox')
  )
  $exe = $exeCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1

  if (-not $exe) {
    throw "Tauri debug binary was not found under src-tauri\target\debug"
  }

  $appOut = Join-Path $smokeDir 'brainbox.stdout.log'
  $appErr = Join-Path $smokeDir 'brainbox.stderr.log'
  $process = Start-Process `
    -FilePath $exe `
    -WorkingDirectory (Split-Path $exe) `
    -WindowStyle Hidden `
    -RedirectStandardOutput $appOut `
    -RedirectStandardError $appErr `
    -PassThru

  $dbPath = Join-Path $smokeDir 'brainbox.sqlite'
  $indexPath = Join-Path $smokeDir 'search_index'
  $deadline = (Get-Date).AddSeconds(25)

  while ((Get-Date) -lt $deadline) {
    if ($process.HasExited) {
      throw "brainbox exited during smoke launch with code $($process.ExitCode)"
    }

    if ((Test-Path $dbPath) -and (Test-Path $indexPath)) {
      Write-Host "Tauri smoke passed: app launched and initialized an isolated profile at $smokeDir"
      exit 0
    }

    Start-Sleep -Milliseconds 500
  }

  throw "Timed out waiting for isolated DB/search profile under $smokeDir"
} finally {
  if ($process -and -not $process.HasExited) {
    Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
    $process.WaitForExit(5000)
  }
  if ($devServer -and -not $devServer.HasExited) {
    Stop-Process -Id $devServer.Id -Force -ErrorAction SilentlyContinue
    $devServer.WaitForExit(5000)
  }

  Remove-Item Env:\BRAINBOX_DATA_DIR -ErrorAction SilentlyContinue

  if (-not $env:BRAINBOX_KEEP_SMOKE_DATA -and (Test-Path $smokeDir)) {
    Remove-Item -LiteralPath $smokeDir -Recurse -Force -ErrorAction SilentlyContinue
  } elseif ($env:BRAINBOX_KEEP_SMOKE_DATA) {
    Write-Host "Kept smoke data at $smokeDir"
  }
}
