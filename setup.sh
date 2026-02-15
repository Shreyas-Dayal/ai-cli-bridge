#!/usr/bin/env bash
#
# Setup script for ai-cli-bridge on a fresh DigitalOcean droplet (Ubuntu 22.04+).
# Run as root: curl -sL <raw-url>/setup.sh | bash
#
set -euo pipefail

echo "=== ai-cli-bridge: DigitalOcean + Cloudflare Tunnel setup ==="

# ── 1. System packages ───────────────────────────────────────────────────────
echo "[1/6] Installing system packages..."
apt-get update -qq
apt-get install -y -qq curl git

# ── 2. Node.js 20 ────────────────────────────────────────────────────────────
echo "[2/6] Installing Node.js 20..."
if ! command -v node &> /dev/null; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y -qq nodejs
fi
echo "  Node: $(node --version)"

# ── 3. pnpm + CLIs ───────────────────────────────────────────────────────────
echo "[3/6] Installing pnpm, Claude Code CLI, Codex CLI..."
npm install -g pnpm @anthropic-ai/claude-code @openai/codex
echo "  pnpm: $(pnpm --version)"

# ── 4. PM2 for process management ────────────────────────────────────────────
echo "[4/6] Installing PM2..."
npm install -g pm2

# ── 5. Cloudflare Tunnel (cloudflared) ────────────────────────────────────────
echo "[5/6] Installing cloudflared..."
if ! command -v cloudflared &> /dev/null; then
  curl -fsSL https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb -o /tmp/cloudflared.deb
  dpkg -i /tmp/cloudflared.deb
  rm /tmp/cloudflared.deb
fi
echo "  cloudflared: $(cloudflared --version)"

echo ""
echo "[6/6] Done! Next steps:"
echo ""
echo "  1. Clone your repo and install:"
echo "     git clone <your-repo> /opt/ai-cli-bridge"
echo "     cd /opt/ai-cli-bridge && pnpm install && pnpm build"
echo ""
echo "  2. Authenticate the CLIs (one-time, interactive):"
echo "     claude          # Follow OAuth flow for Claude Max"
echo "     codex auth      # Follow OAuth flow for OpenAI"
echo ""
echo "  3. Configure env:"
echo "     cp .env.example .env"
echo "     # Edit .env — set BRIDGE_API_KEYS"
echo ""
echo "  4. Start with PM2:"
echo "     pm2 start dist/server.js --name ai-cli-bridge"
echo "     pm2 save && pm2 startup"
echo ""
echo "  5. Create Cloudflare Tunnel:"
echo "     cloudflared tunnel login"
echo "     cloudflared tunnel create ai-bridge"
echo "     cloudflared tunnel route dns ai-bridge bridge.yourdomain.com"
echo ""
echo "  6. Run the tunnel:"
echo "     cloudflared tunnel --url http://localhost:3456 run ai-bridge"
echo "     # Or set up as a systemd service:"
echo "     cloudflared service install"
echo ""
echo "  Your bridge is now available at https://bridge.yourdomain.com"
echo "  Other projects use it with: Authorization: Bearer <your-BRIDGE_API_KEY>"
