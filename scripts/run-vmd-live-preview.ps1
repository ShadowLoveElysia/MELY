param(
  [string]$ModelZip = "",
  [string]$MotionZip = "",
  [int]$Port = 4218
)

$ErrorActionPreference = "Stop"
$OutputEncoding = [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$projectRoot = Split-Path -Parent $PSScriptRoot
$outputRoot = Join-Path $projectRoot "release-validation\vmd-live-preview"
$nodeCandidates = @(
  "C:\Program Files\nodejs\node.exe",
  "C:\Users\q3238\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
)
$node = $nodeCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
$edge = "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
$playwright = Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies\node\node_modules\playwright"
if (-not $ModelZip) {
  $ModelZip = Get-ChildItem -LiteralPath "H:\Downloads" -File -Filter "*ed5668c5d5c3b3063039ec8a4e83f102.zip" |
    Select-Object -ExpandProperty FullName -First 1
}
if (-not $MotionZip) {
  $MotionZip = Get-ChildItem -LiteralPath "H:\Downloads" -File -Filter "*74026477a169d16409b60bc21c0986ca.zip" |
    Select-Object -ExpandProperty FullName -First 1
}

foreach ($required in @($node, $edge, $playwright, $ModelZip, $MotionZip)) {
  if (-not $required -or -not (Test-Path -LiteralPath $required)) {
    throw "Required path is missing: $required"
  }
}

New-Item -ItemType Directory -Force -Path $outputRoot | Out-Null
$viteStdout = Join-Path $outputRoot "vite.stdout.log"
$viteStderr = Join-Path $outputRoot "vite.stderr.log"
$auditStdout = Join-Path $outputRoot "audit.stdout.log"
$auditStderr = Join-Path $outputRoot "audit.stderr.log"
$report = Join-Path $outputRoot "report.json"
Remove-Item -LiteralPath $viteStdout, $viteStderr, $auditStdout, $auditStderr, $report -ErrorAction SilentlyContinue

$env:MELY_MODEL_ZIP = $ModelZip
$env:MELY_MOTION_ZIP = $MotionZip
$env:MELY_OUTPUT_DIRECTORY = $outputRoot
$env:MELY_REPORT_PATH = $report
$env:MELY_URL = "http://127.0.0.1:$Port/"
$env:MELY_BROWSER_PATH = $edge
$env:MELY_PLAYWRIGHT_MODULE = $playwright

$vite = $null
$auditExitCode = 1
try {
  $vite = Start-Process -FilePath $node -ArgumentList @(
    "node_modules\vite\bin\vite.js",
    "--config", "vite.config.ts",
    "--host", "127.0.0.1",
    "--port", [string]$Port,
    "--strictPort"
  ) -WorkingDirectory $projectRoot -RedirectStandardOutput $viteStdout -RedirectStandardError $viteStderr -WindowStyle Hidden -PassThru

  $deadline = [DateTime]::UtcNow.AddSeconds(45)
  $ready = $false
  while ([DateTime]::UtcNow -lt $deadline) {
    if ($vite.HasExited) { throw "Vite exited before MELY became ready (exit $($vite.ExitCode))." }
    try {
      $response = Invoke-WebRequest -UseBasicParsing -Uri $env:MELY_URL -TimeoutSec 2
      if ($response.StatusCode -eq 200) { $ready = $true; break }
    } catch {
      Start-Sleep -Milliseconds 300
    }
  }
  if (-not $ready) { throw "Timed out waiting for $($env:MELY_URL)" }

  $audit = Start-Process -FilePath $node -ArgumentList @(
    "scripts\verify-vmd-live-preview.cjs"
  ) -WorkingDirectory $projectRoot -RedirectStandardOutput $auditStdout -RedirectStandardError $auditStderr -WindowStyle Hidden -Wait -PassThru
  $auditExitCode = $audit.ExitCode
} finally {
  if ($vite -and -not $vite.HasExited) {
    Stop-Process -Id $vite.Id -Force -ErrorAction SilentlyContinue
  }
}

Write-Output "REPORT=$report"
if ($auditExitCode -ne 0) { exit 1 }
