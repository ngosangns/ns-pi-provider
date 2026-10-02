// @ts-nocheck — vendored upstream; adapted under MIT (see NOTICE)
import { spawn, type ChildProcess } from "node:child_process";
import { createInterface, type Interface } from "node:readline";
import { CLIENT_NAME, CLIENT_VERSION } from "./config.js";
import type { AcpInitializeResult, AcpPromptResult, AcpSessionResult, ReasoningEffort } from "./types.js";

export interface JsonRpcMessage {
	jsonrpc?: "2.0";
	id?: string | number | null;
	method?: string;
	params?: unknown;
	result?: unknown;
	error?: { message?: string; code?: number; data?: unknown };
}

export type AcpNotificationHandler = (message: JsonRpcMessage) => void;

export interface AcpSpawnOptions {
	binary: string;
	modelId?: string;
	reasoningEffort?: ReasoningEffort;
	alwaysApprove?: boolean;
	cwd?: string;
	env?: NodeJS.ProcessEnv;
}

export function buildAcpArgs(options: {
	modelId?: string;
	reasoningEffort?: ReasoningEffort;
	alwaysApprove?: boolean;
}): string[] {
	const args = ["agent", "--no-leader"];
	if (options.alwaysApprove !== false) args.push("--always-approve");
	if (options.modelId) args.push("--model", options.modelId);
	if (options.reasoningEffort && options.reasoningEffort !== "none") {
		args.push("--reasoning-effort", options.reasoningEffort);
	}
	args.push("stdio");
	return args;
}

export class AcpJsonRpcClient {
	private nextId = 1;
	private readonly pending = new Map<
		number,
		{ resolve: (value: unknown) => void; reject: (err: Error) => void }
	>();
	private readonly notifications = new Set<AcpNotificationHandler>();
	private readonly rl: Interface;
	private closed = false;
	private stderr = "";

	constructor(private readonly proc: ChildProcess) {
		this.rl = createInterface({ input: proc.stdout!, crlfDelay: Infinity, terminal: false });
		this.rl.on("line", (line) => this.handleLine(line));
		proc.stderr?.setEncoding("utf8");
		proc.stderr?.on("data", (chunk: string) => {
			this.stderr += chunk;
			if (this.stderr.length > 32_000) this.stderr = this.stderr.slice(-16_000);
		});
		proc.on("error", (err) => this.rejectAll(err));
		proc.on("close", (code) => {
			this.closed = true;
			if (this.pending.size === 0) return;
			const detail = this.stderr.trim();
			this.rejectAll(
				new Error(
					detail
						? `Grok ACP subprocess exited (code ${code}): ${detail}`
						: `Grok ACP subprocess exited before responding (code ${code})`,
				),
			);
		});
	}

	getStderr(): string {
		return this.stderr;
	}

	onNotification(listener: AcpNotificationHandler): () => void {
		this.notifications.add(listener);
		return () => this.notifications.delete(listener);
	}

	request(method: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
		if (this.closed) {
			return Promise.reject(new Error("Grok ACP client is closed"));
		}
		if (signal?.aborted) {
			return Promise.reject(new Error("aborted"));
		}
		const id = this.nextId++;
		const payload = `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`;
		const promise = new Promise<unknown>((resolve, reject) => {
			const onAbort = () => {
				this.pending.delete(id);
				reject(new Error("aborted"));
			};
			if (signal) {
				signal.addEventListener("abort", onAbort, { once: true });
			}
			this.pending.set(id, {
				resolve: (value) => {
					signal?.removeEventListener("abort", onAbort);
					resolve(value);
				},
				reject: (err) => {
					signal?.removeEventListener("abort", onAbort);
					reject(err);
				},
			});
		});
		if (!this.proc.stdin?.writable) {
			this.pending.delete(id);
			return Promise.reject(new Error("Grok ACP stdin is not writable"));
		}
		this.proc.stdin.write(payload);
		return promise;
	}

	private handleLine(line: string): void {
		let message: JsonRpcMessage;
		try {
			message = JSON.parse(line) as JsonRpcMessage;
		} catch {
			return;
		}

		if (typeof message.id === "number" && this.pending.has(message.id)) {
			const pending = this.pending.get(message.id)!;
			this.pending.delete(message.id);
			if (message.error) {
				pending.reject(
					new Error(message.error.message ?? `ACP request failed: ${message.error.code}`),
				);
			} else {
				pending.resolve(message.result);
			}
			return;
		}

		for (const listener of this.notifications) {
			try {
				listener(message);
			} catch {
				// ignore listener errors
			}
		}
	}

