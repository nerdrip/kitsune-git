@echo off
rem Backward-compatible release entry point: installer + portable, x64 + arm64.
call "%~dp0build-windows.bat" all all
exit /b %errorlevel%
