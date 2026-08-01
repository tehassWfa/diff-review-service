'use strict';

const http = require('http');
const crypto = require('crypto');

const { parseDiff } = require('./lib/parseDiff');
const { findMockFindings, dedupeAndSort } = require('./lib/mockRules');
const { chunkFiles, CHUNK_BYTES } = require('./lib/chunk');
const { runLlmReview } = require('./lib/llmProvider');
const { Store, writeSseEvent, sha256 } = require('./lib/store');
const { ConcurrencyQueue } = require('./lib/queue');
const { SlidingWindowLimiter } = require('./lib/rateLimit');

const PORT = Number(process.env.PORT) || 3000;
const VERSION = '1.0.0';
const MAX_PAYLOAD_BYTES = 1048576; // 1 MiB
const MAX_CONCURRENT_JOBS = 4;
const RATE_LIMIT_PER_MINUTE = 30;

// Token is either supplied via env (recommended for real deployments) or
// generated at startup and printed to the console.
const AUTH_TOKEN = process.env.AUTH_TOKEN || crypto.randomBytes(24).toString('hex');

const startTime = Date.now();
const store = new Store();
const queue = new ConcurrencyQueue(MAX_CONCURRENT_JOBS);
const rateLimiter = new SlidingWindowLimiter(RATE_LIMIT_PER_MINUTE, 60000);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function sendError(res, status, code, message) {
  sendJson(res, status, { error: { code, message } });
}

function safeCompare(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function checkAuth(req) {
  const header = req.headers['authorization'];
  if (!header || !header.startsWith('Bearer ')) return false;
  const token = header.slice('Bearer '.length);
  return safeCompare(token, AUTH_TOKEN);
}

function collectBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const chunks = [];
    let size = 0;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    let overLimit = false;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        overLimit = true;
        return; // stop accumulating, but keep draining the stream so 'end' fires
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (overLimit) return finish({ tooLarge: true, raw: null });
      finish({ tooLarge: false, raw: Buffer.concat(chunks).toString('utf8') });
    });
    req.on('aborted', () => finish({ tooLarge: true, raw: null }));
    req.on('error', (err) => {
      if (!settled) reject(err);
    });
  });
}

function handleHealth(res) {
  sendJson(res, 200, {
    status: 'ok',
    version: VERSION,
    uptimeSeconds: Math.floor((Date.now() - startTime) / 1000),
  });
}

function handleSpec(res) {
  sendJson(res, 200, {
    specVersion: '1.0',
    providers: ['mock', 'llm'],
    limits: {
      maxPayloadBytes: MAX_PAYLOAD_BYTES,
      chunkBytes: CHUNK_BYTES,
      maxConcurrentJobs: MAX_CONCURRENT_JOBS,
      rateLimitPerMinute: RATE_LIMIT_PER_MINUTE,
    },
  });
}

async function processJob(job, diffText, provider, maxFindings, contentHash) {
  try {
    store.setStatus(job, 'running');

    const inputBytes = Buffer.byteLength(diffText, 'utf8');
    const parsed = parseDiff(diffText);
    const chunks = chunkFiles(parsed.files);
    const chunkCount = parsed.files.length === 0 ? 0 : chunks.length;

    job.usage.inputBytes = inputBytes;
    job.usage.chunks = chunkCount;

    let findings;

    if (provider === 'llm') {
      try {
        findings = await runLlmReview(diffText, maxFindings);
      } catch (e) {
        store.finishFailed(job, e.message || 'llm provider error');
        return;
      }
    } else {
      let all = [];
      for (const group of chunks) {
        // Small yield per chunk: makes 'running' observable and mirrors how
        // a real chunked pipeline would process sequentially. Findings are
        // computed identically to an unchunked scan (chunking never changes
        // rule evaluation, only how work is grouped).
        await sleep(2);
        all = all.concat(findMockFindings(group));
      }
      findings = dedupeAndSort(all);
    }

    const truncated = findings.slice(0, maxFindings);
    for (const f of truncated) store.addFinding(job, f);

    store.cacheSet(contentHash, {
      findings: truncated,
      usage: { inputBytes: job.usage.inputBytes, chunks: job.usage.chunks },
    });

    store.finishDone(job);
  } catch (err) {
    store.finishFailed(job, `internal error: ${err.message}`);
  }
}

