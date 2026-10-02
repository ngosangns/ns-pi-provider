// @ts-nocheck — vendored upstream; adapted under MIT (see NOTICE)
import { accessSync, constants } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

const CANDIDATE_NAMES = ["agent", "grok"] as const;

function isExecutable(path: string): boolean {
	try {
		accessSync(path, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

function which(name: string): string | undefined {
	try {
		const out = execFileSync(process.platform === "win32" ? "where" : "which", [name], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
			timeout: 5_000,
		}).trim();
		const first = out.split(/\r?\n/).map((l) => l.trim()).find(Boolean);
		return first && isExecutable(first) ? first : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Resolve the local Grok agent CLI binary.
 *
 * Order:
 * 1. `PI_GROK_SDK_BIN` / `PI_GROK_AGENT_BIN` / `GROK_AGENT_BIN` / `GROK_BIN`
 * 2. `agent` then `grok` on PATH
 * 3. `~/.grok/bin/{agent,grok}` (standard install location)
 */
export function resolveGrokBinary(env: NodeJS.ProcessEnv = process.env): string {
	const explicit =
		env.PI_GROK_SDK_BIN?.trim() ||
		env.PI_GROK_AGENT_BIN?.trim() ||
		env.GROK_AGENT_BIN?.trim() ||
		env.GROK_BIN?.trim();
	if (explicit) {
		if (!isExecutable(explicit)) {
			throw new Error(
				`Configured Grok agent binary is not executable: ${explicit}. Check PI_GROK_SDK_BIN / PI_GROK_AGENT_BIN / GROK_AGENT_BIN.`,
			);
		}
		return explicit;
	}

	for (const name of CANDIDATE_NAMES) {
		const found = which(name);
		if (found) return found;
	}

	const homeBin = join(homedir(), ".grok", "bin");
	for (const name of CANDIDATE_NAMES) {
		const candidate = join(homeBin, name);
		if (isExecutable(candidate)) return candidate;
	}

	throw new Error(
		"Grok agent CLI not found. Install/authenticate the xAI Grok agent (`agent` or `grok` on PATH, or ~/.grok/bin). Then run: agent --version",
	);
}

export function getGrokVersion(binary?: string): string {
	try {
		const bin = binary ?? resolveGrokBinary();
		return execFileSync(bin, ["--version"], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
			timeout: 8_000,
		}).trim();
	} catch {
		return "unknown";
	}
}

export function probeGrokAuth(binary?: string): boolean {
	try {
		const bin = binary ?? resolveGrokBinary();
		const stdout = execFileSync(bin, ["models"], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
			timeout: 20_000,
		});
		return !/not authenticated/i.test(stdout);
	} catch {
		return false;
	}
}
