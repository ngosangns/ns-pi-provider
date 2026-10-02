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

/** Default Devin CLI credentials.toml locations (XDG + workspace mirror). */
export function defaultDevinCredentialPaths(env: NodeJS.ProcessEnv = process.env): string[] {
  const home = homedir();
  const xdg = env.XDG_DATA_HOME?.trim() || join(home, ".local", "share");
  const paths = [
    join(xdg, "devin", "credentials.toml"),
    join(home, ".local", "share", "devin", "credentials.toml"),
    join("/workspace/.provider-creds/devin", "credentials.toml"),
  ];
  // Deduplicate while preserving order
  return [...new Set(paths)];
}

const DEVIN_TOML_TOKEN_RE =
  /(?:windsurf_api_key|session_token|access_token|api_key|token)\s*=\s*(?:"([^"]+)"|'([^']+)')/i;

/** Parse a Devin credentials.toml (or TOML-ish) file for a session/API token. */
export function parseDevinCredentialsToml(text: string): string | undefined {
  const match = text.match(DEVIN_TOML_TOKEN_RE);
  return match?.[1] || match?.[2] || undefined;
}

export type ResolveDevinTokenOptions = {
  /** Override credential file paths (for tests). */
  paths?: string[];
  /** When false, skip reading credential files. Default true. */
  readFiles?: boolean;
};

/** Resolve a Devin session token without logging secrets. */
export function resolveDevinToken(
  env: NodeJS.ProcessEnv = process.env,
  options: ResolveDevinTokenOptions = {},
): string | undefined {
  const fromEnv =
    env.DEVIN_API_KEY?.trim() ||
    env.DEVIN_SESSION_TOKEN?.trim() ||
    env.WINDSURF_API_KEY?.trim();
  if (fromEnv) return fromEnv;
  if (options.readFiles === false) return undefined;

  for (const path of options.paths ?? defaultDevinCredentialPaths(env)) {
    if (!existsSync(path)) continue;
    try {
      const token = parseDevinCredentialsToml(readFileSync(path, "utf8"));
      if (token) return token;
    } catch {
      // ignore unreadable / corrupt
    }
  }
  return undefined;
}

/**
 * Escape a literal API key for Pi config-value parsing.
 * Devin session tokens contain `$` (prefix `devin-session-token$…`); Pi treats
 * `$VAR` as env interpolation, so unescaped literals fail auth checks and
 * `--list-models` hides the provider. `$$` is the documented escape.
 */
export function escapeDevinApiKeyLiteral(token: string): string {
  // Double every "$" so Pi's config resolver treats them as literals.
  // Use a replacer fn: String.replaceAll treats "$$" in the replacement string as a single "$".
  return token.replaceAll("$", () => "$$");
}

/**
 * Pi apiKey config so `--list-models` marks Devin configured when CLI creds
 * already exist (no prior /login / auth.json entry required).
 * Prefers env refs; falls back to an escaped literal from credentials.toml.
 */
export function resolveDevinApiKeyConfig(
  env: NodeJS.ProcessEnv = process.env,
  options: ResolveDevinTokenOptions = {},
): string | undefined {
  if (env.DEVIN_API_KEY?.trim()) return "$DEVIN_API_KEY";
  if (env.DEVIN_SESSION_TOKEN?.trim()) return "$DEVIN_SESSION_TOKEN";
  if (env.WINDSURF_API_KEY?.trim()) return "$WINDSURF_API_KEY";
  const token = resolveDevinToken(env, { ...options, readFiles: options.readFiles !== false });
  return token ? escapeDevinApiKeyLiteral(token) : undefined;
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

function providerConfig(currentModels: Model<Api>[], apiKey?: string) {
  return {
    name: "Devin",
    api: API,
    baseUrl: BASE_URL,
    models: currentModels,
    // When CLI credentials.toml (or env) already has a token, set apiKey so Pi
    // marks the provider configured for --list-models without auth.json /login.
    ...(apiKey ? { apiKey } : {}),
    async refreshModels({
      credential,
      signal,
      allowNetwork,
    }: {
      credential?: { type: string; access?: string; key?: string };
      signal: AbortSignal;
      allowNetwork: boolean;
    }) {
      if (!allowNetwork) return currentModels;
      const token =
        (credential?.type === "oauth" ? credential.access : undefined) ||
        (credential?.type === "api_key" ? credential.key : undefined) ||
        resolveDevinToken();
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

export async function registerDevinProvider(pi: ExtensionAPI): Promise<void> {
  let apiKeyConfig = resolveDevinApiKeyConfig();
  // Await catalog before first register so --list-models / -p see swe-2-* (and the
  // full discovery set) without waiting for interactive session_start. Pi awaits
  // async extension factories before startup model selection.
  let models = FALLBACK_MODELS;
  try {
    const refreshed = await refreshDevinModels({
      token: resolveDevinToken() || undefined,
    });
    if (refreshed.models.length) models = refreshed.models;
  } catch {
    // keep FALLBACK_MODELS
  }
  pi.registerProvider(DEVIN_PROVIDER_ID, providerConfig(models, apiKeyConfig));

  pi.on("session_start", async (_event, ctx) => {
    try {
      apiKeyConfig = resolveDevinApiKeyConfig() ?? apiKeyConfig;
      const apiKey =
        (await ctx.modelRegistry.getApiKeyForProvider?.(DEVIN_PROVIDER_ID)) || resolveDevinToken();
      if (!apiKey) return;
      const refreshed = await refreshDevinModels({ token: apiKey });
      if (refreshed.models.length) {
        models = refreshed.models;
        pi.registerProvider(DEVIN_PROVIDER_ID, providerConfig(models, apiKeyConfig ?? escapeDevinApiKeyLiteral(apiKey)));
      }
    } catch {
      // keep current models
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
