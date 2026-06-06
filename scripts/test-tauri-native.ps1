param(
  [switch]$SkipBuild,
  [switch]$StopExisting
)

$ErrorActionPreference = 'Stop'

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
Set-Location $repoRoot

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

$existingBrainbox = Get-Process brainbox -ErrorAction SilentlyContinue
if ($existingBrainbox) {
  if ($StopExisting) {
    $existingBrainbox | Stop-Process -Force -ErrorAction SilentlyContinue
  } else {
    throw "brainbox is already running. Close it first, or rerun with -StopExisting for an isolated native QA run."
  }
}

if (-not $SkipBuild) {
  Invoke-Pnpm tauri build --debug --no-bundle --ci
}

Invoke-Pnpm exec playwright test --config=playwright.tauri.config.ts
