// @ts-nocheck — vendored upstream; adapted under MIT (see NOTICE)
import { execFileSync } from "node:child_process";
import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { resolveGrokBinary } from "./binary.js";
import {
	DEFAULT_CONTEXT_WINDOW,
	DEFAULT_MAX_TOKENS,
	DEFAULT_MODEL_ID,
	THINKING_LEVEL_MAP,
} from "./config.js";
import type { GrokModelDescriptor } from "./types.js";

export function parseGrokModelsOutput(stdout: string): GrokModelDescriptor[] {
	const models: GrokModelDescriptor[] = [];
	const seen = new Set<string>();

	// Lines like: "  * grok-4.5 (default)" or "  * grok-4.5"
	const bullet = /^\s*[*•-]\s+(\S+)/;
	// "Default model: grok-4.5"
	const defaultLine = /default model:\s*(\S+)/i;

	for (const line of stdout.split(/\r?\n/)) {
		const m = line.match(bullet);
		if (m) {
			const id = m[1].replace(/[(),]+$/g, "");
			if (!seen.has(id)) {
				seen.add(id);
				models.push({
					id,
					name: id,
					contextWindow: DEFAULT_CONTEXT_WINDOW,
					maxTokens: DEFAULT_MAX_TOKENS,
					supportsReasoningEffort: true,
				});
			}
			continue;
		}
		const d = line.match(defaultLine);
		if (d && !seen.has(d[1])) {
			seen.add(d[1]);
			models.unshift({
				id: d[1],
				name: d[1],
				contextWindow: DEFAULT_CONTEXT_WINDOW,
				maxTokens: DEFAULT_MAX_TOKENS,
				supportsReasoningEffort: true,
			});
		}
	}

	return models;
}

export function fallbackModels(): GrokModelDescriptor[] {
	return [
		{
			id: DEFAULT_MODEL_ID,
			name: "Grok 4.5",
			contextWindow: DEFAULT_CONTEXT_WINDOW,
			maxTokens: DEFAULT_MAX_TOKENS,
			supportsReasoningEffort: true,
		},
	];
}

export function discoverModels(binary?: string): {
	models: GrokModelDescriptor[];
	source: "live" | "fallback";
	error?: string;
} {
	try {
		const bin = binary ?? resolveGrokBinary();
		const stdout = execFileSync(bin, ["models"], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
			timeout: 20_000,
		});
		const parsed = parseGrokModelsOutput(stdout);
		if (parsed.length === 0) {
			return { models: fallbackModels(), source: "fallback", error: "empty model list from CLI" };
		}
		return { models: parsed, source: "live" };
	} catch (err) {
		return {
			models: fallbackModels(),
			source: "fallback",
			error: err instanceof Error ? err.message : String(err),
		};
	}
}

/**
 * Map pi model IDs to CLI `--model` IDs.
 * Supports the pre-0.2 alias `grok-4.5-agent` and a generic `*-agent` suffix strip.
 */
export function resolveCliModelId(modelId: string): string {
	if (modelId === "grok-4.5-agent") return DEFAULT_MODEL_ID;
	if (modelId.endsWith("-agent") && modelId.length > 6) {
		return modelId.slice(0, -"-agent".length);
	}
	return modelId;
}

function toProviderModel(d: GrokModelDescriptor): ProviderModelConfig {
	return {
		id: d.id,
		name: d.name,
		reasoning: true,
		thinkingLevelMap: { ...THINKING_LEVEL_MAP },
		input: ["text"] as ("text" | "image")[],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: d.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
		maxTokens: d.maxTokens ?? DEFAULT_MAX_TOKENS,
	};
}

export function toProviderModels(descriptors: readonly GrokModelDescriptor[]): ProviderModelConfig[] {
	const models = descriptors.map(toProviderModel);
	// Back-compat alias used by older settings / README (v0.1.x).
	const hasDefault = models.some((m) => m.id === DEFAULT_MODEL_ID);
	const hasLegacyAlias = models.some((m) => m.id === "grok-4.5-agent");
	if (hasDefault && !hasLegacyAlias) {
		const base = models.find((m) => m.id === DEFAULT_MODEL_ID)!;
		models.push({
			...base,
			id: "grok-4.5-agent",
			name: `${base.name} (legacy alias)`,
		});
	}
	return models;
}
