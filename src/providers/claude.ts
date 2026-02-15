import { execFile } from 'child_process';
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

    // Write system prompt to temp file with restrictive permissions
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

    const child = execFile('claude', args, {
      timeout: cfg.timeoutMs,
      maxBuffer: cfg.maxBuffer,
    }, (error, stdout) => {
      // Clean up temp file
      try { unlinkSync(tmpFile); } catch { /* ignore */ }

      if (error) {
        console.error('[claude] CLI execution failed');
        reject(new Error('Claude generation failed'));
        return;
      }

      let cliResult: ClaudeCliResult;
      try {
        cliResult = JSON.parse(stdout);
      } catch {
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

    if (child.stdin) {
      child.stdin.write(req.userPrompt);
      child.stdin.end();
    }
  });
}
