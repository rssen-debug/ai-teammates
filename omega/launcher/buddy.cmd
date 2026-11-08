@echo off
rem ═══════════════════════════════════════════════════════════════════════════
rem  STUDDY BUDDY OMEGA — Windows launcher
rem
rem  This is what the installer puts on PATH as `buddy`. Its only job is to find
rem  a suitable CPython and hand every argument through to omega\buddy.py.
rem
rem  Two rules it must never break, both learned from a real failure:
rem    1. NEVER hardcode a Python version. The previous installer demanded 3.12
rem       specifically and broke on every machine that had 3.11 or 3.13. The
rem       product needs >=3.10 and that is the only floor enforced here.
rem    2. NEVER hardcode a machine-specific path. Everything is resolved relative
rem       to this file, or read from install-manifest.json.
rem ═══════════════════════════════════════════════════════════════════════════
setlocal EnableExtensions EnableDelayedExpansion

set "HERE=%~dp0"
set "OMEGA=%HERE%.."
set "TARGET=%OMEGA%\buddy.py"

if not exist "%TARGET%" (
  echo buddy: cannot find %TARGET% 1>&2
  echo        the launcher must sit in omega\launcher\ next to buddy.py 1>&2
  exit /b 2
)

rem ── 1. An explicit interpreter always wins ─────────────────────────────────
if defined BUDDY_PYTHON (
  call :try "%BUDDY_PYTHON%" && goto :eof
)

rem ── 2. What the installer recorded, if it recorded anything ────────────────
rem    Parsing JSON in batch is inherently crude, so this step is best-effort by
rem    design: the `if exist` guard means a mis-parse simply falls through to the
rem    steps below rather than running a garbage path. Failing open here is safe
rem    because every later step is version-checked too.
set "MANIFEST=%OMEGA%\install-manifest.json"
if exist "%MANIFEST%" (
  for /f "usebackq tokens=1,* delims=:" %%A in (`findstr /c:"\"python\"" "%MANIFEST%"`) do (
    set "LINE=%%B"
    set "LINE=!LINE:"=!"
    set "LINE=!LINE:,=!"
    for /f "tokens=* delims= " %%C in ("!LINE!") do set "CAND=%%~C"
    if defined CAND if exist "!CAND!" call :try "!CAND!" && goto :eof
  )
)

rem ── 3. The Windows Python launcher, newest first ───────────────────────────
where py >nul 2>nul
if not errorlevel 1 (
  py -3 -c "import sys;sys.exit(0 if sys.version_info>=(3,10) else 1)" >nul 2>nul
  if not errorlevel 1 (
    py -3 "%TARGET%" %*
    exit /b %errorlevel%
  )
)

rem ── 4. Whatever `python` resolves to, version-checked ──────────────────────
call :try "python" && goto :eof
call :try "python3" && goto :eof

echo. 1>&2
echo   buddy could not find a usable Python. 1>&2
echo. 1>&2
echo   It needs CPython 3.10 or newer; 3.12 is recommended. 1>&2
echo   Either install one from https://www.python.org/downloads/ 1>&2
echo   or point at an existing one: 1>&2
echo. 1>&2
echo       set BUDDY_PYTHON=C:\path\to\python.exe 1>&2
echo. 1>&2
echo   Checked: BUDDY_PYTHON, install-manifest.json, py -3, python, python3. 1>&2
exit /b 127

rem ── helper: run the target with a candidate interpreter if it is new enough ─
:try
set "CAND=%~1"
"%CAND%" -c "import sys;sys.exit(0 if sys.version_info>=(3,10) else 1)" >nul 2>nul
if errorlevel 1 exit /b 1
"%CAND%" "%TARGET%" %*
exit /b %errorlevel%
