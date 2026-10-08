import { describe, expect, it } from "vitest";
import { PiContentEmitter } from "../src/grok/events.js";
import { buildFullPrompt, GROK_BRIDGE_NOTE } from "../src/grok/prompt.js";
import { ToolActivityTracker } from "../src/grok/tool-activity.js";

// Payloads captured from `grok agent stdio` 1.0.46 (trimmed).
const CWD = "/tmp/grokprobe";
const meta = (name: string, kind: string, label: string) => ({
	"x.ai/tool": { version: 1, name, kind, namespace: "grok_build", label, read_only: kind === "read" },
});
const EDIT_FLOW = [
	{ sessionUpdate: "tool_call", toolCallId: "r0", title: "read_file", rawInput: { target_file: `${CWD}/a.txt` }, _meta: meta("read_file", "read", "Read") },
	{ sessionUpdate: "tool_call_update", toolCallId: "r0", kind: "read", title: `Read \`${CWD}/a.txt\``, locations: [{ path: `${CWD}/a.txt` }] },
	{ sessionUpdate: "tool_call_update", toolCallId: "r0", status: "completed", content: [{ type: "content", content: { type: "text", text: "1→line one\n" } }] },
	{ sessionUpdate: "tool_call", toolCallId: "e1", title: "search_replace", rawInput: { file_path: `${CWD}/a.txt`, old_string: "line two", new_string: "line 2" }, _meta: meta("search_replace", "edit", "Edit") },
	{ sessionUpdate: "tool_call_update", toolCallId: "e1", kind: "edit", title: `Edit \`${CWD}/a.txt\``, content: [{ type: "diff", path: `${CWD}/a.txt`, oldText: "line two", newText: "line 2" }] },
	{ sessionUpdate: "tool_call_update", toolCallId: "e1", status: "completed", content: [{ type: "diff", path: `/private${CWD}/a.txt`, oldText: "line two", newText: "line 2" }] },
	{ sessionUpdate: "tool_call", toolCallId: "w2", title: "write", rawInput: { file_path: `${CWD}/b.txt`, content: "bee\nbuzz\n" }, _meta: meta("write", "write", "Write") },
	{ sessionUpdate: "tool_call_update", toolCallId: "w2", kind: "edit", title: `Write \`${CWD}/b.txt\``, content: [{ type: "diff", path: `${CWD}/b.txt`, oldText: "", newText: "bee\nbuzz\n" }] },
	{ sessionUpdate: "tool_call_update", toolCallId: "w2", status: "completed", content: [{ type: "diff", path: `${CWD}/b.txt`, oldText: "", newText: "bee\nbuzz\n" }] },
	{ sessionUpdate: "tool_call", toolCallId: "x3", title: "run_terminal_command", rawInput: { command: "npm test", description: "Run tests" }, _meta: meta("run_terminal_command", "execute", "Run Command") },
	{ sessionUpdate: "tool_call_update", toolCallId: "x3", kind: "execute", title: "Execute `npm test`", content: [{ type: "content", content: { type: "text", text: "Run tests" } }] },
	{ sessionUpdate: "tool_call_update", toolCallId: "x3", status: "in_progress", content: [{ type: "content", content: { type: "text", text: "" } }] },
	{ sessionUpdate: "tool_call_update", toolCallId: "x3", status: "failed", content: [{ type: "content", content: { type: "text", text: "Error: 1 test failed\nmore" } }] },
];

function render(updates: unknown[]): string[] {
	const tracker = new ToolActivityTracker(CWD);
	return updates.map((u) => tracker.handle(u as never)).filter((x): x is string => Boolean(x));
}

describe("grok tool activity", () => {
	it("renders Grok's own read/edit/write/run tools as visible lines", () => {
		expect(render(EDIT_FLOW)).toEqual([
			"- Read `a.txt`\n",
			"- Edit `a.txt` (+1 −1)\n",
			"- Write `b.txt` (+2 −0)\n",
			"- Run `npm test`\n",
			"  - ✗ Run `npm test` failed: Error: 1 test failed ⏎ more\n",
		]);
	});

	it("announces a tool once even without an enriched update", () => {
		expect(
			render([
				{ sessionUpdate: "tool_call", toolCallId: "g", title: "grep", rawInput: { pattern: "foo" }, _meta: meta("grep", "search", "Search") },
				{ sessionUpdate: "tool_call_update", toolCallId: "g", status: "completed" },
				{ sessionUpdate: "tool_call_update", toolCallId: "g", status: "completed" },
			]),
		).toEqual(["- Search `foo`\n"]);
	});

	it("shows the workspace root itself as `.`", () => {
		expect(
			render([
				{ sessionUpdate: "tool_call", toolCallId: "l", title: "list_dir", _meta: meta("list_dir", "read", "List") },
				{ sessionUpdate: "tool_call_update", toolCallId: "l", kind: "read", title: `List \`/private${CWD}\`` },
			]),
		).toEqual(["- List `.`\n"]);
	});

	it("ignores non-tool updates", () => {
		expect(render([{ sessionUpdate: "agent_message_chunk", content: { text: "hi" } }])).toEqual([]);
	});

	it("emits tool lines as answer text (never toolCall blocks) with list spacing", () => {
		const events: Array<{ type: string }> = [];
		const output = { role: "assistant", content: [], usage: { cost: {} }, stopReason: "stop" } as never as {
			content: Array<{ type: string; text?: string }>;
		};
		const stream = { push: (e: { type: string }) => events.push(e), end: () => undefined };
		const emitter = new PiContentEmitter(stream as never, output as never);
		emitter.appendText("Updating a.txt.");
		emitter.appendToolActivity("- Edit `a.txt` (+1 −1)\n");
		emitter.appendToolActivity("- Run `ls`\n");
		emitter.appendText("Done.");
		emitter.done();
		expect(output.content).toEqual([
			{ type: "text", text: "Updating a.txt.\n\n- Edit `a.txt` (+1 −1)\n- Run `ls`\n\nDone." },
		]);
		expect(output.content.some((b) => b.type === "toolCall")).toBe(false);
		expect(events.at(-1)?.type).toBe("done");
	});
});

describe("grok bridge note", () => {
	it("prefixes cold-start prompts so Grok acts with its own tools", () => {
		const prompt = buildFullPrompt({
			systemPrompt: "You are pi. Tools: read, bash, edit, write.",
			messages: [{ role: "user", content: "fix the bug", timestamp: 0 }],
		} as never);
		expect(prompt.startsWith(GROK_BRIDGE_NOTE)).toBe(true);
		expect(prompt).toContain("system:\nYou are pi.");
		expect(prompt).toContain("user:\nfix the bug");
	});

	it("can be disabled and leaves empty prompts empty", () => {
		process.env.PI_GROK_SDK_BRIDGE_NOTE = "0";
		try {
			const prompt = buildFullPrompt({ messages: [{ role: "user", content: "hi", timestamp: 0 }] } as never);
			expect(prompt).toBe("user:\nhi");
		} finally {
			delete process.env.PI_GROK_SDK_BRIDGE_NOTE;
		}
		expect(buildFullPrompt({ messages: [] } as never)).toBe("");
	});
});
