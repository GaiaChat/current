@echo off
setlocal

cd /d "%~dp0"
node "%~dp0scripts\install-local-current.mjs" %*
set "CURRENT_EXIT_CODE=%ERRORLEVEL%"

echo.
if "%CURRENT_EXIT_CODE%"=="0" (
  echo Current setup is complete. You can now run Current Server.cmd.
) else (
  echo Current setup stopped with exit code %CURRENT_EXIT_CODE%.
)
pause
exit /b %CURRENT_EXIT_CODE%
