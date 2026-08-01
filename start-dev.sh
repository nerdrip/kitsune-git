#!/bin/bash
# ============================================
#  KitsuneGIT — Linux/macOS Development Launcher
# ============================================

set -e

echo ""
echo "  === KitsuneGIT Development Mode ==="
echo ""

# Check if Node.js is installed
if ! command -v node &> /dev/null; then
    echo "[ERROR] Node.js is not installed or not in PATH."
    echo "        Install via: https://nodejs.org/ or your package manager"
    echo "        Ubuntu/Debian: sudo apt install nodejs npm"
    echo "        Fedora: sudo dnf install nodejs npm"
    echo "        Arch: sudo pacman -S nodejs npm"
    exit 1
fi
node -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>22||(a===22&&b>=12)?0:1)" \
  || { echo '[ERROR] Node.js 22.12.0 or newer is required.' >&2; exit 1; }

# Check if Git is installed
if ! command -v git &> /dev/null; then
    echo "[ERROR] Git is not installed or not in PATH."
    echo "        Install via: https://git-scm.com/ or your package manager"
    exit 1
fi

# Navigate to script directory
cd "$(dirname "$0")"

# Install dependencies if node_modules is missing
if [ ! -d "node_modules" ]; then
    echo "Installing dependencies..."
    npm install
fi

echo "Starting KitsuneGIT in development mode..."
echo ""
npm run dev
