const { spawn } = require('node:child_process');

const DEFAULT_MAX_OUTPUT = 4 * 1024 * 1024;

function assertCommand(command) {
  if (typeof command !== 'string' || !command || /[\0\r\n]/.test(command)) {
    throw new Error('Command must be a non-empty executable path or name');
  }
}

function assertArguments(args) {
  if (!Array.isArray(args) || args.length > 10_000) {
    throw new Error('Process arguments must be an array containing at most 10,000 items');
  }
  return args.map((argument) => {
    if (typeof argument !== 'string' || argument.includes('\0')) {
      throw new Error('Process arguments must be strings without null characters');
    }
    return argument;
  });
}

function runProcess(command, args = [], options = {}) {
  assertCommand(command);
  const safeArgs = assertArguments(args);
  const timeoutMs = Number.isSafeInteger(options.timeoutMs) && options.timeoutMs > 0
    ? Math.min(options.timeoutMs, 30 * 60 * 1000)
    : 30_000;
  const maxOutput = Number.isSafeInteger(options.maxOutput) && options.maxOutput > 0
    ? Math.min(options.maxOutput, 64 * 1024 * 1024)
    : DEFAULT_MAX_OUTPUT;

  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let outputExceeded = false;

    const child = spawn(command, safeArgs, {
      cwd: options.cwd,
      env: options.env || process.env,
      windowsHide: true,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (options.signal) options.signal.removeEventListener('abort', abort);
      if (error) reject(error);
      else resolve(result);
    };

    const append = (target, chunk) => {
      if (outputExceeded) return target;
      const next = Buffer.concat([target, Buffer.from(chunk)]);
      if (next.length > maxOutput) {
        outputExceeded = true;
        child.kill();
        return next.subarray(0, maxOutput);
      }
      return next;
    };

    child.stdout.on('data', chunk => { stdout = append(stdout, chunk); });
    child.stderr.on('data', chunk => { stderr = append(stderr, chunk); });

    child.once('error', error => finish(error));
    child.once('close', (code, signal) => {
      const result = {
        code: Number.isInteger(code) ? code : -1,
        signal: signal || null,
        stdout: stdout.toString(options.encoding || 'utf8'),
        stderr: stderr.toString(options.encoding || 'utf8')
      };
      if (outputExceeded) {
        const error = new Error(`Process output exceeded ${maxOutput} bytes`);
        error.result = result;
        return finish(error);
      }
      if (options.rejectOnError !== false && result.code !== 0) {
        const message = result.stderr.trim() || result.stdout.trim() || `Process exited with code ${result.code}`;
        const error = new Error(message);
        error.result = result;
        return finish(error);
      }
      finish(null, result);
    });

    const abort = () => {
      child.kill();
      const error = new Error('Operation was cancelled');
      error.name = 'AbortError';
      finish(error);
    };
    if (options.signal) {
      if (options.signal.aborted) return abort();
      options.signal.addEventListener('abort', abort, { once: true });
    }

    if (options.input !== undefined) child.stdin.end(options.input);
    else child.stdin.end();

    timer = setTimeout(() => {
      child.kill();
      const error = new Error(`Process timed out after ${timeoutMs} ms`);
      error.code = 'PROCESS_TIMEOUT';
      finish(error);
    }, timeoutMs);
    timer.unref?.();
  });
}

module.exports = { runProcess };
