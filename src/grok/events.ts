// @ts-nocheck — vendored upstream; adapted under MIT (see NOTICE)
import type {
	Api,
	AssistantMessage,
	AssistantMessageEvent,
	AssistantMessageEventStream,
	Model,
	StopReason,
	TextContent,
	ThinkingContent,
} from "@earendil-works/pi-ai/compat";
import { API } from "./config.js";
import type { AcpPromptMeta } from "./types.js";

export function emptyAssistantMessage(model: Model<Api>): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api || API,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

export function applyAcpUsage(output: AssistantMessage, meta?: AcpPromptMeta): void {
	if (!meta) return;
	output.usage.input = meta.inputTokens ?? 0;
	output.usage.output = meta.outputTokens ?? 0;
	output.usage.cacheRead = meta.cachedReadTokens ?? 0;
	output.usage.cacheWrite = 0;
	output.usage.totalTokens =
		meta.totalTokens ??
		output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
	if (meta.requestId || meta.promptId) {
		output.responseId = meta.requestId ?? meta.promptId;
	}
}

export function mapStopReason(reason: string | undefined): StopReason {
	if (!reason) return "stop";
	const r = reason.toLowerCase();
	if (r === "max_tokens" || r === "maxtokens" || r === "length") return "length";
	if (r === "tool_use" || r === "tooluse" || r === "tool_calls") return "toolUse";
	if (r === "aborted" || r === "cancelled" || r === "canceled") return "aborted";
	if (r === "error") return "error";
	return "stop";
}

function cloneContentBlock(
	block: AssistantMessage["content"][number],
): AssistantMessage["content"][number] {
	if (block.type === "text") {
		return { type: "text", text: block.text, ...(block.textSignature ? { textSignature: block.textSignature } : {}) };
	}
	if (block.type === "thinking") {
		const out: ThinkingContent = { type: "thinking", thinking: block.thinking };
		if (block.thinkingSignature !== undefined) out.thinkingSignature = block.thinkingSignature;
		if (block.redacted !== undefined) out.redacted = block.redacted;
		return out;
	}
	// toolCall / other — shallow copy
	return { ...block };
}

/** Immutable snapshot so consumers/TUI never observe torn mid-mutation state. */
export function snapshotAssistantMessage(message: AssistantMessage): AssistantMessage {
	return {
		...message,
		content: message.content.map(cloneContentBlock),
		usage: {
			...message.usage,
			cost: { ...message.usage.cost },
		},
	};
}

/**
 * Pi-native partial content emitter.
 *
 * - Thinking and text are mutually exclusive open blocks.
 * - First text token closes thinking (`thinking_end`) so pi collapses reasoning
 *   before the answer streams — same as Cursor / native providers.
 * - Each stream event carries an **immutable snapshot** of `partial`.
 */
export class PiContentEmitter {
	private started = false;
	private thinkingContentIndex = -1;
	private textContentIndex = -1;
	/** Last visible text appended was a tool-activity list line. */
	private lastTextWasTool = false;
	private readonly mutuallyExclusive: boolean;

	constructor(
		private readonly stream: AssistantMessageEventStream,
		private readonly partial: AssistantMessage,
		options?: { mutuallyExclusive?: boolean },
	) {
		this.mutuallyExclusive = options?.mutuallyExclusive ?? true;
	}

	/** Current immutable view (for external reads). */
	snapshot(): AssistantMessage {
		return snapshotAssistantMessage(this.partial);
	}

	private push(event: AssistantMessageEvent): void {
		// Re-bind partial on every event so JSON/TUI never see later mutations
		// on a shared object reference.
		const partial = this.snapshot();
		if ("partial" in event) {
			this.stream.push({ ...event, partial } as AssistantMessageEvent);
		} else if (event.type === "done") {
			this.stream.push({ ...event, message: this.snapshot() });
		} else if (event.type === "error") {
			this.stream.push({ ...event, error: this.snapshot() });
		} else {
			this.stream.push(event);
		}
	}

	ensureStart(): void {
		if (this.started) return;
		this.started = true;
		this.push({ type: "start", partial: this.partial });
	}

	closeThinking(): void {
		if (this.thinkingContentIndex < 0) return;
		const contentIndex = this.thinkingContentIndex;
		const block = this.partial.content[contentIndex];
		this.thinkingContentIndex = -1;
		if (block?.type !== "thinking") return;
		this.push({
			type: "thinking_end",
			contentIndex,
			content: block.thinking,
			partial: this.partial,
		});
	}

	closeText(): string {
		if (this.textContentIndex < 0) return "";
		const contentIndex = this.textContentIndex;
		const block = this.partial.content[contentIndex];
		this.textContentIndex = -1;
		this.lastTextWasTool = false;
		if (block?.type !== "text") return "";
		this.push({
			type: "text_end",
			contentIndex,
			content: block.text,
			partial: this.partial,
		});
		return block.text;
	}

	closeAll(): string {
		this.closeThinking();
		return this.closeText();
	}

	appendThinking(delta: string, options?: { closeText?: boolean }): void {
		if (!delta) return;
		this.ensureStart();
		if (options?.closeText ?? this.mutuallyExclusive) this.closeText();

		if (this.thinkingContentIndex < 0) {
			this.thinkingContentIndex = this.partial.content.length;
			this.partial.content.push({ type: "thinking", thinking: "" } satisfies ThinkingContent);
			this.push({
				type: "thinking_start",
				contentIndex: this.thinkingContentIndex,
				partial: this.partial,
			});
		}

		const block = this.partial.content[this.thinkingContentIndex];
		if (block?.type !== "thinking") return;
		block.thinking += delta;
		this.push({
			type: "thinking_delta",
			contentIndex: this.thinkingContentIndex,
			delta,
			partial: this.partial,
		});
	}

