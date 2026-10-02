// @ts-nocheck — vendored upstream; adapted under MIT (see NOTICE)
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import {
	createAssistantMessageEventStream,
	type Api,
	type AssistantMessageEventStream,
	type Context,
	type Model,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai/compat";
import { resolveGrokBinary } from "./binary.js";
import { INACTIVITY_TIMEOUT_MS, mapReasoningEffort } from "./config.js";
import {
	emptyAssistantMessage,
	mapStopReason,
	PiContentEmitter,
	StreamingUpdatePump,
} from "./events.js";
import { resolveCliModelId } from "./models.js";
import { buildFullPrompt } from "./prompt.js";
import { getSessionCwd } from "./session-scope.js";
import type { ReasoningEffort } from "./types.js";

function buildJsonlArgs(
	prompt: string,
	options: {
		modelId: string;
		reasoningEffort?: ReasoningEffort;
		cwd?: string;
		resumeSessionId?: string;
	},
): string[] {
	const args = [
		"--single",
		prompt,
		"--output-format",
		"streaming-json",
		"--always-approve",
		"--no-plan",
		"--no-subagents",
		"--model",
		options.modelId,
	];
	if (options.reasoningEffort && options.reasoningEffort !== "none") {
		args.push("--reasoning-effort", options.reasoningEffort);
	}
	if (options.cwd) args.push("--cwd", options.cwd);
	if (options.resumeSessionId) args.push("--resume", options.resumeSessionId);
	return args;
}

export function streamViaJsonl(
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	const output = emptyAssistantMessage(model);
	const emitter = new PiContentEmitter(stream, output);
	const pump = new StreamingUpdatePump(1);

	queueMicrotask(async () => {
		let proc: ReturnType<typeof spawn> | undefined;
		let inactivityTimer: ReturnType<typeof setTimeout> | undefined;
		let finished = false;

		const finishError = async (msg: string, aborted = false) => {
			if (finished) return;
			finished = true;
			if (inactivityTimer) clearTimeout(inactivityTimer);
			await pump.idle();
			pump.close();
			emitter.error(msg, aborted);
		};

		const finishDone = async (reason?: string) => {
			if (finished) return;
			finished = true;
			if (inactivityTimer) clearTimeout(inactivityTimer);
			await pump.idle();
			pump.close();
			emitter.done(mapStopReason(reason));
		};

		const resetTimer = () => {
			if (inactivityTimer) clearTimeout(inactivityTimer);
			inactivityTimer = setTimeout(() => {
				proc?.kill("SIGTERM");
				void finishError(`Grok agent timed out: no output for ${INACTIVITY_TIMEOUT_MS / 1000}s`);
			}, INACTIVITY_TIMEOUT_MS);
		};

		try {
			if (options?.signal?.aborted) {
				await finishError("aborted", true);
				return;
			}

			const binary = resolveGrokBinary();
			const cwd = getSessionCwd();
			const reasoning = mapReasoningEffort(options?.reasoning);
			const prompt = buildFullPrompt(context);
			const args = buildJsonlArgs(prompt, {
				modelId: resolveCliModelId(model.id),
				reasoningEffort: reasoning,
				cwd,
			});

			proc = spawn(binary, args, {
				stdio: ["ignore", "pipe", "pipe"],
				cwd,
				env: process.env,
			});

			let stderr = "";
			proc.stderr?.setEncoding("utf8");
			proc.stderr?.on("data", (c: string) => {
				stderr += c;
			});

			const abort = () => proc?.kill("SIGTERM");
			options?.signal?.addEventListener("abort", abort, { once: true });

			const rl = createInterface({ input: proc.stdout!, crlfDelay: Infinity, terminal: false });
			resetTimer();
			emitter.ensureStart();

			rl.on("line", (line) => {
				resetTimer();
				const trimmed = line.trim();
				if (!trimmed.startsWith("{")) return;
				let msg: Record<string, unknown>;
				try {
					msg = JSON.parse(trimmed) as Record<string, unknown>;
				} catch {
					return;
				}
				const type = msg.type;
				if (type === "text" && typeof msg.data === "string") {
					const data = msg.data;
					pump.enqueue(() => {
						if (!finished) emitter.appendText(data);
					});
				} else if (type === "thought" && typeof msg.data === "string") {
					const data = msg.data;
					pump.enqueue(() => {
						if (!finished) emitter.appendThinking(data);
					});
				} else if (type === "end") {
					if (typeof msg.requestId === "string") output.responseId = msg.requestId;
					const reason = typeof msg.stopReason === "string" ? msg.stopReason : undefined;
					void (async () => {
						await finishDone(reason);
						rl.close();
						proc?.kill("SIGTERM");
					})();
				} else if (type === "error") {
					const message =
						(typeof msg.message === "string" && msg.message) ||
						(typeof msg.error === "string" && msg.error) ||
						"Grok agent error";
					void (async () => {
						await finishError(message);
						rl.close();
						proc?.kill("SIGTERM");
					})();
				}
			});

			await new Promise<void>((resolve) => {
				rl.on("close", () => resolve());
				proc?.on("close", () => resolve());
				proc?.on("error", (err) => {
					void finishError(err.message).then(() => resolve());
				});
			});

			options?.signal?.removeEventListener("abort", abort);

			if (!finished) {
				if (options?.signal?.aborted) {
					await finishError("aborted", true);
				} else if (stderr.trim()) {
					await finishError(stderr.trim());
				} else {
					await finishDone();
				}
			}
		} catch (err) {
			await finishError(
				err instanceof Error ? err.message : String(err),
				options?.signal?.aborted,
			);
		}
	});

	return stream;
}
