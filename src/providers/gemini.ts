/// <reference types="node" />

import { execFile, spawn } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

export interface GeminiRequest {
	systemPrompt: string;
	userPrompt: string;
	model?: string;
}

export interface GeminiResponse {
	content: Array<{ type: string; text: string }>;
	usage: {
		input_tokens: number;
		output_tokens: number;
		cached_input_tokens: number;
	};
	cost_usd: number;
	duration_ms: number;
}

interface GeminiModelStats {
	api?: {
		totalLatencyMs?: number;
	};
	tokens?: {
		input?: number;
		prompt?: number;
		candidates?: number;
		cached?: number;
		total?: number;
	};
}

interface GeminiJsonOutput {
	response?: string;
	error?: {
		message?: string;
		code?: number;
	};
	stats?: {
		models?: Record<string, GeminiModelStats>;
	};
}

interface GeminiStreamResultStats {
	total_tokens?: number;
	input_tokens?: number;
	output_tokens?: number;
	cached?: number;
	duration_ms?: number;
	models?: Record<
		string,
		{
			input_tokens?: number;
			output_tokens?: number;
			cached?: number;
		}
	>;
}

interface GeminiParsedStats {
	usage: GeminiResponse["usage"];
	durationMs: number;
	resolvedModel?: string;
}

interface GeminiConfig {
	defaultModel: string;
	timeoutMs: number;
	maxBuffer: number;
}

const GEMINI_WORKSPACE_DIR = (() => {
	const dir = join(tmpdir(), "ai-cli-bridge-gemini");
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	return dir;
})();

// Optional pricing per 1M tokens. Keep gemini-pricing.json in the project root
// if you want cost estimation in the admin dashboard and logs.
let GEMINI_PRICING: Record<
	string,
	{ input: number; cached: number; output: number }
> = {};
try {
	const pricingPath = join(process.cwd(), "gemini-pricing.json");
	GEMINI_PRICING = JSON.parse(readFileSync(pricingPath, "utf-8"));
} catch {
	console.warn(
		"[gemini] gemini-pricing.json not found or invalid — cost estimation disabled",
	);
}

let hasWarnedAboutEmptyPricing = false;

function estimateCost(
	model: string,
	input: number,
	cached: number,
	output: number,
): number {
	const pricing = GEMINI_PRICING[model];
	if (!pricing) {
		if (
			!hasWarnedAboutEmptyPricing &&
			Object.keys(GEMINI_PRICING).length === 0
		) {
			hasWarnedAboutEmptyPricing = true;
			console.warn(
				"[gemini] Gemini cost estimation disabled — add entries to gemini-pricing.json to enable it",
			);
		}
		return 0;
	}
	const uncachedInput = Math.max(0, input - cached);
	return (
		(uncachedInput / 1_000_000) * pricing.input +
		(cached / 1_000_000) * pricing.cached +
		(output / 1_000_000) * pricing.output
	);
}

function buildArgs(
	model: string,
	outputFormat: "json" | "stream-json",
): string[] {
	return [
		"-p",
		"",
		"--model",
		model,
		"--approval-mode",
		"plan",
		"--output-format",
		outputFormat,
	];
}

export function buildGeminiPrompt(req: GeminiRequest): string {
	return [
		"Follow the system instructions exactly.",
		"",
		"<system_prompt>",
		req.systemPrompt,
		"</system_prompt>",
		"",
		"<user_prompt>",
		req.userPrompt,
		"</user_prompt>",
	].join("\n");
}

