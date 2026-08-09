[CmdletBinding()]
param(
  [ValidateSet("local", "dev", "release")]
  [string]$Channel = "local",
  [switch]$SkipInstall,
  [switch]$SkipTests,
  [switch]$OpenOutput
)

$ErrorActionPreference = "Stop"
$OutputEncoding = [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)

$projectRoot = Split-Path -Parent $PSScriptRoot
$releaseRoot = Join-Path $projectRoot "release"

function Resolve-Tool {
  param(
    [string]$Name,
    [string[]]$Candidates = @()
  )

  $command = Get-Command $Name -CommandType Application -ErrorAction SilentlyContinue |
    Select-Object -First 1
  if ($command) { return $command.Source }

  foreach ($candidate in $Candidates) {
    if ($candidate -and (Test-Path -LiteralPath $candidate)) {
      return (Resolve-Path -LiteralPath $candidate).Path
    }
  }

  throw "Required tool was not found: $Name"
}

function Invoke-Native {
  param(
    [string]$FilePath,
    [string[]]$ArgumentList = @()
  )

  Write-Host ("> " + $FilePath + " " + ($ArgumentList -join " "))
  if ([IO.Path]::GetExtension($FilePath) -in @(".cmd", ".bat")) {
    $options = @{
      FilePath = $FilePath
      WorkingDirectory = $projectRoot
      NoNewWindow = $true
      Wait = $true
      PassThru = $true
    }
    if ($ArgumentList.Count -gt 0) { $options.ArgumentList = $ArgumentList }
    $process = Start-Process @options
    if ($process.ExitCode -ne 0) {
      throw "Command failed with exit code $($process.ExitCode): $FilePath"
    }
    return
  }

  $escapedArguments = foreach ($argument in $ArgumentList) {
    if ($argument -notmatch '[\s"]' -and $argument.Length -gt 0) {
      $argument
      continue
    }
    $escaped = [Regex]::Replace($argument, '(\\*)"', '$1$1\"')
    $escaped = [Regex]::Replace($escaped, '(\\+)$', '$1$1')
    '"' + $escaped + '"'
  }
  $startInfo = [Diagnostics.ProcessStartInfo]::new()
  $startInfo.FileName = $FilePath
  $startInfo.Arguments = $escapedArguments -join " "
  $startInfo.WorkingDirectory = $projectRoot
  $startInfo.UseShellExecute = $false
  $process = [Diagnostics.Process]::new()
  $process.StartInfo = $startInfo
  if (-not $process.Start()) {
    throw "Could not start command: $FilePath"
  }
  $process.WaitForExit()
  $exitCode = $process.ExitCode
  $process.Dispose()
  if ($exitCode -ne 0) {
    throw "Command failed with exit code ${exitCode}: $FilePath"
  }
}

function Get-NativeOutput {
  param(
    [string]$FilePath,
    [string[]]$ArgumentList = @()
  )

  $captureRoot = Join-Path $env:TEMP ("mely-native-" + [Guid]::NewGuid().ToString("N"))
  $stdoutPath = $captureRoot + ".stdout.log"
  $stderrPath = $captureRoot + ".stderr.log"
  try {
    $options = @{
      FilePath = $FilePath
      RedirectStandardOutput = $stdoutPath
      RedirectStandardError = $stderrPath
      NoNewWindow = $true
      Wait = $true
      PassThru = $true
    }
    if ($ArgumentList.Count -gt 0) { $options.ArgumentList = $ArgumentList }
    $process = Start-Process @options
    $stdout = if (Test-Path -LiteralPath $stdoutPath) {
      Get-Content -LiteralPath $stdoutPath -Raw -ErrorAction SilentlyContinue
    } else { "" }
    $stderr = if (Test-Path -LiteralPath $stderrPath) {
      Get-Content -LiteralPath $stderrPath -Raw -ErrorAction SilentlyContinue
    } else { "" }
    if ($process.ExitCode -ne 0) {
      throw "Command failed with exit code $($process.ExitCode): $FilePath`n$stderr"
    }
    return [string]$stdout
  } finally {
    Remove-Item -LiteralPath $stdoutPath, $stderrPath -Force -ErrorAction SilentlyContinue
  }
}

