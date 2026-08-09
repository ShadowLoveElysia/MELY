param(
  [ValidateSet("Probe", "Build")]
  [string]$Phase = "Probe"
)

$ErrorActionPreference = "Stop"
$OutputEncoding = [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)

$projectRoot = Split-Path -Parent $PSScriptRoot
$outputRoot = Join-Path $projectRoot "release-validation"
New-Item -ItemType Directory -Force -Path $outputRoot | Out-Null

function Write-Utf8Line {
  param([string]$Path, [string]$Value)
  Add-Content -LiteralPath $Path -Value $Value -Encoding utf8
}

function Invoke-Captured {
  param(
    [string]$FilePath,
    [string[]]$ArgumentList,
    [string]$LogPath
  )

  Write-Utf8Line $LogPath ("> " + $FilePath + " " + ($ArgumentList -join " "))
  $captureId = [Guid]::NewGuid().ToString("N")
  $stdoutPath = Join-Path $outputRoot ($captureId + ".stdout.log")
  $stderrPath = Join-Path $outputRoot ($captureId + ".stderr.log")
  try {
    $processOptions = @{
      FilePath = $FilePath
      WorkingDirectory = $projectRoot
      RedirectStandardOutput = $stdoutPath
      RedirectStandardError = $stderrPath
      WindowStyle = "Hidden"
      Wait = $true
      PassThru = $true
    }
    if ($ArgumentList.Count -gt 0) { $processOptions.ArgumentList = $ArgumentList }
    $process = Start-Process @processOptions
    foreach ($capturePath in @($stdoutPath, $stderrPath)) {
      if (Test-Path -LiteralPath $capturePath) {
        $output = Get-Content -LiteralPath $capturePath -Raw -ErrorAction SilentlyContinue
        if ($output) { Write-Utf8Line $LogPath $output.TrimEnd() }
      }
    }
    $exitCode = $process.ExitCode
  } catch {
    Write-Utf8Line $LogPath $_.Exception.ToString()
    $exitCode = 1
  } finally {
    Remove-Item -LiteralPath $stdoutPath, $stderrPath -ErrorAction SilentlyContinue
  }
  Write-Utf8Line $LogPath ("EXIT=" + $exitCode)
  return $exitCode
}

function Find-VsDevCmd {
  $candidates = @(
    "${env:ProgramFiles(x86)}\Microsoft Visual Studio\2022\BuildTools\Common7\Tools\VsDevCmd.bat",
    "$env:ProgramFiles\Microsoft Visual Studio\2022\BuildTools\Common7\Tools\VsDevCmd.bat",
    "$env:ProgramFiles\Microsoft Visual Studio\2022\Community\Common7\Tools\VsDevCmd.bat",
    "$env:ProgramFiles\Microsoft Visual Studio\2022\Professional\Common7\Tools\VsDevCmd.bat",
    "$env:ProgramFiles\Microsoft Visual Studio\2022\Enterprise\Common7\Tools\VsDevCmd.bat",
    "${env:ProgramFiles(x86)}\Microsoft Visual Studio\2019\BuildTools\Common7\Tools\VsDevCmd.bat"
  )
  $known = $candidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
  if ($known) { return $known }
  foreach ($root in @(
    "$env:ProgramFiles\Microsoft Visual Studio",
    "${env:ProgramFiles(x86)}\Microsoft Visual Studio"
  )) {
    if (Test-Path -LiteralPath $root) {
      $found = Get-ChildItem -LiteralPath $root -Filter VsDevCmd.bat -File -Recurse -ErrorAction SilentlyContinue |
        Select-Object -ExpandProperty FullName -First 1
      if ($found) { return $found }
    }
  }
  return $null
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
    $binX64 = Join-Path $kitsRoot ("bin\" + $version.Name + "\x64")
    if (
      (Test-Path -LiteralPath (Join-Path $includeRoot "ucrt")) -and
      (Test-Path -LiteralPath (Join-Path $includeRoot "um")) -and
      (Test-Path -LiteralPath $binX64)
    ) {
      return [PSCustomObject]@{
        Root = $kitsRoot
        Version = $version.Name
        IncludeRoot = $includeRoot
        LibRoot = $version.FullName
        BinX64 = $binX64
      }
    }
  }
  return $null
}

