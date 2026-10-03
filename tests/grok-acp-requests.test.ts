import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { AcpJsonRpcClient } from "../src/grok/acp-client.js";

function fakeProc() {
	const proc = new EventEmitter() as never as {
		stdout: PassThrough;
		stderr: PassThrough;
		stdin: PassThrough;
		exitCode: number | null;
		signalCode: string | null;
		kill(): void;
		on: (ev: string, fn: (...args: unknown[]) => void) => unknown;
	} & EventEmitter;
	proc.stdout = new PassThrough();
	proc.stderr = new PassThrough();
	proc.stdin = new PassThrough();
	proc.exitCode = null;
	proc.signalCode = null;
	proc.kill = () => undefined;
	return proc;
}

function written(proc: { stdin: PassThrough }): Promise<Record<string, unknown>> {
	return new Promise((resolve) => {
		proc.stdin.once("data", (chunk) => resolve(JSON.parse(String(chunk)) as Record<string, unknown>));
	});
}

describe("grok ACP agent→client requests", () => {
	it("answers _x.ai/ask_user_question with a cancellation instead of hanging", async () => {
		const proc = fakeProc();
		const client = new AcpJsonRpcClient(proc as never);
		const response = written(proc);
		proc.stdout.write(
			`${JSON.stringify({ jsonrpc: "2.0", id: 0, method: "_x.ai/ask_user_question", params: { questions: [] } })}\n`,
		);
		const msg = await response;
		expect(msg.id).toBe(0);
		expect(msg.result).toEqual({ cancelled: true });
		client.dispose();
	});

	it("auto-approves session/request_permission with an allow option", async () => {
		const proc = fakeProc();
		const client = new AcpJsonRpcClient(proc as never);
		const response = written(proc);
		proc.stdout.write(
			`${JSON.stringify({ jsonrpc: "2.0", id: 7, method: "session/request_permission", params: { options: [{ optionId: "deny1", kind: "reject_once" }, { optionId: "ok1", kind: "allow_once" }] } })}\n`,
		);
		const msg = await response;
		expect(msg.id).toBe(7);
		expect(msg.result).toEqual({ outcome: { outcome: "selected", optionId: "ok1" } });
		client.dispose();
	});

	it("replies method-not-found to unknown agent requests", async () => {
		const proc = fakeProc();
		const client = new AcpJsonRpcClient(proc as never);
		const response = written(proc);
		proc.stdout.write(
			`${JSON.stringify({ jsonrpc: "2.0", id: 3, method: "fs/read_text_file", params: {} })}\n`,
		);
		const msg = await response;
		expect(msg.id).toBe(3);
		expect((msg.error as { code: number }).code).toBe(-32601);
		client.dispose();
	});

	it("still resolves client→server responses by id", async () => {
		const proc = fakeProc();
		const client = new AcpJsonRpcClient(proc as never);
		const pending = client.request("session/new", { cwd: "/tmp" });
		proc.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, result: { sessionId: "s1" } })}\n`);
		await expect(pending).resolves.toEqual({ sessionId: "s1" });
		client.dispose();
	});
});
