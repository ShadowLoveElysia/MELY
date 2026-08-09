param(
  [string]$OutputDirectory = ""
)

$ErrorActionPreference = "Stop"
$OutputEncoding = [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)

$projectRoot = Split-Path -Parent $PSScriptRoot
if (-not $OutputDirectory) {
  $OutputDirectory = Join-Path $projectRoot "release-validation\web-final"
}
New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null

$nodeCandidates = @(
  "C:\Program Files\nodejs\node.exe",
  "C:\Users\q3238\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
)
$node = $nodeCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (-not $node -or -not (Test-Path -LiteralPath $node)) {
  throw "A Windows Node.js runtime is required."
}

$testFiles = @(
  Get-ChildItem -LiteralPath (Join-Path $projectRoot "tests") -Filter "*.test.ts" -File |
    Sort-Object Name |
    ForEach-Object { "tests\$($_.Name)" }
)
if ($testFiles.Count -eq 0) { throw "No test files were discovered." }

function Invoke-ValidationStage {
  param(
    [string]$Name,
    [string[]]$Arguments
  )

  $stdout = Join-Path $OutputDirectory "$Name.stdout.log"
  $stderr = Join-Path $OutputDirectory "$Name.stderr.log"
  Remove-Item -LiteralPath $stdout, $stderr -ErrorAction SilentlyContinue
  $startedAt = [DateTime]::UtcNow
  $process = Start-Process -FilePath $node -ArgumentList $Arguments `
    -WorkingDirectory $projectRoot `
    -RedirectStandardOutput $stdout `
    -RedirectStandardError $stderr `
    -WindowStyle Hidden `
    -Wait `
    -PassThru
  $finishedAt = [DateTime]::UtcNow
  return [ordered]@{
    name = $Name
    command = @($node) + $Arguments
    exitCode = $process.ExitCode
    startedAt = $startedAt.ToString("o")
    finishedAt = $finishedAt.ToString("o")
    durationMs = [Math]::Round(($finishedAt - $startedAt).TotalMilliseconds)
    stdout = $stdout
    stderr = $stderr
  }
}

function Read-TestSummary {
  param([string]$Path)

  if (-not (Test-Path -LiteralPath $Path)) { return $null }
  $content = [IO.File]::ReadAllText($Path)
  $summary = [ordered]@{}
  foreach ($name in @("tests", "suites", "pass", "fail", "cancelled", "skipped", "todo", "duration_ms")) {
    $match = [Text.RegularExpressions.Regex]::Match(
      $content,
      "(?m)^# $name ([0-9]+(?:\.[0-9]+)?)\s*$"
    )
    if ($match.Success) {
      $summary[$name] = if ($name -eq "duration_ms") {
        [double]$match.Groups[1].Value
      } else {
        [int]$match.Groups[1].Value
      }
    }
  }
  return $summary
}

$stages = @()
$stages += Invoke-ValidationStage "typecheck" @("node_modules\typescript\bin\tsc", "-b")
if ($stages[-1].exitCode -eq 0) {
  $testArguments = @(
    "--import", "tsx", "--test", "--test-concurrency=1", "--test-reporter=tap"
  ) + $testFiles
  $stages += Invoke-ValidationStage "tests" $testArguments
}
if ($stages[-1].exitCode -eq 0) {
  $stages += Invoke-ValidationStage "vite" @(
    "node_modules\vite\bin\vite.js", "build", "--config", "vite.config.ts"
  )
}

$failedStage = $stages | Where-Object { $_.exitCode -ne 0 } | Select-Object -First 1
$testStage = $stages | Where-Object { $_.name -eq "tests" } | Select-Object -First 1
$testSummary = if ($testStage) { Read-TestSummary $testStage.stdout } else { $null }
$report = [ordered]@{
  generatedAt = [DateTime]::UtcNow.ToString("o")
  projectRoot = $projectRoot
  node = $node
  passed = -not $failedStage
  failedStage = if ($failedStage) { $failedStage.name } else { $null }
  testFileCount = $testFiles.Count
  testFiles = $testFiles
  testSummary = $testSummary
  stages = $stages
}
$reportPath = Join-Path $OutputDirectory "report.json"
[IO.File]::WriteAllText(
  $reportPath,
  ($report | ConvertTo-Json -Depth 8) + "`n",
  [Text.UTF8Encoding]::new($false)
)

Write-Output "REPORT=$reportPath"
if ($failedStage) { exit $failedStage.exitCode }
