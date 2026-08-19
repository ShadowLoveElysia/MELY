param(
  [string]$ModelPath = "",
  [int]$Port = 4221,
  [string]$OutputDirectory = ""
)

$ErrorActionPreference = "Stop"
$OutputEncoding = [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$projectRoot = Split-Path -Parent $PSScriptRoot
if (-not $OutputDirectory) {
  $OutputDirectory = Join-Path $projectRoot "release-validation\model-part-selection"
}

$nodeCandidates = @(
  "C:\Program Files\nodejs\node.exe",
  "C:\Users\q3238\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
)
$node = $nodeCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
$edge = "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
$playwright = Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies\node\node_modules\playwright"
foreach ($required in @($node, $edge, $playwright)) {
  if (-not $required -or -not (Test-Path -LiteralPath $required)) {
    throw "Required Windows validation path is missing: $required"
  }
}

New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null
if (-not $ModelPath) {
  $ModelPath = Join-Path $OutputDirectory "mely-model-part-selection-e2e.pmd"
  $fixtureScript = Join-Path ([IO.Path]::GetTempPath()) `
    "mely-generate-model-part-selection-fixture.cjs"
  $fixtureSource = @'
const { writeModelPartSelectionPmd } = require(process.argv[2]);
writeModelPartSelectionPmd(process.argv[3]).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
'@
  try {
    [IO.File]::WriteAllText($fixtureScript, $fixtureSource, [Text.UTF8Encoding]::new($false))
    & $node $fixtureScript (Join-Path $projectRoot "scripts\fixtures\generate-minimal-pmd.cjs") $ModelPath
    if ($LASTEXITCODE -ne 0) {
      throw "Failed to generate the deterministic two-material PMD fixture."
    }
  } finally {
    Remove-Item -LiteralPath $fixtureScript -ErrorAction SilentlyContinue
  }
}
if (-not (Test-Path -LiteralPath $ModelPath -PathType Leaf)) {
  throw "Model path is missing: $ModelPath"
}

$viteStdout = Join-Path $OutputDirectory "vite.stdout.log"
$viteStderr = Join-Path $OutputDirectory "vite.stderr.log"
$auditStdout = Join-Path $OutputDirectory "audit.stdout.log"
$auditStderr = Join-Path $OutputDirectory "audit.stderr.log"
$report = Join-Path $OutputDirectory "report.json"
Remove-Item -LiteralPath $viteStdout, $viteStderr, $auditStdout, $auditStderr, $report `
  -ErrorAction SilentlyContinue

$env:MELY_MODEL_PATH = (Resolve-Path -LiteralPath $ModelPath).Path
$env:MELY_OUTPUT_DIRECTORY = $OutputDirectory
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
  ) -WorkingDirectory $projectRoot -RedirectStandardOutput $viteStdout `
    -RedirectStandardError $viteStderr -WindowStyle Hidden -PassThru

  $deadline = [DateTime]::UtcNow.AddSeconds(60)
  $ready = $false
  while ([DateTime]::UtcNow -lt $deadline) {
    if ($vite.HasExited) {
      throw "Vite exited before MELY became ready (exit $($vite.ExitCode))."
    }
    try {
      $response = Invoke-WebRequest -UseBasicParsing -Uri $env:MELY_URL -TimeoutSec 2
      if ($response.StatusCode -eq 200) { $ready = $true; break }
    } catch {
      Start-Sleep -Milliseconds 300
    }
  }
  if (-not $ready) { throw "Timed out waiting for $($env:MELY_URL)" }

  $audit = Start-Process -FilePath $node -ArgumentList @(
    "scripts\verify-model-part-selection.cjs"
  ) -WorkingDirectory $projectRoot -RedirectStandardOutput $auditStdout `
    -RedirectStandardError $auditStderr -WindowStyle Hidden -Wait -PassThru
  $auditExitCode = $audit.ExitCode
} finally {
  if ($vite -and -not $vite.HasExited) {
    Stop-Process -Id $vite.Id -Force -ErrorAction SilentlyContinue
  }
}

Write-Output "REPORT=$report"
if ($auditExitCode -ne 0) { exit 1 }
