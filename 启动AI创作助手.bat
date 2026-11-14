@echo off
chcp 65001 >nul
title AI 创作平板助手 (PC + Android 平板协同服务)
cd /d "%~dp0"

echo ============================================================
echo 🎨 正在启动 AI 创作平板助手...
echo ============================================================

start "" "http://localhost:3680/pc"
node server.js
pause
