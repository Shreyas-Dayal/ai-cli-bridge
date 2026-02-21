# Contributing

Thanks for your interest in contributing to ai-cli-bridge!

## Getting Started

```bash
git clone https://github.com/Shreyas-Dayal/ai-cli-bridge.git
cd ai-cli-bridge
pnpm install
cp .env.example .env   # Set BRIDGE_ADMIN_KEY
pnpm dev               # http://localhost:3456
```

### Prerequisites

- Node.js 20+
- pnpm
- Claude Code CLI and/or Codex CLI installed and authenticated (for testing generation endpoints)

## Development

- `pnpm dev` — starts the server with file watching (tsx)
- `pnpm run build` — compiles TypeScript (check for errors before submitting)
- `pnpm start:prod` — runs compiled JS from `dist/`

## Code Style

- TypeScript with `strict: true`
- ES modules (`import`/`export`, not `require`)
- Keep things simple — avoid abstractions until they're clearly needed
- Use `execFile` (not `exec`) for CLI invocations to prevent shell injection
- Never store raw API keys on the request object or in logs

## Commit Messages

This project uses [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: add new provider for Gemini CLI
fix: handle empty response from Codex CLI
refactor: extract rate limit config to separate module
docs: update deployment guide
```

## Pull Requests

1. Fork the repo and create a branch from `master`
2. Make your changes
3. Run `pnpm run build` to verify TypeScript compiles cleanly
4. Test manually (see below)
5. Open a PR with a clear description of what and why

## Testing

There's no automated test suite yet. Please verify your changes manually:

```bash
# Health check
curl -s http://localhost:3456/health

# Test generation (requires authenticated CLIs)
curl -s -X POST http://localhost:3456/generate \
  -H "Authorization: Bearer <USER_KEY>" \
  -H "Content-Type: application/json" \
  -d '{"systemPrompt":"Reply concisely.","userPrompt":"What is 2+2?"}'
```

If you'd like to contribute a test framework, that would be very welcome!

## Reporting Issues

Use [GitHub Issues](https://github.com/Shreyas-Dayal/ai-cli-bridge/issues). Please include:

- What you expected vs what happened
- Steps to reproduce
- Node.js version and OS
- Relevant logs (redact any keys or sensitive info)

## Security

If you discover a security vulnerability, please **do not** open a public issue. See [SECURITY.md](SECURITY.md) for responsible disclosure instructions.
