# CLAUDE.md — ai-cli-bridge

## What This Is

HTTP bridge server wrapping Claude Code CLI and Codex CLI behind an Express API. Uses Max/Pro subscriptions instead of per-token API keys. Designed to deploy on any VPS behind a reverse proxy or Cloudflare Tunnel.

## Stack

- **Runtime:** Bun, TypeScript, ES modules
- **Framework:** Express 4
- **Package manager:** bun
- **Process manager:** PM2 (fork mode)
- **Tunnel:** Cloudflare Tunnel (cloudflared)
- **No database** — JSON file persistence (`data/keys.json`, `data/usage.json`, `data/logs.json`)

## Project Layout

```
src/
  server.ts           — Express app, routes, middleware, security headers
  config.ts           — Env var parsing + defaults
  keys.ts             — KeyManager: hashed key CRUD, usage tracking, limits, request logs
  middleware/auth.ts   — Per-user key auth + admin auth (timing-safe)
  providers/
    claude.ts         — Claude Code CLI wrapper (execFile, temp files, JSON parse)
    codex.ts          — Codex CLI wrapper (execFile, JSONL parse, cost estimation)
public/
  admin.html          — Dashboard markup
  admin.css           — Dashboard styles
  admin.js            — Dashboard logic
dist/                 — Compiled JS (gitignored)
data/                 — Runtime data (gitignored, 0o600 permissions)
```

## Commands

```bash
bun dev               # Dev server with watch
bun run build         # TypeScript compile (tsc)
bun start             # Run via bun
bun start:prod        # Run compiled JS (bun dist/server.js)
```

## Build & Deploy

```bash
bun run build
rsync -avz --exclude node_modules --exclude .env --exclude data --exclude .git \
  ./ <YOUR_SERVER>:/path/to/ai-cli-bridge/
ssh <YOUR_SERVER> "pm2 restart ai-cli-bridge"
```

Static-only changes (public/) don't need a server restart.

See `DEPLOY.md` for full reference.

## Architecture

- **Two-thread CLI wrapping:** `execFile()` spawns CLI, pipes prompt via stdin, parses JSON/JSONL output. `execFile` (not `exec`) prevents shell injection.
- **Endpoint-based routing:** `/generate` → Claude CLI, `/generate-codex` → Codex CLI.
- **Auth:** SHA-256 hashed keys with `crypto.timingSafeEqual`. Raw keys never stored — shown once at creation. `req.keyHash` on request object, never `req.rawKey`.
- **Limits:** Per-key: requests/day, requests/month, tokens/month, cost/day, cost/month. All default 0 (unlimited).
- **Usage tracking:** In-memory with 30s dirty-flag flush to disk. Daily entries pruned >90 days, monthly >12 months.
- **Request logs:** Append-only in `logs.json`, capped at 1000 entries FIFO, prompts truncated to 200 chars.
- **Admin dashboard:** Static HTML/CSS/JS served via `express.static` before admin auth middleware. Uses `sessionStorage` for admin key.

## Key Patterns

- **Config:** All via env vars (see `.env.example`). `config.ts` exports a single `config` object.
- **Temp files:** System prompts written to `/tmp/cli-bridge-<uuid>.txt` with `mode: 0o600`, cleaned up after use.
- **Error handling:** Detailed errors logged server-side, generic `"Generation failed"` returned to clients.
- **Trust proxy:** `app.set('trust proxy', 1)` — required for rate limiting behind Cloudflare Tunnel.
- **Graceful shutdown:** SIGTERM/SIGINT flush dirty usage + logs to disk.
- **Cost in Codex:** Estimated from hardcoded pricing table (not returned by CLI). Claude CLI returns `total_cost_usd`.

## TypeScript Notes

- `strict: true` in tsconfig
- ES2020 target and modules, `bundler` moduleResolution
- Express Request augmented with `keyName?: string` and `keyHash?: string` (declared in `middleware/auth.ts`)
- Output to `dist/`, source in `src/`

## Server Paths

| What | Path |
|---|---|
| Project (server) | `/path/to/ai-cli-bridge/` |
| Data dir | `<project>/data/` |
| Env config | `<project>/.env` |
| PM2 config | `<project>/ecosystem.config.cjs` |
| Dashboard | `https://<YOUR_DOMAIN>/admin/dashboard/admin.html` |

## API Endpoints

**User** (Bearer user-key):
- `POST /generate` — Claude Code CLI
- `POST /generate-codex` — Codex CLI
- `GET /health` — No auth

**Admin** (Bearer admin-key):
- `GET /admin/keys` — List keys + usage
- `POST /admin/keys` — Create key
- `GET /admin/keys/:name` — Key details
- `PATCH /admin/keys/:name` — Update limits
- `DELETE /admin/keys/:name` — Revoke key
- `POST /admin/keys/:name/reset-usage` — Reset counters
- `GET /admin/logs?key=&limit=` — Request logs

## Testing

No test framework. Verify manually:

```bash
# Health
curl -s https://<YOUR_DOMAIN>/health

# Generate
curl -s -X POST https://<YOUR_DOMAIN>/generate-codex \
  -H "Authorization: Bearer <KEY>" \
  -H "Content-Type: application/json" \
  -d '{"systemPrompt":"Reply concisely.","userPrompt":"What is 2+2?"}'
```
