import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { config } from './config.js';
import { authMiddleware } from './middleware/auth.js';
import { generateWithClaude } from './providers/claude.js';
import { generateWithCodex } from './providers/codex.js';

const app = express();

const MAX_PROMPT_LENGTH = 500_000; // 500K chars

// ── Security headers ─────────────────────────────────────────────────────────

app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  next();
});

// ── Middleware ────────────────────────────────────────────────────────────────

// CORS
if (config.corsOrigins.length > 0) {
  app.use(cors({ origin: config.corsOrigins }));
} else {
  app.use(cors());
}

app.use(express.json({ limit: '5mb' }));

// Rate limiting
app.use(rateLimit({
  windowMs: config.rateLimitWindowMs,
  max: config.rateLimitMaxRequests,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, try again later' },
}));

// Auth — applied to all routes below
app.use(authMiddleware(config.apiKeys));

// ── Session stats ────────────────────────────────────────────────────────────

let sessionStats = {
  totalRequests: 0,
  totalInputTokens: 0,
  totalOutputTokens: 0,
  totalCacheCreationTokens: 0,
  totalCacheReadTokens: 0,
  totalCostUSD: 0,
};

function updateStats(usage: {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  cached_input_tokens?: number;
}, costUSD: number) {
  sessionStats.totalRequests++;
  sessionStats.totalInputTokens += usage.input_tokens;
  sessionStats.totalOutputTokens += usage.output_tokens;
  sessionStats.totalCacheCreationTokens += usage.cache_creation_input_tokens || 0;
  sessionStats.totalCacheReadTokens += (usage.cache_read_input_tokens || 0) + (usage.cached_input_tokens || 0);
  sessionStats.totalCostUSD += costUSD;
}

function logRequest(provider: string, model: string, usage: Record<string, number>, costUSD: number, durationMs?: number) {
  console.log('\n─────────────────────────────────────────');
  console.log(`[${provider}] Request #${sessionStats.totalRequests} completed`);
  console.log(`  Model: ${model}`);
  if (durationMs) console.log(`  Duration: ${(durationMs / 1000).toFixed(2)}s`);
  console.log(`  Tokens: ${usage.input_tokens || 0} in / ${usage.output_tokens || 0} out`);
  if (usage.cache_creation_input_tokens) console.log(`  Cache created: ${usage.cache_creation_input_tokens}`);
  if (usage.cache_read_input_tokens || usage.cached_input_tokens) {
    console.log(`  Cache read: ${usage.cache_read_input_tokens || usage.cached_input_tokens}`);
  }
  console.log(`  Cost: $${costUSD.toFixed(6)}`);
  console.log(`  Session total: $${sessionStats.totalCostUSD.toFixed(6)}`);
  console.log('─────────────────────────────────────────\n');
}

// ── Input validation ─────────────────────────────────────────────────────────

function validateGenerateBody(body: Record<string, unknown>): { error?: string } {
  const { systemPrompt, userPrompt, model } = body;

  if (!systemPrompt || typeof systemPrompt !== 'string') {
    return { error: 'systemPrompt is required and must be a string' };
  }
  if (!userPrompt || typeof userPrompt !== 'string') {
    return { error: 'userPrompt is required and must be a string' };
  }
  if (systemPrompt.length > MAX_PROMPT_LENGTH || userPrompt.length > MAX_PROMPT_LENGTH) {
    return { error: `Prompt exceeds maximum length of ${MAX_PROMPT_LENGTH} characters` };
  }
  if (model !== undefined && typeof model !== 'string') {
    return { error: 'model must be a string' };
  }

  return {};
}

// ── Routes ───────────────────────────────────────────────────────────────────

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

app.get('/stats', (_req, res) => {
  res.json(sessionStats);
});

app.post('/stats/reset', (_req, res) => {
  sessionStats = {
    totalRequests: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheCreationTokens: 0,
    totalCacheReadTokens: 0,
    totalCostUSD: 0,
  };
  res.json({ message: 'Stats reset', stats: sessionStats });
});

// Claude Code CLI
app.post('/generate', async (req, res) => {
  const validation = validateGenerateBody(req.body);
  if (validation.error) {
    res.status(400).json({ error: validation.error });
    return;
  }

  const { systemPrompt, userPrompt, model } = req.body;

  try {
    const result = await generateWithClaude(
      { systemPrompt, userPrompt, model },
      {
        defaultModel: config.claudeDefaultModel,
        timeoutMs: config.claudeTimeoutMs,
        maxBuffer: config.claudeMaxBuffer,
      }
    );

    updateStats(result.usage, result.cost_usd);
    logRequest('Claude', model || config.claudeDefaultModel, result.usage, result.cost_usd, result.duration_ms);

    res.json(result);
  } catch {
    res.status(500).json({ error: 'Generation failed' });
  }
});

// Codex CLI
app.post('/generate-codex', async (req, res) => {
  const validation = validateGenerateBody(req.body);
  if (validation.error) {
    res.status(400).json({ error: validation.error });
    return;
  }

  const { systemPrompt, userPrompt, model } = req.body;

  try {
    const result = await generateWithCodex(
      { systemPrompt, userPrompt, model },
      {
        defaultModel: config.codexDefaultModel,
        timeoutMs: config.codexTimeoutMs,
        maxBuffer: config.codexMaxBuffer,
      }
    );

    updateStats(result.usage, result.cost_usd);
    logRequest('Codex', model || config.codexDefaultModel, result.usage, result.cost_usd);

    res.json(result);
  } catch {
    res.status(500).json({ error: 'Generation failed' });
  }
});

// ── Start ────────────────────────────────────────────────────────────────────

app.listen(config.port, () => {
  console.log(`\nai-cli-bridge running on http://localhost:${config.port}`);
  console.log(`  Auth: ${config.apiKeys.length > 0 ? `enabled (${config.apiKeys.length} key(s))` : 'DISABLED (no BRIDGE_API_KEYS set)'}`);
  console.log(`  Rate limit: ${config.rateLimitMaxRequests} req / ${config.rateLimitWindowMs / 1000}s`);
  console.log(`  CORS: ${config.corsOrigins.length > 0 ? config.corsOrigins.join(', ') : 'all origins'}`);
  console.log('  Endpoints:');
  console.log('    POST /generate       — Claude Code CLI');
  console.log('    POST /generate-codex — Codex CLI');
  console.log('    GET  /health         — Health check');
  console.log('    GET  /stats          — Session usage stats');
  console.log('    POST /stats/reset    — Reset stats\n');
});
