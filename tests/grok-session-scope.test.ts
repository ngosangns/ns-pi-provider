import { describe, expect, it, vi } from "vitest";

vi.mock("../src/grok/session-agent.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/grok/session-agent.js")>();
	return {
		...actual,
		disposeSessionAgentsForScope: vi.fn(),
		disposeAllSessionAgents: vi.fn(),
	};
});

vi.mock("../src/grok/binary.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/grok/binary.js")>();
	return {
		...actual,
		resolveGrokBinary: () => {
			throw new Error("grok binary not available in tests");
		},
	};
});

import { registerGrokProvider } from "../src/grok/register.js";
import { disposeAllSessionAgents, disposeSessionAgentsForScope } from "../src/grok/session-agent.js";
import { scopeKeyFromCtx } from "../src/grok/session-scope.js";

function mockPi() {
	const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
	return {
		handlers,
		api: {
			registerProvider: vi.fn(),
			unregisterProvider: vi.fn(),
			registerCommand: vi.fn(),
			on: vi.fn((event: string, fn: (event: unknown, ctx: unknown) => unknown) => {
				handlers.set(event, [...(handlers.get(event) ?? []), fn]);
			}),
			events: { on: vi.fn(), emit: vi.fn() },
		},
	};
}

function ctxFor(sessionFile?: string, sessionId?: string) {
	return {
		cwd: "/tmp",
		sessionManager: {
			getSessionFile: () => sessionFile,
			getSessionId: () => sessionId,
		},
	};
}

describe("grok session scope (pi-grok-sdk 45fde95)", () => {
	it("derives the pool key from the handler context", () => {
		expect(scopeKeyFromCtx(ctxFor("/s/a.jsonl", "id-a"))).toBe("/s/a.jsonl");
		expect(scopeKeyFromCtx(ctxFor(undefined, "id-b"))).toBe("__ephemeral__:id-b");
		expect(scopeKeyFromCtx({})).toBe("__anonymous__");
	});

	it("session_shutdown disposes only the shutting-down session's agents", async () => {
		const { api, handlers } = mockPi();
		registerGrokProvider(api as never);
		const shutdown = handlers.get("session_shutdown") ?? [];
		expect(shutdown).toHaveLength(1);

		await shutdown[0]!({ type: "session_shutdown", reason: "new" }, ctxFor("/s/a.jsonl", "id-a"));
		expect(disposeSessionAgentsForScope).toHaveBeenCalledWith("/s/a.jsonl");
		expect(disposeAllSessionAgents).not.toHaveBeenCalled();
	});

	it("session_start for another session no longer disposes the previous scope", async () => {
		vi.mocked(disposeSessionAgentsForScope).mockClear();
		const { api, handlers } = mockPi();
		registerGrokProvider(api as never);
		for (const fn of handlers.get("session_start") ?? []) await fn({ type: "session_start" }, ctxFor("/s/a.jsonl"));
		for (const fn of handlers.get("session_start") ?? []) await fn({ type: "session_start" }, ctxFor("/s/b.jsonl"));
		expect(disposeSessionAgentsForScope).not.toHaveBeenCalled();
	});

	it("installs a single process exit hook across registrations", () => {
		const before = process.listenerCount("exit");
		registerGrokProvider(mockPi().api as never);
		registerGrokProvider(mockPi().api as never);
		expect(process.listenerCount("exit")).toBe(before);
	});
});
