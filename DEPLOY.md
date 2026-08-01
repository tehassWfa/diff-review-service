# Deployment

The service is a single zero-dependency Node.js process (`node server.js`),
so any of these work. Pick whichever you're fastest with — you need it
reachable for the 48-hour scoring window.

## Option A — Render (free web service, easiest for a "real URL")

1. Push this repo to GitHub.
2. On https://render.com -> New -> Web Service -> connect the repo.
3. Build command: (leave blank / `npm install` is fine, there's nothing to install)
4. Start command: `node server.js`
5. Add environment variables:
   - `AUTH_TOKEN` = a long random string (generate with `openssl rand -hex 24`)
   - `PORT` — Render sets this automatically; the server already reads `process.env.PORT`.
   - Optionally `LLM_API_KEY`, `LLM_MODEL`, `LLM_BASE_URL` for the `llm` path.
6. Deploy. Your base URL is `https://<your-service>.onrender.com`.
7. Sanity check: `curl https://<your-service>.onrender.com/health`

Note: Render's free tier can spin down on idle and take ~30s to wake on the
first request. If you're worried about the scoring window's 30s latency
budget being eaten by a cold start, either use a paid instance, a different
host, or ping `/health` periodically to keep it warm.

## Option B — Fly.io (free-tier friendly, no cold-start spin-down issue)

```bash
fly launch --no-deploy   # generates a fly.toml; choose a Node.js app
fly secrets set AUTH_TOKEN=$(openssl rand -hex 24)
# optionally: fly secrets set LLM_API_KEY=... LLM_MODEL=...
fly deploy
```

Fly auto-detects the Node app and runs `node server.js` (or use the
`Dockerfile` included in this repo — Fly will use it automatically if
present). Base URL: `https://<your-app>.fly.dev`.

## Option C — Railway

1. https://railway.app -> New Project -> Deploy from GitHub repo.
2. Set the `AUTH_TOKEN` env var (and `LLM_*` if using the llm provider).
3. Railway auto-detects Node and runs `npm start`.
4. Base URL is the generated `*.up.railway.app` domain.

## Option D — Run on your own machine + tunnel (fastest to stand up)

```bash
AUTH_TOKEN=$(openssl rand -hex 24) PORT=3000 node server.js
```

In another terminal, expose it publicly:

```bash
# Option D1: cloudflared (no account needed for a quick tunnel)
cloudflared tunnel --url http://localhost:3000

# Option D2: ngrok
ngrok http 3000
```

Either prints a public HTTPS URL forwarding to your local server. Keep the
terminal (and your machine) up for the full 48-hour window — this is the
main downside of this option versus a hosted deploy.

## Docker (works with any container host: Fly, Render, Cloud Run, etc.)

A `Dockerfile` is included:

```bash
docker build -t diff-review-service .
docker run -p 3000:3000 -e AUTH_TOKEN=your-secret-token diff-review-service
```

## Before you submit

- [ ] `curl https://<base-url>/health` returns `200`.
- [ ] `curl https://<base-url>/spec` returns the limits object and it matches
      the server's actual behavior.
- [ ] A real `POST /v1/reviews` with your bearer token round-trips through
      `GET /v1/reviews/{id}` to `done`.
- [ ] If you configured the `llm` provider, submit one request with
      `"options":{"provider":"llm"}` and confirm it either completes or fails
      gracefully (never a 5xx, never a hang) — this task explicitly asks you
      to verify this end to end before submitting.
- [ ] The token you send in your submission email matches what the server
      is actually configured with (`AUTH_TOKEN` on the host, not the
      locally-generated fallback from a dev run).
