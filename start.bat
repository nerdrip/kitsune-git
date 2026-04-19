@echo off
REM ============================================
REM  KitsuneGIT — Windows Production Launcher
REM ============================================
title KitsuneGIT

echo.
echo   === KitsuneGIT ===
echo.

cd /d "%~dp0"

REM Check if node_modules exist
if not exist "node_modules\" (
    echo Installing dependencies...
    call npm install --production
)

echo Starting KitsuneGIT...
call npm start
