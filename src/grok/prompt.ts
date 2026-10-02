// @ts-nocheck — vendored upstream; adapted under MIT (see NOTICE)
import type { Context } from "@earendil-works/pi-ai/compat";

function contentToText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((block) => {
			if (!block || typeof block !== "object") return "";
			const b = block as Record<string, unknown>;
			if (b.type === "text" && typeof b.text === "string") return b.text;
			if ("text" in b && typeof b.text === "string" && !b.type) return b.text;
			if (b.type === "thinking") return "";
			if (b.type === "image") return "[image omitted]";
			if (b.type === "toolCall") {
				return `[tool call: ${String(b.name ?? "unknown")} args=${JSON.stringify(b.arguments ?? {})}]`;
			}
			return "";
		})
		.filter(Boolean)
		.join("\n");
}

/**
 * Full conversation prompt for cold starts / JSONL one-shots.
 * Includes system prompt and labeled history so Grok has context.
 */
export function buildFullPrompt(context: Context): string {
	const parts: string[] = [];
	if (context.systemPrompt?.trim()) {
		parts.push(`system:\n${context.systemPrompt.trim()}`);
	}
	for (const message of context.messages) {
		if (message.role === "user") {
			parts.push(`user:\n${contentToText(message.content)}`);
		} else if (message.role === "assistant") {
			parts.push(`assistant:\n${contentToText(message.content)}`);
		} else if (message.role === "toolResult") {
			const name = "toolName" in message ? String((message as { toolName?: string }).toolName ?? "tool") : "tool";
			parts.push(`tool result (${name}):\n${contentToText(message.content)}`);
		}
	}
	return parts.join("\n\n");
}

/**
 * Incremental prompt for a warm ACP session that already holds history.
 * Sends only trailing user / tool-result messages after the last assistant turn.
 */
export function buildIncrementalPrompt(context: Context): string {
	const messages = context.messages;
	let lastAssistant = -1;
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i].role === "assistant") {
			lastAssistant = i;
			break;
		}
	}
	const tail = messages.slice(lastAssistant + 1);
	if (tail.length === 0) {
		// Fallback: last user message or full prompt
		for (let i = messages.length - 1; i >= 0; i--) {
			if (messages[i].role === "user") {
				return contentToText(messages[i].content);
			}
		}
		return buildFullPrompt(context);
	}
	const parts: string[] = [];
	for (const message of tail) {
		if (message.role === "user") {
			parts.push(contentToText(message.content));
		} else if (message.role === "toolResult") {
			const name = "toolName" in message ? String((message as { toolName?: string }).toolName ?? "tool") : "tool";
			parts.push(`tool result (${name}):\n${contentToText(message.content)}`);
		}
	}
	return parts.filter(Boolean).join("\n\n") || buildFullPrompt(context);
}

/** Fingerprint of conversation prefix used to detect history drift. */
export function contextHistoryFingerprint(context: Context): string {
	// Hash-ish string of roles + lengths + last assistant snippet; cheap stability check.
	const parts: string[] = [];
	if (context.systemPrompt) parts.push(`sys:${context.systemPrompt.length}`);
	for (const m of context.messages) {
		const text = contentToText(m.content);
		parts.push(`${m.role}:${text.length}:${text.slice(0, 64)}`);
	}
	return parts.join("|");
}
