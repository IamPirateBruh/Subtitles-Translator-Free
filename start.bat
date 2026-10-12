@echo off
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js is not installed. Get it from https://nodejs.org and run this again. & pause & exit /b 1)
if not exist node_modules (
  echo Installing packages...
  call npm install || (pause & exit /b 1)
)
echo.
echo Subtitle Translator is starting. Open http://localhost:3000 in your browser.
echo Press Ctrl+C to stop.
echo.
node server.js
pause
