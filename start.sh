#!/bin/bash
# ============================================
#  KitsuneGIT — Linux/macOS Production Launcher
# ============================================

set -e

cd "$(dirname "$0")"

# Install dependencies if node_modules is missing
if [ ! -d "node_modules" ]; then
    echo "Installing dependencies..."
    npm install --production
fi

echo "Starting KitsuneGIT..."
npm start
