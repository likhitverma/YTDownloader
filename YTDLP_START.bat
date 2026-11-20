@echo off
cd /d "%~dp0"

set "URL=http://localhost:3000"
set "BRAVE_64=C:\Program Files\BraveSoftware\Brave-Browser\Application\brave.exe"
set "BRAVE_32=C:\Program Files (x86)\BraveSoftware\Brave-Browser\Application\brave.exe"
set "BRAVE_USER=%LOCALAPPDATA%\BraveSoftware\Brave-Browser\Application\brave.exe"

if exist "%BRAVE_64%" (
    start "" "%BRAVE_64%" "%URL%"
) else if exist "%BRAVE_32%" (
    start "" "%BRAVE_32%" "%URL%"
) else if exist "%BRAVE_USER%" (
    start "" "%BRAVE_USER%" "%URL%"
) else (
    start "" "%URL%"
)

call npm start
pause
