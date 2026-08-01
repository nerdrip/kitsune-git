#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

package_type="${1:-all}"
package_arch="${2:-x64}"

command -v node >/dev/null 2>&1 || { echo '[ERROR] Node.js 22.12.0 or newer is required.' >&2; exit 1; }
node -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>22||(a===22&&b>=12)?0:1)" \
  || { echo '[ERROR] Node.js 22.12.0 or newer is required.' >&2; exit 1; }
[ -d node_modules ] || npm ci

node scripts/build-packages.js --platform mac --type "$package_type" --arch "$package_arch"
