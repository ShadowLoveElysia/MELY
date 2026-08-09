param(
  [string]$ModelZip = "",
  [string]$Motion = "",
  [int]$Port = 4199
)

$ErrorActionPreference = "Stop"
$OutputEncoding = [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)

$projectRoot = Split-Path -Parent $PSScriptRoot
$outputRoot = Join-Path $projectRoot "release-validation\mmd-core-audit"
$nodeCandidates = @(
  "C:\Program Files\nodejs\node.exe",
  "C:\Users\q3238\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
)
$node = $nodeCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
$edge = "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
$playwright = Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies\node\node_modules\playwright"
if (-not $Motion) { $Motion = Join-Path $projectRoot "tests\fixtures\mely-motion-e2e.vmd" }
if (-not $ModelZip) {
  $ModelZip = Get-ChildItem -LiteralPath "H:\Downloads" -File -Filter "*ed5668c5d5c3b3063039ec8a4e83f102.zip" |
    Select-Object -ExpandProperty FullName -First 1
}
if (-not $ModelZip) { throw "The real-model audit ZIP was not found by its stable hash suffix." }

New-Item -ItemType Directory -Force -Path $outputRoot | Out-Null
$viteStdout = Join-Path $outputRoot "vite.stdout.log"
$viteStderr = Join-Path $outputRoot "vite.stderr.log"
$auditStdout = Join-Path $outputRoot "audit.stdout.log"
$auditStderr = Join-Path $outputRoot "audit.stderr.log"
$testStdout = Join-Path $outputRoot "snapshot-tests.stdout.log"
$testStderr = Join-Path $outputRoot "snapshot-tests.stderr.log"
$coveragePath = Join-Path $outputRoot "nonlinear-coverage.json"
$report = Join-Path $outputRoot "report.json"
$summary = Join-Path $outputRoot "validation-summary.json"
Remove-Item -LiteralPath $viteStdout, $viteStderr, $auditStdout, $auditStderr, $testStdout, $testStderr, $coveragePath, $report, $summary -ErrorAction SilentlyContinue

foreach ($required in @($node, $edge, $playwright, $ModelZip, $Motion)) {
  if (-not $required -or -not (Test-Path -LiteralPath $required)) { throw "Required path is missing: $required" }
}

$env:MELY_AUDIT_MODEL = $ModelZip
$env:MELY_AUDIT_MOTION = $Motion
$env:MELY_AUDIT_OUTPUT = $report
$env:MELY_AUDIT_URL = "http://127.0.0.1:$Port/scripts/audits/mmd-core.html"
$env:MELY_EDGE_PATH = $edge
$env:MELY_PLAYWRIGHT_PATH = $playwright

$vite = $null
$auditExitCode = 1
$testExitCode = 1
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
    if ($vite.HasExited) { throw "Vite exited before the audit page became ready (exit $($vite.ExitCode))." }
    try {
      $response = Invoke-WebRequest -UseBasicParsing -Uri $env:MELY_AUDIT_URL -TimeoutSec 2
      if ($response.StatusCode -eq 200) { $ready = $true; break }
    } catch {
      Start-Sleep -Milliseconds 300
    }
  }
  if (-not $ready) { throw "Timed out waiting for $($env:MELY_AUDIT_URL)" }

  $auditProcess = Start-Process -FilePath $node -ArgumentList @(
    "scripts\verify-mmd-core-audit.cjs"
  ) -WorkingDirectory $projectRoot -RedirectStandardOutput $auditStdout -RedirectStandardError $auditStderr -WindowStyle Hidden -Wait -PassThru
  $auditExitCode = $auditProcess.ExitCode

  $testProcess = Start-Process -FilePath $node -ArgumentList @(
    "--import", "tsx",
    "--test", "tests\mmdSnapshot.test.ts"
  ) -WorkingDirectory $projectRoot -RedirectStandardOutput $testStdout -RedirectStandardError $testStderr -WindowStyle Hidden -Wait -PassThru
  $testExitCode = $testProcess.ExitCode
  @{
    testFile = "tests/mmdSnapshot.test.ts"
    exitCode = $testExitCode
    assertions = @{
      bdef1Bdef2Bdef4 = ($testExitCode -eq 0)
      sdefSphericalRotation = ($testExitCode -eq 0)
      qdefDualQuaternion = ($testExitCode -eq 0)
      morphBeforeSkinning = ($testExitCode -eq 0)
      sparseMorphSplit = ($testExitCode -eq 0)
    }
    referenceBoundary = "Three.js getVertexPosition is a linear-skinning reference only; SDEF and QDEF use deterministic mathematical fixtures."
  } | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $coveragePath -Encoding utf8
} finally {
  if ($vite -and -not $vite.HasExited) { Stop-Process -Id $vite.Id -Force -ErrorAction SilentlyContinue }
  @{
    generatedAt = [DateTime]::UtcNow.ToString("o")
    auditExitCode = $auditExitCode
    snapshotTestExitCode = $testExitCode
    report = $report
    nonlinearCoverage = $coveragePath
    logs = @{
      auditStdout = $auditStdout
      auditStderr = $auditStderr
      snapshotTestsStdout = $testStdout
      snapshotTestsStderr = $testStderr
      viteStdout = $viteStdout
      viteStderr = $viteStderr
    }
  } | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $summary -Encoding utf8
}

Write-Output "SUMMARY=$summary"
Write-Output "REPORT=$report"
if ($auditExitCode -ne 0 -or $testExitCode -ne 0) { exit 1 }
