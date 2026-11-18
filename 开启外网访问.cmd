@echo off
chcp 65001 >nul
title 开启外网访问 - 安语
setlocal

cd /d "%~dp0"

where python >nul 2>nul
if errorlevel 1 (
  echo.
  echo   没找到 python。请先安装 Python 3，安装时勾选 Add to PATH。
  echo.
  pause
  exit /b 1
)

if not exist "tools\cloudflared.exe" (
  if not exist "tools\cloudflared" (
    echo.
    echo   缺少 tools\cloudflared.exe（外网通道程序）。
    echo   下载：https://github.com/cloudflare/cloudflared/releases/latest
    echo   选 cloudflared-windows-amd64.exe，改名为 cloudflared.exe，放进 tools 文件夹。
    echo.
    pause
    exit /b 1
  )
)

echo.
echo   提示：先确认「启动安语.cmd」的窗口开着，否则隧道没东西可转。
echo.

python "app\tunnel.py" --open

echo.
pause
