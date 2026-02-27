import { join } from 'path';

function requireInt(name: string, fallback: string, min?: number, max?: number): number {
  const raw = process.env[name] || fallback;
  const val = parseInt(raw, 10);
  if (isNaN(val)) {
    throw new Error(`Invalid ${name}: "${raw}" is not a number`);
  }
  if (min !== undefined && val < min) {
    throw new Error(`Invalid ${name}: ${val} must be >= ${min}`);
  }
  if (max !== undefined && val > max) {
    throw new Error(`Invalid ${name}: ${val} must be <= ${max}`);
  }
  return val;
}

export const config = {
  port: requireInt('PORT', '3456', 1, 65535),

  // Admin key for /admin/* endpoints
  adminKey: process.env.BRIDGE_ADMIN_KEY || '',

  // Data directory for keys.json and usage.json
  dataDir: process.env.DATA_DIR || join(process.cwd(), 'data'),

  // Rate limiting
  rateLimitWindowMs: requireInt('RATE_LIMIT_WINDOW_MS', '60000', 1000),
  rateLimitMaxRequests: requireInt('RATE_LIMIT_MAX_REQUESTS', '30', 1),

  // CORS
  corsOrigins: (process.env.CORS_ORIGINS || '').split(',').filter(Boolean),

  // Claude Code CLI
  claudeDefaultModel: process.env.CLAUDE_DEFAULT_MODEL || 'claude-sonnet-4-20250514',
  claudeTimeoutMs: requireInt('CLAUDE_TIMEOUT_MS', '120000', 1000),
  claudeMaxBuffer: requireInt('CLAUDE_MAX_BUFFER_BYTES', '10485760', 1024),

  // Codex CLI
  codexDefaultModel: process.env.CODEX_DEFAULT_MODEL || 'gpt-5.3-codex',
  codexTimeoutMs: requireInt('CODEX_TIMEOUT_MS', '180000', 1000),
  codexMaxBuffer: requireInt('CODEX_MAX_BUFFER_BYTES', '10485760', 1024),
};

if (!config.adminKey) {
  console.warn('[config] WARNING: BRIDGE_ADMIN_KEY is not set — admin endpoints will reject all requests');
}
