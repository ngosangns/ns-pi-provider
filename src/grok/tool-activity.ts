/**
 * Surface the Grok agent's own tool activity in the host transcript.
 *
 * The Grok CLI is a full coding agent: in ACP mode it reads, edits, writes and
 * runs commands itself (`read_file`, `search_replace`, `write`,
 * `run_terminal_command`, …) and only reports them through `session/update`
 * `tool_call` / `tool_call_update` notifications. Pi / OMP never execute those
 * tools, so they must not become `toolCall` content blocks (the host agent loop
 * would try to run them). Instead each tool is rendered as one short Markdown
 * list line in the visible answer text, so edits and commands are visible
 * instead of the turn looking like read-only reasoning.
 */

export interface AcpToolUpdate {
	sessionUpdate?: string;
	toolCallId?: string;
	title?: string;
	kind?: string;
	status?: string;
	rawInput?: Record<string, unknown>;
	content?: unknown;
	locations?: Array<{ path?: string }>;
	_meta?: Record<string, unknown>;
}

interface ToolEntry {
	name?: string;
	label?: string;
	kind?: string;
	title?: string;
	rawInput?: Record<string, unknown>;
	stat?: string;
	announced: boolean;
	finished: boolean;
}

const MAX_LABEL = 160;

function toolMeta(update: AcpToolUpdate): { name?: string; kind?: string; label?: string } {
	const meta = update._meta?.["x.ai/tool"];
	if (!meta || typeof meta !== "object") return {};
	const m = meta as Record<string, unknown>;
	return {
		name: typeof m.name === "string" ? m.name : undefined,
		kind: typeof m.kind === "string" ? m.kind : undefined,
		label: typeof m.label === "string" ? m.label : undefined,
	};
}

function oneLine(text: string, max = MAX_LABEL): string {
	const flat = text.replace(/\s*\n\s*/g, " ⏎ ").replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function countLines(text: unknown): number {
	if (typeof text !== "string" || text.length === 0) return 0;
	const body = text.endsWith("\n") ? text.slice(0, -1) : text;
	return body.split("\n").length;
}

/** `+added −removed` over ACP `diff` content items, or "" when none. */
export function diffStat(content: unknown): string {
	if (!Array.isArray(content)) return "";
	let added = 0;
	let removed = 0;
	let seen = false;
	for (const item of content) {
		if (!item || typeof item !== "object") continue;
		const c = item as Record<string, unknown>;
		if (c.type !== "diff") continue;
		seen = true;
		added += countLines(c.newText);
		removed += countLines(c.oldText);
	}
	return seen ? `+${added} −${removed}` : "";
}

function firstText(content: unknown): string {
	if (!Array.isArray(content)) return "";
	for (const item of content) {
		if (!item || typeof item !== "object") continue;
		const c = item as Record<string, unknown>;
		const inner = c.content as Record<string, unknown> | undefined;
		if (c.type === "content" && inner && typeof inner.text === "string" && inner.text.trim()) {
			return inner.text;
		}
	}
	return "";
}

export class ToolActivityTracker {
	private readonly tools = new Map<string, ToolEntry>();

	constructor(private readonly cwd?: string) {}

	private relativize(text: string): string {
		const cwd = this.cwd?.replace(/\/+$/, "");
		if (!cwd || cwd === "/") return text;
		let out = text;
		const roots = new Set([cwd, cwd.replace(/^\/private\//, "/")]);
		for (const root of [...roots]) roots.add(`/private${root}`);
		// Longest first so "/private/tmp/x" wins over "/tmp/x".
		for (const root of [...roots].sort((a, b) => b.length - a.length)) {
			out = out.split(`${root}/`).join("");
			out = out.split(`\`${root}\``).join("`.`");
		}
		return out;
	}

	private describe(entry: ToolEntry): string {
		const input = entry.rawInput ?? {};
		let label: string;
		if (entry.kind === "execute" && typeof input.command === "string") {
			label = `Run \`${oneLine(String(input.command), MAX_LABEL - 8)}\``;
		} else if (entry.title && entry.title !== entry.name) {
			label = oneLine(entry.title);
		} else {
			const verb = entry.label ?? entry.name ?? "Tool";
			const target =
				(typeof input.file_path === "string" && input.file_path) ||
				(typeof input.target_file === "string" && input.target_file) ||
				(typeof input.path === "string" && input.path) ||
				(typeof input.pattern === "string" && input.pattern) ||
				(typeof input.query === "string" && input.query) ||
				"";
			label = target ? `${verb} \`${oneLine(String(target), MAX_LABEL - 8)}\`` : verb;
		}
		return this.relativize(label);
	}

	/**
	 * Feed one ACP `session/update`. Returns Markdown line(s) to show (each
	 * ending in "\n"), or undefined when nothing new is visible yet.
	 */
	handle(update: AcpToolUpdate): string | undefined {
		const kind = update.sessionUpdate;
		if (kind !== "tool_call" && kind !== "tool_call_update") return undefined;
		const id = update.toolCallId;
		if (!id) return undefined;

		let entry = this.tools.get(id);
		if (!entry) {
			entry = { announced: false, finished: false };
			this.tools.set(id, entry);
		}
		const meta = toolMeta(update);
		entry.name ??= meta.name ?? (kind === "tool_call" ? update.title : undefined);
		entry.label ??= meta.label;
		if (meta.kind) entry.kind = meta.kind === "write" ? "edit" : meta.kind;
		if (update.kind) entry.kind = update.kind;
		if (update.rawInput && typeof update.rawInput === "object") {
			entry.rawInput = { ...(entry.rawInput ?? {}), ...update.rawInput };
		}
		if (update.title) entry.title = update.title;
		if (entry.finished) return undefined;

		const lines: string[] = [];
		const status = update.status;
		const done = status === "completed" || status === "failed";
		const stat = diffStat(update.content);
		if (stat) entry.stat = stat;
		const isEdit = entry.kind === "edit" || entry.kind === "delete" || entry.kind === "move";
		// Wait for the enriched update (title like "Execute `cmd`") before showing.
		// Edits are quick and their diff is only final on completion, so they are
		// shown once done, with `+added −removed`.
		const enriched = kind === "tool_call_update" && Boolean(update.title || update.kind);
		const ready = isEdit ? done : enriched || done || status === "in_progress";

		if (!entry.announced && ready) {
			entry.announced = true;
			lines.push(`- ${this.describe(entry)}${isEdit && entry.stat ? ` (${entry.stat})` : ""}`);
			if (done) {
				entry.finished = true;
				if (status === "failed") lines.push(`  - ✗ failed${this.failureDetail(update)}`);
			}
		} else if (entry.announced && done) {
			entry.finished = true;
			if (status === "failed") {
				lines.push(`  - ✗ ${this.describe(entry)} failed${this.failureDetail(update)}`);
			}
		}
		return lines.length ? `${lines.join("\n")}\n` : undefined;
	}

	private failureDetail(update: AcpToolUpdate): string {
		const text = firstText(update.content);
		return text ? `: ${this.relativize(oneLine(text, 200))}` : "";
	}
}
