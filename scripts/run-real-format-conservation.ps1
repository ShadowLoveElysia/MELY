param(
  [string]$Source = ""
)

$ErrorActionPreference = "Stop"
$OutputEncoding = [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)

$projectRoot = Split-Path -Parent $PSScriptRoot
$outputRoot = Join-Path $projectRoot "release-validation\real-format-conservation"
$nodeCandidates = @(
  "C:\Program Files\nodejs\node.exe",
  "C:\Users\q3238\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
)
$node = $nodeCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (-not $Source) {
  $currentSource = Join-Path $projectRoot "test-generation-solid-balanced.litematic"
  $legacySource = Join-Path $projectRoot "test-generation-solid-balanced.litematica"
  $Source = if (Test-Path -LiteralPath $currentSource) { $currentSource } else { $legacySource }
}

foreach ($required in @($node, $Source)) {
  if (-not $required -or -not (Test-Path -LiteralPath $required)) {
    throw "Required path is missing: $required"
  }
}

New-Item -ItemType Directory -Force -Path $outputRoot | Out-Null
$stdout = Join-Path $outputRoot "audit.stdout.log"
$stderr = Join-Path $outputRoot "audit.stderr.log"
$report = Join-Path $outputRoot "report.json"
$summary = Join-Path $outputRoot "validation-summary.json"
Remove-Item -LiteralPath $stdout, $stderr, $report, $summary -ErrorAction SilentlyContinue

$env:MELY_FORMAT_SOURCE = $Source
$env:MELY_FORMAT_OUTPUT = $outputRoot
$env:MELY_FORMAT_REPORT = $report

$process = Start-Process -FilePath $node -ArgumentList @(
  "--import", "tsx",
  "scripts\verify-real-format-conservation.ts"
) -WorkingDirectory $projectRoot -RedirectStandardOutput $stdout -RedirectStandardError $stderr -WindowStyle Hidden -Wait -PassThru

@{
  generatedAt = [DateTime]::UtcNow.ToString("o")
  exitCode = $process.ExitCode
  source = $Source
  report = $report
  logs = @{
    stdout = $stdout
    stderr = $stderr
  }
} | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $summary -Encoding utf8

Write-Output "SUMMARY=$summary"
Write-Output "REPORT=$report"
if ($process.ExitCode -ne 0) { exit $process.ExitCode }
