# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability, please **do not** open a public GitHub issue.

Instead, email **shreyasdayal@gmail.com** with:

- A description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if you have one)

You should receive a response within 48 hours. Please allow time for a fix to be developed before disclosing publicly.

## Security Considerations

When deploying this project, keep the following in mind:

### Admin Key

- Generate a strong admin key: `openssl rand -hex 32`
- Never commit your `.env` file — it's in `.gitignore` by default
- The admin key controls all key management operations

### API Keys

- Raw keys are shown **once** at creation and never stored
- Only SHA-256 hashes are persisted to disk
- Auth uses `crypto.timingSafeEqual` to prevent timing attacks

### Network

- Deploy behind a reverse proxy (Cloudflare Tunnel, nginx, etc.) for TLS
- The server listens on HTTP internally — do not expose it directly to the internet
- Set `CORS_ORIGINS` to restrict which domains can call the API (empty = allow all)

### File Permissions

- Data files (`keys.json`, `usage.json`, `logs.json`) are written with mode `0o600` (owner-only)
- Temp files for system prompts use the same restrictive permissions

### CLI Execution

- All CLI invocations use `execFile` (not `exec`) to prevent shell injection
- User input is passed via stdin, never interpolated into command strings

### Request Logs

- Request logs store truncated prompts (200 chars). If your users submit sensitive content, consider disabling or restricting log access.

## Supported Versions

| Version | Supported |
| ------- | --------- |
| 1.x     | Yes       |
