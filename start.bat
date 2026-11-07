@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Task Checklist Server

where python >nul 2>nul
if errorlevel 1 (
  echo [ERROR] ไม่พบ Python ในเครื่อง
  echo ติดตั้งได้ที่ https://www.python.org/downloads/  ^(ติ๊ก "Add Python to PATH" ตอนติดตั้ง^)
  pause
  exit /b 1
)

python -u server.py --open
echo.
echo เซิร์ฟเวอร์หยุดทำงานแล้ว
pause
