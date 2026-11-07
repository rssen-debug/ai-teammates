@echo off
rem ============================================================
rem  MAJIN — start the agent on Windows (double-click this file)
rem  The agent runs in Node; the window is an Edge app window.
rem ============================================================
setlocal EnableExtensions
title MAJIN
if "%MAJIN_HOME%"=="" set "MAJIN_HOME=%LOCALAPPDATA%\MAJIN"
rem Preserve the configured MAJIN_CONFIG override.
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   MAJIN behover Node 22 eller senare.
  echo   Installera med:  winget install OpenJS.NodeJS.LTS
  echo   Close this window, open a new one and run it again.
  echo.
  pause
  exit /b 1
)

for /f "usebackq tokens=1 delims=" %%v in (`node -v`) do set "NODEV=%%v"
set "NODEV=%NODEV:v=%"
for /f "tokens=1,2 delims=." %%a in ("%NODEV%") do (
  set "MAJOR=%%a"
  set "MINOR=%%b"
)
if %MAJOR% LSS 22 goto :toogame
goto :run

:toogame
echo.
echo   Node %NODEV% ar for gammal for MAJIN (kraver 22+).
echo   hamta ny: https://nodejs.org/   eller   winget install OpenJS.NodeJS.LTS
echo.
pause
exit /b 1

:run
echo.
echo   MAJIN V4 · data: %MAJIN_HOME%
echo   (Ctrl+C stoppar agenten. For fonsk utan start: majin start --no-window)
echo.
node "bin\majin.mjs" start %*
if errorlevel 1 (
  echo.
  echo   MAJIN avslutade med fel. Kor sjalvtest:
  node "bin\majin.mjs" doctor
  echo.
  pause
)
endlocal
