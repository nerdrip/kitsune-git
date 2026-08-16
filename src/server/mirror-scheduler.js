const crypto = require('node:crypto');

class MirrorScheduler {
  constructor({ projects, mirrors = null, store = null, tickMilliseconds = 60_000 }) {
    this.projects = projects;
    this.store = store;
    this.mirrors = mirrors;
    this.owner = `${process.pid}:${crypto.randomUUID()}`;
    this.tickMilliseconds = tickMilliseconds;
    this.timer = null;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick().catch(error => console.error('[mirror]', error.message)), this.tickMilliseconds);
    this.timer.unref?.();
    void this.tick();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(now = Date.now()) {
    if (this.store?.acquireLease && !this.store.acquireLease('mirror-scheduler', this.owner, this.tickMilliseconds * 2, now)) return 0;
    const due = this.projects.list().filter(project => {
      if (!project.mirror || !project.sourceUrl) return false;
      const last = Date.parse(project.lastMirrorAt || project.createdAt || 0);
      return !Number.isFinite(last) || now - last >= project.mirrorIntervalMinutes * 60_000;
    });
    await Promise.allSettled(due.map(project => this.mirrors ? this.mirrors.sync(project.id, 'scheduler') : this.projects.sync(project.id)));
    return due.length;
  }
}

module.exports = { MirrorScheduler };
