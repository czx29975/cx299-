@echo off
chcp 65001 >nul
title 接入大模型 - 安语
cd /d "%~dp0app"
echo.
python set_llm.py %*
echo.
pause
