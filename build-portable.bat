@echo off
rem Build the native Windows portable executable. Optional argument: x64, arm64, or all.
call "%~dp0build-windows.bat" portable "%~1"
exit /b %errorlevel%
