import { execFile, spawn } from 'child_process';
import { writeFileSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';

export interface ClaudeRequest {
  systemPrompt: string;
  userPrompt: string;
  model?: string;
}

export interface ClaudeResponse {
  content: Array<{ type: string; text: string }>;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens: number;
    cache_read_input_tokens: number;
  };
  cost_usd: number;
  duration_ms: number;
}

interface ClaudeCliResult {
  result?: string;
  is_error?: boolean;
  total_cost_usd?: number;
  duration_ms?: number;
  num_turns?: number;
  stop_reason?: string;
  subtype?: string;
  errors?: unknown;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
}

interface ClaudeConfig {
  defaultModel: string;
  timeoutMs: number;
  maxBuffer: number;
}

export function generateWithClaude(
  req: ClaudeRequest,
  cfg: ClaudeConfig
): Promise<ClaudeResponse> {
  return new Promise((resolve, reject) => {
    const model = req.model || cfg.defaultModel;

    // Write system prompt to a temp file with owner-only permissions (0o600)
    // so other users on the system cannot read prompt content.
    const tmpFile = join(tmpdir(), `cli-bridge-${randomUUID()}.txt`);
    writeFileSync(tmpFile, req.systemPrompt, { encoding: 'utf-8', mode: 0o600 });

    const args = [
      '-p',
      '--system-prompt-file', tmpFile,
      '--model', model,
      '--max-turns', '5',
      '--tools', '',
      '--output-format', 'json',
    ];

    // execFile passes args as an array (no shell interpolation), preventing
    // command injection even if prompt content contains shell metacharacters.
    const child = execFile('claude', args, {
      timeout: cfg.timeoutMs,
      maxBuffer: cfg.maxBuffer,
    }, (error, stdout) => {
      // Clean up temp file
      try { unlinkSync(tmpFile); } catch { /* ignore */ }

      if (error) {
        console.error('[claude] CLI execution failed:', error.message);
        try { child.kill(); } catch { /* already exited */ }
        reject(new Error('Claude generation failed'));
        return;
      }

      let cliResult: ClaudeCliResult;
      try {
        cliResult = JSON.parse(stdout);
      } catch {
        // If the CLI output isn't valid JSON (e.g. plain text mode),
        // return raw stdout as the response with zeroed usage.
        resolve({
          content: [{ type: 'text', text: stdout }],
          usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
          cost_usd: 0,
          duration_ms: 0,
        });
        return;
      }

      const usage = cliResult.usage || {};
      const inputTokens = usage.input_tokens || 0;
      const outputTokens = usage.output_tokens || 0;
      const cacheCreationTokens = usage.cache_creation_input_tokens || 0;
      const cacheReadTokens = usage.cache_read_input_tokens || 0;
      const costUSD = cliResult.total_cost_usd || 0;
      const durationMs = cliResult.duration_ms || 0;

      const resultText = typeof cliResult.result === 'string' ? cliResult.result : '';

      if (!resultText) {
        console.warn('[claude] Empty result', {
          subtype: cliResult.subtype,
          num_turns: cliResult.num_turns,
          stop_reason: cliResult.stop_reason,
        });
      }

      resolve({
        content: [{ type: 'text', text: resultText }],
        usage: {
          input_tokens: inputTokens,
          output_tokens: outputTokens,
          cache_creation_input_tokens: cacheCreationTokens,
          cache_read_input_tokens: cacheReadTokens,
        },
        cost_usd: costUSD,
        duration_ms: durationMs,
      });
    });

    try {
      if (child.stdin) {
        child.stdin.write(req.userPrompt);
        child.stdin.end();
      }
    } catch (err) {
      try { child.kill(); } catch { /* already exited */ }
      try { unlinkSync(tmpFile); } catch { /* ignore */ }
      reject(new Error('Failed to write prompt to CLI stdin'));
    }
  });
}

// ── Streaming variant ───────────────────────────────────────────────────────

export interface StreamCallbacks {
  onText: (chunk: string) => void;
  onUsage: (usage: ClaudeResponse['usage'], costUsd: number, durationMs: number) => void;
  onError: (error: Error) => void;
  onDone: () => void;
}

export function streamWithClaude(
  req: ClaudeRequest,
  cfg: ClaudeConfig,
  callbacks: StreamCallbacks
): { kill: () => void } {
  const model = req.model || cfg.defaultModel;

  const tmpFile = join(tmpdir(), `cli-bridge-${randomUUID()}.txt`);
  writeFileSync(tmpFile, req.systemPrompt, { encoding: 'utf-8', mode: 0o600 });

  const args = [
    '-p',
    '--system-prompt-file', tmpFile,
    '--model', model,
    '--max-turns', '5',
    '--tools', '',
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
  ];

  let finished = false;
  const finish = (fn: () => void) => {
    if (finished) return;
    finished = true;
    fn();
  };

  const child = spawn('claude', args, { stdio: ['pipe', 'pipe', 'pipe'] });

  // Timeout handling
  const timer = setTimeout(() => {
    try { child.kill('SIGTERM'); } catch { /* ignore */ }
    setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
    }, 5000);
    finish(() => callbacks.onError(new Error('Generation timed out')));
  }, cfg.timeoutMs);

  // Stderr collection for diagnostics
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
        const parsed = JSON.parse(line);

        // Text delta chunks
        if (parsed.type === 'stream_event' && parsed.event?.type === 'content_block_delta') {
          const delta = parsed.event.delta;
          if (delta?.type === 'text_delta' && delta.text) {
            callbacks.onText(delta.text);
          }
          // Skip thinking_delta
        }

        // Final result with usage and cost
        if (parsed.type === 'result' && parsed.subtype === 'success') {
          const usage = parsed.usage || {};
          callbacks.onUsage(
            {
              input_tokens: usage.input_tokens || 0,
              output_tokens: usage.output_tokens || 0,
              cache_creation_input_tokens: usage.cache_creation_input_tokens || 0,
              cache_read_input_tokens: usage.cache_read_input_tokens || 0,
            },
            parsed.total_cost_usd || 0,
            parsed.duration_ms || 0
          );
        }
      } catch {
        // Skip unparseable lines
      }
    }
  });

  child.on('close', (code) => {
    clearTimeout(timer);
    try { unlinkSync(tmpFile); } catch { /* ignore */ }

    if (code !== 0 && !finished) {
      console.error(`[claude/stream] CLI exited with code ${code}`, stderrOutput.slice(0, 500));
      finish(() => callbacks.onError(new Error('Claude generation failed')));
    } else {
      finish(() => callbacks.onDone());
    }
  });

  child.on('error', (err) => {
    clearTimeout(timer);
    try { unlinkSync(tmpFile); } catch { /* ignore */ }
    console.error('[claude/stream] spawn error:', err.message);
    finish(() => callbacks.onError(new Error('Claude generation failed')));
  });

  // Write prompt to stdin
  try {
    if (child.stdin) {
      child.stdin.write(req.userPrompt);
      child.stdin.end();
    }
  } catch {
    try { child.kill(); } catch { /* ignore */ }
    try { unlinkSync(tmpFile); } catch { /* ignore */ }
    finish(() => callbacks.onError(new Error('Failed to write prompt to CLI stdin')));
  }

  return {
    kill: () => {
      try { child.kill(); } catch { /* ignore */ }
    },
  };
}
