@echo off
REM ============================================
REM  KitsuneGIT — Build Release (Windows)
REM ============================================
title KitsuneGIT Build

echo.
echo   === Building KitsuneGIT Release (Windows) ===
echo.

cd /d "%~dp0"

REM Check if node_modules exist
if not exist "node_modules\" (
    echo Installing dependencies...
    call npm install
)

echo Generating icons...
call npm run generate-icons

echo.
echo Building Windows installer (NSIS + Portable)...
call npm run build:win

echo.
echo === Build complete! ===
echo Output files are in the dist/ directory.
echo.
dir /b dist\*.exe 2>nul
echo.
pause
