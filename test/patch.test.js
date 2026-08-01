const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { buildSelectedPatch, parseUnifiedDiff } = require('../src/git/patch');

const DIFF = [
  'diff --git a/example.txt b/example.txt',
  'index 0000000..1111111 100644',
  '--- a/example.txt',
  '+++ b/example.txt',
  '@@ -1,4 +1,5 @@',
  ' alpha',
  '-old value',
  '+new value',
  ' middle',
  '+inserted',
  ' omega',
  ''
].join('\n');

describe('selectable unified patches', () => {
  it('parses headers, ranges, and change-line indexes', () => {
    const parsed = parseUnifiedDiff(DIFF);
    assert.equal(parsed.hunks.length, 1);
    assert.deepEqual(parsed.hunks[0].oldRange, { start: 1, count: 4 });
    assert.deepEqual(parsed.hunks[0].newRange, { start: 1, count: 5 });
    assert.equal(parsed.hunks[0].lines[1], '-old value');
    assert.equal(parsed.hunks[0].lines[4], '+inserted');
  });

  it('keeps an unselected deletion as context while staging an insertion', () => {
    const patch = buildSelectedPatch(DIFF, [{ hunk: 0, lines: [2] }]);
    assert.match(patch, /^diff --git/m);
    assert.match(patch, /^ old value$/m);
    assert.match(patch, /^\+new value$/m);
    assert.doesNotMatch(patch, /^-old value$/m);
    assert.doesNotMatch(patch, /^\+inserted$/m);
  });

  it('accepts a whole hunk and rejects empty changes', () => {
    const patch = buildSelectedPatch(DIFF, [{ hunk: 0 }]);
    assert.match(patch, /^\+inserted$/m);
    assert.throws(() => buildSelectedPatch(DIFF, [{ hunk: 0, lines: [0] }]), /does not contain any changed lines/);
  });
});
