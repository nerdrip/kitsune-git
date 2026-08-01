@echo off
REM ============================================
REM  KitsuneGIT — Windows Production Launcher
REM ============================================
title KitsuneGIT

echo.
echo   === KitsuneGIT ===
echo.

cd /d "%~dp0"

where node >nul 2>nul || (
    echo [ERROR] Node.js 22.12.0 or newer is required.
    exit /b 1
)
node -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>22||(a===22&&b>=12)?0:1)" >nul 2>nul || (
    echo [ERROR] Node.js 22.12.0 or newer is required.
    exit /b 1
)

REM Electron is a development dependency, so a source checkout needs all dependencies.
if not exist "node_modules\" (
    echo Installing dependencies...
    call npm.cmd ci
    if errorlevel 1 exit /b 1
)

echo Starting KitsuneGIT...
call npm.cmd start
