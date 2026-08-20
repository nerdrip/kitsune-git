# KitsuneGIT Server

This archive contains the standalone KitsuneGIT collaboration server without the Electron desktop client.

## Requirements

- Node.js 22.13.0 or newer
- npm
- Git and OpenSSH

## Installation

```sh
npm ci --omit=dev --ignore-scripts
export KITSUNE_ADMIN_TOKEN="replace-with-at-least-24-random-characters"
export KITSUNE_SECRET_KEY="replace-with-64-hexadecimal-characters"
export KITSUNE_METADATA_BACKEND="sqlite"
npm start
```

The server listens on `127.0.0.1:4780` by default. See `docs/WEB.md` for HTTPS proxying, SSH, identity providers, storage, backup, and recovery settings.

`Dockerfile.web` and `compose.web.yml` are included for container deployments.