function Invoke-Probe {
  $log = Join-Path $outputRoot "toolchain.log"
  Remove-Item -LiteralPath $log -ErrorAction SilentlyContinue
  Write-Utf8Line $log ("PROJECT=" + $projectRoot)
  Write-Utf8Line $log ("WINDOWS=" + [Environment]::OSVersion.VersionString)
  Write-Utf8Line $log ("ARCH=" + [Runtime.InteropServices.RuntimeInformation]::OSArchitecture)

  $node = "C:\Program Files\nodejs\node.exe"
  $npm = "C:\Program Files\nodejs\npm.cmd"
  $cargo = Join-Path $env:USERPROFILE ".cargo\bin\cargo.exe"
  $rustc = Join-Path $env:USERPROFILE ".cargo\bin\rustc.exe"
  foreach ($tool in @($node, $npm, $cargo, $rustc)) {
    Write-Utf8Line $log ("EXISTS " + $tool + "=" + (Test-Path -LiteralPath $tool))
  }
  if (Test-Path -LiteralPath $node) { Invoke-Captured $node @("--version") $log | Out-Null }
  if (Test-Path -LiteralPath $npm) { Invoke-Captured $npm @("--version") $log | Out-Null }
  if (Test-Path -LiteralPath $cargo) { Invoke-Captured $cargo @("--version") $log | Out-Null }
  if (Test-Path -LiteralPath $rustc) { Invoke-Captured $rustc @("--version", "--verbose") $log | Out-Null }
  $tauriShim = Join-Path $projectRoot "node_modules\.bin\tauri.cmd"
  $tauriScript = Join-Path $projectRoot "node_modules\@tauri-apps\cli\tauri.js"
  Write-Utf8Line $log ("EXISTS " + $tauriShim + "=" + (Test-Path -LiteralPath $tauriShim))
  Write-Utf8Line $log ("EXISTS " + $tauriScript + "=" + (Test-Path -LiteralPath $tauriScript))
  if (Test-Path -LiteralPath $tauriShim) { Invoke-Captured $tauriShim @("--version") $log | Out-Null }
  if ((Test-Path -LiteralPath $node) -and (Test-Path -LiteralPath $tauriScript)) {
    Invoke-Captured $node @($tauriScript, "--version") $log | Out-Null
  }

  $vsDevCmd = Find-VsDevCmd
  $vsDevCmdLabel = if ($vsDevCmd) { $vsDevCmd } else { "MISSING" }
  Write-Utf8Line $log ("VSDEVCMD=" + $vsDevCmdLabel)
  $windowsSdk = Find-WindowsSdk
  $windowsSdkLabel = if ($windowsSdk) { $windowsSdk.Version } else { "MISSING" }
  Write-Utf8Line $log ("WINDOWS_SDK=" + $windowsSdkLabel)
  $webView = Get-ItemProperty @(
    "HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\*",
    "HKCU:\SOFTWARE\Microsoft\EdgeUpdate\Clients\*"
  ) -ErrorAction SilentlyContinue | Where-Object { $_.name -match "WebView2" } | Select-Object -First 1
  $webViewVersion = if ($webView -and $webView.pv) { $webView.pv } else { "MISSING" }
  Write-Utf8Line $log ("WEBVIEW2=" + $webViewVersion)
  Write-Output $log
}