export function extractGeminiJsonStats(
	stats: GeminiJsonOutput["stats"] | undefined,
): GeminiParsedStats {
	if (!stats?.models || Object.keys(stats.models).length === 0) {
		return {
			usage: { input_tokens: 0, output_tokens: 0, cached_input_tokens: 0 },
			durationMs: 0,
		};
	}

	let resolvedModel: string | undefined;
	let inputTokens = 0;
	let outputTokens = 0;
	let cachedInputTokens = 0;
	let durationMs = 0;

	for (const [modelName, modelStats] of Object.entries(stats.models)) {
		resolvedModel ||= modelName;
		const tokens = modelStats.tokens || {};
		inputTokens += tokens.input ?? tokens.prompt ?? 0;
		outputTokens += tokens.candidates ?? 0;
		cachedInputTokens += tokens.cached ?? 0;
		durationMs += modelStats.api?.totalLatencyMs ?? 0;
	}

	return {
		usage: {
			input_tokens: inputTokens,
			output_tokens: outputTokens,
			cached_input_tokens: cachedInputTokens,
		},
		durationMs,
		resolvedModel,
	};
}

export function extractGeminiStreamStats(
	stats: GeminiStreamResultStats | undefined,
): GeminiParsedStats {
	if (!stats) {
		return {
			usage: { input_tokens: 0, output_tokens: 0, cached_input_tokens: 0 },
			durationMs: 0,
		};
	}

	const modelNames = stats.models ? Object.keys(stats.models) : [];
	const resolvedModel = modelNames[0];

	let inputTokens = stats.input_tokens ?? 0;
	let outputTokens = stats.output_tokens ?? 0;
	let cachedInputTokens = stats.cached ?? 0;

	if (!inputTokens && !outputTokens && stats.models) {
		for (const modelStats of Object.values(stats.models)) {
			inputTokens += modelStats.input_tokens ?? 0;
			outputTokens += modelStats.output_tokens ?? 0;
			cachedInputTokens += modelStats.cached ?? 0;
		}
	}

	return {
		usage: {
			input_tokens: inputTokens,
			output_tokens: outputTokens,
			cached_input_tokens: cachedInputTokens,
		},
		durationMs: stats.duration_ms ?? 0,
		resolvedModel,
	};
}

export function generateWithGemini(
	req: GeminiRequest,
	cfg: GeminiConfig,
): Promise<GeminiResponse> {
	return new Promise((resolve, reject) => {
		const model = req.model || cfg.defaultModel;
		const fullPrompt = buildGeminiPrompt(req);

		const child = execFile(
			"gemini",
			buildArgs(model, "json"),
			{
				cwd: GEMINI_WORKSPACE_DIR,
				timeout: cfg.timeoutMs,
				maxBuffer: cfg.maxBuffer,
			},
			(error: Error | null, stdout: string, stderr: string) => {
				if (error) {
					console.error(
						"[gemini] CLI execution failed:",
						error.message,
						stderr.slice(0, 500),
					);
					try {
						child.kill();
					} catch {
						/* already exited */
					}
					reject(new Error("Gemini generation failed"));
					return;
				}

				let parsed: GeminiJsonOutput;
				try {
					parsed = JSON.parse(stdout);
				} catch {
					resolve({
						content: [{ type: "text", text: stdout }],
						usage: {
							input_tokens: 0,
							output_tokens: 0,
							cached_input_tokens: 0,
						},
						cost_usd: 0,
						duration_ms: 0,
					});
					return;
				}

				if (parsed.error?.message) {
					console.error("[gemini] CLI returned error:", parsed.error.message);
					reject(new Error("Gemini generation failed"));
					return;
				}

				const stats = extractGeminiJsonStats(parsed.stats);
				const billingModel = stats.resolvedModel || model;

				resolve({
					content: [{ type: "text", text: parsed.response || "" }],
					usage: stats.usage,
					cost_usd: estimateCost(
						billingModel,
						stats.usage.input_tokens,
						stats.usage.cached_input_tokens,
						stats.usage.output_tokens,
					),
					duration_ms: stats.durationMs,
				});
			},
		);

		try {
			if (child.stdin) {
				child.stdin.write(fullPrompt);
				child.stdin.end();
			}
		} catch {
			try {
				child.kill();
			} catch {
				/* already exited */
			}
			reject(new Error("Failed to write prompt to CLI stdin"));
		}
	});
}

// ── Streaming variant ───────────────────────────────────────────────────────

