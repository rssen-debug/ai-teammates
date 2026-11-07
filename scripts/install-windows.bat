@echo off
setlocal
title MAJIN 0.1.1 - build MAJIN-Setup.exe
cd /d "%~dp0"
echo.
echo   ==========================================================
echo    MAJIN 0.1.1  -  build and install on Windows
echo   ==========================================================
echo.
echo   This window stays open until the build is finished.
echo   First run: npm downloads the build tools, then the program and
echo   the installer are built, then MAJIN is really installed, started,
echo   checked, uninstalled and installed again. A few minutes.
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0INSTALL.ps1" -NoPause
set RC=%ERRORLEVEL%
echo.
if "%RC%"=="0" (
  echo   DONE. The folder with MAJIN-Setup.exe is opening now.
  start "" explorer /select,"%LOCALAPPDATA%\MAJIN\src\dist\installer\MAJIN-Setup.exe"
) else (
  echo   FAILED, code %RC%. Scroll up for the red FAIL line - that is the
  echo   reason, in words. The full log is INSTALL-log.txt next to this file.
)
echo.
pause
exit /b %RC%
