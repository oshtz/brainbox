param(
  [string]$Root = (Resolve-Path ".").Path,
  [string]$OutputPath = "release-checksums.txt"
)

$ErrorActionPreference = "Stop"

$targetRoot = Join-Path $Root "src-tauri/target"
if (-not (Test-Path $targetRoot)) {
  throw "Tauri target directory not found: $targetRoot"
}

$artifactExtensions = @(".msi", ".exe", ".dmg", ".deb", ".rpm", ".appimage", ".zip", ".gz")
$files = Get-ChildItem -Path $targetRoot -Recurse -File |
  Where-Object {
    $normalized = $_.FullName -replace "\\", "/"
    $inReleaseTree = $normalized -match "/release/"
    $notBuildIntermediate = $normalized -notmatch "/(build|deps|incremental)/"
    $isArtifact = $artifactExtensions -contains $_.Extension.ToLowerInvariant()
    $inReleaseTree -and $notBuildIntermediate -and $isArtifact
  } |
  Sort-Object FullName

if ($files.Count -eq 0) {
  throw "No release artifacts found under $targetRoot"
}

$rootPath = (Resolve-Path $Root).Path
$rootUri = [System.Uri]($rootPath.TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar)
$lines = foreach ($file in $files) {
  $hash = Get-FileHash -Path $file.FullName -Algorithm SHA256
  $fileUri = [System.Uri]$file.FullName
  $relative = [System.Uri]::UnescapeDataString($rootUri.MakeRelativeUri($fileUri).ToString())
  "$($hash.Hash.ToLowerInvariant())  $relative"
}

$resolvedOutput = if ([System.IO.Path]::IsPathRooted($OutputPath)) {
  $OutputPath
} else {
  Join-Path $Root $OutputPath
}

$outputDir = Split-Path -Parent $resolvedOutput
if ($outputDir) {
  New-Item -ItemType Directory -Force -Path $outputDir | Out-Null
}

$lines | Set-Content -Path $resolvedOutput -Encoding UTF8
Write-Host "Wrote $($files.Count) checksums to $resolvedOutput"
