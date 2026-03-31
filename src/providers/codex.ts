import { execFile, spawn } from 'child_process';
import { readFileSync } from 'fs';
import { join } from 'path';

export interface CodexRequest {
  systemPrompt: string;
  userPrompt: string;
  model?: string;
}

export interface CodexResponse {
  content: Array<{ type: string; text: string }>;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cached_input_tokens: number;
  };
  cost_usd: number;
}

// Pricing per 1M tokens — loaded from codex-pricing.json at startup.
// Edit that file to update prices without changing source code.
let CODEX_PRICING: Record<string, { input: number; cached: number; output: number }> = {};
try {
  const pricingPath = join(process.cwd(), 'codex-pricing.json');
  CODEX_PRICING = JSON.parse(readFileSync(pricingPath, 'utf-8'));
} catch {
  console.warn('[codex] codex-pricing.json not found or invalid — cost estimation disabled');
}

function estimateCost(model: string, input: number, cached: number, output: number): number {
  const pricing = CODEX_PRICING[model];
  if (!pricing) return 0;
  const uncachedInput = Math.max(0, input - cached);
  return (
    (uncachedInput / 1_000_000) * pricing.input +
    (cached / 1_000_000) * pricing.cached +
    (output / 1_000_000) * pricing.output
  );
}

interface CodexConfig {
  defaultModel: string;
  timeoutMs: number;
  maxBuffer: number;
}

export function generateWithCodex(
  req: CodexRequest,
  cfg: CodexConfig
): Promise<CodexResponse> {
  return new Promise((resolve, reject) => {
    const model = req.model || cfg.defaultModel;

    // Codex doesn't have a clean --system-prompt flag, so combine them
    const fullPrompt = `${req.systemPrompt}\n\n---\n\n${req.userPrompt}`;

    const args = [
      'exec',
      '--model', model,
      '--full-auto',
      '--sandbox', 'read-only',
      '--json',
      '-', // Read prompt from stdin
    ];

    // execFile passes args as an array (no shell interpolation), preventing
    // command injection even if prompt content contains shell metacharacters.
    const child = execFile('codex', args, {
      timeout: cfg.timeoutMs,
      maxBuffer: cfg.maxBuffer,
    }, (error, stdout) => {
      if (error) {
        console.error('[codex] CLI execution failed:', error.message);
        try { child.kill(); } catch { /* already exited */ }
        reject(new Error('Codex generation failed'));
        return;
      }

      // Codex CLI outputs JSONL (one JSON object per line). We scan for:
      //   - item.completed with agent_message → the actual response text
      //   - turn.completed with usage → token counts for tracking
      const lines = stdout.split('\n').filter(l => l.trim());
      let resultText = '';
      let inputTokens = 0;
      let outputTokens = 0;
      let cachedInputTokens = 0;

      for (const line of lines) {
        try {
          const event = JSON.parse(line);

          if (event.type === 'item.completed' && event.item?.type === 'agent_message' && event.item?.text) {
            resultText = event.item.text;
          }

          if (event.type === 'turn.completed' && event.usage) {
            inputTokens = event.usage.input_tokens || 0;
            outputTokens = event.usage.output_tokens || 0;
            cachedInputTokens = event.usage.cached_input_tokens || 0;
          }
        } catch {
          // Skip unparseable lines
        }
      }

      if (!resultText) {
        console.warn('[codex] No agent_message in output');
      }

      resolve({
        content: [{ type: 'text', text: resultText }],
        usage: {
          input_tokens: inputTokens,
          output_tokens: outputTokens,
          cached_input_tokens: cachedInputTokens,
        },
        cost_usd: estimateCost(model, inputTokens, cachedInputTokens, outputTokens),
      });
    });

    try {
      if (child.stdin) {
        child.stdin.write(fullPrompt);
        child.stdin.end();
      }
    } catch (err) {
      try { child.kill(); } catch { /* already exited */ }
      reject(new Error('Failed to write prompt to CLI stdin'));
    }
  });
}

// ── Streaming variant ───────────────────────────────────────────────────────

export interface CodexStreamCallbacks {
  onText: (chunk: string) => void;
  onUsage: (usage: CodexResponse['usage'], costUsd: number) => void;
  onError: (error: Error) => void;
  onDone: () => void;
}

export function streamWithCodex(
  req: CodexRequest,
  cfg: CodexConfig,
  callbacks: CodexStreamCallbacks
): { kill: () => void } {
  const model = req.model || cfg.defaultModel;
  const fullPrompt = `${req.systemPrompt}\n\n---\n\n${req.userPrompt}`;

  const args = [
    'exec',
    '--model', model,
    '--full-auto',
    '--sandbox', 'read-only',
    '--json',
    '-',
  ];

  let finished = false;
  const finish = (fn: () => void) => {
    if (finished) return;
    finished = true;
    fn();
  };

  const child = spawn('codex', args, { stdio: ['pipe', 'pipe', 'pipe'] });

  // Timeout handling
  const timer = setTimeout(() => {
    try { child.kill('SIGTERM'); } catch { /* ignore */ }
    setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
    }, 5000);
    finish(() => callbacks.onError(new Error('Generation timed out')));
  }, cfg.timeoutMs);

  let stderrOutput = '';
  child.stderr.on('data', (data: Buffer) => {
    stderrOutput += data.toString();
  });

  // Line-based JSONL parser
  let buffer = '';
  child.stdout.on('data', (data: Buffer) => {
    buffer += data.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);

        // Codex emits the full response in item.completed with agent_message
        if (event.type === 'item.completed' && event.item?.type === 'agent_message' && event.item?.text) {
          callbacks.onText(event.item.text);
        }

        // Usage data from turn.completed
        if (event.type === 'turn.completed' && event.usage) {
          const inputTokens = event.usage.input_tokens || 0;
          const outputTokens = event.usage.output_tokens || 0;
          const cachedInputTokens = event.usage.cached_input_tokens || 0;
          callbacks.onUsage(
            {
              input_tokens: inputTokens,
              output_tokens: outputTokens,
              cached_input_tokens: cachedInputTokens,
            },
            estimateCost(model, inputTokens, cachedInputTokens, outputTokens)
          );
        }
      } catch {
        // Skip unparseable lines
      }
    }
  });

  child.on('close', (code) => {
    clearTimeout(timer);

    if (code !== 0 && !finished) {
      console.error(`[codex/stream] CLI exited with code ${code}`, stderrOutput.slice(0, 500));
      finish(() => callbacks.onError(new Error('Codex generation failed')));
    } else {
      finish(() => callbacks.onDone());
    }
  });

  child.on('error', (err) => {
    clearTimeout(timer);
    console.error('[codex/stream] spawn error:', err.message);
    finish(() => callbacks.onError(new Error('Codex generation failed')));
  });

  try {
    if (child.stdin) {
      child.stdin.write(fullPrompt);
      child.stdin.end();
    }
  } catch {
    try { child.kill(); } catch { /* ignore */ }
    finish(() => callbacks.onError(new Error('Failed to write prompt to CLI stdin')));
  }

  return {
    kill: () => {
      try { child.kill(); } catch { /* ignore */ }
    },
  };
}
