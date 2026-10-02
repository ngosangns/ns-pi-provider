// @ts-nocheck — vendored upstream; adapted under MIT (see NOTICE)
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Api, Model, OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai";
import { loginDevin } from "./oauth.ts";
import { streamDevin } from "./stream.ts";
import { discoverDevinModels } from "./discovery.ts";
import { fetchDevinQuota, formatDevinQuota } from "./quota.ts";

const PROVIDER = "devin";
const API = "devin-cloud";
const BASE_URL = "https://server.codeium.com";

const models: Model<Api>[] = [
	{
		id: "swe-1-7",
		name: "SWE-1.7",
		api: API,
		provider: PROVIDER,
		baseUrl: BASE_URL,
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 64_000,
	},
	{
		id: "swe-1-6",
		name: "SWE-1.6",
		api: API,
		provider: PROVIDER,
		baseUrl: BASE_URL,
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 64_000,
	},
];

function providerConfig(currentModels: Model<Api>[]) {
	return {
		name: "Devin",
		api: API,
		baseUrl: BASE_URL,
		models: currentModels,
		async refreshModels({ credential, signal, allowNetwork }: { credential?: { type: string; access?: string }; signal: AbortSignal; allowNetwork: boolean }) {
			if (!allowNetwork || credential?.type !== "oauth" || !credential.access) return currentModels;
			try {
				const discovered = await discoverDevinModels(credential.access, signal);
				return discovered.length ? discovered : currentModels;
			} catch {
				return currentModels;
			}
		},
		oauth: {
			name: "Devin OAuth",
			async login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
				return loginDevin(callbacks);
			},
			async refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
				return credentials;
			},
			getApiKey(credentials: OAuthCredentials): string {
				return credentials.access;
			},
		},
		streamSimple: streamDevin,
	};
}

export default function (pi: ExtensionAPI): void {
	pi.registerProvider(PROVIDER, providerConfig(models));
	pi.on("session_start", async (_event, ctx) => {
		const apiKey = await ctx.modelRegistry.getApiKeyForProvider(PROVIDER);
		if (!apiKey) return;
		try {
			const discovered = await discoverDevinModels(apiKey);
			if (discovered.length) pi.registerProvider(PROVIDER, providerConfig(discovered));
		} catch {
			// Keep the static fallback when offline or the service is unavailable.
		}
	});

	pi.registerCommand("devin-status", {
		description: "Show Devin authentication status and quota",
		handler: async (_args, ctx) => {
			const key = await ctx.modelRegistry.getApiKeyForProvider(PROVIDER);
			if (!key) return ctx.ui.notify("Devin: not signed in. Run /login devin", "warning");
			try {
				ctx.ui.notify(formatDevinQuota(await fetchDevinQuota(key)), "info");
			} catch {
				ctx.ui.notify("Devin: authenticated\nQuota: unavailable. Try again later.", "warning");
			}
		},
	});
}
