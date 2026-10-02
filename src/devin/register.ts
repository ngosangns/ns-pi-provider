/**
 * Devin provider registration for Pi.
 * Auth: OAuth (loginDevin) + optional credentials.toml / Pi auth.json.
 * Models: GetCliModelConfigs discovery with TTL disk cache + static fallback.
 * Streaming: adapted from fadlee/pi-devin-provider (MIT).
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Api, Model, OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai";

import { ensureCacheCost, getDefaultCatalogCache, type CatalogModel } from "../shared/index.js";
import { loginDevin } from "./oauth.js";
import { streamDevin } from "./stream.js";
import { discoverDevinModels } from "./discovery.js";
import { fetchDevinQuota, formatDevinQuota } from "./quota.js";

export const DEVIN_PROVIDER_ID = "devin";
const API = "devin-cloud";
const BASE_URL = "https://server.codeium.com";

const FALLBACK_MODELS: Model<Api>[] = [
  {
    id: "swe-1-7",
    name: "SWE-1.7",
    api: API,
    provider: DEVIN_PROVIDER_ID,
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
    provider: DEVIN_PROVIDER_ID,
    baseUrl: BASE_URL,
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 64_000,
  },
];

function toCatalog(models: Model<Api>[]): CatalogModel[] {
  return models.map((m) => ({
    id: m.id,
    name: m.name,
    api: m.api,
    provider: DEVIN_PROVIDER_ID,
    baseUrl: m.baseUrl,
    reasoning: m.reasoning,
    input: m.input as Array<"text" | "image">,
    cost: ensureCacheCost(m.cost),
    contextWindow: m.contextWindow,
    maxTokens: m.maxTokens,
  }));
}

function fromCatalog(models: CatalogModel[]): Model<Api>[] {
  return models.map((m) => ({
    id: m.id,
    name: m.name,
    api: (m.api || API) as Api,
    provider: DEVIN_PROVIDER_ID,
    baseUrl: m.baseUrl ?? BASE_URL,
    reasoning: m.reasoning ?? true,
    input: m.input ?? ["text"],
    cost: ensureCacheCost(m.cost),
    contextWindow: m.contextWindow,
    maxTokens: m.maxTokens,
  }));
}

/** Resolve a Devin session token without logging secrets. */
export function resolveDevinToken(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const fromEnv = env.DEVIN_API_KEY?.trim() || env.DEVIN_SESSION_TOKEN?.trim();
  if (fromEnv) return fromEnv;

  const paths = [
    join(homedir(), ".local", "share", "devin", "credentials.toml"),
    join("/workspace/.provider-creds/devin", "credentials.toml"),
  ];
  for (const path of paths) {
    if (!existsSync(path)) continue;
    try {
      const text = readFileSync(path, "utf8");
      // TOML-ish: look for session_token / access_token / api_key = "..."
      const match =
        text.match(/(?:session_token|access_token|api_key|token)\s*=\s*"([^"]+)"/i) ||
        text.match(/(?:session_token|access_token|api_key|token)\s*=\s*'([^']+)'/i);
      if (match?.[1]) return match[1];
    } catch {
      // ignore
    }
  }
  return undefined;
}

export async function refreshDevinModels(options: {
  force?: boolean;
  signal?: AbortSignal;
  token?: string;
  fetchImpl?: typeof fetch;
  cache?: ReturnType<typeof getDefaultCatalogCache>;
} = {}): Promise<{ models: Model<Api>[]; fromCache: boolean }> {
  const cache = options.cache ?? getDefaultCatalogCache();
  const token = "token" in options ? options.token : resolveDevinToken();
  if (!token) {
    const lookup = cache.lookup<CatalogModel>(DEVIN_PROVIDER_ID);
    if (lookup.hit) return { models: fromCatalog(lookup.snapshot.models), fromCache: true };
    return { models: FALLBACK_MODELS, fromCache: false };
  }

  try {
    const result = await cache.getOrFetch<CatalogModel>(
      DEVIN_PROVIDER_ID,
      async () => {
        const discovered = await discoverDevinModels(token, options.signal, options.fetchImpl);
        return { models: toCatalog(discovered.length ? discovered : FALLBACK_MODELS), version: "devin-cli-v1" };
      },
      { force: options.force },
    );
    return { models: fromCatalog(result.models), fromCache: result.fromCache };
  } catch {
    const lookup = cache.lookup<CatalogModel>(DEVIN_PROVIDER_ID);
    if (lookup.hit) return { models: fromCatalog(lookup.snapshot.models), fromCache: true };
    return { models: FALLBACK_MODELS, fromCache: false };
  }
}

function providerConfig(currentModels: Model<Api>[]) {
  return {
    name: "Devin",
    api: API,
    baseUrl: BASE_URL,
    models: currentModels,
    async refreshModels({
      credential,
      signal,
      allowNetwork,
    }: {
      credential?: { type: string; access?: string };
      signal: AbortSignal;
      allowNetwork: boolean;
    }) {
      if (!allowNetwork) return currentModels;
      const token =
        (credential?.type === "oauth" ? credential.access : undefined) || resolveDevinToken();
      const refreshed = await refreshDevinModels({ force: true, signal, token });
      return refreshed.models;
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

export function registerDevinProvider(pi: ExtensionAPI): void {
  let models = FALLBACK_MODELS;
  pi.registerProvider(DEVIN_PROVIDER_ID, providerConfig(models));

  pi.on("session_start", async (_event, ctx) => {
    try {
      const apiKey =
        (await ctx.modelRegistry.getApiKeyForProvider?.(DEVIN_PROVIDER_ID)) || resolveDevinToken();
      if (!apiKey) return;
      const refreshed = await refreshDevinModels({ token: apiKey });
      if (refreshed.models.length) {
        models = refreshed.models;
        pi.registerProvider(DEVIN_PROVIDER_ID, providerConfig(models));
      }
    } catch {
      // keep fallback
    }
  });

  pi.registerCommand("devin-status", {
    description: "Show Devin authentication status and quota",
    handler: async (_args, ctx) => {
      const key =
        (await ctx.modelRegistry.getApiKeyForProvider?.(DEVIN_PROVIDER_ID)) || resolveDevinToken();
      if (!key) return ctx.ui.notify("Devin: not signed in. Run /login devin", "warning");
      try {
        ctx.ui.notify(formatDevinQuota(await fetchDevinQuota(key)), "info");
      } catch {
        ctx.ui.notify("Devin: authenticated\nQuota: unavailable. Try again later.", "warning");
      }
    },
  });
}

export default registerDevinProvider;
