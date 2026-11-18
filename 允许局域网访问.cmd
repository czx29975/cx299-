@echo off
chcp 65001 >nul
title 允许局域网访问 - 安语
setlocal

net session >nul 2>&1
if errorlevel 1 (
  echo.
  echo   需要管理员权限。
  echo   请右键这个文件，选择「以管理员身份运行」。
  echo.
  pause
  exit /b 1
)

echo.
echo   正在放行端口：8080（网页）  8443（手机 HTTPS）
netsh advfirewall firewall delete rule name="Anyu-HTTP-8080" >nul 2>&1
netsh advfirewall firewall delete rule name="Anyu-HTTPS-8443" >nul 2>&1
netsh advfirewall firewall add rule name="Anyu-HTTP-8080" dir=in action=allow protocol=TCP localport=8080 profile=any >nul
netsh advfirewall firewall add rule name="Anyu-HTTPS-8443" dir=in action=allow protocol=TCP localport=8443 profile=any >nul
if errorlevel 1 (
  echo.
  echo   放行失败。请确认是“以管理员身份运行”，或手动在 Windows 防火墙里放行。
  echo.
  pause
  exit /b 1
)
echo   已放行（专用/公用网络都生效）。
echo.

cd /d "%~dp0app"
where python >nul 2>nul
if errorlevel 1 (
  ipconfig | findstr /i "IPv4"
) else (
  python net_info.py
)

echo   注意：服务本身要先启动，双击「启动安语.cmd」并保持窗口开着。
echo.
pause
