@echo off
setlocal
call "%~dp0MELY.bat" %*
set "MELY_EXIT=%ERRORLEVEL%"
endlocal & exit /b %MELY_EXIT%
