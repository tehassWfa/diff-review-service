'use strict';

const crypto = require('crypto');

class Store {
  constructor() {
    this.jobs = new Map(); // jobId -> job
    this.cache = new Map(); // contentHash -> { findings, usage: {inputBytes, chunks} }
    this.idempotency = new Map(); // key -> { bodyHash, jobId }
  }

  createJob(jobId) {
    const job = {
      jobId,
      status: 'queued',
      findings: [],
      usage: { inputBytes: 0, chunks: 0, cacheHit: false },
      error: null,
      events: [], // { event: 'status'|'finding'|'done', data: {...} }
      streamClients: new Set(),
      createdAt: Date.now(),
    };
    this.jobs.set(jobId, job);
    return job;
  }

  getJob(jobId) {
    return this.jobs.get(jobId) || null;
  }

  emit(job, event, data) {
    const entry = { event, data };
    job.events.push(entry);
    for (const res of job.streamClients) {
      writeSseEvent(res, entry);
    }
  }

  setStatus(job, status) {
    job.status = status;
    this.emit(job, 'status', { status });
  }

  addFinding(job, finding) {
    job.findings.push(finding);
    this.emit(job, 'finding', finding);
  }

  finishDone(job) {
    job.status = 'done';
    this.emit(job, 'status', { status: 'done' });
    const payload = { total: job.findings.length, usage: job.usage };
    this.emit(job, 'done', payload);
    for (const res of job.streamClients) {
      try { res.end(); } catch (_) { /* noop */ }
    }
    job.streamClients.clear();
  }

  finishFailed(job, errorMessage) {
    job.status = 'failed';
    job.error = errorMessage;
    this.emit(job, 'status', { status: 'failed' });
    const payload = { total: job.findings.length, usage: job.usage, error: errorMessage };
    this.emit(job, 'done', payload);
    for (const res of job.streamClients) {
      try { res.end(); } catch (_) { /* noop */ }
    }
    job.streamClients.clear();
  }

  cacheGet(contentHash) {
    return this.cache.get(contentHash) || null;
  }

  cacheSet(contentHash, result) {
    this.cache.set(contentHash, result);
  }

  idempotencyGet(key) {
    return this.idempotency.get(key) || null;
  }

  idempotencySet(key, bodyHash, jobId) {
    this.idempotency.set(key, { bodyHash, jobId });
  }
}

function writeSseEvent(res, entry) {
  try {
    res.write(`event: ${entry.event}\n`);
    res.write(`data: ${JSON.stringify(entry.data)}\n\n`);
  } catch (_) {
    // client likely disconnected; ignore
  }
}

function sha256(input) {
  return crypto.createHash('sha256').update(input).digest('hex');
}

module.exports = { Store, writeSseEvent, sha256 };
