const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { runProcess } = require('../src/main/process-runner');

describe('bounded process runner', () => {
  it('passes arguments and stdin without a shell', async () => {
    const result = await runProcess(process.execPath, ['-e', 'process.stdin.pipe(process.stdout)'], { input: 'safe input\n' });
    assert.equal(result.stdout, 'safe input\n');
  });

  it('rejects null characters and bounds output', async () => {
    await assert.rejects(async () => runProcess(process.execPath, ['bad\0argument']), /null characters/);
    await assert.rejects(
      runProcess(process.execPath, ['-e', 'process.stdout.write("x".repeat(4096))'], { maxOutput: 128 }),
      /output exceeded/
    );
  });

  it('supports abort signals', async () => {
    const controller = new AbortController();
    const operation = runProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { signal: controller.signal });
    controller.abort();
    await assert.rejects(operation, { name: 'AbortError' });
  });
});
