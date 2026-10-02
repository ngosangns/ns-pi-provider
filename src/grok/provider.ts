// @ts-nocheck — vendored upstream; adapted under MIT (see NOTICE)
import {
	createAssistantMessageEventStream,
	type Api,
	type AssistantMessageEventStream,
	type Context,
	type Model,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai/compat";
import { streamViaAcp } from "./acp-mode.js";
import { resolveIntegrationMode } from "./config.js";
import { emptyAssistantMessage } from "./events.js";
import { streamViaJsonl } from "./jsonl-mode.js";

/**
 * Lazy-friendly entry used by the registered provider.
 * Chooses ACP (persistent Grok agent) or JSONL (one-shot headless) from env.
 */
export function streamGrokAgent(
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	try {
		const mode = resolveIntegrationMode();
		if (mode === "jsonl") {
			return streamViaJsonl(model, context, options);
		}
		return streamViaAcp(model, context, options);
	} catch (err) {
		// Invalid mode / immediate config failure
		const stream = createAssistantMessageEventStream();
		const output = emptyAssistantMessage(model);
		queueMicrotask(() => {
			output.stopReason = "error";
			output.errorMessage = err instanceof Error ? err.message : String(err);
			output.content.push({ type: "text", text: output.errorMessage });
			stream.push({ type: "error", reason: "error", error: output });
			stream.end(output);
		});
		return stream;
	}
}
