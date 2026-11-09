@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0" || exit /b 1
set "PYTHONUTF8=1"
if exist ".venv\Scripts\python.exe" goto venv
py -3 -c "import sys; sys.exit(not (sys.version_info >= (3, 11)))" >nul 2>nul
if not errorlevel 1 goto launcher
python -c "import sys; sys.exit(not (sys.version_info >= (3, 11)))" >nul 2>nul
if not errorlevel 1 goto python
echo Python 3.11 or later was not found. See README.md for setup.
set "moodle_result=9009"
goto finish
:venv
".venv\Scripts\python.exe" tools\moodle_download.py %*
set "moodle_result=%errorlevel%"
goto finish
:launcher
py -3 tools\moodle_download.py %*
set "moodle_result=%errorlevel%"
goto finish
:python
python tools\moodle_download.py %*
set "moodle_result=%errorlevel%"
:finish
echo.
echo Exit code: %moodle_result%
pause
exit /b %moodle_result%