async function handleCreateReview(req, res) {
  const rl = rateLimiter.check();
  if (!rl.allowed) {
    res.setHeader('Retry-After', String(rl.retryAfterSeconds));
    return sendError(res, 429, 'rate_limited', 'Too many requests, slow down.');
  }

  let collected;
  try {
    collected = await collectBody(req, MAX_PAYLOAD_BYTES);
  } catch (e) {
    return sendError(res, 400, 'invalid_json', 'Failed to read request body');
  }
  if (collected.tooLarge) {
    return sendError(res, 413, 'payload_too_large', `Payload exceeds ${MAX_PAYLOAD_BYTES} bytes`);
  }

  let body;
  try {
    body = JSON.parse(collected.raw);
  } catch (e) {
    return sendError(res, 400, 'invalid_json', 'Request body is not valid JSON');
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return sendError(res, 400, 'invalid_json', 'Request body must be a JSON object');
  }

  const diffText = body.diff;
  if (typeof diffText !== 'string' || diffText.trim() === '') {
    return sendError(res, 422, 'invalid_diff', 'diff is missing or empty');
  }
  const parsedCheck = parseDiff(diffText);
  if (!parsedCheck.valid) {
    return sendError(res, 422, 'invalid_diff', 'diff could not be parsed as a unified diff');
  }

  const rawOptions = body.options && typeof body.options === 'object' ? body.options : {};
  const provider = rawOptions.provider === 'llm' ? 'llm' : 'mock';
  const maxFindings =
    Number.isInteger(rawOptions.maxFindings) && rawOptions.maxFindings >= 0
      ? rawOptions.maxFindings
      : 100;
  const normalizedOptions = { provider, maxFindings };

  const idempotencyKey = req.headers['idempotency-key'];
  const bodyHash = sha256(collected.raw);

  if (idempotencyKey) {
    const existing = store.idempotencyGet(idempotencyKey);
    if (existing) {
      if (existing.bodyHash === bodyHash) {
        const existingJob = store.getJob(existing.jobId);
        return sendJson(res, 202, {
          jobId: existing.jobId,
          status: existingJob ? existingJob.status : 'queued',
        });
      }
      return sendError(
        res,
        409,
        'idempotency_conflict',
        'Idempotency-Key was reused with a different request body'
      );
    }
  }

  const contentHash = sha256(JSON.stringify({ diff: diffText, options: normalizedOptions }));
  const cached = store.cacheGet(contentHash);

  const jobId = crypto.randomUUID();
  const job = store.createJob(jobId);
  if (idempotencyKey) store.idempotencySet(idempotencyKey, bodyHash, jobId);

  sendJson(res, 202, { jobId, status: 'queued' });

  if (cached) {
    setImmediate(() => {
      store.setStatus(job, 'running');
      job.usage = { ...cached.usage, cacheHit: true };
      for (const f of cached.findings) store.addFinding(job, f);
      store.finishDone(job);
    });
  } else {
    queue.push(() => processJob(job, diffText, provider, maxFindings, contentHash));
  }
}

function handleGetReview(res, jobId) {
  const job = store.getJob(jobId);
  if (!job) return sendError(res, 404, 'not_found', 'Unknown jobId');

  const payload = {
    jobId: job.jobId,
    status: job.status,
    usage: job.usage,
  };
  if (job.status === 'done' || job.status === 'failed') {
    payload.findings = job.findings;
  }
  if (job.status === 'failed') {
    payload.error = { code: 'internal', message: job.error };
  }
  sendJson(res, 200, payload);
}

function handleStream(req, res, jobId) {
  const job = store.getJob(jobId);
  if (!job) return sendError(res, 404, 'not_found', 'Unknown jobId');

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  for (const entry of job.events) writeSseEvent(res, entry);

  if (job.status === 'done' || job.status === 'failed') {
    return res.end();
  }

  job.streamClients.add(res);
  req.on('close', () => job.streamClients.delete(res));
}

const server = http.createServer((req, res) => {
  let pathname;
  try {
    pathname = new URL(req.url, `http://${req.headers.host || 'localhost'}`).pathname;
  } catch (e) {
    return sendError(res, 400, 'invalid_json', 'Malformed URL');
  }

  // Normalize a trailing slash (e.g. "/health/" -> "/health") so monitoring
  // tools that append one don't get a spurious 404. Root "/" is untouched.
  if (pathname.length > 1 && pathname.endsWith('/')) {
    pathname = pathname.slice(0, -1);
  }

  // Health/status checkers commonly send HEAD instead of GET to save
  // bandwidth. Treat HEAD like GET for the public health/spec endpoints.
  const method = req.method === 'HEAD' ? 'GET' : req.method;

  if (method === 'GET' && pathname === '/health') return handleHealth(res);
  if (method === 'GET' && pathname === '/spec') return handleSpec(res);

  if (pathname.startsWith('/v1/')) {
    if (!checkAuth(req)) {
      return sendError(res, 401, 'unauthorized', 'Missing or invalid bearer token');
    }

    if (req.method === 'POST' && pathname === '/v1/reviews') {
      return handleCreateReview(req, res).catch((err) => {
        console.error('handleCreateReview error:', err);
        if (!res.headersSent) sendError(res, 500, 'internal', 'Internal server error');
      });
    }

    const streamMatch = pathname.match(/^\/v1\/reviews\/([^/]+)\/stream$/);
    if (req.method === 'GET' && streamMatch) return handleStream(req, res, streamMatch[1]);

    const getMatch = pathname.match(/^\/v1\/reviews\/([^/]+)$/);
    if (req.method === 'GET' && getMatch) return handleGetReview(res, getMatch[1]);

    return sendError(res, 404, 'not_found', 'Unknown route');
  }

  return sendError(res, 404, 'not_found', 'Unknown route');
});

server.listen(PORT, () => {
  console.log(`AI diff review service listening on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
  if (!process.env.AUTH_TOKEN) {
    console.log(`No AUTH_TOKEN env var set — generated bearer token for this run:`);
    console.log(`  ${AUTH_TOKEN}`);
    console.log(`Set AUTH_TOKEN env var to pin a stable token across restarts.`);
  }
  if (!process.env.LLM_API_KEY || !process.env.LLM_MODEL) {
    console.log(
      `LLM provider not configured (set LLM_API_KEY and LLM_MODEL to enable "llm" provider). ` +
        `Requests with options.provider="llm" will fail gracefully with a clear error.`
    );
  }
});

module.exports = { server, AUTH_TOKEN };