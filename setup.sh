#!/usr/bin/env bash
#
# Setup script for ai-cli-bridge on a fresh DigitalOcean droplet (Ubuntu 22.04+).
# Run as root: curl -sL <raw-url>/setup.sh | bash
#
set -euo pipefail

echo "=== ai-cli-bridge: DigitalOcean + Cloudflare Tunnel setup ==="

# ── 1. System packages ───────────────────────────────────────────────────────
echo "[1/4] Installing system packages..."
apt-get update -qq
apt-get install -y -qq curl git unzip

# ── 2. Bun ───────────────────────────────────────────────────────────────────
echo "[2/4] Installing Bun..."
if ! command -v bun &> /dev/null; then
  curl -fsSL https://bun.sh/install | bash
  source "$HOME/.bun/env"
fi
echo "  Bun: $(bun --version)"

# ── 3. AI CLIs ───────────────────────────────────────────────────────────────
echo "[3/4] Installing Claude Code CLI and Codex CLI..."
bun install -g @anthropic-ai/claude-code @openai/codex

# ── 4. Cloudflare Tunnel (cloudflared) ────────────────────────────────────────
echo "[4/4] Installing cloudflared..."
if ! command -v cloudflared &> /dev/null; then
  curl -fsSL https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb -o /tmp/cloudflared.deb
  dpkg -i /tmp/cloudflared.deb
  rm /tmp/cloudflared.deb
fi
echo "  cloudflared: $(cloudflared --version)"

echo ""
echo "Done! Next steps:"
echo ""
echo "  1. Clone your repo and install:"
echo "     git clone <your-repo> /opt/ai-cli-bridge"
echo "     cd /opt/ai-cli-bridge && bun install"
echo ""
echo "  2. Authenticate the CLIs (one-time, interactive):"
echo "     claude          # Follow OAuth flow for Claude Max"
echo "     codex auth      # Follow OAuth flow for OpenAI"
echo ""
echo "  3. Configure env:"
echo "     cp .env.example .env"
echo "     # Edit .env — set BRIDGE_ADMIN_KEY"
echo ""
echo "  4. Start with systemd:"
echo "     cp /opt/ai-cli-bridge/ai-cli-bridge.service /etc/systemd/system/"
echo "     systemctl daemon-reload"
echo "     systemctl enable --now ai-cli-bridge"
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
echo "  Other projects use it with: Authorization: Bearer <your-key>"
