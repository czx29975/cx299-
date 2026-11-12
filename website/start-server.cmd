@echo off
setlocal
cd /d "%~dp0"
set PORT=8000

where py >nul 2>nul
if %errorlevel%==0 (
  start "" "http://127.0.0.1:%PORT%/"
  py -3 -m http.server %PORT%
  exit /b
)

where python >nul 2>nul
if %errorlevel%==0 (
  start "" "http://127.0.0.1:%PORT%/"
  python -m http.server %PORT%
  exit /b
)

echo Python not found.
echo Double-click index.html to use the site (text input works; microphone may be limited).
echo Or run any static file server in this folder.
pause
