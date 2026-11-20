@echo off
setlocal EnableExtensions
title MediaDock
cd /d "%~dp0"

echo ==================================================
echo   MediaDock - automatic setup and start
echo ==================================================
echo.

rem ---------- 1. Node.js ----------
call :ensure node "OpenJS.NodeJS.LTS" "Node.js"

set "NODE_MAJOR=0"
for /f "usebackq" %%V in (`node -p "process.versions.node.split('.')[0]"`) do set "NODE_MAJOR=%%V"
if %NODE_MAJOR% LSS 20 (
  echo [..] Node.js %NODE_MAJOR% is too old. MediaDock needs version 20 or newer. Upgrading...
  winget upgrade -e --id OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements
  call :refresh_path
)

rem ---------- 2. yt-dlp ----------
call :ensure yt-dlp "yt-dlp.yt-dlp" "yt-dlp"

rem ---------- 3. FFmpeg ----------
call :ensure ffmpeg "Gyan.FFmpeg" "FFmpeg"

rem ---------- 3b. Deno (JavaScript runtime yt-dlp uses for YouTube) ----------
call :ensure deno "DenoLand.Deno" "Deno"

rem ---------- 4. npm install ----------
if not exist "node_modules\express" (
  echo.
  echo [..] Installing MediaDock dependencies ^(first run only^)...
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo [!] npm install failed. Check your internet connection and run this file again.
    pause
    exit 1
  )
)

rem ---------- 5. Start ----------
echo.
echo [OK] Everything is ready. Starting MediaDock at http://127.0.0.1:3000
echo      Keep this window open while using the app. Close it ^(or press Ctrl+C^) to stop.
echo.
start "" cmd /c "timeout /t 3 /nobreak >nul & start "" http://127.0.0.1:3000"
call npm start
echo.
echo MediaDock has stopped.
pause
exit /b 0


rem ==================================================
rem  Subroutines
rem ==================================================

:ensure
rem  %1 = command to look for, %2 = winget package id, %3 = friendly name
where %1 >nul 2>nul
if not errorlevel 1 (
  echo [OK] %~3 found.
  goto :eof
)
echo [..] %~3 not found. Installing with winget ^(a permission prompt may appear^)...
where winget >nul 2>nul
if errorlevel 1 (
  echo [!] winget is not available on this PC.
  echo     Install "App Installer" from the Microsoft Store, or install %~3 manually, then run this file again.
  pause
  exit 1
)
winget install -e --id %~2 --accept-package-agreements --accept-source-agreements
call :refresh_path
where %1 >nul 2>nul
if errorlevel 1 (
  echo [!] %~3 was installed but is not visible yet.
  echo     Close this window and double-click start.bat again.
  pause
  exit 1
)
echo [OK] %~3 installed.
goto :eof

:refresh_path
rem  Reload PATH from the registry so freshly installed tools work in this same window.
for /f "usebackq delims=" %%P in (`powershell -NoProfile -Command "[Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')"`) do set "PATH=%%P;%PATH%"
goto :eof