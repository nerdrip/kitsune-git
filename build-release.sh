#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

case "$(uname -s)" in
  Darwin) exec ./build-macos.sh all all ;;
  Linux) exec ./build-linux.sh all all ;;
  *) echo '[ERROR] Use build-windows.bat on Windows.' >&2; exit 1 ;;
esac
