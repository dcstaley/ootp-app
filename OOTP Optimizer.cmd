@echo off
title OOTP Roster Optimizer
cd /d "%~dp0"

where npm >nul 2>nul || (
  echo.
  echo   Node.js is not installed or not on PATH.
  echo   Install Node 24+ from https://nodejs.org  then run this again.
  echo.
  pause
  exit /b 1
)

if not exist "node_modules\" (
  echo Installing dependencies ^(first run only^)...
  call npm install || (echo npm install failed. & pause & exit /b 1)
)

echo.
echo   Starting the OOTP Roster Optimizer...
echo   Your browser will open automatically when it's ready.
echo.
echo   KEEP THIS WINDOW OPEN while using the app.
echo   Close it (or press Ctrl+C) to stop the app.
echo.

set LAUNCH_OPEN=1
call npm run dev