function Find-VsDevCmd {
  $candidates = @(
    "${env:ProgramFiles(x86)}\Microsoft Visual Studio\2022\BuildTools\Common7\Tools\VsDevCmd.bat",
    "${env:ProgramFiles(x86)}\Microsoft Visual Studio\2022\Community\Common7\Tools\VsDevCmd.bat",
    "${env:ProgramFiles(x86)}\Microsoft Visual Studio\2022\Professional\Common7\Tools\VsDevCmd.bat",
    "${env:ProgramFiles(x86)}\Microsoft Visual Studio\2022\Enterprise\Common7\Tools\VsDevCmd.bat",
    "$env:ProgramFiles\Microsoft Visual Studio\2022\BuildTools\Common7\Tools\VsDevCmd.bat",
    "$env:ProgramFiles\Microsoft Visual Studio\2022\Community\Common7\Tools\VsDevCmd.bat",
    "$env:ProgramFiles\Microsoft Visual Studio\2022\Professional\Common7\Tools\VsDevCmd.bat",
    "$env:ProgramFiles\Microsoft Visual Studio\2022\Enterprise\Common7\Tools\VsDevCmd.bat"
  )

  $known = $candidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
  if ($known) { return $known }

  $vsWhereCandidates = @(
    "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe",
    "$env:ProgramFiles\Microsoft Visual Studio\Installer\vswhere.exe"
  )
  $vsWhere = $vsWhereCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
  if ($vsWhere) {
    $installationPath = & $vsWhere -latest -products * `
      -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 `
      -property installationPath
    if ($LASTEXITCODE -eq 0 -and $installationPath) {
      $candidate = Join-Path ($installationPath | Select-Object -First 1) "Common7\Tools\VsDevCmd.bat"
      if (Test-Path -LiteralPath $candidate) { return $candidate }
    }
  }

  return $null
}

function Import-VsEnvironment {
  param([string]$VsDevCmd)

  $wrapperPath = Join-Path $env:TEMP ("mely-vs-env-" + [Guid]::NewGuid().ToString("N") + ".cmd")
  try {
    $wrapperLines = @(
      "@echo off",
      ('call "' + $VsDevCmd + '" -arch=x64 -host_arch=x64 >nul'),
      'if errorlevel 1 exit /b %ERRORLEVEL%',
      'set'
    )
    [IO.File]::WriteAllLines($wrapperPath, $wrapperLines, [Text.Encoding]::ASCII)
    $output = Get-NativeOutput $env:ComSpec @("/d", "/c", $wrapperPath)
  } finally {
    Remove-Item -LiteralPath $wrapperPath -Force -ErrorAction SilentlyContinue
  }

  foreach ($line in ($output -split "`r?`n")) {
    $separator = $line.IndexOf("=")
    if ($separator -le 0) { continue }
    $name = $line.Substring(0, $separator)
    $value = $line.Substring($separator + 1)
    [Environment]::SetEnvironmentVariable($name, $value, "Process")
  }
}

