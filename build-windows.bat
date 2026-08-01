@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul || (
  echo [ERROR] Node.js 22.12.0 or newer is required.
  exit /b 1
)
node -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>22||(a===22&&b>=12)?0:1)" >nul 2>nul || (
  echo [ERROR] Node.js 22.12.0 or newer is required.
  exit /b 1
)

set "PACKAGE_TYPE=%~1"
if not defined PACKAGE_TYPE set "PACKAGE_TYPE=all"
set "PACKAGE_ARCH=%~2"
if not defined PACKAGE_ARCH set "PACKAGE_ARCH=x64"

if not exist "node_modules\" (
  call npm.cmd ci || exit /b 1
)

node scripts\build-packages.js --platform win --type "%PACKAGE_TYPE%" --arch "%PACKAGE_ARCH%"
exit /b %errorlevel%
