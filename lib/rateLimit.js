'use strict';

// Sliding-window limiter: allows up to `limit` requests in any trailing
// `windowMs` period. Sustained `limit`/minute succeeds by construction since
// we only reject once the window already holds `limit` timestamps.
class SlidingWindowLimiter {
  constructor(limit, windowMs) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.timestamps = [];
  }

  check() {
    const now = Date.now();
    const cutoff = now - this.windowMs;
    while (this.timestamps.length > 0 && this.timestamps[0] <= cutoff) {
      this.timestamps.shift();
    }
    if (this.timestamps.length >= this.limit) {
      const retryAfterMs = this.timestamps[0] + this.windowMs - now;
      return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000)) };
    }
    this.timestamps.push(now);
    return { allowed: true };
  }
}

module.exports = { SlidingWindowLimiter };
