@echo off
rem Build the native Windows NSIS installer. Optional argument: x64, arm64, or all.
call "%~dp0build-windows.bat" installer "%~1"
exit /b %errorlevel%
