/**
 * KitsuneGIT — Icon Generator
 * 
 * Generates application icons for all platforms:
 * - build/icon.png (512x512 PNG — source for electron-builder)
 * - build/icons/  (Linux icon sizes: 16, 32, 48, 64, 128, 256, 512)
 * 
 * electron-builder will auto-generate .ico and .icns from icon.png.
 * 
 * This script creates a simple fox-themed icon using Canvas if no icon.png exists.
 * Replace build/icon.png with your own 512x512 PNG for a custom icon.
 */

const fs = require('fs');
const path = require('path');

const BUILD_DIR = path.join(__dirname, '..', 'build');
const ICONS_DIR = path.join(BUILD_DIR, 'icons');
const ICON_PNG = path.join(BUILD_DIR, 'icon.png');
const LINUX_SIZES = [16, 32, 48, 64, 128, 256, 512];

// Simple PPM-to-PNG isn't feasible without deps, so we generate a minimal valid PNG
// using raw zlib. This creates a simple colored square icon with a "K" letter.

function createMinimalPNG(size) {
  const zlib = require('zlib');

  // Create raw RGBA pixel data
  const pixels = Buffer.alloc(size * size * 4);

  const cx = size / 2;
  const cy = size / 2;
  const r = size * 0.42;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = (y * size + x) * 4;
      const dx = x - cx;
      const dy = y - cy;
      const dist = Math.sqrt(dx * dx + dy * dy);

      if (dist <= r) {
        // Gradient background: deep purple to blue
        const t = dist / r;
        pixels[idx] = Math.round(30 + t * 100);    // R
        pixels[idx + 1] = Math.round(30 + t * 60);  // G
        pixels[idx + 2] = Math.round(46 + t * 150);  // B
        pixels[idx + 3] = 255;                        // A

        // Draw a fox ear (left triangle)
        const earLx = cx - r * 0.55;
        const earRx = cx - r * 0.15;
        const earTy = cy - r * 0.85;
        const earBy = cy - r * 0.2;
        if (y >= earTy && y <= earBy && x >= earLx && x <= earRx) {
          const earProgress = (y - earTy) / (earBy - earTy);
          const earWidth = earProgress * (earRx - earLx);
          const earCenterX = (earLx + earRx) / 2;
          if (Math.abs(x - earCenterX) <= earWidth / 2) {
            pixels[idx] = 255;     // R — orange
            pixels[idx + 1] = 140; // G
            pixels[idx + 2] = 50;  // B
          }
        }

        // Draw a fox ear (right triangle)
        const earLx2 = cx + r * 0.15;
        const earRx2 = cx + r * 0.55;
        if (y >= earTy && y <= earBy && x >= earLx2 && x <= earRx2) {
          const earProgress = (y - earTy) / (earBy - earTy);
          const earWidth = earProgress * (earRx2 - earLx2);
          const earCenterX = (earLx2 + earRx2) / 2;
          if (Math.abs(x - earCenterX) <= earWidth / 2) {
            pixels[idx] = 255;
            pixels[idx + 1] = 140;
            pixels[idx + 2] = 50;
          }
        }

        // Draw face circle (orange)
        const faceDist = Math.sqrt(dx * dx + (dy + r * 0.05) * (dy + r * 0.05));
        if (faceDist <= r * 0.6) {
          pixels[idx] = 255;
          pixels[idx + 1] = 160;
          pixels[idx + 2] = 70;

          // Eyes (dark)
          const eyeY = cy - r * 0.1;
          const eyeSize = r * 0.08;
          const leftEyeX = cx - r * 0.2;
          const rightEyeX = cx + r * 0.2;
          const leftDist = Math.sqrt((x - leftEyeX) ** 2 + (y - eyeY) ** 2);
          const rightDist = Math.sqrt((x - rightEyeX) ** 2 + (y - eyeY) ** 2);
          if (leftDist <= eyeSize || rightDist <= eyeSize) {
            pixels[idx] = 40;
            pixels[idx + 1] = 40;
            pixels[idx + 2] = 60;
          }

          // Nose (dark triangle)
          const noseY = cy + r * 0.1;
          const noseDist = Math.sqrt((x - cx) ** 2 + (y - noseY) ** 2);
          if (noseDist <= r * 0.06) {
            pixels[idx] = 40;
            pixels[idx + 1] = 40;
            pixels[idx + 2] = 60;
          }

          // White snout area
          const snoutDist = Math.sqrt((x - cx) ** 2 + (y - (cy + r * 0.15)) ** 2);
          if (snoutDist <= r * 0.25 && y > cy) {
            pixels[idx] = 240;
            pixels[idx + 1] = 230;
            pixels[idx + 2] = 220;
          }
        }
      } else {
        // Transparent outside
        pixels[idx] = 0;
        pixels[idx + 1] = 0;
        pixels[idx + 2] = 0;
        pixels[idx + 3] = 0;
      }
    }
  }

  // Build PNG file manually
  // PNG signature
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  // IHDR chunk
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(size, 0);  // width
  ihdrData.writeUInt32BE(size, 4);  // height
  ihdrData[8] = 8;   // bit depth
  ihdrData[9] = 6;   // color type (RGBA)
  ihdrData[10] = 0;  // compression
  ihdrData[11] = 0;  // filter
  ihdrData[12] = 0;  // interlace
  const ihdr = createChunk('IHDR', ihdrData);

  // IDAT chunk — filtered pixel data
  const rawData = Buffer.alloc(size * (1 + size * 4)); // filter byte + row data
  for (let y = 0; y < size; y++) {
    const rowOffset = y * (1 + size * 4);
    rawData[rowOffset] = 0; // No filter
    pixels.copy(rawData, rowOffset + 1, y * size * 4, (y + 1) * size * 4);
  }
  const compressed = zlib.deflateSync(rawData);
  const idat = createChunk('IDAT', compressed);

  // IEND chunk
  const iend = createChunk('IEND', Buffer.alloc(0));

  return Buffer.concat([signature, ihdr, idat, iend]);
}

function createChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);

  const typeBuffer = Buffer.from(type, 'ascii');
  const crcData = Buffer.concat([typeBuffer, data]);

  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(crcData), 0);

  return Buffer.concat([length, typeBuffer, data, crc]);
}

function crc32(buf) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xEDB88320 : 0);
    }
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function main() {
  // Create directories
  if (!fs.existsSync(BUILD_DIR)) fs.mkdirSync(BUILD_DIR, { recursive: true });
  if (!fs.existsSync(ICONS_DIR)) fs.mkdirSync(ICONS_DIR, { recursive: true });

  // Generate main icon (512x512) if it doesn't exist
  if (!fs.existsSync(ICON_PNG)) {
    console.log('Generating application icon (512x512)...');
    const png = createMinimalPNG(512);
    fs.writeFileSync(ICON_PNG, png);
    console.log('Created: build/icon.png');
  } else {
    console.log('build/icon.png already exists, skipping generation.');
  }

  // Generate Linux icon sizes
  console.log('Generating Linux icons...');
  for (const size of LINUX_SIZES) {
    const iconPath = path.join(ICONS_DIR, `${size}x${size}.png`);
    if (!fs.existsSync(iconPath)) {
      const png = createMinimalPNG(size);
      fs.writeFileSync(iconPath, png);
      console.log(`  Created: icons/${size}x${size}.png`);
    }
  }

  console.log('Icon generation complete!');
  console.log('Note: Replace build/icon.png with your own 512x512 icon for a custom look.');
  console.log('electron-builder will auto-generate .ico and .icns from icon.png.');
}

main();
