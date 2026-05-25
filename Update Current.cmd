@echo off
setlocal

cd /d "%~dp0"
node "%~dp0update-current-server.mjs" --no-pause %*
set "CURRENT_EXIT_CODE=%ERRORLEVEL%"

echo.
if "%CURRENT_EXIT_CODE%"=="0" (
  echo Current updater is complete.
) else (
  echo Current updater stopped with exit code %CURRENT_EXIT_CODE%.
)
pause
exit /b %CURRENT_EXIT_CODE%
