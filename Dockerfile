FROM node:20-slim

RUN apt-get update && apt-get install -y dumb-init && rm -rf /var/lib/apt/lists/*

# Install pnpm + CLIs
RUN npm install -g pnpm @anthropic-ai/claude-code @openai/codex

WORKDIR /app

# Create non-root user
RUN useradd -m -u 1000 bridge && \
    mkdir -p /home/bridge/.claude /home/bridge/.config && \
    chown -R bridge:bridge /app /home/bridge

# Install dependencies
COPY --chown=bridge:bridge package.json pnpm-lock.yaml* ./
RUN pnpm install --frozen-lockfile || pnpm install

# Copy source
COPY --chown=bridge:bridge . .

# Build TypeScript
RUN pnpm build

USER bridge

EXPOSE 3456

ENTRYPOINT ["/usr/bin/dumb-init", "--"]
CMD ["node", "dist/server.js"]
