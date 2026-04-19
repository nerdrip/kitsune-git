#!/bin/bash
# ============================================
#  KitsuneGIT — Build Release (Linux)
# ============================================

set -e

echo ""
echo "  === Building KitsuneGIT Release (Linux) ==="
echo ""

cd "$(dirname "$0")"

# Check dependencies
if ! command -v node &> /dev/null; then
    echo "[ERROR] Node.js is required. Install from https://nodejs.org/"
    exit 1
fi

# Install dependencies if needed
if [ ! -d "node_modules" ]; then
    echo "Installing dependencies..."
    npm install
fi

# Generate icons
echo "Generating icons..."
npm run generate-icons

echo ""
echo "Building Linux packages (AppImage + deb + rpm + tar.gz)..."
npm run build:linux

echo ""
echo "=== Build complete! ==="
echo "Output files are in the dist/ directory:"
ls -la dist/*.AppImage dist/*.deb dist/*.rpm dist/*.tar.gz 2>/dev/null || echo "(check dist/ folder)"
echo ""