function Invoke-Build {
  $log = Join-Path $outputRoot "tauri-build.log"
  Remove-Item -LiteralPath $log -ErrorAction SilentlyContinue
  Set-Location -LiteralPath $projectRoot

  $wrapper = Join-Path $outputRoot "run-tauri-build.cmd"
  $tauriOverride = Join-Path $outputRoot "tauri.validation.conf.json"
  [IO.File]::WriteAllText(
    $tauriOverride,
    '{"build":{"beforeBuildCommand":""},"bundle":{"targets":["nsis"]}}',
    [Text.UTF8Encoding]::new($false)
  )
  $tauriCommand = '"C:\Program Files\nodejs\node.exe" "node_modules\@tauri-apps\cli\tauri.js" build --ci --runner "%USERPROFILE%\.cargo\bin\cargo.exe" --config "release-validation\tauri.validation.conf.json"'
  $lines = @(
    "@echo off",
    "setlocal EnableExtensions",
    'set "PATH=C:\Windows\System32;C:\Windows;C:\Windows\System32\Wbem;C:\Program Files\nodejs;%USERPROFILE%\.cargo\bin;%PATH%"',
    'cd /d "%~dp0.."',
    'echo PROJECT=%CD%',
    'echo PATH=%PATH%',
    '"C:\Windows\System32\where.exe" node.exe',
    '"C:\Windows\System32\where.exe" npm.cmd',
    '"C:\Windows\System32\where.exe" cargo.exe',
    '"C:\Program Files\nodejs\node.exe" "node_modules\typescript\bin\tsc" -b',
    'if errorlevel 1 exit /b %ERRORLEVEL%',
    '"C:\Program Files\nodejs\node.exe" "node_modules\vite\bin\vite.js" build --config vite.config.ts',
    'if errorlevel 1 exit /b %ERRORLEVEL%',
    $tauriCommand,
    "exit /b %ERRORLEVEL%"
  )
  $vsDevCmd = Find-VsDevCmd
  $environmentLines = @()
  if ($vsDevCmd) {
    $vsSetupLines = @(
      ('call "' + $vsDevCmd + '" -arch=x64 -host_arch=x64'),
      'if errorlevel 1 exit /b %ERRORLEVEL%',
      '"C:\Windows\System32\where.exe" link.exe',
      'if errorlevel 1 exit /b %ERRORLEVEL%',
      'if not defined LIB exit /b 1'
    )
    $environmentLines += $vsSetupLines
  }
  $windowsSdk = Find-WindowsSdk
  if (-not $windowsSdk) {
    throw "A complete Windows 10/11 SDK with x64 libraries was not found."
  }
  $sdkEnvironmentLines = @(
    ('set "WindowsSdkDir=' + $windowsSdk.Root + '\"'),
    ('set "WindowsSDKVersion=' + $windowsSdk.Version + '\"'),
    ('set "WindowsSDKLibVersion=' + $windowsSdk.Version + '\"'),
    ('set "PATH=' + $windowsSdk.BinX64 + ';%PATH%"'),
    ('set "INCLUDE=' + $windowsSdk.IncludeRoot + '\ucrt;' + $windowsSdk.IncludeRoot + '\um;' + $windowsSdk.IncludeRoot + '\shared;' + $windowsSdk.IncludeRoot + '\winrt;%INCLUDE%"'),
    ('set "LIB=' + $windowsSdk.LibRoot + '\ucrt\x64;' + $windowsSdk.LibRoot + '\um\x64;%LIB%"'),
    'if not exist "%WindowsSdkDir%Lib\%WindowsSDKLibVersion%\um\x64\kernel32.lib" exit /b 1'
  )
  $environmentLines += $sdkEnvironmentLines
  $lines = @($lines[0..3]) + $environmentLines + @($lines[4..($lines.Length - 1)])
  [IO.File]::WriteAllLines($wrapper, $lines, [Text.Encoding]::ASCII)
  $exitCode = Invoke-Captured $wrapper @() $log
  Write-Output ("LOG=" + $log)
  Write-Output ("EXIT=" + $exitCode)
  exit $exitCode
}

if ($Phase -eq "Probe") {
  Invoke-Probe
} else {
  Invoke-Build
}
