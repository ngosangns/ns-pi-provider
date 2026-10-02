/**
 * Grok provider registration for Pi (provider id: "grok").
 * Auth: local Grok CLI / ~/.grok/auth.json / XAI_API_KEY (CLI owns refresh).
 * Models: `grok models` CLI discovery with TTL disk cache + static fallback.
 * Streaming: ACP/JSONL via adapted pi-grok-sdk (MIT).
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { ExtensionAPI, ProviderModelConfig } from "@earendil-works/pi-coding-agent";

import { ensureCacheCost, getDefaultCatalogCache, type CatalogModel } from "../shared/index.js";
import { getGrokVersion, probeGrokAuth, resolveGrokBinary } from "./binary.js";
import {
  API as GROK_SDK_API,
  CLIENT_NAME,
  CLIENT_VERSION,
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

/** Unified provider id requested by ns-pi-provider. */
export const GROK_PROVIDER_ID = "grok";
/** Keep sdk alias for compatibility with pi-grok-sdk settings. */
export const GROK_SDK_PROVIDER_ID = "grok-sdk";
export const GROK_API = "grok-cli";

function descriptorsToCatalog(descriptors: GrokModelDescriptor[]): CatalogModel[] {
  return descriptors.map((d) => ({
    id: d.id,
    name: d.name ?? d.id,
    api: GROK_API,
    provider: GROK_PROVIDER_ID,
    baseUrl: "grok-cli://local",
    reasoning: d.supportsReasoningEffort ?? true,
    input: ["text"] as Array<"text" | "image">,
    cost: ensureCacheCost({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }),
    contextWindow: d.contextWindow ?? 500_000,
    maxTokens: d.maxTokens ?? 128_000,
  }));
}

function catalogToProviderModels(models: CatalogModel[]): ProviderModelConfig[] {
  const thinking = toProviderModels(
    models.map((m) => ({
      id: m.id,
      name: m.name,
      contextWindow: m.contextWindow,
      maxTokens: m.maxTokens,
      supportsReasoningEffort: m.reasoning ?? true,
    })),
  );
  // Override api field to our unified id while keeping cost.cache*
  return thinking.map((m, i) => ({
    ...m,
    cost: ensureCacheCost(models[i]?.cost ?? m.cost),
  }));
}

export function grokAuthPresent(): boolean {
  if (process.env.XAI_API_KEY?.trim() || process.env.GROK_API_KEY?.trim()) return true;
  const paths = [
    join(homedir(), ".grok", "auth.json"),
    join("/workspace/.provider-creds/grok", "auth.json"),
  ];
  return paths.some((p) => existsSync(p));
}

export function refreshGrokModels(options: {
  force?: boolean;
  binary?: string;
  cache?: ReturnType<typeof getDefaultCatalogCache>;
} = {}): { models: ProviderModelConfig[]; fromCache: boolean; source: "live" | "fallback" | "cache" } {
  const cache = options.cache ?? getDefaultCatalogCache();

  if (!options.force) {
    const lookup = cache.lookup<CatalogModel>(GROK_PROVIDER_ID);
    if (lookup.hit) {
      return {
        models: catalogToProviderModels(lookup.snapshot.models),
        fromCache: true,
        source: "cache",
      };
    }
  }

  let binary: string | undefined = options.binary;
  try {
    binary ??= resolveGrokBinary();
  } catch {
    binary = undefined;
  }

  const discovered = discoverModels(binary);
  const catalog = descriptorsToCatalog(discovered.models);
  cache.store(GROK_PROVIDER_ID, catalog, { version: "grok-cli-v1" });
  return {
    models: catalogToProviderModels(catalog),
    fromCache: false,
    source: discovered.source,
  };
}

function createProviderConfig(models: ProviderModelConfig[]) {
  return {
    name: "Grok",
    baseUrl: "grok-cli://local",
    apiKey: process.env.XAI_API_KEY ? "$XAI_API_KEY" : "grok-cli",
    api: GROK_API,
    models,
    streamSimple: streamGrokAgent,
    async refreshModels({ allowNetwork }: { allowNetwork: boolean }) {
      if (!allowNetwork) return models;
      return refreshGrokModels({ force: true }).models;
    },
  };
}

export function registerGrokProvider(pi: ExtensionAPI): void {
  registerSessionScope(pi);
  onSessionScopeKeyChange((previousKey) => {
    disposeSessionAgentsForScope(previousKey);
  });
  pi.on("session_shutdown", async () => {
    disposeAllSessionAgents();
  });
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

  let refreshed = refreshGrokModels({ binary });
  let models = refreshed.models;
  const config = createProviderConfig(models);
  pi.registerProvider(GROK_PROVIDER_ID, config as never);
  // Alias for settings that still say grok-sdk
  pi.registerProvider(GROK_SDK_PROVIDER_ID, {
    ...config,
    name: "Grok (sdk alias)",
    api: GROK_SDK_API,
  } as never);

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
      const authed = binary ? probeGrokAuth(binary) : grokAuthPresent();
      notify(
        [
          `${CLIENT_NAME} via ns-pi-provider v${CLIENT_VERSION}`,
          `provider: ${GROK_PROVIDER_ID}`,
          `binary: ${binary ?? "(missing)"}`,
          `version: ${version}`,
          `auth: ${authed ? "ok" : "missing/unknown"}`,
          `mode: ${mode}`,
          `models: ${models.length} (${refreshed.source})`,
          binaryError ? `binary error: ${binaryError}` : "",
        ]
          .filter(Boolean)
          .join("\n"),
        binary && authed ? "info" : "warning",
      );
      return;
    }

    if (action === "models") {
      notify(`Grok models (${refreshed.source}):\n${models.map((m) => `• ${m.id}`).join("\n") || "(none)"}`);
      return;
    }

    if (action === "refresh" || action === "refresh-models") {
      try {
        binary = resolveGrokBinary();
        binaryError = undefined;
      } catch (err) {
        binaryError = err instanceof Error ? err.message : String(err);
        notify(binaryError, "error");
        return;
      }
      refreshed = refreshGrokModels({ force: true, binary });
      models = refreshed.models;
      const next = createProviderConfig(models);
      pi.registerProvider(GROK_PROVIDER_ID, next);
      pi.registerProvider(GROK_SDK_PROVIDER_ID, { ...next, name: "Grok (sdk alias)", api: GROK_SDK_API });
      notify(`Refreshed ${models.length} model(s) from ${refreshed.source}.`, refreshed.source === "live" ? "info" : "warning");
      return;
    }

    notify(`Unknown action "${action}". Try: status, models, refresh`, "warning");
  };

  pi.registerCommand("grok", {
    description: "Grok CLI provider: /grok status | models | refresh",
    handler: commandHandler,
  });
}

export default registerGrokProvider;
