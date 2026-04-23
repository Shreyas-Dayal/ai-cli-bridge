FROM oven/bun:latest

RUN apt-get update && \
    apt-get install -y --no-install-recommends dumb-init ca-certificates && \
    update-ca-certificates && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install CLIs into shared path (as root) so bun user can execute them
ENV PATH="/opt/bun/bin:${PATH}"
RUN BUN_INSTALL=/opt/bun bun install -g @anthropic-ai/claude-code @openai/codex @google/gemini-cli && \
    chmod -R a+rX /opt/bun

# Prep auth dirs for bun user (built-in UID 1000 in oven/bun image)
RUN mkdir -p /home/bun/.claude /home/bun/.codex /home/bun/.gemini && \
    chown -R bun:bun /app /home/bun

USER bun

# Install app dependencies
COPY --chown=bun:bun package.json bun.lock* ./
RUN bun install --frozen-lockfile || bun install

# Copy source
COPY --chown=bun:bun . .

EXPOSE 3456

ENTRYPOINT ["/usr/bin/dumb-init", "--"]
CMD ["bun", "src/server.ts"]
