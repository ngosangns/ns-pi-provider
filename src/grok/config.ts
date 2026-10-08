// @ts-nocheck — vendored upstream; adapted under MIT (see NOTICE)
import type { IntegrationMode, ReasoningEffort } from "./types.js";

/** Pi provider id (registered as grok-sdk/<model>). */
export const PROVIDER = "grok-sdk";
export const API = "grok-sdk";
/** Legacy provider id from pi-grok-agent-cli — still accepted for aliases. */
export const LEGACY_PROVIDER = "grok-agent-cli";
export const DEFAULT_MODEL_ID = "grok-4.5";
export const CLIENT_NAME = "pi-grok-sdk";
export const CLIENT_VERSION = "0.2.1";

/** Map pi thinking levels onto Grok `--reasoning-effort` values. */
export const THINKING_LEVEL_MAP = {
	off: "none",
	minimal: "minimal",
	low: "low",
	medium: "medium",
	high: "high",
	xhigh: "xhigh",
	max: "max",
} as const;

export const DEFAULT_CONTEXT_WINDOW = 500_000;
export const DEFAULT_MAX_TOKENS = 128_000;
export const INACTIVITY_TIMEOUT_MS = 180_000;

export function resolveIntegrationMode(
	env: NodeJS.ProcessEnv = process.env,
): IntegrationMode {
	const raw = (
		env.PI_GROK_SDK_MODE ??
		env.PI_GROK_AGENT_MODE ??
		env.PI_GROK_AGENT_CLI_MODE ??
		"acp"
	)
		.trim()
		.toLowerCase();
	if (raw === "jsonl" || raw === "acp") return raw;
	throw new Error(
		`Invalid PI_GROK_SDK_MODE='${raw}'. Use 'acp' (default, persistent Grok agent) or 'jsonl' (one-shot streaming-json).`,
	);
}

export function mapReasoningEffort(
	reasoning: string | undefined,
): ReasoningEffort | undefined {
	if (!reasoning) return undefined;
	const normalized = reasoning.trim().toLowerCase();
	if (normalized === "off") return "none";
	if (
		normalized === "none" ||
		normalized === "minimal" ||
		normalized === "low" ||
		normalized === "medium" ||
		normalized === "high" ||
		normalized === "xhigh" ||
		normalized === "max"
	) {
		return normalized;
	}
	return undefined;
}

export function envFlag(name: string, env: NodeJS.ProcessEnv = process.env): boolean {
	const v = env[name];
	return v === "1" || v === "true" || v === "yes";
}

/**
 * Tri-state env flag: "1/true/yes/on" → true, "0/false/no/off" → false,
 * unset/other → `fallback`. First set name wins.
 */
export function envFlagDefault(
	names: string[],
	fallback: boolean,
	env: NodeJS.ProcessEnv = process.env,
): boolean {
	for (const name of names) {
		const raw = env[name]?.trim().toLowerCase();
		if (!raw) continue;
		if (raw === "1" || raw === "true" || raw === "yes" || raw === "on") return true;
		if (raw === "0" || raw === "false" || raw === "no" || raw === "off") return false;
	}
	return fallback;
}
