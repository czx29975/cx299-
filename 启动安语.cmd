@echo off
chcp 65001 >nul
title 安语 · 居家养老语音助手
cd /d "%~dp0app"

where python >nul 2>nul
if errorlevel 1 (
  echo.
  echo   没有找到 Python。请先安装 Python 3.10 以上版本：
  echo   https://www.python.org/downloads/
  echo   安装时记得勾选 "Add Python to PATH"。
  echo.
  pause
  exit /b 1
)

echo.
echo   正在启动安语，稍后会自动打开浏览器……
echo   关闭这个窗口就会停止服务。
echo.

start "" /b cmd /c "timeout /t 2 >nul & start "" http://127.0.0.1:8080/"
python server.py

echo.
echo   服务已停止。
pause
