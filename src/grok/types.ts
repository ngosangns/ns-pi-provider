// @ts-nocheck — vendored upstream; adapted under MIT (see NOTICE)
/** Integration modes for talking to the local Grok agent CLI. */
export type IntegrationMode = "acp" | "jsonl";

/** Reasoning effort levels accepted by Grok CLI / ACP. */
export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface GrokModelDescriptor {
	id: string;
	name: string;
	contextWindow?: number;
	maxTokens?: number;
	supportsReasoningEffort?: boolean;
}

/** Headless streaming-json event shapes (non-exhaustive). */
export interface GrokTextEvent {
	type: "text";
	data?: string;
}

export interface GrokThoughtEvent {
	type: "thought";
	data?: string;
}

export interface GrokEndEvent {
	type: "end";
	stopReason?: string;
	sessionId?: string;
	requestId?: string;
}

export interface GrokErrorEvent {
	type: "error";
	message?: string;
	error?: string;
}

export type GrokNdjsonMessage = GrokTextEvent | GrokThoughtEvent | GrokEndEvent | GrokErrorEvent | Record<string, unknown>;

export interface AcpPromptMeta {
	requestId?: string;
	promptId?: string;
	sessionId?: string;
	inputTokens?: number;
	outputTokens?: number;
	cachedReadTokens?: number;
	reasoningTokens?: number;
	totalTokens?: number;
	modelId?: string;
}

export interface AcpPromptResult {
	stopReason?: string;
	_meta?: AcpPromptMeta;
}

export interface AcpInitializeResult {
	protocolVersion?: number;
	authMethods?: Array<{ id?: string; name?: string; description?: string }>;
	agentCapabilities?: Record<string, unknown>;
}

export interface AcpSessionResult {
	sessionId?: string;
	models?: {
		currentModelId?: string;
		availableModels?: Array<{
			modelId?: string;
			name?: string;
			description?: string;
			_meta?: {
				totalContextTokens?: number;
				supportsReasoningEffort?: boolean;
				reasoningEffort?: string;
				reasoningEfforts?: Array<{ id?: string; value?: string; label?: string; default?: boolean }>;
			};
		}>;
	};
}
