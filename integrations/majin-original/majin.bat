@echo off
rem MAJIN — bogyttan: majin.bat doctor / majin.bat send "..." / majin.bat re fil.exe
setlocal
if "%MAJIN_HOME%"=="" set "MAJIN_HOME=%LOCALAPPDATA%\MAJIN"
cd /d "%~dp0"
node "bin\majin.mjs" %*
endlocal
