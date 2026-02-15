export const config = {
  port: parseInt(process.env.PORT || '3456', 10),

  // Auth
  apiKeys: (process.env.BRIDGE_API_KEYS || '').split(',').filter(Boolean),

  // Rate limiting
  rateLimitWindowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000', 10),
  rateLimitMaxRequests: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS || '30', 10),

  // CORS
  corsOrigins: (process.env.CORS_ORIGINS || '').split(',').filter(Boolean),

  // Claude Code CLI
  claudeDefaultModel: process.env.CLAUDE_DEFAULT_MODEL || 'claude-sonnet-4-20250514',
  claudeTimeoutMs: parseInt(process.env.CLAUDE_TIMEOUT_MS || '120000', 10),
  claudeMaxBuffer: parseInt(process.env.CLAUDE_MAX_BUFFER_BYTES || '10485760', 10),

  // Codex CLI
  codexDefaultModel: process.env.CODEX_DEFAULT_MODEL || 'gpt-5.3-codex',
  codexTimeoutMs: parseInt(process.env.CODEX_TIMEOUT_MS || '180000', 10),
  codexMaxBuffer: parseInt(process.env.CODEX_MAX_BUFFER_BYTES || '10485760', 10),
};
