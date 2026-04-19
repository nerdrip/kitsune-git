# Build Resources

Place your application icons here:

- `icon.png` — 512x512 PNG (used for all platforms, also as source for conversion)
- `icon.ico` — Windows icon (will be auto-generated from icon.png by electron-builder if missing)
- `icon.icns` — macOS icon (will be auto-generated from icon.png by electron-builder if missing)
- `icons/` — Linux icons directory (various sizes)

## Quick Icon Generation

If you only have a 512x512 `icon.png`, electron-builder can auto-generate the other formats.
Just place `icon.png` here and run the build.
