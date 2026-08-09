@echo off
setlocal EnableExtensions EnableDelayedExpansion
pushd "%~dp0" >nul 2>&1
if errorlevel 1 (
  echo [MELY] Could not enter the application directory.
  pause
  exit /b 1
)

title MELY Launcher

set "MELY_MODE=auto"
if /i "%~1"=="--web" (
  set "MELY_MODE=web"
  shift
) else if /i "%~1"=="--dev" (
  set "MELY_MODE=dev"
  shift
)

if /i "%MELY_MODE%"=="web" goto require_node
if /i "%MELY_MODE%"=="dev" goto require_node

call :find_packaged_executable
if defined MELY_EXE goto packaged_mode

echo [MELY] No packaged desktop application was found.
echo [MELY] Checking whether a local development or Web runtime is available...
echo.
goto require_node

:packaged_mode
title MELY
for %%I in ("%MELY_EXE%") do set "MELY_EXE_DIR=%%~dpI"
echo [MELY] Starting packaged desktop application...
echo [MELY] Executable: "%MELY_EXE%"
start "" /D "%MELY_EXE_DIR%" "%MELY_EXE%" %*
set "MELY_EXIT=!ERRORLEVEL!"
goto finish

:require_node
set "MELY_NODE="
for /f "delims=" %%I in ('where node.exe 2^>nul') do if not defined MELY_NODE set "MELY_NODE=%%I"
if not defined MELY_NODE if exist "%ProgramFiles%\nodejs\node.exe" set "MELY_NODE=%ProgramFiles%\nodejs\node.exe"
if not defined MELY_NODE if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "MELY_NODE=%LOCALAPPDATA%\Programs\nodejs\node.exe"
if not defined MELY_NODE if exist "%LOCALAPPDATA%\nodejs\node.exe" set "MELY_NODE=%LOCALAPPDATA%\nodejs\node.exe"

if not defined MELY_NODE (
  echo [MELY] Node.js was not found.
  if /i "%MELY_MODE%"=="auto" echo [MELY] Install a packaged MELY build, or install Node.js 20 or newer for Web mode.
  if /i not "%MELY_MODE%"=="auto" echo [MELY] Install Node.js 20 or newer, then run this mode again.
  echo https://nodejs.org/
  set "MELY_EXIT=1"
  goto finish
)

for %%I in ("%MELY_NODE%") do set "PATH=%%~dpI;%PATH%"

set "MELY_NPM="
for /f "delims=" %%I in ('where npm.cmd 2^>nul') do if not defined MELY_NPM set "MELY_NPM=%%I"
if not defined MELY_NPM if exist "%ProgramFiles%\nodejs\npm.cmd" set "MELY_NPM=%ProgramFiles%\nodejs\npm.cmd"
if not defined MELY_NPM (
  echo [MELY] npm was not found next to the Node.js installation.
  echo [MELY] Reinstall Node.js 20 or newer, then run this mode again.
  set "MELY_EXIT=1"
  goto finish
)

if /i "%MELY_MODE%"=="web" goto web_mode

set "MELY_CARGO="
for /f "delims=" %%I in ('where cargo.exe 2^>nul') do if not defined MELY_CARGO set "MELY_CARGO=%%I"
if not defined MELY_CARGO if exist "%USERPROFILE%\.cargo\bin\cargo.exe" set "MELY_CARGO=%USERPROFILE%\.cargo\bin\cargo.exe"

if not exist "%~dp0node_modules\@tauri-apps\cli\package.json" (
  echo [MELY] Tauri dependencies are not installed.
  echo [MELY] Run "npm install" after installing the desktop prerequisites.
  goto desktop_unavailable
)

if not defined MELY_CARGO (
  echo [MELY] Rust/Cargo was not found. The desktop development runtime cannot start.
  echo [MELY] Install Rust from https://rustup.rs/ and the Microsoft C++ Build Tools.
  goto desktop_unavailable
)

for %%I in ("%MELY_CARGO%") do set "PATH=%%~dpI;!PATH!"
"%MELY_CARGO%" --version >nul 2>&1
if errorlevel 1 (
  echo [MELY] Cargo is present, but no usable Rust toolchain is installed.
  echo [MELY] Run "rustup default stable-msvc", then try again.
  goto desktop_unavailable
)

set "MELY_VSWHERE=%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe"
if not exist "%MELY_VSWHERE%" set "MELY_VSWHERE=%ProgramFiles%\Microsoft Visual Studio\Installer\vswhere.exe"
if not exist "%MELY_VSWHERE%" (
  echo [MELY] Microsoft C++ Build Tools were not found.
  echo [MELY] Install the "Desktop development with C++" workload for Tauri.
  goto desktop_unavailable
)
set "MELY_MSVC="
for /f "usebackq delims=" %%I in (`"%MELY_VSWHERE%" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath 2^>nul`) do if not defined MELY_MSVC set "MELY_MSVC=%%I"
if not defined MELY_MSVC (
  echo [MELY] Visual Studio is installed without the required C++ build tools.
  echo [MELY] Add the "Desktop development with C++" workload for Tauri.
  goto desktop_unavailable
)

title MELY Desktop Development Runtime
echo [MELY] Starting the Tauri desktop development runtime...
call "%MELY_NPM%" run dev:desktop %*
set "MELY_EXIT=!ERRORLEVEL!"
goto finish

:desktop_unavailable
if /i "%MELY_MODE%"=="dev" (
  set "MELY_EXIT=1"
  goto finish
)
echo [MELY] Falling back to the browser runtime.
echo [MELY] Use "MELY.bat --web" to start Web mode directly.
echo.

:web_mode
title MELY Web Runtime
"%MELY_NODE%" "%~dp0scripts\start-web.mjs" %*
set "MELY_EXIT=!ERRORLEVEL!"
goto finish

:find_packaged_executable
set "MELY_EXE="
call :consider_executable "%~dp0MELY.exe"
call :consider_executable "%~dp0src-tauri\target\release\MELY.exe"
if defined LOCALAPPDATA call :consider_executable "%LOCALAPPDATA%\MELY\MELY.exe"
if defined LOCALAPPDATA call :consider_executable "%LOCALAPPDATA%\Programs\MELY\MELY.exe"
if defined ProgramFiles call :consider_executable "%ProgramFiles%\MELY\MELY.exe"
if defined ProgramW6432 call :consider_executable "%ProgramW6432%\MELY\MELY.exe"
call :consider_executable "%ProgramFiles(x86)%\MELY\MELY.exe"
if defined MELY_EXE exit /b 0
for /f "delims=" %%I in ('where MELY.exe 2^>nul') do if not defined MELY_EXE call :consider_executable "%%I"
exit /b 0

:consider_executable
if defined MELY_EXE exit /b 0
if exist "%~1" for %%I in ("%~1") do set "MELY_EXE=%%~fI"
exit /b 0

:finish
if not defined MELY_EXIT set "MELY_EXIT=0"
popd

if not "!MELY_EXIT!"=="0" (
  echo.
  echo [MELY] Startup failed. Review the message above.
  pause
)

endlocal & exit /b %MELY_EXIT%
