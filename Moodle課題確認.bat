@echo off
chcp 65001 >nul
call "%~dp0Moodle資料取得.bat" --assignments %*
exit /b %errorlevel%
