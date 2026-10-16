@echo off
title Webchat
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Get the LTS version from https://nodejs.org and run this again.
  pause
  exit /b
)

if not exist config.json (
  echo config.json is missing. It should be in the same folder as run.bat.
  pause
  exit /b
)

findstr /c:"PASTE_BOT_TOKEN_HERE" config.json >nul
if not errorlevel 1 (
  echo Paste your bot token into config.json, save it, then run this again.
  start notepad config.json
  pause
  exit /b
)

if not exist node_modules (
  echo Installing dependencies...
  call npm install --no-fund --no-audit
)

node server.js
echo.
echo The bot has stopped.
pause
