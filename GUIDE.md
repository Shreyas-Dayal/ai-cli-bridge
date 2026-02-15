# AI CLI Bridge: Complete Architecture & Deployment Guide

Turn your Claude Max / OpenAI Pro subscriptions into a private API endpoint that any project can consume.

## Table of Contents

- [Problem Statement](#problem-statement)
- [Why CLI Wrappers Instead of SDKs](#why-cli-wrappers-instead-of-sdks)
- [Architecture Overview](#architecture-overview)
- [CLI Capability Matrix](#cli-capability-matrix)
- [Project Structure](#project-structure)
- [Security Measures](#security-measures)
- [Step-by-Step Deployment](#step-by-step-deployment)
- [Using the Bridge From Other Projects](#using-the-bridge-from-other-projects)
- [API Reference](#api-reference)
- [Maintenance & Operations](#maintenance--operations)

---

## Problem Statement

AI API calls are expensive at scale. If you already pay for **Claude Max** (~$100-200/mo) or **OpenAI Pro** (~$200/mo), you're paying for generous usage that's locked to the CLI tools (Claude Code CLI, Codex CLI). These CLIs can only run locally from a terminal — they can't be called from web apps, Figma plugins, mobile apps, or any HTTP-based client.

**This project bridges that gap:** it wraps the CLIs behind an HTTP API, deploys to a cheap server, and exposes a URL that any project can use as if it were a regular AI API — backed by your subscription instead of per-token billing.

---

## Why CLI Wrappers Instead of SDKs

The obvious question: why not use the Anthropic SDK (`@anthropic-ai/sdk`) or OpenAI SDK directly?

**Because SDKs require API keys billed per-token.** The entire point is to use your existing subscription. The CLI tools authenticate via OAuth to your Max/Pro account, and usage counts against your subscription's monthly allocation — not a separate API bill.

| Approach | Auth | Billing | Setup |
|---|---|---|---|
| SDK (Anthropic/OpenAI) | API key | Per-token ($$$) | Simple |
| CLI wrapper (this project) | OAuth subscription | Monthly flat rate | More setup, but free per-request |

The tradeoff: more infrastructure complexity in exchange for dramatically lower marginal cost per request.

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│  Your Other Projects (web apps, plugins, scripts, etc.)         │
│  fetch('https://bridge.yourdomain.com/generate', {              │
│    headers: { Authorization: 'Bearer <BRIDGE_KEY>' },           │
│    body: { systemPrompt, userPrompt, model }                    │
│  })                                                             │
└────────────────────────────┬────────────────────────────────────┘
                             │ HTTPS
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│  Cloudflare Tunnel                                              │
│  - Free TLS termination                                         │
│  - DDoS protection                                              │
│  - No open ports on server                                      │
│  - Custom domain (bridge.yourdomain.com)                        │
└────────────────────────────┬────────────────────────────────────┘
                             │ HTTP (localhost only)
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│  DigitalOcean Droplet ($4-6/mo)                                 │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │  ai-cli-bridge (Express server, managed by PM2)           │  │
│  │  - Bearer token auth (timing-safe comparison)             │  │
│  │  - Rate limiting                                          │  │
│  │  - Input validation                                       │  │
│  │  - Security headers                                       │  │
│  │  - Usage stats tracking                                   │  │
│  └──────────┬──────────────────────────┬─────────────────────┘  │
│             │                          │                         │
│             ▼                          ▼                         │
│  ┌──────────────────┐      ┌──────────────────────┐             │
│  │  Claude Code CLI  │      │  Codex CLI            │            │
│  │  (OAuth → Max)    │      │  (OAuth → Pro)        │            │
│  └──────────────────┘      └──────────────────────┘             │
└─────────────────────────────────────────────────────────────────┘
```

### Why This Stack

- **DigitalOcean Droplet ($4-6/mo):** The CLIs call remote APIs, so CPU/RAM needs are minimal. Cheapest tier works fine.
- **Cloudflare Tunnel:** Eliminates the need to open any ports on the droplet. All traffic flows through Cloudflare's network. Free TLS, free DDoS protection, and a clean domain name.
- **PM2:** Process manager that auto-restarts the server on crash and survives reboots via systemd integration.
- **Express:** Minimal HTTP framework. The server is ~200 lines — just middleware, validation, and CLI invocation.

### Why Not Docker in Production

While a Dockerfile is included for reproducibility, the recommended deployment is **directly on the droplet** (not containerized). Reason: the CLIs require interactive OAuth authentication, which is easier to do via SSH than inside a container. Once authenticated, the tokens persist on the filesystem.

---

## CLI Capability Matrix

Important to understand what you get (and don't get) using CLI vs API:

| Capability | Claude Code CLI (Max) | Claude API (paid) | Codex CLI (Pro) |
|---|---|---|---|
| Extended thinking | Automatic | Fine-grained budget control | Automatic |
| Web search | No native tool | `web_search` tool | No native tool |
| Vision/images | Supported | Supported | Supported |
| Tool use | Bash, file read/write | Custom tool definitions | Sandbox-based |
| Streaming | Possible (via `spawn()`) | Native SSE | Possible |
| Model selection | Limited to subscription tier | Any model | Limited to subscription |
| Usage limits | Monthly subscription cap | Pay-per-token, no cap | Monthly cap |
| Prompt caching | Automatic | Manual API params | Automatic |

**Key limitations:** No web search, no thinking budget control, subscription usage caps apply.

---

## Project Structure

```
ai-cli-bridge/
├── src/
│   ├── server.ts              # Express app — security headers, CORS, rate
│   │                          #   limiting, auth, routes, stats tracking
│   ├── config.ts              # All settings loaded from environment variables
│   ├── middleware/
│   │   └── auth.ts            # Bearer token auth with timing-safe comparison
│   └── providers/
│       ├── claude.ts          # Claude Code CLI wrapper (execFile → promise)
│       └── codex.ts           # Codex CLI wrapper (JSONL parsing)
├── Dockerfile                 # Container build (non-root user, dumb-init)
├── docker-compose.yml         # With health check + auth volume persistence
├── ecosystem.config.cjs       # PM2 process manager configuration
├── cloudflared-config.yml     # Cloudflare Tunnel config template
├── setup.sh                   # One-shot droplet provisioning script
├── .env.example               # All configurable environment variables
├── .gitignore
├── package.json
└── tsconfig.json
```

### How the CLI Wrappers Work

Both providers follow the same pattern:

1. **Receive** a `{ systemPrompt, userPrompt, model }` request
2. **Write** the system prompt to a temp file (with `0o600` permissions — owner-only)
3. **Spawn** the CLI via `execFile()` (not `exec()` — avoids shell injection)
4. **Pipe** the user prompt to stdin
5. **Parse** the CLI's JSON/JSONL output
6. **Clean up** the temp file
7. **Return** a normalized response matching the Anthropic Messages API shape

The key insight: `execFile()` passes arguments as an array, not a shell string, which prevents command injection even if prompt content contains shell metacharacters.

**Claude CLI invocation:**
```
claude -p \
  --system-prompt-file /tmp/cli-bridge-<uuid>.txt \
  --model <model> \
  --max-turns 5 \
  --tools '' \
  --output-format json
  < userPrompt (via stdin)
```

**Codex CLI invocation:**
```
codex exec \
  --model <model> \
  --full-auto \
  --sandbox read-only \
  --json \
  - < combinedPrompt (via stdin)
```

---

## Security Measures

### What Was Implemented and Why

#### 1. Timing-Safe Authentication

**Problem:** Standard string comparison (`===`, `Array.includes()`) short-circuits on the first mismatched character. An attacker can measure response times to guess valid API keys character-by-character.

**Solution:** `crypto.timingSafeEqual()` compares all bytes regardless of where differences occur.

```typescript
import { timingSafeEqual } from 'crypto';

function constantTimeMatch(userKey: string, validKeys: string[]): boolean {
  for (const validKey of validKeys) {
    if (userKey.length === validKey.length) {
      if (timingSafeEqual(Buffer.from(userKey), Buffer.from(validKey))) {
        return true;
      }
    }
  }
  return false;
}
```

#### 2. Temp File Permissions

**Problem:** `writeFileSync()` defaults to mode `0o666` (world-readable). System prompts written to temp files could be read by other users on the system.

**Solution:** Write with `mode: 0o600` (owner read/write only).

```typescript
writeFileSync(tmpFile, systemPrompt, { encoding: 'utf-8', mode: 0o600 });
```

#### 3. Error Message Sanitization

**Problem:** Returning raw CLI error messages to clients leaks system paths, command arguments, and internal state.

**Solution:** Log detailed errors server-side, return generic messages to clients.

```typescript
// Server-side: full details for debugging
console.error('[claude] CLI execution failed');

// Client-side: generic message
reject(new Error('Claude generation failed'));

// Route handler: never exposes err.message
catch { res.status(500).json({ error: 'Generation failed' }); }
```

#### 4. Security Headers

Standard hardening headers applied to all responses:

```typescript
res.setHeader('X-Content-Type-Options', 'nosniff');    // Prevent MIME sniffing
res.setHeader('X-Frame-Options', 'DENY');               // Prevent clickjacking
res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
```

#### 5. Input Validation

All generation endpoints validate:
- `systemPrompt` and `userPrompt` must be strings (prevents type confusion)
- Maximum length enforced (500K chars — prevents memory exhaustion)
- `model` parameter must be a string if provided

#### 6. Rate Limiting

`express-rate-limit` with configurable window and max requests. Prevents abuse and protects subscription usage caps.

#### 7. No Open Ports

Cloudflare Tunnel means the droplet has **zero open ports**. All traffic flows through Cloudflare's encrypted tunnel. Even if someone discovers the droplet's IP, there's nothing to connect to.

#### 8. Process Isolation (Docker)

The Dockerfile runs as a non-root `bridge` user with `dumb-init` for proper signal handling. Auth volumes are mapped to the non-root home directory.

### What Was Intentionally NOT Done

- **HTTPS on the server itself:** Not needed — Cloudflare Tunnel handles TLS termination. The server listens on HTTP internally, which is standard for reverse-proxy architectures.
- **Model whitelisting:** Left flexible so new models work without code changes. The CLIs themselves enforce model access based on your subscription.
- **Request logging to a database:** Overkill for a personal bridge. Console logs captured by PM2 are sufficient.

---

## Step-by-Step Deployment

### Prerequisites

- A **DigitalOcean** account (or any VPS provider)
- A **Cloudflare** account with a domain
- **Claude Max** and/or **OpenAI Pro** subscription
- SSH key pair on your local machine

### 1. Create the Droplet

1. Log into DigitalOcean → Create → Droplets
2. **Image:** Ubuntu 24.04 LTS
3. **Plan:** Basic, $4/mo (512MB RAM) or $6/mo (1GB)
4. **Region:** Closest to you
5. **Auth:** Add your SSH public key
6. **Hostname:** `ai-cli-bridge`
7. Create

### 2. Configure SSH

Add to your `~/.ssh/config`:

```
Host ai-bridge
  HostName <DROPLET_IP>
  User root
  IdentityFile ~/.ssh/<YOUR_KEY>
  AddKeysToAgent yes
```

Verify: `ssh ai-bridge "echo connected"`

### 3. Provision the Droplet

SSH in and run:

```bash
ssh ai-bridge

# System packages
apt-get update -qq && apt-get install -y -qq curl git

# Node.js 20
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y -qq nodejs

# pnpm, PM2, AI CLIs
npm install -g pnpm pm2 @anthropic-ai/claude-code @openai/codex

# Cloudflared
curl -fsSL https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb -o /tmp/cloudflared.deb
dpkg -i /tmp/cloudflared.deb && rm /tmp/cloudflared.deb
```

### 4. Deploy the Project

From your local machine:

```bash
rsync -avz --exclude node_modules --exclude dist --exclude .env \
  -e "ssh -i ~/.ssh/<YOUR_KEY>" \
  ./ai-cli-bridge/ root@<DROPLET_IP>:/opt/ai-cli-bridge/
```

On the droplet:

```bash
cd /opt/ai-cli-bridge
pnpm install
pnpm build
```

### 5. Configure Environment

```bash
# Generate a secure bridge API key
BRIDGE_KEY=$(openssl rand -hex 32)
echo "Your bridge key: $BRIDGE_KEY"

# Create .env
cat > /opt/ai-cli-bridge/.env << EOF
PORT=3456
BRIDGE_API_KEYS=$BRIDGE_KEY
RATE_LIMIT_WINDOW_MS=60000
RATE_LIMIT_MAX_REQUESTS=30
CORS_ORIGINS=
CLAUDE_DEFAULT_MODEL=claude-sonnet-4-20250514
CODEX_DEFAULT_MODEL=gpt-5.3-codex
EOF

chmod 600 /opt/ai-cli-bridge/.env
```

**Save the bridge key** — this is what your other projects will use.

### 6. Authenticate the CLIs

This is interactive and requires a browser:

```bash
# Claude Code — follow the OAuth URL it prints
claude

# Codex — follow the OAuth URL it prints
codex auth
```

Each CLI will print a URL. Open it in your browser, authenticate, and the tokens are saved to `~/.claude/` and `~/.config/` respectively.

### 7. Start the Server

```bash
cd /opt/ai-cli-bridge
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup  # Auto-start on reboot
```

Verify: `curl -s http://localhost:3456/health` → `{"status":"ok"}`

### 8. Set Up Cloudflare Tunnel

```bash
# Authenticate with Cloudflare (opens browser URL)
cloudflared tunnel login

# Create a named tunnel
cloudflared tunnel create ai-bridge

# Route your subdomain to the tunnel
cloudflared tunnel route dns ai-bridge bridge.yourdomain.com

# Write tunnel config
TUNNEL_ID=$(cloudflared tunnel list -o json | python3 -c "import sys,json; print(json.load(sys.stdin)[0]['id'])")

cat > ~/.cloudflared/config.yml << EOF
tunnel: $TUNNEL_ID
credentials-file: /root/.cloudflared/$TUNNEL_ID.json

ingress:
  - hostname: bridge.yourdomain.com
    service: http://localhost:3456
  - service: http_status:404
EOF

# Install as a system service (auto-starts on reboot)
cloudflared service install
```

### 9. Verify End-to-End

From your local machine:

```bash
# Health check
curl -s https://bridge.yourdomain.com/health \
  -H "Authorization: Bearer <YOUR_BRIDGE_KEY>"
# → {"status":"ok"}

# Test generation
curl -s https://bridge.yourdomain.com/generate-codex \
  -H "Authorization: Bearer <YOUR_BRIDGE_KEY>" \
  -H "Content-Type: application/json" \
  -d '{"systemPrompt":"Reply concisely.","userPrompt":"What is 2+2?"}'
# → {"content":[{"type":"text","text":"4"}],"usage":{...}}
```

---

## Using the Bridge From Other Projects

### Direct HTTP

```typescript
const response = await fetch('https://bridge.yourdomain.com/generate', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': 'Bearer <YOUR_BRIDGE_KEY>',
  },
  body: JSON.stringify({
    systemPrompt: 'You are a helpful assistant.',
    userPrompt: 'Explain monads in one sentence.',
    model: 'claude-sonnet-4-20250514', // optional
  }),
});

const data = await response.json();
console.log(data.content[0].text);
```

### From a Figma Plugin (or any browser iframe)

The bridge was originally built for a Figma plugin. The provider pattern uses the API key field to pass both the bridge key and URL:

```
API Key field value: <BRIDGE_KEY>@https://bridge.yourdomain.com
```

The provider code parses this:

```typescript
function parseBridgeConfig(apiKey: string) {
  if (apiKey && apiKey.includes('@')) {
    const atIdx = apiKey.indexOf('@');
    return {
      url: apiKey.slice(atIdx + 1),
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey.slice(0, atIdx)}`,
      },
    };
  }
  return { url: 'http://localhost:3456', headers: { 'Content-Type': 'application/json' } };
}
```

### Response Shape

All endpoints return the same shape (Anthropic Messages API compatible):

```json
{
  "content": [{ "type": "text", "text": "..." }],
  "usage": {
    "input_tokens": 1234,
    "output_tokens": 56,
    "cache_creation_input_tokens": 0,
    "cache_read_input_tokens": 789
  },
  "cost_usd": 0.003,
  "duration_ms": 4500
}
```

---

## API Reference

All endpoints (except `/health` in auth-disabled mode) require `Authorization: Bearer <key>`.

### `POST /generate`

Calls Claude Code CLI.

**Request:**
```json
{
  "systemPrompt": "string (required, max 500K chars)",
  "userPrompt": "string (required, max 500K chars)",
  "model": "string (optional, default: claude-sonnet-4-20250514)"
}
```

**Response:** See response shape above.

### `POST /generate-codex`

Calls Codex CLI.

**Request:** Same as `/generate`. Default model: `gpt-5.3-codex`.

**Response:** Same shape. `cost_usd` is estimated from a hardcoded pricing table.

### `GET /health`

Returns `{"status":"ok"}`. Use for uptime monitoring and load balancer checks.

### `GET /stats`

Returns cumulative session statistics:

```json
{
  "totalRequests": 42,
  "totalInputTokens": 150000,
  "totalOutputTokens": 8000,
  "totalCacheCreationTokens": 0,
  "totalCacheReadTokens": 120000,
  "totalCostUSD": 0.45
}
```

### `POST /stats/reset`

Resets all session statistics to zero.

---

## Maintenance & Operations

### Updating the Bridge

From your local machine:

```bash
# After making changes locally
pnpm build  # Verify it compiles

# Deploy
rsync -avz --exclude node_modules --exclude dist --exclude .env \
  -e ssh ./ai-cli-bridge/ ai-bridge:/opt/ai-cli-bridge/

# On the droplet
ssh ai-bridge 'cd /opt/ai-cli-bridge && pnpm install && pnpm build && pm2 restart ai-cli-bridge'
```

### Re-authenticating CLIs

Subscription tokens expire periodically. When generation requests start failing:

```bash
ssh ai-bridge
claude        # Re-authenticate Claude
codex auth    # Re-authenticate Codex
# No server restart needed — the CLIs read fresh tokens on each invocation
```

### Monitoring

```bash
# View real-time logs
ssh ai-bridge 'pm2 logs ai-cli-bridge'

# Check server status
ssh ai-bridge 'pm2 status'

# Check tunnel status
ssh ai-bridge 'systemctl status cloudflared'

# Usage stats
curl -s https://bridge.yourdomain.com/stats \
  -H "Authorization: Bearer <KEY>"
```

### Rotating Bridge API Keys

```bash
ssh ai-bridge

# Generate new key
NEW_KEY=$(openssl rand -hex 32)

# Update .env (can have multiple comma-separated keys for rotation)
# OLD_KEY,NEW_KEY allows both to work during transition
sed -i "s/^BRIDGE_API_KEYS=.*/BRIDGE_API_KEYS=<OLD_KEY>,$NEW_KEY/" /opt/ai-cli-bridge/.env

# Restart to pick up new keys
pm2 restart ai-cli-bridge

# Update all clients to use NEW_KEY, then remove OLD_KEY
```

### Cost Awareness

While per-request cost is "free" (covered by your subscription), be aware:
- **Claude Max** has monthly usage limits that vary by tier
- **OpenAI Pro** has similar caps
- The `/stats` endpoint tracks estimated costs for awareness
- Heavy automated usage may hit throttling before the month ends

---

## Extending the Bridge

### Adding a New CLI Provider

1. Create `src/providers/newprovider.ts` following the existing pattern
2. Export a `generateWithNewProvider(req, cfg): Promise<Response>` function
3. Add the route in `src/server.ts`
4. Add config entries in `src/config.ts` and `.env.example`
5. Install the CLI on the droplet

### Adding Streaming Support

Replace `execFile()` with `spawn()` and pipe chunks to an SSE response:

```typescript
import { spawn } from 'child_process';

const child = spawn('claude', args);
res.setHeader('Content-Type', 'text/event-stream');
child.stdout.on('data', chunk => res.write(`data: ${chunk}\n\n`));
child.on('close', () => res.end());
```

### Multiple Bridge Keys with Per-Key Rate Limits

Extend the auth middleware to identify which key was used, then apply per-key rate limiting. Useful if sharing the bridge with others.
