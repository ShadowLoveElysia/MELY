param([int]$Port = 4208)

$ErrorActionPreference = "Stop"
$OutputEncoding = [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)

$projectRoot = Split-Path -Parent $PSScriptRoot
$outputRoot = Join-Path $projectRoot "release-validation\mmd-input-audit"
$nodeCandidates = @(
  "C:\Program Files\nodejs\node.exe",
  "C:\Users\q3238\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
)
$node = $nodeCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
$edge = "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
$playwright = Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies\node\node_modules\playwright"
New-Item -ItemType Directory -Force -Path $outputRoot | Out-Null

$paths = @{
  viteStdout = Join-Path $outputRoot "vite.stdout.log"
  viteStderr = Join-Path $outputRoot "vite.stderr.log"
  parserStdout = Join-Path $outputRoot "parser.stdout.log"
  parserStderr = Join-Path $outputRoot "parser.stderr.log"
  browserStdout = Join-Path $outputRoot "browser.stdout.log"
  browserStderr = Join-Path $outputRoot "browser.stderr.log"
  testsStdout = Join-Path $outputRoot "tests.stdout.log"
  testsStderr = Join-Path $outputRoot "tests.stderr.log"
  parserReport = Join-Path $outputRoot "parser-report.json"
  browserReport = Join-Path $outputRoot "report.json"
  summary = Join-Path $outputRoot "validation-summary.json"
}
$paths.Values | ForEach-Object { Remove-Item -LiteralPath $_ -ErrorAction SilentlyContinue }
foreach ($required in @($node, $edge, $playwright)) {
  if (-not $required -or -not (Test-Path -LiteralPath $required)) { throw "Required path is missing: $required" }
}

$env:MELY_EDGE_PATH = $edge
$env:MELY_PLAYWRIGHT_PATH = $playwright
$env:MELY_INPUT_AUDIT_URL = "http://127.0.0.1:$Port/scripts/audits/mmd-core.html"
$env:MELY_INPUT_AUDIT_OUTPUT = $paths.browserReport
$env:MELY_REPORT_PATH = $paths.parserReport

$vite = $null
$parserExitCode = 1
$browserExitCode = 1
$testExitCode = 1
try {
  $vite = Start-Process -FilePath $node -ArgumentList @(
    "node_modules\vite\bin\vite.js", "--config", "vite.config.ts",
    "--host", "127.0.0.1", "--port", [string]$Port, "--strictPort"
  ) -WorkingDirectory $projectRoot -RedirectStandardOutput $paths.viteStdout -RedirectStandardError $paths.viteStderr -WindowStyle Hidden -PassThru

  $deadline = [DateTime]::UtcNow.AddSeconds(45)
  $ready = $false
  while ([DateTime]::UtcNow -lt $deadline) {
    if ($vite.HasExited) { throw "Vite exited before the audit page became ready (exit $($vite.ExitCode))." }
    try {
      $response = Invoke-WebRequest -UseBasicParsing -Uri $env:MELY_INPUT_AUDIT_URL -TimeoutSec 2
      if ($response.StatusCode -eq 200) { $ready = $true; break }
    } catch { Start-Sleep -Milliseconds 300 }
  }
  if (-not $ready) { throw "Timed out waiting for $($env:MELY_INPUT_AUDIT_URL)" }

  $parser = Start-Process -FilePath $node -ArgumentList @(
    "scripts\verify-input-fixtures.cjs"
  ) -WorkingDirectory $projectRoot -RedirectStandardOutput $paths.parserStdout -RedirectStandardError $paths.parserStderr -WindowStyle Hidden -Wait -PassThru
  $parserExitCode = $parser.ExitCode

  $browser = Start-Process -FilePath $node -ArgumentList @(
    "scripts\verify-mmd-input-audit.cjs"
  ) -WorkingDirectory $projectRoot -RedirectStandardOutput $paths.browserStdout -RedirectStandardError $paths.browserStderr -WindowStyle Hidden -Wait -PassThru
  $browserExitCode = $browser.ExitCode

  $tests = Start-Process -FilePath $node -ArgumentList @(
    "--import", "tsx", "--test",
    "tests\mmdInputFixtures.test.ts", "tests\mmdAssets.test.ts", "tests\vmdFixture.test.ts"
  ) -WorkingDirectory $projectRoot -RedirectStandardOutput $paths.testsStdout -RedirectStandardError $paths.testsStderr -WindowStyle Hidden -Wait -PassThru
  $testExitCode = $tests.ExitCode
} finally {
  if ($vite -and -not $vite.HasExited) { Stop-Process -Id $vite.Id -Force -ErrorAction SilentlyContinue }
  @{
    generatedAt = [DateTime]::UtcNow.ToString("o")
    parserExitCode = $parserExitCode
    browserExitCode = $browserExitCode
    testExitCode = $testExitCode
    reports = @{ parser = $paths.parserReport; browser = $paths.browserReport }
    logs = $paths
  } | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $paths.summary -Encoding utf8
}

Write-Output "SUMMARY=$($paths.summary)"
Write-Output "REPORT=$($paths.browserReport)"
if ($parserExitCode -ne 0 -or $browserExitCode -ne 0 -or $testExitCode -ne 0) { exit 1 }
