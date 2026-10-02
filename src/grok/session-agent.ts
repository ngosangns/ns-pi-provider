// @ts-nocheck — vendored upstream; adapted under MIT (see NOTICE)
/**
 * Persistent Grok ACP agent pool, scoped to a pi session.
 *
 * Keep one long-lived `agent agent stdio` process per
 * (pi session, model, cwd, effort) so multi-turn conversations reuse Grok's
 * own history instead of replaying the full transcript every turn.
 */

import { resolveGrokBinary } from "./binary.js";
import {
	createLiveAcpSession,
	promptAcpSession,
	type LiveAcpSession,
} from "./acp-client.js";
import { getSessionCwd, getSessionScopeKey } from "./session-scope.js";
import type { ReasoningEffort } from "./types.js";

export interface SessionAgentKeyParts {
	scopeKey: string;
	modelId: string;
	cwd: string;
	reasoningEffort?: ReasoningEffort;
	binary: string;
}

function poolKey(parts: SessionAgentKeyParts): string {
	return [
		parts.scopeKey,
		parts.modelId,
		parts.cwd,
		parts.reasoningEffort ?? "",
		parts.binary,
	].join("\0");
}

interface QueueItem {
	run: (session: LiveAcpSession) => Promise<void>;
	reject: (err: unknown) => void;
}

interface PoolEntry {
	key: string;
	scopeKey: string;
	session: LiveAcpSession;
	busy: boolean;
	queue: QueueItem[];
}

const pool = new Map<string, PoolEntry>();

function disposeEntry(entry: PoolEntry): void {
	try {
		entry.session.dispose();
	} catch {
		// ignore
	}
	for (const item of entry.queue) {
		item.reject(new Error("Grok ACP session was disposed"));
	}
	entry.queue.length = 0;
}

export function disposeSessionAgentsForScope(scopeKey: string): void {
	for (const [key, entry] of pool) {
		if (entry.scopeKey === scopeKey) {
			disposeEntry(entry);
			pool.delete(key);
		}
	}
}

export function disposeAllSessionAgents(): void {
	for (const entry of pool.values()) disposeEntry(entry);
	pool.clear();
}

async function drain(entry: PoolEntry): Promise<void> {
	if (entry.busy) return;
	entry.busy = true;
	try {
		while (entry.queue.length > 0) {
			const item = entry.queue.shift()!;
			try {
				await item.run(entry.session);
			} catch (err) {
				item.reject(err);
			}
		}
	} finally {
		entry.busy = false;
		if (entry.queue.length > 0) void drain(entry);
	}
}

export interface WithSessionAgentParams {
	modelId: string;
	reasoningEffort?: ReasoningEffort;
	cwd?: string;
	signal?: AbortSignal;
	/** When true, always create a fresh ACP process (ignore pool). */
	forceNew?: boolean;
}

/**
 * Run work exclusively on the pooled ACP session for the current pi scope.
 * Creates the session on first use.
 */
export async function withSessionAgent<T>(
	params: WithSessionAgentParams,
	fn: (session: LiveAcpSession, meta: { created: boolean }) => Promise<T>,
): Promise<T> {
	const binary = resolveGrokBinary();
	const scopeKey = getSessionScopeKey();
	const cwd = params.cwd ?? getSessionCwd();
	const key = poolKey({
		scopeKey,
		modelId: params.modelId,
		cwd,
		reasoningEffort: params.reasoningEffort,
		binary,
	});

	let entry = params.forceNew ? undefined : pool.get(key);

	if (entry && (entry.session.proc.exitCode !== null || entry.session.proc.signalCode !== null)) {
		disposeEntry(entry);
		pool.delete(key);
		entry = undefined;
	}

	let created = false;
	if (!entry) {
		// Replace any other agents for this pi session (model/cwd/effort change).
		disposeSessionAgentsForScope(scopeKey);
		const session = await createLiveAcpSession({
			binary,
			modelId: params.modelId,
			reasoningEffort: params.reasoningEffort,
			alwaysApprove: true,
			cwd,
			signal: params.signal,
		});
		entry = { key, scopeKey, session, busy: false, queue: [] };
		pool.set(key, entry);
		created = true;
	}

	const leaseEntry = entry;
	const createdFlag = created;

	return new Promise<T>((resolve, reject) => {
		leaseEntry.queue.push({
			run: async (session) => {
				try {
					const result = await fn(session, { created: createdFlag });
					resolve(result);
				} catch (err) {
					reject(err);
				}
			},
			reject,
		});
		void drain(leaseEntry);
	});
}

export { promptAcpSession };
