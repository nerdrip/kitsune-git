const fs = require('node:fs');
const path = require('node:path');
const yauzl = require('yauzl');

function safeTarget(root, fileName) {
  if (typeof fileName !== 'string' || !fileName || fileName.includes('\0') || fileName.includes('\\') || fileName.startsWith('/') || /^[A-Za-z]:/.test(fileName)) {
    throw new Error('ZIP archive contains an unsafe path');
  }
  const parts = fileName.split('/').filter(Boolean);
  if (parts.some(part => part === '.' || part === '..')) throw new Error('ZIP archive contains path traversal');
  const resolvedRoot = path.resolve(root);
  const target = path.resolve(resolvedRoot, ...parts);
  if (target !== resolvedRoot && !target.startsWith(`${resolvedRoot}${path.sep}`)) throw new Error('ZIP archive escaped the extraction directory');
  return target;
}

function extractZip(archive, { dir, maxEntries = 100_000, maxBytes = 4 * 1024 * 1024 * 1024 } = {}) {
  const destination = path.resolve(dir);
  fs.mkdirSync(destination, { recursive: true });
  return new Promise((resolve, reject) => {
    yauzl.open(path.resolve(archive), { lazyEntries: true, autoClose: true, decodeStrings: true, validateEntrySizes: true }, (openError, zip) => {
      if (openError) return reject(openError);
      let entries = 0;
      let totalBytes = 0;
      let settled = false;
      const fail = error => {
        if (settled) return;
        settled = true;
        zip.close();
        reject(error);
      };
      zip.once('error', fail);
      zip.once('end', () => { if (!settled) { settled = true; resolve(); } });
      zip.on('entry', entry => {
        try {
          entries += 1;
          totalBytes += entry.uncompressedSize;
          if (entries > maxEntries || totalBytes > maxBytes) throw new Error('ZIP archive exceeds extraction limits');
          const mode = (entry.externalFileAttributes >>> 16) & 0xffff;
          if ((mode & 0o170000) === 0o120000) throw new Error('ZIP archive contains a symbolic link');
          const target = safeTarget(destination, entry.fileName);
          if (entry.fileName.endsWith('/')) {
            fs.mkdirSync(target, { recursive: true });
            return zip.readEntry();
          }
          fs.mkdirSync(path.dirname(target), { recursive: true });
          zip.openReadStream(entry, (streamError, input) => {
            if (streamError) return fail(streamError);
            const output = fs.createWriteStream(target, { flags: 'wx', mode: mode & 0o777 || 0o600 });
            input.once('error', fail);
            output.once('error', fail);
            output.once('finish', () => {
              if (process.platform !== 'win32' && (mode & 0o777)) fs.chmodSync(target, mode & 0o777);
              zip.readEntry();
            });
            input.pipe(output);
          });
        } catch (error) { fail(error); }
      });
      zip.readEntry();
    });
  });
}

module.exports = { extractZip, safeTarget };
