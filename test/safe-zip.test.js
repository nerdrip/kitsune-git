const assert = require('node:assert/strict');
const path = require('node:path');
const { describe, it } = require('node:test');
const { safeTarget } = require('../src/main/safe-zip');

describe('safe ZIP extraction paths', () => {
  const root = path.resolve('safe-extraction-root');

  it('keeps regular archive entries inside the destination', () => {
    assert.equal(safeTarget(root, 'folder/file.txt'), path.join(root, 'folder', 'file.txt'));
  });

  it('rejects traversal, absolute, drive, and backslash paths', () => {
    for (const entry of ['../escape', 'folder/../../escape', '/absolute', 'C:/drive', 'folder\\escape']) {
      assert.throws(() => safeTarget(root, entry), /unsafe|traversal/);
    }
  });
});
