#!/bin/bash
# ============================================
#  KitsuneGIT — Linux/macOS Production Launcher
# ============================================

set -e

cd "$(dirname "$0")"

command -v node >/dev/null 2>&1 || { echo '[ERROR] Node.js 22.12.0 or newer is required.' >&2; exit 1; }
node -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>22||(a===22&&b>=12)?0:1)" \
  || { echo '[ERROR] Node.js 22.12.0 or newer is required.' >&2; exit 1; }

# Electron is a development dependency, so a source checkout needs all dependencies.
if [ ! -d "node_modules" ]; then
    echo "Installing dependencies..."
    npm ci
fi

echo "Starting KitsuneGIT..."
npm start
