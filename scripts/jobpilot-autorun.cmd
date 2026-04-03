@echo off
setlocal
powershell.exe -ExecutionPolicy Bypass -File "%~dp0jobpilot-autorun.ps1"
set "EXITCODE=%ERRORLEVEL%"
if not "%EXITCODE%"=="0" (
  echo.
  echo JobPilot autorun failed with exit code %EXITCODE%.
  pause
)
endlocal
exit /b %EXITCODE%
