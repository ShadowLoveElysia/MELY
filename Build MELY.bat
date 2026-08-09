@echo off
setlocal EnableExtensions
pushd "%~dp0" >nul 2>&1
if errorlevel 1 (
  echo [MELY] Could not enter the project directory.
  pause
  exit /b 1
)

title MELY Windows Release Build
echo [MELY] Building the Windows portable package and NSIS installer...
echo.

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\build-windows-release.ps1" -Channel local -OpenOutput %*
set "MELY_EXIT=%ERRORLEVEL%"

echo.
if "%MELY_EXIT%"=="0" (
  echo [MELY] Build completed. Artifacts are in "%~dp0release".
) else (
  echo [MELY] Build failed with exit code %MELY_EXIT%.
)

popd
if not defined MELY_NO_PAUSE pause
endlocal & exit /b %MELY_EXIT%
