@echo off
title FileLLM tests
cd /d "%~dp0"

echo.
echo   FileLLM test suite
echo   ============================================================
echo.

where node >nul 2>&1
if errorlevel 1 (
  echo   Node.js is not installed. Get it from https://nodejs.org
  pause
  exit /b 1
)

set FAILED=0

echo   [1/4] units - zip, extraction, safety, walker, tools
node test/run-tests.mjs || set FAILED=1

echo.
echo   [2/4] markdown renderer
node test/markdown.test.mjs || set FAILED=1

echo.
echo   [3/4] agent loop - real tools, scripted model
node test/loop.test.mjs || set FAILED=1

echo.
echo   [4/4] mutations - REALLY recycles and moves files in a scratch folder
node test/integration-mutate.mjs || set FAILED=1

echo.
echo   ============================================================
if "%FAILED%"=="1" (
  echo   SOME TESTS FAILED - see the output above.
) else (
  echo   ALL TESTS PASSED.
)
echo.
pause
