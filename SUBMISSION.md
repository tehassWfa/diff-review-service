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

*[Candidate: if you changed the deployment target or added anything past
what's described here, note how you verified it against the deployed URL
specifically, not just localhost.]*

## AI tools used

Built with Claude (Anthropic) as an AI pair-programmer for the full
implementation — diff parser, rule engine, chunking, job store/SSE event
log, concurrency queue, rate limiter, and the test suite — plus this
document.

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

*[Candidate: add your own priorities here if they differ.]*
