# AI Diff Review Service

A small HTTP service that takes a unified diff and returns structured code
review findings, asynchronously, via a job/poll + SSE-stream API. Implements
the take-home contract exactly. Zero external dependencies — pure Node.js
built-ins (`http`, `crypto`), so it runs anywhere Node 18+ runs with no
`npm install` step.

## Run locally

```bash
AUTH_TOKEN=your-secret-token PORT=3000 node server.js
```

If you don't set `AUTH_TOKEN`, one is generated and printed to the console
at startup (useful for local testing, not for a real deployment — set it
explicitly so it survives restarts).

To enable the `llm` provider, also set:

```bash
LLM_API_KEY=sk-...          # your model vendor's API key
LLM_MODEL=claude-...        # model name/string
LLM_BASE_URL=...            # optional, defaults to Anthropic's /v1/messages
```

## Run the test suite

With the server running on port 3000:

```bash
TEST_BASE=http://localhost:3000 TEST_TOKEN=your-secret-token node test/run.js
```

This exercises the full contract: health/spec, auth, validation/error
taxonomy, exact mock rule findings, ordering, injection inertness,
`maxFindings` truncation, caching, idempotency, chunking (including an
oversized single file), SSE streaming + replay, 404s, `llm` graceful
failure, and concurrency (5 jobs against a 4-worker pool).

## Architecture

```
server.js            HTTP routing, auth, request lifecycle, SSE wiring
lib/parseDiff.js      Unified diff -> per-file blocks + added-line records
lib/mockRules.js       MOCK-* rule table + empty-catch-block detection
lib/chunk.js            Groups files into <=64KiB chunks on file boundaries
lib/llmProvider.js       Real-LLM path; fails gracefully, never throws raw
lib/store.js              In-memory job store, SSE event log, cache, idempotency
lib/queue.js                Concurrency-limited worker queue (max 4)
lib/rateLimit.js              Sliding-window limiter (30 req/min on POST only)
```

### Provider design

Both providers share one pipeline: parse -> chunk -> findings -> dedupe/sort
-> truncate -> cache -> emit. `mock` computes findings via the deterministic
rule table in `lib/mockRules.js`. `llm` sends the diff to a configured model
with a prompt asking for the same JSON finding shape, then validates and
normalizes whatever comes back (dropping malformed entries rather than
letting bad model output crash the job). If `LLM_API_KEY`/`LLM_MODEL` aren't
set, or the call fails/times out, the job transitions to `failed` with a
clear error — never a crash, never a 5xx.

### Job lifecycle & SSE

Every state transition and finding is appended to an in-memory per-job event
log as it happens. A live SSE client gets pushed events as they occur; a
client connecting after the job is done gets the entire event log replayed
verbatim and the connection closes — so replay is byte-for-byte identical to
having watched it live.

### Caching vs. idempotency

These are two different mechanisms:

- **Idempotency** (`Idempotency-Key` header) is about safe retries of the
  *same request*: same key + same body -> same `jobId`. Same key + different
  body -> `409`.
- **Caching** is about not re-doing work for *content* that's been seen
  before, regardless of key: a SHA-256 hash of `{diff, normalizedOptions}`
  keys a results cache. A repeat submission (with or without an idempotency
  key) gets a fresh `jobId` but resolves instantly with `cacheHit: true` and
  byte-identical findings.

### Chunking

Diffs are parsed into per-file blocks first; chunks are then formed by
packing whole files up to 64 KiB each, never splitting a file. A single file
over 64 KiB becomes its own (oversized) chunk. Because rule evaluation is
per-added-line and file-scoped, chunking never changes the finding set —
only how the work is grouped and counted in `usage.chunks`.

## Deployment

See `DEPLOY.md`.
