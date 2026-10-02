// @ts-nocheck — vendored upstream; adapted under MIT (see NOTICE)
import type { ExtensionAPI, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { getGrokVersion, probeGrokAuth, resolveGrokBinary } from "./binary.js";
import {
	API,
	CLIENT_NAME,
	CLIENT_VERSION,
	LEGACY_PROVIDER,
	PROVIDER,
	resolveIntegrationMode,
} from "./config.js";
import { discoverModels, toProviderModels } from "./models.js";
import { streamGrokAgent } from "./provider.js";
import {
	onSessionScopeKeyChange,
	registerSessionScope,
} from "./session-scope.js";
import { disposeAllSessionAgents, disposeSessionAgentsForScope } from "./session-agent.js";
import type { GrokModelDescriptor } from "./types.js";

function createProviderConfig(models: ProviderModelConfig[]) {
	return {
		name: "Grok SDK",
		baseUrl: "grok-sdk://local",
		apiKey: "grok-sdk",
		api: API,
		models,
		streamSimple: streamGrokAgent,
	};
}

function registerProviders(pi: Pick<ExtensionAPI, "registerProvider">, models: ProviderModelConfig[]): void {
	const config = createProviderConfig(models);
	pi.registerProvider(PROVIDER, config);
	// Legacy provider id so old settings / model strings keep working.
	pi.registerProvider(LEGACY_PROVIDER, {
		...config,
		name: "Grok SDK (legacy id)",
		apiKey: LEGACY_PROVIDER,
	});
}

export default function (pi: ExtensionAPI) {
	// Session scope first — other handlers may depend on cwd/scope key.
	registerSessionScope(pi);

	onSessionScopeKeyChange((previousKey) => {
		disposeSessionAgentsForScope(previousKey);
	});

	pi.on("session_shutdown", async () => {
		disposeAllSessionAgents();
	});

	// Clean up agent subprocesses if the pi process exits.
	const cleanup = () => {
		try {
			disposeAllSessionAgents();
		} catch {
			// ignore
		}
	};
	process.once("exit", cleanup);

	let binary: string | undefined;
	let binaryError: string | undefined;
	try {
		binary = resolveGrokBinary();
	} catch (err) {
		binaryError = err instanceof Error ? err.message : String(err);
	}

	let modelSource: "live" | "fallback" = "fallback";
	let descriptors: GrokModelDescriptor[] = [];
	const discovered = discoverModels(binary);
	descriptors = discovered.models;
	modelSource = discovered.source;
	let models = toProviderModels(descriptors);
	registerProviders(pi, models);

	const commandHandler = async (
		args: string,
		ctx: {
			hasUI: boolean;
			ui: { notify: (msg: string, level: "info" | "warning" | "error") => void };
		},
	) => {
		const action = (args.trim().split(/\s+/)[0] || "status").toLowerCase();
		const notify = (msg: string, level: "info" | "warning" | "error" = "info") => {
			if (ctx.hasUI) ctx.ui.notify(msg, level);
		};

		if (action === "status") {
			let mode: string;
			try {
				mode = resolveIntegrationMode();
			} catch (err) {
				mode = err instanceof Error ? err.message : String(err);
			}
			const version = binary ? getGrokVersion(binary) : "unknown";
			const authed = binary ? probeGrokAuth(binary) : false;
			notify(
				[
					`${CLIENT_NAME} v${CLIENT_VERSION}`,
					`provider: ${PROVIDER} (legacy: ${LEGACY_PROVIDER})`,
					`binary: ${binary ?? "(missing)"}`,
					`version: ${version}`,
					`auth: ${authed ? "ok" : "missing/unknown"}`,
					`mode: ${mode}`,
					`models: ${models.length} (${modelSource})`,
					binaryError ? `binary error: ${binaryError}` : "",
				]
					.filter(Boolean)
					.join("\n"),
				binary && authed ? "info" : "warning",
			);
			return;
		}

		if (action === "models") {
			const live = discoverModels(binary);
			const list = live.models.map((m) => `• ${m.id}`).join("\n") || "(none)";
			notify(`Grok models (${live.source}):\n${list}`);
			return;
		}

		if (action === "mode") {
			try {
				notify(
					`Integration mode: ${resolveIntegrationMode()}\nSet PI_GROK_SDK_MODE=acp|jsonl (acp is default: long-lived Grok agent session).\nAliases: PI_GROK_AGENT_MODE, PI_GROK_AGENT_CLI_MODE.`,
				);
			} catch (err) {
				notify(err instanceof Error ? err.message : String(err), "error");
			}
			return;
		}

		if (action === "refresh-models" || action === "refresh") {
			try {
				binary = resolveGrokBinary();
				binaryError = undefined;
			} catch (err) {
				binaryError = err instanceof Error ? err.message : String(err);
				notify(binaryError, "error");
				return;
			}
			const live = discoverModels(binary);
			descriptors = live.models;
			modelSource = live.source;
			models = toProviderModels(descriptors);
			registerProviders(pi, models);
			notify(
				`Refreshed ${models.length} model(s) from ${modelSource} catalog.`,
				modelSource === "live" ? "info" : "warning",
			);
			return;
		}

		notify(
			`Unknown action "${action}". Try: status, models, mode, refresh-models`,
			"warning",
		);
	};

	pi.registerCommand("grok-sdk", {
		description: "Grok SDK: /grok-sdk status | models | mode | refresh-models",
		handler: commandHandler,
	});
	// Back-compat command name
	pi.registerCommand("grok-agent", {
		description: "Alias for /grok-sdk",
		handler: commandHandler,
	});
}

export {
	PROVIDER,
	API,
	LEGACY_PROVIDER,
	resolveIntegrationMode,
	streamGrokAgent,
	discoverModels,
	resolveGrokBinary,
};
