const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { OperationQueue } = require('../src/main/operation-queue');

describe('Git operation queue', () => {
  it('runs mutating tasks sequentially', async () => {
    const queue = new OperationQueue();
    const events = [];
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const first = queue.enqueue('first', async () => { events.push('first:start'); await gate; events.push('first:end'); });
    const second = queue.enqueue('second', async () => { events.push('second:start'); events.push('second:end'); });
    assert.equal(queue.status().active.label, 'first');
    assert.equal(queue.status().pending.length, 1);
    release();
    await Promise.all([first, second]);
    assert.deepEqual(events, ['first:start', 'first:end', 'second:start', 'second:end']);
  });

  it('cancels queued tasks before execution', async () => {
    const queue = new OperationQueue();
    let release;
    const first = queue.enqueue('first', () => new Promise(resolve => { release = resolve; }));
    const second = queue.enqueue('second', async () => 'never');
    const pendingId = queue.status().pending[0].id;
    assert.equal(queue.cancel(pendingId), true);
    await assert.rejects(second, { name: 'AbortError' });
    release();
    await first;
  });

  it('returns the real result when an active non-interruptible task finishes', async () => {
    const queue = new OperationQueue();
    let release;
    const result = queue.enqueue('library task', () => new Promise(resolve => { release = () => resolve('completed'); }));
    const activeId = queue.status().active.id;
    assert.equal(queue.cancel(activeId), true);
    release();
    assert.equal(await result, 'completed');
  });
});
