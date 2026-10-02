// @ts-nocheck — vendored upstream; adapted under MIT (see NOTICE)
import {
	createAssistantMessageEventStream,
	type Api,
	type AssistantMessageEventStream,
	type Context,
	type Model,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai/compat";
import { envFlag, mapReasoningEffort } from "./config.js";
import {
	applyAcpUsage,
	emptyAssistantMessage,
	mapStopReason,
	PiContentEmitter,
	StreamingUpdatePump,
} from "./events.js";
import { resolveCliModelId } from "./models.js";
import { buildFullPrompt, buildIncrementalPrompt, contextHistoryFingerprint } from "./prompt.js";
import { getSessionCwd } from "./session-scope.js";
import { promptAcpSession, withSessionAgent } from "./session-agent.js";

export function streamViaAcp(
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	const output = emptyAssistantMessage(model);
	const emitter = new PiContentEmitter(stream, output);
	const pump = new StreamingUpdatePump(1);

	queueMicrotask(async () => {
		let finished = false;
		const finishError = async (msg: string, aborted = false) => {
			if (finished) return;
			finished = true;
			await pump.idle();
			pump.close();
			emitter.error(msg, aborted);
		};
		const finishDone = async (reason?: string) => {
			if (finished) return;
			finished = true;
			await pump.idle();
			pump.close();
			emitter.done(mapStopReason(reason));
		};

		try {
			if (options?.signal?.aborted) {
				await finishError("aborted", true);
				return;
			}

			const reasoning = mapReasoningEffort(options?.reasoning);
			const cwd = getSessionCwd();
			const showTools =
				envFlag("PI_GROK_SDK_SHOW_TOOLS") || envFlag("PI_GROK_AGENT_SHOW_TOOLS");
			const cliModelId = resolveCliModelId(model.id);

			// Live assistant row before first token (native pi feel).
			emitter.ensureStart();

			await withSessionAgent(
				{
					modelId: cliModelId,
					reasoningEffort: reasoning,
					cwd,
					signal: options?.signal,
				},
				async (session) => {
					const fingerprint = contextHistoryFingerprint(context);
					const useIncremental = session.bootstrapped && session.historyFingerprint !== "";
					const promptText = useIncremental
						? buildIncrementalPrompt(context)
						: buildFullPrompt(context);

					if (!promptText.trim()) {
						throw new Error("Empty prompt for Grok ACP session");
					}

					const result = await promptAcpSession(session, promptText, {
						signal: options?.signal,
						onUpdate: (update) => {
							// Enqueue so each token yields to the event loop (TUI paints).
							pump.enqueue(() => {
								if (finished || options?.signal?.aborted) return;
								const kind = update.sessionUpdate;
								const piece =
									typeof update.content?.text === "string" ? update.content.text : "";
								if (kind === "agent_thought_chunk") {
									// Token deltas; closing text if open starts a new thinking block.
									emitter.appendThinking(piece);
								} else if (kind === "agent_message_chunk") {
									// Closes thinking first → pi collapses reasoning, then streams answer.
									emitter.appendText(piece);
								} else if (showTools && kind === "tool_call") {
									const label = update.title || update.kind || "tool";
									emitter.noteActivity(`[grok tool: ${label}]`);
								}
							});
						},
					});

					// Drain any queued tokens before applying usage / done.
					await pump.idle();
					applyAcpUsage(output, result._meta);
					session.bootstrapped = true;
					session.historyFingerprint = fingerprint;
					await finishDone(result.stopReason);
				},
			);
		} catch (err) {
			const aborted =
				options?.signal?.aborted || (err instanceof Error && err.message === "aborted");
			await finishError(err instanceof Error ? err.message : String(err), aborted);
		}
	});

	return stream;
}