function Find-WindowsSdk {
  $kitsRoot = Join-Path ${env:ProgramFiles(x86)} "Windows Kits\10"
  $libRoot = Join-Path $kitsRoot "Lib"
  if (-not (Test-Path -LiteralPath $libRoot)) { return $null }

  $versions = Get-ChildItem -LiteralPath $libRoot -Directory -ErrorAction SilentlyContinue |
    Where-Object {
      (Test-Path -LiteralPath (Join-Path $_.FullName "um\x64\kernel32.lib")) -and
      (Test-Path -LiteralPath (Join-Path $_.FullName "ucrt\x64\ucrt.lib"))
    } |
    Sort-Object { try { [Version]$_.Name } catch { [Version]"0.0" } } -Descending

  foreach ($version in $versions) {
    $includeRoot = Join-Path $kitsRoot ("Include\" + $version.Name)
    $binRoot = Join-Path $kitsRoot ("bin\" + $version.Name + "\x64")
    if (
      (Test-Path -LiteralPath (Join-Path $includeRoot "ucrt")) -and
      (Test-Path -LiteralPath (Join-Path $includeRoot "um")) -and
      (Test-Path -LiteralPath $binRoot)
    ) {
      return [PSCustomObject]@{
        Root = $kitsRoot
        Version = $version.Name
        IncludeRoot = $includeRoot
        LibRoot = $version.FullName
        BinRoot = $binRoot
      }
    }
  }

  return $null
}

function Add-WindowsSdkEnvironment {
  param($Sdk)

  $env:WindowsSdkDir = $Sdk.Root + "\"
  $env:WindowsSDKVersion = $Sdk.Version + "\"
  $env:WindowsSDKLibVersion = $Sdk.Version + "\"
  $env:PATH = $Sdk.BinRoot + ";" + $env:PATH
  $env:INCLUDE = @(
    (Join-Path $Sdk.IncludeRoot "ucrt"),
    (Join-Path $Sdk.IncludeRoot "um"),
    (Join-Path $Sdk.IncludeRoot "shared"),
    (Join-Path $Sdk.IncludeRoot "winrt"),
    $env:INCLUDE
  ) -join ";"
  $env:LIB = @(
    (Join-Path $Sdk.LibRoot "ucrt\x64"),
    (Join-Path $Sdk.LibRoot "um\x64"),
    $env:LIB
  ) -join ";"
}

function Write-Utf8File {
  param(
    [string]$Path,
    [string]$Value
  )

  [IO.File]::WriteAllText($Path, $Value, [Text.UTF8Encoding]::new($false))
}

function Get-Sha256Line {
  param(
    [string]$Path,
    [string]$DisplayName
  )

  $hash = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
  return "$hash  $DisplayName"
}

Set-Location -LiteralPath $projectRoot

$packageJsonPath = Join-Path $projectRoot "package.json"
$tauriConfigPath = Join-Path $projectRoot "src-tauri\tauri.conf.json"
$cargoTomlPath = Join-Path $projectRoot "src-tauri\Cargo.toml"
$packageJson = Get-Content -LiteralPath $packageJsonPath -Raw | ConvertFrom-Json
$tauriConfig = Get-Content -LiteralPath $tauriConfigPath -Raw | ConvertFrom-Json
$cargoToml = Get-Content -LiteralPath $cargoTomlPath -Raw
$cargoVersionMatch = [Regex]::Match($cargoToml, '(?ms)^\[package\].*?^version\s*=\s*"([^"]+)"')

if (-not $cargoVersionMatch.Success) {
  throw "Could not read the package version from src-tauri/Cargo.toml."
}

$version = [string]$packageJson.version
$tauriVersion = [string]$tauriConfig.version
$cargoVersion = $cargoVersionMatch.Groups[1].Value
if ($version -ne $tauriVersion -or $version -ne $cargoVersion) {
  throw "Version mismatch: package.json=$version, tauri.conf.json=$tauriVersion, Cargo.toml=$cargoVersion"
}

$node = Resolve-Tool "node.exe" @(
  "$env:ProgramFiles\nodejs\node.exe",
  "$env:LOCALAPPDATA\Programs\nodejs\node.exe"
)
$npm = Resolve-Tool "npm.cmd" @(
  "$env:ProgramFiles\nodejs\npm.cmd",
  "$env:LOCALAPPDATA\Programs\nodejs\npm.cmd"
)
$cargo = Resolve-Tool "cargo.exe" @("$env:USERPROFILE\.cargo\bin\cargo.exe")
$rustc = Resolve-Tool "rustc.exe" @("$env:USERPROFILE\.cargo\bin\rustc.exe")

$nodeVersionText = (Get-NativeOutput $node @("--version")).Trim().TrimStart("v")
if (-not $nodeVersionText) {
  throw "Node.js did not return a version string: $node"
}
if ([Version]($nodeVersionText.Split("-")[0]) -lt [Version]"20.0.0") {
  throw "Node.js 20 or newer is required. Found $nodeVersionText."
}

$cargoDirectory = Split-Path -Parent $cargo
$nodeDirectory = Split-Path -Parent $node

$vsDevCmd = Find-VsDevCmd
if (-not $vsDevCmd) {
  throw "Visual Studio 2022 with the Desktop development with C++ workload was not found."
}
Import-VsEnvironment $vsDevCmd

$windowsSdk = Find-WindowsSdk
if (-not $windowsSdk) {
  throw "A complete Windows 10 or Windows 11 SDK with x64 libraries was not found."
}
Add-WindowsSdkEnvironment $windowsSdk
$env:PATH = $cargoDirectory + ";" + $nodeDirectory + ";" + $env:PATH

$link = Resolve-Tool "link.exe"
Write-Host "[MELY] Version: $version"
Write-Host "[MELY] Channel: $Channel"
Write-Host "[MELY] Node.js: $nodeVersionText"
Write-Host "[MELY] Rust: $((Get-NativeOutput $rustc @('--version')).Trim())"
Write-Host "[MELY] MSVC linker: $link"
Write-Host "[MELY] Windows SDK: $($windowsSdk.Version)"

if (-not $SkipInstall) {
  Invoke-Native $npm @("ci", "--no-audit", "--no-fund")
}

$tauriCli = Join-Path $projectRoot "node_modules\@tauri-apps\cli\tauri.js"
$typescriptCli = Join-Path $projectRoot "node_modules\typescript\bin\tsc"
$viteCli = Join-Path $projectRoot "node_modules\vite\bin\vite.js"
if (-not (Test-Path -LiteralPath $tauriCli)) {
  throw "Tauri dependencies are missing. Run npm ci or omit -SkipInstall."
}
if (-not (Test-Path -LiteralPath $typescriptCli) -or -not (Test-Path -LiteralPath $viteCli)) {
  throw "TypeScript or Vite dependencies are missing. Run npm ci or omit -SkipInstall."
}

Invoke-Native $node @($typescriptCli, "-b")
if (-not $SkipTests) {
  $testsRoot = Join-Path $projectRoot "tests"
  if (-not (Test-Path -LiteralPath $testsRoot)) {
    New-Item -ItemType Directory -Path $testsRoot -Force | Out-Null
    Write-Host "[MELY] Created missing tests directory: $testsRoot"
  }
  $testFiles = Get-ChildItem -LiteralPath $testsRoot -Filter "*.test.ts" -File |
    Sort-Object Name |
    Select-Object -ExpandProperty FullName
  if ($testFiles) {
    $testArguments = @("--import", "tsx", "--test", "--test-concurrency=1") + @($testFiles)
    Invoke-Native $node $testArguments
  } else {
    Write-Warning "The tests directory contains no *.test.ts files. Continuing without tests."
  }
}
Invoke-Native $node @($viteCli, "build", "--config", "vite.config.ts")

$tauriOverride = Join-Path $env:TEMP ("mely-tauri-release-" + [Guid]::NewGuid().ToString("N") + ".json")
try {
  Write-Utf8File $tauriOverride '{"build":{"beforeBuildCommand":""},"bundle":{"targets":["nsis"]}}'
  Invoke-Native $node @(
    $tauriCli,
    "build",
    "--ci",
    "--config",
    $tauriOverride
  )
} finally {
  Remove-Item -LiteralPath $tauriOverride -Force -ErrorAction SilentlyContinue
}

$builtExecutable = Join-Path $projectRoot "src-tauri\target\release\mely.exe"
$installerSource = Get-ChildItem -LiteralPath (Join-Path $projectRoot "src-tauri\target\release\bundle\nsis") `
  -Filter "*.exe" -File |
  Sort-Object LastWriteTimeUtc -Descending |
  Select-Object -First 1

if (-not (Test-Path -LiteralPath $builtExecutable)) {
  throw "Tauri did not produce the expected desktop executable."
}
if (-not $installerSource) {
  throw "Tauri did not produce an NSIS installer."
}

$artifactVersion = if ($Channel -eq "dev") { "dev" } else { $version }
$artifactPrefix = "MELY-$artifactVersion-windows-x64"
$portableName = "$artifactPrefix-portable"
$portableStageParent = Join-Path $env:TEMP ("mely-release-stage-" + [Guid]::NewGuid().ToString("N"))
$portableRoot = Join-Path $portableStageParent $portableName
$portableExecutable = Join-Path $portableRoot "MELY.exe"
$portableReadme = Join-Path $portableRoot "README.txt"
$portableChecksums = Join-Path $portableRoot "SHA256SUMS.txt"
$portableZip = Join-Path $releaseRoot ($portableName + ".zip")
$installerOutput = Join-Path $releaseRoot ($artifactPrefix + "-setup.exe")
$checksumsOutput = Join-Path $releaseRoot ($artifactPrefix + "-SHA256SUMS.txt")

New-Item -ItemType Directory -Force -Path $releaseRoot, $portableRoot | Out-Null
try {
  Copy-Item -LiteralPath $builtExecutable -Destination $portableExecutable -Force
  Copy-Item -LiteralPath $installerSource.FullName -Destination $installerOutput -Force

  $portableNotes = @"
MELY $version Windows x64 Portable

Start: double-click MELY.exe.

Requirements:
- Windows 10 or Windows 11, 64-bit
- Microsoft Edge WebView2 Runtime (normally included with current Windows)

This packaged application does not require Node.js. Node.js 20 or newer is
only required when developing or rebuilding MELY from source.

Build channel: $Channel
"@
  Write-Utf8File $portableReadme $portableNotes
  Write-Utf8File $portableChecksums ((Get-Sha256Line $portableExecutable "MELY.exe") + [Environment]::NewLine)
  Compress-Archive -LiteralPath $portableRoot -DestinationPath $portableZip -CompressionLevel Optimal -Force
} finally {
  Remove-Item -LiteralPath $portableStageParent -Recurse -Force -ErrorAction SilentlyContinue
}

$checksumLines = @(
  (Get-Sha256Line $portableZip (Split-Path -Leaf $portableZip)),
  (Get-Sha256Line $installerOutput (Split-Path -Leaf $installerOutput))
)
Write-Utf8File $checksumsOutput (($checksumLines -join [Environment]::NewLine) + [Environment]::NewLine)

Write-Host ""
Write-Host "[MELY] Windows release build completed."
Write-Host "[MELY] Portable ZIP: $portableZip"
Write-Host "[MELY] NSIS installer: $installerOutput"
Write-Host "[MELY] SHA-256: $checksumsOutput"

if ($OpenOutput) {
  Start-Process explorer.exe -ArgumentList $releaseRoot
}
