@echo off
chcp 65001 >nul
title AI Creative Tablet Assistant
cd /d "%~dp0" || exit /b 1

echo ============================================================
echo Starting AI Creative Tablet Assistant...
echo ============================================================

start "" "http://localhost:3680/pc"
node server.js
pause
