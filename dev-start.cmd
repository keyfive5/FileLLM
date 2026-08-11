@echo off
REM Dev launcher: pins the session token so the preview URL is stable and
REM suppresses the auto-open browser. Use START.bat for normal use.
cd /d "%~dp0"
set FILELLM_TOKEN=dev
set FILELLM_NO_OPEN=1
node server.mjs
