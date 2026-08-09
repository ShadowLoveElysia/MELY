@echo off
setlocal
call "%~dp0Build MELY.bat" %*
set "MELY_EXIT=%ERRORLEVEL%"
endlocal & exit /b %MELY_EXIT%
