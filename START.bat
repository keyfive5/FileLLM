@echo off
title FileLLM
cd /d "%~dp0"

echo.
echo   FileLLM - AI file agent
echo   ============================================================
echo.

where node >nul 2>&1
if errorlevel 1 (
  echo   Node.js is not installed.
  echo.
  echo   FileLLM needs it to run. Download the LTS installer from:
  echo       https://nodejs.org
  echo   Install it, then double-click START.bat again.
  echo.
  pause
  exit /b 1
)

for /f "tokens=1 delims=." %%v in ('node -p "process.versions.node"') do set MAJOR=%%v
if %MAJOR% LSS 20 (
  echo   Your Node.js is too old ^(v%MAJOR%^). FileLLM needs v20 or newer.
  echo   Update it from https://nodejs.org and run START.bat again.
  echo.
  pause
  exit /b 1
)

node server.mjs
echo.
echo   FileLLM stopped.
pause
