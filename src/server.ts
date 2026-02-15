import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { join } from 'path';
import { config } from './config.js';
import { KeyManager } from './keys.js';
import { keyAuthMiddleware, adminAuthMiddleware } from './middleware/auth.js';
import { generateWithClaude } from './providers/claude.js';
import { generateWithCodex } from './providers/codex.js';

const app = express();
app.set('trust proxy', 1); // Trust first proxy (Cloudflare Tunnel)
const keyManager = new KeyManager(config.dataDir);

const MAX_PROMPT_LENGTH = 500_000;

// Graceful shutdown
process.on('SIGTERM', () => { keyManager.shutdown(); process.exit(0); });
process.on('SIGINT', () => { keyManager.shutdown(); process.exit(0); });

// ── Security headers ─────────────────────────────────────────────────────────

app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  next();
});

// ── Middleware ────────────────────────────────────────────────────────────────

if (config.corsOrigins.length > 0) {
  app.use(cors({ origin: config.corsOrigins }));
} else {
  app.use(cors());
}

app.use(express.json({ limit: '5mb' }));

app.use(rateLimit({
  windowMs: config.rateLimitWindowMs,
  max: config.rateLimitMaxRequests,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, try again later' },
}));

// ── Health (unauthenticated) ─────────────────────────────────────────────────

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

// ── Admin dashboard (static, unauthenticated — the page itself has no secrets) ─
app.use('/admin/dashboard', express.static(join(process.cwd(), 'public')));

// ── Admin routes (admin key auth) ────────────────────────────────────────────

const adminRouter = express.Router();
adminRouter.use(adminAuthMiddleware(config.adminKey));

// List all keys with usage
adminRouter.get('/keys', (_req, res) => {
  res.json({ keys: keyManager.listKeys() });
});

// Create a new key
adminRouter.post('/keys', (req, res) => {
  const { name, maxRequestsPerDay, maxRequestsPerMonth, maxTokensPerMonth, maxCostPerDay, maxCostPerMonth } = req.body;

  if (!name || typeof name !== 'string') {
    res.status(400).json({ error: 'name is required' });
    return;
  }

  try {
    const rawKey = keyManager.createKey(name, {
      maxRequestsPerDay: maxRequestsPerDay ?? 0,
      maxRequestsPerMonth: maxRequestsPerMonth ?? 0,
      maxTokensPerMonth: maxTokensPerMonth ?? 0,
      maxCostPerDay: maxCostPerDay ?? 0,
      maxCostPerMonth: maxCostPerMonth ?? 0,
    });

    res.status(201).json({
      message: `Key created for "${name}"`,
      key: rawKey,
      note: 'Save this key — it cannot be retrieved again.',
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to create key';
    res.status(409).json({ error: message });
  }
});

// Get a specific key's usage
adminRouter.get('/keys/:name', (req, res) => {
  const info = keyManager.getKeyUsage(req.params.name);
  if (!info) {
    res.status(404).json({ error: 'Key not found' });
    return;
  }
  res.json(info);
});

// Update a key's limits
adminRouter.patch('/keys/:name', (req, res) => {
  const { maxRequestsPerDay, maxRequestsPerMonth, maxTokensPerMonth, maxCostPerDay, maxCostPerMonth } = req.body;
  const updated = keyManager.updateLimits(req.params.name, {
    maxRequestsPerDay,
    maxRequestsPerMonth,
    maxTokensPerMonth,
    maxCostPerDay,
    maxCostPerMonth,
  });

  if (!updated) {
    res.status(404).json({ error: 'Key not found' });
    return;
  }
  res.json({ message: `Limits updated for "${req.params.name}"` });
});

// Delete a key
adminRouter.delete('/keys/:name', (req, res) => {
  const deleted = keyManager.deleteKey(req.params.name);
  if (!deleted) {
    res.status(404).json({ error: 'Key not found' });
    return;
  }
  res.json({ message: `Key "${req.params.name}" deleted` });
});

// Reset a key's usage
adminRouter.post('/keys/:name/reset-usage', (req, res) => {
  const reset = keyManager.resetUsage(req.params.name);
  if (!reset) {
    res.status(404).json({ error: 'Key not found' });
    return;
  }
  res.json({ message: `Usage reset for "${req.params.name}"` });
});

app.use('/admin', adminRouter);

// ── User routes (per-user key auth) ──────────────────────────────────────────

app.use(keyAuthMiddleware(keyManager));

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

// ── Logging ──────────────────────────────────────────────────────────────────

function logRequest(provider: string, model: string, keyName: string | undefined, usage: Record<string, number>, costUSD: number, durationMs?: number) {
  console.log('\n─────────────────────────────────────────');
  console.log(`[${provider}] ${keyName || 'anonymous'}`);
  console.log(`  Model: ${model}`);
  if (durationMs) console.log(`  Duration: ${(durationMs / 1000).toFixed(2)}s`);
  console.log(`  Tokens: ${usage.input_tokens || 0} in / ${usage.output_tokens || 0} out`);
  if (usage.cache_creation_input_tokens) console.log(`  Cache created: ${usage.cache_creation_input_tokens}`);
  if (usage.cache_read_input_tokens || usage.cached_input_tokens) {
    console.log(`  Cache read: ${usage.cache_read_input_tokens || usage.cached_input_tokens}`);
  }
  console.log(`  Cost: $${costUSD.toFixed(6)}`);
  console.log('─────────────────────────────────────────\n');
}

// ── Generation routes ────────────────────────────────────────────────────────

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

    // Record per-key usage
    if (req.keyHash) {
      keyManager.recordUsage(req.keyHash, result.usage.input_tokens, result.usage.output_tokens, result.cost_usd);
    }

    logRequest('Claude', model || config.claudeDefaultModel, req.keyName, result.usage, result.cost_usd, result.duration_ms);
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

    if (req.keyHash) {
      keyManager.recordUsage(req.keyHash, result.usage.input_tokens, result.usage.output_tokens, result.cost_usd);
    }

    logRequest('Codex', model || config.codexDefaultModel, req.keyName, result.usage, result.cost_usd);
    res.json(result);
  } catch {
    res.status(500).json({ error: 'Generation failed' });
  }
});

// ── Start ────────────────────────────────────────────────────────────────────

app.listen(config.port, () => {
  console.log(`\nai-cli-bridge running on http://localhost:${config.port}`);
  console.log(`  Keys: ${keyManager.hasKeys() ? `${keyManager.keyCount()} key(s)` : 'NONE (auth disabled)'}`);
  console.log(`  Admin: ${config.adminKey ? 'enabled' : 'DISABLED (no BRIDGE_ADMIN_KEY set)'}`);
  console.log(`  Rate limit: ${config.rateLimitMaxRequests} req / ${config.rateLimitWindowMs / 1000}s`);
  console.log(`  Data dir: ${config.dataDir}`);
  console.log('  Endpoints:');
  console.log('    POST /generate          — Claude Code CLI');
  console.log('    POST /generate-codex    — Codex CLI');
  console.log('    GET  /health            — Health check');
  console.log('  Admin:');
  console.log('    GET    /admin/keys          — List keys + usage');
  console.log('    POST   /admin/keys          — Create key');
  console.log('    GET    /admin/keys/:name    — Key usage details');
  console.log('    PATCH  /admin/keys/:name    — Update limits');
  console.log('    DELETE /admin/keys/:name    — Revoke key');
  console.log('    POST   /admin/keys/:name/reset-usage\n');
});