	private rejectAll(err: Error): void {
		for (const pending of this.pending.values()) pending.reject(err);
		this.pending.clear();
	}

	dispose(): void {
		this.closed = true;
		this.rejectAll(new Error("Grok ACP client disposed"));
		try {
			this.rl.close();
		} catch {
			// ignore
		}
		if (this.proc.exitCode === null && this.proc.signalCode === null) {
			this.proc.kill("SIGTERM");
			setTimeout(() => {
				if (this.proc.exitCode === null && this.proc.signalCode === null) {
					this.proc.kill("SIGKILL");
				}
			}, 1500).unref?.();
		}
	}
}

function chooseAuthMethod(initializeResult: AcpInitializeResult): string {
	const ids = new Set(
		(initializeResult.authMethods ?? []).map((m) => m.id).filter((id): id is string => Boolean(id)),
	);
	if (ids.has("cached_token")) return "cached_token";
	if (process.env.XAI_API_KEY && ids.has("xai.api_key")) return "xai.api_key";
	if (ids.has("grok.com")) {
		throw new Error(
			"Grok ACP requires interactive login (grok.com). Run `agent` or `grok login` once in a terminal, then retry.",
		);
	}
	throw new Error(
		`Grok ACP authentication unavailable. Offered methods: ${[...ids].join(", ") || "none"}. Run \`agent\` to authenticate.`,
	);
}

export interface LiveAcpSession {
	client: AcpJsonRpcClient;
	proc: ChildProcess;
	sessionId: string;
	modelId: string;
	cwd: string;
	/** True once at least one successful prompt has completed. */
	bootstrapped: boolean;
	/** Fingerprint of history committed into the Grok session. */
	historyFingerprint: string;
	dispose(): void;
}

export async function createLiveAcpSession(
	options: AcpSpawnOptions & { signal?: AbortSignal },
): Promise<LiveAcpSession> {
	const args = buildAcpArgs({
		modelId: options.modelId,
		reasoningEffort: options.reasoningEffort,
		alwaysApprove: options.alwaysApprove,
	});
	const proc = spawn(options.binary, args, {
		stdio: ["pipe", "pipe", "pipe"],
		cwd: options.cwd ?? process.cwd(),
		env: options.env ?? process.env,
	});
	const client = new AcpJsonRpcClient(proc);

	const dispose = () => client.dispose();

	try {
		if (options.signal?.aborted) throw new Error("aborted");

		const initializeResult = (await client.request(
			"initialize",
			{
				protocolVersion: 1,
				clientCapabilities: {
					fs: { readTextFile: false, writeTextFile: false },
					terminal: false,
				},
				clientInfo: { name: CLIENT_NAME, version: CLIENT_VERSION },
			},
			options.signal,
		)) as AcpInitializeResult;

		const methodId = chooseAuthMethod(initializeResult);
		await client.request("authenticate", { methodId }, options.signal);

		const sessionResult = (await client.request(
			"session/new",
			{
				cwd: options.cwd ?? process.cwd(),
				mcpServers: [],
			},
			options.signal,
		)) as AcpSessionResult;

		if (!sessionResult.sessionId) {
			throw new Error("Grok ACP did not return a session id from session/new");
		}

		return {
			client,
			proc,
			sessionId: sessionResult.sessionId,
			modelId: options.modelId ?? "unknown",
			cwd: options.cwd ?? process.cwd(),
			bootstrapped: false,
			historyFingerprint: "",
			dispose,
		};
	} catch (err) {
		dispose();
		throw err;
	}
}

export async function promptAcpSession(
	session: LiveAcpSession,
	prompt: string,
	options: {
		signal?: AbortSignal;
		onUpdate?: (update: {
			sessionUpdate?: string;
			content?: { text?: string; type?: string };
			title?: string;
			kind?: string;
			status?: string;
		}) => void;
	} = {},
): Promise<AcpPromptResult> {
	const unsub = session.client.onNotification((message) => {
		if (message.method !== "session/update") return;
		const params = message.params as { update?: Record<string, unknown> } | undefined;
		const update = params?.update;
		if (!update) return;
		options.onUpdate?.(update as Parameters<NonNullable<typeof options.onUpdate>>[0]);
	});

	try {
		const result = (await session.client.request(
			"session/prompt",
			{
				sessionId: session.sessionId,
				prompt: [{ type: "text", text: prompt }],
			},
			options.signal,
		)) as AcpPromptResult;
		return result;
	} finally {
		unsub();
	}
}
