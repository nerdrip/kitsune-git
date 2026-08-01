#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

case "$(uname -s)" in
  Darwin) exec ./build-macos.sh installer "${1:-x64}" ;;
  Linux) exec ./build-linux.sh installer "${1:-x64}" ;;
  *) echo '[ERROR] Use build-installer.bat on Windows.' >&2; exit 1 ;;
esac
