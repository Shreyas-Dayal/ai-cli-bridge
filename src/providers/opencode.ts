import { execFile, spawn } from 'child_process';
import { writeFileSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

export interface OpencodeRequest {
  systemPrompt: string;
  userPrompt: string;
  model?: string;
}

export interface OpencodeResponse {
  content: Array<{ type: string; text: string }>;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cached_input_tokens: number;
    reasoning_tokens: number;
  };
  cost_usd: number;
}

interface OpencodeConfig {
  defaultModel: string;
  timeoutMs: number;
  maxBuffer: number;
}

// opencode picks up agent definitions from <cwd>/opencode.json. We provision
// a temp dir per request containing a `bridge` agent that:
//   - injects the caller's systemPrompt
//   - disables every write/exec tool so a hosted model can't touch the host
// The dir is removed on completion.
function writeBridgeConfig(systemPrompt: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'cli-bridge-opencode-'));
  const cfg = {
    $schema: 'https://opencode.ai/config.json',
    agent: {
      bridge: {
        description: 'Stateless chat-only agent for HTTP bridge',
        prompt: systemPrompt,
        tools: {
          write: false,
          edit: false,
          bash: false,
          patch: false,
          task: false,
          todoread: false,
          todowrite: false,
          webfetch: false,
          websearch: false,
        },
      },
    },
  };
  writeFileSync(join(dir, 'opencode.json'), JSON.stringify(cfg), { mode: 0o600 });
  return dir;
}

