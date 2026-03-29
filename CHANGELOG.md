# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/), and this project adheres to [Semantic Versioning](https://semver.org/).

## [1.0.0] - 2026-02-22

### Added

- **Express HTTP server** wrapping Claude Code CLI and Codex CLI
- **Two generation endpoints** — `POST /generate` (Claude) and `POST /generate-codex` (Codex)
- **API key management** — SHA-256 hashed storage, timing-safe auth, keys shown once at creation
- **Per-key usage limits** — requests/day, requests/month, tokens/month, cost/day, cost/month
- **Usage tracking** — in-memory with 30s dirty-flag flush to disk, auto-pruning (90 days daily, 12 months monthly)
- **Admin dashboard** — static HTML/CSS/JS UI for key management, usage monitoring, and request logs
- **Admin API** — full CRUD for keys, usage reset, request log viewer
- **Request logging** — append-only log capped at 1000 entries, prompts truncated to 200 chars
- **Rate limiting** — configurable global rate limiter via `express-rate-limit`
- **Security headers** — X-Content-Type-Options, X-Frame-Options, Referrer-Policy, Permissions-Policy
- **Docker support** — Dockerfile with non-root user and dumb-init, docker-compose with healthcheck
- **systemd service** — ai-cli-bridge.service for production process management
- **Cloudflare Tunnel template** — cloudflared config for zero-open-port deployment
- **Server provisioning script** — setup.sh for one-shot VPS setup
- **Health endpoint** — `GET /health` (unauthenticated)
- **Graceful shutdown** — SIGTERM/SIGINT flush dirty usage and logs to disk
- **Auth-disabled mode** — when no keys exist, auth is bypassed for easy local development
