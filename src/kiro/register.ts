/**
 * Kiro provider registration for Pi.
 * Auth: OAuth (Builder ID / Google / GitHub) via createKiroOAuthProvider,
 *       and/or KIRO_API_KEY / tokens from ~/.aws/sso/cache.
 * Models: ListAvailableModels discovery with disk TTL cache + static fallback.
 * Streaming: OAuth stream (eventstream) from adapted pi-kiro-provider.
 *
 * Adapted under MIT from MasuRii/pi-kiro-provider and satiyap/pi-kiro-api.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type {
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  AssistantMessageEventStream,
  Context,
  Model,
  SimpleStreamOptions,
} from "@earendil-works/pi-ai";

import { getDefaultCatalogCache, ensureCacheCost, firstEnv, type CatalogModel } from "../shared/index.js";
import { KIRO_API, loadConfig, type ExtensionConfig } from "./config.js";
import { DebugLogger } from "./debug-logger.js";
import { omitAuthorizationHeaders } from "./headers.js";
import { createKiroOAuthProvider } from "./oauth-provider.js";
import { discoverKiroModels } from "./discover.js";

const EXTENSION_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
export const KIRO_PROVIDER_ID = "kiro";

type KiroStreamModule = typeof import("./stream-oauth.js");

function createLazyKiroStream(
  config: ExtensionConfig,
  runtime: { cwd?: string },
  logger: DebugLogger,
): (model: Model<Api>, context: Context, options?: SimpleStreamOptions) => AssistantMessageEventStream {
  let promise: Promise<KiroStreamModule> | undefined;
  const load = () => {
    promise ??= import("./stream-oauth.js");
    return promise;
  };
  return (model, context, options) => {
    const streamPromise = load().then(({ createKiroStream }) =>
      createKiroStream(config, runtime, logger)(model, context, options),
    );
    streamPromise.catch(() => undefined);
    return {
      async *[Symbol.asyncIterator](): AsyncIterator<AssistantMessageEvent> {
        const stream = await streamPromise;
        yield* stream;
      },
      result(): Promise<AssistantMessage> {
        return streamPromise.then((s) => s.result());
      },
      push(event: AssistantMessageEvent): void {
        void streamPromise.then((s) => s.push(event), () => undefined);
      },
      end(result?: AssistantMessage): void {
        void streamPromise.then((s) => s.end(result), () => undefined);
      },
    } as unknown as AssistantMessageEventStream;
  };
}

function fallbackCatalogModels(config: ExtensionConfig): CatalogModel[] {
  return config.models.map((raw) => {
    const m = raw as unknown as Record<string, unknown> & { id: string; name: string; cost?: Partial<CatalogModel["cost"]>; headers?: Record<string, string>; input?: Array<"text" | "image"> };
    return {
      id: m.id,
      name: m.name,
      api: KIRO_API,
      provider: KIRO_PROVIDER_ID,
      baseUrl: config.upstreamUrl,
      reasoning: (m.reasoning as boolean | undefined) ?? true,
      input: m.input ?? ["text"],
      cost: ensureCacheCost(m.cost),
      contextWindow: (m.contextWindow as number | undefined) ?? 200_000,
      maxTokens: (m.maxTokens as number | undefined) ?? 32_000,
      ...(m.headers ? { headers: omitAuthorizationHeaders(m.headers) } : {}),
    };
  });
}

function toProviderModels(models: CatalogModel[], config: ExtensionConfig) {
  return models.map((m) => ({
    id: m.id,
    name: m.name,
    reasoning: m.reasoning ?? true,
    input: m.input ?? ["text"],
    cost: ensureCacheCost(m.cost),
    contextWindow: m.contextWindow,
    maxTokens: m.maxTokens,
    ...(m.headers ? { headers: m.headers } : {}),
    ...((m as { thinkingLevelMap?: CatalogModel["thinkingLevelMap"] }).thinkingLevelMap
      ? { thinkingLevelMap: (m as { thinkingLevelMap?: unknown }).thinkingLevelMap as never }
      : {}),
  }));
}

/** Resolve a bearer/API key for discovery without throwing when missing. */
export function resolveKiroDiscoveryToken(
  env: NodeJS.ProcessEnv = process.env,
  options: { paths?: string[]; readFiles?: boolean } = {},
): { token: string; source: string } | undefined {
  const envKey = firstEnv(["KIRO_API_KEY", "KIRO_ACCESS_TOKEN", "AMAZON_Q_TOKEN"], env);
  if (envKey) return { token: envKey, source: "env" };
  if (options.readFiles === false) return undefined;

  const candidates = options.paths ?? [
    join(homedir(), ".aws", "sso", "cache", "kiro-auth-token.json"),
    join(homedir(), ".aws", "sso", "cache", "kiro-auth-token-cli.json"),
    join("/workspace/.provider-creds/aws-sso", "kiro-auth-token.json"),
    join("/workspace/.provider-creds/aws-sso", "kiro-auth-token-cli.json"),
  ];
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    try {
      const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
      const token =
        (typeof raw.accessToken === "string" && raw.accessToken) ||
        (typeof raw.access_token === "string" && raw.access_token) ||
        (typeof raw.token === "string" && raw.token) ||
        undefined;
      if (token) return { token, source: path };
    } catch {
      // ignore unreadable / corrupt
    }
  }
  return undefined;
}

export function kiroRegion(env: NodeJS.ProcessEnv = process.env): string {
  return firstEnv(["KIRO_API_REGION", "AWS_REGION", "AWS_DEFAULT_REGION"], env) ?? "us-east-1";
}