function cleanupDir(dir: string) {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

interface ParsedEvents {
  text: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  reasoningTokens: number;
  costUsd: number;
  errorMessage?: string;
}

function parseEventLine(line: string, state: ParsedEvents, lastTextByPart: Record<string, string>): string | null {
  let event: { type?: string; part?: Record<string, unknown>; error?: { data?: { message?: string } } };
  try {
    event = JSON.parse(line);
  } catch {
    return null;
  }

  if (event.type === 'text' && event.part && event.part.type === 'text') {
    const partId = String(event.part.id || '');
    const fullText = typeof event.part.text === 'string' ? event.part.text : '';
    const prev = lastTextByPart[partId] || '';
    const delta = fullText.startsWith(prev) ? fullText.slice(prev.length) : fullText;
    lastTextByPart[partId] = fullText;
    state.text += delta;
    return delta;
  }

  if (event.type === 'step_finish' && event.part) {
    const tokens = (event.part.tokens || {}) as {
      input?: number;
      output?: number;
      reasoning?: number;
      cache?: { read?: number; write?: number };
    };
    state.inputTokens += tokens.input || 0;
    state.outputTokens += tokens.output || 0;
    state.cachedInputTokens += tokens.cache?.read || 0;
    state.reasoningTokens += tokens.reasoning || 0;
    state.costUsd += typeof event.part.cost === 'number' ? event.part.cost : 0;
  }

  if (event.type === 'error' && event.error?.data?.message) {
    state.errorMessage = event.error.data.message;
  }

  return null;
}

export function generateWithOpencode(
  req: OpencodeRequest,
  cfg: OpencodeConfig
): Promise<OpencodeResponse> {
  return new Promise((resolve, reject) => {
    const model = req.model || cfg.defaultModel;
    const workDir = writeBridgeConfig(req.systemPrompt);

    const args = [
      'run',
      '--format', 'json',
      '--model', model,
      '--agent', 'bridge',
      req.userPrompt,
    ];

    const child = execFile('opencode', args, {
      cwd: workDir,
      timeout: cfg.timeoutMs,
      maxBuffer: cfg.maxBuffer,
    }, (error, stdout) => {
      cleanupDir(workDir);

      if (error) {
        console.error('[opencode] CLI execution failed:', error.message);
        try { child.kill(); } catch { /* already exited */ }
        reject(new Error('Opencode generation failed'));
        return;
      }

      const state: ParsedEvents = {
        text: '',
        inputTokens: 0,
        outputTokens: 0,
        cachedInputTokens: 0,
        reasoningTokens: 0,
        costUsd: 0,
      };
      const lastTextByPart: Record<string, string> = {};

      for (const line of stdout.split('\n')) {
        if (!line.trim()) continue;
        parseEventLine(line, state, lastTextByPart);
      }

      if (state.errorMessage) {
        console.error('[opencode] error event:', state.errorMessage);
        reject(new Error('Opencode generation failed'));
        return;
      }

      if (!state.text) {
        console.warn('[opencode] No text in output');
      }

      resolve({
        content: [{ type: 'text', text: state.text }],
        usage: {
          input_tokens: state.inputTokens,
          output_tokens: state.outputTokens,
          cached_input_tokens: state.cachedInputTokens,
          reasoning_tokens: state.reasoningTokens,
        },
        cost_usd: state.costUsd,
      });
    });
  });
}

// ── Streaming variant ───────────────────────────────────────────────────────

export interface OpencodeStreamCallbacks {
  onText: (chunk: string) => void;
  onUsage: (usage: OpencodeResponse['usage'], costUsd: number) => void;
  onError: (error: Error) => void;
  onDone: () => void;
}

export function streamWithOpencode(
  req: OpencodeRequest,
  cfg: OpencodeConfig,
  callbacks: OpencodeStreamCallbacks
): { kill: () => void } {
  const model = req.model || cfg.defaultModel;
  const workDir = writeBridgeConfig(req.systemPrompt);

  const args = [
    'run',
    '--format', 'json',
    '--model', model,
    '--agent', 'bridge',
    req.userPrompt,
  ];

  let finished = false;
  const finish = (fn: () => void) => {
    if (finished) return;
    finished = true;
    cleanupDir(workDir);
    fn();
  };

  const child = spawn('opencode', args, { cwd: workDir, stdio: ['pipe', 'pipe', 'pipe'] });

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

  const state: ParsedEvents = {
    text: '',
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    reasoningTokens: 0,
    costUsd: 0,
  };
  const lastTextByPart: Record<string, string> = {};
  let lastUsageEmitted = { input: 0, output: 0, cached: 0, reasoning: 0, cost: 0 };

  let buffer = '';
  child.stdout.on('data', (data: Buffer) => {
    buffer += data.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.trim()) continue;
      const delta = parseEventLine(line, state, lastTextByPart);
      if (delta) callbacks.onText(delta);

      // Emit usage updates whenever step_finish nudges the totals.
      const moved =
        state.inputTokens !== lastUsageEmitted.input ||
        state.outputTokens !== lastUsageEmitted.output ||
        state.cachedInputTokens !== lastUsageEmitted.cached ||
        state.reasoningTokens !== lastUsageEmitted.reasoning ||
        state.costUsd !== lastUsageEmitted.cost;
      if (moved) {
        lastUsageEmitted = {
          input: state.inputTokens,
          output: state.outputTokens,
          cached: state.cachedInputTokens,
          reasoning: state.reasoningTokens,
          cost: state.costUsd,
        };
        callbacks.onUsage(
          {
            input_tokens: state.inputTokens,
            output_tokens: state.outputTokens,
            cached_input_tokens: state.cachedInputTokens,
            reasoning_tokens: state.reasoningTokens,
          },
          state.costUsd
        );
      }
    }
  });

  child.on('close', (code) => {
    clearTimeout(timer);

    if (state.errorMessage) {
      console.error('[opencode/stream] error event:', state.errorMessage);
      finish(() => callbacks.onError(new Error('Opencode generation failed')));
      return;
    }

    if (code !== 0 && !finished) {
      console.error(`[opencode/stream] CLI exited with code ${code}`, stderrOutput.slice(0, 500));
      finish(() => callbacks.onError(new Error('Opencode generation failed')));
    } else {
      finish(() => callbacks.onDone());
    }
  });

  child.on('error', (err) => {
    clearTimeout(timer);
    console.error('[opencode/stream] spawn error:', err.message);
    finish(() => callbacks.onError(new Error('Opencode generation failed')));
  });

  return {
    kill: () => {
      try { child.kill(); } catch { /* ignore */ }
      cleanupDir(workDir);
    },
  };
}