	appendText(delta: string, options?: { closeThinking?: boolean }): void {
		if (!delta) return;
		if (this.lastTextWasTool && this.textContentIndex >= 0) {
			// Blank line so prose after a tool list is not folded into its last item.
			this.lastTextWasTool = false;
			const open = this.partial.content[this.textContentIndex];
			if (open?.type === "text" && !open.text.endsWith("\n\n")) {
				delta = `${open.text.endsWith("\n") ? "\n" : "\n\n"}${delta}`;
			}
		}
		this.lastTextWasTool = false;
		this.appendTextRaw(delta, options);
	}

	/**
	 * Visible tool-activity line(s) ("- Edit `a.ts` (+1 −1)\n") in the answer
	 * text, separated from surrounding prose so Markdown renders them as a list.
	 */
	appendToolActivity(lines: string, options?: { closeThinking?: boolean }): void {
		if (!lines) return;
		let delta = lines.endsWith("\n") ? lines : `${lines}\n`;
		const open = this.textContentIndex >= 0 ? this.partial.content[this.textContentIndex] : undefined;
		if (!this.lastTextWasTool && open?.type === "text" && open.text && !open.text.endsWith("\n\n")) {
			delta = `${open.text.endsWith("\n") ? "\n" : "\n\n"}${delta}`;
		}
		this.appendTextRaw(delta, options);
		this.lastTextWasTool = true;
	}

	private appendTextRaw(delta: string, options?: { closeThinking?: boolean }): void {
		this.ensureStart();
		if (options?.closeThinking ?? this.mutuallyExclusive) this.closeThinking();

		if (this.textContentIndex < 0) {
			this.textContentIndex = this.partial.content.length;
			this.partial.content.push({ type: "text", text: "" } satisfies TextContent);
			this.push({
				type: "text_start",
				contentIndex: this.textContentIndex,
				partial: this.partial,
			});
		}

		const block = this.partial.content[this.textContentIndex];
		if (block?.type !== "text") return;
		block.text += delta;
		this.push({
			type: "text_delta",
			contentIndex: this.textContentIndex,
			delta,
			partial: this.partial,
		});
	}

	/** Short closed thinking note (tool activity) without polluting the answer. */
	noteActivity(label: string): void {
		const text = label.endsWith("\n") ? label : `${label}\n`;
		this.appendThinking(text);
		this.closeThinking();
	}

	noteToolCall(title: string | undefined, kind?: string): void {
		const label = title || kind || "tool";
		this.noteActivity(`[grok tool: ${label}]`);
	}

	finishOpenBlocks(): void {
		this.closeAll();
	}

	done(reason: StopReason = "stop"): void {
		this.ensureStart();
		this.closeAll();
		this.partial.stopReason = reason;
		const doneReason =
			reason === "length" || reason === "toolUse" || reason === "stop" ? reason : "stop";
		this.push({ type: "done", reason: doneReason, message: this.partial });
		this.stream.end(this.snapshot());
	}

	error(message: string, aborted = false): void {
		this.closeAll();
		if (!this.started) this.ensureStart();
		this.partial.stopReason = aborted ? "aborted" : "error";
		this.partial.errorMessage = message;
		if (this.partial.content.length === 0) {
			this.partial.content.push({ type: "text", text: message });
		}
		this.push({
			type: "error",
			reason: this.partial.stopReason,
			error: this.partial,
		});
		this.stream.end(this.snapshot());
	}
}

/**
 * Async pump: apply ACP/JSONL content updates with an event-loop yield between
 * tokens so pi's TUI can paint mid-stream (native streaming feel).
 *
 * Without this, a buffered burst of NDJSON/ACP lines is applied in one tick
 * and the UI only shows the final blob.
 */
export class StreamingUpdatePump {
	private queue: Array<() => void> = [];
	private running = false;
	private closed = false;
	private drainResolve: (() => void) | undefined;
	private drainPromise: Promise<void> | undefined;

	constructor(private readonly yieldEvery = 1) {}

	enqueue(fn: () => void): void {
		if (this.closed) return;
		this.queue.push(fn);
		void this.kick();
	}

	/** Wait until the queue is empty. */
	idle(): Promise<void> {
		if (this.queue.length === 0 && !this.running) return Promise.resolve();
		if (!this.drainPromise) {
			this.drainPromise = new Promise((resolve) => {
				this.drainResolve = resolve;
			});
		}
		return this.drainPromise;
	}

	close(): void {
		this.closed = true;
		this.queue.length = 0;
		this.finishDrain();
	}

	private finishDrain(): void {
		const resolve = this.drainResolve;
		this.drainResolve = undefined;
		this.drainPromise = undefined;
		resolve?.();
	}

	private async kick(): Promise<void> {
		if (this.running) return;
		this.running = true;
		try {
			let n = 0;
			while (this.queue.length > 0 && !this.closed) {
				const fn = this.queue.shift()!;
				try {
					fn();
				} catch {
					// ignore individual update errors; outer path handles fatals
				}
				n++;
				// Yield to the event loop so pi TUI / JSON mode can flush frames.
				if (n % this.yieldEvery === 0) {
					await new Promise<void>((r) => setImmediate(r));
				}
			}
		} finally {
			this.running = false;
			if (this.queue.length > 0 && !this.closed) {
				void this.kick();
			} else {
				this.finishDrain();
			}
		}
	}
}
