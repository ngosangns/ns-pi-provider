/**
 * ns-pi-provider — unified Pi extension registering kiro, devin, and grok.
 * Loads gracefully when credentials are missing (fallback models + login hooks).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { registerKiroProvider, refreshKiroModels, KIRO_PROVIDER_ID } from "./kiro/register.js";
import { registerDevinProvider, refreshDevinModels, DEVIN_PROVIDER_ID } from "./devin/register.js";
import { registerGrokProvider, refreshGrokModels, GROK_PROVIDER_ID } from "./grok/register.js";
import { getDefaultCatalogCache } from "./shared/index.js";

export interface NsPiProviderOptions {
  /** Skip individual providers when false. Default: all enabled. */
  kiro?: boolean;
  devin?: boolean;
  grok?: boolean;
}

export async function registerAllProviders(
  pi: ExtensionAPI,
  options: NsPiProviderOptions = {},
): Promise<void> {
  const enableKiro = options.kiro !== false;
  const enableDevin = options.devin !== false;
  const enableGrok = options.grok !== false;

  if (enableKiro) {
    try {
      await registerKiroProvider(pi);
    } catch (err) {
      console.warn(
        `[ns-pi-provider] kiro registration failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  if (enableDevin) {
    try {
      await registerDevinProvider(pi);
    } catch (err) {
      console.warn(
        `[ns-pi-provider] devin registration failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  if (enableGrok) {
    try {
      registerGrokProvider(pi);
    } catch (err) {
      console.warn(
        `[ns-pi-provider] grok registration failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  pi.registerCommand("ns-pi", {
    description: "ns-pi-provider: /ns-pi refresh | status",
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const action = (parts[0] || "status").toLowerCase();
      const target = (parts[1] || "all").toLowerCase();

      if (action === "status") {
        const cache = getDefaultCatalogCache();
        const lines = [KIRO_PROVIDER_ID, DEVIN_PROVIDER_ID, GROK_PROVIDER_ID].map((id) => {
          const hit = cache.lookup(id);
          return hit.hit
            ? `${id}: ${hit.snapshot.models.length} model(s) cached (age ${Math.round((Date.now() - hit.snapshot.fetchedAt) / 1000)}s)`
            : `${id}: no cache (${hit.reason})`;
        });
        ctx.ui.notify(lines.join("\n"), "info");
        return;
      }

      if (action === "refresh") {
        const results: string[] = [];
        const want = (id: string) => target === "all" || target === id;
        if (want("kiro") && enableKiro) {
          try {
            const r = await refreshKiroModels({ force: true });
            results.push(`kiro: ${r.models.length} model(s)${r.fromCache ? " (cache)" : ""}`);
          } catch (err) {
            results.push(`kiro: failed (${err instanceof Error ? err.message : String(err)})`);
          }
        }
        if (want("devin") && enableDevin) {
          try {
            const r = await refreshDevinModels({ force: true });
            results.push(`devin: ${r.models.length} model(s)${r.fromCache ? " (cache)" : ""}`);
          } catch (err) {
            results.push(`devin: failed (${err instanceof Error ? err.message : String(err)})`);
          }
        }
        if (want("grok") && enableGrok) {
          try {
            const r = refreshGrokModels({ force: true });
            results.push(`grok: ${r.models.length} model(s) [${r.source}]`);
          } catch (err) {
            results.push(`grok: failed (${err instanceof Error ? err.message : String(err)})`);
          }
        }
        ctx.ui.notify(results.join("\n") || "nothing refreshed", "info");
        return;
      }

      ctx.ui.notify("Usage: /ns-pi status | refresh [all|kiro|devin|grok]", "warning");
    },
  });
}

export default async function nsPiProviderExtension(pi: ExtensionAPI): Promise<void> {
  await registerAllProviders(pi);
}

export {
  registerKiroProvider,
  registerDevinProvider,
  registerGrokProvider,
  refreshKiroModels,
  refreshDevinModels,
  refreshGrokModels,
  KIRO_PROVIDER_ID,
  DEVIN_PROVIDER_ID,
  GROK_PROVIDER_ID,
};
