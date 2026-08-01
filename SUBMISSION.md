# SUBMISSION

## Architecture (10 lines)

Single Node.js process, zero external dependencies (built-in `http`/`crypto`
only, for maximum deploy portability). Request lifecycle: auth check ->
validate/parse body -> idempotency check -> content-hash cache check ->
create job, respond `202` immediately -> background worker (4-slot
concurrency queue) parses the diff into per-file blocks, groups them into
<=64KiB chunks on file boundaries, runs the selected provider, dedupes/sorts
findings by `(path, line, ruleId)`, truncates to `maxFindings`, caches the
full result by content hash, and marks the job `done`/`failed`. Every state
transition and finding is appended to an in-memory per-job event log as it
happens, which both drives live SSE pushes and lets a late-connecting client
get an identical replay. A sliding-window limiter gates `POST /v1/reviews`
at 30/min; all other routes are ungated.

## Provider design

Both providers sit behind the same pipeline (parse -> chunk -> findings ->
dedupe/sort -> truncate -> cache). `mock` runs a deterministic rule table
against added lines (plus a small brace-depth scanner for the empty-catch
rule, since it can span lines). `llm` sends the diff to a model configured
entirely via server-side env vars (`LLM_API_KEY`, `LLM_MODEL`,
`LLM_BASE_URL`) with a prompt requesting the same finding JSON shape, then
validates and drops any malformed entries from the response rather than
trusting it blindly. Any failure in the `llm` path — missing config,
network error, timeout, unparseable response — is caught and turned into a
`failed` job with a specific error message; nothing in that path can crash
the process or return a 5xx.

## How I verified the cross-cutting behaviors

Wrote `test/run.js`, an automated suite that runs against a live instance
(no mocking of the HTTP layer) and checks: exact `MOCK-*` rule triggering on
a crafted diff exercising every rule, finding ordering, `maxFindings`
truncation while `usage` still reflects the full scan, injection content
appearing as a finding rather than altering behavior, cache-hit correctness
(byte-identical findings on repeat submission), idempotency (same key+body
-> same jobId, same key+different body -> 409), chunking with a
deliberately oversized single file (confirms one file over 64KiB becomes its
own chunk and findings still match an unchunked scan), SSE replay after job
completion, 404 on unknown job IDs, and 5-jobs-against-4-workers concurrency
(5th job completes rather than failing). Rate limiting was checked
separately by firing 35 rapid submissions and confirming exactly 30
succeeded with `Retry-After` present on the rejected ones. All of this is
re-runnable: `node test/run.js` against any running instance.

Deployed to Render (Node runtime, free tier). After deploy, re-verified
against the live URL specifically (not just localhost): `GET /spec` matches
the declared limits, an authenticated `POST /v1/reviews` against a real diff
returns `202` with a `jobId`, polling `GET /v1/reviews/{id}` reaches
`status: done` with the expected `MOCK-007` finding, and a repeat submission
of the same diff returns `cacheHit: true` — confirming the deployed instance
behaves identically to the local dev server, not just that it boots.

I also verified the `llm` path end to end against the live deployment, per
the task's explicit ask to confirm this before submitting. I configured
`LLM_API_KEY`/`LLM_MODEL`/`LLM_BASE_URL`/`LLM_API_STYLE` to point at Google's
Gemini API (`gemini-3.6-flash`) via its OpenAI-compatible endpoint — a
deliberate choice since Gemini's free tier requires no billing setup, and
the task states model sourcing is up to the candidate. This required one
small code addition: `lib/llmProvider.js` originally only spoke Anthropic's
Messages API request/response shape, so I added a second caller for the
OpenAI-compatible chat-completions shape (selected via `LLM_API_STYLE`),
which Gemini, OpenAI itself, and other compatible vendors all support. A
real request against the live URL with `options.provider: "llm"` returned
`status: done` with a well-formed finding (`LLM:f.ts:2:Unexpected console
statement`, correct path/line/evidence) — confirming the full pipeline
(auth -> parse -> real model call -> response validation -> job store)
works against an actual model, not just the documented graceful-failure
path.

## AI tools used

Built with Claude (Anthropic) as an AI pair-programmer for the full
implementation — diff parser, rule engine, chunking, job store/SSE event
log, concurrency queue, rate limiter, the test suite, and later the
OpenAI-compatible caller added to support the `llm` provider against
Gemini — plus this document.

## An AI suggestion I rejected

The first pass of the 413 (payload-too-large) handler called
`req.destroy()` the moment the byte limit was exceeded, on the theory that
you should stop accepting more data immediately. Running the test suite
against the live server showed this was wrong: in Node's `http` server,
the request and response share the same underlying socket, so destroying
`req` also kills the connection the `413` response needed to go out on —
clients got a hard connection reset instead of a clean error envelope.
Fixed by letting the stream drain (dropping bytes past the limit without
destroying anything) and sending the proper `413` once `end` fires. Kept
the test suite specifically to catch this class of "looks right, breaks
under an actual request" bug.

## What I'd do next with more time

- Replace the empty-catch-block scanner (currently a hand-rolled
  brace-depth walk over added lines only) with a real lightweight parser —
  it currently bails out (skips, rather than guesses) whenever a catch
  block's body isn't fully contained in contiguous added lines, which is
  safe but conservative.
- Persist jobs/cache to disk or Redis — everything is in-memory today, so a
  process restart loses in-flight and cached jobs.
- Add per-token rate limiting instead of a single global bucket, and make
  the SSE heartbeat explicit (a periodic comment ping) so idle connections
  survive intermediary proxies' timeouts.
- Add streaming/partial LLM parsing so very large diffs to the `llm`
  provider don't wait on one big completion.

If I had more time before the deadline, I'd also add a keep-alive ping so
the free-tier host doesn't cold-start on the first request of the scoring
window, and I'd extend the `llm` provider's prompt/validation with a retry
on malformed model output rather than dropping it silently.