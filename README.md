# ai-cli-bridge

Turn your **Claude Max** / **OpenAI Pro** subscriptions into a private HTTP API that any project can consume.

This server wraps the [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) and [Codex CLI](https://github.com/openai/codex) behind an Express API. Instead of paying per-token, requests are backed by your existing subscription.

## Why

AI API calls are expensive at scale. If you already pay for Claude Max (~$100-200/mo) or OpenAI Pro (~$200/mo), that usage is locked to the CLI tools — they can't be called from web apps, plugins, or other HTTP clients. This project bridges that gap.

| Approach | Auth | Billing |
|---|---|---|
| SDK (Anthropic/OpenAI) | API key | Per-token |
| CLI wrapper (this project) | OAuth subscription | Monthly flat rate |

## Features

- **Two providers** — Claude Code CLI (`/generate`) and Codex CLI (`/generate-codex`)
- **Per-user API keys** — SHA-256 hashed, shown once at creation, timing-safe auth
- **Per-key usage limits** — requests/day, requests/month, tokens/month, cost/day, cost/month
- **Admin dashboard** — manage keys, monitor usage, view request logs
- **Usage tracking** — in-memory with periodic disk flush, auto-pruning
- **Security** — `execFile` (no shell injection), temp file permissions, rate limiting, security headers
- **Deploy anywhere** — Docker support, PM2 config, Cloudflare Tunnel template

## Quick Start

### Prerequisites

- Node.js 20+
- pnpm
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) and/or [Codex CLI](https://github.com/openai/codex) installed and authenticated

### Local Development

```bash
git clone https://github.com/Shreyas-Dayal/ai-cli-bridge.git
cd ai-cli-bridge
pnpm install
cp .env.example .env    # Edit to set BRIDGE_ADMIN_KEY
pnpm dev                # Starts on http://localhost:3456
```

### Docker

```bash
cp .env.example .env    # Edit to set BRIDGE_ADMIN_KEY
docker compose up --build -d
```

### Verify

```bash
curl http://localhost:3456/health
# → {"status":"ok"}
```

## Usage

### Generate (Claude)

```bash
curl -X POST http://localhost:3456/generate \
  -H "Authorization: Bearer <USER_KEY>" \
  -H "Content-Type: application/json" \
  -d '{"systemPrompt":"Reply concisely.","userPrompt":"What is 2+2?"}'
```

### Generate (Codex)

```bash
curl -X POST http://localhost:3456/generate-codex \
  -H "Authorization: Bearer <USER_KEY>" \
  -H "Content-Type: application/json" \
  -d '{"systemPrompt":"Reply concisely.","userPrompt":"What is 2+2?"}'
```

### Response Shape

All endpoints return an Anthropic Messages API-compatible response:

```json
{
  "content": [{ "type": "text", "text": "4" }],
  "usage": {
    "input_tokens": 1234,
    "output_tokens": 56
  },
  "cost_usd": 0.003,
  "duration_ms": 4500
}
```

## API Endpoints

### User (Bearer user-key)

| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | Health check (no auth) |
| `POST` | `/generate` | Claude Code CLI |
| `POST` | `/generate-codex` | Codex CLI |

### Admin (Bearer admin-key)

| Method | Path | Description |
|---|---|---|
| `GET` | `/admin/keys` | List all keys + usage |
| `POST` | `/admin/keys` | Create a key |
| `GET` | `/admin/keys/:name` | Key details |
| `PATCH` | `/admin/keys/:name` | Update limits |
| `DELETE` | `/admin/keys/:name` | Revoke a key |
| `POST` | `/admin/keys/:name/reset-usage` | Reset usage counters |
| `GET` | `/admin/logs` | Request logs (`?key=&limit=`) |

## Key Management

Create your first user key:

```bash
curl -X POST http://localhost:3456/admin/keys \
  -H "Authorization: Bearer <ADMIN_KEY>" \
  -H "Content-Type: application/json" \
  -d '{"name":"my-app","maxCostPerMonth":10.00}'
```

The raw key is returned **once** — save it. Only the SHA-256 hash is stored on disk.

All limits default to `0` (unlimited). Available limits: `maxRequestsPerDay`, `maxRequestsPerMonth`, `maxTokensPerMonth`, `maxCostPerDay`, `maxCostPerMonth`.

## Deployment

The recommended production setup is a cheap VPS ($4-6/mo) behind a Cloudflare Tunnel.

See [GUIDE.md](GUIDE.md) for a complete step-by-step deployment walkthrough, and [DEPLOY.md](DEPLOY.md) for a quick deployment reference.

## Configuration

All settings are via environment variables. See [`.env.example`](.env.example) for the full list.

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3456` | Server port |
| `BRIDGE_ADMIN_KEY` | — | Admin key for `/admin/*` endpoints |
| `DATA_DIR` | `./data` | Directory for keys.json, usage.json, logs.json |
| `CORS_ORIGINS` | — | Comma-separated origins (empty = allow all) |
| `RATE_LIMIT_WINDOW_MS` | `60000` | Rate limit window |
| `RATE_LIMIT_MAX_REQUESTS` | `30` | Max requests per window |
| `CLAUDE_DEFAULT_MODEL` | `claude-sonnet-4-20250514` | Default Claude model |
| `CODEX_DEFAULT_MODEL` | `gpt-5.3-codex` | Default Codex model |

## Project Structure

```
src/
  server.ts             Express app, routes, middleware
  config.ts             Environment variable parsing
  keys.ts               Key CRUD, usage tracking, limits
  middleware/auth.ts     Per-user + admin auth (timing-safe)
  providers/
    claude.ts           Claude Code CLI wrapper
    codex.ts            Codex CLI wrapper
public/                 Admin dashboard (HTML/CSS/JS)
data/                   Runtime data (gitignored)
```

## License

[MIT](LICENSE)
