class OperationQueue {
  constructor({ onChange = () => {} } = {}) {
    this.onChange = onChange;
    this.active = null;
    this.pending = [];
    this.nextId = 1;
  }

  isBusy() {
    return Boolean(this.active || this.pending.length);
  }

  status() {
    const serialize = item => item && ({
      id: item.id,
      label: item.label,
      state: item.state,
      queuedAt: item.queuedAt,
      startedAt: item.startedAt || null,
      cancelRequested: item.controller.signal.aborted
    });
    return { active: serialize(this.active), pending: this.pending.map(serialize) };
  }

  enqueue(label, task) {
    if (typeof label !== 'string' || !label || typeof task !== 'function') throw new Error('Queued operation is invalid');
    return new Promise((resolve, reject) => {
      const item = {
        id: this.nextId++,
        label,
        task,
        resolve,
        reject,
        controller: new AbortController(),
        state: 'queued',
        queuedAt: Date.now(),
        startedAt: null
      };
      this.pending.push(item);
      this._notify();
      void this._drain();
    });
  }

  cancel(id) {
    if (!Number.isSafeInteger(id) || id < 1) throw new Error('Operation id is invalid');
    if (this.active?.id === id) {
      this.active.controller.abort();
      this._notify();
      return true;
    }
    const index = this.pending.findIndex(item => item.id === id);
    if (index < 0) return false;
    const [item] = this.pending.splice(index, 1);
    item.controller.abort();
    const error = new Error('Operation was cancelled before it started');
    error.name = 'AbortError';
    item.reject(error);
    this._notify();
    return true;
  }

  async _drain() {
    if (this.active || this.pending.length === 0) return;
    const item = this.pending.shift();
    this.active = item;
    item.state = 'running';
    item.startedAt = Date.now();
    this._notify();
    try {
      const result = await item.task(item.controller.signal);
      // Some library-backed Git calls cannot be interrupted once started. If
      // such a task completes normally after a cancellation request, surface
      // its real result instead of falsely reporting that no mutation occurred.
      item.resolve(result);
    } catch (error) {
      item.reject(error);
    } finally {
      this.active = null;
      this._notify();
      queueMicrotask(() => void this._drain());
    }
  }

  _notify() {
    try { this.onChange(this.status()); } catch { /* observer errors must not break Git operations */ }
  }
}

module.exports = { OperationQueue };