export interface GeminiStreamCallbacks {
	onText: (chunk: string) => void;
	onUsage: (
		usage: GeminiResponse["usage"],
		costUsd: number,
		durationMs: number,
	) => void;
	onError: (error: Error) => void;
	onDone: () => void;
}

export function streamWithGemini(
	req: GeminiRequest,
	cfg: GeminiConfig,
	callbacks: GeminiStreamCallbacks,
): { kill: () => void } {
	const model = req.model || cfg.defaultModel;
	const fullPrompt = buildGeminiPrompt(req);

	let finished = false;
	const finish = (fn: () => void) => {
		if (finished) return;
		finished = true;
		fn();
	};

	const child = spawn("gemini", buildArgs(model, "stream-json"), {
		cwd: GEMINI_WORKSPACE_DIR,
		stdio: ["pipe", "pipe", "pipe"],
	});
	const timer = setTimeout(() => {
		try {
			child.kill("SIGTERM");
		} catch {
			/* ignore */
		}
		setTimeout(() => {
			try {
				child.kill("SIGKILL");
			} catch {
				/* ignore */
			}
		}, 5000);
		finish(() => callbacks.onError(new Error("Generation timed out")));
	}, cfg.timeoutMs);

	const stderrDecoder = new TextDecoder();
	const stdoutDecoder = new TextDecoder();
	let stderrOutput = "";
	child.stderr.on("data", (data: Uint8Array) => {
		stderrOutput += stderrDecoder.decode(data, { stream: true });
	});

	let usageReported = false;
	const processStreamLine = (line: string) => {
		if (finished || !line.trim()) return;
		try {
			const event = JSON.parse(line);

			if (
				event.type === "message" &&
				event.role === "assistant" &&
				event.delta === true &&
				typeof event.content === "string"
			) {
				callbacks.onText(event.content);
			}

			if (event.type === "result" && event.status === "success") {
				const stats = extractGeminiStreamStats(event.stats);
				const billingModel = stats.resolvedModel || model;
				usageReported = true;
				callbacks.onUsage(
					stats.usage,
					estimateCost(
						billingModel,
						stats.usage.input_tokens,
						stats.usage.cached_input_tokens,
						stats.usage.output_tokens,
					),
					stats.durationMs,
				);
			}
		} catch {
			// Skip unparseable lines
		}
	};

	let buffer = "";
	child.stdout.on("data", (data: Uint8Array) => {
		buffer += stdoutDecoder.decode(data, { stream: true });
		const lines = buffer.split("\n");
		buffer = lines.pop() || "";

		for (const line of lines) {
			processStreamLine(line);
		}
	});

	child.on("close", (code: number | null) => {
		clearTimeout(timer);
		const trailing = `${stdoutDecoder.decode()}${buffer}`.trim();
		if (trailing) {
			processStreamLine(trailing);
		}

		if (code !== 0 && !finished) {
			console.error(
				`[gemini/stream] CLI exited with code ${code}`,
				stderrOutput.slice(0, 500),
			);
			finish(() => callbacks.onError(new Error("Gemini generation failed")));
		} else {
			if (!usageReported) {
				callbacks.onUsage(
					{ input_tokens: 0, output_tokens: 0, cached_input_tokens: 0 },
					0,
					0,
				);
			}
			finish(() => callbacks.onDone());
		}
	});

	child.on("error", (err: Error) => {
		clearTimeout(timer);
		console.error("[gemini/stream] spawn error:", err.message);
		finish(() => callbacks.onError(new Error("Gemini generation failed")));
	});

	try {
		if (child.stdin) {
			child.stdin.write(fullPrompt);
			child.stdin.end();
		}
	} catch {
		try {
			child.kill();
		} catch {
			/* ignore */
		}
		finish(() =>
			callbacks.onError(new Error("Failed to write prompt to CLI stdin")),
		);
	}

	return {
		kill: () => {
			try {
				child.kill();
			} catch {
				/* ignore */
			}
		},
	};
}
