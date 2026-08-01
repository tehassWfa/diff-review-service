'use strict';

class ConcurrencyQueue {
  constructor(maxConcurrent) {
    this.maxConcurrent = maxConcurrent;
    this.running = 0;
    this.pending = [];
  }

  // task: async () => void. Never throws out of run() — caller's task should
  // handle its own errors (we still guard here to avoid unhandled rejections
  // taking down the process).
  push(task) {
    this.pending.push(task);
    this._drain();
  }

  _drain() {
    while (this.running < this.maxConcurrent && this.pending.length > 0) {
      const task = this.pending.shift();
      this.running++;
      Promise.resolve()
        .then(task)
        .catch((err) => {
          // Defensive: task implementations should already catch their own
          // errors and mark the job failed. This is a last-resort net.
          console.error('unhandled task error:', err);
        })
        .finally(() => {
          this.running--;
          this._drain();
        });
    }
  }
}

module.exports = { ConcurrencyQueue };
