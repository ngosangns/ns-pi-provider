// @ts-nocheck — vendored upstream; adapted under MIT (see NOTICE)
import type { ExtensionHandler, SessionInfoChangedEvent, SessionStartEvent } from "@earendil-works/pi-coding-agent";

/** Minimal context shape used by session_start / session_info_changed handlers. */
interface SessionCtx {
	cwd: string;
	sessionManager?: {
		getSessionFile?: () => string | undefined | null;
		getSessionId?: () => string | undefined | null;
		getSessionName?: () => string | undefined | null;
	};
	isProjectTrusted?: () => boolean;
}

interface SessionScopeApi {
	on(
		event: "session_start",
		handler: ExtensionHandler<SessionStartEvent, void, SessionCtx>,
	): void;
	on(
		event: "session_info_changed",
		handler: ExtensionHandler<SessionInfoChangedEvent, void, SessionCtx>,
	): void;
	on(event: "session_shutdown", handler: ExtensionHandler): void;
}

const ANONYMOUS_SCOPE = "__anonymous__";
const EPHEMERAL_PREFIX = "__ephemeral__:";

const state = {
	cwd: process.cwd(),
	sessionFile: undefined as string | undefined,
	sessionId: undefined as string | undefined,
	generation: 0,
};

let nextGeneration = 1;
const scopeGenerations = new Map<string, number>([[ANONYMOUS_SCOPE, 0]]);

export function getSessionCwd(): string {
	return state.cwd;
}

export function getSessionScopeKey(): string {
	return scopeKeyFrom(state.sessionFile, state.sessionId);
}

/** Derive pool key from session file / id (no global mutation). */
export function scopeKeyFrom(
	sessionFile?: string | null,
	sessionId?: string | null,
): string {
	if (sessionFile) return sessionFile;
	if (sessionId) return `${EPHEMERAL_PREFIX}${sessionId}`;
	return ANONYMOUS_SCOPE;
}

/** Scope key from an extension handler context (session_start / session_shutdown). */
export function scopeKeyFromCtx(ctx: {
	sessionManager?: {
		getSessionFile?: () => string | undefined | null;
		getSessionId?: () => string | undefined | null;
	};
}): string {
	return scopeKeyFrom(
		ctx.sessionManager?.getSessionFile?.() ?? undefined,
		ctx.sessionManager?.getSessionId?.() ?? undefined,
	);
}

export function getSessionScopeGeneration(scopeKey: string = getSessionScopeKey()): number {
	return scopeGenerations.get(scopeKey) ?? 0;
}

function setScope(cwd: string, sessionFile?: string, sessionId?: string): void {
	state.cwd = cwd;
	state.sessionFile = sessionFile;
	state.sessionId = sessionId;
	state.generation = nextGeneration++;
	scopeGenerations.set(getSessionScopeKey(), state.generation);
}

export function registerSessionScope(pi: SessionScopeApi): void {
	// Point process-global cwd/scope at this runner's session. Does NOT dispose
	// other scopes — multi-session hosts (pi-gui) keep one ACP pool entry per
	// session file; only session_shutdown tears that entry down.
	pi.on("session_start", async (_event, ctx) => {
		setScope(
			ctx.cwd,
			ctx.sessionManager?.getSessionFile?.() ?? undefined,
			ctx.sessionManager?.getSessionId?.() ?? undefined,
		);
	});

	// session_info_changed only updates name in current pi; keep handler for future fields.
	pi.on("session_info_changed", async () => {
		// no-op for cwd/file; name not needed for agent pooling
	});
}

/** Test helper */
export function resetSessionScopeForTests(): void {
	state.cwd = process.cwd();
	state.sessionFile = undefined;
	state.sessionId = undefined;
	state.generation = 0;
	nextGeneration = 1;
	scopeGenerations.clear();
	scopeGenerations.set(ANONYMOUS_SCOPE, 0);
}
