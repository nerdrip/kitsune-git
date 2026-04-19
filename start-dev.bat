@echo off
REM ============================================
REM  KitsuneGIT — Windows Development Launcher
REM ============================================
title KitsuneGIT Dev

echo.
echo   === KitsuneGIT Development Mode ===
echo.

REM Check if Node.js is installed
where node >nul 2>nul
if errorlevel 1 (
    echo [ERROR] Node.js is not installed or not in PATH.
    echo         Download from: https://nodejs.org/
    pause
    exit /b 1
)

REM Check if Git is installed
where git >nul 2>nul
if errorlevel 1 (
    echo [ERROR] Git is not installed or not in PATH.
    echo         Download from: https://git-scm.com/
    pause
    exit /b 1
)

REM Navigate to project directory
cd /d "%~dp0"

REM Install dependencies if node_modules is missing
if not exist "node_modules\" (
    echo Installing dependencies...
    call npm install
    if errorlevel 1 (
        echo [ERROR] npm install failed.
        pause
        exit /b 1
    )
)

echo Starting KitsuneGIT in development mode...
echo.
call npm run dev

pause
