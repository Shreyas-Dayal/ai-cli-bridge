# Deployment Quick Reference

## SSH Config

Add your server to `~/.ssh/config`:

```
Host <YOUR_SERVER>
  HostName <SERVER_IP>
  User root
  IdentityFile ~/.ssh/<YOUR_KEY>
  AddKeysToAgent yes
```

## Deploy Updates

From the local project directory:

```bash
# 1. Build locally (verify no TypeScript errors)
bun run build

# 2. Sync files to server (excludes node_modules, .env, data, .git)
rsync -avz --exclude node_modules --exclude .env --exclude data --exclude .git \
  ./ <YOUR_SERVER>:/path/to/ai-cli-bridge/

# 3. Restart the server
ssh <YOUR_SERVER> "systemctl restart ai-cli-bridge"
```

### Static-Only Changes (HTML/CSS/JS in public/)

If you only changed files in `public/`, no server restart is needed — `express.static` serves them directly:

```bash
rsync -avz ./public/ <YOUR_SERVER>:/path/to/ai-cli-bridge/public/
```

### Dependency Changes (package.json updated)

If `package.json` or `bun.lock` changed, install on the server before restarting:

```bash
rsync -avz --exclude node_modules --exclude .env --exclude data --exclude .git \
  ./ <YOUR_SERVER>:/path/to/ai-cli-bridge/

ssh <YOUR_SERVER> "cd /path/to/ai-cli-bridge && bun install --frozen-lockfile && systemctl restart ai-cli-bridge"
```

## Verify

```bash
# Health check
curl -s https://<YOUR_DOMAIN>/health
# → {"status":"ok"}

# Check service status
ssh <YOUR_SERVER> "systemctl status ai-cli-bridge"

# View live logs
ssh <YOUR_SERVER> "journalctl -u ai-cli-bridge -f --lines 20"
```

## Important Paths

| What | Path |
|---|---|
| Project (server) | `/path/to/ai-cli-bridge/` |
| Data dir (server) | `<project>/data/` |
| Keys file (server) | `<project>/data/keys.json` |
| Usage file (server) | `<project>/data/usage.json` |
| Logs file (server) | `<project>/data/logs.json` |
| Env config (server) | `<project>/.env` |
| systemd service | `/etc/systemd/system/ai-cli-bridge.service` |
| Dashboard URL | `https://<YOUR_DOMAIN>/admin/dashboard/admin.html` |

## Re-authenticate CLIs

When generation requests start failing due to expired tokens:

```bash
ssh <YOUR_SERVER>
claude        # Follow the OAuth URL for Claude
codex auth    # Follow the OAuth URL for Codex
# No server restart needed — CLIs read fresh tokens each invocation
```

## Useful Commands

```bash
# View server logs in real-time
ssh <YOUR_SERVER> "journalctl -u ai-cli-bridge -f"

# Check tunnel status
ssh <YOUR_SERVER> "systemctl status cloudflared"

# Restart server + tunnel
ssh <YOUR_SERVER> "systemctl restart ai-cli-bridge cloudflared"
```
