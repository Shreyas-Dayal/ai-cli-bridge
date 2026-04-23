import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	buildGeminiPrompt,
	extractGeminiJsonStats,
	extractGeminiStreamStats,
} from "../src/providers/gemini";

describe("buildGeminiPrompt", () => {
	it("wraps the system and user prompts in explicit sections", () => {
		const prompt = buildGeminiPrompt({
			systemPrompt: "Reply concisely.",
			userPrompt: "What is 2+2?",
		});

		assert.ok(prompt.includes("<system_prompt>"));
		assert.ok(prompt.includes("Reply concisely."));
		assert.ok(prompt.includes("<user_prompt>"));
		assert.ok(prompt.includes("What is 2+2?"));
	});
});

describe("extractGeminiJsonStats", () => {
	it("normalizes usage and duration from Gemini JSON output", () => {
		const stats = extractGeminiJsonStats({
			models: {
				"gemini-3.1-pro-preview": {
					api: { totalLatencyMs: 3306 },
					tokens: {
						input: 13015,
						prompt: 13015,
						candidates: 10,
						total: 13096,
						cached: 0,
					},
				},
			},
		});

		assert.deepEqual(stats, {
			usage: {
				input_tokens: 13015,
				output_tokens: 10,
				cached_input_tokens: 0,
			},
			durationMs: 3306,
			resolvedModel: "gemini-3.1-pro-preview",
		});
	});
});

describe("extractGeminiStreamStats", () => {
	it("normalizes usage and duration from Gemini stream result events", () => {
		const stats = extractGeminiStreamStats({
			input_tokens: 13029,
			output_tokens: 92,
			cached: 0,
			duration_ms: 6076,
			models: {
				"gemini-3.1-pro-preview": {
					input_tokens: 13029,
					output_tokens: 92,
					cached: 0,
				},
			},
		});

		assert.deepEqual(stats, {
			usage: {
				input_tokens: 13029,
				output_tokens: 92,
				cached_input_tokens: 0,
			},
			durationMs: 6076,
			resolvedModel: "gemini-3.1-pro-preview",
		});
	});

	it("falls back to summing model stats when top-level token counts are absent", () => {
		const stats = extractGeminiStreamStats({
			duration_ms: 1200,
			models: {
				"gemini-a": { input_tokens: 100, output_tokens: 5, cached: 10 },
				"gemini-b": { input_tokens: 200, output_tokens: 7, cached: 20 },
			},
		});

		assert.deepEqual(stats, {
			usage: {
				input_tokens: 300,
				output_tokens: 12,
				cached_input_tokens: 30,
			},
			durationMs: 1200,
			resolvedModel: "gemini-a",
		});
	});
});