export function kiroListBaseUrl(region = kiroRegion()): string {
  return `https://q.${region}.amazonaws.com/`;
}

export async function refreshKiroModels(options: {
  force?: boolean;
  signal?: AbortSignal;
  token?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  cache?: ReturnType<typeof getDefaultCatalogCache>;
  fallback?: CatalogModel[];
} = {}): Promise<{ models: CatalogModel[]; fromCache: boolean }> {
  const cache = options.cache ?? getDefaultCatalogCache();
  const fallback = options.fallback ?? [];
  const token =
    "token" in options ? options.token : resolveKiroDiscoveryToken()?.token;
  if (!token) {
    const lookup = cache.lookup<CatalogModel>(KIRO_PROVIDER_ID);
    if (lookup.hit) return { models: lookup.snapshot.models, fromCache: true };
    return { models: fallback, fromCache: false };
  }
  const baseUrl = options.baseUrl ?? kiroListBaseUrl();

  try {
    const result = await cache.getOrFetch<CatalogModel>(
      KIRO_PROVIDER_ID,
      async () => {
        const discovered = await discoverKiroModels(token, baseUrl, options.signal);
        const models: CatalogModel[] = discovered.map((m) => ({
          id: m.id,
          name: m.name,
          api: "kiro-api",
          provider: KIRO_PROVIDER_ID,
          baseUrl: m.baseUrl ?? baseUrl,
          reasoning: m.reasoning ?? true,
          input: m.input,
          cost: ensureCacheCost(m.cost),
          contextWindow: m.contextWindow,
          maxTokens: m.maxTokens,
        }));
        return { models, version: "kiro-list-v1" };
      },
      { force: options.force },
    );
    return result;
  } catch {
    const lookup = cache.lookup<CatalogModel>(KIRO_PROVIDER_ID);
    if (lookup.hit) return { models: lookup.snapshot.models, fromCache: true };
    return { models: fallback, fromCache: false };
  }
}

export function registerKiroProvider(pi: ExtensionAPI): void {
  const { config, warnings } = loadConfig(EXTENSION_ROOT);
  const logger = new DebugLogger({ extensionRoot: EXTENSION_ROOT, debug: config.debug });
  for (const warning of warnings) logger.warn("config_warning", { warning });

  // Force provider id to the unified "kiro"
  const providerId = KIRO_PROVIDER_ID;
  config.providerId = providerId;

  let oauthProvider: ReturnType<typeof createKiroOAuthProvider> | undefined;
  try {
    oauthProvider = createKiroOAuthProvider(config.oauth, logger, {
      providerId,
      displayName: config.displayName || "Kiro",
    });
  } catch (err) {
    logger.warn("oauth_init_failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  try {
    // Best-effort registerOAuthProvider for /login listing
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    void import("@earendil-works/pi-ai/oauth")
      .then((mod) => {
        if (oauthProvider && typeof (mod as { registerOAuthProvider?: (p: unknown) => void }).registerOAuthProvider === "function") {
          (mod as { registerOAuthProvider: (p: unknown) => void }).registerOAuthProvider(oauthProvider);
        }
      })
      .catch(() => undefined);
  } catch {
    // optional
  }

  const runtime: { cwd?: string } = {};
  const streamSimple = createLazyKiroStream(config, runtime, logger);
  const providerHeaders = omitAuthorizationHeaders(config.headers);
  let currentModels = toProviderModels(fallbackCatalogModels(config), config);

  const buildConfig = (models: typeof currentModels) => ({
    name: config.displayName || "Kiro",
    baseUrl: config.upstreamUrl,
    apiKey: config.apiKey || "$KIRO_API_KEY",
    api: KIRO_API,
    authHeader: false,
    streamSimple,
    headers: providerHeaders,
    models,
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
        resolveKiroDiscoveryToken()?.token;
      const refreshed = await refreshKiroModels({
        force: true,
        signal,
        token,
        fallback: fallbackCatalogModels(config),
      });
      currentModels = toProviderModels(refreshed.models, config);
      return currentModels;
    },
    ...(oauthProvider
      ? {
          oauth: {
            name: oauthProvider.name,
            login: (callbacks: Parameters<NonNullable<typeof oauthProvider>["login"]>[0]) =>
              oauthProvider!.login(callbacks),
            refreshToken: (credentials: Parameters<NonNullable<typeof oauthProvider>["refreshToken"]>[0]) =>
              oauthProvider!.refreshToken(credentials),
            getApiKey: (credentials: Parameters<NonNullable<typeof oauthProvider>["getApiKey"]>[0]) =>
              oauthProvider!.getApiKey(credentials),
            modifyModels: (
              models: Parameters<NonNullable<NonNullable<typeof oauthProvider>["modifyModels"]>>[0],
              credentials: Parameters<NonNullable<NonNullable<typeof oauthProvider>["modifyModels"]>>[1],
            ) => oauthProvider!.modifyModels?.(models, credentials) ?? models,
          },
        }
      : {}),
  });

  pi.registerProvider(providerId, buildConfig(currentModels) as never);

  pi.on("session_start", async (_event, ctx) => {
    runtime.cwd = ctx.cwd;
    try {
      const refreshed = await refreshKiroModels({
        fallback: fallbackCatalogModels(config),
      });
      if (refreshed.models.length) {
        currentModels = toProviderModels(refreshed.models, config);
        pi.registerProvider(providerId, buildConfig(currentModels) as never);
      }
    } catch {
      // keep fallback
    }
  });

  logger.debug("provider_registered", {
    providerId,
    modelCount: currentModels.length,
  });
}

export default registerKiroProvider;
