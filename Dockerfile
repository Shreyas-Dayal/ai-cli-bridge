FROM oven/bun:latest

RUN apt-get update && apt-get install -y dumb-init curl && rm -rf /var/lib/apt/lists/*

# Install Node.js (needed for CLI tools that require it)
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && \
    apt-get install -y nodejs && \
    npm install -g @anthropic-ai/claude-code @openai/codex

WORKDIR /app

# Create non-root user
RUN useradd -m -u 1000 bridge && \
    mkdir -p /home/bridge/.claude /home/bridge/.config && \
    chown -R bridge:bridge /app /home/bridge

# Install dependencies
COPY --chown=bridge:bridge package.json bun.lock* ./
RUN bun install --frozen-lockfile || bun install

# Copy source
COPY --chown=bridge:bridge . .

USER bridge

EXPOSE 3456

ENTRYPOINT ["/usr/bin/dumb-init", "--"]
CMD ["bun", "src/server.ts"]
